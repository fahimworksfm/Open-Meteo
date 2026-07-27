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
import { currentPosition, locateAvailable, reverseGeocode, fallbackLabel } from './geo.js';
import { Groq, MODELS } from './ai.js';
import { fetchTerrainTiles, IMAGERY_CREDIT } from './scene/tiles.js';
import { units, temp, tempWithScale, wind, precip, height,
         tempToDisplay, tempFromDisplay, tempStep, tempScaleLabel } from './units.js';

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
  btnLocate: $('btn-locate'), btnAi: $('btn-ai'),
  dispatch: $('dispatch'), dispatchBody: $('dispatch-body'),
  btnUnits: $('btn-units'), btnTerrain: $('btn-terrain'), attribution: $('attribution'),
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
  terrainMode: localStorage.getItem('meteora.terrain') === 'stylized' ? 'stylized' : 'satellite',
  tileFailed: false,  // set when the tile services can't be reached
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
  const errFmt = e => (units.imperial ? e * 9 / 5 : e).toFixed(1);
  const msg = p.outcome === 'win'
    ? `You beat the model at ${p.name} — you ${temp(p.guess, { decimals: 1 })}, model ${temp(p.model, { decimals: 1 })}, actual ${temp(p.actual, { decimals: 1 })}`
    : p.outcome === 'loss'
      ? `The model won at ${p.name} — actual ${temp(p.actual, { decimals: 1 })}, you were off by ${errFmt(p.errUser)}°`
      : `Dead heat at ${p.name} — actual ${temp(p.actual, { decimals: 1 })}`;
  toast(`<span class="t-ico">🎯</span><span><b>Duel settled</b><span class="t-sub">${msg}</span></span>`, '', 8000);
  flashButton(el.btnDuel);
  checkAchievements(true);
});

