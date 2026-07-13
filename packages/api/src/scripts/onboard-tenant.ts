/**
 * Tenant onboarding — provisions a new tenant directly against the database
 * (bypasses the API, so it isn't blocked by the mandatory-2FA gate a fresh
 * admin would hit). Creates the org + admin user, sets the scoring policy,
 * imports a scorecard from CSV, and seeds Knowledge Base section content.
 *
 * Idempotent and safe to re-run: an existing org (by name) or admin (by email)
 * is reused, not duplicated; the scorecard is created only if the org has none
 * by that name; KB section content is upserted.
 *
 * Usage:
 *   # Dry run — connects and reports what it WOULD do, writes nothing:
 *   npm run onboard-tenant --workspace=packages/api -- --config src/scripts/onboard/trustpoint.json --dry-run
 *
 *   # For real:
 *   npm run onboard-tenant --workspace=packages/api -- --config src/scripts/onboard/trustpoint.json
 *
 * The admin's one-time temporary password is printed once at the end. Send it
 * over a secure channel; the admin changes it and enrols 2FA on first login.
 */

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { pool, query, queryOne, withTransaction } from '../db/client.js';

interface OnboardConfig {
  org: { name: string; plan?: string; industry?: string | null };
  admin: { name: string; email: string };
  scoring?: {
    scoring_scope?: string;
    min_scoreable_seconds?: number;
    min_scoreable_words?: number;
    pass_threshold?: number;
    retention_days?: number;
    transcription_mode?: string;
    deepgram_region?: string;
    adviser_channel?: number | null;
  };
  scorecard?: {
    name: string;
    description?: string;
    csv: string; // path relative to the config file
    scoring_mode?: 'per_call' | 'journey';
    branch_config?: unknown;
  };
  knowledge_base?: Array<{ section: string; file?: string; files?: string[] }>;
}

interface CsvItem {
  label: string;
  description: string;
  score_type: string;
  weight: number;
  severity: string | null;
  section: string | null;
  item_type: string;
  branch: string;
  expectation: string | null;
  ai_check: string | null;
  consent_gate: boolean;
}

const TRUTHY = ['true', 'yes', 'y', '1'];

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseScorecardCsv(csvPath: string): CsvItem[] {
  const text = fs.readFileSync(csvPath, 'utf-8').replace(/^﻿/, '').replace(/\r/g, '');
  const lines = text.split('\n').filter((l) => l.trim());
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const li = idx('label');
  if (li < 0) throw new Error('scorecard CSV must have a "label" column');
  const items: CsvItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]!);
    const label = c[li]?.trim();
    if (!label) continue;
    const pick = (n: string) => (idx(n) >= 0 ? (c[idx(n)] ?? '').trim() : '');
    const it = pick('item_type').toLowerCase();
    items.push({
      label,
      description: pick('description'),
      score_type: ['binary', 'scale_1_5', 'scale_1_10'].includes(pick('score_type')) ? pick('score_type') : 'binary',
      weight: parseFloat(pick('weight')) || 1,
      severity: ['critical', 'high', 'medium', 'low'].includes(pick('severity').toLowerCase()) ? pick('severity').toLowerCase() : null,
      section: pick('section') || null,
      item_type: it === 'manual' ? 'manual' : 'ai',
      branch: pick('branch'),
      expectation: pick('expectation') || null,
      ai_check: pick('ai_check') || null,
      consent_gate: TRUTHY.includes(pick('consent_gate').toLowerCase()),
    });
  }
  return items;
}

