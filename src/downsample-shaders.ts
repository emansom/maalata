/**
 * RGSS 4x Downsample GLSL Shader
 *
 * Downsamples a 4x (2× per dimension) texture back to native resolution
 * using Rotated Grid SuperSampling (RGSS). Each output pixel averages 4
 * samples from the source texture at rotated grid positions, producing
 * high-quality anti-aliased edges from the Kopf-Lischinski smoothing pass.
 *
 * Data flow:
 *   Smoothed 4x texture (2W×2H) → [this shader] → Native texture (W×H)
 *
 * RGSS sample offsets (in output pixel units, 1 output pixel = 2 source texels):
 *   (-3/8, -1/8)    ( 1/8, -3/8)
 *   (-1/8,  3/8)    ( 3/8,  1/8)
 *
 * The rotated grid avoids axis-aligned sampling artifacts that a regular
 * 2×2 box filter would produce. RGSS is the same pattern used by hardware
 * MSAA at 4× and provides optimal edge anti-aliasing for the cost of 4
 * texture reads per output fragment.
 *
 * Source texture uses NEAREST filtering for point-sampled RGSS — each
 * sample reads exactly one source texel with no hardware interpolation.
 *
 * Reuses CRT_VERTEX_SRC from crt-shaders.ts (same fullscreen quad).
 */

/**
 * Fragment shader: RGSS 4x downsample.
 *
 * Uniforms:
 *   u_texture    — 4x smoothed texture (2W × 2H)
 *   u_sourceSize — dimensions of the 4x texture (2W, 2H)
 */
export const DOWNSAMPLE_FRAGMENT_SRC = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  varying vec2 v_texCoord;

  uniform sampler2D u_texture;
  uniform vec2 u_sourceSize;

  void main() {
    vec2 uv = v_texCoord;
    vec2 outPx = 2.0 / u_sourceSize;  // 1 output pixel = 2 source texels

    vec3 c  = texture2D(u_texture, uv + vec2(-0.375, -0.125) * outPx).rgb;
         c += texture2D(u_texture, uv + vec2( 0.125, -0.375) * outPx).rgb;
         c += texture2D(u_texture, uv + vec2( 0.375,  0.125) * outPx).rgb;
         c += texture2D(u_texture, uv + vec2(-0.125,  0.375) * outPx).rgb;

    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`;
