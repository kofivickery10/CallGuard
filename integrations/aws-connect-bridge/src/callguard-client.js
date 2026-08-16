'use strict';

const WebSocket = require('ws');

/**
 * Thin client for CallGuard's dialer streaming protocol
 * (packages/api/src/services/stream-server.ts + dialer-adapters.ts,
 * awsConnectAdapter):
 *
 *   connect:  wss://<host>/v1/stream/dialer/aws-connect?api_key=<raw key>
 *   frames:   binary   -> raw PCM16LE 8kHz mono audio
 *             JSON     -> {"event":"session.start","metadata":{...},"external_id":"..."}
 *                         {"event":"session.end"}
 *
 * Handles a dropped connection mid-call: reconnects with bounded, jittered
 * backoff and buffers outgoing audio (bounded, oldest-first drop) while
 * disconnected so a brief network blip doesn't lose audio. IMPORTANT — read
 * "Reconnect behaviour" in README.md: a reconnect opens a brand new
 * CallGuard session against the same external_id. CallGuard does not today
 * stitch two sessions that share an external_id into one call record, so a
 * mid-call reconnect produces two scored call records tagged with the same
 * Connect ContactId, not one seamlessly resumed session.
 */
class CallGuardClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsHost
   * @param {string} opts.apiKey
   * @param {string} opts.externalId - Connect ContactId
   * @param {object} opts.metadata
   * @param {object} opts.config - see config.js (reconnect tuning)
   * @param {(msg: object) => void} [opts.onServerFrame]
   */
  constructor({ wsHost, apiKey, externalId, metadata, config, onServerFrame }) {
    this.url = `wss://${wsHost}/v1/stream/dialer/aws-connect?api_key=${encodeURIComponent(apiKey)}`;
    this.externalId = externalId;
    this.metadata = metadata;
    this.config = config;
    this.onServerFrame = onServerFrame || (() => {});

    this.ws = null;
    this.open = false;
    this.closedByUs = false;
    this.reconnectAttempt = 0;

    // Bounded audio buffer used only while reconnecting.
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.maxPendingBytes =
      this.config.wsReconnectBufferMs * this.config.sampleRate * this.config.bytesPerSample / 1000;
  }

  async connect() {
    await this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        this.open = true;
        this.reconnectAttempt = 0;
        this._sendJson({
          event: 'session.start',
          metadata: this.metadata,
          external_id: this.externalId,
        });
        this._flushPendingAudio();
        resolve();
      };

      ws.once('open', onOpen);

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          this.onServerFrame(JSON.parse(data.toString()));
        } catch {
          // ignore malformed server frames
        }
      });

      ws.on('error', (err) => {
        if (!this.open) reject(err);
      });

      ws.on('close', () => {
        this.open = false;
        if (!this.closedByUs) {
          void this._reconnect();
        }
      });
    });
  }

  async _reconnect() {
    if (this.closedByUs) return;
    if (this.reconnectAttempt >= this.config.wsReconnectMaxAttempts) {
      console.error(
        `[CallGuardClient] giving up reconnecting for external_id=${this.externalId} after ${this.reconnectAttempt} attempts`,
      );
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.config.wsReconnectBaseDelayMs * 2 ** (this.reconnectAttempt - 1),
      this.config.wsReconnectMaxDelayMs,
    );
    console.warn(
      `[CallGuardClient] connection dropped for external_id=${this.externalId}, reconnect attempt ${this.reconnectAttempt} in ${delay}ms`,
    );
    await sleep(delay);
    try {
      await this._open();
      console.warn(
        `[CallGuardClient] reconnected for external_id=${this.externalId} — this is a NEW CallGuard session (see README "Reconnect behaviour")`,
      );
    } catch (err) {
      console.error(`[CallGuardClient] reconnect attempt ${this.reconnectAttempt} failed:`, err.message);
      void this._reconnect();
    }
  }

  /** Send mixed mono PCM16LE audio. Buffered (bounded) while disconnected. */
  sendAudio(buffer) {
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
      return;
    }
    this.pendingAudio.push(buffer);
    this.pendingAudioBytes += buffer.length;
    while (this.pendingAudioBytes > this.maxPendingBytes && this.pendingAudio.length > 1) {
      const dropped = this.pendingAudio.shift();
      this.pendingAudioBytes -= dropped.length;
    }
  }

  _flushPendingAudio() {
    if (this.pendingAudio.length === 0) return;
    for (const buf of this.pendingAudio) {
      this.ws.send(buf);
    }
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  _sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Clean end-of-call: tell CallGuard the session is over, then close. */
  async end() {
    this.closedByUs = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendJson({ event: 'session.end' });
      await sleep(50); // give the frame a moment to flush before closing
    }
    this._close();
  }

  /** Abrupt stop (Lambda approaching its timeout) — still sends session.end. */
  async endForContinuation() {
    return this.end();
  }

  _close() {
    this.closedByUs = true;
    try {
      if (this.ws) this.ws.close(1000, 'session ended');
    } catch {
      // ignore
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = { CallGuardClient };