function branchToAppliesWhen(branch: string): string | null {
  const parts = branch.split(',').map((b) => b.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return JSON.stringify({ branch: parts.length === 1 ? parts[0] : parts });
}

function log(dry: boolean, msg: string) {
  console.log(`${dry ? '[dry-run] ' : ''}${msg}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const cfgIdx = args.indexOf('--config');
  if (cfgIdx < 0 || !args[cfgIdx + 1]) {
    throw new Error('Usage: onboard-tenant --config <path-to-config.json> [--dry-run]');
  }
  const cfgPath = path.resolve(process.cwd(), args[cfgIdx + 1]!);
  const cfgDir = path.dirname(cfgPath);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as OnboardConfig;
  const resolve = (p: string) => path.resolve(cfgDir, p);

  console.log(`\n=== Onboarding tenant: ${cfg.org.name} ${dry ? '(DRY RUN — no writes)' : ''} ===\n`);

  // 1. Org (idempotent by name).
  let org = await queryOne<{ id: string }>('SELECT id FROM organizations WHERE name = $1', [cfg.org.name]);
  if (org) {
    log(dry, `Org "${cfg.org.name}" already exists (${org.id}) — reusing.`);
  } else if (dry) {
    log(dry, `Would create org "${cfg.org.name}" (plan=${cfg.org.plan || 'core'}).`);
  } else {
    org = await queryOne<{ id: string }>(
      'INSERT INTO organizations (name, plan) VALUES ($1, $2) RETURNING id',
      [cfg.org.name, cfg.org.plan || 'core']
    );
    console.log(`Created org ${org!.id}.`);
  }
  const orgId = org?.id ?? '(new)';

  // 2. Scoring policy + industry (only when the org row exists).
  if (org && !dry) {
    await query(
      `UPDATE organizations SET
         industry = COALESCE($2, industry),
         scoring_scope = COALESCE($3, scoring_scope),
         min_scoreable_seconds = COALESCE($4, min_scoreable_seconds),
         min_scoreable_words = COALESCE($5, min_scoreable_words),
         pass_threshold = COALESCE($6, pass_threshold),
         retention_days = COALESCE($7, retention_days),
         transcription_mode = COALESCE($8, transcription_mode),
         deepgram_region = COALESCE($9, deepgram_region),
         adviser_channel = COALESCE($10, adviser_channel),
         updated_at = now()
       WHERE id = $1`,
      [
        org.id, cfg.org.industry ?? null,
        cfg.scoring?.scoring_scope ?? null, cfg.scoring?.min_scoreable_seconds ?? null,
        cfg.scoring?.min_scoreable_words ?? null, cfg.scoring?.pass_threshold ?? null,
        cfg.scoring?.retention_days ?? null, cfg.scoring?.transcription_mode ?? null,
        cfg.scoring?.deepgram_region ?? null, cfg.scoring?.adviser_channel ?? null,
      ]
    );
    console.log(`Set scoring policy (scope=${cfg.scoring?.scoring_scope}, retention=${cfg.scoring?.retention_days}d, mode=${cfg.scoring?.transcription_mode}).`);
  } else {
    log(dry, `Would set scoring policy: ${JSON.stringify(cfg.scoring ?? {})}, industry="${cfg.org.industry ?? ''}".`);
  }

  // 3. Admin user (idempotent by email — globally unique).
  let tempPassword: string | null = null;
  const existingUser = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [cfg.admin.email]);
  if (existingUser) {
    log(dry, `Admin ${cfg.admin.email} already exists (${existingUser.id}) — leaving as-is.`);
  } else if (dry) {
    log(dry, `Would create admin "${cfg.admin.name}" <${cfg.admin.email}> (role=admin) with a random temp password.`);
  } else {
    tempPassword = randomBytes(9).toString('base64url') + 'Cg1!';
    const hash = await bcrypt.hash(tempPassword, 12);
    const u = await queryOne<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
      [org!.id, cfg.admin.email, cfg.admin.name, hash]
    );
    console.log(`Created admin ${u!.id} (${cfg.admin.email}).`);
  }

  // 4. Scorecard + items (idempotent by org + name).
  if (cfg.scorecard) {
    const items = parseScorecardCsv(resolve(cfg.scorecard.csv));
    const existingSc = org
      ? await queryOne<{ id: string }>('SELECT id FROM scorecards WHERE organization_id = $1 AND name = $2', [org.id, cfg.scorecard.name])
      : null;
    if (existingSc) {
      log(dry, `Scorecard "${cfg.scorecard.name}" already exists (${existingSc.id}) — skipping import (edit in the app to change).`);
    } else if (dry) {
      log(dry, `Would create scorecard "${cfg.scorecard.name}" (mode=${cfg.scorecard.scoring_mode || 'journey'}) with ${items.length} items (${items.filter((i) => i.item_type === 'manual').length} manual, ${items.filter((i) => i.consent_gate).length} consent gates).`);
    } else {
      await withTransaction(async (tx) => {
        const sc = await tx.queryOne<{ id: string }>(
          `INSERT INTO scorecards (organization_id, name, description, branch_config, scoring_mode)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            org!.id, cfg.scorecard!.name, cfg.scorecard!.description ?? null,
            cfg.scorecard!.branch_config ? JSON.stringify(cfg.scorecard!.branch_config) : null,
            cfg.scorecard!.scoring_mode || 'journey',
          ]
        );
        for (let i = 0; i < items.length; i++) {
          const it = items[i]!;
          await tx.query(
            `INSERT INTO scorecard_items
               (scorecard_id, label, description, score_type, weight, sort_order,
                severity, section, item_type, applies_when, expectation, ai_check, consent_gate)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              sc!.id, it.label, it.description || null, it.score_type, it.weight, i,
              it.severity, it.section, it.item_type, branchToAppliesWhen(it.branch),
              it.expectation, it.ai_check, it.consent_gate,
            ]
          );
        }
        console.log(`Created scorecard ${sc!.id} with ${items.length} items.`);
      });
    }
  }

  // 5. Knowledge base section content.
  for (const kb of cfg.knowledge_base ?? []) {
    const files = kb.files ?? (kb.file ? [kb.file] : []);
    const content = files.map((f) => fs.readFileSync(resolve(f), 'utf-8')).join('\n\n---\n\n');
    if (dry) {
      log(dry, `Would set KB section "${kb.section}" from ${files.length} file(s) (${content.length} chars).`);
    } else if (org) {
      await query(
        `INSERT INTO knowledge_base_sections (organization_id, section_type, content)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, section_type)
         DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
        [org.id, kb.section, content]
      );
      console.log(`Set KB section "${kb.section}" (${content.length} chars).`);
    }
  }

  console.log(`\n=== Done${dry ? ' (dry run)' : ''}: ${cfg.org.name} (${orgId}) ===`);
  if (tempPassword) {
    console.log(`\n  Admin login: ${cfg.admin.email}`);
    console.log(`  TEMP PASSWORD (send securely, shown once): ${tempPassword}`);
    console.log(`  The admin must change it and enrol 2FA on first login.\n`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('Onboarding failed:', err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
