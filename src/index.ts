import { Hono } from 'hono';
import { GlobalWarDO, Env } from './durable_object';
import { handleOG } from './og';

export { GlobalWarDO };

const BLOCKED_IPS = new Set<string>([
  // Static hard bans if needed in future
]);

const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1541822387220254820/YmFJys_ILv72Mugijqru5n7QmyIxkYbW0W8E_x9Wtb3KZ-amO0zw0WeX2jWGzui-3Jxx';

const app = new Hono<{ Bindings: Env }>();

// Fast-path 403 drop for known malicious IPs
app.use('*', async (c, next) => {
  const clientIP = (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').trim();
  if (clientIP && BLOCKED_IPS.has(clientIP)) {
    return c.text('Forbidden', 403);
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

app.post('/api/admin/reload-all', async (c) => {
  const id = c.env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = c.env.GLOBAL_WAR.get(id);
  const res = await stub.fetch(new Request('https://dummy/reload-all', { method: 'POST' }));
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', version: '0.6.0' });
});

// Fallback to static assets with strict HTML cache busting
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
      return new Response(res.body, { status: res.status, headers });
    }
    return res;
  }
  return c.text('Not found', 404);
});

// Cron trigger → ambient heartbeat every minute, plus hourly weekly reminders.
async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
  const id = env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = env.GLOBAL_WAR.get(id);

  // 1. Every minute: ambient heartbeat with 0-25s jitter & randomized global location
  await stub.fetch(new Request('https://dummy/internal/heartbeat', { method: 'POST' }));

  // 2. On the hour (minute === 0): run weekly push reminders (self-gates on window/side)
  const cronDate = new Date(event.scheduledTime);
  if (cronDate.getUTCMinutes() === 0) {
    await stub.fetch(new Request('https://dummy/reminders/run', { method: 'POST' }));
  }
}

export default { fetch: app.fetch, scheduled };
