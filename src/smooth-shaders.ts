/**
 * ScaleFX + Sharpsmoother + AA Level2 Pixel Art Smoothing GLSL ES 3.00 Shaders
 *
 * Eight fragment shaders forming a multi-pass edge-aware pixel art scaler using
 * Compuphase perceptual color distance, 6-level edge classification with precise
 * slope detection, edge-preserving smoothing, and multi-directional anti-aliasing.
 *
 * Pipeline (all passes use CRT_VERTEX_SRC as vertex shader):
 *   Pass 0: ScaleFX metric — Compuphase color distance to 4 neighbors (W×H → W×H RGBA16F)
 *   Pass 1: ScaleFX strength — corner interpolation strength (W×H → W×H RGBA16F)
 *   Pass 2: ScaleFX ambiguity — dominance voting, orientation packing (W×H → W×H RGBA8)
 *   Pass 3: ScaleFX edge level — 6-level classification, subpixel tags (W×H → W×H RGBA8)
 *   Pass 4: ScaleFX 3× output — tag decode → source pixel color lookup (W×H → 3W×3H RGBA8)
 *   Pass 5: Sharpsmoother — edge-preserving 3×3 perceptual-weighted smoothing (3W×3H → 3W×3H)
 *   Pass 6: AA level2 pass 1 — 13-point directional AA (3W×3H → 3W×3H)
 *   Pass 7: AA level2 pass 2 — 4-point diagonal AA (3W×3H → 3W×3H)
 *
 * Texture bindings per pass:
 *   Pass 0: u_source = original input
 *   Pass 1: u_source = pass 0 metric
 *   Pass 2: u_source = pass 1 strength, u_metricTex = pass 0 metric
 *   Pass 3: u_source = pass 2 ambiguity
 *   Pass 4: u_source = pass 3 edge level, u_originalTex = original input
 *   Pass 5-7: u_source = previous pass output
 *
 * Sources:
 *   ScaleFX (MIT, Sp00kyFox 2016-2017) — edge interpolation specialized in pixel art
 *     https://github.com/libretro/glsl-shaders/tree/master/edge-smoothing/scalefx
 *   Sharpsmoother (GPL v2+, guest(r) 2005-2017) — edge-preserving color smoothing
 *     https://github.com/libretro/glsl-shaders/blob/master/blurs/shaders/sharpsmoother.glsl
 *   AA Shader 4.0 Level2 (GPL v2+, guest(r) 2007-2016) — directional anti-aliasing
 *     https://github.com/libretro/glsl-shaders/tree/master/anti-aliasing/shaders/aa-shader-4.0-level2
 *   Compuphase perceptual color distance — http://www.compuphase.com/cmetric.htm
 *
 * Ported from libretro GLSL 1.30 → GLSL ES 3.00 for maalata.
 * Hardcoded preset parameters (xsoft+scalefx-level2aa+sharpsmoother):
 *   SFX_CLR=0.60, SFX_SAA=0.0, SFX_SCN=1.0, AAOFFSET=1.0, AAOFFSET2=0.5
 *   Sharpsmoother: max_w=0.10, min_w=-0.07, smoot=0.55, lumad=0.30, mtric=0.70
 */

// ---------------------------------------------------------------------------
// Pass 0: ScaleFX metric (W×H → W×H RGBA16F)
// ---------------------------------------------------------------------------

/**
 * Computes Compuphase perceptual color distance from center pixel E to four
 * neighbors: A (-1,-1), B (0,-1), C (1,-1), F (1,0). Output stored in RGBA16F.
 *
 * Uniforms:
 *   u_source     — original input texture (W × H), texture unit 0
 *   u_sourceSize — source dimensions (W, H)
 */
export const SCALEFX_PASS0_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

// Compuphase perceptual color distance
// Reference: http://www.compuphase.com/cmetric.htm
float dist(vec3 A, vec3 B) {
  float r = 0.5 * (A.r + B.r);
  vec3 d = A - B;
  vec3 c = vec3(2.0 + r, 4.0, 3.0 - r);
  return sqrt(dot(c * d, d)) / 3.0;
}

