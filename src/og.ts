// Dynamic OG share card — renders live tug-of-war scores as a PNG.
// Uses workers-og (Satori + resvg-wasm under the hood).
import React from 'react';
import { ImageResponse } from 'workers-og';
import type { Env } from './durable_object';

// Fonts loaded once per isolate, cached in module scope.
const BUNGEE_SHADE_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/bungee-shade@latest/latin-400-normal.ttf';
const SPACE_URL  = 'https://cdn.jsdelivr.net/fontsource/fonts/space-mono@latest/latin-700-normal.ttf';

let FONTS: { name: string; data: ArrayBuffer; style: string; weight: number }[] | null = null;
async function loadFonts() {
  if (FONTS) return FONTS;
  const [bungeeShade, space] = await Promise.all([
    fetch(BUNGEE_SHADE_URL).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
    fetch(SPACE_URL).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
  ]);
  const fonts: typeof FONTS = [];
  if (bungeeShade) fonts.push({ name: 'Bungee Shade', data: bungeeShade, style: 'normal', weight: 400 });
  if (space)  fonts.push({ name: 'Space Mono', data: space, style: 'normal', weight: 700 });
  FONTS = fonts;
  return FONTS;
}

// Mascot SVGs loaded once per isolate, cached as base64 data URIs.
let TENDIE_URI: string | null = null;
let DIMMIE_URI: string | null = null;

