/**
 * CRT Post-Processing GLSL Shaders
 *
 * Combined from two open-source CRT shader implementations:
 *
 * - Ichiaka/CRTFilter v1.1.0 (MIT)
 *   https://github.com/Ichiaka/CRTFilter
 *   Original basis for the effects pipeline: barrel distortion, chromatic
 *   aberration, static noise, horizontal tearing, glow/bloom, vertical jitter,
 *   signal loss, scanlines, dot mask, desaturation, contrast/brightness, flicker.
 *
 * - gingerbeardman/webgl-crt-shader (MIT)
 *   https://github.com/gingerbeardman/webgl-crt-shader
 *   Performance optimizations adopted: early-out guards for disabled effects,
 *   out-of-bounds check after barrel distortion, vignette function (Chebyshev
 *   distance squared), `highp` precision selection via GL_FRAGMENT_PRECISION_HIGH,
 *   combined lighting mask (scanlines + flicker + vignette in single multiply),
 *   configurable scanline count uniform.
 *
 * - Blur Busters CRT Beam Simulator (MIT)
 *   https://github.com/blurbusters/crt-beam-simulator
 *   By Mark Rejhon (@BlurBusters) & Timothy Lottes (@NOTimothyLottes)
 *   Rolling scan BFI with phosphor decay and variable per-pixel MPRT.
 *   Adapted: 3-frame trailing buffer, interval overlap formula, gamma-correct
 *   operations, GAIN_VS_BLUR tradeoff, per-channel independent processing.
 *
 * Design decisions for the combined shader:
 * - Pipeline reordered so all UV modifications (jitter, tearing) happen before
 *   any texture reads, eliminating one redundant texture read from the original.
 * - Chromatic aberration conditional: 1 texture read when aberration ≈ 0,
 *   3 reads only when active. This is the biggest per-fragment win.
 * - Every effect block guarded by `> 0.0001` threshold check for early-out.
 * - Bool uniforms (u_retrace, u_dotMask) replaced with float intensity values
 *   so they participate in the same early-out pattern.
 * - Vignette from gingerbeardman added as part of the combined lighting mask.
 * - gingerbeardman's 5-tap bloom intentionally NOT adopted (4 extra texture
 *   reads per fragment); current smoothstep glow is much cheaper.
 * - Noise hash seeded with u_time for temporal variation (animated static).
 */

/**
 * Vertex shader: fullscreen quad [0,1] → clip space [-1,1].
 * Same coordinate mapping as the passthrough vertex shader in canvas-ultrafast.
 */
export const CRT_VERTEX_SRC = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = a_position;
    gl_Position = vec4(a_position * 2.0 - 1.0, 0, 1);
  }