void main() {
  vec2 ts = 1.0 / u_sourceSize;

  /*  grid      metric
      A B C     x y z
        E F       o w  */

  vec3 A = texture(u_source, v_texCoord + ts * vec2(-1.0, -1.0)).rgb;
  vec3 B = texture(u_source, v_texCoord + ts * vec2( 0.0, -1.0)).rgb;
  vec3 C = texture(u_source, v_texCoord + ts * vec2( 1.0, -1.0)).rgb;
  vec3 E = texture(u_source, v_texCoord).rgb;
  vec3 F = texture(u_source, v_texCoord + ts * vec2( 1.0,  0.0)).rgb;

  fragColor = vec4(dist(E, A), dist(E, B), dist(E, C), dist(E, F));
}
`;

// ---------------------------------------------------------------------------
// Pass 1: ScaleFX strength (W×H → W×H RGBA16F)
// ---------------------------------------------------------------------------

/**
 * Calculates corner interpolation strength from pass 0 metric data.
 * Reads 3×3 neighborhood of metric vectors (9 texture reads).
 * SFX_CLR=0.60 (threshold), SFX_SAA=0.0 (no filter AA).
 *
 * Uniforms:
 *   u_source     — pass 0 metric texture (W × H), texture unit 0
 *   u_sourceSize — source dimensions (W, H)
 */
export const SCALEFX_PASS1_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define SFX_CLR 0.60
#define SFX_SAA 0.0

// Corner strength: evaluates interpolation weight based on color distances
float str(float d, vec2 a, vec2 b) {
  float diff = a.x - a.y;
  float wght1 = max(SFX_CLR - d, 0.0) / SFX_CLR;
  float wght2 = clamp((1.0 - d) + (min(a.x, b.x) + a.x > min(a.y, b.y) + a.y ? diff : -diff), 0.0, 1.0);
  return (SFX_SAA == 1.0 || 2.0 * d < a.x + a.y) ? (wght1 * wght2) * (a.x * a.y) : 0.0;
}

void main() {
  vec2 ts = 1.0 / u_sourceSize;

  /*  grid      metric      pattern
      A B       x y z       x y
      D E F       o w       w z
      G H I                       */

  #define TEX(x, y) texture(u_source, v_texCoord + ts * vec2(x, y))

  vec4 A = TEX(-1.0, -1.0), B = TEX( 0.0, -1.0);
  vec4 D = TEX(-1.0,  0.0), E = TEX( 0.0,  0.0), F = TEX( 1.0,  0.0);
  vec4 G = TEX(-1.0,  1.0), H = TEX( 0.0,  1.0), I = TEX( 1.0,  1.0);

  vec4 res;
  res.x = str(D.z, vec2(D.w, E.y), vec2(A.w, D.y));
  res.y = str(F.x, vec2(E.w, E.y), vec2(B.w, F.y));
  res.z = str(H.z, vec2(E.w, H.y), vec2(H.w, I.y));
  res.w = str(H.x, vec2(D.w, H.y), vec2(G.w, G.y));

  fragColor = res;
}
`;

// ---------------------------------------------------------------------------
// Pass 2: ScaleFX ambiguity (W×H → W×H RGBA8)
// ---------------------------------------------------------------------------

/**
 * Resolves ambiguous corner configurations at pixel junctions via dominance
 * voting. Reads metric data (pass 0) and strength data (pass 1).
 * Packs: (res + 2*hori + 4*vert + 8*orient) / 15.0 per channel.
 *
 * Uniforms:
 *   u_source     — pass 1 strength texture (W × H), texture unit 0
 *   u_metricTex  — pass 0 metric texture (W × H), texture unit 1
 *   u_sourceSize — source dimensions (W, H)
 */
export const SCALEFX_PASS2_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform sampler2D u_metricTex;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define LE(x, y) (1.0 - step(y, x))
#define GE(x, y) (1.0 - step(x, y))
#define LEQ(x, y) step(x, y)
#define GEQ(x, y) step(y, x)
#define NOT(x) (1.0 - (x))

// Corner dominance at junctions
vec4 dom(vec3 x, vec3 y, vec3 z, vec3 w) {
  return 2.0 * vec4(x.y, y.y, z.y, w.y) - (vec4(x.x, y.x, z.x, w.x) + vec4(x.z, y.z, z.z, w.z));
}

// Junction condition for orthogonal edges
float clear(vec2 crn, vec2 a, vec2 b) {
  return (crn.x >= max(min(a.x, a.y), min(b.x, b.y))) && (crn.y >= max(min(a.x, b.y), min(b.x, a.y))) ? 1.0 : 0.0;
}

