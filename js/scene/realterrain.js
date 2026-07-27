// realterrain.js — the photoreal mode: genuine elevation from terrain tiles, wearing
// genuine satellite imagery, lit and weathered by the same live Open-Meteo numbers that
// drive everything else. Exposes the same surface as Diorama so World can swap them.

import * as THREE from 'three';

const SIZE = 190;             // world units the tile mosaic is mapped onto
const GROUND_RADIUS = 1100;
const EXAGGERATION = 1.8;     // real proportions read very flat across 16 km of ground

export class RealTerrain {
  // data: result of fetchTerrainTiles(); cond used only for the initial snow guess
  constructor(data, { lat, lon } = {}) {
    this.group = new THREE.Group();
    this.biomeName = 'satellite';
    this.data = data;
    this.lat = lat;
    this.lon = lon;

    this.metresToUnits = (SIZE / data.spanMetres) * EXAGGERATION;
    this.hasSea = data.seaFraction > 0.06;
    this.seaLevelY = 0;

    // a whole landscape needs to be viewed from much further out than a diorama
    this.framing = { distance: SIZE * 1.15, pitch: 0.52, maxDistance: SIZE * 2.6 };

    this._buildHeights();
    this._buildMesh();
    this._buildSkirt();
    this._buildGround();
    if (this.hasSea) this._buildWater();
  }

  _buildHeights() {
    const { heights, size } = this.data;
    const scale = this.metresToUnits;
    this.R = size;
    this.heights = new Float32Array(heights.length);
    let maxY = -Infinity;
    let minY = Infinity;
    for (let i = 0; i < heights.length; i++) {
      // clamp bathymetry: below sea level we only need a shallow basin for the water plane
      const h = heights[i] <= 0 ? Math.max(heights[i], -60) * scale * 0.5 : heights[i] * scale;
      this.heights[i] = h;
      if (h > maxY) maxY = h;
      if (h < minY) minY = h;
    }
    this.maxY = Math.max(maxY, 2);
    this.minY = Math.min(minY, 0);
    // the block is cut off a little below its lowest point
    this.baseY = this.minY - Math.max(6, (this.maxY - this.minY) * 0.18);
  }

  // Walls dropping from the tile edge to a base, so the terrain reads as a cut block
  // of the real world rather than a sheet floating in the air.
  _buildSkirt() {
    const R = this.R;
    const at = (row, col) => ({
      x: (col / (R - 1) - 0.5) * SIZE,
      y: this.heights[row * R + col],
      z: (row / (R - 1) - 0.5) * SIZE,
    });

    const border = [];
    for (let c = 0; c < R; c++) border.push(at(0, c));
    for (let r = 1; r < R; r++) border.push(at(r, R - 1));
    for (let c = R - 2; c >= 0; c--) border.push(at(R - 1, c));
    for (let r = R - 2; r >= 1; r--) border.push(at(r, 0));

    const verts = [];
    const base = this.baseY;
    for (let i = 0; i < border.length; i++) {
      const a = border[i];
      const b = border[(i + 1) % border.length];
      // two triangles per segment, wound so the outside faces the camera
      verts.push(a.x, a.y, a.z, b.x, base, b.z, b.x, b.y, b.z);
      verts.push(a.x, a.y, a.z, a.x, base, a.z, b.x, base, b.z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        uTop: { value: new THREE.Color(0x6b6255) },
        uBottom: { value: new THREE.Color(0x241f1b) },
        uTopY: { value: this.maxY },
        uBaseY: { value: base },
        uSunColor: this.uniforms.uSunColor,
        uLightIntensity: this.uniforms.uLightIntensity,
        uAmbientColor: this.uniforms.uAmbientColor,
        uAmbientIntensity: this.uniforms.uAmbientIntensity,
        uFogColor: this.uniforms.uFogColor,
        uFogDensity: this.uniforms.uFogDensity,
        uFlash: this.uniforms.uFlash,
      },
      vertexShader: /* glsl */`
        varying float vY;
        varying float vFogDepth;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vY = wp.y;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uTop;
        uniform vec3 uBottom;
        uniform float uTopY;
        uniform float uBaseY;
        uniform vec3 uSunColor;
        uniform float uLightIntensity;
        uniform vec3 uAmbientColor;
        uniform float uAmbientIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uFlash;
        varying float vY;
        varying float vFogDepth;
        void main() {
          float t = clamp((vY - uBaseY) / max(uTopY - uBaseY, 0.001), 0.0, 1.0);
          // faint strata so the cut face has some depth to it
          float band = 0.94 + 0.06 * sin(vY * 2.4);
          vec3 albedo = mix(uBottom, uTop, pow(t, 0.7)) * band;
          vec3 light = uSunColor * uLightIntensity * 0.42
            + uAmbientColor * uAmbientIntensity * 0.85 + vec3(uFlash * 0.7);
          vec3 outColor = albedo * light;
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          outColor = mix(outColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
          gl_FragColor = vec4(outColor, 1.0);
        }
      `,
    });