const worldNow = new WorldNow();
const groq = new Groq();
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

  el.hudTemp.textContent = temp(cond.temp);
  el.hudCondText.textContent = describeCode(cond.code).label;

  const isExpedition = state.tl.mode === 'expedition';
  const ni = nowIdx();
  const isNow = !isExpedition && ni !== null && Math.abs(state.timeIdx - ni) < 0.4;
  el.hudCondTime.textContent = (isNow ? '● LIVE · ' : '') + fmtLocal(tMs, isExpedition);
  el.hud.classList.toggle('time-traveling', isExpedition || !isNow);
  el.btnNow.classList.toggle('live-on', isNow);

  el.hudWind.textContent = `${wind(cond.windSpeed)} ${windArrow(cond.windDir)}`;
  el.hudCloud.textContent = `${Math.round(cond.cloud)}%`;
  el.hudHumidity.textContent = `${Math.round(cond.humidity)}%`;
  if (cond.waveH !== null && cond.waveH !== undefined) {
    el.hudWaveStat.classList.remove('hidden');
    el.hudWave.textContent = height(cond.waveH);
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

    const [tl, elevGrid, revLabel] = await Promise.all([
      expeditionDate
        ? fetchTimelineArchive(place.lat, place.lon, expeditionDate)
        : fetchTimelineLive(place.lat, place.lon),
      state.place && state.elevGrid &&
        Math.abs(state.place.lat - place.lat) < 1e-6 && Math.abs(state.place.lon - place.lon) < 1e-6
        ? Promise.resolve(state.elevGrid)
        : fetchElevationGrid(place.lat, place.lon),
      // only a GPS fix needs naming; searched places already know what they are
      place.autoName ? reverseGeocode(place.lat, place.lon).catch(() => null) : Promise.resolve(null),
    ]);

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

    // Satellite mode pulls real terrain + imagery tiles; if they can't be reached we
    // quietly fall back to the stylized diorama rather than showing nothing.
    const terrainKey = `${place.lat.toFixed(4)},${place.lon.toFixed(4)},${state.terrainMode}`;
    let built = world.diorama && state.terrainKey === terrainKey;
    if (built && state.terrainMode === 'satellite' && !state.tileFailed) showAttribution(IMAGERY_CREDIT);

    if (!built && state.terrainMode === 'satellite') {
      setLoader('pulling satellite imagery…');
      try {
        const tileData = await fetchTerrainTiles(place.lat, place.lon);
        world.setRealTerrain(tileData, { lat: place.lat, lon: place.lon });
        built = true;
        state.tileFailed = false;
        showAttribution(IMAGERY_CREDIT);
      } catch (err) {
        console.warn('satellite terrain unavailable:', err.message);
        state.tileFailed = true;
        hideAttribution();
      }
    } else if (state.terrainMode !== 'satellite') {
      hideAttribution();
    }

    if (!built) {
      setLoader('raising the terrain…');
      world.setDiorama({ elev: elevGrid, biomeName, hasSeaHint, lat: place.lat, lon: place.lon });
      if (state.terrainMode === 'satellite' && state.tileFailed) {
        toast(`<span class="t-ico">🛰</span><span><b>Satellite imagery unreachable</b><span class="t-sub">Showing the stylized world instead — tap 🛰 to retry.</span></span>`, '', 6000);
      }
    }
    state.terrainKey = state.tileFailed && state.terrainMode === 'satellite' ? null : terrainKey;

    // a GPS fix arrives nameless: use the real locality, never a guess from the timezone
    if (place.autoName) {
      const lbl = revLabel || fallbackLabel(tl.timezone, place.lat, place.lon);
      place = { ...place, name: lbl.name, country: lbl.country, autoName: false };
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
    requestDispatch();

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

// ---------- units ----------
function syncUnitsButton() {
  el.btnUnits.textContent = units.imperial ? '°F' : '°C';
  el.btnUnits.title = units.imperial
    ? 'Imperial (°F, mph, in) — tap for metric'
    : 'Metric (°C, km/h, mm) — tap for imperial';
}

el.btnUnits.addEventListener('click', () => {
  units.toggle();
  syncUnitsButton();
  if (state.tl) updateHUD(condAt(state.timeIdx), timeMs(), true);
  refreshOpenPanel(); // open panels are showing numbers too
  toast(`<span class="t-ico">${units.imperial ? '🇺🇸' : '🌍'}</span><span><b>${units.imperial ? 'Imperial' : 'Metric'}</b><span class="t-sub">${units.imperial ? '°F · mph · inches · feet' : '°C · km/h · mm · metres'}</span></span>`, '', 3000);
});
syncUnitsButton();

// ---------- terrain mode ----------
function syncTerrainButton() {
  const sat = state.terrainMode === 'satellite';
  el.btnTerrain.textContent = sat ? '🛰' : '▲';
  el.btnTerrain.title = sat
    ? 'Satellite terrain — tap for the stylized world'
    : 'Stylized world — tap for real satellite terrain';
}

function showAttribution(text) {
  el.attribution.textContent = text;
  el.attribution.classList.remove('hidden');
}
function hideAttribution() {
  el.attribution.classList.add('hidden');
}

el.btnTerrain.addEventListener('click', async () => {
  state.terrainMode = state.terrainMode === 'satellite' ? 'stylized' : 'satellite';
  localStorage.setItem('meteora.terrain', state.terrainMode);
  state.tileFailed = false;
  state.terrainKey = null; // force a rebuild in the new mode
  syncTerrainButton();
  if (state.place) {
    const expedition = state.tl && state.tl.mode === 'expedition' ? state.tl.expeditionDate : null;
    await loadLocation(state.place, expedition);
  }
});
syncTerrainButton();

// ---------- AI field dispatch ----------
let dispatchToken = 0;

async function requestDispatch() {
  const token = ++dispatchToken;
  if (!groq.enabled || !groq.dispatchOn) {
    el.dispatch.classList.add('hidden');
    return;
  }
  el.dispatch.classList.remove('hidden');
  el.dispatchBody.className = 'dispatch-body thinking';
  el.dispatchBody.textContent = 'reading the air';

  try {
    const cond = condAt(state.timeIdx);
    const tMs = timeMs();
    const sun = sunPosition(tMs, state.place.lat, state.place.lon);
    const text = await groq.dispatch({
      place: state.place,
      cond,
      condLabel: describeCode(cond.code).label,
      localTime: fmtLocal(tMs, state.tl.mode === 'expedition'),
      sunAltDeg: sun.altitude * 180 / Math.PI,
      mode: state.tl.mode,
      biome: world.diorama ? world.diorama.biomeName : 'unknown',
      hasSea: world.diorama ? !!world.diorama.hasSea : false,
    });
    if (token !== dispatchToken) return; // a newer location won the race
    el.dispatchBody.className = 'dispatch-body';
    el.dispatchBody.textContent = text;
  } catch (err) {
    if (token !== dispatchToken) return;
    el.dispatch.classList.add('hidden');
    groq.lastError = err.message;
    console.warn('dispatch failed:', err.message);
  }
}

// ---------- locate me ----------
el.btnLocate.addEventListener('click', async () => {
  audio.unlock();
  if (!locateAvailable()) {
    toast(`<span class="t-ico">📍</span><span><b>No geolocation here</b><span class="t-sub">This device or browser can't provide a position.</span></span>`, '', 6000);
    return;
  }
  el.btnLocate.classList.add('attention');
  showLoader('asking your device where you are…');
  try {
    const pos = await currentPosition();
    await loadLocation({
      name: 'Your location',
      country: '',
      lat: pos.lat,
      lon: pos.lon,
      autoName: true,
    });
  } catch (err) {
    hideLoader();
    toast(`<span class="t-ico">📍</span><span><b>Couldn't locate you</b><span class="t-sub">${err.message}</span></span>`, '', 7000);
  } finally {
    el.btnLocate.classList.remove('attention');
  }
});

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

// A request like "somewhere it's snowing right now" is not a place name — offer it to
// the model instead of the gazetteer. Only shown when a Groq key is present.
function looksLikeRequest(q) {
  const s = q.trim().toLowerCase();
  if (s.split(/\s+/).length >= 4) return true;
  return /\b(where|somewhere|anywhere|find|take me|show me|coldest|hottest|storm|snowing|raining|windiest)\b/.test(s);
}

el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.search.value;
  if (q.trim().length < 2) { closeSearch(); return; }
  searchTimer = setTimeout(async () => {
    try {
      searchHits = await geocode(q);
    } catch { searchHits = []; }

    const offerAi = groq.enabled && looksLikeRequest(q);
    if (!searchHits.length && !offerAi) { closeSearch(); return; }

    el.searchResults.innerHTML = '';
    if (offerAi) {
      const btn = document.createElement('button');
      btn.className = 'search-result ai-row-item active';
      btn.innerHTML = `<span class="sr-ai">✨ Ask AI to find it</span><span class="sr-meta">${q.length > 42 ? q.slice(0, 42) + '…' : q}</span>`;
      btn.addEventListener('click', () => askAiToTravel(q));
      el.searchResults.appendChild(btn);
    }
    searchHits.forEach((r, i) => {
      const btn = document.createElement('button');
      btn.className = 'search-result' + (i === 0 && !offerAi ? ' active' : '');
      btn.innerHTML = `<span>${r.name}</span><span class="sr-meta">${[r.admin, r.country].filter(Boolean).join(', ')}</span>`;
      btn.addEventListener('click', () => pickResult(r));
      el.searchResults.appendChild(btn);
    });
    el.searchResults.classList.remove('hidden');
  }, 300);
});

