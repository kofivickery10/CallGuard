import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { v4 as uuid } from 'uuid';
import { query, queryOne } from '../db/client.js';
import { StreamWorker } from './stream-worker.js';
import { verifyStreamToken, verifyApiKeyForStreaming } from '../routes/stream.js';
import { ADAPTERS, type DialerAdapter } from './dialer-adapters.js';
import type { ClientControlFrame, LiveSessionSource } from '@callguard/shared';

/**
 * Attach the streaming WebSocket server to the existing HTTP server.
 *
 * Two route patterns:
 *   /v1/stream/sdk?token=<jwt>                  - mobile / browser SDK clients
 *   /v1/stream/dialer/:source?api_key=<raw>     - dialer integrations (twilio, aws-connect, generic)
 */
export function attachStreamServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/v1/stream/sdk') {
      handleSdkUpgrade(wss, req, socket, head, url);
      return;
    }

    const dialerMatch = pathname.match(/^\/v1\/stream\/dialer\/([a-z_-]+)$/);
    if (dialerMatch) {
      const sourceParam = dialerMatch[1]!;
      handleDialerUpgrade(wss, req, socket, head, url, sourceParam);
      return;
    }

    // Not a streaming path - leave the socket alone for other handlers (or close)
    socket.destroy();
  });

  console.log('[Stream] WebSocket server attached: /v1/stream/sdk + /v1/stream/dialer/:source');
}

function handleSdkUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
): void {
  const token = url.searchParams.get('token');
  if (!token) {
    abortUpgrade(socket, 401, 'missing token');
    return;
  }

  let payload: ReturnType<typeof verifyStreamToken>;
  try {
    payload = verifyStreamToken(token);
  } catch {
    abortUpgrade(socket, 401, 'invalid token');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    void onSdkConnection(ws, payload);
  });
}

function handleDialerUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  sourceParam: string,
): void {
  const adapter = ADAPTERS[sourceParam];
  if (!adapter) {
    abortUpgrade(socket, 404, 'unknown dialer source');
    return;
  }

  const apiKey = url.searchParams.get('api_key') || url.searchParams.get('token');
  if (!apiKey) {
    abortUpgrade(socket, 401, 'missing api_key');
    return;
  }

  void (async () => {
    let validated: { api_key_id: string; organization_id: string };
    try {
      validated = await verifyApiKeyForStreaming(apiKey);
    } catch {
      abortUpgrade(socket, 401, 'invalid api_key');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void onDialerConnection(ws, adapter, validated);
    });
  })();
}

async function onSdkConnection(
  ws: WebSocket,
  payload: ReturnType<typeof verifyStreamToken>,
): Promise<void> {
  const session = await queryOne<{
    id: string;
    organization_id: string;
    api_key_id: string;
    external_id: string | null;
    agent_id: string | null;
    scorecard_id: string | null;
    status: string;
    metadata: Record<string, unknown>;
    consent_required: boolean;
  }>(
    `SELECT id, organization_id, api_key_id, external_id, agent_id, scorecard_id,
            status, metadata, consent_required
       FROM live_sessions
      WHERE id = $1`,
    [payload.session_id],
  );

  if (!session || session.status !== 'opening') {
    sendErrorAndClose(ws, 'session not found or already used');
    return;
  }

  const worker = new StreamWorker({
    sessionId: session.id,
    organizationId: session.organization_id,
    apiKeyId: session.api_key_id,
    source: 'sdk',
    externalId: session.external_id,
    agentId: session.agent_id,
    scorecardId: session.scorecard_id,
    audioFormat: 'opus',
    audioSampleRate: 16000,
    metadata: session.metadata,
    consentRequired: session.consent_required,
    client: ws,
  });

  await worker.start();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      worker.ingestAudio(data as Buffer);
      return;
    }
    let frame: ClientControlFrame;
    try {
      frame = JSON.parse(data.toString()) as ClientControlFrame;
    } catch {
      return;
    }
    void worker.ingestControlFrame(frame);
  });

  ws.on('close', () => {
    void worker.handleClientClose();
  });

  ws.on('error', (err) => {
    console.error(`[Stream ${session.id}] WebSocket error:`, err.message);
  });
}

async function onDialerConnection(
  ws: WebSocket,
  adapter: DialerAdapter,
  auth: { api_key_id: string; organization_id: string },
): Promise<void> {
  // Dialers create a fresh session on connect - we wait for the source's
  // session_start frame to populate metadata, then provision the session.
  let worker: StreamWorker | null = null;
  let sessionId: string | null = null;

  ws.on('message', async (data, isBinary) => {
    const frame = adapter.parseFrame(isBinary ? (data as Buffer) : data.toString());

    if (frame.kind === 'session_start') {
      if (worker) return; // already started
      sessionId = uuid();

      // Look up active scorecard for this org (dialer doesn't choose - org default applies)
      const sc = await queryOne<{ id: string }>(
        `SELECT id FROM scorecards WHERE organization_id = $1 AND is_active = true LIMIT 1`,
        [auth.organization_id],
      );

      const externalId = frame.externalId || (frame.metadata?.external_id as string | undefined) || null;
      const agentId = (frame.metadata?.agent_id as string | undefined) || null;

      await query(
        `INSERT INTO live_sessions
           (id, organization_id, api_key_id, source, external_id, agent_id, scorecard_id,
            status, metadata, audio_format, audio_sample_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening', $8, $9, $10)`,
        [
          sessionId,
          auth.organization_id,
          auth.api_key_id,
          adapter.source,
          externalId,
          agentId,
          sc?.id || null,
          JSON.stringify(frame.metadata),
          adapter.audioFormat,
          adapter.sampleRate,
        ],
      );

      worker = new StreamWorker({
        sessionId,
        organizationId: auth.organization_id,
        apiKeyId: auth.api_key_id,
        source: adapter.source,
        externalId,
        agentId,
        scorecardId: sc?.id || null,
        audioFormat: adapter.audioFormat,
        audioSampleRate: adapter.sampleRate,
        metadata: frame.metadata,
        consentRequired: false, // dialers manage consent at the telephony layer
        client: ws,
      });
      await worker.start();
      return;
    }

    if (frame.kind === 'audio' && worker) {
      worker.ingestAudio(frame.audio);
      return;
    }

    if (frame.kind === 'session_end' && worker) {
      await worker.ingestControlFrame({ type: 'session.end', ts: new Date().toISOString() });
      return;
    }
  });

  ws.on('close', () => {
    if (worker) {
      void worker.handleClientClose();
    } else {
      console.warn(
        `[Stream/${adapter.source}] Connection closed before session_start - no worker to clean up`,
      );
    }
  });

  ws.on('error', (err) => {
    console.error(`[Stream/${adapter.source}] WebSocket error:`, err.message);
  });
}

function abortUpgrade(socket: Duplex, code: number, msg: string): void {
  socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
  socket.destroy();
}

function sendErrorAndClose(ws: WebSocket, msg: string): void {
  try {
    ws.send(JSON.stringify({ type: 'error', message: msg }));
    ws.close(1008, msg);
  } catch {
    // ignore
  }
}

export type { LiveSessionSource };
