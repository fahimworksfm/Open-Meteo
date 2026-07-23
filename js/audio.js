// audio.js — procedural weather sound. No samples: wind is filtered noise breathing
// with real wind speed, rain is hissing noise scaled by real intensity, thunder is a
// shaped rumble delayed by the strike's distance. Starts only after a user gesture.

export class AudioEngine {
  constructor() {
    this.enabled = localStorage.getItem('meteora.sound') === 'on';
    this.ctx = null;
    this._targets = { wind: 0, rain: 0, windFreq: 500 };
  }

  _ensure() {
    if (this.ctx) return true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return false;
    }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(ctx.destination);

    // shared looping noise source
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const mkNoise = () => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    };

    // wind: noise → lowpass → gain, with a slow LFO for gusts
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    mkNoise().connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    this.gustLfo = ctx.createOscillator();
    this.gustLfo.frequency.value = 0.13;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 0;
    this.gustLfo.connect(this.gustGain);
    this.gustGain.connect(this.windGain.gain);
    this.gustLfo.start();

    // rain: noise → highpass → gain
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 1400;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    mkNoise().connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.master);

    this._noiseBuf = buf;
    return true;
  }

  // call from any user gesture so the context is allowed to run
  unlock() {
    if (!this._ensure()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('meteora.sound', this.enabled ? 'on' : 'off');
    this.unlock();
    if (this.ctx) {
      this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, this.ctx.currentTime, 0.2);
    }
    return this.enabled;
  }

  // windKmh + rain/snow intensity (0..1) from the current graded conditions
  setWeather({ windKmh, rain, snow }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const w = Math.min(windKmh / 90, 1.3);
    this.windGain.gain.setTargetAtTime(0.02 + w * 0.34, t, 0.8);
    this.windFilter.frequency.setTargetAtTime(300 + w * 700, t, 0.8);
    this.gustGain.gain.setTargetAtTime(w * 0.1, t, 1.2);
    const r = Math.min((rain || 0) + (snow || 0) * 0.25, 1.2);
    this.rainGain.gain.setTargetAtTime(r * 0.16, t, 0.8);
  }

  // distanceNorm: 0 = overhead, 1 = far away
  thunder(distanceNorm) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const delay = 0.3 + distanceNorm * 2.8; // sound lags the flash
    const t0 = ctx.currentTime + delay;

    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(160, t0);
    filter.frequency.exponentialRampToValueAtTime(45, t0 + 2.6);
    const gain = ctx.createGain();
    const peak = 0.7 * (1 - distanceNorm * 0.6);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8 + Math.random());

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t0);
    src.stop(t0 + 4.2);
  }
}
