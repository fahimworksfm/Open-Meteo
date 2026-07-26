// api.js — all Open-Meteo endpoints (no key, no backend, straight from the browser).
// Every visual in the scene traces back to a number returned by one of these calls.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

const HOURLY_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'snowfall',
  'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m',
].join(',');

const cache = new Map();

async function getJSON(url, { retries = 2 } = {}) {
  if (cache.has(url)) return cache.get(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try { reason = (await res.json()).reason || reason; } catch { /* not json */ }
        throw new Error(reason);
      }
      const data = await res.json();
      cache.set(url, data);
      if (cache.size > 80) cache.delete(cache.keys().next().value);
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function geocode(query) {
  if (!query || query.trim().length < 2) return [];
  const url = `${GEOCODE}?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`;
  const data = await getJSON(url);
  return (data.results || []).map(r => ({
    name: r.name,
    lat: r.latitude,
    lon: r.longitude,
    country: r.country || '',
    admin: r.admin1 || '',
    elevation: r.elevation,
  }));
}

// Shared shape for both live and expedition windows: hourly arrays + unix times (UTC seconds).
function packTimeline(hourly, marineHourly, utcOffsetSeconds, daily, timezone) {
  const n = hourly.time.length;
  const num = (arr, i, fallback = 0) => {
    const v = arr ? arr[i] : null;
    return (v === null || v === undefined || Number.isNaN(v)) ? fallback : v;
  };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const hours = new Array(n);
  for (let i = 0; i < n; i++) {
    hours[i] = {
      t: hourly.time[i], // unix seconds UTC
      temp: num(hourly.temperature_2m, i),
      humidity: clamp(num(hourly.relative_humidity_2m, i, 50), 0, 100),
      precip: Math.max(num(hourly.precipitation, i), 0),
      snowfall: Math.max(num(hourly.snowfall, i), 0),
      code: num(hourly.weather_code, i),
      cloud: clamp(num(hourly.cloud_cover, i), 0, 100),
      windSpeed: Math.max(num(hourly.wind_speed_10m, i), 0),
      windDir: num(hourly.wind_direction_10m, i),
      waveH: marineHourly ? num(marineHourly.wave_height, i, 0) : null,
      waveP: marineHourly ? num(marineHourly.wave_period, i, 6) : null,
    };
  }
  return { hours, utcOffsetSeconds, daily: daily || null, timezone: timezone || null };
}

function marineIsUseful(marine) {
  if (!marine || !marine.hourly || !marine.hourly.wave_height) return false;
  return marine.hourly.wave_height.some(v => v !== null && v !== undefined && v > 0.01);
}

// Live window: 2 days of the recent past + 8 days of forecast, hourly.
export async function fetchTimelineLive(lat, lon) {
  const base = `latitude=${lat}&longitude=${lon}&timezone=auto&timeformat=unixtime`;
  const forecastUrl = `${FORECAST}?${base}&hourly=${HOURLY_VARS}` +
    `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&past_days=2&forecast_days=8`;
  const marineUrl = `${MARINE}?${base}&hourly=wave_height,wave_period&past_days=2&forecast_days=8`;

  const [forecast, marine] = await Promise.all([
    getJSON(forecastUrl),
    getJSON(marineUrl, { retries: 0 }).catch(() => null),
  ]);

  const tl = packTimeline(
    forecast.hourly,
    marineIsUseful(marine) ? marine.hourly : null,
    forecast.utc_offset_seconds || 0,
    forecast.daily,
    forecast.timezone,
  );
  tl.mode = 'live';
  return tl;
}

// Expedition window: 3 days centred on any date since 1940, from the historical archive.
export async function fetchTimelineArchive(lat, lon, dateStr) {
  const centre = new Date(dateStr + 'T12:00:00Z');
  const day = 86400000;
  const fmt = d => d.toISOString().slice(0, 10);
  const start = fmt(new Date(centre.getTime() - day));
  const end = fmt(new Date(centre.getTime() + day));

  const base = `latitude=${lat}&longitude=${lon}&timezone=auto&timeformat=unixtime` +
    `&start_date=${start}&end_date=${end}`;
  const archiveUrl = `${ARCHIVE}?${base}&hourly=${HOURLY_VARS}` +
    `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset`;
  const marineUrl = `${MARINE}?${base}&hourly=wave_height,wave_period`;

  const [archive, marine] = await Promise.all([
    getJSON(archiveUrl),
    getJSON(marineUrl, { retries: 0 }).catch(() => null),
  ]);

  const tl = packTimeline(
    archive.hourly,
    marineIsUseful(marine) ? marine.hourly : null,
    archive.utc_offset_seconds || 0,
    archive.daily,
    archive.timezone,
  );
  tl.mode = 'expedition';
  tl.expeditionDate = dateStr;
  return tl;
}

// N×N grid of real ground elevations around a point (elevation API takes up to 100 coords).
export async function fetchElevationGrid(lat, lon, n = 9, spanDeg = 0.36) {
  const lats = [];
  const lons = [];
  const lonSpan = spanDeg / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      // row 0 = north edge so the grid reads like a map
      lats.push((lat + spanDeg / 2 - (row / (n - 1)) * spanDeg).toFixed(4));
      lons.push((lon - lonSpan / 2 + (col / (n - 1)) * lonSpan).toFixed(4));
    }
  }
  const url = `${ELEVATION}?latitude=${lats.join(',')}&longitude=${lons.join(',')}`;
  try {
    const data = await getJSON(url);
    const grid = Float32Array.from(data.elevation.map(v => (v === null ? 0 : v)));
    let min = Infinity, max = -Infinity;
    for (const v of grid) { if (v < min) min = v; if (v > max) max = v; }
    return { grid, n, min, max };
  } catch {
    // Elevation is decorative; a flat fallback keeps the world alive if the call fails.
    return { grid: new Float32Array(n * n), n, min: 0, max: 0 };
  }
}

