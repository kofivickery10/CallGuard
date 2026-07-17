/**
 * Diagnostic: hit CloudTalk's recording endpoint for one call id and report
 * exactly what it returns (status, content-type, and either the JSON body or
 * the first bytes if it's audio). Tells us how to actually fetch recordings.
 *
 * Usage:
 *   ORG=<org-uuid> CALL_ID=1243028285 npx tsx src/scripts/probe-recording.ts
 */

import { getDialerConnection } from '../services/tenant-settings.js';
import { cloudTalkBasicAuthHeader } from '../services/cloudtalk.js';

const orgId = process.env.ORG;
const callId = process.env.CALL_ID;

if (!orgId || !callId) {
  console.error('ORG and CALL_ID are both required');
  process.exit(1);
}

async function run() {
  const conn = await getDialerConnection(orgId as string, 'cloudtalk');
  if (!conn) {
    console.error(`No CloudTalk connection for org ${orgId}`);
    process.exit(1);
  }
  const headers = cloudTalkBasicAuthHeader(conn);
  if (!headers) {
    console.error('CloudTalk API credentials not configured on the connection');
    process.exit(1);
  }

  const url = `${conn.api_base_url}/calls/recording/${encodeURIComponent(callId as string)}.json`;
  console.log(`[Probe] GET ${url}`);
  const res = await fetch(url, { headers, redirect: 'manual' });
  console.log(`[Probe] status: ${res.status} ${res.statusText}`);
  console.log(`[Probe] content-type: ${res.headers.get('content-type')}`);
  console.log(`[Probe] content-length: ${res.headers.get('content-length')}`);
  console.log(`[Probe] location (if redirect): ${res.headers.get('location')}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') || ct.includes('text')) {
    console.log(`[Probe] body:\n${buf.toString('utf8').slice(0, 2000)}`);
  } else {
    // Likely audio — show size + magic bytes so we can confirm it's a media file.
    console.log(`[Probe] binary body: ${buf.length} bytes, first bytes: ${buf.subarray(0, 16).toString('hex')}`);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('[Probe] failed:', err);
  process.exit(1);
});