void main() {
  vec2 ts = 1.0 / u_sourceSize;

  /*  grid      metric      pattern
      A B C     x y z       x y
      D E F       o w       w z
      G H I                       */

  // Metric data (pass 0)
  #define TEXm(x, y) texture(u_metricTex, v_texCoord + ts * vec2(x, y))

  vec4 A = TEXm(-1.0, -1.0), B = TEXm( 0.0, -1.0);
  vec4 D = TEXm(-1.0,  0.0), E = TEXm( 0.0,  0.0), F = TEXm( 1.0,  0.0);
  vec4 G = TEXm(-1.0,  1.0), H = TEXm( 0.0,  1.0), I = TEXm( 1.0,  1.0);

  // Strength data (pass 1)
  #define TEXs(x, y) texture(u_source, v_texCoord + ts * vec2(x, y))

  vec4 As = TEXs(-1.0, -1.0), Bs = TEXs( 0.0, -1.0), Cs = TEXs( 1.0, -1.0);
  vec4 Ds = TEXs(-1.0,  0.0), Es = TEXs( 0.0,  0.0), Fs = TEXs( 1.0,  0.0);
  vec4 Gs = TEXs(-1.0,  1.0), Hs = TEXs( 0.0,  1.0), Is = TEXs( 1.0,  1.0);

  // Strength & dominance junctions
  vec4 jSx = vec4(As.z, Bs.w, Es.x, Ds.y), jDx = dom(As.yzw, Bs.zwx, Es.wxy, Ds.xyz);
  vec4 jSy = vec4(Bs.z, Cs.w, Fs.x, Es.y), jDy = dom(Bs.yzw, Cs.zwx, Fs.wxy, Es.xyz);
  vec4 jSz = vec4(Es.z, Fs.w, Is.x, Hs.y), jDz = dom(Es.yzw, Fs.zwx, Is.wxy, Hs.xyz);
  vec4 jSw = vec4(Ds.z, Es.w, Hs.x, Gs.y), jDw = dom(Ds.yzw, Es.zwx, Hs.wxy, Gs.xyz);

  // Majority vote for ambiguous dominance junctions
  vec4 zero4 = vec4(0.0);
  vec4 jx = min(GE(jDx, zero4) * (LEQ(jDx.yzwx, zero4) * LEQ(jDx.wxyz, zero4) + GE(jDx + jDx.zwxy, jDx.yzwx + jDx.wxyz)), 1.0);
  vec4 jy = min(GE(jDy, zero4) * (LEQ(jDy.yzwx, zero4) * LEQ(jDy.wxyz, zero4) + GE(jDy + jDy.zwxy, jDy.yzwx + jDy.wxyz)), 1.0);
  vec4 jz = min(GE(jDz, zero4) * (LEQ(jDz.yzwx, zero4) * LEQ(jDz.wxyz, zero4) + GE(jDz + jDz.zwxy, jDz.yzwx + jDz.wxyz)), 1.0);
  vec4 jw = min(GE(jDw, zero4) * (LEQ(jDw.yzwx, zero4) * LEQ(jDw.wxyz, zero4) + GE(jDw + jDw.zwxy, jDw.yzwx + jDw.wxyz)), 1.0);

  // Inject strength without creating new contradictions
  vec4 res;
  res.x = min(jx.z + NOT(jx.y) * NOT(jx.w) * GE(jSx.z, 0.0) * (jx.x + GE(jSx.x + jSx.z, jSx.y + jSx.w)), 1.0);
  res.y = min(jy.w + NOT(jy.z) * NOT(jy.x) * GE(jSy.w, 0.0) * (jy.y + GE(jSy.y + jSy.w, jSy.x + jSy.z)), 1.0);
  res.z = min(jz.x + NOT(jz.w) * NOT(jz.y) * GE(jSz.x, 0.0) * (jz.z + GE(jSz.x + jSz.z, jSz.y + jSz.w)), 1.0);
  res.w = min(jw.y + NOT(jw.x) * NOT(jw.z) * GE(jSw.y, 0.0) * (jw.w + GE(jSw.y + jSw.w, jSw.x + jSw.z)), 1.0);

  // Single pixel & end of line detection
  res = min(res * (vec4(jx.z, jy.w, jz.x, jw.y) + NOT(res.wxyz * res.yzwx)), 1.0);

  // Edge clarity, orientation, and packing
  vec4 clr;
  clr.x = clear(vec2(D.z, E.x), vec2(D.w, E.y), vec2(A.w, D.y));
  clr.y = clear(vec2(F.x, E.z), vec2(E.w, E.y), vec2(B.w, F.y));
  clr.z = clear(vec2(H.z, I.x), vec2(E.w, H.y), vec2(H.w, I.y));
  clr.w = clear(vec2(H.x, G.z), vec2(D.w, H.y), vec2(G.w, G.y));

  vec4 h = vec4(min(D.w, A.w), min(E.w, B.w), min(E.w, H.w), min(D.w, G.w));
  vec4 v = vec4(min(E.y, D.y), min(E.y, F.y), min(H.y, I.y), min(H.y, G.y));

  // 'or' is reserved in some GLSL implementations — renamed to 'orient'
  vec4 orient = GE(h + vec4(D.w, E.w, E.w, D.w), v + vec4(E.y, E.y, H.y, H.y));
  vec4 hori = LE(h, v) * clr;
  vec4 vert = GE(h, v) * clr;

  fragColor = (res + 2.0 * hori + 4.0 * vert + 8.0 * orient) / 15.0;
}
`;

// ---------------------------------------------------------------------------
// Pass 3: ScaleFX edge level (W×H → W×H RGBA8)
// ---------------------------------------------------------------------------

/**
 * 6-level edge classification with subpixel tag assignment. Reads pass 2
 * ambiguity data at 13 positions (E, D/D0/D1, F/F0/F1, B/B0/B1, H/H0/H1).
 * Output: (crn + 9*mid) / 80.0 packed corner and mid tags. SFX_SCN=1.0.
 *
 * Uniforms:
 *   u_source     — pass 2 ambiguity texture (W × H), texture unit 0
 *   u_sourceSize — source dimensions (W, H)
 */
export const SCALEFX_PASS3_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define SFX_SCN 1.0

// Extract packed booleans from pass 2 output
bvec4 loadCorn(vec4 x) { return bvec4(floor(mod(x * 15.0 + 0.5, 2.0))); }
bvec4 loadHori(vec4 x) { return bvec4(floor(mod(x * 7.5 + 0.25, 2.0))); }
bvec4 loadVert(vec4 x) { return bvec4(floor(mod(x * 3.75 + 0.125, 2.0))); }
bvec4 loadOr(vec4 x)   { return bvec4(floor(mod(x * 1.875 + 0.0625, 2.0))); }

void main() {
  vec2 ts = 1.0 / u_sourceSize;

  /*  grid      corners     mids
        B       x   y         x
      D E F                 w   y
        H       w   z         z  */

  #define TEX(x, y) texture(u_source, v_texCoord + ts * vec2(x, y))

  // Read data: E at center, D/F horizontal ±1/2/3, B/H vertical ±1/2/3
  vec4 E  = TEX( 0.0,  0.0);
  vec4 D  = TEX(-1.0,  0.0), D0 = TEX(-2.0,  0.0), D1 = TEX(-3.0,  0.0);
  vec4 F  = TEX( 1.0,  0.0), F0 = TEX( 2.0,  0.0), F1 = TEX( 3.0,  0.0);
  vec4 B  = TEX( 0.0, -1.0), B0 = TEX( 0.0, -2.0), B1 = TEX( 0.0, -3.0);
  vec4 H  = TEX( 0.0,  1.0), H0 = TEX( 0.0,  2.0), H1 = TEX( 0.0,  3.0);

  // Extract packed data
  bvec4 Ec = loadCorn(E), Eh = loadHori(E), Ev = loadVert(E), Eo = loadOr(E);
  bvec4 Dc = loadCorn(D), Dh = loadHori(D), Do = loadOr(D), D0c = loadCorn(D0), D0h = loadHori(D0), D1h = loadHori(D1);
  bvec4 Fc = loadCorn(F), Fh = loadHori(F), Fo = loadOr(F), F0c = loadCorn(F0), F0h = loadHori(F0), F1h = loadHori(F1);
  bvec4 Bc = loadCorn(B), Bv = loadVert(B), Bo = loadOr(B), B0c = loadCorn(B0), B0v = loadVert(B0), B1v = loadVert(B1);
  bvec4 Hc = loadCorn(H), Hv = loadVert(H), Ho = loadOr(H), H0c = loadCorn(H0), H0v = loadVert(H0), H1v = loadVert(H1);

  // lvl1 corners
  bool lvl1x = Ec.x && (Dc.z || Bc.z || SFX_SCN == 1.0);
  bool lvl1y = Ec.y && (Fc.w || Bc.w || SFX_SCN == 1.0);
  bool lvl1z = Ec.z && (Fc.x || Hc.x || SFX_SCN == 1.0);
  bool lvl1w = Ec.w && (Dc.y || Hc.y || SFX_SCN == 1.0);

  // lvl2 mid (left, right / up, down)
  bvec2 lvl2x = bvec2((Ec.x && Eh.y) && Dc.z, (Ec.y && Eh.x) && Fc.w);
  bvec2 lvl2y = bvec2((Ec.y && Ev.z) && Bc.w, (Ec.z && Ev.y) && Hc.x);
  bvec2 lvl2z = bvec2((Ec.w && Eh.z) && Dc.y, (Ec.z && Eh.w) && Fc.x);
  bvec2 lvl2w = bvec2((Ec.x && Ev.w) && Bc.z, (Ec.w && Ev.x) && Hc.y);

  // lvl3 corners (hori, vert)
  bvec2 lvl3x = bvec2(lvl2x.y && (Dh.y && Dh.x) && Fh.z, lvl2w.y && (Bv.w && Bv.x) && Hv.z);
  bvec2 lvl3y = bvec2(lvl2x.x && (Fh.x && Fh.y) && Dh.w, lvl2y.y && (Bv.z && Bv.y) && Hv.w);
  bvec2 lvl3z = bvec2(lvl2z.x && (Fh.w && Fh.z) && Dh.x, lvl2y.x && (Hv.y && Hv.z) && Bv.x);
  bvec2 lvl3w = bvec2(lvl2z.y && (Dh.z && Dh.w) && Fh.y, lvl2w.x && (Hv.x && Hv.w) && Bv.y);

  // lvl4 corners (hori, vert)
  bvec2 lvl4x = bvec2((Dc.x && Dh.y && Eh.x && Eh.y && Fh.x && Fh.y) && (D0c.z && D0h.w), (Bc.x && Bv.w && Ev.x && Ev.w && Hv.x && Hv.w) && (B0c.z && B0v.y));
  bvec2 lvl4y = bvec2((Fc.y && Fh.x && Eh.y && Eh.x && Dh.y && Dh.x) && (F0c.w && F0h.z), (Bc.y && Bv.z && Ev.y && Ev.z && Hv.y && Hv.z) && (B0c.w && B0v.x));
  bvec2 lvl4z = bvec2((Fc.z && Fh.w && Eh.z && Eh.w && Dh.z && Dh.w) && (F0c.x && F0h.y), (Hc.z && Hv.y && Ev.z && Ev.y && Bv.z && Bv.y) && (H0c.x && H0v.w));
  bvec2 lvl4w = bvec2((Dc.w && Dh.z && Eh.w && Eh.z && Fh.w && Fh.z) && (D0c.y && D0h.x), (Hc.w && Hv.x && Ev.w && Ev.x && Bv.w && Bv.x) && (H0c.y && H0v.z));

  // lvl5 mid (left, right / up, down)
  bvec2 lvl5x = bvec2(lvl4x.x && (F0h.x && F0h.y) && (D1h.z && D1h.w), lvl4y.x && (D0h.y && D0h.x) && (F1h.w && F1h.z));
  bvec2 lvl5y = bvec2(lvl4y.y && (H0v.y && H0v.z) && (B1v.w && B1v.x), lvl4z.y && (B0v.z && B0v.y) && (H1v.x && H1v.w));
  bvec2 lvl5z = bvec2(lvl4w.x && (F0h.w && F0h.z) && (D1h.y && D1h.x), lvl4z.x && (D0h.z && D0h.w) && (F1h.x && F1h.y));
  bvec2 lvl5w = bvec2(lvl4x.y && (H0v.x && H0v.w) && (B1v.z && B1v.y), lvl4w.y && (B0v.w && B0v.x) && (H1v.y && H1v.z));

  // lvl6 corners (hori, vert)
  bvec2 lvl6x = bvec2(lvl5x.y && (D1h.y && D1h.x), lvl5w.y && (B1v.w && B1v.x));
  bvec2 lvl6y = bvec2(lvl5x.x && (F1h.x && F1h.y), lvl5y.y && (B1v.z && B1v.y));
  bvec2 lvl6z = bvec2(lvl5z.x && (F1h.w && F1h.z), lvl5y.x && (H1v.y && H1v.z));
  bvec2 lvl6w = bvec2(lvl5z.y && (D1h.z && D1h.w), lvl5w.x && (H1v.x && H1v.w));

  // Subpixels: 0=E, 1=D, 2=D0, 3=F, 4=F0, 5=B, 6=B0, 7=H, 8=H0
  vec4 crn;
  crn.x = (lvl1x && Eo.x || lvl3x.x && Eo.y || lvl4x.x && Do.x || lvl6x.x && Fo.y) ? 5.0 : (lvl1x || lvl3x.y && !Eo.w || lvl4x.y && !Bo.x || lvl6x.y && !Ho.w) ? 1.0 : lvl3x.x ? 3.0 : lvl3x.y ? 7.0 : lvl4x.x ? 2.0 : lvl4x.y ? 6.0 : lvl6x.x ? 4.0 : lvl6x.y ? 8.0 : 0.0;
  crn.y = (lvl1y && Eo.y || lvl3y.x && Eo.x || lvl4y.x && Fo.y || lvl6y.x && Do.x) ? 5.0 : (lvl1y || lvl3y.y && !Eo.z || lvl4y.y && !Bo.y || lvl6y.y && !Ho.z) ? 3.0 : lvl3y.x ? 1.0 : lvl3y.y ? 7.0 : lvl4y.x ? 4.0 : lvl4y.y ? 6.0 : lvl6y.x ? 2.0 : lvl6y.y ? 8.0 : 0.0;
  crn.z = (lvl1z && Eo.z || lvl3z.x && Eo.w || lvl4z.x && Fo.z || lvl6z.x && Do.w) ? 7.0 : (lvl1z || lvl3z.y && !Eo.y || lvl4z.y && !Ho.z || lvl6z.y && !Bo.y) ? 3.0 : lvl3z.x ? 1.0 : lvl3z.y ? 5.0 : lvl4z.x ? 4.0 : lvl4z.y ? 8.0 : lvl6z.x ? 2.0 : lvl6z.y ? 6.0 : 0.0;
  crn.w = (lvl1w && Eo.w || lvl3w.x && Eo.z || lvl4w.x && Do.w || lvl6w.x && Fo.z) ? 7.0 : (lvl1w || lvl3w.y && !Eo.x || lvl4w.y && !Ho.w || lvl6w.y && !Bo.x) ? 1.0 : lvl3w.x ? 3.0 : lvl3w.y ? 5.0 : lvl4w.x ? 2.0 : lvl4w.y ? 8.0 : lvl6w.x ? 4.0 : lvl6w.y ? 6.0 : 0.0;

  vec4 mid;
  mid.x = (lvl2x.x &&  Eo.x || lvl2x.y &&  Eo.y || lvl5x.x &&  Do.x || lvl5x.y &&  Fo.y) ? 5.0 : lvl2x.x ? 1.0 : lvl2x.y ? 3.0 : lvl5x.x ? 2.0 : lvl5x.y ? 4.0 : (Ec.x && Dc.z && Ec.y && Fc.w) ? ( Eo.x ?  Eo.y ? 5.0 : 3.0 : 1.0) : 0.0;
  mid.y = (lvl2y.x && !Eo.y || lvl2y.y && !Eo.z || lvl5y.x && !Bo.y || lvl5y.y && !Ho.z) ? 3.0 : lvl2y.x ? 5.0 : lvl2y.y ? 7.0 : lvl5y.x ? 6.0 : lvl5y.y ? 8.0 : (Ec.y && Bc.w && Ec.z && Hc.x) ? (!Eo.y ? !Eo.z ? 3.0 : 7.0 : 5.0) : 0.0;
  mid.z = (lvl2z.x &&  Eo.w || lvl2z.y &&  Eo.z || lvl5z.x &&  Do.w || lvl5z.y &&  Fo.z) ? 7.0 : lvl2z.x ? 1.0 : lvl2z.y ? 3.0 : lvl5z.x ? 2.0 : lvl5z.y ? 4.0 : (Ec.z && Fc.x && Ec.w && Dc.y) ? ( Eo.z ?  Eo.w ? 7.0 : 1.0 : 3.0) : 0.0;
  mid.w = (lvl2w.x && !Eo.x || lvl2w.y && !Eo.w || lvl5w.x && !Bo.x || lvl5w.y && !Ho.w) ? 1.0 : lvl2w.x ? 5.0 : lvl2w.y ? 7.0 : lvl5w.x ? 6.0 : lvl5w.y ? 8.0 : (Ec.w && Hc.y && Ec.x && Bc.z) ? (!Eo.w ? !Eo.x ? 1.0 : 5.0 : 7.0) : 0.0;

  fragColor = (crn + 9.0 * mid) / 80.0;
}
`;

