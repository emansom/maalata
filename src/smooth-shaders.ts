/**
 * xBRZ Freescale Multipass Pixel Art Smoothing GLSL ES 3.00 Shaders
 *
 * Two-pass edge-aware pixel art scaler using YCbCr perceptual color distance
 * with dominant gradient detection, shallow/steep line classification, and
 * smoothstep-based sub-pixel blending at arbitrary scale factors.
 *
 * Pass 0 (analysis): Reads source at W×H, outputs packed blend metadata at W×H.
 *   3×3 core + extended neighbors (up to ±2 offset), DistYCbCr perceptual
 *   color distance (Rec.2020 luma weights), 4-corner blend classification
 *   (NONE/NORMAL/DOMINANT), shallow/steep line detection, doLineBlend flags.
 *   All packed as integers (blendResult + 4*doLineBlend + 16*shallow + 64*steep)
 *   then divided by 255.0 for RGBA8 storage (max value 86/255 ≈ 0.337).
 *
 * Pass 1 (freescale blend): Reads pass0 metadata + original source at 2W×2H.
 *   Decodes packed blend flags, for each active corner applies directional
 *   smoothstep blending via get_left_ratio() — signed distance from sub-pixel
 *   position to blend line with smoothstep(-√2/2, √2/2, v). Blends toward the
 *   perceptually-closer neighbor. "Freescale" = works at any scale factor.
 *
 * Both passes use CRT_VERTEX_SRC as vertex shader (no custom vertex shader
 * needed — analysis computes offsets per-fragment via texelSize * vec2(x, y)).
 *
 * Data flow:
 *   Ready texture (W × H) → [pass0 analysis] → Metadata texture (W × H) →
 *   [pass1 freescale blend with original source] → Upscaled texture (2W × 2H) →
 *   [RGSS downsample] → Smoothed texture (W × H) → CRT shader
 *
 * Adapted from libretro/glsl-shaders xbrz-freescale-multipass:
 *   https://github.com/libretro/glsl-shaders/tree/master/xbrz/shaders/xbrz-freescale-multipass
 *
 * Hyllian's xBR-vertex code and texel mapping — Copyright (C) 2011/2016 Hyllian (MIT)
 * xBRZ concepts from Desmume/HqMAME — Copyright (C) Zenju (GPL-3.0)
 *
 * Input Pixel Mapping (pass 0):
 *   -|x|x|x|-
 *   x|A|B|C|x      blendResult Mapping: x|y|
 *   x|D|E|F|x                           w|z|
 *   x|G|H|I|x
 *   -|x|x|x|-
 */

// ---------------------------------------------------------------------------
// Pass 0: xBRZ analysis fragment shader (W×H → W×H metadata)
// ---------------------------------------------------------------------------

/**
 * Fragment shader for pass 0: blend analysis and metadata output.
 *
 * Reads a 3×3 core neighborhood (A-I) plus extended neighbors for each corner.
 * Computes perceptual color distance (YCbCr) to classify each corner's blend
 * type (NONE/NORMAL/DOMINANT) and detect shallow/steep diagonal lines.
 *
 * Output is packed integer metadata / 255.0 stored in RGBA8 texture.
 * Each channel encodes one corner's blend info.
 *
 * Uniforms:
 *   u_source     — source texture (W × H), texture unit 0
 *   u_sourceSize — source dimensions (W, H)
 */
export const XBRZ_ANALYSIS_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;

uniform sampler2D u_source;
uniform vec2 u_sourceSize;

out vec4 fragColor;

#define BLEND_NONE 0
#define BLEND_NORMAL 1
#define BLEND_DOMINANT 2
#define LUMINANCE_WEIGHT 1.0
#define EQUAL_COLOR_TOLERANCE (30.0 / 255.0)
#define STEEP_DIRECTION_THRESHOLD 2.2
#define DOMINANT_DIRECTION_THRESHOLD 3.6

