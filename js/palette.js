// palette.js — turns raw weather numbers into the look of the world.
// One place owns all color decisions so day/night/storm/snow grade coherently.

import * as THREE from 'three';

// ---------- WMO weather codes → meaning + effect drivers ----------

const WMO = {
  0:  { label: 'Clear sky',            kind: 'clear' },
  1:  { label: 'Mainly clear',         kind: 'clear' },
  2:  { label: 'Partly cloudy',        kind: 'cloudy' },
  3:  { label: 'Overcast',             kind: 'cloudy' },
  45: { label: 'Fog',                  kind: 'fog', fog: 1 },
  48: { label: 'Rime fog',             kind: 'fog', fog: 1 },
  51: { label: 'Light drizzle',        kind: 'rain', rain: 0.25 },
  53: { label: 'Drizzle',              kind: 'rain', rain: 0.4 },
  55: { label: 'Heavy drizzle',        kind: 'rain', rain: 0.6 },
  56: { label: 'Freezing drizzle',     kind: 'rain', rain: 0.35 },
  57: { label: 'Heavy freezing drizzle', kind: 'rain', rain: 0.6 },
  61: { label: 'Light rain',           kind: 'rain', rain: 0.4 },
  63: { label: 'Rain',                 kind: 'rain', rain: 0.7 },
  65: { label: 'Heavy rain',           kind: 'rain', rain: 1.0 },
  66: { label: 'Freezing rain',        kind: 'rain', rain: 0.6 },
  67: { label: 'Heavy freezing rain',  kind: 'rain', rain: 0.9 },
  71: { label: 'Light snow',           kind: 'snow', snow: 0.4 },
  73: { label: 'Snow',                 kind: 'snow', snow: 0.7 },
  75: { label: 'Heavy snow',           kind: 'snow', snow: 1.0 },
  77: { label: 'Snow grains',          kind: 'snow', snow: 0.5 },
  80: { label: 'Light showers',        kind: 'rain', rain: 0.5 },
  81: { label: 'Showers',              kind: 'rain', rain: 0.75 },
  82: { label: 'Violent showers',      kind: 'rain', rain: 1.0 },
  85: { label: 'Snow showers',         kind: 'snow', snow: 0.6 },
  86: { label: 'Heavy snow showers',   kind: 'snow', snow: 1.0 },
  95: { label: 'Thunderstorm',         kind: 'thunder', rain: 0.85, thunder: 1 },
  96: { label: 'Thunderstorm with hail', kind: 'thunder', rain: 0.95, thunder: 1 },
  99: { label: 'Severe thunderstorm',  kind: 'thunder', rain: 1.0, thunder: 1 },
};

export function describeCode(code) {
  return WMO[code] || { label: 'Unknown', kind: 'clear' };
}

// ---------- sky + light grading ----------

const C = (hex) => new THREE.Color(hex);

// key sky stops by sun altitude (radians)
const SKY_STOPS = [
  { alt: -0.35, top: C(0x050810), horizon: C(0x0a1020), sun: C(0x223048), light: 0.06 }, // deep night
  { alt: -0.12, top: C(0x0a1226), horizon: C(0x27263f), sun: C(0x584a63), light: 0.10 }, // astro dawn
  { alt: -0.02, top: C(0x1b2a4d), horizon: C(0xb0576b), sun: C(0xff9a5e), light: 0.28 }, // horizon glow
  { alt: 0.06,  top: C(0x3f6ca8), horizon: C(0xffb37a), sun: C(0xffcf8a), light: 0.62 }, // golden hour
  { alt: 0.25,  top: C(0x4a8fd4), horizon: C(0xbcd8ea), sun: C(0xfff0d0), light: 0.95 }, // morning
  { alt: 0.7,   top: C(0x3f86dd), horizon: C(0xa8d4f0), sun: C(0xfffbee), light: 1.1 },  // high sun
  { alt: 1.4,   top: C(0x3179d6), horizon: C(0x9ccdf0), sun: C(0xffffff), light: 1.15 }, // zenith
];

function lerpStops(alt) {
  const s = SKY_STOPS;
  if (alt <= s[0].alt) return { ...s[0], top: s[0].top.clone(), horizon: s[0].horizon.clone(), sun: s[0].sun.clone() };
  if (alt >= s[s.length - 1].alt) {
    const l = s[s.length - 1];
    return { ...l, top: l.top.clone(), horizon: l.horizon.clone(), sun: l.sun.clone() };
  }
  for (let i = 0; i < s.length - 1; i++) {
    if (alt >= s[i].alt && alt <= s[i + 1].alt) {
      const f = (alt - s[i].alt) / (s[i + 1].alt - s[i].alt);
      return {
        top: s[i].top.clone().lerp(s[i + 1].top, f),
        horizon: s[i].horizon.clone().lerp(s[i + 1].horizon, f),
        sun: s[i].sun.clone().lerp(s[i + 1].sun, f),
        light: s[i].light + (s[i + 1].light - s[i].light) * f,
      };
    }
  }
  return lerpStops(s[0].alt);
}

const GREY_TOP = C(0x4b5a6b);
const GREY_HOR = C(0x8b98a6);
const STORM_TOP = C(0x232c3a);
const STORM_HOR = C(0x49525f);

