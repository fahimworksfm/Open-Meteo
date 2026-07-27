// geo.js — "put me where I actually am". Uses the device's own geolocation, then
// names the spot from the timezone Open-Meteo reports back (no third-party reverse
// geocoder, no extra keys). Works in the browser and inside the Android WebView,
// which serves the app over https so the secure-context requirement is satisfied.

export function locateAvailable() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

const ERRORS = {
  1: 'Location permission denied — allow it in your browser or Android app settings.',
  2: 'Your device could not get a fix. Try again outdoors or with Wi-Fi on.',
  3: 'Locating timed out. Try again.',
};

export function currentPosition({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!locateAvailable()) {
      reject(new Error('This device has no geolocation support.'));
      return;
    }
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
      reject(new Error('Location needs a secure page (https or localhost).'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      err => reject(new Error(ERRORS[err.code] || err.message || 'Could not get your location.')),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 },
    );
  });
}

export function formatCoords(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

// Names the actual settlement you are standing in. Open-Meteo's geocoding API is
// forward-only (name → coordinates), so this uses BigDataCloud's free keyless
// client endpoint. It is strictly cosmetic: the weather itself is always fetched
// from the raw GPS coordinates, so a failure here costs a label and nothing else.
const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

export async function reverseGeocode(lat, lon, { timeout = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(
      `${REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: ctrl.signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const name = d.city || d.locality || d.principalSubdivision;
    if (!name) throw new Error('no locality');
    const region = [d.principalSubdivision, d.countryName]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i && v !== name)
      .join(', ');
    return { name, country: region || formatCoords(lat, lon) };
  } finally {
    clearTimeout(timer);
  }
}

// Fallback when the reverse lookup is unavailable. Deliberately does NOT invent a
// city from the timezone — a timezone spans a continent, so "America/New_York"
// says nothing about whether you are in Manhattan or Charlotte.
export function fallbackLabel(timezone, lat, lon) {
  const coords = formatCoords(lat, lon);
  return {
    name: 'Your location',
    country: timezone ? `${coords} · ${timezone.replace(/_/g, ' ')}` : coords,
  };
}
