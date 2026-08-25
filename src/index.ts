import { Hono } from 'hono';
import { GlobalWarDO, Env } from './durable_object';
import { handleOG } from './og';

export { GlobalWarDO };

const app = new Hono<{ Bindings: Env }>();

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
