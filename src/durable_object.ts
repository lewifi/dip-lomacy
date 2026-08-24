import { DurableObject } from 'cloudflare:workers';

export interface Env {
  GLOBAL_WAR: DurableObjectNamespace<GlobalWarDO>;
  ASSETS?: Fetcher;
}

interface SocketMetadata {
  ip: string;
  country: string;
  city: string;
  lastDipTime: number;
  dipIntervals: number[];
  continuousDips: number;
}

interface IpRateState {
  tokens: number;
  lastRefill: number;
  recentDips: number[]; // timestamps within last 60s
  activeSockets: number;
  permanentBot: boolean; // hard kill for obvious robotic scripts
  cooldownUntil: number; // 3-minute auto-decay penalty box for hyperactive humans
}

export interface CountryScore {
  country: string;
  dips: number;
}

// Returns the most recent Monday 00:00 UTC as a timestamp.
function getMonday(ts: number = Date.now()): number {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Rate limiting parameters (generous high-energy clicker profile)
const BUCKET_CAPACITY = 50;
const TOKEN_REFILL_RATE = 5.0; // tokens per second
const MIN_DIP_INTERVAL_MS = 80; // allows rapid multi-finger clicking up to 12 clicks/sec
const MAX_DIPS_PER_MINUTE = 250; // generous session headroom
const MAX_CONCURRENT_SOCKETS_PER_IP = 4;
const HUMAN_COOLDOWN_MS = 15 * 1000; // 15-second breather for humans if streak exceeded

export class GlobalWarDO extends DurableObject {
  // All-time totals
  private tendieDips: number = 0;
  private dimmieDips: number = 0;

  // Weekly totals
  private weeklyTendie: number = 0;
  private weeklyDimmie: number = 0;
  private weekStart: number = 0;

  // Weeks-won scoreboard
  private weeksWonTendie: number = 0;
  private weeksWonDimmie: number = 0;

  // Country dip breakdown
  private countryDips: Record<string, number> = {};

  private sockets: Map<WebSocket, SocketMetadata> = new Map();
  private ipStates: Map<string, IpRateState> = new Map();
  private dirty: boolean = false;
  private broadcastScheduled: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const s = this.ctx.storage;

      // v2: reset all scores to 0 for real launch (runs once)
      const version = await s.get<number>('schema_version');
      if (version !== 2) {
        await s.put('tendie_dips', 0);
        await s.put('dimmie_dips', 0);
        await s.put('weekly_tendie', 0);
        await s.put('weekly_dimmie', 0);
        await s.put('week_start', getMonday());
        await s.put('weeks_won_tendie', 0);
        await s.put('weeks_won_dimmie', 0);
        await s.put('country_dips', {});
        await s.put('schema_version', 2);
      }

      const storedTendie = await s.get<number>('tendie_dips');
      const storedDimmie = await s.get<number>('dimmie_dips');
      if (storedTendie !== undefined) this.tendieDips = storedTendie;
      if (storedDimmie !== undefined) this.dimmieDips = storedDimmie;

      this.weeklyTendie = (await s.get<number>('weekly_tendie')) ?? 0;
      this.weeklyDimmie = (await s.get<number>('weekly_dimmie')) ?? 0;
      this.weekStart = (await s.get<number>('week_start')) ?? getMonday();
      this.weeksWonTendie = (await s.get<number>('weeks_won_tendie')) ?? 0;
      this.weeksWonDimmie = (await s.get<number>('weeks_won_dimmie')) ?? 0;
      this.countryDips = (await s.get<Record<string, number>>('country_dips')) ?? {};

      // Check for rollover on startup
      this.maybeRollover();
    });
  }

  // If the stored week has passed, finalize it and start a new one.
  private maybeRollover() {
    const now = Date.now();
    const weekEnd = this.weekStart + WEEK_MS;
    if (now < weekEnd) return;

    // Award the completed week (ties go uncounted)
    if (this.weeklyTendie > this.weeklyDimmie) {
      this.weeksWonTendie += 1;
    } else if (this.weeklyDimmie > this.weeklyTendie) {
      this.weeksWonDimmie += 1;
    }

    // Reset for the current week
    this.weeklyTendie = 0;
    this.weeklyDimmie = 0;
    this.weekStart = getMonday(now);

    // Persist rollover state
    this.ctx.storage.put('weekly_tendie', 0);
    this.ctx.storage.put('weekly_dimmie', 0);
    this.ctx.storage.put('week_start', this.weekStart);
    this.ctx.storage.put('weeks_won_tendie', this.weeksWonTendie);
    this.ctx.storage.put('weeks_won_dimmie', this.weeksWonDimmie);
  }

  private buildPayload(type: 'init' | 'tick') {
    const topCountries = Object.entries(this.countryDips)
      .filter(([country]) => country && country !== 'XX')
      .map(([country, dips]) => ({ country, dips }))
      .sort((a, b) => b.dips - a.dips)
      .slice(0, 50);

    return JSON.stringify({
      type,
      tendie_dips: this.tendieDips,
      dimmie_dips: this.dimmieDips,
      weekly_tendie: this.weeklyTendie,
      weekly_dimmie: this.weeklyDimmie,
      weeks_won_tendie: this.weeksWonTendie,
      weeks_won_dimmie: this.weeksWonDimmie,
      week_ends: this.weekStart + WEEK_MS,
      top_countries: topCountries,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      // Plain GET → return current scores as JSON
      this.maybeRollover();
      return new Response(this.buildPayload('init'), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const country = request.headers.get('X-Client-Country') || 'XX';
    const city = request.headers.get('X-Client-City') || '';
    const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server);

    let ipState = this.ipStates.get(ip);
    if (!ipState) {
      ipState = {
        tokens: BUCKET_CAPACITY,
        lastRefill: Date.now(),
        recentDips: [],
        activeSockets: 1,
        permanentBot: false,
        cooldownUntil: 0,
      };
      this.ipStates.set(ip, ipState);
    } else {
      ipState.activeSockets += 1;
      if (ipState.activeSockets > MAX_CONCURRENT_SOCKETS_PER_IP) {
        ipState.permanentBot = true;
      }
    }

    this.sockets.set(server, {
      ip,
      country,
      city,
      lastDipTime: 0,
      dipIntervals: [],
      continuousDips: 0,
    });

    // Check for weekly rollover on new connections
    this.maybeRollover();

    server.send(this.buildPayload('init'));

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

        // 1. Hard Physical Animation Gate (drop clicks faster than 380ms)
        if (interval < MIN_DIP_INTERVAL_MS) {
          return;
        }

        const ipState = this.ipStates.get(meta.ip);

        // 2. Check if IP is permanently flagged as a bot
        if (ipState && ipState.permanentBot) {
          return;
        }

        // 3. Check Option A: Human 3-Minute Cooldown Penalty Box
        if (ipState && ipState.cooldownUntil > 0) {
          if (now < ipState.cooldownUntil) {
            // Still in penalty box — ignore clicks silently
            return;
          } else {
            // Cooldown has expired! Reset human back to clean standing
            ipState.cooldownUntil = 0;
            ipState.tokens = BUCKET_CAPACITY;
            ipState.recentDips = [];
            meta.continuousDips = 0;
          }
        }

        // 4. Token Bucket & Velocity Rate Limiting
        if (ipState) {
          const elapsedSec = (now - ipState.lastRefill) / 1000;
          ipState.tokens = Math.min(BUCKET_CAPACITY, ipState.tokens + elapsedSec * TOKEN_REFILL_RATE);
          ipState.lastRefill = now;

          // Prune timestamps older than 60s
          ipState.recentDips = ipState.recentDips.filter(t => now - t < 60000);

          // If out of tokens or exceeding 250 dips/min, trigger human 15s cooldown
          if (ipState.tokens < 1 || ipState.recentDips.length >= MAX_DIPS_PER_MINUTE) {
            ipState.cooldownUntil = now + HUMAN_COOLDOWN_MS;
            return;
          }

          ipState.tokens -= 1;
          ipState.recentDips.push(now);
        }

        // 5. Continuous Streak Tracking
        if (interval < 1000) {
          meta.continuousDips += 1;
        } else {
          meta.continuousDips = 0;
        }

        // Over 150 rapid continuous clicks without taking a breath -> 15s cooldown
        if (meta.continuousDips > 150) {
          if (ipState) ipState.cooldownUntil = now + HUMAN_COOLDOWN_MS;
          meta.continuousDips = 0;
          return;
        }

        // 6. Robotic Autoclicker Jitter Analysis (Hard Bot Kill)
        meta.dipIntervals.push(interval);
        if (meta.dipIntervals.length > 12) {
          meta.dipIntervals.shift();
        }

        if (meta.dipIntervals.length >= 10) {
          const mean = meta.dipIntervals.reduce((a, b) => a + b, 0) / meta.dipIntervals.length;
          const variance =
            meta.dipIntervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
            meta.dipIntervals.length;
          const stdDev = Math.sqrt(variance);

          // Robotic scripts with identical timing (stdDev < 12ms) are permanently killed as bots
          if (stdDev < 12) {
            if (ipState) ipState.permanentBot = true;
            return;
          }
        }

        meta.lastDipTime = now;

        // Check for rollover before counting
        this.maybeRollover();

        // Commit dip to both all-time and weekly totals
        if (data.side === 'tendie') {
          this.tendieDips += 1;
          this.weeklyTendie += 1;
        } else {
          this.dimmieDips += 1;
          this.weeklyDimmie += 1;
        }

        if (meta.country && meta.country !== 'XX') {
          this.countryDips[meta.country] = (this.countryDips[meta.country] || 0) + 1;
        }

        // Broadcast instantaneous live dip event to all other active clients
        const worldDipPayload = JSON.stringify({
          type: 'world_dip',
          side: data.side,
          country: meta.country,
          city: meta.city,
        });

        for (const [socket] of this.sockets) {
          if (socket !== ws) {
            try {
              socket.send(worldDipPayload);
            } catch {
              // Ignore stale socket
            }
          }
        }

        this.dirty = true;
        this.scheduleBroadcast();
      }
    } catch (e) {
      // Ignore malformed client payloads
    }
  }

  async webSocketClose(ws: WebSocket) {
    const meta = this.sockets.get(ws);
    if (meta) {
      const ipState = this.ipStates.get(meta.ip);
      if (ipState) {
        ipState.activeSockets = Math.max(0, ipState.activeSockets - 1);
        if (ipState.activeSockets === 0) {
          this.ipStates.delete(meta.ip);
        }
      }
    }
    this.sockets.delete(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
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
      await this.ctx.storage.put('weekly_tendie', this.weeklyTendie);
      await this.ctx.storage.put('weekly_dimmie', this.weeklyDimmie);
      await this.ctx.storage.put('country_dips', this.countryDips);

      // Fan out update to all connected clients
      const payload = this.buildPayload('tick');

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
