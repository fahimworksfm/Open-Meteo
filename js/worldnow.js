// worldnow.js — "the world right now": one batched Open-Meteo call across a spread of
// places, surfacing live extremes so hunting achievements is discovery, not tedium.

import { fetchWorldNow } from './api.js';
import { describeCode } from './palette.js';
import { temp, wind } from './units.js';

const PLACES = [
  { name: 'Reykjavík', country: 'Iceland', lat: 64.15, lon: -21.94 },
  { name: 'Nuuk', country: 'Greenland', lat: 64.18, lon: -51.72 },
  { name: 'Longyearbyen', country: 'Svalbard', lat: 78.22, lon: 15.63 },
  { name: 'Yakutsk', country: 'Russia', lat: 62.03, lon: 129.73 },
  { name: 'Oymyakon', country: 'Russia', lat: 63.46, lon: 142.79 },
  { name: 'Fairbanks', country: 'USA', lat: 64.84, lon: -147.72 },
  { name: 'Ushuaia', country: 'Argentina', lat: -54.80, lon: -68.30 },
  { name: 'Furnace Creek', country: 'USA', lat: 36.46, lon: -116.87 },
  { name: 'Phoenix', country: 'USA', lat: 33.45, lon: -112.07 },
  { name: 'Dubai', country: 'UAE', lat: 25.20, lon: 55.27 },
  { name: 'Kuwait City', country: 'Kuwait', lat: 29.38, lon: 47.99 },
  { name: 'New Delhi', country: 'India', lat: 28.61, lon: 77.21 },
  { name: 'Singapore', country: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Jakarta', country: 'Indonesia', lat: -6.21, lon: 106.85 },
  { name: 'Darwin', country: 'Australia', lat: -12.46, lon: 130.84 },
  { name: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21 },
  { name: 'Wellington', country: 'New Zealand', lat: -41.29, lon: 174.78 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, lon: 18.42 },
  { name: 'Nairobi', country: 'Kenya', lat: -1.29, lon: 36.82 },
  { name: 'Cairo', country: 'Egypt', lat: 30.04, lon: 31.24 },
  { name: 'Mumbai', country: 'India', lat: 19.08, lon: 72.88 },
  { name: 'Bangkok', country: 'Thailand', lat: 13.76, lon: 100.50 },
  { name: 'Hong Kong', country: 'China', lat: 22.32, lon: 114.17 },
  { name: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.69 },
  { name: 'Honolulu', country: 'USA', lat: 21.31, lon: -157.86 },
  { name: 'Miami', country: 'USA', lat: 25.76, lon: -80.19 },
  { name: 'New York', country: 'USA', lat: 40.71, lon: -74.01 },
  { name: 'Mexico City', country: 'Mexico', lat: 19.43, lon: -99.13 },
  { name: 'Lima', country: 'Peru', lat: -12.05, lon: -77.04 },
  { name: 'São Paulo', country: 'Brazil', lat: -23.55, lon: -46.63 },
  { name: 'Buenos Aires', country: 'Argentina', lat: -34.60, lon: -58.38 },
  { name: 'London', country: 'UK', lat: 51.51, lon: -0.13 },
  { name: 'Madrid', country: 'Spain', lat: 40.42, lon: -3.70 },
  { name: 'Tromsø', country: 'Norway', lat: 69.65, lon: 18.96 },
  { name: 'Nazaré', country: 'Portugal', lat: 39.60, lon: -9.07 },
  { name: 'Punta Arenas', country: 'Chile', lat: -53.16, lon: -70.91 },
];

export class WorldNow {
  constructor() {
    this.data = null;
    this.fetchedAt = 0;
  }

  async refresh() {
    if (this.data && Date.now() - this.fetchedAt < 10 * 60 * 1000) return this.data;
    this.data = await fetchWorldNow(PLACES);
    this.fetchedAt = Date.now();
    return this.data;
  }

  // Anything currently storming, for the hint badge on the globe button.
  stormsNow() {
    if (!this.data) return [];
    return this.data.filter(p => p.code >= 95);
  }

  render(container, onFly) {
    const frag = document.createDocumentFragment();
    const intro = document.createElement('p');
    intro.textContent = 'Live conditions across the planet — tap any card to fly there and stand in it.';
    frag.appendChild(intro);

    const valid = (this.data || []).filter(p => p.temp !== null);
    if (!valid.length) {
      const err = document.createElement('p');
      err.textContent = 'Could not reach the live feed. Try again in a moment.';
      frag.appendChild(err);
      container.replaceChildren(frag);
      return;
    }

    const hottest = [...valid].sort((a, b) => b.temp - a.temp)[0];
    const coldest = [...valid].sort((a, b) => a.temp - b.temp)[0];
    const windiest = [...valid].sort((a, b) => b.wind - a.wind)[0];
    const storms = valid.filter(p => p.code >= 95);
    const snowing = valid.filter(p => describeCode(p.code).kind === 'snow');
    const raining = valid.filter(p => describeCode(p.code).kind === 'rain');

    const wrap = document.createElement('div');
    wrap.className = 'wn-extremes';

    const card = (ico, label, place, value) => {
      const el = document.createElement('button');
      el.className = 'wn-card';
      el.innerHTML = `
        <div class="wn-ico">${ico}</div>
        <div><div class="wn-label">${label}</div><div class="wn-place">${place.name}, ${place.country}</div></div>
        <div class="wn-val">${value}</div>`;
      el.addEventListener('click', () => onFly(place));
      return el;
    };

    wrap.appendChild(card('🔥', 'hottest right now', hottest, temp(hottest.temp)));
    wrap.appendChild(card('🧊', 'coldest right now', coldest, temp(coldest.temp)));
    wrap.appendChild(card('💨', 'windiest right now', windiest, wind(windiest.wind)));
    for (const s of storms.slice(0, 4)) wrap.appendChild(card('⛈️', 'thunderstorm in progress', s, temp(s.temp)));
    for (const s of snowing.slice(0, 3)) wrap.appendChild(card('🌨️', 'snowing right now', s, temp(s.temp)));
    for (const s of raining.slice(0, 3)) wrap.appendChild(card('🌧️', 'raining right now', s, temp(s.temp)));
    frag.appendChild(wrap);

    const upd = document.createElement('div');
    upd.className = 'wn-updated';
    const age = Math.round((Date.now() - this.fetchedAt) / 60000);
    upd.textContent = `sampled across ${valid.length} places · updated ${age < 1 ? 'just now' : age + ' min ago'}`;
    frag.appendChild(upd);

    container.replaceChildren(frag);
  }
}
