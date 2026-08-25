// Minimal Web Push (VAPID) sender for Cloudflare Workers.
// Sends a contentless "tickle" push — no payload encryption needed. The service
// worker builds the notification from live scores on receipt (see public/sw.js).

export interface PushSubscription {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}

export interface VapidConfig {
  publicKey: string;   // base64url uncompressed point (65 bytes)
  privateKey: string;  // base64url raw scalar (32 bytes)
  subject: string;     // mailto: or https: contact
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

async function importVapidKey(cfg: VapidConfig): Promise<CryptoKey> {
  // Derive x, y from the uncompressed public point (0x04 || x || y).
  const pub = b64urlToBytes(cfg.publicKey);
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: cfg.privateKey,
    x,
    y,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function signVapidJwt(endpoint: string, cfg: VapidConfig): Promise<string> {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = strToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = strToB64url(
    JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: cfg.subject,
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidKey(cfg);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// Returns the HTTP status. 201 = delivered; 404/410 = subscription gone (prune it).
export async function sendTickle(
  sub: PushSubscription,
  cfg: VapidConfig,
  ttlSeconds = 24 * 60 * 60
): Promise<number> {
  const jwt = await signVapidJwt(sub.endpoint, cfg);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${cfg.publicKey}`,
      TTL: String(ttlSeconds),
      'Content-Length': '0',
    },
  });
  return res.status;
}
