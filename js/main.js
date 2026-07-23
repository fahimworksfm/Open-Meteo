// main.js — Meteora's conductor. Owns app state (place, timeline, scrub position),
// feeds the 3D world one env object per frame, and wires every piece of UI.

import * as THREE from 'three';
import { geocode, fetchTimelineLive, fetchTimelineArchive, fetchElevationGrid } from './api.js';
import { sunPosition, moonPosition } from './solar.js';
import { grade, describeCode, pickBiome } from './palette.js';
import { World } from './scene/world.js';
import { AudioEngine } from './audio.js';
import { Logbook } from './logbook.js';
import { Duel } from './duel.js';
import { WorldNow } from './worldnow.js';

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const el = {
  loader: $('loader'), loaderStatus: $('loader-status'),
  hud: $('hud'), hudName: $('hud-name'), hudCountry: $('hud-country'),
  hudTemp: $('hud-temp'), hudCondText: $('hud-cond-text'), hudCondTime: $('hud-cond-time'),
  hudWind: $('hud-wind'), hudCloud: $('hud-cloud'), hudHumidity: $('hud-humidity'),
  hudWaveStat: $('hud-wave-stat'), hudWave: $('hud-wave'),
  timebar: $('timebar'), scrub: $('scrub'), scrubDays: $('scrub-days'),
  nowMarker: $('scrub-now-marker'), btnPlay: $('btn-play'), btnNow: $('btn-now'),
  btnExpedition: $('btn-expedition'), expeditionForm: $('expedition-form'),
  expeditionDate: $('expedition-date'), btnExpeditionGo: $('btn-expedition-go'),
  search: $('search'), searchResults: $('search-results'),
  panel: $('panel'), panelTitle: $('panel-title'), panelBody: $('panel-body'), panelClose: $('panel-close'),
  toasts: $('toasts'),
  btnWorldnow: $('btn-worldnow'), btnLogbook: $('btn-logbook'), btnDuel: $('btn-duel'),
  btnSound: $('btn-sound'), btnAbout: $('btn-about'),
};

// ---------- state ----------
const state = {
  place: null,        // {name, country, lat, lon}
  tl: null,           // timeline from api.js
  timeIdx: 0,         // fractional hour index into tl.hours
  liveMode: true,
  playing: false,
  playSpeed: 2.6,     // hours per real second
  loading: false,
  openPanel: null,
  elevGrid: null,
};

const STARTERS = [
  { name: 'Reykjavík', country: 'Iceland', lat: 64.146, lon: -21.94 },
  { name: 'Nazaré', country: 'Portugal', lat: 39.601, lon: -9.07 },
  { name: 'Chamonix', country: 'France', lat: 45.924, lon: 6.869 },
  { name: 'Tromsø', country: 'Norway', lat: 69.649, lon: 18.956 },
  { name: 'Queenstown', country: 'New Zealand', lat: -45.031, lon: 168.663 },
  { name: 'Mount Fuji', country: 'Japan', lat: 35.361, lon: 138.728 },
  { name: 'Banff', country: 'Canada', lat: 51.178, lon: -115.571 },
  { name: 'Santorini', country: 'Greece', lat: 36.393, lon: 25.461 },
  { name: 'El Chaltén', country: 'Argentina', lat: -49.331, lon: -72.886 },
  { name: 'Hilo', country: 'Hawaii, USA', lat: 19.73, lon: -155.09 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, lon: 18.42 },
  { name: 'Zermatt', country: 'Switzerland', lat: 46.02, lon: 7.749 },
];

// ---------- systems ----------
const audio = new AudioEngine();

const logbook = new Logbook((ach) => {
  toast(`<span class="t-ico">${ach.ico}</span><span><b>${ach.name}</b><span class="t-sub">${ach.desc}</span></span>`, 'achievement', 6000);
  flashButton(el.btnLogbook);
});

