// post.js — the frame's last mile: bloom and a weather-driven color grade.
//
// The scene renders into an offscreen buffer that holds exactly what the screen
// would have shown (standard materials still get ACES + sRGB; the custom shaders
// already write display values). Bloom and grading then work in that display space,
// so turning post off never changes the base look — it only adds on top.
//
// Every grading decision is read from the same env the world is lit by: real sun
// colour, cloud cover, storm, snow, temperature, lightning. Mood, not invented weather.

import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// soft-knee threshold + 4-tap box down to half resolution
const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 0.5, -0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2(-0.5,  0.5)).rgb
           + texture2D(tSrc, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
    c *= 0.25;
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, br - uThreshold) / max(br, 1e-4);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

// dual-filter (Kawase) down / up — cheap, wide, stable on mobile GPUs
const DOWN_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
  }
`;

const UP_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 s = vec3(0.0);
    s += texture2D(tSrc, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb * 2.0;
    s += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb * 2.0;
    gl_FragColor = vec4(s / 12.0, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform vec3 uTint;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uSepia;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    c += texture2D(tBloom, vUv).rgb * uBloom;

    c *= uTint;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSaturation);
    c = (c - 0.5) * uContrast + 0.5;
    c = mix(c, vec3(l) * vec3(1.08, 0.97, 0.80), uSepia);

    // highlights roll off instead of clipping hard where bloom stacks up
    c = mix(c, 1.0 - exp(-c * 1.6) * 0.82, smoothstep(0.8, 1.6, max(c.r, max(c.g, c.b))));

    float n = hash(gl_FragCoord.xy + fract(uTime) * 917.0);
    c += (n - 0.5) * uGrain;
    c += (n - 0.5) / 255.0; // dither: kills banding in long sky gradients

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`;

const LEVELS = { high: 5, medium: 4 };
const SAMPLES = { high: 4, medium: 2 };

function makeMat(frag, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: QUAD_VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...extra,
  });
}

// Can this device render to half-float buffers? Without it post is off.
export function postSupported(renderer) {
  const caps = renderer.capabilities;
  if (!caps.isWebGL2) return false;
  return renderer.extensions.has('EXT_color_buffer_float')
    || renderer.extensions.has('EXT_color_buffer_half_float');
}