// Master grade: everything the renderer needs to color a frame.
export function grade(sunAlt, cond) {
  const info = describeCode(cond.code);
  const stop = lerpStops(sunAlt);
  const dayness = THREE.MathUtils.smoothstep(sunAlt, -0.1, 0.15);

  // cloud cover pulls the sky toward grey; storms pull it toward slate
  const cloudF = THREE.MathUtils.clamp(cond.cloud / 100, 0, 1) * 0.85;
  const stormF = info.thunder ? 0.75 : (info.rain ? info.rain * 0.45 : 0);

  const top = stop.top.clone()
    .lerp(GREY_TOP.clone().multiplyScalar(0.25 + dayness * 0.75), cloudF * dayness)
    .lerp(STORM_TOP.clone().multiplyScalar(0.3 + dayness * 0.7), stormF);
  const horizon = stop.horizon.clone()
    .lerp(GREY_HOR.clone().multiplyScalar(0.2 + dayness * 0.8), cloudF * dayness)
    .lerp(STORM_HOR.clone().multiplyScalar(0.25 + dayness * 0.75), stormF);

  // temperature nudges the light: cold = steel blue, heat = amber
  const tempF = THREE.MathUtils.clamp((cond.temp - 10) / 30, -1, 1);
  const tempTint = tempF > 0
    ? C(0xffe2b8).lerp(C(0xffffff), 1 - tempF * 0.5)
    : C(0xbfd4ff).lerp(C(0xffffff), 1 + tempF * 0.5);

  const sunColor = stop.sun.clone().multiply(tempTint);
  const lightIntensity = stop.light * (1 - cloudF * 0.55) * (1 - stormF * 0.45);

  // moonlit floor: keep the world faintly readable at night
  const ambient = horizon.clone().lerp(top, 0.5)
    .add(C(0x1c2438).multiplyScalar((1 - dayness) * 0.9));
  const ambientIntensity = 0.35 + dayness * 0.75 - stormF * 0.15;

  // fog density: real fog codes dominate; humidity + rain add haze
  const fogKind = info.fog ? 1 : 0;
  const haze = THREE.MathUtils.clamp(
    fogKind * 0.9 +
    (cond.humidity > 82 ? (cond.humidity - 82) / 60 : 0) +
    (info.rain || 0) * 0.18 + (info.snow || 0) * 0.28,
    0, 1
  );
  const fogColor = horizon.clone().lerp(top, 0.25);

  return {
    skyTop: top,
    skyHorizon: horizon,
    sunColor,
    lightIntensity,
    ambientColor: ambient,
    ambientIntensity,
    fogColor,
    fogDensity: 0.0016 + haze * 0.028,
    starAlpha: THREE.MathUtils.clamp(-sunAlt * 6, 0, 1) * (1 - cloudF) * (1 - stormF),
    dayness,
    cloudDarkness: Math.max(cloudF * 0.5, stormF),
    info,
  };
}

// ---------- biome palettes for terrain vertex painting ----------

export const BIOMES = {
  tropical: {
    low: C(0x3e9e4f), mid: C(0x2f7d46), high: C(0x6b7f58), rock: C(0x7a705f),
    sand: C(0xe8d9a8), treeDensity: 0.85, treeKind: 'canopy',
    trunk: C(0x6e5136), leaf: C(0x2f8f4a), leaf2: C(0x57b25e),
  },
  desert: {
    low: C(0xd9b678), mid: C(0xc9a066), high: C(0xa8825a), rock: C(0x8f6f52),
    sand: C(0xe8cf96), treeDensity: 0.06, treeKind: 'shrub',
    trunk: C(0x7d6547), leaf: C(0x8fa05e), leaf2: C(0xa8b06a),
  },
  temperate: {
    low: C(0x71a83f), mid: C(0x4f8a3c), high: C(0x8a8a6a), rock: C(0x8a8578),
    sand: C(0xdccf9f), treeDensity: 0.55, treeKind: 'mixed',
    trunk: C(0x6b4f34), leaf: C(0x3f7d3a), leaf2: C(0x6aa04a),
  },
  boreal: {
    low: C(0x5b8a4f), mid: C(0x3f6b44), high: C(0x77826b), rock: C(0x7d7a70),
    sand: C(0xc9bd97), treeDensity: 0.7, treeKind: 'conifer',
    trunk: C(0x5d4630), leaf: C(0x2c5d3f), leaf2: C(0x3d7050),
  },
  tundra: {
    low: C(0x9aa08262), mid: C(0x8a9078), high: C(0x9aa0a0), rock: C(0x878d92),
    sand: C(0xb8b09a), treeDensity: 0.08, treeKind: 'shrub',
    trunk: C(0x6b5a44), leaf: C(0x6f7d5a), leaf2: C(0x7d8a66),
  },
  polar: {
    low: C(0xcfd8de), mid: C(0xc2ccd4), high: C(0xd8e2e8), rock: C(0x8f99a3),
    sand: C(0xc2c8cf), treeDensity: 0, treeKind: 'none',
    trunk: C(0x666666), leaf: C(0x888888), leaf2: C(0x999999),
  },
};

// fix accidental 8-digit hex above (tundra low) — clamp to a sane tone
BIOMES.tundra.low = C(0x9aa082);

// Pick a biome from real signals: latitude band, terrain height, temperature climate.
export function pickBiome(lat, meanElev, avgTemp, avgHumidity) {
  const a = Math.abs(lat);
  if (a > 66 || (avgTemp !== null && avgTemp < -8)) return 'polar';
  if (a > 58 || (avgTemp !== null && avgTemp < 0)) return 'tundra';
  if (a > 48) return 'boreal';
  if (a < 20 && avgHumidity !== null && avgHumidity < 45 && avgTemp !== null && avgTemp > 22) return 'desert';
  if (a >= 15 && a <= 35 && avgHumidity !== null && avgHumidity < 40) return 'desert';
  if (a < 21) return 'tropical';
  return 'temperate';
}
