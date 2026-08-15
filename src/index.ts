import { Hono } from 'hono';
import { GlobalWarDO, Env } from './durable_object';

export { GlobalWarDO };

const app = new Hono<{ Bindings: Env }>();

app.get('/api/ws', (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket connection', 426);
  }

  // Route WebSocket connection to the global war Durable Object singleton
  const id = c.env.GLOBAL_WAR.idFromName('global-war-v1');
  const stub = c.env.GLOBAL_WAR.get(id);

  return stub.fetch(c.req.raw);
});

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', version: '0.4.3' });
});

// Fallback to static assets
app.all('*', async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text('Not found', 404);
});

export default app;