// ---------------------------------------------------------------------------
// Pass 4: ScaleFX 3× output (W×H → 3W×3H RGBA8)
// ---------------------------------------------------------------------------

/**
 * Decodes subpixel tags from pass 3 and maps each 3×3 subpixel to one of 9
 * source pixels (E, D, D0, F, F0, B, B0, H, H0), then fetches the original
 * pixel color. Only 2 texture reads per fragment.
 *
 * Uniforms:
 *   u_source      — pass 3 edge level texture (W × H), texture unit 0
 *   u_originalTex — original input texture (W × H), texture unit 1
 *   u_sourceSize  — source dimensions (W, H)
 */
export const SCALEFX_PASS4_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform sampler2D u_originalTex;
uniform vec2 u_sourceSize;
out vec4 fragColor;

// Extract corner tags from packed data
vec4 loadCrn(vec4 x) { return floor(mod(x * 80.0 + 0.5, 9.0)); }

// Extract mid tags from packed data
vec4 loadMid(vec4 x) { return floor(mod(x * 8.888888 + 0.055555, 9.0)); }

void main() {
  /*  grid      corners     mids
        B       x   y         x
      D E F                 w   y
        H       w   z         z  */

  // Read tag data from pass 3
  vec4 E = texture(u_source, v_texCoord);

  // Extract corner and mid tags
  vec4 crn = loadCrn(E);
  vec4 mid = loadMid(E);

  // Determine subpixel position in the 3×3 grid
  vec2 fp = floor(3.0 * fract(v_texCoord * u_sourceSize));

  // Map grid position to subpixel tag
  float sp = fp.y == 0.0
    ? (fp.x == 0.0 ? crn.x : fp.x == 1.0 ? mid.x : crn.y)
    : (fp.y == 1.0
      ? (fp.x == 0.0 ? mid.w : fp.x == 1.0 ? 0.0 : mid.y)
      : (fp.x == 0.0 ? crn.w : fp.x == 1.0 ? mid.z : crn.z));

  // Map tag to source texel offset: 0=E, 1=D, 2=D0, 3=F, 4=F0, 5=B, 6=B0, 7=H, 8=H0
  vec2 res = sp == 0.0 ? vec2( 0.0,  0.0)
           : sp == 1.0 ? vec2(-1.0,  0.0)
           : sp == 2.0 ? vec2(-2.0,  0.0)
           : sp == 3.0 ? vec2( 1.0,  0.0)
           : sp == 4.0 ? vec2( 2.0,  0.0)
           : sp == 5.0 ? vec2( 0.0, -1.0)
           : sp == 6.0 ? vec2( 0.0, -2.0)
           : sp == 7.0 ? vec2( 0.0,  1.0)
           :             vec2( 0.0,  2.0);

  // Fetch original pixel color at the computed offset
  fragColor = texture(u_originalTex, v_texCoord + res / u_sourceSize);
}
`;

// ---------------------------------------------------------------------------
// Pass 5: Sharpsmoother (3W×3H → 3W×3H RGBA8)
// ---------------------------------------------------------------------------

/**
 * Edge-preserving 3×3 perceptual-weighted smoothing. Adds color blending to
 * ScaleFX's hard pixel selection. 9 texture reads per fragment.
 * Parameters: max_w=0.10, min_w=-0.07, smoot=0.55, lumad=0.30, mtric=0.70.
 *
 * Uniforms:
 *   u_source     — pass 4 ScaleFX 3× output (3W × 3H), texture unit 0
 *   u_sourceSize — upscaled dimensions (3W, 3H)
 */
export const SHARPSMOOTHER_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define max_w  0.10
#define min_w -0.07
#define smoot  0.55
#define lumad  0.30
#define mtric  0.70

vec3 dt = vec3(1.0, 1.0, 1.0);

float wt(vec3 A, vec3 B) {
  return clamp(smoot - ((6.0 + lumad) / pow(3.0, mtric)) * pow(dot(pow(abs(A - B), vec3(1.0 / mtric)), dt), mtric) / (dot(A + B, dt) + lumad), min_w, max_w);
}

void main() {
  vec2 ts = 1.0 / u_sourceSize;
  vec2 dg1 = ts;
  vec2 dg2 = vec2(-ts.x, ts.y);
  vec2 dx = vec2(ts.x, 0.0);
  vec2 dy = vec2(0.0, ts.y);

  vec3 c00 = texture(u_source, v_texCoord - dg1).rgb;
  vec3 c10 = texture(u_source, v_texCoord - dy).rgb;
  vec3 c20 = texture(u_source, v_texCoord - dg2).rgb;
  vec3 c01 = texture(u_source, v_texCoord - dx).rgb;
  vec3 c11 = texture(u_source, v_texCoord).rgb;
  vec3 c21 = texture(u_source, v_texCoord + dx).rgb;
  vec3 c02 = texture(u_source, v_texCoord + dg2).rgb;
  vec3 c12 = texture(u_source, v_texCoord + dy).rgb;
  vec3 c22 = texture(u_source, v_texCoord + dg1).rgb;

  float w10 = wt(c11, c10);
  float w21 = wt(c11, c21);
  float w12 = wt(c11, c12);
  float w01 = wt(c11, c01);
  float w00 = wt(c11, c00) * 0.75;
  float w22 = wt(c11, c22) * 0.75;
  float w20 = wt(c11, c20) * 0.75;
  float w02 = wt(c11, c02) * 0.75;

  fragColor = vec4(
    w10 * c10 + w21 * c21 + w12 * c12 + w01 * c01 +
    w00 * c00 + w22 * c22 + w20 * c20 + w02 * c02 +
    (1.0 - w10 - w21 - w12 - w01 - w00 - w22 - w20 - w02) * c11,
    1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 6: AA Level2 Pass 1 (3W×3H → 3W×3H RGBA8)
// ---------------------------------------------------------------------------

/**
 * 13-point directional anti-aliasing. Samples diagonal, extended horizontal,
 * and extended vertical neighbors with edge-adaptive inverse-distance weighting.
 * AAOFFSET=1.0. Requires LINEAR texture filtering on input.
 *
 * Uniforms:
 *   u_source     — pass 5 sharpsmoother output (3W × 3H), texture unit 0
 *   u_sourceSize — upscaled dimensions (3W, 3H)
 */
export const AA_LEVEL2_PASS1_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define AAOFFSET 1.0

void main() {
  vec2 texsize = u_sourceSize;
  float dx = AAOFFSET / texsize.x;
  float dy = AAOFFSET / texsize.y;
  vec3 dt = vec3(1.0, 1.0, 1.0);

  vec4 yx = vec4(dx, dy, -dx, -dy);
  vec4 xh = yx * vec4(4.0, 1.5, 4.0, 1.5);
  vec4 yv = yx * vec4(1.5, 4.0, 1.5, 4.0);

  vec3 c11 = texture(u_source, v_texCoord).xyz;
  vec3 s00 = texture(u_source, v_texCoord + yx.zw).xyz;
  vec3 s20 = texture(u_source, v_texCoord + yx.xw).xyz;
  vec3 s22 = texture(u_source, v_texCoord + yx.xy).xyz;
  vec3 s02 = texture(u_source, v_texCoord + yx.zy).xyz;
  vec3 h00 = texture(u_source, v_texCoord + xh.zw).xyz;
  vec3 h20 = texture(u_source, v_texCoord + xh.xw).xyz;
  vec3 h22 = texture(u_source, v_texCoord + xh.xy).xyz;
  vec3 h02 = texture(u_source, v_texCoord + xh.zy).xyz;
  vec3 v00 = texture(u_source, v_texCoord + yv.zw).xyz;
  vec3 v20 = texture(u_source, v_texCoord + yv.xw).xyz;
  vec3 v22 = texture(u_source, v_texCoord + yv.xy).xyz;
  vec3 v02 = texture(u_source, v_texCoord + yv.zy).xyz;

  float m1 = 1.0 / (dot(abs(s00 - s22), dt) + 0.00001);
  float m2 = 1.0 / (dot(abs(s02 - s20), dt) + 0.00001);
  float h1 = 1.0 / (dot(abs(s00 - h22), dt) + 0.00001);
  float h2 = 1.0 / (dot(abs(s02 - h20), dt) + 0.00001);
  float h3 = 1.0 / (dot(abs(h00 - s22), dt) + 0.00001);
  float h4 = 1.0 / (dot(abs(h02 - s20), dt) + 0.00001);
  float fv1 = 1.0 / (dot(abs(s00 - v22), dt) + 0.00001);
  float fv2 = 1.0 / (dot(abs(s02 - v20), dt) + 0.00001);
  float fv3 = 1.0 / (dot(abs(v00 - s22), dt) + 0.00001);
  float fv4 = 1.0 / (dot(abs(v02 - s20), dt) + 0.00001);

  vec3 t1 = 0.5 * (m1 * (s00 + s22) + m2 * (s02 + s20)) / (m1 + m2);
  vec3 t2 = 0.5 * (h1 * (s00 + h22) + h2 * (s02 + h20) + h3 * (h00 + s22) + h4 * (h02 + s20)) / (h1 + h2 + h3 + h4);
  vec3 t3 = 0.5 * (fv1 * (s00 + v22) + fv2 * (s02 + v20) + fv3 * (v00 + s22) + fv4 * (v02 + s20)) / (fv1 + fv2 + fv3 + fv4);

  float k1 = 1.0 / (dot(abs(t1 - c11), dt) + 0.00001);
  float k2 = 1.0 / (dot(abs(t2 - c11), dt) + 0.00001);
  float k3 = 1.0 / (dot(abs(t3 - c11), dt) + 0.00001);

  fragColor = vec4((k1 * t1 + k2 * t2 + k3 * t3) / (k1 + k2 + k3), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 7: AA Level2 Pass 2 (3W×3H → 3W×3H RGBA8)
// ---------------------------------------------------------------------------

/**
 * 4-point diagonal anti-aliasing refinement. Samples at half-pixel diagonal
 * offsets with edge-adaptive weighting. AAOFFSET2=0.5.
 * Requires LINEAR texture filtering on input.
 *
 * Uniforms:
 *   u_source     — pass 6 AA pass 1 output (3W × 3H), texture unit 0
 *   u_sourceSize — upscaled dimensions (3W, 3H)
 */
export const AA_LEVEL2_PASS2_FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
out vec4 fragColor;

#define AAOFFSET2 0.5

void main() {
  vec2 texsize = u_sourceSize;
  float dx = AAOFFSET2 / texsize.x;
  float dy = AAOFFSET2 / texsize.y;
  vec3 dt = vec3(1.0, 1.0, 1.0);

  vec2 UL = v_texCoord + vec2(-dx, -dy);
  vec2 UR = v_texCoord + vec2( dx, -dy);
  vec2 DL = v_texCoord + vec2(-dx,  dy);
  vec2 DR = v_texCoord + vec2( dx,  dy);

  vec3 c00 = texture(u_source, UL).xyz;
  vec3 c20 = texture(u_source, UR).xyz;
  vec3 c02 = texture(u_source, DL).xyz;
  vec3 c22 = texture(u_source, DR).xyz;

  float m1 = dot(abs(c00 - c22), dt) + 0.001;
  float m2 = dot(abs(c02 - c20), dt) + 0.001;

  fragColor = vec4((m1 * (c02 + c20) + m2 * (c22 + c00)) / (2.0 * (m1 + m2)), 1.0);
}
`;