const duel = new Duel((p) => {
  const msg = p.outcome === 'win'
    ? `You beat the model at ${p.name} — you ${p.guess}°, model ${p.model}°, actual ${p.actual}°`
    : p.outcome === 'loss'
      ? `The model won at ${p.name} — actual ${p.actual}°, you were off by ${p.errUser.toFixed(1)}°`
      : `Dead heat at ${p.name} — actual ${p.actual}°`;
  toast(`<span class="t-ico">🎯</span><span><b>Duel settled</b><span class="t-sub">${msg}</span></span>`, '', 8000);
  flashButton(el.btnDuel);
  checkAchievements(true);
});

const worldNow = new WorldNow();
const world = new World($('scene'), { onStrike: d => audio.thunder(d) });

// ---------- helpers ----------
function toast(html, cls = '', ttl = 5000) {
  const t = document.createElement('div');
  t.className = `toast ${cls}`;
  t.style.setProperty('--ttl', `${ttl}ms`);
  t.innerHTML = html;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), ttl + 700);
}

function flashButton(btn) {
  btn.classList.add('attention');
  setTimeout(() => btn.classList.remove('attention'), 4000);
}

function showLoader(status) {
  el.loaderStatus.textContent = status;
  el.loader.classList.remove('fading', 'hidden');
}
function setLoader(status) { el.loaderStatus.textContent = status; }
function hideLoader() {
  el.loader.classList.add('fading');
  setTimeout(() => el.loader.classList.add('hidden'), 750);
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const windArrow = deg => DIRS[Math.round(((deg % 360) / 45)) % 8];

function localDate(tMs) {
  return new Date(tMs + (state.tl ? state.tl.utcOffsetSeconds : 0) * 1000);
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtLocal(tMs, withYear = false) {
  const d = localDate(tMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const yr = withYear ? ` ${d.getUTCFullYear()}` : '';
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${yr} · ${hh}:${mm} local`;
}

// ---------- timeline math ----------
function nowIdx() {
  if (!state.tl || state.tl.mode !== 'live') return null;
  const i = (Date.now() / 1000 - state.tl.hours[0].t) / 3600;
  return THREE.MathUtils.clamp(i, 0, state.tl.hours.length - 1);
}

function condAt(idx) {
  const hours = state.tl.hours;
  const i0 = THREE.MathUtils.clamp(Math.floor(idx), 0, hours.length - 1);
  const i1 = Math.min(i0 + 1, hours.length - 1);
  const f = THREE.MathUtils.clamp(idx - i0, 0, 1);
  const a = hours[i0], b = hours[i1];
  const L = (x, y) => x + (y - x) * f;
  const dd = ((b.windDir - a.windDir + 540) % 360) - 180;
  const near = f < 0.5 ? a : b;
  return {
    temp: L(a.temp, b.temp),
    humidity: L(a.humidity, b.humidity),
    precip: L(a.precip, b.precip),
    snowfall: L(a.snowfall, b.snowfall),
    code: near.code,
    cloud: L(a.cloud, b.cloud),
    windSpeed: L(a.windSpeed, b.windSpeed),
    windDir: (a.windDir + dd * f + 360) % 360,
    waveH: a.waveH === null ? null : L(a.waveH, b.waveH ?? a.waveH),
    waveP: a.waveP === null ? null : L(a.waveP, b.waveP ?? a.waveP),
  };
}

function timeMs() {
  return (state.tl.hours[0].t + state.timeIdx * 3600) * 1000;
}

function buildScrub() {
  const len = state.tl.hours.length;
  el.scrub.max = String(len - 1);
  el.scrub.value = String(state.timeIdx);

  // day labels — hourly data starts at local midnight, so days are equal segments
  el.scrubDays.innerHTML = '';
  const dayCount = Math.max(1, Math.round(len / 24));
  const todayStr = new Date(Date.now() + state.tl.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
  for (let d = 0; d < dayCount; d++) {
    const t = (state.tl.hours[Math.min(d * 24, len - 1)].t + state.tl.utcOffsetSeconds) * 1000;
    const dd = new Date(t);
    const div = document.createElement('div');
    div.className = 'scrub-day';
    if (dd.toISOString().slice(0, 10) === todayStr && state.tl.mode === 'live') div.classList.add('today');
    div.textContent = `${DAYS[dd.getUTCDay()]} ${dd.getUTCDate()}`;
    el.scrubDays.appendChild(div);
  }

  const ni = nowIdx();
  if (ni !== null) {
    el.nowMarker.style.display = '';
    el.nowMarker.style.left = `${(ni / (len - 1)) * 100}%`;
  } else {
    el.nowMarker.style.display = 'none';
  }
}

// ---------- HUD ----------
let hudTimer = 0;
function updateHUD(cond, tMs, force = false) {
  if (!force && hudTimer > 0) return;
  hudTimer = 0.25;

  el.hudTemp.textContent = `${Math.round(cond.temp)}°`;
  el.hudCondText.textContent = describeCode(cond.code).label;

  const isExpedition = state.tl.mode === 'expedition';
  const ni = nowIdx();
  const isNow = !isExpedition && ni !== null && Math.abs(state.timeIdx - ni) < 0.4;
  el.hudCondTime.textContent = (isNow ? '● LIVE · ' : '') + fmtLocal(tMs, isExpedition);
  el.hud.classList.toggle('time-traveling', isExpedition || !isNow);
  el.btnNow.classList.toggle('live-on', isNow);

  el.hudWind.textContent = `${Math.round(cond.windSpeed)} km/h ${windArrow(cond.windDir)}`;
  el.hudCloud.textContent = `${Math.round(cond.cloud)}%`;
  el.hudHumidity.textContent = `${Math.round(cond.humidity)}%`;
  if (cond.waveH !== null && cond.waveH !== undefined) {
    el.hudWaveStat.classList.remove('hidden');
    el.hudWave.textContent = `${cond.waveH.toFixed(1)} m`;
  } else {
    el.hudWaveStat.classList.add('hidden');
  }
}

// ---------- achievements ----------
let achTimer = 0;
function checkAchievements(force = false) {
  if (!force && achTimer > 0) return;
  achTimer = 2;
  if (!state.tl || !state.place) return;

  const tMs = timeMs();
  const cond = condAt(state.timeIdx);
  const sun = sunPosition(tMs, state.place.lat, state.place.lon);
  const live = state.tl.mode === 'live' && Math.abs(tMs - Date.now()) < 2.5 * 3600e3;
  const d = localDate(tMs);

  logbook.check({
    cond,
    live,
    sunAltDeg: sun.altitude * 180 / Math.PI,
    place: state.place,
    timeMs: tMs,
    localHour: d.getUTCHours(),
    year: state.tl.mode === 'expedition' ? d.getUTCFullYear() : null,
    duelRecord: duel.record,
  });
}

// ---------- per-frame env ----------
const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();
const _windVec = new THREE.Vector3();

function dirFromAzAlt(v, az, alt) {
  return v.set(
    Math.sin(az) * Math.cos(alt),
    Math.sin(alt),
    -Math.cos(az) * Math.cos(alt),
  );
}

world.onFrame = (dt) => {
  hudTimer -= dt;
  achTimer -= dt;
  if (!state.tl || !state.place || state.loading) return;

  const len = state.tl.hours.length;

  if (state.playing) {
    state.timeIdx += dt * state.playSpeed;
    if (state.timeIdx >= len - 1) {
      state.timeIdx = len - 1;
      setPlaying(false);
    }
    el.scrub.value = String(state.timeIdx);
    state.liveMode = false;
  } else if (state.liveMode) {
    const ni = nowIdx();
    if (ni !== null) {
      state.timeIdx = ni;
      el.scrub.value = String(state.timeIdx);
    }
  }

  const tMs = timeMs();
  const cond = condAt(state.timeIdx);
  const sun = sunPosition(tMs, state.place.lat, state.place.lon);
  const moon = moonPosition(tMs, state.place.lat, state.place.lon);
  const g = grade(sun.altitude, cond);

  const toward = ((cond.windDir + 180) % 360) * Math.PI / 180;
  _windVec.set(Math.sin(toward), 0, -Math.cos(toward));

  world.setEnvironment({
    cond,
    grade: g,
    sunDir: dirFromAzAlt(_sunDir, sun.azimuth, sun.altitude),
    moonDir: dirFromAzAlt(_moonDir, moon.azimuth, moon.altitude),
    moonPhase: moon.phase,
    windVec: _windVec,
    windKmh: cond.windSpeed,
    flash: 0,
  });

  audio.setWeather({ windKmh: cond.windSpeed, rain: g.info.rain || 0, snow: g.info.snow || 0 });
  updateHUD(cond, tMs);
  checkAchievements();
};

// ---------- location loading ----------
async function loadLocation(place, expeditionDate = null) {
  if (state.loading) return;
  state.loading = true;
  showLoader(`flying to ${place.name}…`);
  try {
    setLoader(expeditionDate
      ? `opening the archive for ${expeditionDate}…`
      : `reading the sky over ${place.name}…`);

    const [tl, elevGrid] = await Promise.all([
      expeditionDate
        ? fetchTimelineArchive(place.lat, place.lon, expeditionDate)
        : fetchTimelineLive(place.lat, place.lon),
      state.place && state.elevGrid &&
        Math.abs(state.place.lat - place.lat) < 1e-6 && Math.abs(state.place.lon - place.lon) < 1e-6
        ? Promise.resolve(state.elevGrid)
        : fetchElevationGrid(place.lat, place.lon),
    ]);

    setLoader('raising the terrain…');

    // climate signals for the biome choice
    let tSum = 0, hSum = 0;
    for (const h of tl.hours) { tSum += h.temp; hSum += h.humidity; }
    const avgTemp = tSum / tl.hours.length;
    const avgHumidity = hSum / tl.hours.length;
    let meanElev = 0;
    for (const v of elevGrid.grid) meanElev += v;
    meanElev /= elevGrid.grid.length;

    const biomeName = pickBiome(place.lat, meanElev, avgTemp, avgHumidity);
    const hasSeaHint = tl.hours.some(h => h.waveH !== null && h.waveH > 0.01);

    const sameDiorama = state.place && state.elevGrid === elevGrid && world.diorama &&
      world.diorama.biomeName === biomeName;
    if (!sameDiorama) {
      world.setDiorama({ elev: elevGrid, biomeName, hasSeaHint, lat: place.lat, lon: place.lon });
    }

    state.place = place;
    state.tl = tl;
    state.elevGrid = elevGrid;

    if (expeditionDate) {
      state.timeIdx = Math.min(36, tl.hours.length - 1); // noon of the target day
      state.liveMode = false;
    } else {
      const ni = nowIdx();
      state.timeIdx = ni === null ? 0 : ni;
      state.liveMode = true;
    }
    setPlaying(false);
    buildScrub();

    el.hudName.textContent = place.name;
    el.hudCountry.textContent = place.country || `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}`;
    el.hud.classList.remove('hidden');
    el.timebar.classList.remove('hidden');
    updateHUD(condAt(state.timeIdx), timeMs(), true);

    logbook.recordVisit(place);
    checkAchievements(true);

    const url = new URL(location.href);
    url.searchParams.set('lat', place.lat.toFixed(4));
    url.searchParams.set('lon', place.lon.toFixed(4));
    url.searchParams.set('name', place.name);
    if (place.country) url.searchParams.set('country', place.country);
    history.replaceState(null, '', url);
  } catch (err) {
    console.error('load failed', err);
    toast(`<span class="t-ico">⚠️</span><span><b>Couldn't reach the weather</b><span class="t-sub">${err.message || 'network error'} — try again</span></span>`, '', 6000);
  } finally {
    state.loading = false;
    hideLoader();
  }
}

// ---------- playback controls ----------
function setPlaying(playing) {
  state.playing = playing;
  el.btnPlay.textContent = playing ? '⏸' : '▶';
  if (playing) state.liveMode = false;
}

el.btnPlay.addEventListener('click', () => {
  audio.unlock();
  if (!state.playing && state.timeIdx >= state.tl.hours.length - 1.1) state.timeIdx = 0;
  setPlaying(!state.playing);
});

el.scrub.addEventListener('input', () => {
  state.timeIdx = parseFloat(el.scrub.value);
  setPlaying(false);
  const ni = nowIdx();
  state.liveMode = ni !== null && Math.abs(state.timeIdx - ni) < 0.4;
  updateHUD(condAt(state.timeIdx), timeMs(), true);
});

el.btnNow.addEventListener('click', async () => {
  audio.unlock();
  if (state.tl.mode === 'expedition') {
    await loadLocation(state.place); // back to the live window
  } else {
    state.liveMode = true;
    setPlaying(false);
  }
});

el.btnExpedition.addEventListener('click', () => {
  el.expeditionForm.classList.toggle('hidden');
  if (!el.expeditionDate.value) {
    const yr = 1940 + Math.floor(Math.random() * 70);
    el.expeditionDate.value = `${yr}-06-21`;
  }
  const maxDate = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
  el.expeditionDate.max = maxDate;
});

el.btnExpeditionGo.addEventListener('click', () => {
  const v = el.expeditionDate.value;
  if (!v || !state.place) return;
  el.expeditionForm.classList.add('hidden');
  loadLocation(state.place, v);
});

// ---------- search ----------
let searchTimer = null;
let searchHits = [];

function closeSearch() {
  el.searchResults.classList.add('hidden');
  el.searchResults.innerHTML = '';
  searchHits = [];
}

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.search.value;
  if (q.trim().length < 2) { closeSearch(); return; }
  searchTimer = setTimeout(async () => {
    try {
      searchHits = await geocode(q);
    } catch { searchHits = []; }
    if (!searchHits.length) { closeSearch(); return; }
    el.searchResults.innerHTML = '';
    searchHits.forEach((r, i) => {
      const btn = document.createElement('button');
      btn.className = 'search-result' + (i === 0 ? ' active' : '');
      btn.innerHTML = `<span>${r.name}</span><span class="sr-meta">${[r.admin, r.country].filter(Boolean).join(', ')}</span>`;
      btn.addEventListener('click', () => pickResult(r));
      el.searchResults.appendChild(btn);
    });
    el.searchResults.classList.remove('hidden');
  }, 300);
});

