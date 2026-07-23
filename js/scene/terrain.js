// terrain.js — the procedural low-poly diorama. Real elevation samples set the bones,
// seeded noise adds the flesh, the biome paints it, and live uniforms let real weather
// (snow, rain-wet ground, storm light, waves) play across it every frame.

import * as THREE from 'three';
import { BIOMES } from '../palette.js';

const SIZE = 190;          // world-units span of the diorama tile
const RES = 96;            // grid segments per side
const GROUND_RADIUS = 1100;

// ---------- seeded value noise ----------

function makeNoise(seed) {
  const hash = (x, y) => {
    let h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
    return h - Math.floor(h);
  };
  const smooth = t => t * t * (3 - 2 * t);
  const value = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    const u = smooth(xf), v = smooth(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, octaves = 4) => {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += value(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return sum / norm;
  };
  return { value, fbm };
}

// ---------- shared shader chunks ----------

const FOG_PARS = /* glsl */`
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying float vFogDepth;
`;
const FOG_APPLY = /* glsl */`
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  outColor = mix(outColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
`;
const LIGHT_PARS = /* glsl */`
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uLightIntensity;
  uniform vec3 uAmbientColor;
  uniform float uAmbientIntensity;
  uniform float uFlash;
`;

export class Diorama {
  // params: { elev:{grid,n,min,max}, biomeName, hasSeaHint, lat, lon, cond }
  constructor(params) {
    this.group = new THREE.Group();
    this.biome = BIOMES[params.biomeName] || BIOMES.temperate;
    this.biomeName = params.biomeName;
    const seed = Math.abs(Math.sin(params.lat * 12.9898 + params.lon * 78.233)) * 1000;
    this.noise = makeNoise(seed);

    this.sharedUniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uLightIntensity: { value: 1 },
      uAmbientColor: { value: new THREE.Color(0x8899aa) },
      uAmbientIntensity: { value: 0.5 },
      uFogColor: { value: new THREE.Color(0x9ccdf0) },
      uFogDensity: { value: 0.002 },
      uFlash: { value: 0 },
    };

    this._buildHeightfield(params);
    this._buildTerrain();
    this._buildGround();
    if (this.hasSea) this._buildWater();
    this._buildTrees();
    this._buildRocks();
  }

  // ---- heightfield from real elevation + noise detail ----
  _buildHeightfield({ elev, hasSeaHint }) {
    const { grid, n, min, max } = elev;

    let seaCells = 0;
    for (const v of grid) if (v <= 0.4) seaCells++;
    const seaFrac = seaCells / grid.length;
    this.hasSea = hasSeaHint || seaFrac > 0.12;

    const relief = Math.max(max - Math.min(min, 0), 1);
    const vScale = 16 / Math.max(relief, 150);
    this.metersToUnits = vScale;

    // grid in world units, sea carved below the waterline
    const g = new Float32Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      if (this.hasSea && grid[i] <= 0.4) g[i] = -3.2;
      else g[i] = grid[i] * vScale;
    }

    const R = RES + 1;
    const detailAmp = THREE.MathUtils.clamp(relief * vScale * 0.22, 0.5, 2.6);
    const heights = new Float32Array(R * R);
    let maxY = -Infinity;

    for (let row = 0; row < R; row++) {
      for (let col = 0; col < R; col++) {
        const u = col / RES, v = row / RES;
        // bilinear over the real elevation grid
        const gx = u * (n - 1), gy = v * (n - 1);
        const x0 = Math.min(Math.floor(gx), n - 2), y0 = Math.min(Math.floor(gy), n - 2);
        const fx = gx - x0, fy = gy - y0;
        const h00 = g[y0 * n + x0], h10 = g[y0 * n + x0 + 1];
        const h01 = g[(y0 + 1) * n + x0], h11 = g[(y0 + 1) * n + x0 + 1];
        let h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;

        const detail = (this.noise.fbm(u * 7, v * 7) - 0.5) * 2 * detailAmp;
        h += h < -0.5 ? detail * 0.25 : detail * (0.4 + Math.min(Math.abs(h) * 0.08, 0.6));

        // soften the tile rim so the diorama meets the horizon plane gracefully
        const edge = THREE.MathUtils.smoothstep(Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2, 0.84, 1.0);
        h = THREE.MathUtils.lerp(h, h * 0.2, edge);

        heights[row * R + col] = h;
        if (h > maxY) maxY = h;
      }
    }
    this.heights = heights;
    this.R = R;
    this.maxY = Math.max(maxY, 2);
  }

  heightAt(x, z) {
    const R = this.R;
    const u = THREE.MathUtils.clamp(x / SIZE + 0.5, 0, 1) * RES;
    const v = THREE.MathUtils.clamp(z / SIZE + 0.5, 0, 1) * RES;
    const x0 = Math.min(Math.floor(u), RES - 1), y0 = Math.min(Math.floor(v), RES - 1);
    const fx = u - x0, fy = v - y0;
    const h = this.heights;
    return h[y0 * R + x0] * (1 - fx) * (1 - fy) + h[y0 * R + x0 + 1] * fx * (1 - fy) +
      h[(y0 + 1) * R + x0] * (1 - fx) * fy + h[(y0 + 1) * R + x0 + 1] * fx * fy;
  }

  _slopeAt(x, z) {
    const d = SIZE / RES;
    const dx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const dz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.sqrt(dx * dx + dz * dz) / (2 * d);
  }

  // ---- terrain mesh with per-face low-poly colors ----
  _buildTerrain() {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, RES, RES);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const R = this.R;
    for (let i = 0; i < pos.count; i++) {
      const col = i % R, row = Math.floor(i / R);
      pos.setY(i, this.heights[row * R + col]);
    }

    const flat = geo.toNonIndexed();
    const fpos = flat.attributes.position;
    const colors = new Float32Array(fpos.count * 3);
    const b = this.biome;
    const c = new THREE.Color();
    const triCount = fpos.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const cx = (fpos.getX(i0) + fpos.getX(i0 + 1) + fpos.getX(i0 + 2)) / 3;
      const cy = (fpos.getY(i0) + fpos.getY(i0 + 1) + fpos.getY(i0 + 2)) / 3;
      const cz = (fpos.getZ(i0) + fpos.getZ(i0 + 1) + fpos.getZ(i0 + 2)) / 3;
      const slope = this._slopeAt(cx, cz);
      const m = this.noise.fbm(cx * 0.05 + 40, cz * 0.05 + 40);

      if (this.hasSea && cy < 0.85) {
        // beach / seabed
        c.copy(b.sand).multiplyScalar(cy < -0.5 ? 0.55 : 1);
      } else {
        const tH = THREE.MathUtils.clamp(cy / (this.maxY * 0.92) + (m - 0.5) * 0.25, 0, 1);
        if (tH < 0.5) c.copy(b.low).lerp(b.mid, tH * 2);
        else c.copy(b.mid).lerp(b.high, (tH - 0.5) * 2);
        if (slope > 0.45) c.lerp(b.rock, Math.min((slope - 0.45) * 1.8, 1));
      }
      const jitter = 0.94 + this.noise.value(cx * 3.1, cz * 3.1) * 0.12;
      c.multiplyScalar(jitter);

      for (let k = 0; k < 3; k++) {
        colors[(i0 + k) * 3] = c.r;
        colors[(i0 + k) * 3 + 1] = c.g;
        colors[(i0 + k) * 3 + 2] = c.b;
      }
    }
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    flat.computeBoundingSphere();

    this.terrainUniforms = {
      ...this.sharedUniforms,
      uSnowLine: { value: 999 },
      uSnowAmount: { value: 0 },
      uWetness: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.terrainUniforms,
      vertexShader: /* glsl */`
        varying vec3 vColor;
        varying vec3 vWorldPos;
        varying float vFogDepth;
        attribute vec3 color;
        void main() {
          vColor = color;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        ${LIGHT_PARS}
        ${FOG_PARS}
        uniform float uSnowLine;
        uniform float uSnowAmount;
        uniform float uWetness;
        varying vec3 vColor;
        varying vec3 vWorldPos;
        void main() {
          vec3 fdx = dFdx(vWorldPos);
          vec3 fdy = dFdy(vWorldPos);
          vec3 n = normalize(cross(fdx, fdy));

          vec3 albedo = vColor * (1.0 - uWetness * 0.32);

          float snowMask = smoothstep(uSnowLine, uSnowLine + 2.5, vWorldPos.y)
            * smoothstep(0.3, 0.62, n.y) * uSnowAmount;
          albedo = mix(albedo, vec3(0.93, 0.96, 0.99), clamp(snowMask, 0.0, 1.0));

          float diff = max(dot(n, normalize(uSunDir)), 0.0);
          vec3 light = uSunColor * diff * uLightIntensity
            + uAmbientColor * uAmbientIntensity * (0.55 + 0.45 * n.y)
            + vec3(uFlash * 0.85);

          vec3 outColor = albedo * light;
          ${FOG_APPLY}
          gl_FragColor = vec4(outColor, 1.0);
        }
      `,
    });

    this.terrain = new THREE.Mesh(flat, mat);
    this.group.add(this.terrain);
  }

  // ---- infinite-feeling ground plane out to the horizon ----
  _buildGround() {
    const b = this.biome;
    const color = this.hasSea ? b.sand.clone().multiplyScalar(0.5) : b.mid.clone().multiplyScalar(0.82);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.sharedUniforms, uColor: { value: color } },
      vertexShader: /* glsl */`
        varying vec3 vWorldPos;
        varying float vFogDepth;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        ${LIGHT_PARS}
        ${FOG_PARS}
        uniform vec3 uColor;
        varying vec3 vWorldPos;
        void main() {
          vec3 light = uSunColor * uLightIntensity * 0.55
            + uAmbientColor * uAmbientIntensity + vec3(uFlash * 0.8);
          vec3 outColor = uColor * light;
          ${FOG_APPLY}
          gl_FragColor = vec4(outColor, 1.0);
        }
      `,
    });
    const geo = new THREE.CircleGeometry(GROUND_RADIUS, 48);
    geo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = this.hasSea ? -3.4 : -0.35;
    this.group.add(this.ground);
  }

  // ---- the sea, driven by real wave height ----
  _buildWater() {
    this.waterUniforms = {
      ...this.sharedUniforms,
      uTime: { value: 0 },
      uAmp: { value: 0.25 },
      uFreq: { value: 0.14 },
      uWaveDir: { value: new THREE.Vector2(1, 0.3).normalize() },
      uDeep: { value: new THREE.Color(0x0e3a52) },
      uShallow: { value: new THREE.Color(0x2b7d8f) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      transparent: true,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform float uAmp;
        uniform float uFreq;
        uniform vec2 uWaveDir;
        varying vec3 vWorldPos;
        varying float vFogDepth;
        varying float vCrest;
        void main() {
          vec3 p = position;
          vec2 d1 = uWaveDir;
          vec2 d2 = normalize(vec2(-uWaveDir.y, uWaveDir.x) + uWaveDir * 0.4);
          float ph1 = dot(p.xz, d1) * uFreq + uTime * 0.9;
          float ph2 = dot(p.xz, d2) * uFreq * 1.7 + uTime * 1.3;
          float ph3 = dot(p.xz, d1 + d2) * uFreq * 3.1 + uTime * 2.1;
          float disp = sin(ph1) * 0.6 + sin(ph2) * 0.28 + sin(ph3) * 0.12;
          p.y += disp * uAmp;
          vCrest = disp;
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        ${LIGHT_PARS}
        ${FOG_PARS}
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform float uAmp;
        varying vec3 vWorldPos;
        varying float vCrest;
        void main() {
          vec3 fdx = dFdx(vWorldPos);
          vec3 fdy = dFdy(vWorldPos);
          vec3 n = normalize(cross(fdx, fdy));
          vec3 viewDir = normalize(cameraPosition - vWorldPos);

          float facing = clamp(dot(n, viewDir), 0.0, 1.0);
          vec3 albedo = mix(uDeep, uShallow, pow(1.0 - facing, 1.4) * 0.6 + 0.18);

          // whitecaps grow with real wave height
          float cap = smoothstep(0.72, 0.98, vCrest) * smoothstep(0.35, 1.6, uAmp);
          albedo = mix(albedo, vec3(0.92, 0.96, 0.98), cap * 0.85);

          float diff = max(dot(n, normalize(uSunDir)), 0.0);
          vec3 refl = reflect(-normalize(uSunDir), n);
          float spec = pow(max(dot(refl, viewDir), 0.0), 90.0);

          vec3 light = uSunColor * diff * uLightIntensity
            + uAmbientColor * uAmbientIntensity + vec3(uFlash * 0.8);
          vec3 outColor = albedo * light + uSunColor * spec * uLightIntensity * 0.9;
          ${FOG_APPLY}
          gl_FragColor = vec4(outColor, 0.94);
        }
      `,
    });
    const geo = new THREE.PlaneGeometry(GROUND_RADIUS * 2, GROUND_RADIUS * 2, 140, 140);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = 0;
    this.group.add(this.water);
  }

  // ---- vegetation ----
  _buildTrees() {
    const b = this.biome;
    if (b.treeKind === 'none' || b.treeDensity <= 0) { this.treeParts = []; return; }

    const spots = [];
    const maxTrees = Math.round(240 * b.treeDensity);
    const treeline = this.maxY * 0.78;
    let guard = 0;
    while (spots.length < maxTrees && guard++ < 2600) {
      const x = (this.noise.value(guard * 1.7, 3.3) - 0.5) * SIZE * 0.92;
      const z = (this.noise.value(guard * 2.3, 7.7) - 0.5) * SIZE * 0.92;
      const h = this.heightAt(x, z);
      if (h < 0.9 || h > treeline) continue;
      if (this._slopeAt(x, z) > 0.5) continue;
      if (this.noise.fbm(x * 0.04 + 9, z * 0.04 + 9) < 0.42) continue; // clearings
      let kind = b.treeKind;
      if (kind === 'mixed') kind = this.noise.value(x * 5, z * 5) > 0.5 ? 'conifer' : 'canopy';
      spots.push({ x, z, h, kind, s: 0.75 + this.noise.value(x * 9, z * 9) * 0.8 });
    }

    const conifers = spots.filter(s => s.kind === 'conifer');
    const canopies = spots.filter(s => s.kind === 'canopy');
    const shrubs = spots.filter(s => s.kind === 'shrub');
    this.treeParts = [];
    this.swayShaders = [];

    const swayify = (mat) => {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        shader.uniforms.uWind = { value: 0 };
        shader.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' +
          shader.vertexShader.replace('#include <begin_vertex>', `
            #include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
              float swayAmt = sin(uTime * 1.7 + iPos.x * 0.4 + iPos.z * 0.23) * uWind * 0.09;
              transformed.x += swayAmt * smoothstep(0.0, 2.5, transformed.y + 1.0);
              transformed.z += swayAmt * 0.55 * smoothstep(0.0, 2.5, transformed.y + 1.0);
            #endif
          `);
        this.swayShaders.push(shader);
      };
      return mat;
    };

    const place = (list, geo, mat, yOffFn, scaleFn, colorize) => {
      if (!list.length) return null;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const col = new THREE.Color();
      list.forEach((s, i) => {
        q.setFromAxisAngle(up, this.noise.value(s.x * 3, s.z * 3) * Math.PI * 2);
        const sc = scaleFn(s);
        m.compose(new THREE.Vector3(s.x, s.h + yOffFn(s), s.z), q, sc);
        mesh.setMatrixAt(i, m);
        if (colorize) {
          col.copy(b.leaf).lerp(b.leaf2, this.noise.value(s.x * 7, s.z * 7));
          mesh.setColorAt(i, col);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.treeParts.push(mesh);
      return mesh;
    };

    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1.4, 5);
    trunkGeo.translate(0, 0.7, 0);
    const coneGeo = new THREE.ConeGeometry(1.15, 3.2, 6);
    coneGeo.translate(0, 1.6, 0);
    const ballGeo = new THREE.IcosahedronGeometry(1.25, 0);
    const shrubGeo = new THREE.IcosahedronGeometry(0.6, 0);

    const trunkMat = new THREE.MeshStandardMaterial({ color: b.trunk, flatShading: true, roughness: 1 });
    this.coneMat = swayify(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 }));
    this.ballMat = swayify(new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 }));
    const shrubMat = new THREE.MeshStandardMaterial({ color: b.leaf, flatShading: true, roughness: 1 });

    const treesWithTrunks = conifers.concat(canopies);
    place(treesWithTrunks, trunkGeo, trunkMat, () => -0.1,
      s => new THREE.Vector3(s.s, s.s * (s.kind === 'conifer' ? 0.8 : 1.1), s.s), false);
    place(conifers, coneGeo, this.coneMat, s => s.s * 0.9 - 0.1,
      s => new THREE.Vector3(s.s, s.s, s.s), true);
    place(canopies, ballGeo, this.ballMat, s => s.s * 1.65,
      s => new THREE.Vector3(s.s * 1.15, s.s * 0.95, s.s * 1.15), true);
    place(shrubs, shrubGeo, shrubMat, s => s.s * 0.3,
      s => new THREE.Vector3(s.s, s.s * 0.8, s.s), false);
  }

  _buildRocks() {
    const geo = new THREE.DodecahedronGeometry(0.8, 0);
    const mat = new THREE.MeshStandardMaterial({ color: this.biome.rock, flatShading: true, roughness: 1 });
    const count = 26;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let placed = 0, guard = 0;
    while (placed < count && guard++ < 400) {
      const x = (this.noise.value(guard * 3.7, 13.1) - 0.5) * SIZE * 0.9;
      const z = (this.noise.value(guard * 5.1, 17.9) - 0.5) * SIZE * 0.9;
      const h = this.heightAt(x, z);
      if (h < 0.5) continue;
      const s = 0.4 + this.noise.value(x * 11, z * 11) * 1.6;
      e.set(this.noise.value(x, z) * 0.6, this.noise.value(z, x) * Math.PI, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, h + 0.1, z), q, new THREE.Vector3(s, s * 0.8, s));
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.rocks = mesh;
    this.group.add(mesh);
  }

  // ---- per-frame: real weather drives the uniforms ----
  update(dt, env) {
    const g = env.grade;
    const u = this.sharedUniforms;
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(g.sunColor);
    u.uLightIntensity.value = g.lightIntensity;
    u.uAmbientColor.value.copy(g.ambientColor);
    u.uAmbientIntensity.value = g.ambientIntensity;
    u.uFogColor.value.copy(g.fogColor);
    u.uFogDensity.value = g.fogDensity;
    u.uFlash.value = env.flash;

    // snow cover: cold ground + falling snow whiten the diorama from the peaks down
    const cond = env.cond;
    const coldCover = THREE.MathUtils.clamp((2 - cond.temp) / 8, 0, 1);
    const falling = (g.info.snow || 0) > 0 || cond.snowfall > 0.05 ? 0.35 : 0;
    const target = Math.min(1, coldCover * 0.85 + falling);
    this._snow = this._snow === undefined ? target : this._snow + (target - this._snow) * Math.min(1, dt * 0.6);
    this.terrainUniforms.uSnowAmount.value = THREE.MathUtils.clamp(this._snow * 1.35, 0, 1);
    this.terrainUniforms.uSnowLine.value = this.maxY * (1 - this._snow) * 0.9 - 7 * this._snow;

    const wetTarget = g.info.rain ? Math.min(1, g.info.rain + cond.precip * 0.15) : 0;
    this._wet = this._wet === undefined ? wetTarget : this._wet + (wetTarget - this._wet) * Math.min(1, dt * 0.4);
    this.terrainUniforms.uWetness.value = this._wet;

    if (this.water) {
      const wu = this.waterUniforms;
      wu.uTime.value += dt * (0.7 + Math.min(cond.windSpeed / 60, 1.2));
      const waveH = cond.waveH === null || cond.waveH === undefined ? 0.25 : cond.waveH;
      const targetAmp = THREE.MathUtils.clamp(waveH * 0.62, 0.06, 3.4);
      wu.uAmp.value += (targetAmp - wu.uAmp.value) * Math.min(1, dt * 0.8);
      wu.uFreq.value = THREE.MathUtils.clamp(0.22 - (cond.waveP || 6) * 0.012, 0.06, 0.2);
      wu.uWaveDir.value.set(env.windVec.x, env.windVec.z);
      if (wu.uWaveDir.value.lengthSq() < 0.01) wu.uWaveDir.value.set(1, 0.3);
      wu.uWaveDir.value.normalize();
      // night + storm darken the sea
      wu.uDeep.value.setHex(0x0e3a52).multiplyScalar(0.35 + g.dayness * 0.65);
      wu.uShallow.value.setHex(0x2b7d8f).multiplyScalar(0.35 + g.dayness * 0.65);
    }

    // tree sway follows real wind speed
    const windF = Math.min(cond.windSpeed / 55, 1.6);
    for (const s of this.swayShaders || []) {
      s.uniforms.uTime.value += dt;
      s.uniforms.uWind.value = windF;
    }
    // gentle whitening of crowns under snow
    if (this.coneMat) this.coneMat.emissive = this.coneMat.emissive || new THREE.Color();
    if (this.coneMat) this.coneMat.emissive.setScalar((this._snow || 0) * 0.18);
    if (this.ballMat) this.ballMat.emissive = this.ballMat.emissive || new THREE.Color();
    if (this.ballMat) this.ballMat.emissive.setScalar((this._snow || 0) * 0.18);
  }

  dispose() {
    this.group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
      }
    });
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
