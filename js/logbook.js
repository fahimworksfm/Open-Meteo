// logbook.js — the witnessed-weather achievement system. Entries earned while viewing
// "now" count as live sightings; anything reached through the time machine is honestly
// badged as time travel. Everything persists in localStorage.

const KEY = 'meteora.logbook.v1';
const VISITED_KEY = 'meteora.visited.v1';

// ctx: { cond, live, sunAltDeg, place, timeMs, year, visitedCount, hasSea, duelRecord }
export const ACHIEVEMENTS = [
  { id: 'first-steps', ico: '👣', name: 'First Steps',
    desc: 'Visit your first place.',
    check: c => c.visitedCount >= 1 },
  { id: 'globetrotter', ico: '🧭', name: 'Globetrotter',
    desc: 'Visit 10 different places.',
    check: c => c.visitedCount >= 10 },
  { id: 'storm-witness', ico: '⛈️', name: 'Storm Witness',
    desc: 'Be present during a real thunderstorm.',
    check: c => c.cond.code >= 95 },
  { id: 'deep-freeze', ico: '🥶', name: 'Deep Freeze',
    desc: 'Stand somewhere at −30 °C or below.',
    check: c => c.cond.temp <= -30 },
  { id: 'furnace', ico: '🔥', name: 'Furnace',
    desc: 'Stand somewhere at 40 °C or above.',
    check: c => c.cond.temp >= 40 },
  { id: 'gale-rider', ico: '🌪️', name: 'Gale Rider',
    desc: 'Feel winds of 90 km/h or more.',
    check: c => c.cond.windSpeed >= 90 },
  { id: 'big-swell', ico: '🌊', name: 'Big Swell',
    desc: 'Watch seas running 5 m waves or higher.',
    check: c => (c.cond.waveH || 0) >= 5 },
  { id: 'whiteout', ico: '🌨️', name: 'Whiteout',
    desc: 'Witness heavy snowfall.',
    check: c => c.cond.code === 75 || c.cond.code === 86 || c.cond.snowfall >= 2.5 },
  { id: 'golden-hour', ico: '🌅', name: 'Golden Hour',
    desc: 'Catch the sun within 8° of the horizon under open sky.',
    check: c => c.sunAltDeg > 0 && c.sunAltDeg < 8 && c.cond.cloud < 45 },
  { id: 'sunshower', ico: '🌦️', name: 'Sunshower',
    desc: 'Rain while the sun is out.',
    check: c => c.sunAltDeg > 5 && c.cond.precip > 0.3 && c.cond.cloud < 70 },
  { id: 'midnight-sun', ico: '🌞', name: 'Midnight Sun',
    desc: 'See the sun above the horizon at local midnight.',
    check: c => c.sunAltDeg > 0 && (c.localHour === 0 || c.localHour === 23) },
  { id: 'night-owl', ico: '🦉', name: 'Night Owl',
    desc: 'Visit a place at its local midnight.',
    check: c => c.localHour === 0 },
  { id: 'time-traveler', ico: '🕰️', name: 'Time Traveler',
    desc: 'Take an expedition to any year before 2000.',
    check: c => c.year !== null && c.year < 2000 },
  { id: 'ancient-weather', ico: '📜', name: 'Ancient Weather',
    desc: 'Witness weather from before 1950.',
    check: c => c.year !== null && c.year < 1950 },
  { id: 'forecaster', ico: '🎯', name: 'Forecaster',
    desc: 'Win your first forecast duel against the model.',
    check: c => (c.duelRecord?.wins || 0) >= 1 },
  { id: 'oracle', ico: '🔮', name: 'Oracle',
    desc: 'Win 5 forecast duels.',
    check: c => (c.duelRecord?.wins || 0) >= 5 },
  { id: 'hot-streak', ico: '⚡', name: 'Hot Streak',
    desc: 'Win 3 forecast duels in a row.',
    check: c => (c.duelRecord?.bestStreak || 0) >= 3 },
];

// Weather sightings must be witnessed (live or via time machine); meta achievements
// (visits, duels, expeditions) are earned regardless of the scrub position.
const META = new Set(['first-steps', 'globetrotter', 'time-traveler', 'ancient-weather',
  'forecaster', 'oracle', 'hot-streak', 'night-owl']);

export class Logbook {
  constructor(onUnlock) {
    this.onUnlock = onUnlock; // (achievement, entry) => void
    try { this.earned = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { this.earned = {}; }
    try { this.visited = JSON.parse(localStorage.getItem(VISITED_KEY)) || []; } catch { this.visited = []; }
  }

  _save() {
    localStorage.setItem(KEY, JSON.stringify(this.earned));
    localStorage.setItem(VISITED_KEY, JSON.stringify(this.visited));
  }

  recordVisit(place) {
    const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
    if (!this.visited.includes(key)) {
      this.visited.push(key);
      if (this.visited.length > 500) this.visited.shift();
      this._save();
    }
  }

  get visitedCount() { return this.visited.length; }

  check(ctx) {
    ctx.visitedCount = this.visitedCount;
    for (const a of ACHIEVEMENTS) {
      if (this.earned[a.id]) continue;
      let ok = false;
      try { ok = a.check(ctx); } catch { ok = false; }
      if (!ok) continue;
      const entry = {
        earnedAt: Date.now(),
        place: ctx.place ? `${ctx.place.name}` : '',
        mode: META.has(a.id) ? 'meta' : (ctx.live ? 'live' : 'timetravel'),
        when: ctx.timeMs ? new Date(ctx.timeMs).toISOString().slice(0, 10) : '',
      };
      this.earned[a.id] = entry;
      this._save();
      if (this.onUnlock) this.onUnlock(a, entry);
    }
  }

  render(container) {
    const earnedCount = Object.keys(this.earned).length;
    const frag = document.createDocumentFragment();

    const prog = document.createElement('div');
    prog.className = 'lb-progress';
    prog.textContent = `${earnedCount} of ${ACHIEVEMENTS.length} witnessed · ${this.visitedCount} places visited`;
    frag.appendChild(prog);

    const grid = document.createElement('div');
    grid.className = 'lb-grid';
    const sorted = [...ACHIEVEMENTS].sort((a, b) => (this.earned[b.id] ? 1 : 0) - (this.earned[a.id] ? 1 : 0));
    for (const a of sorted) {
      const e = this.earned[a.id];
      const el = document.createElement('div');
      el.className = 'lb-entry' + (e ? '' : ' locked');
      let earnedLine = '';
      if (e) {
        const badge = e.mode === 'timetravel' ? ' <span class="tt">· via time machine</span>' : '';
        const at = e.place ? ` — ${e.place}` : '';
        earnedLine = `<div class="lb-earned">✓ ${e.when || ''}${at}${badge}</div>`;
      }
      el.innerHTML = `
        <div class="lb-ico">${a.ico}</div>
        <div>
          <div class="lb-name">${a.name}</div>
          <div class="lb-desc">${a.desc}</div>
          ${earnedLine}
        </div>`;
      grid.appendChild(el);
    }
    frag.appendChild(grid);
    container.replaceChildren(frag);
  }
}
