// units.js — metric ⇄ imperial. Open-Meteo is always fetched in metric and converted
// at display time, so flipping the switch is instant and never refetches anything.

const STORE = 'meteora.units';

export const units = {
  system: localStorage.getItem(STORE) === 'imperial' ? 'imperial' : 'metric',

  get imperial() { return this.system === 'imperial'; },

  toggle() {
    this.system = this.imperial ? 'metric' : 'imperial';
    localStorage.setItem(STORE, this.system);
    return this.system;
  },
};

// ---- conversions (input is always the metric value Open-Meteo returned) ----

export const toF = c => c * 9 / 5 + 32;
export const toMph = kmh => kmh * 0.621371;
export const toInches = mm => mm / 25.4;
export const toFeet = m => m * 3.28084;

// ---- formatters: number + unit, ready for the HUD ----

export function temp(c, { decimals = 0, unit = true } = {}) {
  const v = units.imperial ? toF(c) : c;
  return `${v.toFixed(decimals)}${unit ? '°' : ''}`;
}

export function tempWithScale(c, { decimals = 0 } = {}) {
  const v = units.imperial ? toF(c) : c;
  return `${v.toFixed(decimals)}°${units.imperial ? 'F' : 'C'}`;
}

export function wind(kmh, { decimals = 0 } = {}) {
  const v = units.imperial ? toMph(kmh) : kmh;
  return `${v.toFixed(decimals)} ${units.imperial ? 'mph' : 'km/h'}`;
}

export function precip(mm, { decimals = null } = {}) {
  if (units.imperial) {
    const v = toInches(mm);
    return `${v.toFixed(decimals ?? 2)} in`;
  }
  return `${mm.toFixed(decimals ?? 1)} mm`;
}

export function height(m, { decimals = 1 } = {}) {
  if (units.imperial) return `${toFeet(m).toFixed(0)} ft`;
  return `${m.toFixed(decimals)} m`;
}

// Degrees are unitless in both systems, but the step size for a temperature slider
// should feel native: whole °F, half °C.
export function tempStep() { return units.imperial ? 1 : 0.5; }

// Slider values live in display units; these move between display and metric.
export function tempToDisplay(c) { return units.imperial ? toF(c) : c; }
export function tempFromDisplay(v) { return units.imperial ? (v - 32) * 5 / 9 : v; }
export const tempScaleLabel = () => (units.imperial ? '°F' : '°C');