float DistYCbCr(vec3 pixA, vec3 pixB) {
  const vec3 w = vec3(0.2627, 0.6780, 0.0593);
  const float scaleB = 0.5 / (1.0 - w.b);
  const float scaleR = 0.5 / (1.0 - w.r);
  vec3 diff = pixA - pixB;
  float Y = dot(diff, w);
  float Cb = scaleB * (diff.b - Y);
  float Cr = scaleR * (diff.r - Y);
  return sqrt(((LUMINANCE_WEIGHT * Y) * (LUMINANCE_WEIGHT * Y)) + (Cb * Cb) + (Cr * Cr));
}

bool IsPixEqual(vec3 pixA, vec3 pixB) {
  return (DistYCbCr(pixA, pixB) < EQUAL_COLOR_TOLERANCE);
}

#define eq(a,b)  (a == b)
#define neq(a,b) (a != b)
#define P(x,y) texture(u_source, coord + texelSize * vec2(x, y)).rgb

void main() {
  // Bypass: test mode
  if (u_sourceSize.y < 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / u_sourceSize;
  vec2 pos = fract(v_texCoord * u_sourceSize) - vec2(0.5, 0.5);
  vec2 coord = v_texCoord - pos * texelSize;

  //  Input Pixel Mapping:  -|x|x|x|-
  //                        x|A|B|C|x
  //                        x|D|E|F|x
  //                        x|G|H|I|x
  //                        -|x|x|x|-

  vec3 A = P(-1.,-1.);
  vec3 B = P( 0.,-1.);
  vec3 C = P( 1.,-1.);
  vec3 D = P(-1., 0.);
  vec3 E = P( 0., 0.);
  vec3 F = P( 1., 0.);
  vec3 G = P(-1., 1.);
  vec3 H = P( 0., 1.);
  vec3 I = P( 1., 1.);

  // blendResult Mapping: x|y|
  //                      w|z|
  ivec4 blendResult = ivec4(BLEND_NONE);

  // --- Preprocess corners ---

  // Corner z: Pixel Tap Mapping: -|-|-|-|-
  //                              -|-|B|C|-
  //                              -|D|E|F|x
  //                              -|G|H|I|x
  //                              -|-|x|x|-
  if (!((eq(E,F) && eq(H,I)) || (eq(E,H) && eq(F,I)))) {
    float dist_H_F = DistYCbCr(G, E) + DistYCbCr(E, C) + DistYCbCr(P(0.,2.), I) + DistYCbCr(I, P(2.,0.)) + (4.0 * DistYCbCr(H, F));
    float dist_E_I = DistYCbCr(D, H) + DistYCbCr(H, P(1.,2.)) + DistYCbCr(B, F) + DistYCbCr(F, P(2.,1.)) + (4.0 * DistYCbCr(E, I));
    bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_H_F) < dist_E_I;
    blendResult.z = ((dist_H_F < dist_E_I) && neq(E,F) && neq(E,H)) ? ((dominantGradient) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
  }

  // Corner w: Pixel Tap Mapping: -|-|-|-|-
  //                              -|A|B|-|-
  //                              x|D|E|F|-
  //                              x|G|H|I|-
  //                              -|x|x|-|-
  if (!((eq(D,E) && eq(G,H)) || (eq(D,G) && eq(E,H)))) {
    float dist_G_E = DistYCbCr(P(-2.,1.), D) + DistYCbCr(D, B) + DistYCbCr(P(-1.,2.), H) + DistYCbCr(H, F) + (4.0 * DistYCbCr(G, E));
    float dist_D_H = DistYCbCr(P(-2.,0.), G) + DistYCbCr(G, P(0.,2.)) + DistYCbCr(A, E) + DistYCbCr(E, I) + (4.0 * DistYCbCr(D, H));
    bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_D_H) < dist_G_E;
    blendResult.w = ((dist_G_E > dist_D_H) && neq(E,D) && neq(E,H)) ? ((dominantGradient) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
  }

  // Corner y: Pixel Tap Mapping: -|-|x|x|-
  //                              -|A|B|C|x
  //                              -|D|E|F|x
  //                              -|-|H|I|-
  //                              -|-|-|-|-
  if (!((eq(B,C) && eq(E,F)) || (eq(B,E) && eq(C,F)))) {
    float dist_E_C = DistYCbCr(D, B) + DistYCbCr(B, P(1.,-2.)) + DistYCbCr(H, F) + DistYCbCr(F, P(2.,-1.)) + (4.0 * DistYCbCr(E, C));
    float dist_B_F = DistYCbCr(A, E) + DistYCbCr(E, I) + DistYCbCr(P(0.,-2.), C) + DistYCbCr(C, P(2.,0.)) + (4.0 * DistYCbCr(B, F));
    bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_B_F) < dist_E_C;
    blendResult.y = ((dist_E_C > dist_B_F) && neq(E,B) && neq(E,F)) ? ((dominantGradient) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
  }

  // Corner x: Pixel Tap Mapping: -|x|x|-|-
  //                              x|A|B|C|-
  //                              x|D|E|F|-
  //                              -|G|H|-|-
  //                              -|-|-|-|-
  if (!((eq(A,B) && eq(D,E)) || (eq(A,D) && eq(B,E)))) {
    float dist_D_B = DistYCbCr(P(-2.,0.), A) + DistYCbCr(A, P(0.,-2.)) + DistYCbCr(G, E) + DistYCbCr(E, C) + (4.0 * DistYCbCr(D, B));
    float dist_A_E = DistYCbCr(P(-2.,-1.), D) + DistYCbCr(D, H) + DistYCbCr(P(-1.,-2.), B) + DistYCbCr(B, F) + (4.0 * DistYCbCr(A, E));
    bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_D_B) < dist_A_E;
    blendResult.x = ((dist_D_B < dist_A_E) && neq(E,D) && neq(E,B)) ? ((dominantGradient) ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
  }

  fragColor = vec4(blendResult);

  // --- Refine: doLineBlend + shallow/steep line detection ---

  // Corner z
  if (blendResult.z == BLEND_DOMINANT || (blendResult.z == BLEND_NORMAL &&
      !((blendResult.y != BLEND_NONE && !IsPixEqual(E, G)) || (blendResult.w != BLEND_NONE && !IsPixEqual(E, C)) ||
        (IsPixEqual(G, H) && IsPixEqual(H, I) && IsPixEqual(I, F) && IsPixEqual(F, C) && !IsPixEqual(E, I))))) {
    fragColor.z += 4.0;
    float dist_F_G = DistYCbCr(F, G);
    float dist_H_C = DistYCbCr(H, C);
    if ((STEEP_DIRECTION_THRESHOLD * dist_F_G <= dist_H_C) && neq(E,G) && neq(D,G))
      fragColor.z += 16.0;
    if ((STEEP_DIRECTION_THRESHOLD * dist_H_C <= dist_F_G) && neq(E,C) && neq(B,C))
      fragColor.z += 64.0;
  }

  // Corner w
  if (blendResult.w == BLEND_DOMINANT || (blendResult.w == BLEND_NORMAL &&
      !((blendResult.z != BLEND_NONE && !IsPixEqual(E, A)) || (blendResult.x != BLEND_NONE && !IsPixEqual(E, I)) ||
        (IsPixEqual(A, D) && IsPixEqual(D, G) && IsPixEqual(G, H) && IsPixEqual(H, I) && !IsPixEqual(E, G))))) {
    fragColor.w += 4.0;
    float dist_H_A = DistYCbCr(H, A);
    float dist_D_I = DistYCbCr(D, I);
    if ((STEEP_DIRECTION_THRESHOLD * dist_H_A <= dist_D_I) && neq(E,A) && neq(B,A))
      fragColor.w += 16.0;
    if ((STEEP_DIRECTION_THRESHOLD * dist_D_I <= dist_H_A) && neq(E,I) && neq(F,I))
      fragColor.w += 64.0;
  }

  // Corner y
  if (blendResult.y == BLEND_DOMINANT || (blendResult.y == BLEND_NORMAL &&
      !((blendResult.x != BLEND_NONE && !IsPixEqual(E, I)) || (blendResult.z != BLEND_NONE && !IsPixEqual(E, A)) ||
        (IsPixEqual(I, F) && IsPixEqual(F, C) && IsPixEqual(C, B) && IsPixEqual(B, A) && !IsPixEqual(E, C))))) {
    fragColor.y += 4.0;
    float dist_B_I = DistYCbCr(B, I);
    float dist_F_A = DistYCbCr(F, A);
    if ((STEEP_DIRECTION_THRESHOLD * dist_B_I <= dist_F_A) && neq(E,I) && neq(H,I))
      fragColor.y += 16.0;
    if ((STEEP_DIRECTION_THRESHOLD * dist_F_A <= dist_B_I) && neq(E,A) && neq(D,A))
      fragColor.y += 64.0;
  }

  // Corner x
  if (blendResult.x == BLEND_DOMINANT || (blendResult.x == BLEND_NORMAL &&
      !((blendResult.w != BLEND_NONE && !IsPixEqual(E, C)) || (blendResult.y != BLEND_NONE && !IsPixEqual(E, G)) ||
        (IsPixEqual(C, B) && IsPixEqual(B, A) && IsPixEqual(A, D) && IsPixEqual(D, G) && !IsPixEqual(E, A))))) {
    fragColor.x += 4.0;
    float dist_D_C = DistYCbCr(D, C);
    float dist_B_G = DistYCbCr(B, G);
    if ((STEEP_DIRECTION_THRESHOLD * dist_D_C <= dist_B_G) && neq(E,C) && neq(F,C))
      fragColor.x += 16.0;
    if ((STEEP_DIRECTION_THRESHOLD * dist_B_G <= dist_D_C) && neq(E,G) && neq(H,G))
      fragColor.x += 64.0;
  }

  fragColor /= 255.0;
}
`;

// ---------------------------------------------------------------------------
// Pass 1: xBRZ freescale blend fragment shader (W×H + W×H → 2W×2H)
// ---------------------------------------------------------------------------

/**
 * Fragment shader for pass 1: freescale smoothstep blending.
 *
 * Reads pass0 metadata from u_source and original pixel colors from u_original.
 * Decodes packed blend flags, then for each active corner applies directional
 * smoothstep blending — computing signed distance from the sub-pixel position
 * to the blend line via get_left_ratio().
 *
 * "Freescale" means the shader works at any output scale factor (not just 2x).
 * Scale is derived from u_outputSize / u_sourceSize.
 *
 * Uniforms:
 *   u_source     — pass0 metadata texture (W × H), texture unit 0
 *   u_original   — original ready texture (W × H), texture unit 1
 *   u_sourceSize — original dimensions (W, H)
 *   u_outputSize — output dimensions (2W, 2H for our 2x pipeline)
 */
export const XBRZ_BLEND_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;

uniform sampler2D u_source;
uniform sampler2D u_original;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;

out vec4 fragColor;

#define BLEND_NONE 0.
#define BLEND_NORMAL 1.
#define BLEND_DOMINANT 2.
#define LUMINANCE_WEIGHT 1.0
#define EQUAL_COLOR_TOLERANCE (30.0 / 255.0)
#define STEEP_DIRECTION_THRESHOLD 2.2

float DistYCbCr(vec3 pixA, vec3 pixB) {
  const vec3 w = vec3(0.2627, 0.6780, 0.0593);
  const float scaleB = 0.5 / (1.0 - w.b);
  const float scaleR = 0.5 / (1.0 - w.r);
  vec3 diff = pixA - pixB;
  float Y = dot(diff, w);
  float Cb = scaleB * (diff.b - Y);
  float Cr = scaleR * (diff.r - Y);
  return sqrt(((LUMINANCE_WEIGHT * Y) * (LUMINANCE_WEIGHT * Y)) + (Cb * Cb) + (Cr * Cr));
}

bool IsPixEqual(vec3 pixA, vec3 pixB) {
  return (DistYCbCr(pixA, pixB) < EQUAL_COLOR_TOLERANCE);
}

float get_left_ratio(vec2 center, vec2 origin, vec2 direction, vec2 scale) {
  vec2 P0 = center - origin;
  vec2 proj = direction * (dot(P0, direction) / dot(direction, direction));
  vec2 distv = P0 - proj;
  vec2 orth = vec2(-direction.y, direction.x);
  float side = sign(dot(P0, orth));
  float v = side * length(distv * scale);
  return smoothstep(-sqrt(2.0) / 2.0, sqrt(2.0) / 2.0, v);
}

#define P(x,y) texture(u_original, coord + texelSize * vec2(x, y)).rgb

void main() {
  //  Input Pixel Mapping: -|B|-
  //                       D|E|F
  //                       -|H|-

  vec2 texelSize = 1.0 / u_sourceSize;
  vec2 scale = u_outputSize * texelSize;
  vec2 pos = fract(v_texCoord * u_sourceSize) - vec2(0.5, 0.5);
  vec2 coord = v_texCoord - pos * texelSize;

  vec3 B = P( 0.,-1.);
  vec3 D = P(-1., 0.);
  vec3 E = P( 0., 0.);
  vec3 F = P( 1., 0.);
  vec3 H = P( 0., 1.);

  vec4 info = floor(texture(u_source, coord) * 255.0 + 0.5);

  // info Mapping: x|y|
  //               w|z|

  vec4 blendResult = floor(mod(info, 4.0));
  vec4 doLineBlend = floor(mod(info / 4.0, 4.0));
  vec4 haveShallowLine = floor(mod(info / 16.0, 4.0));
  vec4 haveSteepLine = floor(mod(info / 64.0, 4.0));

  vec3 res = E;

  // Corner z: -|-|-
  //           -|E|F
  //           -|H|-
  if (blendResult.z > BLEND_NONE) {
    vec2 origin = vec2(0.0, 1.0 / sqrt(2.0));
    vec2 direction = vec2(1.0, -1.0);
    if (doLineBlend.z > 0.0) {
      origin = haveShallowLine.z > 0.0 ? vec2(0.0, 0.25) : vec2(0.0, 0.5);
      direction.x += haveShallowLine.z;
      direction.y -= haveSteepLine.z;
    }
    vec3 blendPix = mix(H, F, step(DistYCbCr(E, F), DistYCbCr(E, H)));
    res = mix(res, blendPix, get_left_ratio(pos, origin, direction, scale));
  }

  // Corner w: -|-|-
  //           D|E|-
  //           -|H|-
  if (blendResult.w > BLEND_NONE) {
    vec2 origin = vec2(-1.0 / sqrt(2.0), 0.0);
    vec2 direction = vec2(1.0, 1.0);
    if (doLineBlend.w > 0.0) {
      origin = haveShallowLine.w > 0.0 ? vec2(-0.25, 0.0) : vec2(-0.5, 0.0);
      direction.y += haveShallowLine.w;
      direction.x += haveSteepLine.w;
    }
    vec3 blendPix = mix(H, D, step(DistYCbCr(E, D), DistYCbCr(E, H)));
    res = mix(res, blendPix, get_left_ratio(pos, origin, direction, scale));
  }

  // Corner y: -|B|-
  //           -|E|F
  //           -|-|-
  if (blendResult.y > BLEND_NONE) {
    vec2 origin = vec2(1.0 / sqrt(2.0), 0.0);
    vec2 direction = vec2(-1.0, -1.0);
    if (doLineBlend.y > 0.0) {
      origin = haveShallowLine.y > 0.0 ? vec2(0.25, 0.0) : vec2(0.5, 0.0);
      direction.y -= haveShallowLine.y;
      direction.x -= haveSteepLine.y;
    }
    vec3 blendPix = mix(F, B, step(DistYCbCr(E, B), DistYCbCr(E, F)));
    res = mix(res, blendPix, get_left_ratio(pos, origin, direction, scale));
  }

  // Corner x: -|B|-
  //           D|E|-
  //           -|-|-
  if (blendResult.x > BLEND_NONE) {
    vec2 origin = vec2(0.0, -1.0 / sqrt(2.0));
    vec2 direction = vec2(-1.0, 1.0);
    if (doLineBlend.x > 0.0) {
      origin = haveShallowLine.x > 0.0 ? vec2(0.0, -0.25) : vec2(0.0, -0.5);
      direction.x -= haveShallowLine.x;
      direction.y += haveSteepLine.x;
    }
    vec3 blendPix = mix(D, B, step(DistYCbCr(E, B), DistYCbCr(E, D)));
    res = mix(res, blendPix, get_left_ratio(pos, origin, direction, scale));
  }

  fragColor = vec4(res, 1.0);
}
`;
