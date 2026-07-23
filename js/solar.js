// solar.js — where the sun and moon actually are, for any time and place on Earth.
// Standard low-precision astronomical formulas (good to ~0.3°, far beyond what the eye
// can judge in a stylized sky). Times are unix milliseconds UTC.

const RAD = Math.PI / 180;

// days since J2000.0
function j2000(unixMs) {
  return unixMs / 86400000 - 10957.5;
}

// Sun altitude/azimuth in radians. Azimuth: 0 = north, π/2 = east.
export function sunPosition(unixMs, lat, lon) {
  const d = j2000(unixMs);

  const L = (280.460 + 0.9856474 * d) % 360;           // mean longitude
  const g = ((357.528 + 0.9856003 * d) % 360) * RAD;   // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * d) * RAD;          // obliquity

  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  // local sidereal time
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = ((gmst + lon / 15) % 24 + 24) % 24;
  let H = lst * 15 * RAD - ra; // hour angle

  const latR = lat * RAD;
  const alt = Math.asin(
    Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(H)
  );
  const az = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(latR) - Math.tan(dec) * Math.cos(latR)
  ) + Math.PI; // measured from north, clockwise through east

  return { altitude: alt, azimuth: az };
}

// Moon phase 0..1 (0 = new, 0.5 = full). Synodic approximation.
export function moonPhase(unixMs) {
  const synodic = 29.53058867;
  // reference new moon: 2000-01-06 18:14 UTC
  const days = (unixMs - 947182440000) / 86400000;
  return ((days / synodic) % 1 + 1) % 1;
}

// A stylized moon position: correct-feeling counterweight to the sun.
// (Real lunar ephemeris is overkill for a diorama; this keeps the moon up at night.)
export function moonPosition(unixMs, lat, lon) {
  const sun = sunPosition(unixMs, lat, lon);
  const phase = moonPhase(unixMs);
  // offset the moon from the sun by its phase angle around the sky
  const az = (sun.azimuth + Math.PI * 2 * phase + Math.PI) % (Math.PI * 2);
  const alt = -sun.altitude * 0.9 + 0.08;
  return { altitude: alt, azimuth: az, phase };
}
