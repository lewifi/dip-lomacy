import { Hono } from 'hono';
import { GlobalWarDO, Env } from './durable_object';
import { handleOG } from './og';

export { GlobalWarDO };

const BLOCKED_IPS = new Set<string>([
  // Hard-banned IPs go here
]);

const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1541822387220254820/YmFJys_ILv72Mugijqru5n7QmyIxkYbW0W8E_x9Wtb3KZ-amO0zw0WeX2jWGzui-3Jxx';

const app = new Hono<{ Bindings: Env }>();

// Global edge middleware: Drop banned IPs & monitor velocity with Sentinel tripwire
app.use('*', async (c, next) => {
  const clientIP = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '';
  if (BLOCKED_IPS.has(clientIP.trim())) {
    return c.text('Forbidden', 403);
  }

  // Sentinel Tripwire: track request velocity per IP in edge cache
  if (clientIP && clientIP !== '193.32.127.221' && clientIP !== '127.0.0.1' && clientIP !== '0.0.0.0') {
    try {
      const cacheKey = `https://traffic-limit.local/${clientIP.trim()}`;
      const cacheReq = new Request(cacheKey);
      const cachedData = await caches.default.match(cacheReq);
      let currentHits = 1;

      if (cachedData) {
        try {
          const data = await cachedData.json<{ hits: number }>();
          currentHits = (data.hits || 0) + 1;
        } catch {}
      }

      const responseToCache = new Response(JSON.stringify({ hits: currentHits }), {
        headers: { 'Cache-Control': 'max-age=60' },
      });
      c.executionCtx.waitUntil(caches.default.put(cacheReq, responseToCache));

      // Tripwire threshold: alert at 16 (first breach), 50, and 100 requests/min
      if (currentHits === 16 || currentHits === 50 || currentHits === 100) {
        const cf = (c.req.raw as any).cf;
        const country = cf?.country || c.req.header('cf-ipcountry') || 'Unknown';
        const city = cf?.city || 'Unknown';

        c.executionCtx.waitUntil(
          fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content:
                `🔥 **SILENT BOT EXPLOSION DETECTED!** 🔥\n` +
                `An unknown network IP address is rapidly machine-gunning the API.\n\n` +
                `➡️ **Offending IP:** \`${clientIP}\`\n` +
                `➡️ **Location Context:** ${city}, ${country} 🗺️\n` +
                `➡️ **Activity Velocity:** ${currentHits} requests inside 60 seconds\n\n` +
                `⚠️ *Action advised:* Paste this IP straight into Antigravity's block list to seal the breach.`,
            }),
          }).catch(() => {})
        );
      }
    } catch {}
  }

  await next();
});

app.get('/api/og', (c) => handleOG(c.env));

app.get('/api/scores', async (c) => {
  const id = c.env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = c.env.GLOBAL_WAR.get(id);
  const res = await stub.fetch(new Request('https://dummy/scores'));
  return new Response(res.body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' },
  });
});

app.get('/api/ws', (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket connection', 426);
  }

  // Strict Origin verification: block bare proxy scripts / unauthorized callers
  const origin = c.req.header('origin') || '';
  const isAllowedOrigin =
    origin === 'https://dip-lomacy.com' ||
    origin === 'https://www.dip-lomacy.com' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');

  if (!isAllowedOrigin) {
    return c.text('Forbidden: Invalid Origin', 403);
  }

  // Route WebSocket connection to the global war Durable Object singleton
  const id = c.env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = c.env.GLOBAL_WAR.get(id);

  // Forward request with geolocation metadata and real client IP from Cloudflare edge
  const req = new Request(c.req.raw);
  const cf = (c.req.raw as any).cf;
  const country = cf?.country || c.req.header('cf-ipcountry') || 'XX';
  const city = cf?.city || '';
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '127.0.0.1';
  req.headers.set('X-Client-Country', country);
  req.headers.set('X-Client-City', city);
  req.headers.set('CF-Connecting-IP', ip);

  return stub.fetch(req);
});

app.post('/api/subscribe', async (c) => {
  const id = c.env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = c.env.GLOBAL_WAR.get(id);
  const res = await stub.fetch(
    new Request('https://dummy/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await c.req.raw.text(),
    })
  );
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', version: '0.5.0' });
});

// Fallback to static assets
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Not found', 404);
});

// Cron trigger → ask the DO to fire weekly reminders (it self-gates on window/side).
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
  const id = env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = env.GLOBAL_WAR.get(id);
  ctx.waitUntil(stub.fetch(new Request('https://dummy/reminders/run', { method: 'POST' })));
}

export default { fetch: app.fetch, scheduled };