async function askAiToTravel(query) {
  closeSearch();
  el.search.value = '';
  el.search.blur();
  audio.unlock();
  showLoader('asking the model where to go…');
  try {
    const live = await worldNow.refresh().catch(() => null);
    const dest = await groq.pickDestination(query, live);
    hideLoader();
    if (dest.why) {
      toast(`<span class="t-ico">✨</span><span><b>${dest.name}${dest.country ? `, ${dest.country}` : ''}</b><span class="t-sub">${dest.why}</span></span>`, '', 7000);
    }
    await loadLocation({ name: dest.name, country: dest.country, lat: dest.lat, lon: dest.lon });
  } catch (err) {
    hideLoader();
    toast(`<span class="t-ico">✨</span><span><b>AI travel failed</b><span class="t-sub">${err.message}</span></span>`, '', 7000);
  }
}

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

const panelBuilders = {};

function openPanel(kind, title, builder) {
  if (state.openPanel === kind) { closePanel(); return; }
  state.openPanel = kind;
  panelBuilders[kind] = builder;
  el.panelTitle.textContent = title;
  el.panelBody.innerHTML = '<p>loading…</p>';
  el.panel.classList.remove('hidden');
  builder(el.panelBody);
}

// re-render whatever panel is open (after a unit switch, a new duel, etc.)
function refreshOpenPanel() {
  const kind = state.openPanel;
  if (!kind || !panelBuilders[kind]) return;
  panelBuilders[kind](el.panelBody);
}

function flyToPlace(place) {
  closePanel();
  loadLocation(place);
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
      worldNow.render(body, flyToPlace);
    } catch (err) {
      body.innerHTML = `<p>Couldn't reach the live feed (${err.message}). Try again shortly.</p>`;
    }
  });
});

