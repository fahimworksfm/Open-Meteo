// world.js — owns the renderer, camera, lights, and the currently-loaded diorama.
// main.js feeds it one "env" object per frame (real conditions + sun + grade);
// everything visual flows down from that.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from './sky.js';
import { Diorama } from './terrain.js';
import { RealTerrain } from './realterrain.js';
import { Precipitation, Lightning } from './effects.js';

export class World {
  constructor(canvas, { onStrike } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
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

  // env: { cond, grade, sunDir, moonDir, moonPhase, windVec, windKmh }
  setEnvironment(env) {
    this.env = env;
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(this._clock.getDelta(), 0.1);

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
    this.renderer.render(this.scene, this.camera);
  }
}
