// duel.js — the forecast duel. You call tomorrow's high for the place you're viewing;
// the model's own forecast is locked in beside yours. A day later, reality (the actual
// recorded maximum) settles who was closer. All state lives in localStorage.

import { fetchActualMaxTemp, fetchModelMaxTemp } from './api.js';

const KEY = 'meteora.duel.v1';

export class Duel {
  constructor(onResolved) {
    this.onResolved = onResolved; // (prediction) => void, for toasts + achievements
    try {
      this.state = JSON.parse(localStorage.getItem(KEY)) || null;
    } catch { this.state = null; }
    if (!this.state) {
      this.state = { predictions: [], record: { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 } };
    }
  }

  _save() { localStorage.setItem(KEY, JSON.stringify(this.state)); }

  get record() { return this.state.record; }

  // Local "tomorrow" for a place, from its UTC offset.
  targetDateFor(utcOffsetSeconds) {
    const local = new Date(Date.now() + utcOffsetSeconds * 1000 + 86400000);
    return local.toISOString().slice(0, 10);
  }

  hasOpenPrediction(place, dateStr) {
    return this.state.predictions.some(p =>
      !p.resolved && p.date === dateStr &&
      Math.abs(p.lat - place.lat) < 0.05 && Math.abs(p.lon - place.lon) < 0.05);
  }

  async place(place, utcOffsetSeconds, guess) {
    const date = this.targetDateFor(utcOffsetSeconds);
    if (this.hasOpenPrediction(place, date)) return { ok: false, reason: 'already-placed' };
    let model = null;
    try { model = await fetchModelMaxTemp(place.lat, place.lon, date); } catch { /* keep null */ }
    if (model === null) return { ok: false, reason: 'no-model' };
    const prediction = {
      id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      name: place.name, lat: place.lat, lon: place.lon,
      date, guess: Math.round(guess * 10) / 10, model,
      // settle once the target day is fully over at the place (+3 h for data to land)
      resolveAfter: Date.now() + 86400000 + (24 - new Date(Date.now() + utcOffsetSeconds * 1000).getUTCHours() + 3) * 3600000,
      resolved: false,
    };
    this.state.predictions.unshift(prediction);
    if (this.state.predictions.length > 40) this.state.predictions.length = 40;
    this._save();
    return { ok: true, prediction };
  }

  async resolveDue() {
    const due = this.state.predictions.filter(p => !p.resolved && Date.now() > p.resolveAfter);
    for (const p of due) {
      const actual = await fetchActualMaxTemp(p.lat, p.lon, p.date);
      if (actual === null) { p.resolveAfter = Date.now() + 6 * 3600000; continue; } // retry later
      p.actual = actual;
      p.errUser = Math.abs(p.guess - actual);
      p.errModel = Math.abs(p.model - actual);
      p.outcome = p.errUser < p.errModel ? 'win' : (p.errUser > p.errModel ? 'loss' : 'draw');
      p.resolved = true;

      const r = this.state.record;
      if (p.outcome === 'win') {
        r.wins++; r.streak++;
        r.bestStreak = Math.max(r.bestStreak, r.streak);
      } else if (p.outcome === 'loss') {
        r.losses++; r.streak = 0;
      } else { r.draws++; }
      if (this.onResolved) this.onResolved(p);
    }
    if (due.length) this._save();
    return due.filter(p => p.resolved);
  }

  render(container, currentPlace, utcOffsetSeconds, refTemp, onPlaced) {
    const r = this.state.record;
    const frag = document.createDocumentFragment();

    const score = document.createElement('div');
    score.className = 'duel-score';
    score.innerHTML = `
      <div class="ds"><b>${r.wins}</b><span>wins</span></div>
      <div class="ds"><b>${r.losses}</b><span>losses</span></div>
      <div class="ds"><b>${r.streak}</b><span>streak</span></div>
      <div class="ds"><b>${r.bestStreak}</b><span>best</span></div>`;
    frag.appendChild(score);

    if (currentPlace) {
      const date = this.targetDateFor(utcOffsetSeconds);
      const already = this.hasOpenPrediction(currentPlace, date);
      const form = document.createElement('div');
      form.className = 'duel-place-form';
      if (already) {
        form.innerHTML = `<div class="dp-title">🎯 ${currentPlace.name} — ${date}</div>
          <div class="duel-note">Your call is locked in. Come back after the day ends to see who was closer.</div>`;
      } else {
        const start = Math.round(refTemp ?? 15);
        form.innerHTML = `
          <div class="dp-title">🎯 Call tomorrow's high — ${currentPlace.name}, ${date}</div>
          <div class="duel-guess-row">
            <input type="range" id="duel-slider" min="${start - 25}" max="${start + 25}" step="0.5" value="${start}">
            <div class="duel-guess-val" id="duel-val">${start}°</div>
          </div>
          <div style="margin-top:10px"><button class="chip-btn" id="duel-place-btn">Lock it in</button></div>
          <div class="duel-note">The model locks its own forecast at the same moment. Reality decides tomorrow. Beat the supercomputer.</div>`;
      }
      frag.appendChild(form);

      if (!already) {
        const slider = form.querySelector('#duel-slider');
        const val = form.querySelector('#duel-val');
        slider.addEventListener('input', () => { val.textContent = `${slider.value}°`; });
        form.querySelector('#duel-place-btn').addEventListener('click', async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Locking…';
          const res = await this.place(currentPlace, utcOffsetSeconds, parseFloat(slider.value));
          if (res.ok && onPlaced) onPlaced(res.prediction);
          else if (!res.ok) { ev.target.disabled = false; ev.target.textContent = 'Lock it in'; }
        });
      }
    }

    const h = document.createElement('h3');
    h.textContent = 'Duel history';
    frag.appendChild(h);

    const list = document.createElement('div');
    list.className = 'duel-list';
    if (!this.state.predictions.length) {
      list.innerHTML = `<p>No duels yet. Call tomorrow's high anywhere on Earth and see if you can out-forecast the model.</p>`;
    }
    for (const p of this.state.predictions.slice(0, 15)) {
      const el = document.createElement('div');
      el.className = 'duel-item';
      if (p.resolved) {
        const cls = p.outcome;
        const label = p.outcome === 'win' ? 'YOU WIN' : (p.outcome === 'loss' ? 'MODEL WINS' : 'DRAW');
        el.innerHTML = `
          <div class="di-head"><span>${p.name} · ${p.date}</span><span class="${cls}">${label}</span></div>
          <div class="di-sub">you ${p.guess}° (off ${p.errUser.toFixed(1)}) · model ${p.model}° (off ${p.errModel.toFixed(1)}) · actual ${p.actual}°</div>`;
      } else {
        el.innerHTML = `
          <div class="di-head"><span>${p.name} · ${p.date}</span><span>⏳ pending</span></div>
          <div class="di-sub">you ${p.guess}° · model ${p.model}° · settles when the day ends</div>`;
      }
      list.appendChild(el);
    }
    frag.appendChild(list);
    container.replaceChildren(frag);
  }
}