function pickResult(r) {
  closeSearch();
  el.search.value = '';
  el.search.blur();
  audio.unlock();
  loadLocation({ name: r.name, country: [r.admin, r.country].filter(Boolean).join(', '), lat: r.lat, lon: r.lon });
}

el.search.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && searchHits.length) pickResult(searchHits[0]);
  if (ev.key === 'Escape') { closeSearch(); el.search.blur(); }
});
document.addEventListener('pointerdown', (ev) => {
  if (!el.searchResults.contains(ev.target) && ev.target !== el.search) closeSearch();
});

// ---------- panels ----------
function closePanel() {
  el.panel.classList.add('hidden');
  state.openPanel = null;
}
el.panelClose.addEventListener('click', closePanel);

function openPanel(kind, title, builder) {
  if (state.openPanel === kind) { closePanel(); return; }
  state.openPanel = kind;
  el.panelTitle.textContent = title;
  el.panelBody.innerHTML = '<p>loading…</p>';
  el.panel.classList.remove('hidden');
  builder(el.panelBody);
}

el.btnLogbook.addEventListener('click', () => {
  openPanel('logbook', '📖 Logbook', body => logbook.render(body));
});

el.btnDuel.addEventListener('click', () => {
  openPanel('duel', '🎯 Forecast Duel', body => {
    const refTemp = state.tl ? condAt(state.timeIdx).temp : 15;
    duel.render(body, state.place, state.tl ? state.tl.utcOffsetSeconds : 0, refTemp, () => {
      toast(`<span class="t-ico">🎯</span><span><b>Prediction locked</b><span class="t-sub">Reality settles the duel after tomorrow ends.</span></span>`);
      duel.render(el.panelBody, state.place, state.tl.utcOffsetSeconds, refTemp);
    });
  });
});