el.btnAi.addEventListener('click', () => {
  openPanel('ai', '✨ AI Features', body => {
    const models = MODELS.map(m =>
      `<option value="${m.id}"${m.id === groq.model ? ' selected' : ''}>${m.label}</option>`).join('');
    body.innerHTML = `
      <div class="ai-status ${groq.enabled ? 'on' : ''}" id="ai-status">
        ${groq.enabled ? '● Connected — AI features are live' : '○ Dormant — add a key to switch these on'}
      </div>
      <p>Two things the model does, both grounded in the same real Open-Meteo numbers the
      world is built from — it narrates and chooses, it never invents weather.</p>
      <p><b>Field dispatch</b> — a two-sentence description of what you're standing in,
      written on arrival at every place.<br>
      <b>Natural-language travel</b> — type something like <i>"somewhere it's snowing right
      now"</i> into the search box and pick the ✨ row.</p>

      <h3>Your Groq API key</h3>
      <div class="ai-field">
        <label for="ai-key">key (stored only in this browser)</label>
        <input type="password" id="ai-key" placeholder="gsk_…" value="${groq.key ? groq.key.replace(/./g, '•') : ''}" autocomplete="off" spellcheck="false">
      </div>
      <div class="ai-field">
        <label for="ai-model">model</label>
        <select id="ai-model">${models}</select>
      </div>
      <div class="ai-row">
        <button class="chip-btn" id="ai-save">Save</button>
        <button class="chip-btn" id="ai-clear">Clear key</button>
        <label class="ai-toggle"><input type="checkbox" id="ai-dispatch" ${groq.dispatchOn ? 'checked' : ''}> field dispatch on arrival</label>
      </div>
      <div id="ai-msg"></div>
      <p style="margin-top:14px">Get a free key at
      <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>.
      It is stored in this browser's localStorage and sent only to Groq — never to this site
      (there is no server) and never to Open-Meteo. Clear it any time above.</p>`;

    const keyInput = body.querySelector('#ai-key');
    const msg = body.querySelector('#ai-msg');
    keyInput.addEventListener('focus', () => { if (keyInput.value.startsWith('•')) keyInput.value = ''; });

    body.querySelector('#ai-save').addEventListener('click', () => {
      const v = keyInput.value.trim();
      if (v && !v.startsWith('•')) groq.setKey(v);
      groq.setModel(body.querySelector('#ai-model').value);
      groq.setDispatch(body.querySelector('#ai-dispatch').checked);
      msg.className = 'ai-ok';
      msg.textContent = groq.enabled ? 'Saved. AI features are live.' : 'Saved. Add a key to switch AI features on.';
      body.querySelector('#ai-status').className = `ai-status ${groq.enabled ? 'on' : ''}`;
      body.querySelector('#ai-status').textContent = groq.enabled
        ? '● Connected — AI features are live'
        : '○ Dormant — add a key to switch these on';
      syncAiIcon();
      requestDispatch();
    });

    body.querySelector('#ai-clear').addEventListener('click', () => {
      groq.setKey('');
      keyInput.value = '';
      msg.className = 'ai-ok';
      msg.textContent = 'Key removed from this browser.';
      body.querySelector('#ai-status').className = 'ai-status';
      body.querySelector('#ai-status').textContent = '○ Dormant — add a key to switch these on';
      syncAiIcon();
      el.dispatch.classList.add('hidden');
    });

    body.querySelector('#ai-dispatch').addEventListener('change', (ev) => {
      groq.setDispatch(ev.target.checked);
      if (ev.target.checked) requestDispatch();
      else el.dispatch.classList.add('hidden');
    });
  });
});

function syncAiIcon() {
  el.btnAi.title = groq.enabled ? 'AI features (Groq) — connected' : 'AI features (Groq) — add a key';
  el.btnAi.style.opacity = groq.enabled ? '1' : '0.62';
}
syncAiIcon();

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
      <h3>Two worlds</h3>
      <p>🛰 switches between <b>satellite terrain</b> — real elevation from terrain tiles
      wearing real aerial imagery, cut as a block of the actual ground — and the
      <b>stylized world</b>, a procedural low-poly diorama built from the same elevation
      data. Both are lit and weathered by identical live numbers.</p>
      <h3>Units, location & AI</h3>
      <p>°C/°F switches everything instantly. 📍 drops you where you actually are.
      ✨ optionally connects a Groq key for field dispatches and natural-language travel —
      everything else works without it.</p>
      <h3>Data & credits</h3>
      <p>Weather, marine, geocoding and elevation data by
      <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a>
      (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) —
      free, no API key, and it holds up under real traffic.
      Satellite imagery © Esri, Maxar, Earthstar Geographics; terrain tiles from the
      Mapzen/Tilezen open dataset.
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
