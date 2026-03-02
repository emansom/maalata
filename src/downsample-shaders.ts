/**
 * EWA Smooth Downsample GLSL ES 3.00 Shader
 *
 * Downsamples a texture using an Elliptical Weighted Average (EWA) filter with
 * a raised-cosine envelope in polar coordinates. Treats the source image as a
 * continuous surface rather than a pixel grid — produces maximum smoothness
 * with zero ringing artifacts.
 *
 * Properties:
 *   - Raised-cosine envelope: all-positive weights, no negative lobes, zero ringing
 *   - Polar/EWA symmetry: treats all edge angles identically (like continuous geometry)
 *   - Wide support (SUPPORT=1.5): extends 0.5 output pixels beyond each pixel footprint
 *   - Smooth rolloff: both center and edges fade smoothly (no hard cutoffs)
 *   - Better than Gaussian: sharper frequency cutoff (Gaussian never reaches zero)
 *
 * Used by SmoothingDisplay as the final stage:
 *   Upscaled texture (3W × 3H) → Native texture (W × H)
 *
 * Also used by screenshotUpscaled() for GPU-based 3×→2× downsample:
 *   Upscaled texture (3W × 3H) → Screenshot texture (2W × 2H)
 *
 * The u_downscaleFactor uniform adapts the kernel:
 *   - 3.0: halfScale=1.5, support extends 2.25 source texels from center (~32 of 64 samples)
 *   - 1.5: halfScale=0.75, support extends 1.125 source texels from center (~16 of 64 samples)
 *
 * 8×8 grid (64 taps). The raised-cosine weight:
 *   w = (1 + cos(π * d / SUPPORT)) / 2, where d = polar distance in output-pixel space
 *   All samples with d ≥ SUPPORT are skipped (zero weight).
 *
 * Source texture uses NEAREST filtering for point-sampled reads — each sample
 * reads exactly one source texel with no hardware interpolation.
 *
 * Reuses CRT_VERTEX_SRC from crt-shaders.ts (same fullscreen quad).
 */

/**
 * Fragment shader: EWA smooth 8×8 downsample.
 *
 * Uniforms:
 *   u_texture          -- upscaled texture (3W × 3H)
 *   u_sourceSize       -- dimensions of the upscaled texture (3W, 3H)
 *   u_downscaleFactor  -- downsample ratio (3.0 for main pipeline, 1.5 for screenshots)
 */
export const DOWNSAMPLE_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;

uniform sampler2D u_texture;
uniform vec2 u_sourceSize;
uniform float u_downscaleFactor;

out vec4 fragColor;

const float PI = 3.14159265;
const float SUPPORT = 1.5;

void main() {
  vec2 texelSize = 1.0 / u_sourceSize;
  float halfScale = u_downscaleFactor * 0.5;

  vec3 color = vec3(0.0);
  float totalWeight = 0.0;

  for (int dy = 0; dy < 8; dy++) {
    for (int dx = 0; dx < 8; dx++) {
      vec2 offset = vec2(float(dx) - 3.5, float(dy) - 3.5);
      float d = length(offset) / halfScale;

      if (d >= SUPPORT) continue;

      // Raised-cosine: smooth bell curve, all-positive, zero at SUPPORT
      float w = (1.0 + cos(PI * d / SUPPORT)) * 0.5;
      color += texture(u_texture, v_texCoord + offset * texelSize).rgb * w;
      totalWeight += w;
    }
  }

  fragColor = vec4(color / totalWeight, 1.0);
}
`;
