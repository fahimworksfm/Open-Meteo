// intro.js — the first-visit fly-in: orbit → into a cyclone → white cloud, scrubbed by
// scroll. The video ships as a WebP frame sequence (frame-exact seeking that a <video>
// element can't do smoothly on phones). Its last frame is mist, so the handoff to the
// live world — which has been loading underneath the whole time — is a plain fade,
// whatever place the world turns out to be.

const FRAMES = 96;
const SRC = i => `assets/intro/${String(i + 1).padStart(3, '0')}.webp`;
const SEEN_KEY = 'meteora.introSeen';

// captions, keyed to scroll progress [start, end]
const CAPTIONS = [
  { at: [0.0, 0.22], title: 'METEORA', sub: "Earth's real weather, as a living world" },
  { at: [0.26, 0.48], sub: 'Inside, every cloud, raindrop and gust is live Open-Meteo data' },
  { at: [0.52, 0.72], sub: 'Scrub time from 1940 to 16 days ahead' },
  { at: [0.78, 0.94], sub: 'Dropping you in…' },
];

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

export function shouldPlayIntro() {
  if (new URLSearchParams(location.search).has('nointro')) return false;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return storageGet(SEEN_KEY) !== '1';
}

// onCover(): the intro now hides the world; onReveal(): it has started fading out.
export function playIntro({ onCover, onReveal } = {}) {
  if (document.getElementById('intro')) return;

  const root = document.createElement('div');
  root.id = 'intro';
  root.tabIndex = -1;
  root.innerHTML = `
    <canvas class="intro-canvas"></canvas>
    <div class="intro-captions">
      ${CAPTIONS.map((c, i) => `
        <div class="intro-cap" data-i="${i}">
          ${c.title ? `<div class="intro-title">${c.title}</div>` : ''}
          <div class="intro-sub">${c.sub}</div>
        </div>`).join('')}
    </div>
    <div class="intro-hint" aria-hidden="true"><span>scroll</span><i></i></div>
    <button class="intro-skip chip-btn" type="button">Skip intro</button>
    <div class="intro-spacer"></div>`;
  document.body.appendChild(root);

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const caps = [...root.querySelectorAll('.intro-cap')];
  const hint = root.querySelector('.intro-hint');

  // ---- frames: every 8th first so the whole range is scrubbable fast, then fill in
  const imgs = new Array(FRAMES).fill(null);
  const order = [];
  for (let step of [8, 4, 2, 1]) {
    for (let i = 0; i < FRAMES; i += step) if (!order.includes(i)) order.push(i);
  }
  let alive = true;
  let inflight = 0;
  const pump = () => {
    while (alive && inflight < 6 && order.length) {
      const i = order.shift();
      const img = new Image();
      img.decoding = 'async';
      inflight++;
      img.onload = () => { imgs[i] = img; inflight--; dirty = true; pump(); };
      img.onerror = () => { inflight--; pump(); };
      img.src = SRC(i);
    }
  };
  pump();

  // nearest loaded frame, so an unloaded frame never blanks the canvas
  const nearest = i => {
    for (let d = 0; d < FRAMES; d++) {
      if (imgs[i - d]) return imgs[i - d];
      if (imgs[i + d]) return imgs[i + d];
    }
    return null;
  };

  // ---- sizing
  let cw = 0, ch = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = canvas.width = Math.round(window.innerWidth * dpr);
    ch = canvas.height = Math.round(window.innerHeight * dpr);
    dirty = true;
  };
  window.addEventListener('resize', resize);

  // ---- draw loop: eased toward the scroll target so wheel steps glide
  let target = 0;      // scroll progress 0..1
  let shown = 0;       // eased progress
  let dirty = true;
  let lastFrame = -1;
  let done = false;
  let lastT = performance.now();

  const draw = (now = performance.now()) => {
    if (!alive) return;
    requestAnimationFrame(draw);
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    shown += (target - shown) * (1 - Math.exp(-dt * 7)); // same glide at any frame rate
    if (Math.abs(target - shown) < 0.0004) shown = target;

    const f = Math.min(FRAMES - 1, Math.round(shown * (FRAMES - 1)));
    if (f !== lastFrame || dirty) {
      const img = nearest(f);
      if (img) {
        // cover-fit, keep the cyclone centred on any aspect
        const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
        lastFrame = f;
        dirty = false;
      }
    }

    for (let i = 0; i < caps.length; i++) {
      const [a, b] = CAPTIONS[i].at;
      const fadeIn = Math.min(1, Math.max(0, (shown - a) / 0.05));
      const fadeOut = Math.min(1, Math.max(0, (b - shown) / 0.05));
      const o = i === 0 ? Math.min(1, Math.max(0, (b - shown) / 0.06)) : Math.min(fadeIn, fadeOut);
      caps[i].style.opacity = o.toFixed(3);
      caps[i].style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
    }
    hint.style.opacity = Math.max(0, 1 - shown * 12).toFixed(3);

    if (!done && shown > 0.98) finish();
  };

  const onScroll = () => {
    const max = root.scrollHeight - root.clientHeight;
    target = max > 0 ? Math.min(1, root.scrollTop / max) : 0;
  };
  root.addEventListener('scroll', onScroll, { passive: true });

  function finish() {
    if (done) return;
    done = true;
    storageSet(SEEN_KEY, '1');
    root.classList.add('leaving');
    if (onReveal) onReveal();
    setTimeout(() => {
      alive = false;
      window.removeEventListener('resize', resize);
      root.remove();
    }, 1300);
  }

  root.querySelector('.intro-skip').addEventListener('click', finish);
  root.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') finish(); });

  if (onCover) onCover();
  resize();
  root.focus({ preventScroll: true }); // arrow keys / space scroll the intro
  requestAnimationFrame(draw);
}