    this.skirt = new THREE.Mesh(geo, mat);
    this.group.add(this.skirt);
  }

  heightAt(x, z) {
    const R = this.R;
    const u = THREE.MathUtils.clamp(x / SIZE + 0.5, 0, 1) * (R - 1);
    const v = THREE.MathUtils.clamp(z / SIZE + 0.5, 0, 1) * (R - 1);
    const x0 = Math.min(Math.floor(u), R - 2);
    const y0 = Math.min(Math.floor(v), R - 2);
    const fx = u - x0;
    const fy = v - y0;
    const h = this.heights;
    return h[y0 * R + x0] * (1 - fx) * (1 - fy) + h[y0 * R + x0 + 1] * fx * (1 - fy) +
      h[(y0 + 1) * R + x0] * (1 - fx) * fy + h[(y0 + 1) * R + x0 + 1] * fx * fy;
  }

  _buildMesh() {
    const R = this.R;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, R - 1, R - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heights[i]);
    }
    geo.computeVertexNormals();

    let map = null;
    if (this.data.texture) {
      map = new THREE.CanvasTexture(this.data.texture);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 8;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.map = map;

    this.uniforms = {
      uMap: { value: map },
      uHasMap: { value: map ? 1 : 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uLightIntensity: { value: 1 },
      uAmbientColor: { value: new THREE.Color(0x8899aa) },
      uAmbientIntensity: { value: 0.5 },
      uFogColor: { value: new THREE.Color(0x9ccdf0) },
      uFogDensity: { value: 0.002 },
      uFlash: { value: 0 },
      uSnowLine: { value: 9999 },
      uSnowAmount: { value: 0 },
      uWetness: { value: 0 },
      uSeaLevel: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFogDepth;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uHasMap;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uLightIntensity;
        uniform vec3 uAmbientColor;
        uniform float uAmbientIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uFlash;
        uniform float uSnowLine;
        uniform float uSnowAmount;
        uniform float uWetness;
        uniform float uSeaLevel;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFogDepth;

        void main() {
          vec3 albedo = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : vec3(0.38, 0.42, 0.34);

          // rain darkens and slightly saturates the ground, as wet ground does
          float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
          albedo = mix(albedo, albedo * 0.62 + vec3(lum) * 0.06, uWetness);

          vec3 n = normalize(vNormal);

          // snow settles on high ground and gentle slopes, not on cliffs or the sea
          float above = smoothstep(uSnowLine, uSnowLine + 2.0, vWorldPos.y);
          float flatness = smoothstep(0.35, 0.7, n.y); // 'flat' is a reserved GLSL word
          float land = step(uSeaLevel + 0.05, vWorldPos.y);
          float snow = clamp(above * flatness * land * uSnowAmount, 0.0, 1.0);
          albedo = mix(albedo, vec3(0.94, 0.96, 0.99), snow);

          float diff = max(dot(n, normalize(uSunDir)), 0.0);
          vec3 light = uSunColor * diff * uLightIntensity
            + uAmbientColor * uAmbientIntensity * (0.55 + 0.45 * n.y)
            + vec3(uFlash * 0.85);

          vec3 outColor = albedo * light;
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          outColor = mix(outColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
          gl_FragColor = vec4(outColor, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.group.add(this.mesh);
  }

  _buildGround() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.hasSea ? 0x11364a : 0x2c3428) },
        uSunColor: this.uniforms.uSunColor,
        uLightIntensity: this.uniforms.uLightIntensity,
        uAmbientColor: this.uniforms.uAmbientColor,
        uAmbientIntensity: this.uniforms.uAmbientIntensity,
        uFogColor: this.uniforms.uFogColor,
        uFogDensity: this.uniforms.uFogDensity,
        uFlash: this.uniforms.uFlash,
      },
      vertexShader: /* glsl */`
        varying float vFogDepth;
        void main() {
          vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform vec3 uSunColor;
        uniform float uLightIntensity;
        uniform vec3 uAmbientColor;
        uniform float uAmbientIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uFlash;
        varying float vFogDepth;
        void main() {
          vec3 light = uSunColor * uLightIntensity * 0.5
            + uAmbientColor * uAmbientIntensity + vec3(uFlash * 0.8);
          vec3 outColor = uColor * light;
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          outColor = mix(outColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
          gl_FragColor = vec4(outColor, 1.0);
        }
      `,
    });
    const geo = new THREE.CircleGeometry(GROUND_RADIUS, 48);
    geo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geo, mat);
    // sits at the base of the block so the skirt has something to stand on
    this.ground.position.y = this.baseY - 0.5;
    this.group.add(this.ground);
  }

  _buildWater() {
    this.waterUniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.2 },
      uFreq: { value: 0.16 },
      uWaveDir: { value: new THREE.Vector2(1, 0.3).normalize() },
      uDeep: { value: new THREE.Color(0x0b3145) },
      uShallow: { value: new THREE.Color(0x246d80) },
      uSunDir: this.uniforms.uSunDir,
      uSunColor: this.uniforms.uSunColor,
      uLightIntensity: this.uniforms.uLightIntensity,
      uAmbientColor: this.uniforms.uAmbientColor,
      uAmbientIntensity: this.uniforms.uAmbientIntensity,
      uFogColor: this.uniforms.uFogColor,
      uFogDensity: this.uniforms.uFogDensity,
      uFlash: this.uniforms.uFlash,
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
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform float uAmp;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uLightIntensity;
        uniform vec3 uAmbientColor;
        uniform float uAmbientIntensity;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uFlash;
        varying vec3 vWorldPos;
        varying float vCrest;
        varying float vFogDepth;
        void main() {
          vec3 fdx = dFdx(vWorldPos);
          vec3 fdy = dFdy(vWorldPos);
          vec3 n = normalize(cross(fdx, fdy));
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float facing = clamp(dot(n, viewDir), 0.0, 1.0);
          vec3 albedo = mix(uDeep, uShallow, pow(1.0 - facing, 1.4) * 0.55 + 0.15);
          float cap = smoothstep(0.72, 0.98, vCrest) * smoothstep(0.35, 1.6, uAmp);
          albedo = mix(albedo, vec3(0.92, 0.96, 0.98), cap * 0.8);
          float diff = max(dot(n, normalize(uSunDir)), 0.0);
          vec3 refl = reflect(-normalize(uSunDir), n);
          float spec = pow(max(dot(refl, viewDir), 0.0), 90.0);
          vec3 light = uSunColor * diff * uLightIntensity
            + uAmbientColor * uAmbientIntensity + vec3(uFlash * 0.8);
          vec3 outColor = albedo * light + uSunColor * spec * uLightIntensity * 0.9;
          float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
          outColor = mix(outColor, uFogColor, clamp(fogFactor, 0.0, 1.0));
          gl_FragColor = vec4(outColor, 0.93);
        }
      `,
    });
    const geo = new THREE.PlaneGeometry(GROUND_RADIUS * 2, GROUND_RADIUS * 2, 120, 120);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = this.seaLevelY;
    this.group.add(this.water);
  }

  update(dt, env) {
    const g = env.grade;
    const cond = env.cond;
    const u = this.uniforms;

    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(g.sunColor);
    u.uLightIntensity.value = g.lightIntensity;
    u.uAmbientColor.value.copy(g.ambientColor);
    u.uAmbientIntensity.value = g.ambientIntensity;
    u.uFogColor.value.copy(g.fogColor);
    u.uFogDensity.value = g.fogDensity;
    u.uFlash.value = env.flash;

    // real snow line: freezing level converted to world units, so snow sits where
    // the air is actually below zero rather than at an arbitrary height
    const lapse = 6.5 / 1000;                       // °C per metre
    const freezingMetres = cond.temp / lapse;       // height where temp hits 0 °C
    const falling = (g.info.snow || 0) > 0 || cond.snowfall > 0.05;
    const targetSnow = Math.min(1, Math.max(0, (2 - cond.temp) / 8) * 0.9 + (falling ? 0.35 : 0));
    this._snow = this._snow === undefined ? targetSnow : this._snow + (targetSnow - this._snow) * Math.min(1, dt * 0.6);
    u.uSnowAmount.value = THREE.MathUtils.clamp(this._snow * 1.3, 0, 1);
    u.uSnowLine.value = THREE.MathUtils.clamp(
      freezingMetres * this.metresToUnits, -20, this.maxY * 1.2,
    );

    const wetTarget = g.info.rain ? Math.min(1, g.info.rain + cond.precip * 0.15) : 0;
    this._wet = this._wet === undefined ? wetTarget : this._wet + (wetTarget - this._wet) * Math.min(1, dt * 0.4);
    u.uWetness.value = this._wet;

    if (this.water) {
      const wu = this.waterUniforms;
      wu.uTime.value += dt * (0.7 + Math.min(cond.windSpeed / 60, 1.2));
      const waveH = cond.waveH === null || cond.waveH === undefined ? 0.3 : cond.waveH;
      const targetAmp = THREE.MathUtils.clamp(waveH * 0.4, 0.05, 2.6);
      wu.uAmp.value += (targetAmp - wu.uAmp.value) * Math.min(1, dt * 0.8);
      wu.uWaveDir.value.set(env.windVec.x, env.windVec.z);
      if (wu.uWaveDir.value.lengthSq() < 0.01) wu.uWaveDir.value.set(1, 0.3);
      wu.uWaveDir.value.normalize();
      wu.uDeep.value.setHex(0x0b3145).multiplyScalar(0.32 + g.dayness * 0.68);
      wu.uShallow.value.setHex(0x246d80).multiplyScalar(0.32 + g.dayness * 0.68);
    }
  }

  dispose() {
    this.group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
      }
    });
    if (this.map) this.map.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
