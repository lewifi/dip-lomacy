import { DurableObject } from 'cloudflare:workers';
import { sendTickle, type PushSubscription, type VapidConfig } from './push';
import { moderateComment } from './moderation';

// War-room chat: ephemeral rolling buffer, min gap between a socket's comments.
const COMMENT_BUFFER_MAX = 30;
const COMMENT_MIN_INTERVAL_MS = 2000;

interface ChatComment {
  handle: string;
  text: string;
  side: 'tendie' | 'dimmie';
  ts: number;
}

// Fire the weekly reminder only inside this window before the Monday reset.
const REMINDER_WINDOW_MS = 36 * 60 * 60 * 1000;

interface StoredSub {
  sub: PushSubscription;
  side: 'tendie' | 'dimmie';
  lastNotifiedWeek: number; // week_start value we last pinged for (dedup)
}

export interface Env {
  GLOBAL_WAR: DurableObjectNamespace<GlobalWarDO>;
  ASSETS?: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

interface SocketMetadata {
  ip: string;
  country: string;
  city: string;
  lastDipTime: number;
  dipIntervals: number[];
  continuousDips: number;
  lastCommentTime: number;
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

// Cheap, stable, non-reversible tag for an IP so `wrangler tail` can tell sources
// apart without logging real addresses. Debug aid only.
function hashIp(ip: string): string {
  let h = 5381;
  for (let i = 0; i < ip.length; i++) h = ((h << 5) + h + ip.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 6);
}

// Rate limiting parameters (generous high-energy clicker profile)
const BUCKET_CAPACITY = 150;
const TOKEN_REFILL_RATE = 12.0; // tokens per second
const MIN_DIP_INTERVAL_MS = 60; // allows rapid multi-finger clicking up to 16 clicks/sec
const MAX_DIPS_PER_MINUTE = 600; // generous session headroom (up to 10 dips/sec sustained)
const MAX_CONCURRENT_SOCKETS_PER_IP = 15;
const HUMAN_COOLDOWN_MS = 5 * 1000; // 5-second short breather if capacity fully exhausted

export class GlobalWarDO extends DurableObject<Env> {
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
  private comments: ChatComment[] = [];
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
      this.comments = (await s.get<ChatComment[]>('recent_comments')) ?? [];

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
      const url = new URL(request.url);

      // Register a push subscription for the weekly reminder.
      if (request.method === 'POST' && url.pathname === '/subscribe') {
        return this.handleSubscribe(request);
      }

      // Cron-triggered: send weekly reminders to the losing side, if in window.
      if (request.method === 'POST' && url.pathname === '/reminders/run') {
        return this.runReminders();
      }

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
      // Reset any accidental historical permanent ban on reconnect
      ipState.permanentBot = false;
    }

    this.sockets.set(server, {
      ip,
      country,
      city,
      lastDipTime: 0,
      dipIntervals: [],
      continuousDips: 0,
      lastCommentTime: 0,
    });

    // Pin identity onto the socket so it survives DO hibernation (in-memory
    // maps are wiped on wake; this attachment is restored with the socket).
    server.serializeAttachment({ ip, country, city });

    // Check for weekly rollover on new connections
    this.maybeRollover();

