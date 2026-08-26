// Does the position-aware extractor change anything it should not?
//
// Reordering spans within a line is meant to touch ONLY lines the producing
// application emitted out of order. Every stored profile — its detect patterns,
// its parse config, its question fingerprint — was learned against the old
// output, so any change beyond the scrambled lines invalidates them.
//
// This diffs old against new, line by line, over local sample documents. It
// reads no database and writes nothing.
//
// Usage: tsx src/scripts/diff-pdf-extraction.ts [glob-dir]
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractPdfText } from '../services/application-pdf.js';

/**
 * The first argument that is not a flag.
 *
 * argv[2] is not that. Running this script with only --commit made "--commit"
 * the organisation name, which fails safe (nothing matches, nothing is written)
 * but reads as though the tenant is missing rather than the argument.
 */
function firstPositional(): string | undefined {
  return process.argv.slice(2).find((a) => !a.startsWith('--'));
}


async function legacyExtract(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

/** The line's words, order-insensitive, so a pure reordering can be spotted. */
function normaliseWords(s: string): string {
  return s
    .split(/[\t ]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Line diff by longest common subsequence.
 *
 * Comparing by index instead reports a single inserted line as every subsequent
 * line having changed — 207 false "wording changed" rows on one document, which
 * is the difference between "this rewrote the document" and "this repaired four
 * lines". The alignment has to be real for the number to mean anything.
 */
function diffLines(a: string, b: string): Array<{ n: number; old: string; new: string }> {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length;
  const m = bl.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = al[i] === bl[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: Array<{ n: number; old: string; new: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // Line present in old, gone from new. Pair it with the new line opposite
      // when that is also a deletion+insertion, so a changed line reads as one
      // row rather than two.
      if (lcs[i + 1]![j]! === lcs[i]![j + 1]!) {
        out.push({ n: i + 1, old: al[i]!, new: bl[j]! });
        i++;
        j++;
      } else {
        out.push({ n: i + 1, old: al[i]!, new: '<removed>' });
        i++;
      }
    } else {
      out.push({ n: i + 1, old: '<added>', new: bl[j]! });
      j++;
    }
  }
  while (i < n) out.push({ n: i + 1, old: al[i++]!, new: '<removed>' });
  while (j < m) out.push({ n: i + 1, old: '<added>', new: bl[j++]! });
  return out;
}

async function main(): Promise<void> {
  const dir = firstPositional() ?? 'docs/trustpoint/samples';
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf'));

  let totalOld = 0;
  let totalChanged = 0;

  for (const f of files) {
    const buffer = await readFile(path.join(dir, f));
    const [oldText, newText] = [await legacyExtract(buffer), await extractPdfText(buffer)];
    const changed = diffLines(oldText, newText);
    const lineCount = oldText.split('\n').length;
    totalOld += lineCount;
    totalChanged += changed.length;

    console.log(`\n${'─'.repeat(72)}\n${f}`);
    console.log(`   ${changed.length} of ${lineCount} lines differ`);

    // Classify, so "everything moved" can be told apart from "wording changed".
    // Only the last bucket is a change to what the comparison will read.
    const buckets = new Map<string, Array<{ n: number; old: string; new: string }>>();
    for (const c of changed) {
      // A trailing column marker that is now leading: same characters, same
      // wording, different end of the line.
      const markerMoved = /^(.*?)\t([A-Z])$/.exec(c.old);
      const nowLeading = markerMoved ? `${markerMoved[2]}\t${markerMoved[1]}` : null;
      const key =
        nowLeading === c.new
          ? 'marker moved to front (wording identical)'
          : c.old.replace(/[\t ]+/g, '') === c.new.replace(/[\t ]+/g, '')
            ? 'whitespace only'
            : normaliseWords(c.old) === normaliseWords(c.new)
              ? 'same words, reordered'
              : 'WORDING CHANGED';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(c);
    }
    for (const [key, rows] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n   ${rows.length}x  ${key}`);
      const show = key === 'WORDING CHANGED' ? rows : rows.slice(0, 3);
      for (const c of show) {
        console.log(`      line ${c.n}`);
        console.log(`         old: ${JSON.stringify(c.old)}`);
        console.log(`         new: ${JSON.stringify(c.new)}`);
      }
      if (show.length < rows.length) console.log(`      ... and ${rows.length - show.length} more`);
    }
  }

  console.log(
    `\n${'='.repeat(72)}\nTOTAL: ${totalChanged} of ${totalOld} lines differ across ${files.length} documents`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
