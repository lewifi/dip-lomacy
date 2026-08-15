import { DurableObject } from 'cloudflare:workers';

export interface Env {
  GLOBAL_WAR: DurableObjectNamespace<GlobalWarDO>;
  ASSETS?: Fetcher;
}

interface SocketMetadata {
  lastDipTime: number;
  dipIntervals: number[];
  continuousDips: number;
  shadowBanned: boolean;
}

export class GlobalWarDO extends DurableObject {
  private tendieDips: number = 12847392; // Baseline starting numbers for war vibe
  private dimmieDips: number = 9203118;
  private sockets: Map<WebSocket, SocketMetadata> = new Map();
  private dirty: boolean = false;
  private broadcastScheduled: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const storedTendie = await this.ctx.storage.get<number>('tendie_dips');
      const storedDimmie = await this.ctx.storage.get<number>('dimmie_dips');
      if (storedTendie !== undefined) this.tendieDips = storedTendie;
      if (storedDimmie !== undefined) this.dimmieDips = storedDimmie;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);
    this.sockets.set(server, {
      lastDipTime: 0,
      dipIntervals: [],
      continuousDips: 0,
      shadowBanned: false,
    });

    // Send initial state to newly connected client
    server.send(
      JSON.stringify({
        type: 'init',
        tendie_dips: this.tendieDips,
        dimmie_dips: this.dimmieDips,
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') return;
      const data = JSON.parse(message);

      if (data.type === 'dip' && (data.side === 'tendie' || data.side === 'dimmie')) {
        const meta = this.sockets.get(ws);
        if (!meta) return;

        const now = Date.now();
        const interval = meta.lastDipTime > 0 ? now - meta.lastDipTime : 1000;

        // 1. Animation Gate: drop dips faster than the 300ms mascot arc cycle
        if (interval < 300) {
          return;
        }

        // 2. Continuous Streak Tracking
        if (interval < 1500) {
          meta.continuousDips += 1;
        } else {
          meta.continuousDips = 0;
        }

        // 3. Jitter / Variance Tracking (last 15 intervals)
        meta.dipIntervals.push(interval);
        if (meta.dipIntervals.length > 15) {
          meta.dipIntervals.shift();
        }

        // 4. Bot Detection Checks
        if (meta.continuousDips > 100) {
          meta.shadowBanned = true;
        }

        if (meta.dipIntervals.length >= 10) {
          const mean = meta.dipIntervals.reduce((a, b) => a + b, 0) / meta.dipIntervals.length;
          const variance =
            meta.dipIntervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
            meta.dipIntervals.length;
          const stdDev = Math.sqrt(variance);

          // Synthetic clickers with zero/near-zero variance (<15ms stdDev) are shadow-banned
          if (stdDev < 15) {
            meta.shadowBanned = true;
          }
        }

        meta.lastDipTime = now;

        // If shadow-banned, ignore from global total (client still gets optimistic local blop)
        if (meta.shadowBanned) {
          return;
        }

        // Commit dip to authoritative total
        if (data.side === 'tendie') {
          this.tendieDips += 1;
        } else {
          this.dimmieDips += 1;
        }

        this.dirty = true;
        this.scheduleBroadcast();
      }
    } catch (e) {
      // Ignore malformed client payloads
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sockets.delete(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.sockets.delete(ws);
  }

  private scheduleBroadcast() {
    if (this.broadcastScheduled) return;
    this.broadcastScheduled = true;

    // Throttle broadcast fan-out to ~10 Hz (100ms aggregation window)
    setTimeout(async () => {
      this.broadcastScheduled = false;
      if (!this.dirty) return;
      this.dirty = false;

      // Save to storage
      await this.ctx.storage.put('tendie_dips', this.tendieDips);
      await this.ctx.storage.put('dimmie_dips', this.dimmieDips);

      // Fan out update to all connected clients
      const payload = JSON.stringify({
        type: 'tick',
        tendie_dips: this.tendieDips,
        dimmie_dips: this.dimmieDips,
      });

      for (const [socket] of this.sockets) {
        try {
          socket.send(payload);
        } catch {
          // Socket closed ungracefully
        }
      }
    }, 100);
  }
}