`;

/**
 * Fragment shader: CRT effects pipeline (optimized).
 *
 * Pipeline order (UV modifications first, texture reads second):
 *  1. Barrel distortion + curvature → OOB early-out
 *  2. Vertical jitter (UV offset, conditional)
 *  3. Horizontal tearing (UV offset, conditional)
 *  4. Texture sampling — 4-way: BFI×aberration (1/3/3/9 reads)
 *  5. Linearize with CRT gamma (2.4, BT.1886)
 *  6. Static noise (linear)
 *  7. Glow/bloom (linear, adjusted threshold)
 *  8. Signal loss (linear)
 *  9. Combined lighting mask: scanlines + flicker + vignette (linear)
 * 10. Dot mask (linear)
 * 11. Encode with display gamma (2.2, sRGB)
 * 12. Color: desaturation → contrast → brightness (perceptual)
 */
export const CRT_FRAGMENT_SRC = `
  // gingerbeardman: highp precision selection for better quality on capable GPUs
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  varying vec2 v_texCoord;

  uniform sampler2D u_texture;
  uniform float u_time;
  uniform float u_barrel;
  uniform float u_aberration;
  uniform float u_noise;
  uniform float u_tearing;
  uniform float u_glow;
  uniform float u_jitter;
  uniform float u_brightness;
  uniform float u_contrast;
  uniform float u_desaturation;
  uniform float u_flicker;
  uniform float u_scanlineIntensity;
  uniform float u_scanlineCount;
  uniform float u_curvature;
  uniform float u_signalLoss;
  uniform float u_dotMask;
  uniform float u_vignetteStrength;

  // CRT gamma pipeline: BT.1886 decode + sRGB encode
  uniform float u_crtGamma;      // CRT native gamma (default 2.4, BT.1886)
  uniform float u_displayGamma;  // Display output gamma (default 2.2, sRGB)

  // Blur Busters: BFI rolling scan uniforms
  uniform sampler2D u_framePrev2;    // 2 CRT cycles ago
  uniform sampler2D u_framePrev1;    // 1 CRT cycle ago
  uniform sampler2D u_frameCurr;     // current CRT cycle
  uniform float u_bfiStrength;       // 0 = off, > 0 = BFI active
  uniform float u_bfiPhase;          // 0-1 beam scan position
  uniform float u_bfiFramesPerHz;    // displayHz / crtHz
  uniform float u_bfiGainVsBlur;     // brightness vs motion blur tradeoff

  // Blur Busters: gamma-correct operations prevent horizontal banding
  const float BFI_GAMMA = 2.2;
  vec3 bfiToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(BFI_GAMMA)); }
  vec3 bfiToGamma(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / BFI_GAMMA)); }

  // CRT gamma pipeline helpers
  vec3 crtLinearize(vec3 c) { return pow(max(c, vec3(0.0)), vec3(u_crtGamma)); }
  vec3 crtEncode(vec3 c)    { return pow(max(c, vec3(0.0)), vec3(1.0 / u_displayGamma)); }

  // Blur Busters rolling scan with phosphor decay + variable MPRT
  // Ported from getPixelFromSimulatedCRT in crt-simulator.glsl
  vec3 bfiCompute(vec3 pixPrev2, vec3 pixPrev1, vec3 pixCurr) {
    vec3 linPrev2 = bfiToLinear(pixPrev2);
    vec3 linPrev1 = bfiToLinear(pixPrev1);
    vec3 linCurr  = bfiToLinear(pixCurr);

    // Photon budget: brighter pixels persist across more sub-frames (variable MPRT)
    float brightnessScale = u_bfiFramesPerHz * u_bfiGainVsBlur;
    vec3 cPrev2 = linPrev2 * brightnessScale;
    vec3 cPrev1 = linPrev1 * brightnessScale;
    vec3 cCurr  = linCurr * brightnessScale;

    // Physical scan position (top=0, bottom=1), undistorted
    float tubePos = 1.0 - v_texCoord.y;

    // Current native frame's interval in CRT-cycle frame space
    float tubeFrame = tubePos * u_bfiFramesPerHz;
    float fStart = u_bfiPhase * u_bfiFramesPerHz;
    float fEnd = fStart + 1.0;

    vec3 result = vec3(0.0);

    // Per-channel: compute overlap between phosphor emission and current frame interval
    for (int ch = 0; ch < 3; ch++) {
      float Lprev2 = cPrev2[ch];
      float Lprev1 = cPrev1[ch];
      float Lcurr  = cCurr[ch];
      if (Lprev2 <= 0.0 && Lprev1 <= 0.0 && Lcurr <= 0.0) continue;

      float s2 = tubeFrame - u_bfiFramesPerHz;
      float s1 = tubeFrame;
      float s0 = tubeFrame + u_bfiFramesPerHz;

      result[ch] = max(0.0, min(s2 + Lprev2, fEnd) - max(s2, fStart))
                 + max(0.0, min(s1 + Lprev1, fEnd) - max(s1, fStart))
                 + max(0.0, min(s0 + Lcurr,  fEnd) - max(s0, fStart));
    }

    return bfiToGamma(result);
  }

  // Ichiaka: barrel distortion — same math in both implementations
  vec2 barrelDistortion(vec2 uv, float amount) {
    vec2 centered = uv - 0.5;
    float dist = dot(centered, centered);
    return uv + centered * dist * amount;
  }

  // gingerbeardman: vignette using Chebyshev distance squared
  // Cheaper than radial distance and produces a natural screen-edge darkening
  float vignette(vec2 uv, float strength) {
    vec2 d = abs(uv - 0.5) * 2.0;
    float v = max(d.x, d.y);        // Chebyshev distance
    return 1.0 - strength * v * v;   // squared falloff
  }

  void main() {
    vec2 uv = v_texCoord;

    // --- 1. Barrel distortion + curvature (Ichiaka) ---
    uv = barrelDistortion(uv, u_barrel + u_curvature);

    // gingerbeardman: OOB early-out after distortion — avoids all further work
    // for pixels that land outside the texture. Returns black immediately.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // --- 2. Vertical jitter (Ichiaka, moved before texture reads) ---
    // Originally applied after texture reads; moved here so the offset is
    // baked into the UV before sampling, saving a redundant texture read.
    if (u_jitter > 0.0001) {
      uv.y += sin(u_time * 5.0) * u_jitter;
    }

    // --- 3. Horizontal tearing (Ichiaka, moved before texture reads) ---
    // Originally applied after chromatic aberration, requiring a 4th texture
    // read. Moving the UV offset here eliminates that extra read entirely.
    if (u_tearing > 0.0001) {
      uv.x += sin(uv.y * 10.0 + u_time * 2.0) * u_tearing;
    }

    // --- 4. Texture sampling (combined optimization) ---
    // 4-way branch: BFI × aberration. When BFI active, sample from 3-frame
    // history buffer via bfiCompute(); when off, original u_texture path.
    vec3 col;
    if (u_bfiStrength > 0.0001) {
      if (u_aberration > 0.0001) {
        // BFI + aberration: 9 reads (3 frames × 3 UV offsets)
        vec2 uvR = uv + vec2(u_aberration, 0.0);
        vec2 uvB = uv - vec2(u_aberration, 0.0);
        vec3 p2 = vec3(texture2D(u_framePrev2, uvR).r, texture2D(u_framePrev2, uv).g, texture2D(u_framePrev2, uvB).b);
        vec3 p1 = vec3(texture2D(u_framePrev1, uvR).r, texture2D(u_framePrev1, uv).g, texture2D(u_framePrev1, uvB).b);
        vec3 p0 = vec3(texture2D(u_frameCurr,  uvR).r, texture2D(u_frameCurr,  uv).g, texture2D(u_frameCurr,  uvB).b);
        col = bfiCompute(p2, p1, p0);
      } else {
        // BFI only: 3 reads (one per history texture)
        col = bfiCompute(
          texture2D(u_framePrev2, uv).rgb,
          texture2D(u_framePrev1, uv).rgb,
          texture2D(u_frameCurr, uv).rgb
        );
      }
    } else if (u_aberration > 0.0001) {
      // Aberration only: 3 reads from u_texture
      col.r = texture2D(u_texture, uv + vec2(u_aberration, 0.0)).r;
      col.g = texture2D(u_texture, uv).g;
      col.b = texture2D(u_texture, uv - vec2(u_aberration, 0.0)).b;
    } else {
      // No BFI, no aberration: 1 read
      col = texture2D(u_texture, uv).rgb;
    }

    // --- 5. Linearize with CRT gamma (BT.1886) ---
    col = crtLinearize(col);

    // --- 6. Static noise (Ichiaka, enhanced with temporal variation) ---
    // Original used only UV for hash seed, producing a static pattern.
    // Adding u_time makes the noise animate, which is more CRT-authentic.
    if (u_noise > 0.0001) {
      float n = fract(sin(dot(uv.xy + u_time * 0.01, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * u_noise;
    }

    // --- 7. Glow/bloom (Ichiaka) ---
    // Cheap smoothstep-based glow. gingerbeardman uses a 5-tap bloom (4 extra
    // texture reads) which we intentionally skip for performance.
    // Threshold adjusted for linear space: 0.2 linear ≈ 0.5 sRGB
    if (u_glow > 0.0001) {
      col += u_glow * smoothstep(0.2, 1.0, col);
    }

    // --- 8. Signal loss (Ichiaka) ---
    if (u_signalLoss > 0.0001) {
      col *= 1.0 - (u_signalLoss * abs(sin(uv.y * 50.0 + u_time * 10.0)));
    }

    // --- 9. Combined lighting mask (gingerbeardman pattern) ---
    // Combine scanlines, flicker, and vignette into a single multiplier.
    // One multiply is cheaper than three separate multiply operations.
    float mask = 1.0;

    // Scanlines (Ichiaka effect, gingerbeardman's configurable count pattern)
    // Fixed: original had 1.9 + intensity*sin() which amplified brightness 1.3-2.5x.
    // That compensated for a double-multiplication bug in CRTFilter that maalata doesn't have.
    // New formula: dark lines at (1-intensity), bright lines at 1.0, no amplification.
    if (u_scanlineIntensity > 0.0001) {
      mask *= 1.0 - u_scanlineIntensity * 0.5 * (1.0 - sin(uv.y * u_scanlineCount + u_time * 10.0));
    }

    // Flicker (Ichiaka)
    if (u_flicker > 0.0001) {
      mask *= 1.0 + u_flicker * sin(u_time * 60.0);
    }

    // Vignette (gingerbeardman: Chebyshev distance squared)
    if (u_vignetteStrength > 0.0001) {
      mask *= vignette(uv, u_vignetteStrength);
    }

    col *= mask;

    // --- 10. Dot mask (Ichiaka, converted from bool to float intensity) ---
    // Original was a bool uniform; now float so it participates in early-out
    // pattern and allows variable intensity.
    if (u_dotMask > 0.0001) {
      vec3 dotEffect = vec3(
        1.0,
        0.9 + 0.1 * mod(uv.x * 100.0, 2.0),
        0.9 + 0.1 * mod(uv.y * 100.0, 2.0)
      );
      col *= mix(vec3(1.0), dotEffect, u_dotMask);
    }

    // --- 11. Encode with display gamma (sRGB) ---
    col = crtEncode(col);

    // --- 12. Color adjustments (Ichiaka, perceptual/gamma-encoded space) ---
    // Desaturation
    if (u_desaturation > 0.0001) {
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), u_desaturation);
    }

    // Contrast
    col = (col - 0.5) * u_contrast + 0.5;

    // Brightness
    col *= u_brightness;

    gl_FragColor = vec4(col, 1.0);
  }
`;