async function loadMascots(env: Env): Promise<{ tendieUri: string | null; dimmieUri: string | null }> {
  if (TENDIE_URI !== null && DIMMIE_URI !== null) {
    return { tendieUri: TENDIE_URI, dimmieUri: DIMMIE_URI };
  }
  if (!env.ASSETS) {
    return { tendieUri: null, dimmieUri: null };
  }

  const [tendieRes, dimmieRes] = await Promise.all([
    env.ASSETS.fetch(new Request('https://dummy/assets/tendie_og.png')).catch(() => null),
    env.ASSETS.fetch(new Request('https://dummy/assets/dimmie_og.png')).catch(() => null),
  ]);

  if (tendieRes?.ok) {
    const buf = await tendieRes.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    TENDIE_URI = `data:image/png;base64,${b64}`;
  }
  if (dimmieRes?.ok) {
    const buf = await dimmieRes.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    DIMMIE_URI = `data:image/png;base64,${b64}`;
  }

  return { tendieUri: TENDIE_URI, dimmieUri: DIMMIE_URI };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function getWeekLabel(ts: number = Date.now()): string {
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `WEEK ${weekNo} · ${date.getUTCFullYear()}`;
}

interface Scores {
  tendie_dips: number;
  dimmie_dips: number;
  weekly_tendie: number;
  weekly_dimmie: number;
  weeks_won_tendie: number;
  weeks_won_dimmie: number;
  week_ends?: number;
}

function renderCard(
  h: typeof React.createElement,
  s: Scores,
  tendieUri: string | null,
  dimmieUri: string | null,
) {
  const wt = s.weekly_tendie;
  const wd = s.weekly_dimmie;
  const total = wt + wd;
  const tPct = total === 0 ? 50 : Math.round((wt / total) * 100);
  const dPct = 100 - tPct;

  const TENDIE_CLR = '#d97706';
  const DIMMIE_CLR = '#dc2626';

  return h('div', {
    style: {
      width: '1200px', height: '630px', display: 'flex', flexDirection: 'column' as const,
      alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(145deg, #3e2a14 0%, #5c3d1e 40%, #4a3018 100%)',
      fontFamily: 'Space Mono', color: '#ffffff', position: 'relative' as const,
      overflow: 'hidden',
    },
  }, [
    // Wood grain texture lines (decorative)
    ...([0.15, 0.35, 0.55, 0.75, 0.92].map((y, i) =>
      h('div', {
        key: `g${i}`,
        style: {
          position: 'absolute' as const, left: '0', right: '0',
          top: `${y * 100}%`, height: '1px',
          background: `rgba(255,255,255,${0.03 + (i % 2) * 0.02})`,
        },
      })
    )),

    // Tendie mascot (left - double size)
    tendieUri ? h('img', {
      key: 'tendie-img',
      src: tendieUri,
      width: 560,
      height: 620,
      style: {
        position: 'absolute' as const, left: '-60px', bottom: '-40px',
        width: '560px', height: '620px', objectFit: 'contain' as const,
      },
    }) : null,

    // Dimmie mascot (right - double size)
    dimmieUri ? h('img', {
      key: 'dimmie-img',
      src: dimmieUri,
      width: 560,
      height: 620,
      style: {
        position: 'absolute' as const, right: '-60px', bottom: '-40px',
        width: '560px', height: '620px', objectFit: 'contain' as const,
      },
    }) : null,

    // Center content stack
    h('div', {
      key: 'center-stack',
      style: {
        display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
        justifyContent: 'center', width: '640px', position: 'relative' as const,
      },
    }, [
      // Title
      h('div', {
        key: 'title',
        style: {
          fontFamily: 'Bungee Shade', fontSize: '66px', letterSpacing: '4px',
          color: '#ffffff', marginBottom: '6px', display: 'flex',
          textShadow: '3px 3px 0 rgba(0,0,0,0.4)', whiteSpace: 'nowrap' as const,
        },
      }, 'DIP-LOMACY'),

      // Subtitle
      h('div', {
        key: 'sub',
        style: {
          fontSize: '18px', letterSpacing: '8px', color: 'rgba(255,255,255,0.6)',
          marginBottom: '8px', display: 'flex',
        },
      }, 'THE GLOBAL SNACK WAR'),

      // Tagline Question
      h('div', {
        key: 'question',
        style: {
          fontSize: '24px', letterSpacing: '3px', color: 'rgba(255,255,255,0.95)',
          fontWeight: 700, marginBottom: '24px', display: 'flex',
        },
      }, 'WHO WILL GET GOOD BOY POINTS?'),

      // Centre: tug-of-war bar and scores
      h('div', {
        key: 'war',
        style: {
          display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
          width: '500px',
        },
      }, [
        // Labels row
        h('div', {
          key: 'labels',
          style: {
            display: 'flex', justifyContent: 'space-between', width: '100%',
            marginBottom: '12px',
          },
        }, [
          h('div', {
            key: 'tl',
            style: { display: 'flex', alignItems: 'baseline', gap: '10px' },
          }, [
            h('span', {
              key: 'tn',
              style: { fontFamily: 'Space Mono', fontSize: '26px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.8)' },
            }, 'TENDIE'),
            h('span', {
              key: 'tp',
              style: { fontSize: '26px', color: TENDIE_CLR, fontWeight: 700 },
            }, `${tPct}%`),
          ]),
          h('div', {
            key: 'dl',
            style: { display: 'flex', alignItems: 'baseline', gap: '10px' },
          }, [
            h('span', {
              key: 'dp',
              style: { fontSize: '26px', color: DIMMIE_CLR, fontWeight: 700 },
            }, `${dPct}%`),
            h('span', {
              key: 'dn',
              style: { fontFamily: 'Space Mono', fontSize: '26px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.8)' },
            }, 'DIMMIE'),
          ]),
        ]),

        // Bar track
        h('div', {
          key: 'track',
          style: {
            width: '100%', height: '36px', borderRadius: '18px',
            background: 'rgba(0,0,0,0.35)', display: 'flex', overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.12)',
          },
        }, [
          h('div', {
            key: 'tf',
            style: {
              width: `${tPct}%`, height: '100%',
              background: `linear-gradient(90deg, ${TENDIE_CLR}, #f59e0b)`,
              borderRadius: tPct >= 100 ? '18px' : '18px 0 0 18px',
            },
          }),
          h('div', {
            key: 'df',
            style: {
              width: `${dPct}%`, height: '100%',
              background: `linear-gradient(90deg, #ef4444, ${DIMMIE_CLR})`,
              borderRadius: dPct >= 100 ? '18px' : '0 18px 18px 0',
            },
          }),
        ]),

        // Week & Year label
        h('div', {
          key: 'week',
          style: {
            fontSize: '14px', letterSpacing: '4px', color: 'rgba(255,255,255,0.5)',
            marginTop: '12px', display: 'flex',
          },
        }, getWeekLabel(s.week_ends ? s.week_ends - 3600000 : Date.now())),
      ]),

      // All-time stats
      h('div', {
        key: 'stats',
        style: {
          display: 'flex', gap: '36px', marginTop: '24px',
          fontSize: '15px', letterSpacing: '2px', color: 'rgba(255,255,255,0.55)',
        },
      }, [
        h('span', { key: 'at' }, `ALL-TIME: ${fmt(s.tendie_dips)} – ${fmt(s.dimmie_dips)}`),
        h('span', { key: 'sep', style: { opacity: 0.3 } }, '|'),
        h('span', { key: 'ww' }, `WEEKS WON: ${s.weeks_won_tendie} – ${s.weeks_won_dimmie}`),
      ]),
    ]),

    // Domain badge
    h('div', {
      key: 'domain',
      style: {
        position: 'absolute' as const, bottom: '18px', right: '28px',
        fontSize: '12px', letterSpacing: '3px', color: 'rgba(255,255,255,0.25)',
        display: 'flex',
      },
    }, 'DIP-LOMACY.COM'),
  ]);
}

export async function handleOG(env: Env): Promise<Response> {
  try {
    // Fetch live scores from the Durable Object
    const id = env.GLOBAL_WAR.idFromName('global-war-v1');
    const stub = env.GLOBAL_WAR.get(id);
    const res = await stub.fetch(new Request('https://dummy/scores'));
    const scores: Scores = await res.json();

    const [fonts, mascots] = await Promise.all([
      loadFonts(),
      loadMascots(env),
    ]);

    const h = React.createElement;
    const card = renderCard(h, scores, mascots.tendieUri, mascots.dimmieUri);

    const image = new ImageResponse(card, { width: 1200, height: 630, fonts: fonts || [] });
    return new Response(image.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300, s-maxage=600',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