el.btnWorldnow.addEventListener('click', () => {
  openPanel('worldnow', '🌐 World Right Now', async body => {
    try {
      await worldNow.refresh();
      worldNow.render(body, place => { closePanel(); loadLocation(place); });
    } catch (err) {
      body.innerHTML = `<p>Couldn't reach the live feed (${err.message}). Try again shortly.</p>`;
    }
  });
});

el.btnAbout.addEventListener('click', () => {
  openPanel('about', '✦ About Meteora', body => {
    body.innerHTML = `
      <h3>A real-weather world</h3>
      <p>Everything you see is driven by real data — nothing is faked. The sun sits where it
      truly sits for this place and moment. Wind speed bends the trees and slants the rain.
      Cloud cover, snowfall, fog and wave height are the real observations and forecasts.</p>
      <h3>Time machine</h3>
      <p>Scrub across 10 days around now, or take an expedition to any date since <b>1940</b>
      via the 🕰 button. Weather achievements earned while time-traveling are badged honestly.</p>
      <h3>Forecast duel</h3>
      <p>Call tomorrow's high anywhere on Earth. The model locks its forecast at the same
      moment; the recorded actual settles it the next day.</p>
      <h3>Data & credits</h3>
      <p>Weather, marine, geocoding and elevation data by
      <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>
      (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) —
      free, no API key, and it holds up under real traffic.
      Rendering: <a href="https://threejs.org/" target="_blank" rel="noopener">three.js</a>.
      Sound is procedural WebAudio. No backend, no tracking; your logbook and duels live in your browser.</p>
      <h3>Tips</h3>
      <p>Drag to orbit · scroll to zoom · press ▶ to let time flow · try a thunderstorm from
      the 🌐 panel · sunrise at 68°N in June is worth the trip.</p>`;
  });
});