// One batched call for the "world right now" panel: many places, current conditions.
export async function fetchWorldNow(places) {
  const lats = places.map(p => p.lat).join(',');
  const lons = places.map(p => p.lon).join(',');
  const url = `${FORECAST}?latitude=${lats}&longitude=${lons}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m&timezone=UTC`;
  const data = await getJSON(url);
  const arr = Array.isArray(data) ? data : [data];
  return places.map((p, i) => {
    const cur = arr[i] && arr[i].current ? arr[i].current : {};
    return {
      ...p,
      temp: cur.temperature_2m ?? null,
      code: cur.weather_code ?? 0,
      wind: cur.wind_speed_10m ?? 0,
      gusts: cur.wind_gusts_10m ?? 0,
    };
  });
}

// Actual max temperature for a recent past date — settles forecast duels.
export async function fetchActualMaxTemp(lat, lon, dateStr) {
  const url = `${FORECAST}?latitude=${lat}&longitude=${lon}&timezone=auto` +
    `&daily=temperature_2m_max&start_date=${dateStr}&end_date=${dateStr}`;
  try {
    const data = await getJSON(url);
    const v = data.daily && data.daily.temperature_2m_max ? data.daily.temperature_2m_max[0] : null;
    return (v === null || v === undefined) ? null : v;
  } catch {
    return null;
  }
}

// Model's predicted max temp for a future date at a place (the duel opponent).
export async function fetchModelMaxTemp(lat, lon, dateStr) {
  const url = `${FORECAST}?latitude=${lat}&longitude=${lon}&timezone=auto` +
    `&daily=temperature_2m_max&forecast_days=10`;
  const data = await getJSON(url);
  const idx = data.daily.time.indexOf(dateStr);
  if (idx === -1) return null;
  return data.daily.temperature_2m_max[idx];
}
