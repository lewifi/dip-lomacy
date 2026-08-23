// Dip-lomacy Front-End Engine
import { initDip, triggerDip } from './dip';

interface WarState {
  lifeTendie: number;
  lifeDimmie: number;
  todayTendie: number;
  todayDimmie: number;
}

const state: WarState = {
  lifeTendie: 12847392,
  lifeDimmie: 9203118,
  todayTendie: 41230,
  todayDimmie: 58940,
};

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');

// DOM Elements
const elTodayTendie = document.getElementById('todayTendie')!;
const elTodayDimmie = document.getElementById('todayDimmie')!;
const elLifeTendie = document.getElementById('lifeTendie')!;
const elLifeDimmie = document.getElementById('lifeDimmie')!;
const elWarLeadBadge = document.getElementById('warLeadBadge')!;
const elTendieBar = document.getElementById('tendieBar')!;
const elDimmieBar = document.getElementById('dimmieBar')!;

const elStageTendie = document.getElementById('stageTendie')!;
const elStageDimmie = document.getElementById('stageDimmie')!;

const elSplashTendie = document.getElementById('splashTendie')!;
const elSplashDimmie = document.getElementById('splashDimmie')!;

// Load SVG Art inline
async function loadArt() {
  try {
    const [resTendie, resDimmie] = await Promise.all([
      fetch('/assets/tendie.svg'),
      fetch('/assets/XLB.svg'),
    ]);

    const tendieSvgText = await resTendie.text();
    const dimmieSvgText = await resDimmie.text();

    document.getElementById('svgTendieContainer')!.innerHTML = tendieSvgText;
    document.getElementById('svgDimmieContainer')!.innerHTML = dimmieSvgText;

    const tendieSvg = document.querySelector('#svgTendieContainer svg') as SVGSVGElement | null;
    const dimmieSvg = document.querySelector('#svgDimmieContainer svg') as SVGSVGElement | null;
    if (tendieSvg && dimmieSvg) initDip(tendieSvg, dimmieSvg);
  } catch (err) {
    console.error('Failed loading SVG art:', err);
  }
}

// Synthesizer Audio "Blop"
function playBlop(isTendie: boolean) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    const startFreq = isTendie ? 480 : 380;
    osc.frequency.setValueAtTime(startFreq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  } catch (e) {
    // Audio Context not allowed before user gesture
  }
}

// Splash Particle System
function spawnSplashParticles(container: HTMLElement, isRanch: boolean) {
  const particleCount = 8;
  for (let i = 0; i < particleCount; i++) {
    const drop = document.createElement('div');
    drop.className = `splash-drop ${isRanch ? 'ranch-drop' : 'vinegar-drop'}`;

    const angle = (i / particleCount) * Math.PI * 2 + (Math.random() * 0.4 - 0.2);
    const dist = 25 + Math.random() * 25;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 15; // Arc upward slightly

    drop.style.setProperty('--dx', `${dx}px`);
    drop.style.setProperty('--dy', `${dy}px`);

    container.appendChild(drop);
    setTimeout(() => drop.remove(), 350);
  }
}

// Dip Action Triggers
function performDip(side: 'tendie' | 'dimmie') {
  // Optimistic count and responsive feedback on the tap; the visual dip runs on top and
  // restarts if you tap again mid-swing, so rapid dipping stays snappy.
  if (side === 'tendie') {
    state.todayTendie += 1;
    state.lifeTendie += 1;
    playBlop(true);
    spawnSplashParticles(elSplashTendie, true);
  } else {
    state.todayDimmie += 1;
    state.lifeDimmie += 1;
    playBlop(false);
    spawnSplashParticles(elSplashDimmie, false);
  }

  triggerDip(side);
  updateUI();

  // Send to WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'dip', side }));
  }
}

// Update UI & Tug of War Bar
function updateUI() {
  elTodayTendie.textContent = fmt(state.todayTendie);
  elTodayDimmie.textContent = fmt(state.todayDimmie);
  elLifeTendie.textContent = fmt(state.lifeTendie);
  elLifeDimmie.textContent = fmt(state.lifeDimmie);

  const total = state.todayTendie + state.todayDimmie;
  const tendiePct = total > 0 ? (state.todayTendie / total) * 100 : 50;
  const dimmiePct = 100 - tendiePct;

  elTendieBar.style.width = `${tendiePct.toFixed(1)}%`;
  elDimmieBar.style.width = `${dimmiePct.toFixed(1)}%`;

  if (state.todayTendie === state.todayDimmie) {
    elWarLeadBadge.textContent = 'DEAD HEAT';
    elWarLeadBadge.style.color = '#64748b';
  } else if (state.todayTendie > state.todayDimmie) {
    const margin = state.todayTendie - state.todayDimmie;
    elWarLeadBadge.textContent = `TENDIE LEADS BY +${fmt(margin)}`;
    elWarLeadBadge.style.color = '#d97706';
  } else {
    const margin = state.todayDimmie - state.todayTendie;
    elWarLeadBadge.textContent = `DIMMIE LEADS BY +${fmt(margin)}`;
    elWarLeadBadge.style.color = '#dc2626';
  }

}

// Setup WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/ws`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'init' || data.type === 'tick') {
          state.lifeTendie = data.tendie_dips;
          state.lifeDimmie = data.dimmie_dips;
          updateUI();
        }
      } catch (err) {
        // Invalid json
      }
    };

    ws.onclose = () => {
      setTimeout(connectWebSocket, 2000);
    };
  } catch (err) {
    console.warn('WebSocket connection failed, running in local standalone mode.');
  }
}

// Event Listeners
elStageTendie.addEventListener('click', () => performDip('tendie'));
elStageDimmie.addEventListener('click', () => performDip('dimmie'));

elStageTendie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') performDip('tendie');
});
elStageDimmie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') performDip('dimmie');
});

// Initialize
loadArt();
updateUI();
connectWebSocket();
