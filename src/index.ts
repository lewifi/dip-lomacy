import { Hono } from 'hono';
import { GlobalWarDO, Env } from './durable_object';
import { handleOG } from './og';

export { GlobalWarDO };

const BLOCKED_IPS = new Set<string>([
  '167.71.60.195', // DigitalOcean Frankfurt Bot VPS
  '35.236.214.210', // Google Cloud (us-east4) Bot VPS
]);

const DISCORD_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1541822387220254820/YmFJys_ILv72Mugijqru5n7QmyIxkYbW0W8E_x9Wtb3KZ-amO0zw0WeX2jWGzui-3Jxx';

const app = new Hono<{ Bindings: Env }>();

const DYNAMIC_BANNED_IPS = new Set<string>();

// Global edge middleware: Drop banned IPs & monitor velocity with Gemini AI Sentinel
app.use('*', async (c, next) => {
  const clientIP = (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').trim();

  // Fast-path 403 drop for static and dynamically banned IPs
  if (clientIP && (BLOCKED_IPS.has(clientIP) || DYNAMIC_BANNED_IPS.has(clientIP))) {
    return c.text('Forbidden', 403);
  }

  // Check persistent edge cache ban list
  if (clientIP) {
    try {
      const banCacheReq = new Request(`https://banned-ips.local/${clientIP}`);
      const isBanned = await caches.default.match(banCacheReq);
      if (isBanned) {
        DYNAMIC_BANNED_IPS.add(clientIP);
        return c.text('Forbidden', 403);
      }
    } catch {}
  }

  // Sentinel Tripwire: track request velocity per IP in edge cache
  if (clientIP && clientIP !== '193.32.127.221' && clientIP !== '127.0.0.1' && clientIP !== '0.0.0.0') {
    try {
      const cacheKey = `https://traffic-limit.local/${clientIP}`;
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

      // Tripwire threshold: Trigger Gemini 1.5 Flash-8B AI Analysis at 16 requests/min
      if (currentHits === 16) {
        const cf = (c.req.raw as any).cf;
        const country = cf?.country || c.req.header('cf-ipcountry') || 'Unknown';
        const city = cf?.city || 'Unknown';
        const asOrg = cf?.asOrganization || 'Unknown ISP/Host';
        const asn = cf?.asn || 0;
        const userAgent = c.req.header('user-agent') || 'None';
        const origin = c.req.header('origin') || 'None';

        c.executionCtx.waitUntil((async () => {
          let aiVerdict = {
            risk_level: 'HIGH',
            action: 'AUTO_BAN',
            confidence_pct: 95,
            summary: 'High-velocity connection burst detected.',
          };

          // Query Gemini 1.5 Flash-8B for autonomous threat opinion
          if (c.env.GEMINI_API_KEY) {
            try {
              const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${c.env.GEMINI_API_KEY}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [
                      {
                        parts: [
                          {
                            text: `You are an automated edge security analyst for dip-lomacy.com (a fast-paced web game).
Evaluate whether this client is an automated bot/cloud scraper or a legitimate human player.
Telemetry:
- IP: ${clientIP}
- Location: ${city}, ${country}
- ASN / Host: ${asOrg} (AS${asn})
- User-Agent: ${userAgent}
- Origin Header: ${origin}
- Velocity: ${currentHits} HTTP requests in 60s

Rule Guide:
1. If the ASN is a cloud host (DigitalOcean, Google Cloud, AWS, Hetzner, Linode, OVH, M247, etc.) or missing browser headers, classify as HIGH risk and AUTO_BAN.
2. If it is a residential/mobile ISP (Telstra, Comcast, Swisscom, AT&T, Charter, etc.) with browser headers, classify as LOW risk and ALLOW_HUMAN (standard in-game fatigue handles human mashers).

Respond ONLY with raw valid JSON:
{
  "risk_level": "HIGH" | "MEDIUM" | "LOW",
  "action": "AUTO_BAN" | "ALLOW_HUMAN",
  "confidence_pct": number,
  "summary": "1-2 sentence explanation"
}`
                          }
                        ]
                      }
                    ],
                    generationConfig: {
                      responseMimeType: 'application/json',
                      temperature: 0.1
                    }
                  })
                }
              );

              if (geminiRes.ok) {
                const geminiJson: any = await geminiRes.json();
                const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  aiVerdict = JSON.parse(text);
                }
              }
            } catch (err) {
              console.error('Gemini security audit error:', err);
            }
          }

          // Execute autonomous ban if ruled AUTO_BAN
          if (aiVerdict.action === 'AUTO_BAN' || aiVerdict.risk_level === 'HIGH') {
            DYNAMIC_BANNED_IPS.add(clientIP);
            // Cache ban for 24 hours at the edge
            const banCacheReq = new Request(`https://banned-ips.local/${clientIP}`);
            const banCacheRes = new Response(JSON.stringify({ banned: true, reason: aiVerdict.summary }), {
              headers: { 'Cache-Control': 'max-age=86400' },
            });
            await caches.default.put(banCacheReq, banCacheRes);

            // Notify Discord of autonomous ban
            await fetch(DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content:
                  `🛡️ **AUTONOMOUS AI BOT BAN EXECUTED!** 🛡️\n` +
                  `An unauthorized automated script was flagged and neutralized at the edge.\n\n` +
                  `➡️ **Offending IP:** \`${clientIP}\` *(Auto-banned with 403)*\n` +
                  `➡️ **Host / ASN:** ${asOrg} (AS${asn}) · ${city}, ${country} 🗺️\n` +
                  `➡️ **AI Model:** Gemini 1.5 Flash-8B (${aiVerdict.confidence_pct}% Confidence)\n` +
                  `➡️ **AI Diagnosis:** ${aiVerdict.summary}\n\n` +
                  `⚡ *Action Taken: Banned at Worker edge. You can paste into Cloudflare WAF when convenient.*`,
              }),
            }).catch(() => {});
          } else {
            // Human player confirmed
            await fetch(DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content:
                  `🟢 **HUMAN TRAFFIC CONFIRMED (Allowed)**\n` +
                  `High activity detected from a verified residential player.\n\n` +
                  `➡️ **IP:** \`${clientIP}\` (${asOrg}) · ${city}, ${country}\n` +
                  `➡️ **AI Diagnosis:** ${aiVerdict.summary}\n` +
                  `🎮 *Standard in-game fatigue limits applied. No ban enacted.*`,
              }),
            }).catch(() => {});
          }
        })());
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
