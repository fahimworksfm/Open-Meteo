// sky.js — the dome above the diorama: graded sky shader, sun, moon, stars,
// and a fleet of low-poly cloud clusters whose count and mood track real cloud cover.

import * as THREE from 'three';

const DOME_RADIUS = 900;
const CELESTIAL_DIST = 780;
const MAX_CLUSTERS = 14;
const CLOUD_FIELD = 420;

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    // ---- dome ----
    this.domeUniforms = {
      uTop: { value: new THREE.Color(0x3179d6) },
      uHorizon: { value: new THREE.Color(0x9ccdf0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFlash: { value: 0 },
    };
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform float uFlash;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 sky = mix(uHorizon, uTop, pow(h, 0.62));
          float sunAmount = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
          sky += uSunColor * 0.55 * pow(sunAmount, 24.0);
          sky += uSunColor * 0.25 * pow(sunAmount, 4.0);
          sky = mix(sky, vec3(0.92, 0.95, 1.0), uFlash * 0.85);
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), domeMat);
    this.dome.renderOrder = -10;
    this.group.add(this.dome);

    // ---- stars ----
    const starCount = 700;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // upper hemisphere, biased away from the horizon
      const az = Math.random() * Math.PI * 2;
      const alt = Math.asin(Math.random() * 0.98 + 0.02);
      const r = DOME_RADIUS * 0.96;
      starPos[i * 3] = Math.sin(az) * Math.cos(alt) * r;
      starPos[i * 3 + 1] = Math.sin(alt) * r;
      starPos[i * 3 + 2] = -Math.cos(az) * Math.cos(alt) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 1.7, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -9;
    this.group.add(this.stars);

    // ---- sun & moon ----
    this.sunMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(16, 16, 12), this.sunMat);
    this.sun.renderOrder = -8;
    this.group.add(this.sun);

    this.moonMat = new THREE.MeshBasicMaterial({
      color: 0xdde6f0, transparent: true, opacity: 0, fog: false,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 12), this.moonMat);
    this.moon.renderOrder = -8;
    this.group.add(this.moon);

    // ---- clouds ----
    this.clusters = [];
    const puffGeo = new THREE.IcosahedronGeometry(1, 0);
    for (let c = 0; c < MAX_CLUSTERS; c++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, flatShading: true, transparent: true,
        opacity: 0, roughness: 1, metalness: 0, depthWrite: false,
      });
      const cluster = new THREE.Group();
      const puffCount = 5 + Math.floor(Math.random() * 4);
      let spread = 0;
      for (let p = 0; p < puffCount; p++) {
        const puff = new THREE.Mesh(puffGeo, mat);
        const s = 4 + Math.random() * 7;
        puff.scale.set(s, s * (0.42 + Math.random() * 0.2), s * (0.75 + Math.random() * 0.4));
        puff.position.set(
          (Math.random() - 0.5) * 26,
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 14,
        );
        puff.rotation.y = Math.random() * Math.PI;
        spread = Math.max(spread, Math.abs(puff.position.x) + s);
        cluster.add(puff);
      }
      cluster.position.set(
        (Math.random() - 0.5) * CLOUD_FIELD,
        66 + Math.random() * 38,
        (Math.random() - 0.5) * CLOUD_FIELD,
      );
      cluster.userData = { mat, baseY: cluster.position.y, targetOpacity: 0, speedJitter: 0.7 + Math.random() * 0.6 };
      this.clusters.push(cluster);
      this.group.add(cluster);
    }
  }

  // env: { grade, sunDir, moonDir, moonPhase, windVec, windKmh, flash }
  update(dt, env) {
    const g = env.grade;

    this.domeUniforms.uTop.value.copy(g.skyTop);
    this.domeUniforms.uHorizon.value.copy(g.skyHorizon);
    this.domeUniforms.uSunColor.value.copy(g.sunColor).multiplyScalar(0.5 + g.dayness * 0.6);
    this.domeUniforms.uSunDir.value.copy(env.sunDir);
    this.domeUniforms.uFlash.value = env.flash;

    this.starMat.opacity += (g.starAlpha - this.starMat.opacity) * Math.min(1, dt * 2);

    this.sun.position.copy(env.sunDir).multiplyScalar(CELESTIAL_DIST);
    this.sunMat.color.copy(g.sunColor);
    this.sun.visible = env.sunDir.y > -0.06;

    this.moon.position.copy(env.moonDir).multiplyScalar(CELESTIAL_DIST);
    const moonBright = (1 - g.dayness) * (0.35 + 0.65 * Math.sin(env.moonPhase * Math.PI));
    this.moonMat.opacity += (moonBright - this.moonMat.opacity) * Math.min(1, dt * 2);
    this.moon.visible = env.moonDir.y > -0.04 && this.moonMat.opacity > 0.02;

    // clouds: active count follows real cloud cover
    const cloudFrac = Math.min(1, (env.cond.cloud || 0) / 100);
    const active = Math.round(cloudFrac * MAX_CLUSTERS);
    const stormy = g.info.thunder === 1 || (g.info.rain || 0) > 0.6;
    const drift = env.windVec.clone().multiplyScalar(0.35 + env.windKmh * 0.045);

    const cloudColor = new THREE.Color(0xffffff).lerp(new THREE.Color(0x39424f), g.cloudDarkness);

    for (let i = 0; i < this.clusters.length; i++) {
      const cl = this.clusters[i];
      const ud = cl.userData;
      ud.targetOpacity = i < active ? (stormy ? 0.96 : 0.88) : 0;
      ud.mat.opacity += (ud.targetOpacity - ud.mat.opacity) * Math.min(1, dt * 1.2);
      ud.mat.color.copy(cloudColor);
      cl.visible = ud.mat.opacity > 0.015;

      cl.position.addScaledVector(drift, dt * ud.speedJitter);
      const targetY = ud.baseY - (stormy ? 22 : 0);
      cl.position.y += (targetY - cl.position.y) * Math.min(1, dt * 0.5);

      // wrap around the field so clouds keep coming with the wind
      const half = CLOUD_FIELD / 2 + 40;
      if (cl.position.x > half) cl.position.x = -half;
      if (cl.position.x < -half) cl.position.x = half;
      if (cl.position.z > half) cl.position.z = -half;
      if (cl.position.z < -half) cl.position.z = half;
    }
  }
}