    server.send(this.buildPayload('init'));
    if (this.comments.length) {
      server.send(JSON.stringify({ type: 'comments', items: this.comments }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // War-room chat: moderate server-side, buffer, and broadcast to every tab.
  private async handleComment(ws: WebSocket, rawText: unknown, sideRaw: unknown) {
    const meta = this.metaFor(ws);
    if (!meta) return;

    const now = Date.now();
    if (now - meta.lastCommentTime < COMMENT_MIN_INTERVAL_MS) return; // rate limit
    const ipState = this.ipStateFor(meta.ip);
    if (ipState.permanentBot) return;

    const result = moderateComment(typeof rawText === 'string' ? rawText : '');
    if (!result.ok) return; // hate/empty/link-only → silently dropped

    meta.lastCommentTime = now;

    const side: 'tendie' | 'dimmie' = sideRaw === 'dimmie' ? 'dimmie' : 'tendie';
    const handle =
      meta.city && meta.country !== 'XX'
        ? `${meta.city} ${meta.country}`
        : meta.country && meta.country !== 'XX'
        ? meta.country
        : '🌍';

    const comment: ChatComment = { handle, text: result.text, side, ts: now };
    this.comments.push(comment);
    if (this.comments.length > COMMENT_BUFFER_MAX) {
      this.comments = this.comments.slice(-COMMENT_BUFFER_MAX);
    }
    await this.ctx.storage.put('recent_comments', this.comments);

    // Broadcast to all tabs, sender included (so they see their own line land).
    const payload = JSON.stringify({ type: 'comment', handle, text: result.text, side, ts: now });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // ignore stale socket
      }
    }
  }

  // Rebuild per-socket metadata from the hibernation attachment when the
  // in-memory map was wiped (DO woke from hibernation). Without this, a woken
  // DO would drop every dip from a still-open socket it no longer "remembers".
  private metaFor(ws: WebSocket): SocketMetadata | null {
    let meta = this.sockets.get(ws);
    if (meta) return meta;
    const att = ws.deserializeAttachment() as
      | { ip: string; country: string; city: string }
      | null;
    if (!att) return null;
    meta = {
      ip: att.ip,
      country: att.country,
      city: att.city,
      lastDipTime: 0,
      dipIntervals: [],
      continuousDips: 0,
      lastCommentTime: 0,
    };
    this.sockets.set(ws, meta);
    return meta;
  }

  // Get or lazily recreate the per-IP rate state (also wiped by hibernation).
  private ipStateFor(ip: string): IpRateState {
    let st = this.ipStates.get(ip);
    if (!st) {
      st = {
        tokens: BUCKET_CAPACITY,
        lastRefill: Date.now(),
        recentDips: [],
        activeSockets: 1,
        permanentBot: false,
        cooldownUntil: 0,
      };
      this.ipStates.set(ip, st);
    }
    return st;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') return;
      const data = JSON.parse(message);

      if (data.type === 'comment') {
        await this.handleComment(ws, data.text, data.side);
        return;
      }

      if (data.type === 'dip' && (data.side === 'tendie' || data.side === 'dimmie')) {
        const meta = this.metaFor(ws);
        if (!meta) return;

        const now = Date.now();
        const interval = meta.lastDipTime > 0 ? now - meta.lastDipTime : 1000;

        // 1. Hard Physical Animation Gate (drop clicks faster than 380ms)
        if (interval < MIN_DIP_INTERVAL_MS) {
          return;
        }

        const ipState = this.ipStateFor(meta.ip);

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

        // Over 350 rapid continuous clicks without taking a breath -> 5s breather
        if (meta.continuousDips > 350) {
          if (ipState) ipState.cooldownUntil = now + HUMAN_COOLDOWN_MS;
          meta.continuousDips = 0;
          return;
        }

        // 6. Robotic Autoclicker Jitter Analysis (Hard Bot Kill)
        meta.dipIntervals.push(interval);
        if (meta.dipIntervals.length > 15) {
          meta.dipIntervals.shift();
        }

        if (meta.dipIntervals.length >= 14) {
          const mean = meta.dipIntervals.reduce((a, b) => a + b, 0) / meta.dipIntervals.length;
          const variance =
            meta.dipIntervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
            meta.dipIntervals.length;
          const stdDev = Math.sqrt(variance);

          // Robotic scripts with zero interval jitter (stdDev < 6ms) are blocked
          if (stdDev < 6) {
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

        // DEBUG: per-dip trace for `wrangler tail` — source is a hashed IP (no PII).
        // Grep the tail for "CH" to see whether Zurich is one hash or many. Remove
        // once the bot-vs-players question is answered.
        console.log(`DIP ${data.side} ${meta.country} ${hashIp(meta.ip)}`);

        // Broadcast instantaneous live dip event to all other active clients
        const worldDipPayload = JSON.stringify({
          type: 'world_dip',
          side: data.side,
          country: meta.country,
          city: meta.city,
        });

        for (const socket of this.ctx.getWebSockets()) {
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

  // Store (or update) a push subscription keyed by its endpoint.
  private async handleSubscribe(request: Request): Promise<Response> {
    try {
      const body = await request.json<{ subscription?: PushSubscription; side?: string }>();
      const sub = body.subscription;
      const side = body.side === 'dimmie' ? 'dimmie' : 'tendie';
      if (!sub || !sub.endpoint) {
        return new Response(JSON.stringify({ error: 'missing subscription' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const key = 'sub:' + sub.endpoint;
      const existing = await this.ctx.storage.get<StoredSub>(key);
      await this.ctx.storage.put<StoredSub>(key, {
        sub,
        side,
        lastNotifiedWeek: existing?.lastNotifiedWeek ?? 0,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Ping only losing-side subscribers, only inside the pre-reset window, once per week.
  private async runReminders(): Promise<Response> {
    this.maybeRollover();

    const cfg = this.vapidConfig();
    if (!cfg) {
      return new Response(JSON.stringify({ error: 'vapid not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Date.now();
    const weekEnds = this.weekStart + WEEK_MS;
    const inWindow = weekEnds - now <= REMINDER_WINDOW_MS && weekEnds - now > 0;
    if (!inWindow) {
      return new Response(JSON.stringify({ sent: 0, reason: 'outside window' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Which side is currently losing (ties → nobody gets nagged).
    let losingSide: 'tendie' | 'dimmie' | null = null;
    if (this.weeklyTendie < this.weeklyDimmie) losingSide = 'tendie';
    else if (this.weeklyDimmie < this.weeklyTendie) losingSide = 'dimmie';
    if (!losingSide) {
      return new Response(JSON.stringify({ sent: 0, reason: 'tie' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const entries = await this.ctx.storage.list<StoredSub>({ prefix: 'sub:' });
    let sent = 0;
    let pruned = 0;

    for (const [key, stored] of entries) {
      if (stored.side !== losingSide) continue;
      if (stored.lastNotifiedWeek === this.weekStart) continue; // already pinged this week

      let status = 0;
      try {
        status = await sendTickle(stored.sub, cfg);
      } catch (e) {
        continue;
      }

      if (status === 404 || status === 410) {
        await this.ctx.storage.delete(key); // subscription expired
        pruned++;
        continue;
      }
      if (status >= 200 && status < 300) {
        stored.lastNotifiedWeek = this.weekStart;
        await this.ctx.storage.put<StoredSub>(key, stored);
        sent++;
      }
    }

    return new Response(JSON.stringify({ sent, pruned, losingSide }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private vapidConfig(): VapidConfig | null {
    const publicKey = this.env.VAPID_PUBLIC_KEY;
    const privateKey = this.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) return null;
    return {
      publicKey,
      privateKey,
      subject: this.env.VAPID_SUBJECT || 'mailto:lewi.hirvela@gmail.com',
    };
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

      // Fan out update to all connected clients (getWebSockets survives
      // hibernation, so woken DOs still reach tabs opened before the nap).
      const payload = this.buildPayload('tick');

      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(payload);
        } catch {
          // Socket closed ungracefully
        }
      }
    }, 100);
  }
}
