// world.js — owns the renderer, camera, lights, and the currently-loaded diorama.
// main.js feeds it one "env" object per frame (real conditions + sun + grade);
// everything visual flows down from that.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from './sky.js';
import { Diorama } from './terrain.js';
import { RealTerrain } from './realterrain.js';
import { Precipitation, Lightning } from './effects.js';
import { PostFX, postSupported } from './post.js';

export const QUALITIES = ['low', 'medium', 'high'];
const PIXEL_RATIO_CAP = { low: 1.25, medium: 1.5, high: 2 };

export class World {
  // quality: 'low' (direct render) | 'medium' | 'high' (bloom + grade, denser weather)
  constructor(canvas, { onStrike, quality = 'high', onQualityDrop } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.postSupported = postSupported(this.renderer);
    this.onQualityDrop = onQualityDrop; // (newQuality) => void, after an automatic step down
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9ccdf0, 0.002);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 2400);
    this.camera.position.set(46, 30, 62);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 7, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 26;
    this.controls.maxDistance = 170;
    this.controls.maxPolarAngle = 1.45;
    this.controls.minPolarAngle = 0.25;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    canvas.addEventListener('pointerdown', () => { this.controls.autoRotate = false; }, { once: false });

    // lights for the standard-material props (trees, clouds, rocks);
    // terrain & water use the same values through their own uniforms
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.position.set(60, 120, 40);
    this.scene.add(this.sunLight);
    this.hemiLight = new THREE.HemisphereLight(0xbfd8f0, 0x53607a, 0.6);
    this.scene.add(this.hemiLight);

    this.sky = new Sky(this.scene);
    this.precip = new Precipitation(this.scene);
    this.lightning = new Lightning(this.scene, onStrike);

    this.post = null;
    this.quality = null;
    this.autoQuality = false; // when true, sustained low fps steps quality down
    this._perf = { time: 0, frames: 0, slowWindows: 0, grace: 4 };
    this.setQuality(quality);

    this.paused = false; // true while something opaque (the intro) covers the canvas
    this.diorama = null;
    this.env = null;
    this._clock = new THREE.Clock();
    this.onFrame = null; // main.js hook, runs before render

    window.addEventListener('resize', () => this._resize());
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.post) this._sizePost();
  }

  _sizePost() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(size.x, size.y);
  }

  setQuality(q) {
    if (!QUALITIES.includes(q)) q = 'medium';
    if (q !== 'low' && !this.postSupported) q = 'low';
    if (q === this.quality) return q;
    this.quality = q;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[q]));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    const usePost = q !== 'low';
    if (usePost) {
      if (!this.post) this.post = new PostFX(this.renderer, q);
      else this.post.setQuality(q);
      this._sizePost();
    } else if (this.post) {
      this.post.dispose();
      this.post = null;
    }
    this.sky.setHDR(usePost);
    this.lightning.setHDR(usePost);
    this.precip.setQuality(q);
    this._perf.slowWindows = 0;
    this._perf.grace = 3; // let the new settings settle before judging them
    return q;
  }

  // Watches real frame time; on a device that can't keep up, steps quality down once
  // per sustained slump. Only active while the user hasn't picked a quality themselves.
  _watchPerf(rawDt) {
    const p = this._perf;
    if (!this.autoQuality || document.hidden || this.quality === 'low' || rawDt > 0.5) return;
    p.time += rawDt;
    p.frames++;
    if (p.time < 2) return;
    const fps = p.frames / p.time;
    p.time = 0;
    p.frames = 0;
    if (p.grace > 0) { p.grace--; return; }
    p.slowWindows = fps < 30 ? p.slowWindows + 1 : 0;
    if (p.slowWindows >= 2) {
      const next = QUALITIES[QUALITIES.indexOf(this.quality) - 1];
      this.setQuality(next);
      if (this.onQualityDrop) this.onQualityDrop(next);
    }
  }

  setDiorama(params) {
    if (this.diorama) this.diorama.dispose();
    this.diorama = new Diorama(params);
    this.scene.add(this.diorama.group);
    this._frameCamera();
    return this.diorama;
  }

  // photoreal mode: real elevation wearing real satellite imagery
  setRealTerrain(tileData, { lat, lon } = {}) {
    if (this.diorama) this.diorama.dispose();
    this.diorama = new RealTerrain(tileData, { lat, lon });
    this.scene.add(this.diorama.group);
    this._frameCamera();
    return this.diorama;
  }

  _frameCamera() {
    const maxY = this.diorama.maxY;
    // terrains declare their own framing; the stylized diorama uses the close default
    const f = this.diorama.framing || { distance: 77, pitch: 0.42, maxDistance: 170 };
    const focusY = Math.min(Math.max(maxY * 0.45, 4), 16);
    this.controls.target.set(0, focusY, 0);

    const horiz = Math.cos(f.pitch) * f.distance;
    this.camera.position.set(
      horiz * 0.6,
      Math.max(f.distance * Math.sin(f.pitch), maxY * 1.15 + 10),
      horiz * 0.8,
    );
    this.controls.maxDistance = f.maxDistance;
    this.controls.autoRotate = true;
  }

  // env: { cond, grade, sunDir, moonDir, moonPhase, windVec, windKmh, era }
  setEnvironment(env) {
    this.env = env;
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const rawDt = this._clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    if (this.paused) return; // nothing visible to draw; spare the GPU and battery
    this._watchPerf(rawDt);

    if (this.onFrame) this.onFrame(dt);

    const env = this.env;
    if (env) {
      this.lightning.setActive(!!env.grade.info.thunder);
      this.lightning.update(dt);
      env.flash = this.lightning.flash;

      this.sky.update(dt, env);
      if (this.diorama) this.diorama.update(dt, env);
      this.precip.update(dt, env);

      const g = env.grade;
      this.sunLight.color.copy(g.sunColor);
      this.sunLight.intensity = g.lightIntensity * 1.25 + env.flash * 1.6;
      this.sunLight.position.copy(env.sunDir).multiplyScalar(220);
      this.hemiLight.color.copy(g.skyHorizon);
      this.hemiLight.groundColor.copy(g.ambientColor).multiplyScalar(0.55);
      this.hemiLight.intensity = g.ambientIntensity * 0.95 + env.flash * 0.8;
      this.scene.fog.color.copy(g.fogColor);
      this.scene.fog.density = g.fogDensity;
    }

    this.controls.update();
    if (this.post) this.post.render(this.scene, this.camera, env, dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
