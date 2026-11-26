// ==UserScript==
// @name         Safari Mobile WebGPU 超解析度引擎 (SSimSuperRes / Anime4K / FSR1 + EDR HDR)
// @namespace    https://local.webgpu.sr
// @version      3.3.2
// @description  純 WebGPU 影片超分 (SSimSuperRes / Anime4K / FSR1 + SDR→HDR / 選用真 EDR)，支援長按拖曳視窗位置與標準 SDR 8-bit 錄影不變暗
// @author       Antigravity
// @homepageURL  https://github.com/joey971018yt/safari-webgpu-superres
// @downloadURL  https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js
// @updateURL    https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self && (window.innerWidth < 300 || window.innerHeight < 200)) {
    return;
  }
  if (window.__WEBGPU_SR_ENGINE_LOADED__) return;
  window.__WEBGPU_SR_ENGINE_LOADED__ = true;

  console.log('[WebGPU-SR] 腳本已啟動 v3.3.2');

  // ============================================================================
  // 1. 預設設定與全域狀態
  // ============================================================================
  const PRESETS = {
    1: { label: '1 檔 (自然)', deblur: 0.5, sharpness: 0.55 },
    2: { label: '2 檔 (均衡)', deblur: 0.85, sharpness: 0.85 },
    3: { label: '3 檔 (極致)', deblur: 1.25, sharpness: 1.2 },
  };

  const CONFIG = {
    enabled: false,
    engineMode: 'ssim', // 'ssim' | 'anime4k' | 'fsr1'
    presetLevel: 2,
    deblur: 0.85,
    sharpness: 0.85,
    denoise: true,
    sdrToHdrLevel: 0,
    enableEdr: false, // 預設關閉真 EDR，確保 iOS 螢幕錄影 SDR 影片完全不變暗
    compareMode: false,
    compareSplit: 0.5,
    maxOutputWidth: 3840,
    maxOutputHeight: 2160,
  };

  const STATE = {
    gpuSupported: typeof navigator !== 'undefined' && !!navigator.gpu,
    device: null,
    activeVideo: null,
    engine: null,
    edrSupported: false,
    corsFallback: false,
    corsRetrying: false,
    pseudoFullscreen: false,
    stats: {
      fps: 0,
      resolution: '-',
      hdrBackend: '-',
      status: '待機中',
      error: '',
    },
  };

  // ============================================================================
  // 2. WGSL 著色器
  //    Pass 0 (可選): 邊緣保持雙邊去噪 (消除 YouTube H.264/VP9 壓縮蚊式噪點) -> texClean
  //    Pass 1: 縮放核心 (EWA LanczosSharp 或 AMD FSR 1.0 EASU；降頻改走 4-tap 超採樣) -> texScaled
  //    Pass 2 (SSimSuperRes 專用): 將 texScaled 回降至原解析度 -> texLow (模擬模糊基準)
  //    Pass 3: 結構重建 (SSimSuperRes 變異數反演 / Anime4K 梯度邊緣收細 / 2px 去模糊)
  //            + 1px AMD CAS + Apple 真 EDR / 模擬 HDR -> Canvas
  // ============================================================================

  const FULLSCREEN_VS_WGSL = /* wgsl */ `
    struct VSOut {
      @builtin(position) pos: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @vertex
    fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
      var out: VSOut;
      let x = f32((vid << 1u) & 2u);
      let y = f32(vid & 2u);
      out.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
      out.uv = vec2<f32>(x, y);
      return out;
    }
  `;

  // Pass 0: 輕量級邊緣保持雙邊濾波 (只抹平 <0.04 的串流壓縮噪點，完整保留真實銳利邊緣)
  const DENOISE_FS_WGSL = /* wgsl */ `
    @group(0) @binding(0) var texRaw: texture_2d<f32>;

    fn loadRaw(c: vec2<i32>, maxC: vec2<i32>) -> vec3<f32> {
      return textureLoad(texRaw, clamp(c, vec2<i32>(0, 0), maxC), 0).rgb;
    }

    @fragment
    fn fs_main(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
      let dims = vec2<i32>(textureDimensions(texRaw));
      let maxC = max(dims - vec2<i32>(1, 1), vec2<i32>(0, 0));
      let px = vec2<i32>(floor(fragPos.xy));

      let center = loadRaw(px, maxC);
      var accum = center * 1.0;
      var wSum = 1.0;

      // 緊湊 3x3 雙邊核 (sigmaRange=0.024 只濾除極細微蚊式壓縮噪點，絕不糊化動漫細髮絲與淡色陰影)
      let invRange2 = 1.0 / (0.024 * 0.024);
      for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
        for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
          if (dx == 0 && dy == 0) { continue; }
          let s = loadRaw(px + vec2<i32>(dx, dy), maxC);
          let diff = s - center;
          let d2 = dot(diff, diff);
          let wSpatial = select(0.55, 0.75, (dx == 0 || dy == 0));
          let wRange = exp(-d2 * invRange2);
          let w = wSpatial * wRange;
          accum = accum + s * w;
          wSum = wSum + w;
        }
      }
      return vec4<f32>(accum / wSum, 1.0);
    }
  `;

  // Pass 1A: libplacebo EWA LanczosSharp (供 SSimSuperRes 與 Anime4K 使用，對角線零鋸齒)
  const EWA_LANCZOS_FS_WGSL = /* wgsl */ `
    struct ScaleUniforms {
      srcSize: vec2<f32>,
      dstSize: vec2<f32>,
      isDownscale: f32,
      _pad0: f32,
      _pad1: f32,
      _pad2: f32,
    };

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var texSrc: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> u: ScaleUniforms;

    fn loadPx(c: vec2<i32>, maxC: vec2<i32>) -> vec3<f32> {
      return textureLoad(texSrc, clamp(c, vec2<i32>(0, 0), maxC), 0).rgb;
    }

    fn jinc(r: f32) -> f32 {
      if (r < 1e-4) { return 1.0; }
      let x = 3.14159265 * r;
      let y = x * x;
      let num = 0.5 + y * (-0.054551672 + y * (0.0016748786 + y * (-2.0535558e-5 + y * (1.085124e-7 + y * (-2.084e-10)))));
      let den = 1.0 + y * (0.015895884 + y * (0.00012840406 + y * (6.871485e-7 + y * (2.60493e-9 + y * 6.9096e-12))));
      return 2.0 * (num / den);
    }

    fn ewaWeight(dist: f32) -> f32 {
      let rb = dist / 0.98125056;
      if (rb >= 2.2331306) { return 0.0; }
      return jinc(rb) * jinc(rb * 0.5461704);
    }

    @fragment
    fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      if (u.isDownscale > 0.5) {
        let hp = 0.25 / max(u.dstSize, vec2<f32>(1.0));
        let s0 = textureSampleLevel(texSrc, samp, uv + vec2<f32>(-hp.x, -hp.y), 0.0).rgb;
        let s1 = textureSampleLevel(texSrc, samp, uv + vec2<f32>( hp.x, -hp.y), 0.0).rgb;
        let s2 = textureSampleLevel(texSrc, samp, uv + vec2<f32>(-hp.x,  hp.y), 0.0).rgb;
        let s3 = textureSampleLevel(texSrc, samp, uv + vec2<f32>( hp.x,  hp.y), 0.0).rgb;
        return vec4<f32>((s0 + s1 + s2 + s3) * 0.25, 1.0);
      }

      let dims = vec2<i32>(textureDimensions(texSrc));
      let maxC = max(dims - vec2<i32>(1, 1), vec2<i32>(0, 0));

      let pp = uv * vec2<f32>(dims) - vec2<f32>(0.5, 0.5);
      let fp = floor(pp);
      let f = pp - fp;
      let base = vec2<i32>(fp);

      var accum = vec3<f32>(0.0);
      var wSum = 0.0;
      var min4 = vec3<f32>(1e9);
      var max4 = vec3<f32>(-1e9);

      for (var j: i32 = -1; j <= 2; j = j + 1) {
        for (var i: i32 = -1; i <= 2; i = i + 1) {
          let c = loadPx(base + vec2<i32>(i, j), maxC);
          if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
            min4 = min(min4, c);
            max4 = max(max4, c);
          }
          let d = vec2<f32>(f32(i) - f.x, f32(j) - f.y);
          let w = ewaWeight(length(d));
          accum = accum + c * w;
          wSum = wSum + w;
        }
      }

      let raw = accum / max(wSum, 1e-5);
      let span = max4 - min4;
      let outRgb = clamp(raw, min4 - span * 0.08, max4 + span * 0.08);
      return vec4<f32>(clamp(outRgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
    }
  `;

  // Pass 1B: 官方 AMD FSR 1.0 EASU (保留作為對照選項)
  const FSR_EASU_FS_WGSL = /* wgsl */ `
    struct ScaleUniforms {
      srcSize: vec2<f32>,
      dstSize: vec2<f32>,
      isDownscale: f32,
      _pad0: f32,
      _pad1: f32,
      _pad2: f32,
    };

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var texSrc: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> u: ScaleUniforms;

    fn loadPx(c: vec2<i32>, maxC: vec2<i32>) -> vec3<f32> {
      return textureLoad(texSrc, clamp(c, vec2<i32>(0, 0), maxC), 0).rgb;
    }

    fn fsrLuma(c: vec3<f32>) -> f32 {
      return 0.25 * c.r + 0.5 * c.g + 0.25 * c.b;
    }

    struct EdgeAcc { dir: vec2<f32>, len: f32 };

    fn fsrEasuSet(acc: EdgeAcc, w: f32, lC: f32, lU: f32, lL: f32, lR: f32, lD: f32) -> EdgeAcc {
      var out = acc;
      let dcX = lR - lL;
      let lenX = max(abs(lR - lC), abs(lC - lL));
      let normX = clamp(abs(dcX) / max(lenX, 1e-5), 0.0, 1.0);
      out.dir.x = out.dir.x + dcX * w;
      out.len = out.len + (normX * normX) * w;

      let dcY = lD - lU;
      let lenY = max(abs(lD - lC), abs(lC - lU));
      let normY = clamp(abs(dcY) / max(lenY, 1e-5), 0.0, 1.0);
      out.dir.y = out.dir.y + dcY * w;
      out.len = out.len + (normY * normY) * w;
      return out;
    }

    fn fsrTapWeight(d: vec2<f32>, dir: vec2<f32>, len2: vec2<f32>, lob: f32, clp: f32) -> f32 {
      let vX = (d.x * dir.x + d.y * dir.y) * len2.x;
      let vY = (d.x * (-dir.y) + d.y * dir.x) * len2.y;
      let d2 = min(vX * vX + vY * vY, clp);
      let wB0 = (2.0 / 5.0) * d2 - 1.0;
      let wA0 = lob * d2 - 1.0;
      let wB = (25.0 / 16.0) * (wB0 * wB0) - (9.0 / 16.0);
      let wA = wA0 * wA0;
      return wB * wA;
    }

    @fragment
    fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      if (u.isDownscale > 0.5) {
        let hp = 0.25 / max(u.dstSize, vec2<f32>(1.0));
        let s0 = textureSampleLevel(texSrc, samp, uv + vec2<f32>(-hp.x, -hp.y), 0.0).rgb;
        let s1 = textureSampleLevel(texSrc, samp, uv + vec2<f32>( hp.x, -hp.y), 0.0).rgb;
        let s2 = textureSampleLevel(texSrc, samp, uv + vec2<f32>(-hp.x,  hp.y), 0.0).rgb;
        let s3 = textureSampleLevel(texSrc, samp, uv + vec2<f32>( hp.x,  hp.y), 0.0).rgb;
        return vec4<f32>((s0 + s1 + s2 + s3) * 0.25, 1.0);
      }

      let dims = vec2<i32>(textureDimensions(texSrc));
      let maxC = max(dims - vec2<i32>(1, 1), vec2<i32>(0, 0));

      let pp = uv * vec2<f32>(dims) - vec2<f32>(0.5, 0.5);
      let fp = floor(pp);
      let f = pp - fp;
      let base = vec2<i32>(fp);

      let b  = loadPx(base + vec2<i32>( 0, -1), maxC);
      let c  = loadPx(base + vec2<i32>( 1, -1), maxC);
      let e  = loadPx(base + vec2<i32>(-1,  0), maxC);
      let f0 = loadPx(base + vec2<i32>( 0,  0), maxC);
      let g  = loadPx(base + vec2<i32>( 1,  0), maxC);
      let h  = loadPx(base + vec2<i32>( 2,  0), maxC);
      let i  = loadPx(base + vec2<i32>(-1,  1), maxC);
      let j  = loadPx(base + vec2<i32>( 0,  1), maxC);
      let k  = loadPx(base + vec2<i32>( 1,  1), maxC);
      let l  = loadPx(base + vec2<i32>( 2,  1), maxC);
      let n  = loadPx(base + vec2<i32>( 0,  2), maxC);
      let o  = loadPx(base + vec2<i32>( 1,  2), maxC);

      let lb = fsrLuma(b);  let lc = fsrLuma(c);
      let le = fsrLuma(e);  let lf = fsrLuma(f0); let lg = fsrLuma(g); let lh = fsrLuma(h);
      let li = fsrLuma(i);  let lj = fsrLuma(j);  let lk = fsrLuma(k); let ll = fsrLuma(l);
      let ln = fsrLuma(n);  let lo = fsrLuma(o);

      var acc = EdgeAcc(vec2<f32>(0.0, 0.0), 0.0);
      acc = fsrEasuSet(acc, (1.0 - f.x) * (1.0 - f.y), lf, lb, le, lg, lj);
      acc = fsrEasuSet(acc, f.x * (1.0 - f.y),         lg, lc, lf, lh, lk);
      acc = fsrEasuSet(acc, (1.0 - f.x) * f.y,         lj, lf, li, lk, ln);
      acc = fsrEasuSet(acc, f.x * f.y,                 lk, lg, lj, ll, lo);

      let dirR = acc.dir.x * acc.dir.x + acc.dir.y * acc.dir.y;
      let dir = select(acc.dir * inverseSqrt(max(dirR, 1e-8)), vec2<f32>(1.0, 0.0), dirR < 1e-8);

      var edgeLen = acc.len * 0.5;
      edgeLen = edgeLen * edgeLen;

      let stretch = 1.0 / max(abs(dir.x), abs(dir.y));
      let len2 = vec2<f32>(1.0 + (stretch - 1.0) * edgeLen, 1.0 - 0.5 * edgeLen);
      let lob = 0.5 + ((0.25 - 0.04) - 0.5) * edgeLen;
      let clp = 1.0 / lob;

      var offsets = array<vec2<f32>, 12>(
        vec2<f32>( 0.0, -1.0), vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  0.0), vec2<f32>( 0.0,  0.0), vec2<f32>( 1.0,  0.0), vec2<f32>( 2.0,  0.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 0.0,  1.0), vec2<f32>( 1.0,  1.0), vec2<f32>( 2.0,  1.0),
        vec2<f32>( 0.0,  2.0), vec2<f32>( 1.0,  2.0)
      );
      var colors = array<vec3<f32>, 12>(b, c, e, f0, g, h, i, j, k, l, n, o);

      var aC = vec3<f32>(0.0);
      var aW = 0.0;
      for (var idx: u32 = 0u; idx < 12u; idx = idx + 1u) {
        let w = fsrTapWeight(offsets[idx] - f, dir, len2, lob, clp);
        aC = aC + colors[idx] * w;
        aW = aW + w;
      }

      let min4 = min(min(f0, g), min(j, k));
      let max4 = max(max(f0, g), max(j, k));
      let outRgb = clamp(aC / max(aW, 1e-5), min4, max4);

      return vec4<f32>(clamp(outRgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
    }
  `;

  // Pass 2 (SSimSuperRes 專用): 將升頻結果 texScaled 模擬回降至原影片解析度 texLow
  // 用於在 Pass 3 比對原畫(H)與回降圖(L)的局部 SSIM 均值與變異數差異，精準還原遺失結構
  const SSIM_DOWN_FS_WGSL = /* wgsl */ `
    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var texScaled: texture_2d<f32>;

    @fragment
    fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let scaledDims = vec2<f32>(textureDimensions(texScaled));
      let hp = 0.5 / max(scaledDims, vec2<f32>(1.0));
      let c0 = textureSampleLevel(texScaled, samp, uv + vec2<f32>(-hp.x, -hp.y), 0.0).rgb;
      let c1 = textureSampleLevel(texScaled, samp, uv + vec2<f32>( hp.x, -hp.y), 0.0).rgb;
      let c2 = textureSampleLevel(texScaled, samp, uv + vec2<f32>(-hp.x,  hp.y), 0.0).rgb;
      let c3 = textureSampleLevel(texScaled, samp, uv + vec2<f32>( hp.x,  hp.y), 0.0).rgb;
      return vec4<f32>((c0 + c1 + c2 + c3) * 0.25, 1.0);
    }
  `;

  // Pass 3: 最終超分結構重建 + 1px AMD CAS + Apple 真 EDR / 模擬 HDR
  // mode: 0 = SSimSuperRes (結構相似度超分), 1 = Anime4K 梯度邊緣收細, 2 = FSR 1.0 + 多尺度去模糊
  const SR_FINAL_FS_WGSL = /* wgsl */ `
    struct FinalUniforms {
      dstSize: vec2<f32>,
      deblur: f32,
      sharpness: f32,
      sdrToHdrLevel: f32,
      isEdrCanvas: f32,
      shaderCompare: f32,
      srMode: f32, // 0: SSimSuperRes, 1: Anime4K, 2: FSR1
    };

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var texScaled: texture_2d<f32>;
    @group(0) @binding(2) var texOrig: texture_2d<f32>;
    @group(0) @binding(3) var texLow: texture_2d<f32>;
    @group(0) @binding(4) var<uniform> u: FinalUniforms;

    fn loadScaled(px: vec2<i32>, maxPx: vec2<i32>) -> vec3<f32> {
      return textureLoad(texScaled, clamp(px, vec2<i32>(0, 0), maxPx), 0).rgb;
    }

    fn luma(c: vec3<f32>) -> f32 {
      return dot(c, vec3<f32>(0.299, 0.587, 0.114));
    }

    fn sobelGradMag(px: vec2<i32>, maxPx: vec2<i32>) -> f32 {
      let tl = luma(loadScaled(px + vec2<i32>(-1, -1), maxPx));
      let tc = luma(loadScaled(px + vec2<i32>( 0, -1), maxPx));
      let tr = luma(loadScaled(px + vec2<i32>( 1, -1), maxPx));
      let ml = luma(loadScaled(px + vec2<i32>(-1,  0), maxPx));
      let mr = luma(loadScaled(px + vec2<i32>( 1,  0), maxPx));
      let bl = luma(loadScaled(px + vec2<i32>(-1,  1), maxPx));
      let bc = luma(loadScaled(px + vec2<i32>( 0,  1), maxPx));
      let br = luma(loadScaled(px + vec2<i32>( 1,  1), maxPx));
      let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
      return length(vec2<f32>(gx, gy));
    }

    // 電影級 SDR → HDR 逆色調映射 (支援 Apple 真 EDR 16F 與 SDR 模擬高動態)
    fn applySdrToHdr(rgb: vec3<f32>, localBlurY: f32, level: f32, isEdr: f32) -> vec3<f32> {
      if (level < 0.5) { return rgb; }
      let s = select(1.0, 0.6, level < 1.5);

      let lin = pow(max(rgb, vec3<f32>(1e-6)), vec3<f32>(2.2));
      let y = max(dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-5);

      let gamma = 1.0 + 0.22 * s;
      let contrastedY = pow(y, gamma);

      let blurLin = pow(max(localBlurY, 1e-6), 2.2);
      let localBoost = 1.0 + clamp((y - blurLin) * 1.4, -0.18, 0.25) * s;

      var targetY = contrastedY * localBoost;

      if (isEdr > 0.5) {
        let hlMask = smoothstep(0.24, 0.96, y);
        let edrPeak = 1.0 + s * 1.35 * hlMask * hlMask;
        targetY = targetY * (1.0 + 0.16 * s) * edrPeak;
      } else {
        let hlLift = 1.0 + 0.48 * s * smoothstep(0.10, 0.88, y);
        let lifted = targetY * hlLift;
        targetY = lifted / (1.0 + 0.28 * s * max(lifted - 0.50, 0.0));
      }

      var outLin = lin * (max(targetY, 1e-6) / y);

      let maxC = max(outLin.r, max(outLin.g, outLin.b));
      let minC = min(outLin.r, min(outLin.g, outLin.b));
      let sat = (maxC - minC) / max(maxC, 1e-4);

      let warmBias = clamp((rgb.r - rgb.b) * 2.0, 0.0, 1.0) * clamp((rgb.r - rgb.g) * 3.0, 0.0, 1.0);
      let skinProtect = 1.0 - 0.65 * warmBias * smoothstep(0.15, 0.75, rgb.r);

      let vibStrength = mix(0.32, 0.52, step(1.5, level)) * skinProtect;
      let vibGain = 1.0 + vibStrength * (1.0 - sat * 0.75);
      let outY = vec3<f32>(dot(outLin, vec3<f32>(0.2126, 0.7152, 0.0722)));
      outLin = mix(outY, outLin, vibGain);

      let maxOut = select(1.0, 2.2, isEdr > 0.5);
      let outGamma = pow(max(outLin, vec3<f32>(1e-6)), vec3<f32>(1.0 / 2.2));
      return clamp(outGamma, vec3<f32>(0.0), vec3<f32>(maxOut));
    }

    @fragment
    fn fs_main(@builtin(position) fragPos: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      if (u.shaderCompare > 0.001) {
        let lineHalf = 1.5 / max(u.dstSize.x, 1.0);
        if (abs(uv.x - u.shaderCompare) < lineHalf) {
          return vec4<f32>(0.45, 0.68, 1.0, 1.0);
        }
        if (uv.x < u.shaderCompare) {
          let hp = 0.25 / max(u.dstSize, vec2<f32>(1.0));
          let o0 = textureSampleLevel(texOrig, samp, uv + vec2<f32>(-hp.x, -hp.y), 0.0).rgb;
          let o1 = textureSampleLevel(texOrig, samp, uv + vec2<f32>( hp.x, -hp.y), 0.0).rgb;
          let o2 = textureSampleLevel(texOrig, samp, uv + vec2<f32>(-hp.x,  hp.y), 0.0).rgb;
          let o3 = textureSampleLevel(texOrig, samp, uv + vec2<f32>( hp.x,  hp.y), 0.0).rgb;
          return vec4<f32>((o0 + o1 + o2 + o3) * 0.25, 1.0);
        }
      }

      let dims = vec2<i32>(textureDimensions(texScaled));
      let maxPx = max(dims - vec2<i32>(1, 1), vec2<i32>(0, 0));
      let px = vec2<i32>(floor(fragPos.xy));

      let a = loadScaled(px + vec2<i32>(-1, -1), maxPx);
      let b = loadScaled(px + vec2<i32>( 0, -1), maxPx);
      let c = loadScaled(px + vec2<i32>( 1, -1), maxPx);
      let d = loadScaled(px + vec2<i32>(-1,  0), maxPx);
      let e = loadScaled(px, maxPx);
      let f = loadScaled(px + vec2<i32>( 1,  0), maxPx);
      let g = loadScaled(px + vec2<i32>(-1,  1), maxPx);
      let h = loadScaled(px + vec2<i32>( 0,  1), maxPx);
      let i = loadScaled(px + vec2<i32>( 1,  1), maxPx);

      let n2 = loadScaled(px + vec2<i32>( 0, -2), maxPx);
      let s2 = loadScaled(px + vec2<i32>( 0,  2), maxPx);
      let w2 = loadScaled(px + vec2<i32>(-2,  0), maxPx);
      let e2 = loadScaled(px + vec2<i32>( 2,  0), maxPx);

      let la = luma(a); let lb = luma(b); let lc = luma(c);
      let ld = luma(d); let le = luma(e); let lf = luma(f);
      let lg = luma(g); let lh = luma(h); let li = luma(i);

      let minL3 = min(min(min(la, lb), min(lc, ld)), min(le, min(min(lf, lg), min(lh, li))));
      let maxL3 = max(max(max(la, lb), max(lc, ld)), max(le, max(max(lf, lg), max(lh, li))));
      let contrast3 = maxL3 - minL3;
      let noiseGate = smoothstep(0.014, 0.065, contrast3);

      let blur1 = (la + lc + lg + li) * 0.0625 + (lb + ld + lf + lh) * 0.125 + le * 0.25;
      let blur2 = (luma(n2) + luma(s2) + luma(w2) + luma(e2)) * 0.25;
      let blurWide = blur1 * 0.65 + blur2 * 0.35;

      var cur = e;

      // ======================================================================
      // 核心模式 0: SSimSuperRes (mpv/madVR 結構相似度超分重建)
      // 比較「原畫 texOrig (H)」與「回降圖 texLow (L)」的局部均值與變異數，
      // 數學精確還原縮放過程遺失的真實結構細節，極自然無人工白邊！
      // ======================================================================
      if (u.srMode < 0.5) {
        let origDims = vec2<f32>(textureDimensions(texOrig));
        let invOrig = 1.0 / max(origDims, vec2<f32>(1.0));

        var meanH = vec3<f32>(0.0);
        var meanL = vec3<f32>(0.0);
        var meanH2 = 0.0;
        var meanL2 = 0.0;

        // 3x3 高斯加權局部 SSIM 統計 (權重總和 = 1.0)
        for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
          for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
            let off = vec2<f32>(f32(dx), f32(dy)) * invOrig;
            let sUv = clamp(uv + off, vec2<f32>(0.0), vec2<f32>(1.0));
            let gw = select(select(0.0625, 0.125, (dx == 0 || dy == 0)), 0.25, (dx == 0 && dy == 0));

            let H = textureSampleLevel(texOrig, samp, sUv, 0.0).rgb;
            let L = textureSampleLevel(texLow, samp, sUv, 0.0).rgb;
            let lH = luma(H);
            let lL = luma(L);

            meanH = meanH + H * gw;
            meanL = meanL + L * gw;
            meanH2 = meanH2 + (lH * lH) * gw;
            meanL2 = meanL2 + (lL * lL) * gw;
          }
        }

        let mHy = luma(meanH);
        let mLy = luma(meanL);
        let varH = max(meanH2 - mHy * mHy, 0.0);
        let varL = max(meanL2 - mLy * mLy, 0.0);

        let eps = 0.0008;
        let ratio = sqrt((varH + eps) / (varL + eps));
        let excess = max(ratio - 1.0, 0.0);
        let gain = min(1.0 + excess * (1.2 + u.deblur * 1.45), 1.0 + 1.15 * u.deblur);

        // SSimSuperRes 精確結構重建方程式：校正局部均值並放大遺失的結構變異數
        let ssimRec = meanH + (e - meanL) * gain;

        // 額外補上一點 2px 中尺度亮度去模糊（針對串流原始壓縮造成的發虛）
        let detailY = luma(ssimRec) - blurWide;
        let maxHalo = max(contrast3 * 0.38, 0.018);
        let deltaY = clamp(detailY * (u.deblur * 0.72 * noiseGate), -maxHalo, maxHalo);

        cur = clamp(ssimRec + vec3<f32>(deltaY), vec3<f32>(0.0), vec3<f32>(1.0));
      } else if (u.srMode < 1.5) {
        // ====================================================================
        // 核心模式 1: Anime4K 真・邊緣收細 (ThinLines) + 墨線還原 (DarkenLines)
        // 關鍵修正：反向取樣必須用「uv - dirN * pushPx」（遠離高梯度脊線取樣，
        // 才能把發虛的雙側背景往輪廓內側收緊）；舊版 +dirN 反而把線條往外拉粗產生重影！
        // ====================================================================
        let gL = sobelGradMag(px + vec2<i32>(-1,  0), maxPx);
        let gR = sobelGradMag(px + vec2<i32>( 1,  0), maxPx);
        let gU = sobelGradMag(px + vec2<i32>( 0, -1), maxPx);
        let gD = sobelGradMag(px + vec2<i32>( 0,  1), maxPx);
        let gradDir = vec2<f32>(gR - gL, gD - gU);
        let gradLen = length(gradDir);

        if (gradLen > 0.03) {
          let dirN = gradDir / gradLen;
          // 負號 (-dirN) 才是把兩側拉向線條中心收細！
          let pushPx = clamp(u.deblur * 0.55 * smoothstep(0.03, 0.30, gradLen), 0.0, 0.85);
          let invDst = 1.0 / max(u.dstSize, vec2<f32>(1.0));
          let thinned = textureSampleLevel(
            texScaled,
            samp,
            clamp(uv - dirN * pushPx * invDst, vec2<f32>(0.0), vec2<f32>(1.0)),
            0.0
          ).rgb;
          cur = mix(e, thinned, 0.82);
        }

        // Anime4K DarkenLines：僅針對發灰的深色動漫墨線谷底 (lCur < blurWide) 微微加深還原俐落墨線
        let lCur = luma(cur);
        let inkValley = max(blurWide - lCur, 0.0);
        let inkGate = smoothstep(0.025, 0.14, inkValley) * smoothstep(0.04, 0.18, contrast3);
        let darkenAmount = clamp(inkValley * (u.deblur * 0.65 * inkGate), 0.0, 0.16);
        cur = max(cur - vec3<f32>(darkenAmount), vec3<f32>(0.0));

        // 輕微中尺度去模糊 + 嚴格 3x3 極值箝制，確保零白邊光暈
        let detailY = luma(cur) - blurWide;
        let maxHalo = max(contrast3 * 0.30, 0.015);
        let deltaY = clamp(detailY * (u.deblur * 0.55 * noiseGate), -maxHalo, maxHalo);

        let min3 = min(min(min(a, b), min(c, d)), min(e, min(min(f, g), min(h, i))));
        let max3 = max(max(max(a, b), max(c, d)), max(e, max(max(f, g), max(h, i))));
        cur = clamp(cur + vec3<f32>(deltaY), min3 * 0.88, max3);
      } else {
        // ====================================================================
        // 核心模式 2: AMD FSR 1.0 + 2px 多尺度壓縮去模糊
        // ====================================================================
        if (u.deblur > 0.001) {
          let detailY = le - blurWide;
          let maxHalo = max(contrast3 * 0.42, 0.02);
          let deltaY = clamp(detailY * (u.deblur * 1.15 * noiseGate), -maxHalo, maxHalo);
          let safeDelta = deltaY * (1.0 - smoothstep(0.88, 1.0, le)) * smoothstep(0.0, 0.08, le);
          cur = clamp(e + vec3<f32>(safeDelta), vec3<f32>(0.0), vec3<f32>(1.0));
        }
      }

      // 最後統一加上 1px AMD FidelityFX CAS 精細銳化 (讓髮絲、文字與紋理更俐落)
      if (u.sharpness > 0.001) {
        var mnRGB = min(min(d, cur), min(f, min(b, h)));
        mnRGB = mnRGB + min(mnRGB, min(min(a, c), min(g, i)));

        var mxRGB = max(max(d, cur), max(f, max(b, h)));
        mxRGB = mxRGB + max(mxRGB, max(max(a, c), max(g, i)));

        let rcpM = 1.0 / max(mxRGB, vec3<f32>(1e-4));
        let ampRGB = sqrt(clamp(min(mnRGB, vec3<f32>(2.0) - mxRGB) * rcpM, vec3<f32>(0.0), vec3<f32>(1.0)));

        let sNorm = clamp(u.sharpness, 0.0, 1.5);
        let peak = -1.0 / mix(8.5, 4.1, min(sNorm, 1.0));
        let overBoost = 1.0 + max(sNorm - 1.0, 0.0) * 0.42;
        let wRGB = ampRGB * peak * overBoost * noiseGate;

        cur = (cur + (b + d + f + h) * wRGB) / (vec3<f32>(1.0) + 4.0 * wRGB);
        cur = clamp(cur, vec3<f32>(0.0), vec3<f32>(1.0));
      }

      let finalRgb = applySdrToHdr(cur, blurWide, u.sdrToHdrLevel, u.isEdrCanvas);
      return vec4<f32>(finalRgb, 1.0);
    }
  `;

  // ============================================================================
  // 3. WebGPU 超分核心引擎
  // ============================================================================
  class WebGPUSuperResEngine {
    constructor(video) {
      this.video = video;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'webgpu-sr-canvas';
      this.canvas.style.cssText =
        'position:absolute;pointer-events:none;z-index:2147483640;background:#000;';

      this.divider = document.createElement('div');
      this.divider.className = 'webgpu-sr-divider';
      this.divider.style.cssText =
        'position:absolute;pointer-events:none;z-index:2147483642;display:none;width:2px;background:#7dd3fc;box-shadow:0 0 8px rgba(125,211,252,0.9);';

      const badgeBase =
        'position:absolute;top:10px;padding:2px 7px;border-radius:6px;font:600 11px -apple-system,sans-serif;color:#fff;background:rgba(0,0,0,0.65);white-space:nowrap;';
      const lblLeft = document.createElement('span');
      lblLeft.textContent = '原生原畫';
      lblLeft.style.cssText = `${badgeBase}right:8px;`;
      const lblRight = document.createElement('span');
      lblRight.textContent = 'WebGPU 增強';
      lblRight.style.cssText = `${badgeBase}left:8px;background:rgba(79,70,229,0.85);`;
      this.divider.appendChild(lblLeft);
      this.divider.appendChild(lblRight);

      this.context = null;
      this.format = null;
      this.isEdrCanvas = false;
      this.sampler = null;

      this.denoisePipeline = null;
      this.ewaPipeline = null;
      this.fsrPipeline = null;
      this.ssimDownPipeline = null;
      this.finalPipeline = null;
      this.scaleUniformBuf = null;
      this.finalUniformBuf = null;

      this.texVideo = null;
      this.texClean = null;
      this.texLow = null;
      this.texScaled = null;
      this.srcW = 0;
      this.srcH = 0;
      this.outW = 0;
      this.outH = 0;

      this.hasFrame = false;
      this.needsRender = false;
      this.lastMediaTime = -1;
      this.frameCount = 0;
      this.lastStatPerf = performance.now();

      this.running = false;
      this.rafId = 0;
      this.rvfcId = 0;
      this.resizeObserver = null;
      this.corsTainted = false;
    }

    async init() {
      if (!STATE.device) {
        if (!navigator.gpu) {
          throw new Error('此瀏覽器未啟用 WebGPU（請在 Safari 進階 Feature Flags 開啟 WebGPU）');
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('無法取得 WebGPU Adapter');
        STATE.device = await adapter.requestDevice();

        STATE.device.lost.then((info) => {
          STATE.stats.error = `WebGPU 裝置中斷: ${info.message}`;
          STATE.device = null;
          updateUIStats();
        });
      }

      const device = STATE.device;
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('無法建立 Canvas WebGPU Context');

      this.sdrFormat = navigator.gpu.getPreferredCanvasFormat();
      this.vsModule = device.createShaderModule({ code: FULLSCREEN_VS_WGSL });
      this.finalFsModule = device.createShaderModule({ code: SR_FINAL_FS_WGSL });
      this.finalPipelineSdr = null;
      this.finalPipelineEdr = null;

      this.sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });

      this.scaleUniformBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.finalUniformBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const vsModule = this.vsModule;

      this.denoisePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vsModule, entryPoint: 'vs_main' },
        fragment: {
          module: device.createShaderModule({ code: DENOISE_FS_WGSL }),
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.ewaPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vsModule, entryPoint: 'vs_main' },
        fragment: {
          module: device.createShaderModule({ code: EWA_LANCZOS_FS_WGSL }),
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.fsrPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vsModule, entryPoint: 'vs_main' },
        fragment: {
          module: device.createShaderModule({ code: FSR_EASU_FS_WGSL }),
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.ssimDownPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vsModule, entryPoint: 'vs_main' },
        fragment: {
          module: device.createShaderModule({ code: SSIM_DOWN_FS_WGSL }),
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.finalPipelineSdr = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: vsModule, entryPoint: 'vs_main' },
        fragment: {
          module: this.finalFsModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.sdrFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });

      this.configureColorSpace();

      this.attachOverlay();
      this.running = true;
      this.captureCurrentFrame();
      this.scheduleVideoFrameCallback();
      this.renderLoop();
    }

    // 動態切換標準 SDR (bgra8unorm，iOS 螢幕錄影完全不變暗) 與 Apple 真 EDR (rgba16float extended)
    configureColorSpace() {
      const device = STATE.device;
      if (!device || !this.context) return;

      const wantEdr = CONFIG.sdrToHdrLevel > 0 && CONFIG.enableEdr;
      if (wantEdr) {
        try {
          this.context.configure({
            device,
            format: 'rgba16float',
            colorSpace: 'srgb',
            toneMapping: { mode: 'extended' },
            alphaMode: 'opaque',
          });
          if (!this.finalPipelineEdr) {
            this.finalPipelineEdr = device.createRenderPipeline({
              layout: 'auto',
              vertex: { module: this.vsModule, entryPoint: 'vs_main' },
              fragment: {
                module: this.finalFsModule,
                entryPoint: 'fs_main',
                targets: [{ format: 'rgba16float' }],
              },
              primitive: { topology: 'triangle-list' },
            });
          }
          this.format = 'rgba16float';
          this.finalPipeline = this.finalPipelineEdr;
          this.isEdrCanvas = true;
          STATE.edrSupported = true;
          if (!this.corsTainted) STATE.stats.hdrBackend = '真 EDR (16F)';
          this.needsRender = true;
          updateUIStats();
          return;
        } catch (_) {
          STATE.edrSupported = false;
        }
      }

      // 標準 8-bit SDR 模式 (iOS 螢幕錄影、截圖 100% 維持原亮度不壓暗)
      this.context.configure({
        device,
        format: this.sdrFormat,
        colorSpace: 'srgb',
        alphaMode: 'opaque',
      });
      this.format = this.sdrFormat;
      this.finalPipeline = this.finalPipelineSdr;
      this.isEdrCanvas = false;
      if (!this.corsTainted) STATE.stats.hdrBackend = 'SDR 8-bit';
      this.needsRender = true;
      updateUIStats();
    }

    attachOverlay() {
      const parent = this.video.offsetParent || this.video.parentElement || document.body;
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.canvas);
      parent.appendChild(this.divider);

      this.canvas.addEventListener('click', () => {
        if (!STATE.pseudoFullscreen || !this.video) return;
        if (this.video.paused) this.video.play().catch(() => {});
        else this.video.pause();
      });
      this.syncCanvasLayout();

      this.resizeObserver = new ResizeObserver(() => this.syncCanvasLayout());
      this.resizeObserver.observe(this.video);
      this._boundSyncLayout = () => this.syncCanvasLayout();
      window.addEventListener('resize', this._boundSyncLayout);
      window.addEventListener('scroll', this._boundSyncLayout, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this._boundSyncLayout);
      }
    }

    syncCanvasLayout() {
      if (!this.video || !this.canvas) return;
      const vw = this.video.videoWidth || 1280;
      const vh = this.video.videoHeight || 720;
      const srcAspect = vw / Math.max(vh, 1);
      const vvScale = window.visualViewport ? window.visualViewport.scale : 1;
      const dpr = Math.min((window.devicePixelRatio || 2) * Math.max(vvScale, 1), 3);

      let boxLeft = 0;
      let boxTop = 0;
      let boxW = 0;
      let boxH = 0;

      if (STATE.pseudoFullscreen) {
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        boxW = winW;
        boxH = winW / srcAspect;
        if (boxH > winH) {
          boxH = winH;
          boxW = winH * srcAspect;
        }
        boxLeft = Math.round((winW - boxW) * 0.5);
        boxTop = Math.round((winH - boxH) * 0.5);

        this.canvas.style.position = 'fixed';
        this.canvas.style.left = `${boxLeft}px`;
        this.canvas.style.top = `${boxTop}px`;
        this.canvas.style.width = `${Math.round(boxW)}px`;
        this.canvas.style.height = `${Math.round(boxH)}px`;
        this.canvas.style.zIndex = '2147483645';
        this.canvas.style.pointerEvents = 'auto';
        this.canvas.style.boxShadow = '0 0 0 100vmax #000';
      } else {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const vRect = this.video.getBoundingClientRect();
        const pRect = parent.getBoundingClientRect();
        let fitW = vRect.width;
        let fitH = fitW / srcAspect;
        if (fitH > vRect.height) {
          fitH = vRect.height;
          fitW = fitH * srcAspect;
        }
        boxLeft = vRect.left - pRect.left + (vRect.width - fitW) * 0.5;
        boxTop = vRect.top - pRect.top + (vRect.height - fitH) * 0.5;
        boxW = fitW;
        boxH = fitH;

        this.canvas.style.position = 'absolute';
        this.canvas.style.left = `${boxLeft}px`;
        this.canvas.style.top = `${boxTop}px`;
        this.canvas.style.width = `${boxW}px`;
        this.canvas.style.height = `${boxH}px`;
        this.canvas.style.zIndex = '2147483640';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.boxShadow = 'none';
      }

      if (CONFIG.compareMode && !STATE.pseudoFullscreen) {
        const pct = (CONFIG.compareSplit * 100).toFixed(2);
        const clipVal = `inset(0 0 0 ${pct}%)`;
        this.canvas.style.clipPath = clipVal;
        this.canvas.style.webkitClipPath = clipVal;

        this.divider.style.display = 'block';
        this.divider.style.position = 'absolute';
        this.divider.style.left = `${boxLeft + boxW * CONFIG.compareSplit}px`;
        this.divider.style.top = `${boxTop}px`;
        this.divider.style.height = `${boxH}px`;
        this.divider.style.zIndex = '2147483642';
      } else {
        this.canvas.style.clipPath = 'none';
        this.canvas.style.webkitClipPath = 'none';
        this.divider.style.display = 'none';
      }

      const physW = Math.min(CONFIG.maxOutputWidth, Math.max(2, Math.round(boxW * dpr)));
      const physH = Math.min(CONFIG.maxOutputHeight, Math.max(2, Math.round(boxH * dpr)));

      if (this.canvas.width !== physW || this.canvas.height !== physH) {
        this.canvas.width = physW;
        this.canvas.height = physH;
        this.needsRender = true;
      }

      if (STATE.device) {
        this.ensureScaledTexture(physW, physH);
      }

      STATE.stats.resolution = `${vw}×${vh} → ${physW}×${physH}`;
    }

    ensureSourceTextures(w, h) {
      if (this.srcW === w && this.srcH === h && this.texVideo) return;
      [this.texVideo, this.texClean, this.texLow].forEach((t) => t && t.destroy());
      const usage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT;
      this.texVideo = STATE.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
      this.texClean = STATE.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
      this.texLow = STATE.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage });
      this.srcW = w;
      this.srcH = h;
      this.syncCanvasLayout();
    }

    ensureScaledTexture(w, h) {
      if (this.outW === w && this.outH === h && this.texScaled) return;
      if (this.texScaled) this.texScaled.destroy();
      this.texScaled = STATE.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.outW = w;
      this.outH = h;
    }

    scheduleVideoFrameCallback() {
      if (!this.running || !this.video) return;
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        this.rvfcId = this.video.requestVideoFrameCallback((_now, metadata) => {
          if (metadata.mediaTime !== this.lastMediaTime) {
            this.lastMediaTime = metadata.mediaTime;
            this.captureCurrentFrame();
          }
          this.scheduleVideoFrameCallback();
        });
      }
    }

    ensureSvgSharpenFilter() {
      const svgNS = 'http://www.w3.org/2000/svg';
      let svg = document.getElementById('webgpu-sr-svg-defs');
      if (!svg) {
        svg = document.createElementNS(svgNS, 'svg');
        svg.id = 'webgpu-sr-svg-defs';
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none;';
        const defs = document.createElementNS(svgNS, 'defs');
        const filter = document.createElementNS(svgNS, 'filter');
        filter.id = 'webgpu-sr-svg-sharpen';
        filter.setAttribute('color-interpolation-filters', 'sRGB');
        const conv = document.createElementNS(svgNS, 'feConvolveMatrix');
        conv.id = 'webgpu-sr-svg-conv';
        conv.setAttribute('order', '3');
        conv.setAttribute('preserveAlpha', 'true');
        conv.setAttribute('edgeMode', 'duplicate');
        filter.appendChild(conv);
        defs.appendChild(filter);
        svg.appendChild(defs);
        (document.body || document.documentElement).appendChild(svg);
      }
      return document.getElementById('webgpu-sr-svg-conv');
    }

    applyCompositorFallback() {
      if (!this.video) return;
      // 隱藏無法擷取畫面的 WebGPU 畫布與分割線，改由 Safari 合成器直接加速原 <video>
      this.canvas.style.display = 'none';
      this.divider.style.display = 'none';

      if (CONFIG.compareMode) {
        // 備援模式下按「原畫對比」可一鍵暫時關閉濾鏡檢視純原畫
        this.video.style.filter = this._origVideoFilter || '';
        this.video.style.webkitFilter = this._origVideoFilter || '';
        return;
      }

      const conv = this.ensureSvgSharpenFilter();
      // 綜合去模糊與銳化參數計算 3x3 捲積核強度 (安全範圍 0.0 ~ 0.65，避免過銳)
      const k = Math.max(0, Math.min(0.65, (CONFIG.sharpness * 0.28 + CONFIG.deblur * 0.16)));
      const center = (1 + 4 * k).toFixed(3);
      const side = (-k).toFixed(3);
      if (conv) {
        conv.setAttribute('kernelMatrix', `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
      }

      const filters = [];
      if (k > 0.01) filters.push('url(#webgpu-sr-svg-sharpen)');
      if (CONFIG.sdrToHdrLevel === 1) {
        filters.push('contrast(1.14) saturate(1.22) brightness(1.03)');
      } else if (CONFIG.sdrToHdrLevel === 2) {
        filters.push('contrast(1.26) saturate(1.38) brightness(1.05)');
      } else {
        // 輕微對比提升讓合成器銳化更立體
        filters.push('contrast(1.04)');
      }

      const cssFilter = filters.join(' ');
      this.video.style.filter = cssFilter;
      this.video.style.webkitFilter = cssFilter;
    }

    clearCompositorFallback() {
      if (this.video) {
        this.video.style.filter = this._origVideoFilter || '';
        this.video.style.webkitFilter = this._origVideoFilter || '';
      }
    }

    captureCurrentFrame() {
      if (!this.running || !STATE.device) return;
      const v = this.video;
      if (v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) return;

      this.ensureSourceTextures(v.videoWidth, v.videoHeight);

      try {
        STATE.device.queue.copyExternalImageToTexture(
          { source: v },
          { texture: this.texVideo },
          [this.srcW, this.srcH]
        );
        if (this.corsTainted) {
          this.corsTainted = false;
          STATE.corsFallback = false;
          this.clearCompositorFallback();
          this.canvas.style.display = 'block';
          STATE.stats.hdrBackend = this.isEdrCanvas ? '真 EDR (16F)' : 'SDR 8-bit';
          STATE.stats.error = '';
          syncUIControls();
        }
        this.hasFrame = true;
        this.needsRender = true;
        this.frameCount++;
      } catch (_) {
        if (!this.corsTainted) {
          this._origVideoFilter = v.style.filter || '';
        }
        this.corsTainted = true;
        STATE.corsFallback = true;
        STATE.stats.hdrBackend = '合成器濾鏡';
        STATE.stats.error =
          '此網站影片跨網域受限 (CORS)，WebGPU 無法讀取像素；已自動切換為「Safari GPU 合成器銳化備援」。你也可以點下方按鈕嘗試以 CORS 模式重載影片。';
        this.applyCompositorFallback();
        syncUIControls();
        updateUIStats();
      }
    }

    requestRedraw() {
      if (this.corsTainted) {
        this.applyCompositorFallback();
      } else {
        this.needsRender = true;
      }
    }

    renderLoop() {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(() => this.renderLoop());

      const now = performance.now();
      if (typeof this.video.requestVideoFrameCallback !== 'function') {
        if (this.video.currentTime !== this.lastMediaTime) {
          this.lastMediaTime = this.video.currentTime;
          this.captureCurrentFrame();
        }
      }

      if (this.hasFrame && this.needsRender && STATE.device && this.texVideo && this.texScaled && !this.corsTainted) {
        this.renderFrame();
        this.needsRender = false;
      }

      if (now - this.lastStatPerf >= 500) {
        const sec = (now - this.lastStatPerf) / 1000;
        STATE.stats.fps = Math.round(this.frameCount / sec);
        STATE.stats.status = this.video.paused ? '已暫停' : '運行中';
        this.frameCount = 0;
        this.lastStatPerf = now;
        updateUIStats();
      }
    }

    renderFrame() {
      const device = STATE.device;
      const encoder = device.createCommandEncoder();

      // Pass 0 (可選): 邊緣保持雙邊去噪 -> texClean
      let srcTex = this.texVideo;
      if (CONFIG.denoise) {
        const denoiseBg = device.createBindGroup({
          layout: this.denoisePipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: this.texVideo.createView() }],
        });
        const p0 = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.texClean.createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        p0.setPipeline(this.denoisePipeline);
        p0.setBindGroup(0, denoiseBg);
        p0.draw(3);
        p0.end();
        srcTex = this.texClean;
      }

      // Pass 1: 縮放至 1:1 Retina 像素 -> texScaled
      const isDownscale = this.outW <= this.srcW * 1.02 && this.outH <= this.srcH * 1.02 ? 1.0 : 0.0;
      const scalePipe = CONFIG.engineMode === 'fsr1' ? this.fsrPipeline : this.ewaPipeline;

      device.queue.writeBuffer(
        this.scaleUniformBuf,
        0,
        new Float32Array([this.srcW, this.srcH, this.outW, this.outH, isDownscale, 0, 0, 0])
      );
      const scaleBg = device.createBindGroup({
        layout: scalePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: srcTex.createView() },
          { binding: 2, resource: { buffer: this.scaleUniformBuf } },
        ],
      });
      const p1 = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.texScaled.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      p1.setPipeline(scalePipe);
      p1.setBindGroup(0, scaleBg);
      p1.draw(3);
      p1.end();

      // Pass 2 (SSimSuperRes 專用): 將 texScaled 回降回原解析度 -> texLow
      if (CONFIG.engineMode === 'ssim') {
        const downBg = device.createBindGroup({
          layout: this.ssimDownPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: this.texScaled.createView() },
          ],
        });
        const p2 = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.texLow.createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        p2.setPipeline(this.ssimDownPipeline);
        p2.setBindGroup(0, downBg);
        p2.draw(3);
        p2.end();
      }

      // Pass 3: 最終結構重建 (SSimSuperRes / Anime4K / FSR1) + 1px AMD CAS + EDR HDR -> Canvas
      const srModeId = CONFIG.engineMode === 'ssim' ? 0.0 : CONFIG.engineMode === 'anime4k' ? 1.0 : 2.0;
      const useShaderCompare = CONFIG.compareMode && STATE.pseudoFullscreen ? CONFIG.compareSplit : 0.0;

      device.queue.writeBuffer(
        this.finalUniformBuf,
        0,
        new Float32Array([
          this.outW,
          this.outH,
          CONFIG.deblur,
          CONFIG.sharpness,
          CONFIG.sdrToHdrLevel,
          this.isEdrCanvas ? 1.0 : 0.0,
          useShaderCompare,
          srModeId,
        ])
      );
      const finalBg = device.createBindGroup({
        layout: this.finalPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.texScaled.createView() },
          { binding: 2, resource: srcTex.createView() },
          { binding: 3, resource: this.texLow.createView() },
          { binding: 4, resource: { buffer: this.finalUniformBuf } },
        ],
      });
      const p3 = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      p3.setPipeline(this.finalPipeline);
      p3.setBindGroup(0, finalBg);
      p3.draw(3);
      p3.end();

      device.queue.submit([encoder.finish()]);
    }

    destroy() {
      this.running = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.rvfcId && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
        try {
          this.video.cancelVideoFrameCallback(this.rvfcId);
        } catch (_) {}
      }
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this._boundSyncLayout) {
        window.removeEventListener('resize', this._boundSyncLayout);
        window.removeEventListener('scroll', this._boundSyncLayout);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', this._boundSyncLayout);
        }
      }
      this.clearCompositorFallback();
      [this.texVideo, this.texClean, this.texLow, this.texScaled].forEach((t) => t && t.destroy());
      [this.scaleUniformBuf, this.finalUniformBuf].forEach((b) => b && b.destroy());
      if (this.canvas && this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
      if (this.divider && this.divider.parentElement) this.divider.parentElement.removeChild(this.divider);
    }
  }

  // ============================================================================
  // 4. 影片偵測、引擎控制與標準 CORS 重試
  // ============================================================================
  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;

    const scored = videos
      .map((v) => {
        const rect = v.getBoundingClientRect();
        const area = rect.width * rect.height;
        const hasFrame = v.videoWidth > 0 && v.videoHeight > 0;
        const playing = !v.paused && !v.ended && v.readyState >= 2;
        return { v, score: area + (hasFrame ? 1e6 : 0) + (playing ? 1e7 : 0) };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0] ? scored[0].v : null;
  }

  // 部分影片站 CDN 其實支援 CORS，只是網頁 <video> 漏寫 crossorigin="anonymous"。
  // 此函式以瀏覽器標準方式重載並附帶失敗自動回滾，絕不破壞播放。
  async function tryEnableCorsReload() {
    const video = STATE.activeVideo || findBestVideo();
    if (!video || STATE.corsRetrying) return;

    STATE.corsRetrying = true;
    STATE.stats.error = '正在嘗試以標準 CORS (crossOrigin="anonymous") 重載影片...';
    syncUIControls();
    updateUIStats();

    const savedTime = video.currentTime || 0;
    const wasPaused = video.paused;
    const prevAttr = video.getAttribute('crossorigin');

    const rollback = () => {
      if (prevAttr === null) video.removeAttribute('crossorigin');
      else video.setAttribute('crossorigin', prevAttr);
      video.load();
      video.addEventListener(
        'loadedmetadata',
        () => {
          try {
            if (savedTime > 0) video.currentTime = savedTime;
          } catch (_) {}
          if (!wasPaused) video.play().catch(() => {});
        },
        { once: true }
      );
    };

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('loadeddata', onOk);
          video.removeEventListener('canplay', onOk);
          video.removeEventListener('error', onErr);
          if (ok) resolve();
          else reject(err);
        };
        const onOk = () => finish(true);
        const onErr = () => finish(false, new Error('伺服器拒絕跨網域 CORS 請求'));
        const timer = setTimeout(() => finish(false, new Error('CORS 重載逾時')), 4500);

        video.addEventListener('loadeddata', onOk, { once: true });
        video.addEventListener('canplay', onOk, { once: true });
        video.addEventListener('error', onErr, { once: true });

        video.crossOrigin = 'anonymous';
        video.load();
      });

      try {
        if (savedTime > 0) video.currentTime = savedTime;
      } catch (_) {}
      if (!wasPaused) video.play().catch(() => {});

      STATE.corsRetrying = false;
      STATE.corsFallback = false;
      await startEngine();
    } catch (err) {
      rollback();
      STATE.corsRetrying = false;
      STATE.corsFallback = true;
      STATE.stats.error = `${err.message}：已自動恢復播放並維持「Safari GPU 合成器銳化備援」。`;
      if (STATE.engine) STATE.engine.applyCompositorFallback();
      syncUIControls();
      updateUIStats();
    }
  }

  async function startEngine() {
    stopEngine();
    const video = findBestVideo();
    if (!video) {
      STATE.stats.error = '頁面上找不到 <video> 元素，請先開始播放影片';
      STATE.stats.status = '未偵測到影片';
      CONFIG.enabled = false;
      syncUIControls();
      updateUIStats();
      return;
    }

    STATE.activeVideo = video;
    STATE.corsFallback = false;
    STATE.stats.error = '';
    STATE.stats.status = '初始化 WebGPU...';
    updateUIStats();

    try {
      const engine = new WebGPUSuperResEngine(video);
      await engine.init();
      STATE.engine = engine;
      CONFIG.enabled = true;
      STATE.stats.status = '運行中';
    } catch (err) {
      console.error('[WebGPU-SR] 啟動失敗:', err);
      STATE.stats.error = err.message || String(err);
      STATE.stats.status = '啟動失敗';
      CONFIG.enabled = false;
    }

    syncUIControls();
    updateUIStats();
  }

  function stopEngine() {
    if (STATE.engine) {
      STATE.engine.destroy();
      STATE.engine = null;
    }
    STATE.corsFallback = false;
    STATE.pseudoFullscreen = false;
    CONFIG.enabled = false;
    STATE.stats.status = '已停止';
    STATE.stats.fps = 0;
    syncUIControls();
    updateUIStats();
  }

  function togglePseudoFullscreen() {
    if (!STATE.engine) return;
    STATE.pseudoFullscreen = !STATE.pseudoFullscreen;
    STATE.engine.syncCanvasLayout();
    STATE.engine.requestRedraw();
    syncUIControls();
  }

  // ============================================================================
  // 5. 純 DOM 輕量面板
  // ============================================================================
  const uiRefs = {};

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'string') node.style.cssText = v;
      else if (k.startsWith('data-')) node.setAttribute(k, v);
      else node[k] = v;
    }
    for (const ch of children) {
      if (ch == null) continue;
      node.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
    }
    return node;
  }

  function mountUI() {
    if (document.getElementById('webgpu-sr-host')) return;

    const host = document.createElement('div');
    host.id = 'webgpu-sr-host';
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
    (document.body || document.documentElement).appendChild(host);

    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
      .fab {
        position: fixed;
        right: 16px;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 84px);
        height: 42px;
        padding: 0 15px;
        border-radius: 21px;
        border: 1.5px solid rgba(129, 140, 248, 0.75);
        background: rgba(16, 20, 32, 0.88);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        color: #f8fafc;
        font-size: 13px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 7px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
        cursor: pointer;
        user-select: none;
        touch-action: none;
        pointer-events: auto;
      }
      .fab .dot { width: 9px; height: 9px; border-radius: 50%; background: #94a3b8; transition: background 0.2s; }
      .fab.active .dot { background: #34d399; box-shadow: 0 0 8px #34d399; }

      .sheet {
        position: fixed;
        right: 12px;
        left: 12px;
        max-width: min(408px, calc(100vw - 12px));
        margin-left: auto;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 14px);
        max-height: 84dvh;
        overflow-y: auto;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(16, 18, 26, 0.94);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        color: #eef2ff;
        padding: 14px 16px 16px;
        box-shadow: 0 16px 44px rgba(0,0,0,0.6);
        display: none;
        font-size: 13px;
        pointer-events: auto;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        transition: border-color 0.16s, box-shadow 0.16s;
      }
      .sheet.open { display: block; }
      .sheet.dragging {
        border-color: rgba(129, 140, 248, 0.95);
        box-shadow: 0 22px 56px rgba(0, 0, 0, 0.78), 0 0 0 2px rgba(99, 102, 241, 0.35);
        touch-action: none;
        overflow: hidden;
      }
      .header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 10px; gap: 8px;
        touch-action: none; cursor: grab;
      }
      .sheet.dragging .header { cursor: grabbing; }
      .title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .title { font-size: 15px; font-weight: 700; white-space: nowrap; }
      .drag-badge {
        font-size: 10px; font-weight: 600; color: #a5b4fc;
        background: rgba(99, 102, 241, 0.18); border: 1px solid rgba(129, 140, 248, 0.35);
        border-radius: 999px; padding: 2px 7px; white-space: nowrap;
      }
      .sheet.dragging .drag-badge {
        background: rgba(99, 102, 241, 0.55); border-color: #a5b4fc; color: #fff;
      }
      .close-btn {
        border: none; background: rgba(255,255,255,0.14); color: #fff;
        width: 30px; height: 30px; border-radius: 15px; font-size: 15px; cursor: pointer; flex-shrink: 0;
      }
      .stats-bar {
        display: grid; grid-template-columns: 0.65fr 1.65fr 1.1fr; gap: 6px;
        background: rgba(255,255,255,0.06); border-radius: 12px; padding: 8px;
        margin-bottom: 10px; text-align: center;
      }
      .stat-label { font-size: 10px; color: #9aa4b8; }
      .stat-val { font-size: 11px; font-weight: 700; color: #e2e8f0; margin-top: 2px; }
      .error-box {
        display: none; margin-bottom: 10px; padding: 8px 10px; border-radius: 10px;
        background: rgba(239, 68, 68, 0.18); border: 1px solid rgba(239,68,68,0.45);
        color: #fecaca; font-size: 12px; line-height: 1.4; word-break: break-word;
      }
      .row { margin-bottom: 10px; }
      .row-flex { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .label { font-size: 12px; color: #cbd5e1; margin-bottom: 5px; display: block; }
      .btn-primary {
        flex: 1; padding: 10px 12px; border-radius: 12px; border: none;
        background: linear-gradient(135deg, #3b82f6, #6366f1); color: #fff;
        font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .btn-primary.stop { background: linear-gradient(135deg, #ef4444, #dc2626); }
      .btn-sec {
        padding: 9px 11px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.08); color: #f1f5f9;
        font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .btn-sec.active { background: rgba(52, 211, 153, 0.25); border-color: #34d399; color: #d1fae5; }
      .seg3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .seg3 button {
        padding: 8px 4px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.05); color: #cbd5e1; font-size: 11.5px; cursor: pointer;
      }
      .seg3 button.active {
        background: rgba(99, 102, 241, 0.38); border-color: #818cf8; color: #fff; font-weight: 600;
      }
      input[type="range"] { width: 100%; accent-color: #6366f1; }
      .hint { font-size: 11px; color: #94a3b8; line-height: 1.45; }
    `;

    const dot = el('span', { className: 'dot' });
    const fabText = el('span', { text: 'GPU 超分' });
    const fab = el('div', { className: 'fab' }, [dot, fabText]);

    const dragBadge = el('span', { className: 'drag-badge', text: '⋮⋮ 長按拖曳' });
    const closeBtn = el('button', { type: 'button', className: 'close-btn', text: '✕' });
    const header = el('div', { className: 'header' }, [
      el('div', { className: 'title-wrap' }, [
        el('div', { className: 'title', text: 'WebGPU 超分引擎 v3.3.2' }),
        dragBadge,
      ]),
      closeBtn,
    ]);

    const statFps = el('div', { className: 'stat-val', text: '0' });
    const statRes = el('div', { className: 'stat-val', text: '-' });
    const statHdr = el('div', { className: 'stat-val', text: '-' });
    const statsBar = el('div', { className: 'stats-bar' }, [
      el('div', {}, [el('div', { className: 'stat-label', text: 'FPS' }), statFps]),
      el('div', {}, [el('div', { className: 'stat-label', text: '1:1 Retina' }), statRes]),
      el('div', {}, [el('div', { className: 'stat-label', text: '輸出色彩' }), statHdr]),
    ]);

    const errorBox = el('div', { className: 'error-box' });
    const corsRetryBtn = el('button', {
      type: 'button',
      className: 'btn-sec',
      style:
        'display:none;width:100%;margin-bottom:10px;border-color:rgba(251,191,36,0.55);background:rgba(251,191,36,0.16);color:#fef3c7;',
      text: '嘗試以 CORS 模式重載影片（解鎖完整 WebGPU）',
    });

    const toggleBtn = el('button', { type: 'button', className: 'btn-primary', text: '啟動 WebGPU 超分' });
    const compareBtn = el('button', { type: 'button', className: 'btn-sec', text: '原畫對比' });
    const fsBtn = el('button', { type: 'button', className: 'btn-sec', text: '全螢幕' });
    const actionRow = el('div', { className: 'row row-flex' }, [toggleBtn, compareBtn, fsBtn]);

    const splitVal = el('span', { style: 'font-size:12px;color:#94a3b8;', text: '50%' });
    const splitRange = el('input', {
      type: 'range',
      min: '0.1',
      max: '0.9',
      step: '0.02',
      value: String(CONFIG.compareSplit),
    });
    const splitRow = el('div', { className: 'row', style: 'display:none;' }, [
      el('div', { className: 'row-flex' }, [
        el('span', { className: 'label', text: '對比分割線（左=真實原生影片 / 右=超分）' }),
        splitVal,
      ]),
      splitRange,
    ]);

    // 三大超分演算法切換
    const btnSsim = el('button', { type: 'button', 'data-eng': 'ssim', className: 'active', text: 'SSimSuperRes' });
    const btnA4k = el('button', { type: 'button', 'data-eng': 'anime4k', text: 'Anime4K 輪廓' });
    const btnFsr1 = el('button', { type: 'button', 'data-eng': 'fsr1', text: 'AMD FSR 1.0' });
    const engSeg = el('div', { className: 'seg3' }, [btnSsim, btnA4k, btnFsr1]);
    const engRow = el('div', { className: 'row' }, [
      el('span', { className: 'label', text: '超分核心（SSimSuperRes 結構還原優於 FSR1）' }),
      engSeg,
    ]);

    // 檔位預設 + 壓縮去噪開關
    const p1 = el('button', { type: 'button', 'data-preset': '1', text: PRESETS[1].label });
    const p2 = el('button', { type: 'button', 'data-preset': '2', className: 'active', text: PRESETS[2].label });
    const p3 = el('button', { type: 'button', 'data-preset': '3', text: PRESETS[3].label });
    const presetSeg = el('div', { className: 'seg3' }, [p1, p2, p3]);
    const denoiseBtn = el('button', {
      type: 'button',
      className: 'btn-sec active',
      style: 'width:100%;margin-top:6px;',
      text: '串流壓縮去噪 (去除 YouTube 蚊式噪點)：開啟',
    });
    const presetRow = el('div', { className: 'row' }, [
      el('span', { className: 'label', text: '超分檔位與預處理' }),
      presetSeg,
      denoiseBtn,
    ]);

    const deblurVal = el('span', { style: 'font-size:12px;color:#94a3b8;', text: CONFIG.deblur.toFixed(2) });
    const deblurRange = el('input', {
      type: 'range',
      min: '0',
      max: '1.5',
      step: '0.05',
      value: String(CONFIG.deblur),
    });
    const deblurRow = el('div', { className: 'row' }, [
      el('div', { className: 'row-flex' }, [
        el('span', { className: 'label', text: '結構重建 / 邊緣收細強度' }),
        deblurVal,
      ]),
      deblurRange,
    ]);

    const sharpVal = el('span', { style: 'font-size:12px;color:#94a3b8;', text: CONFIG.sharpness.toFixed(2) });
    const sharpRange = el('input', {
      type: 'range',
      min: '0',
      max: '1.5',
      step: '0.05',
      value: String(CONFIG.sharpness),
    });
    const sharpRow = el('div', { className: 'row' }, [
      el('div', { className: 'row-flex' }, [
        el('span', { className: 'label', text: '1px 精細銳化 (AMD CAS)' }),
        sharpVal,
      ]),
      sharpRange,
    ]);

    const hdr0 = el('button', { type: 'button', 'data-hdr': '0', className: 'active', text: '關閉' });
    const hdr1 = el('button', { type: 'button', 'data-hdr': '1', text: '1 檔 (自然 HDR)' });
    const hdr2 = el('button', { type: 'button', 'data-hdr': '2', text: '2 檔 (鮮明 XDR)' });
    const hdrSeg = el('div', { className: 'seg3' }, [hdr0, hdr1, hdr2]);
    const edrBtn = el('button', {
      type: 'button',
      className: 'btn-sec',
      style: 'display:none;width:100%;margin-top:6px;',
      text: 'Apple 真 EDR 實體高光 (錄影會壓暗)：關閉',
    });
    const hdrRow = el('div', { className: 'row' }, [
      el('span', { className: 'label', text: 'SDR → HDR 逆色調映射' }),
      hdrSeg,
      edrBtn,
    ]);

    const hintEl = el('div', {
      className: 'hint',
      text: '預設採標準 SDR 8-bit 輸出（iOS 螢幕錄影完全不變暗）；開 HDR 時可自由選擇要不要啟用真 EDR 實體高光。',
    });

    const sheet = el('div', { className: 'sheet' }, [
      header,
      statsBar,
      errorBox,
      corsRetryBtn,
      actionRow,
      splitRow,
      engRow,
      presetRow,
      deblurRow,
      sharpRow,
      hdrRow,
      hintEl,
    ]);

    root.appendChild(styleEl);
    root.appendChild(fab);
    root.appendChild(sheet);

    Object.assign(uiRefs, {
      fab,
      fabText,
      sheet,
      closeBtn,
      statFps,
      statRes,
      statHdr,
      errorBox,
      corsRetryBtn,
      toggleBtn,
      compareBtn,
      fsBtn,
      splitRow,
      splitRange,
      splitVal,
      engSeg,
      presetSeg,
      denoiseBtn,
      deblurRange,
      deblurVal,
      sharpRange,
      sharpVal,
      hdrSeg,
      edrBtn,
    });

    let startX = 0;
    let startY = 0;
    let fabRight = 16;
    let fabBottom = 84;
    let moved = false;
    let dragging = false;

    fab.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    fab.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (moved) {
        startX = e.clientX;
        startY = e.clientY;
        fabRight = Math.max(8, Math.min(window.innerWidth - 110, fabRight + dx));
        fabBottom = Math.max(14, Math.min(window.innerHeight - 60, fabBottom + dy));
        fab.style.right = `${fabRight}px`;
        fab.style.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${fabBottom}px)`;
      }
    });
    fab.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (!moved) {
        const opened = sheet.classList.toggle('open');
        if (opened) clampSheetPos();
      }
    });

    // 控制視窗長按拖曳（長按標題列或面板空白處 260ms 即可拖曳位置，不干擾滑桿與捲動）
    let pressTimer = null;
    let sheetDragging = false;
    let sheetPositioned = false;
    let sheetPointerId = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let lastDragX = 0;
    let lastDragY = 0;
    let sheetLeft = 12;
    let sheetTop = 12;
    let sheetW = 380;

    const clampSheetPos = () => {
      if (!sheetPositioned) return;
      const curW = Math.min(sheet.offsetWidth || sheetW, Math.max(220, window.innerWidth - 12));
      const maxLeft = Math.max(6, window.innerWidth - curW - 6);
      const maxTop = Math.max(6, window.innerHeight - 72);
      sheetLeft = Math.max(6, Math.min(maxLeft, sheetLeft));
      sheetTop = Math.max(6, Math.min(maxTop, sheetTop));
      sheet.style.left = `${Math.round(sheetLeft)}px`;
      sheet.style.top = `${Math.round(sheetTop)}px`;
    };

    const endSheetDrag = (e) => {
      if (e && e.pointerId !== undefined && sheetPointerId !== null && e.pointerId !== sheetPointerId) {
        return;
      }
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      if (sheetDragging) {
        sheetDragging = false;
        sheet.classList.remove('dragging');
        dragBadge.textContent = '⋮⋮ 長按拖曳';
        if (sheetPointerId !== null) {
          try {
            sheet.releasePointerCapture(sheetPointerId);
          } catch (_) {}
        }
      }
      sheetPointerId = null;
    };

    sheet.addEventListener('pointerdown', (e) => {
      // 點在按鈕、滑桿或選項上時不觸發視窗拖曳
      if (e.target && e.target.closest && e.target.closest('button, input, select, label, a')) {
        return;
      }
      endSheetDrag();
      sheetPointerId = e.pointerId;
      pressStartX = e.clientX;
      pressStartY = e.clientY;
      lastDragX = e.clientX;
      lastDragY = e.clientY;

      pressTimer = setTimeout(() => {
        pressTimer = null;
        sheetDragging = true;
        const rect = sheet.getBoundingClientRect();
        sheetLeft = rect.left;
        sheetTop = rect.top;
        sheetW = rect.width;
        sheetPositioned = true;

        sheet.style.left = `${Math.round(sheetLeft)}px`;
        sheet.style.top = `${Math.round(sheetTop)}px`;
        sheet.style.right = 'auto';
        sheet.style.bottom = 'auto';
        sheet.style.marginLeft = '0';
        sheet.style.width = `${Math.round(sheetW)}px`;

        sheet.classList.add('dragging');
        dragBadge.textContent = '拖曳中...';
        try {
          sheet.setPointerCapture(sheetPointerId);
        } catch (_) {}
        if (navigator.vibrate) {
          try {
            navigator.vibrate(12);
          } catch (_) {}
        }
      }, 260);
    });

    window.addEventListener('pointermove', (e) => {
      if (sheetPointerId === null || e.pointerId !== sheetPointerId) return;
      if (!sheetDragging) {
        // 長按尚未觸發前若移動超過 10px，視為一般面板捲動並取消長按
        if (Math.abs(e.clientX - pressStartX) > 10 || Math.abs(e.clientY - pressStartY) > 10) {
          if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
          }
          sheetPointerId = null;
        }
        return;
      }
      e.preventDefault();
      const dx = e.clientX - lastDragX;
      const dy = e.clientY - lastDragY;
      lastDragX = e.clientX;
      lastDragY = e.clientY;
      sheetLeft += dx;
      sheetTop += dy;
      clampSheetPos();
    });

    window.addEventListener(
      'touchmove',
      (e) => {
        if (sheetDragging) e.preventDefault();
      },
      { passive: false }
    );

    window.addEventListener('pointerup', endSheetDrag);
    window.addEventListener('pointercancel', endSheetDrag);
    sheet.addEventListener('contextmenu', (e) => {
      if (sheetDragging || pressTimer) e.preventDefault();
    });
    window.addEventListener('resize', clampSheetPos);

    closeBtn.addEventListener('click', () => sheet.classList.remove('open'));
    toggleBtn.addEventListener('click', () => (CONFIG.enabled ? stopEngine() : startEngine()));
    compareBtn.addEventListener('click', () => {
      CONFIG.compareMode = !CONFIG.compareMode;
      if (STATE.engine) {
        STATE.engine.syncCanvasLayout();
        STATE.engine.requestRedraw();
      }
      syncUIControls();
    });
    fsBtn.addEventListener('click', togglePseudoFullscreen);

    splitRange.addEventListener('input', () => {
      CONFIG.compareSplit = parseFloat(splitRange.value);
      splitVal.textContent = `${Math.round(CONFIG.compareSplit * 100)}%`;
      if (STATE.engine) {
        STATE.engine.syncCanvasLayout();
        STATE.engine.requestRedraw();
      }
    });

    engSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        CONFIG.engineMode = btn.getAttribute('data-eng');
        if (STATE.engine) STATE.engine.requestRedraw();
        syncUIControls();
      });
    });

    presetSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lvl = parseInt(btn.getAttribute('data-preset'), 10);
        const p = PRESETS[lvl];
        if (!p) return;
        CONFIG.presetLevel = lvl;
        CONFIG.deblur = p.deblur;
        CONFIG.sharpness = p.sharpness;
        deblurRange.value = String(CONFIG.deblur);
        deblurVal.textContent = CONFIG.deblur.toFixed(2);
        sharpRange.value = String(CONFIG.sharpness);
        sharpVal.textContent = CONFIG.sharpness.toFixed(2);
        if (STATE.engine) STATE.engine.requestRedraw();
        syncUIControls();
      });
    });

    denoiseBtn.addEventListener('click', () => {
      CONFIG.denoise = !CONFIG.denoise;
      if (STATE.engine) STATE.engine.requestRedraw();
      syncUIControls();
    });

    deblurRange.addEventListener('input', () => {
      CONFIG.deblur = parseFloat(deblurRange.value);
      CONFIG.presetLevel = 0;
      deblurVal.textContent = CONFIG.deblur.toFixed(2);
      if (STATE.engine) STATE.engine.requestRedraw();
      syncUIControls();
    });

    sharpRange.addEventListener('input', () => {
      CONFIG.sharpness = parseFloat(sharpRange.value);
      CONFIG.presetLevel = 0;
      sharpVal.textContent = CONFIG.sharpness.toFixed(2);
      if (STATE.engine) STATE.engine.requestRedraw();
      syncUIControls();
    });

    corsRetryBtn.addEventListener('click', tryEnableCorsReload);

    hdrSeg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        CONFIG.sdrToHdrLevel = parseInt(btn.getAttribute('data-hdr'), 10);
        if (STATE.engine) {
          STATE.engine.configureColorSpace();
          STATE.engine.requestRedraw();
        }
        syncUIControls();
      });
    });

    edrBtn.addEventListener('click', () => {
      CONFIG.enableEdr = !CONFIG.enableEdr;
      if (STATE.engine) {
        STATE.engine.configureColorSpace();
        STATE.engine.requestRedraw();
      }
      syncUIControls();
    });

    syncUIControls();
    updateUIStats();
  }

  function syncUIControls() {
    if (!uiRefs.toggleBtn) return;
    uiRefs.fab.classList.toggle('active', CONFIG.enabled);
    uiRefs.toggleBtn.textContent = CONFIG.enabled ? '停止超分' : '啟動 WebGPU 超分';
    uiRefs.toggleBtn.classList.toggle('stop', CONFIG.enabled);
    uiRefs.compareBtn.classList.toggle('active', CONFIG.compareMode);
    uiRefs.compareBtn.textContent = CONFIG.compareMode
      ? STATE.corsFallback
        ? '目前：原畫'
        : '對比中'
      : '原畫對比';
    uiRefs.splitRow.style.display = CONFIG.compareMode && !STATE.corsFallback ? 'block' : 'none';
    uiRefs.fsBtn.textContent = STATE.pseudoFullscreen ? '退出全螢幕' : '全螢幕';

    if (uiRefs.corsRetryBtn) {
      uiRefs.corsRetryBtn.style.display = STATE.corsFallback ? 'block' : 'none';
      uiRefs.corsRetryBtn.disabled = STATE.corsRetrying;
      uiRefs.corsRetryBtn.textContent = STATE.corsRetrying
        ? '正在測試 CORS 重載...'
        : '嘗試以 CORS 模式重載影片（解鎖完整 WebGPU）';
    }

    if (uiRefs.edrBtn) {
      uiRefs.edrBtn.style.display = CONFIG.sdrToHdrLevel > 0 && !STATE.corsFallback ? 'block' : 'none';
      uiRefs.edrBtn.classList.toggle('active', CONFIG.enableEdr);
      uiRefs.edrBtn.textContent = `Apple 真 EDR 實體高光 (螢幕錄影會壓暗)：${CONFIG.enableEdr ? '開啟' : '關閉'}`;
    }

    uiRefs.denoiseBtn.classList.toggle('active', CONFIG.denoise);
    uiRefs.denoiseBtn.textContent = `串流壓縮去噪 (去除蚊式噪點)：${CONFIG.denoise ? '開啟' : '關閉'}`;

    uiRefs.engSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-eng') === CONFIG.engineMode);
    });
    uiRefs.presetSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', parseInt(b.getAttribute('data-preset'), 10) === CONFIG.presetLevel);
    });
    uiRefs.hdrSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', parseInt(b.getAttribute('data-hdr'), 10) === CONFIG.sdrToHdrLevel);
    });
  }

  function updateUIStats() {
    if (!uiRefs.statFps) return;
    uiRefs.statFps.textContent = String(STATE.stats.fps);
    uiRefs.statRes.textContent = STATE.stats.resolution;
    uiRefs.statHdr.textContent = STATE.stats.hdrBackend;
    uiRefs.fabText.textContent = CONFIG.enabled ? '超分中' : 'GPU 超分';

    if (STATE.stats.error) {
      uiRefs.errorBox.style.display = 'block';
      uiRefs.errorBox.textContent = STATE.stats.error;
    } else {
      uiRefs.errorBox.style.display = 'none';
    }
  }

  function safeMount() {
    try {
      mountUI();
    } catch (err) {
      console.error('[WebGPU-SR] UI 掛載失敗:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeMount, { once: true });
  } else {
    safeMount();
  }

  setInterval(() => {
    if (!document.getElementById('webgpu-sr-host') && document.body) {
      safeMount();
    }
  }, 2000);
})();
