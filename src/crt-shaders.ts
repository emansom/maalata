/**
 * CRT Post-Processing GLSL Shaders
 *
 * Combined from two open-source CRT shader implementations:
 *
 * - Ichiaka/CRTFilter v1.1.0 (MIT)
 *   https://github.com/Ichiaka/CRTFilter
 *   Original basis for the effects pipeline: barrel distortion, chromatic
 *   aberration, static noise, horizontal tearing, glow/bloom, vertical jitter,
 *   signal loss, desaturation, contrast/brightness, flicker.
 *
 * - gingerbeardman/webgl-crt-shader (MIT)
 *   https://github.com/gingerbeardman/webgl-crt-shader
 *   Performance optimizations adopted: early-out guards for disabled effects,
 *   out-of-bounds check after barrel distortion, vignette function (Chebyshev
 *   distance squared), `highp` precision selection via GL_FRAGMENT_PRECISION_HIGH,
 *   combined lighting mask (flicker + vignette in single multiply).
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
 * - Pixel beam (Gaussian CRT phosphor dots) replaced both sin-based scanlines
 *   and mod-based dot mask — matches real CRT physics where beam cross-section
 *   creates both pixel shapes and scanline gaps as a single effect. Pixel art
 *   scale auto-detected per-fragment from texture color boundaries.
 * - Vignette from gingerbeardman added as part of the combined lighting mask.
 * - gingerbeardman's 5-tap bloom intentionally NOT adopted (4 extra texture
 *   reads per fragment); current smoothstep glow is much cheaper.
 * - Noise hash seeded with u_time for temporal variation (animated static).
 *
 * CRT colorspace pipeline (BT.1886 → sRGB):
 *
 * The shader simulates a 2002-era PC CRT monitor viewed on a modern sRGB display.
 * Input arrives as sRGB-encoded values from Canvas 2D API via RGBA textures
 * (canvas-ultrafast uses gl.RGBA8 — no EXT_sRGB, no hardware decode).
 * Output goes to gl_FragColor which the browser composites as sRGB
 * (WebGL has no automatic linear-to-sRGB encode on the default framebuffer).
 *
 * Pipeline: decode γ=2.4 (BT.1886 CRT) → effects in linear → encode γ=2.2 (sRGB)
 *
 * Why γ=2.4 decode (not 2.2):
 *   BT.1886 (ITU-R, 2011) codifies actual CRT phosphor response as a pure power
 *   law with γ=2.4. Real PC CRT tubes measured 2.2–2.5; 2.4 is the standard
 *   reference. The sRGB standard's "effective γ=2.2" is lower because it accounts
 *   for viewing environment — it was never the CRT's native response.
 *
 * Why simple pow() (not piecewise sRGB):
 *   CRTs had no linear toe segment near black — they clipped to zero. The sRGB
 *   piecewise curve (linear segment below 0.0031308) was designed for digital
 *   displays. Using pow() for both decode and encode is more physically accurate.
 *
 * Why no color primary conversion:
 *   2002-era PC monitors used P22 phosphors whose primaries are nearly identical
 *   to sRGB/Rec.709, both with D65 white point. Color matrix conversion (as done
 *   by Dolphin emulator for NTSC-M/NTSC-J/PAL TV standards) is not needed for
 *   PC CRT simulation. See: Dolphin PR #11850, dolphin-emu.org progress report
 *   May–July 2023.
 *
 * Net effect: γ_net = 2.4/2.2 ≈ 1.09 — midtones render ~3% darker, producing
 * the subtle contrast boost characteristic of CRT viewing. This matches what
 * users experienced in 2002: sRGB-encoded content displayed on a γ=2.4 tube
 * was slightly punchier than on today's calibrated sRGB LCDs.
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
 *  9. Lighting mask: flicker + vignette (linear)
 * 10. Pixel beam: 2D Gaussian CRT phosphor dot, per-region scale auto-detection
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
  uniform float u_curvature;
  uniform float u_signalLoss;
  uniform float u_vignetteStrength;
  uniform vec2 u_inputSize;
  uniform vec3 u_bgColor;

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
      gl_FragColor = vec4(u_bgColor, 1.0);
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
    // Input from texture2D() is sRGB-encoded (RGBA texture, no hw decode).
    // Decode with CRT gamma (2.4) to get linear light as a real CRT would produce.
    // See file header "CRT colorspace pipeline" for full rationale.
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

    // --- 9. Combined lighting mask: flicker + vignette (linear) ---
    // Scanline gaps are now created by the pixel beam's vertical Gaussian
    // profile (step 10), matching real CRT behavior where scan line gaps
    // were a natural result of beam cross-section, not a separate effect.
    float mask = 1.0;

    // Flicker (Ichiaka)
    if (u_flicker > 0.0001) {
      mask *= 1.0 + u_flicker * sin(u_time * 60.0);
    }

    // Vignette (gingerbeardman: Chebyshev distance squared)
    if (u_vignetteStrength > 0.0001) {
      mask *= vignette(uv, u_vignetteStrength);
    }

    col *= mask;

    // --- 10. Pixel beam (Gaussian CRT phosphor dot, per-region auto-detection) ---
    // Replaces both the sin-based scanlines and mod-based dot mask with a
    // unified 2D Gaussian beam model. On a real CRT, the electron beam has
    // a Gaussian cross-section that creates both the pixel dot shape AND the
    // scanline gaps — they are the same physical effect.
    //
    // For each fragment, search up/down/left/right in the raw texture to
    // find the uniform-color block this texel belongs to. This detects
    // pixel art that has been scaled up by any factor (2x-8x) and adapts
    // the beam to match, even when different canvas regions use different
    // scale factors.
    //
    // Cost: up to 33 texture reads (1 center + 8x4 directions), reduced
    // by early-out at color boundaries. Interior of 4x art: ~17 reads.
    // 1x content or edges: ~5 reads.
    //
    // u_inputSize.y < 1.0 bypasses the beam (used by verify-demo tests
    // that need a clean signal for gamma/passthrough measurements).
    if (u_inputSize.y > 0.5) {
      vec2 texel = 1.0 / u_inputSize;
      vec3 ref = texture2D(u_texture, uv).rgb;

      float dUp = 0.0;
      for (int i = 1; i <= 8; i++) {
        vec2 s = uv - vec2(0.0, float(i) * texel.y);
        if (s.y < 0.0 || distance(texture2D(u_texture, s).rgb, ref) > 0.02) break;
        dUp += 1.0;
      }
      float dDown = 0.0;
      for (int i = 1; i <= 8; i++) {
        vec2 s = uv + vec2(0.0, float(i) * texel.y);
        if (s.y > 1.0 || distance(texture2D(u_texture, s).rgb, ref) > 0.02) break;
        dDown += 1.0;
      }
      float dLeft = 0.0;
      for (int i = 1; i <= 8; i++) {
        vec2 s = uv - vec2(float(i) * texel.x, 0.0);
        if (s.x < 0.0 || distance(texture2D(u_texture, s).rgb, ref) > 0.02) break;
        dLeft += 1.0;
      }
      float dRight = 0.0;
      for (int i = 1; i <= 8; i++) {
        vec2 s = uv + vec2(float(i) * texel.x, 0.0);
        if (s.x > 1.0 || distance(texture2D(u_texture, s).rgb, ref) > 0.02) break;
        dRight += 1.0;
      }

      // Block dimensions in canvas pixels
      vec2 blockSize = vec2(dLeft + dRight + 1.0, dUp + dDown + 1.0);

      // Fragment's normalized distance from block center: [-0.5, 0.5]
      vec2 dist = vec2(
        (dLeft - (blockSize.x - 1.0) * 0.5) / blockSize.x,
        (dUp   - (blockSize.y - 1.0) * 0.5) / blockSize.y
      );

      // Brightness-dependent beam width
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float sigma = 0.35 * (0.6 + 0.65 * sqrt(lum));

      // 2D Gaussian beam profile → round phosphor dot shape
      col *= exp(-dot(dist, dist) / (2.0 * sigma * sigma));
    }

    // --- 11. Encode with display gamma (sRGB) ---
    // Re-encode to sRGB for the browser's default framebuffer (no hw encode).
    // Net gamma 2.4/2.2 = 1.09 produces authentic CRT contrast boost.
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