export class PostFX {
  constructor(renderer, quality = 'high') {
    this.renderer = renderer;
    this.quality = quality;
    this.width = 1;
    this.height = 1;

    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    this.brightMat = makeMat(BRIGHT_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0.82 }, uKnee: { value: 0.22 },
    });
    this.downMat = makeMat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = makeMat(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      { blending: THREE.AdditiveBlending, transparent: true });
    this.compositeMat = makeMat(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null },
      uBloom: { value: 0.4 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uSaturation: { value: 1 },
      uContrast: { value: 1 },
      uSepia: { value: 0 },
      uGrain: { value: 0 },
      uTime: { value: 0 },
    });

    // smoothed grade, eased toward per-frame targets so scrubbing never pops
    this.g = { bloom: 0.4, sat: 1, contrast: 1, sepia: 0, grain: 0, tint: new THREE.Vector3(1, 1, 1) };
    this._tint = new THREE.Vector3();
    this._sun = new THREE.Color();

    this.sceneRT = null;
    this.bloomRTs = [];
  }

  _build() {
    this._disposeTargets();
    const w = this.width, h = this.height;

    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: SAMPLES[this.quality] || 0,
      depthBuffer: true,
    });
    // Make three treat this target like the screen: standard materials keep their
    // ACES tone mapping and sRGB encode, so the buffer matches the direct render.
    // (Half-float storage means no hardware sRGB conversion is involved.)
    this.sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.sceneRT.isXRRenderTarget = true;

    const levels = LEVELS[this.quality] || 4;
    let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    for (let i = 0; i < levels; i++) {
      this.bloomRTs.push(new THREE.WebGLRenderTarget(bw, bh, {
        type: THREE.HalfFloatType, depthBuffer: false,
      }));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._build();
  }

  setQuality(q) {
    if (q === this.quality && this.sceneRT) return;
    this.quality = q;
    this._build();
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  // env: the world env for this frame (grade, cond, sunDir, flash, era)
  _updateGrade(dt, env) {
    const g = this.g;
    let bloom = 0.42, sat = 1.04, contrast = 1.03, sepia = 0, grain = 0;
    const tint = this._tint.set(1, 1, 1);

    if (env) {
      const gr = env.grade;
      const info = gr.info;
      const day = gr.dayness;
      const cloudF = Math.min(1, (env.cond.cloud || 0) / 100);
      const stormF = info.thunder ? 1 : (info.rain || 0) * 0.6;
      const snowF = info.snow || 0;
      const fogF = info.fog ? 1 : 0;
      const sunAlt = env.sunDir.y;

      // white balance follows the real sun colour, strongest at golden hour
      const golden = day * (1 - THREE.MathUtils.smoothstep(sunAlt, 0.08, 0.35)) * (1 - cloudF * 0.7);
      const sun = this._sun.copy(gr.sunColor);
      const m = Math.max(sun.r, sun.g, sun.b, 1e-3);
      const wb = 0.06 + golden * 0.12;
      tint.set(
        1 + (sun.r / m - 1) * wb,
        1 + (sun.g / m - 1) * wb,
        1 + (sun.b / m - 1) * wb,
      );
      // blue-shifted night vision; cool cast in snow
      const night = 1 - day;
      tint.x *= 1 - night * 0.06 - snowF * 0.03;
      tint.z *= 1 + night * 0.07 + snowF * 0.04;

      sat = 1.04 + golden * 0.12 - cloudF * 0.08 - stormF * 0.18 - snowF * 0.08 - fogF * 0.12 - night * 0.12;
      contrast = 1.03 + stormF * 0.05 - fogF * 0.08 - snowF * 0.03;

      // bloom: lightning and the low sun earn the glow; flat overcast doesn't
      bloom = 0.32 + golden * 0.25 + night * 0.15 - cloudF * 0.1 - snowF * 0.22 + (env.flash || 0) * 1.4;

      // expeditions into the archive read as old film, more so the further back
      if (env.era) {
        const age = THREE.MathUtils.clamp((2005 - env.era) / 65, 0, 1);
        sepia = 0.08 + age * 0.3;
        grain = 0.025 + age * 0.045;
        sat *= 1 - age * 0.2;
      }
    }

    const k = Math.min(1, dt * 2.5);
    g.bloom += (bloom - g.bloom) * Math.min(1, dt * 12); // fast: lightning must punch
    g.sat += (sat - g.sat) * k;
    g.contrast += (contrast - g.contrast) * k;
    g.sepia += (sepia - g.sepia) * k;
    g.grain += (grain - g.grain) * k;
    g.tint.lerp(tint, k);

    const u = this.compositeMat.uniforms;
    u.uBloom.value = Math.max(0, g.bloom);
    u.uSaturation.value = g.sat;
    u.uContrast.value = g.contrast;
    u.uSepia.value = g.sepia;
    u.uGrain.value = g.grain;
    u.uTint.value.copy(g.tint);
    u.uTime.value += dt;
  }

  render(scene, camera, env, dt) {
    if (!this.sceneRT) this._build();
    const r = this.renderer;
    const prevAutoClear = r.autoClear;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    r.autoClear = false;

    // bright pass → mip chain down → additive tent back up
    const rts = this.bloomRTs;
    this.brightMat.uniforms.tSrc.value = this.sceneRT.texture;
    this.brightMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this._pass(this.brightMat, rts[0]);

    for (let i = 1; i < rts.length; i++) {
      this.downMat.uniforms.tSrc.value = rts[i - 1].texture;
      this.downMat.uniforms.uTexel.value.set(1 / rts[i - 1].width, 1 / rts[i - 1].height);
      this._pass(this.downMat, rts[i]);
    }
    for (let i = rts.length - 1; i > 0; i--) {
      this.upMat.uniforms.tSrc.value = rts[i].texture;
      this.upMat.uniforms.uTexel.value.set(0.5 / rts[i].width, 0.5 / rts[i].height);
      this._pass(this.upMat, rts[i - 1]);
    }

    this._updateGrade(dt, env);
    const cu = this.compositeMat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tBloom.value = rts[0].texture;
    this._pass(this.compositeMat, null);

    r.autoClear = prevAutoClear;
  }

  _disposeTargets() {
    if (this.sceneRT) this.sceneRT.dispose();
    for (const rt of this.bloomRTs) rt.dispose();
    this.sceneRT = null;
    this.bloomRTs = [];
  }

  dispose() {
    this._disposeTargets();
    this.quad.geometry.dispose();
    for (const m of [this.brightMat, this.downMat, this.upMat, this.compositeMat]) m.dispose();
  }
}
