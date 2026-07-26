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

// "Europe/Lisbon" → "Lisbon area · Europe"; falls back to plain coordinates.
export function labelFromTimezone(timezone, lat, lon) {
  const coords = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  if (!timezone || !timezone.includes('/')) return { name: 'Your location', country: coords };
  const [region, city] = timezone.split('/');
  const pretty = city.replace(/_/g, ' ');
  return { name: `Near ${pretty}`, country: `${region.replace(/_/g, ' ')} · ${coords}` };
}
