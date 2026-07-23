// effects.js — precipitation and lightning. Rain and snow live entirely on the GPU:
// seeded particles wrap through a box around the viewpoint, driven by uniforms that
// track real precipitation intensity and the real wind vector.

import * as THREE from 'three';

const AREA = 130;   // horizontal extent of the precipitation box
const HEIGHT = 55;  // vertical extent

export class Precipitation {
  constructor(scene) {
    this.scene = scene;
    this._buildRain();
    this._buildSnow();
  }

  _buildRain() {
    const drops = 1500;
    const seeds = new Float32Array(drops * 2 * 3);
    const tips = new Float32Array(drops * 2);
    for (let i = 0; i < drops; i++) {
      const s0 = Math.random(), s1 = Math.random(), s2 = Math.random();
      for (let v = 0; v < 2; v++) {
        seeds[(i * 2 + v) * 3] = s0;
        seeds[(i * 2 + v) * 3 + 1] = s1;
        seeds[(i * 2 + v) * 3 + 2] = s2;
        tips[i * 2 + v] = v;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(drops * 2 * 3), 3)); // unused, required
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));

    this.rainUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uWind: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uWind;
        attribute vec3 aSeed;
        attribute float aTip;
        varying float vAlpha;
        void main() {
          float fall = 46.0;
          float t = fract(aSeed.y + uTime * (fall / ${HEIGHT}.0) * (0.85 + aSeed.z * 0.3));
          vec3 dir = normalize(vec3(uWind.x, -fall, uWind.z));
          vec3 base = vec3(
            (aSeed.x - 0.5) * ${AREA}.0 + uWind.x * t * 1.2,
            ${HEIGHT}.0 * (1.0 - t),
            (aSeed.z - 0.5) * ${AREA}.0 + uWind.z * t * 1.2
          );
          vec3 p = base + dir * aTip * (0.9 + aSeed.z * 0.5);
          vAlpha = (0.16 + aSeed.z * 0.2) * (1.0 - aTip * 0.65);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uIntensity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(0.72, 0.8, 0.92, vAlpha * uIntensity);
        }
      `,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  _buildSnow() {
    const flakes = 1800;
    const seeds = new Float32Array(flakes * 3);
    for (let i = 0; i < flakes * 3; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flakes * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

    this.snowUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uWind: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.snowUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uWind;
        attribute vec3 aSeed;
        varying float vAlpha;
        void main() {
          float fall = 3.2 + aSeed.z * 2.2;
          float t = fract(aSeed.y + uTime * (fall / ${HEIGHT}.0));
          float sway = sin(uTime * (0.8 + aSeed.z) + aSeed.x * 40.0) * 2.2;
          vec3 p = vec3(
            (aSeed.x - 0.5) * ${AREA}.0 + sway + uWind.x * t * 2.4,
            ${HEIGHT}.0 * (1.0 - t),
            (aSeed.z - 0.5) * ${AREA}.0 + sway * 0.6 + uWind.z * t * 2.4
          );
          vAlpha = 0.5 + aSeed.z * 0.5;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_PointSize = (2.2 + aSeed.x * 2.6) * (140.0 / max(-mv.z, 8.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uIntensity;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float disc = smoothstep(0.5, 0.18, d);
          gl_FragColor = vec4(0.96, 0.98, 1.0, disc * vAlpha * uIntensity);
        }
      `,
    });
    this.snow = new THREE.Points(geo, mat);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.scene.add(this.snow);
  }

  // env: { grade, cond, windVec, windKmh }
  update(dt, env) {
    const info = env.grade.info;
    const wind = env.windVec.clone().multiplyScalar(Math.min(env.windKmh * 0.28, 26));

    const rainTarget = info.rain || 0;
    const ru = this.rainUniforms;
    ru.uTime.value += dt;
    ru.uIntensity.value += (rainTarget - ru.uIntensity.value) * Math.min(1, dt * 1.5);
    ru.uWind.value.copy(wind);
    this.rain.visible = ru.uIntensity.value > 0.02;

    const snowTarget = info.snow || 0;
    const su = this.snowUniforms;
    su.uTime.value += dt;
    su.uIntensity.value += (snowTarget - su.uIntensity.value) * Math.min(1, dt * 1.5);
    su.uWind.value.copy(wind.multiplyScalar(0.4));
    this.snow.visible = su.uIntensity.value > 0.02;
  }

  dispose() {
    for (const obj of [this.rain, this.snow]) {
      obj.geometry.dispose();
      obj.material.dispose();
      this.scene.remove(obj);
    }
  }
}

// ---------------------------------------------------------------------------

export class Lightning {
  constructor(scene, onStrike) {
    this.scene = scene;
    this.onStrike = onStrike; // (distanceNorm) => void, for thunder audio
    this.flash = 0;           // read by the renderer every frame
    this.active = false;
    this.nextStrike = 2 + Math.random() * 5;

    const mat = new THREE.LineBasicMaterial({
      color: 0xeef4ff, transparent: true, opacity: 0, fog: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    this.bolt = new THREE.LineSegments(geo, mat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.scene.add(this.bolt);
    this.boltTtl = 0;
  }

  setActive(active) {
    if (active && !this.active) this.nextStrike = 0.5 + Math.random() * 3;
    this.active = active;
  }

  _strike() {
    const x = (Math.random() - 0.5) * 180;
    const z = (Math.random() - 0.5) * 180;
    const top = 60 + Math.random() * 20;

    const pts = [];
    let px = x, py = top, pz = z;
    while (py > 0) {
      const nx = px + (Math.random() - 0.5) * 7;
      const ny = py - (4 + Math.random() * 7);
      const nz = pz + (Math.random() - 0.5) * 7;
      pts.push(px, py, pz, nx, Math.max(ny, 0), nz);
      // occasional fork
      if (Math.random() < 0.3 && pts.length < 150) {
        pts.push(px, py, pz,
          px + (Math.random() - 0.5) * 16,
          py - 4 - Math.random() * 8,
          pz + (Math.random() - 0.5) * 16);
      }
      px = nx; py = ny; pz = nz;
    }
    const arr = new Float32Array(64 * 3 * 2);
    arr.set(pts.slice(0, arr.length));
    this.bolt.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.bolt.geometry.setDrawRange(0, Math.min(pts.length / 3, 128));
    this.bolt.visible = true;
    this.bolt.material.opacity = 1;
    this.boltTtl = 0.14 + Math.random() * 0.1;

    this.flash = 1;
    const dist = Math.sqrt(x * x + z * z) / 130; // 0 near … 1 far
    if (this.onStrike) this.onStrike(dist);
  }

  update(dt) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 4.5);
      // secondary flicker
      if (Math.random() < 0.08 && this.flash > 0.2) this.flash = Math.min(1, this.flash + 0.35);
    }
    if (this.boltTtl > 0) {
      this.boltTtl -= dt;
      this.bolt.material.opacity = Math.max(0, this.boltTtl * 6);
      if (this.boltTtl <= 0) this.bolt.visible = false;
    }
    if (this.active) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this._strike();
        this.nextStrike = 2.5 + Math.random() * 8;
      }
    }
  }

  dispose() {
    this.bolt.geometry.dispose();
    this.bolt.material.dispose();
    this.scene.remove(this.bolt);
  }
}