// ---------- sound ----------
function syncSoundIcon() {
  el.btnSound.textContent = audio.enabled ? '🔊' : '🔇';
  el.btnSound.title = audio.enabled ? 'Sound on' : 'Sound off';
}
el.btnSound.addEventListener('click', () => { audio.toggle(); syncSoundIcon(); });
document.addEventListener('pointerdown', () => audio.unlock(), { once: true });
syncSoundIcon();

// ---------- boot ----------
(async function boot() {
  showLoader('waking up the atmosphere…');

  const params = new URLSearchParams(location.search);
  let start;
  if (params.get('lat') && params.get('lon')) {
    start = {
      name: params.get('name') || 'Somewhere',
      country: params.get('country') || '',
      lat: parseFloat(params.get('lat')),
      lon: parseFloat(params.get('lon')),
    };
  } else {
    start = STARTERS[Math.floor(Math.random() * STARTERS.length)];
  }

  await loadLocation(start);

  // settle any duels that came due while away
  duel.resolveDue().catch(() => {});
  // warm the world-now cache so the panel opens instantly + surface a storm hint
  worldNow.refresh().then(() => {
    const storms = worldNow.stormsNow();
    if (storms.length) {
      flashButton(el.btnWorldnow);
      const s = storms[0];
      toast(`<span class="t-ico">⛈️</span><span><b>Storm in progress</b><span class="t-sub">It's thundering in ${s.name} right now — fly there from 🌐</span></span>`, '', 7000);
    }
  }).catch(() => {});
})();
