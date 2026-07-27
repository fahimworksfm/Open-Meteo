import { units, toF, toMph, toInches, toFeet } from './units.js';

// ai.js — optional Groq layer. Two jobs, both grounded in real Open-Meteo numbers:
//   1. a short "field dispatch" describing what you're standing in on arrival
//   2. natural-language travel ("somewhere it's snowing right now")
// The key is yours and lives only in this browser's localStorage — the app stays
// static and backend-free, and every AI feature stays dormant until a key is added.

const KEY_STORE = 'meteora.groq.key';
const MODEL_STORE = 'meteora.groq.model';
const DISPATCH_STORE = 'meteora.groq.dispatch';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export const MODELS = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B — best writing' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B — fastest' },
];
const DEFAULT_MODEL = MODELS[0].id;

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Groq {
  constructor() {
    this.key = localStorage.getItem(KEY_STORE) || '';
    this.model = localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL;
    this.dispatchOn = localStorage.getItem(DISPATCH_STORE) !== 'off';
    this.lastError = null;
  }

  get enabled() { return !!this.key; }

  setKey(key) {
    this.key = (key || '').trim();
    if (this.key) localStorage.setItem(KEY_STORE, this.key);
    else localStorage.removeItem(KEY_STORE);
    this.lastError = null;
  }

  setModel(model) {
    this.model = model;
    localStorage.setItem(MODEL_STORE, model);
  }

  setDispatch(on) {
    this.dispatchOn = !!on;
    localStorage.setItem(DISPATCH_STORE, on ? 'on' : 'off');
  }

  async chat(messages, { json = false, maxTokens = 320, temperature = 0.75 } = {}) {
    if (!this.enabled) throw new Error('No Groq API key set.');
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (err) {
      // Most likely CORS or offline — say something actionable rather than "failed to fetch".
      throw new Error('Could not reach Groq from the browser (network or CORS). Check your connection.');
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        detail = body.error?.message || detail;
      } catch { /* keep status */ }
      if (res.status === 401) detail = 'Groq rejected the key. Check it in the ✨ panel.';
      if (res.status === 429) detail = 'Groq rate limit hit — try again shortly.';
      throw new Error(detail);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  // ---- 1. field dispatch -------------------------------------------------

  // facts must come from the real timeline — the model narrates, it never invents data.
  async dispatch({ place, cond, condLabel, localTime, sunAltDeg, mode, biome, hasSea }) {
    const windDir = DIRS[Math.round(((cond.windDir % 360) / 45)) % 8];
    const light = sunAltDeg > 12 ? 'full daylight'
      : sunAltDeg > 0 ? 'low sun near the horizon'
      : sunAltDeg > -6 ? 'twilight'
      : 'night';

    // give the model the same units the reader is seeing, so any number it echoes matches
    const imp = units.imperial;
    const facts = [
      `place: ${place.name}${place.country ? `, ${place.country}` : ''}`,
      `local time: ${localTime}`,
      `conditions: ${condLabel}`,
      `temperature: ${imp ? `${toF(cond.temp).toFixed(0)} °F` : `${cond.temp.toFixed(1)} °C`}`,
      `wind: ${imp ? `${toMph(cond.windSpeed).toFixed(0)} mph` : `${cond.windSpeed.toFixed(0)} km/h`} from ${windDir}`,
      `cloud cover: ${Math.round(cond.cloud)}%`,
      `humidity: ${Math.round(cond.humidity)}%`,
      `precipitation: ${imp ? `${toInches(cond.precip).toFixed(2)} in/h` : `${cond.precip.toFixed(1)} mm/h`}`,
      cond.snowfall > 0 ? `snowfall: ${imp ? `${toInches(cond.snowfall * 10).toFixed(1)} in/h` : `${cond.snowfall.toFixed(1)} cm/h`}` : null,
      cond.waveH !== null && cond.waveH !== undefined
        ? `sea state: ${imp ? `${toFeet(cond.waveH).toFixed(0)} ft` : `${cond.waveH.toFixed(1)} m`} waves` : null,
      `light: ${light}`,
      `terrain: ${biome}${hasSea ? ', on the coast' : ''}`,
      mode === 'expedition' ? 'NOTE: this is a historical archive date, not the present — write in past tense.' : null,
    ].filter(Boolean).join('\n');

    const content = await this.chat([
      {
        role: 'system',
        content: 'You write two-sentence field dispatches for a weather explorer app. ' +
          'You are standing at the location. Be vivid, concrete and physical — what the air ' +
          'feels like, what the wind is doing to things, what the light looks like. ' +
          'Use ONLY the facts given; never invent numbers, landmarks or events. ' +
          'No greetings, no meta-commentary, no emoji, no quotation marks. Maximum 45 words.',
      },
      { role: 'user', content: facts },
    ], { maxTokens: 140, temperature: 0.85 });

    return content.replace(/^["']|["']$/g, '');
  }

  // ---- 2. natural-language travel ---------------------------------------

  // worldNow gives it real live conditions to reason over, so "somewhere it's
  // snowing right now" resolves to a place that is genuinely snowing.
  async pickDestination(query, worldNow) {
    const live = (worldNow || [])
      .filter(p => p.temp !== null)
      .map(p => `${p.name}, ${p.country} (${p.lat.toFixed(2)},${p.lon.toFixed(2)}): ${Math.round(p.temp)}°C, code ${p.code}, wind ${Math.round(p.wind)} km/h`)
      .join('\n');

    const raw = await this.chat([
      {
        role: 'system',
        content: 'You choose a real place on Earth for a weather-exploration app, then return JSON only.\n' +
          'Schema: {"name": string, "country": string, "lat": number, "lon": number, "why": string}\n' +
          'lat/lon must be the real coordinates of that place, accurate to about a tenth of a degree.\n' +
          '"why" is one short sentence (max 15 words) explaining the pick.\n' +
          'A live sample of current conditions worldwide is provided; WMO weather codes: ' +
          '0-3 clear→overcast, 45/48 fog, 51-67 drizzle/rain, 71-77 snow, 80-82 showers, 85/86 snow showers, 95-99 thunderstorm.\n' +
          'If the request asks for conditions happening right now, prefer a place from the live sample that genuinely matches. ' +
          'Otherwise pick any real place that best fits the request.',
      },
      { role: 'user', content: `Live conditions sample:\n${live}\n\nRequest: ${query}` },
    ], { json: true, maxTokens: 200, temperature: 0.6 });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('The model did not return a usable place.');
      parsed = JSON.parse(m[0]);
    }
    const lat = Number(parsed.lat);
    const lon = Number(parsed.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('The model returned coordinates that are not on Earth.');
    }
    return {
      name: String(parsed.name || 'Somewhere').slice(0, 60),
      country: String(parsed.country || '').slice(0, 60),
      lat,
      lon,
      why: String(parsed.why || '').slice(0, 140),
    };
  }
}
