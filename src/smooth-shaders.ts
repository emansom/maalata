/**
 * Pixel Art Smoothing GLSL Shader (Kopf-Lischinski)
 *
 * Pre-processing pass that smooths pre-upscaled pixel art (2x-8x) before
 * CRT effects are applied. Adapts the Kopf-Lischinski depixelization
 * algorithm for real-time per-fragment WebGL2 rendering.
 *
 * Data flow: DOM canvas -> canvas-ultrafast -> maalata pipeline ->
 *            [this shader] -> CRT shader -> display
 *
 * The full Kopf-Lischinski pipeline (graph -> polygons -> splines -> SVG)
 * requires sequential processing for polygon extraction. This shader
 * extracts the per-pixel-parallel stages (edge detection, diagonal
 * resolution) and replaces polygon extraction with direct per-fragment
 * color interpolation, achieving the visual quality of correct diagonal
 * resolution without the sequential vectorization.
 *
 * Algorithm stages per fragment:
 *  1. Block detection — search for uniform-color boundaries (up to 8 texels
 *     per direction) to find the logical pixel this canvas texel belongs to
 *  2. 3x3 logical neighborhood — sample 8 adjacent logical pixels by jumping
 *     one texel beyond each detected block boundary
 *  3. YUV similarity graph — compare all neighbor pairs using perceptually-
 *     weighted YUV color space (thresholds: Y<=48, U<=7, V<=6 on 0-255)
 *  4. Diagonal crossing resolution — when two diagonals cross at a corner,
 *     resolve ambiguity using valence heuristic (keep sparser diagonal)
 *  5. Edge-aware interpolation — at block boundaries blend toward connected
 *     neighbors; at corners with resolved diagonals apply diagonal cell
 *     boundary cut via signed distance function
 *
 * Early-outs:
 *  - u_inputSize.y < 0.5: bypass (test mode, same as CRT beam bypass)
 *  - 1x1 blocks: non-pixel-art content (text, gradients), pass through
 *  - Interior pixels (>40% from edge): no neighbors needed, pass through
 *
 * References:
 *  - Kopf & Lischinski, "Depixelizing Pixel Art" (SIGGRAPH 2011)
 *  - Silva et al., "Real Time Pixel Art Remasterization on GPUs" (SIBGRAPI 2013)
 *  - swielgus/vctrsKL (CUDA) — YUV thresholds, graph construction
 *  - marcoc2/pixel-art-remaster-gpu (CUDA) — per-pixel parallel architecture
 */

/**
 * Fragment shader: Kopf-Lischinski pixel art smoothing.
 *
 * Reuses CRT_VERTEX_SRC from crt-shaders.ts (same fullscreen quad).
 */
export const SMOOTH_FRAGMENT_SRC = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  varying vec2 v_texCoord;

  uniform sampler2D u_texture;
  uniform vec2 u_inputSize;

  // --- YUV similarity (Kopf-Lischinski / vctrsKL thresholds) ---
  vec3 rgb2yuv(vec3 c) {
    return vec3(
      0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
      -0.169 * c.r - 0.331 * c.g + 0.5 * c.b + 0.5,
      0.5 * c.r - 0.419 * c.g - 0.081 * c.b + 0.5
    );
  }

  bool isSimilar(vec3 a, vec3 b) {
    vec3 d = abs(rgb2yuv(a) - rgb2yuv(b));
    return d.x <= 48.0/255.0 && d.y <= 7.0/255.0 && d.z <= 6.0/255.0;
  }

  void main() {
    vec2 uv = v_texCoord;
    vec2 px = 1.0 / u_inputSize;  // texel size
    vec3 center = texture2D(u_texture, uv).rgb;

    // --- Bypass: test mode ---
    if (u_inputSize.y < 0.5) {
      gl_FragColor = vec4(center, 1.0);
      return;
    }

    // --- STEP 1: Block detection ---
    // Search up to 8 texels in each direction for color boundaries.
    // A boundary is where the color differs from center.
    // blockL/R/U/D = distance in texels to nearest boundary in each direction.

    float blockL = 0.0;
    float blockR = 0.0;
    float blockU = 0.0;
    float blockD = 0.0;

    for (int i = 1; i <= 8; i++) {
      if (blockL == 0.0 && !isSimilar(center, texture2D(u_texture, uv + vec2(-float(i) * px.x, 0.0)).rgb))
        blockL = float(i);
      if (blockR == 0.0 && !isSimilar(center, texture2D(u_texture, uv + vec2( float(i) * px.x, 0.0)).rgb))
        blockR = float(i);
      if (blockU == 0.0 && !isSimilar(center, texture2D(u_texture, uv + vec2(0.0, -float(i) * px.y)).rgb))
        blockU = float(i);
      if (blockD == 0.0 && !isSimilar(center, texture2D(u_texture, uv + vec2(0.0,  float(i) * px.y)).rgb))
        blockD = float(i);
    }

    // If no boundary found within 8 texels, clamp to 8 (very large block or edge)
    if (blockL == 0.0) blockL = 8.0;
    if (blockR == 0.0) blockR = 8.0;
    if (blockU == 0.0) blockU = 8.0;
    if (blockD == 0.0) blockD = 8.0;

    // Block extent: distance from this texel to block boundaries
    // blockSize = total block width/height in texels
    float blockW = blockL + blockR - 1.0;
    float blockH = blockU + blockD - 1.0;

    // Early-out: 1x1 blocks are non-pixel-art content (text, gradients)
    if (blockW < 1.5 && blockH < 1.5) {
      gl_FragColor = vec4(center, 1.0);
      return;
    }

    // Sub-position within block: [-0.5, 0.5] from block center
    float subX = (blockL - 0.5 * (blockW + 1.0)) / blockW;
    float subY = (blockU - 0.5 * (blockH + 1.0)) / blockH;

    // Early-out: interior pixels (far from edges) — no blending needed
    if (abs(subX) < 0.1 && abs(subY) < 0.1) {
      gl_FragColor = vec4(center, 1.0);
      return;
    }

    // --- STEP 2: Sample 3x3 logical neighborhood ---
    // Jump one texel beyond each block boundary to sample adjacent logical pixels.
    vec2 uvL = uv + vec2(-blockL * px.x, 0.0);
    vec2 uvR = uv + vec2( blockR * px.x, 0.0);
    vec2 uvU = uv + vec2(0.0, -blockU * px.y);
    vec2 uvD = uv + vec2(0.0,  blockD * px.y);

    vec3 ml = texture2D(u_texture, uvL).rgb;              // middle-left
    vec3 mr = texture2D(u_texture, uvR).rgb;              // middle-right
    vec3 tc = texture2D(u_texture, uvU).rgb;              // top-center
    vec3 bc = texture2D(u_texture, uvD).rgb;              // bottom-center
    vec3 tl = texture2D(u_texture, uvU + vec2(-blockL * px.x, 0.0)).rgb;  // top-left
    vec3 tr = texture2D(u_texture, uvU + vec2( blockR * px.x, 0.0)).rgb;  // top-right
    vec3 bl = texture2D(u_texture, uvD + vec2(-blockL * px.x, 0.0)).rgb;  // bottom-left
    vec3 br = texture2D(u_texture, uvD + vec2( blockR * px.x, 0.0)).rgb;  // bottom-right

    // --- STEP 3: YUV similarity graph ---
    // Cardinal edges: center <-> neighbor
    bool sim_ml = isSimilar(center, ml);
    bool sim_mr = isSimilar(center, mr);
    bool sim_tc = isSimilar(center, tc);
    bool sim_bc = isSimilar(center, bc);

    // Diagonal edges: center <-> corner
    bool sim_tl = isSimilar(center, tl);
    bool sim_tr = isSimilar(center, tr);
    bool sim_bl = isSimilar(center, bl);
    bool sim_br = isSimilar(center, br);

    // Cross edges: adjacent neighbors sharing a corner
    bool cross_tc_ml = isSimilar(tc, ml);  // top-left corner
    bool cross_tc_mr = isSimilar(tc, mr);  // top-right corner
    bool cross_bc_ml = isSimilar(bc, ml);  // bottom-left corner
    bool cross_bc_mr = isSimilar(bc, mr);  // bottom-right corner

    // --- STEP 4: Diagonal crossing resolution ---
    // At each corner, two diagonals can cross. If both are connected,
    // resolve ambiguity using the valence heuristic: keep the diagonal
    // whose endpoints have fewer cardinal connections (sparser = preserve).

    // Valence = number of cardinal connections for each neighbor
    // (how many of the 4 cardinal neighbors of center are similar to this neighbor)
    int val_tl_c = (sim_tc ? 1 : 0) + (sim_ml ? 1 : 0);
    int val_br_c = (sim_bc ? 1 : 0) + (sim_mr ? 1 : 0);
    int val_tr_c = (sim_tc ? 1 : 0) + (sim_mr ? 1 : 0);
    int val_bl_c = (sim_bc ? 1 : 0) + (sim_ml ? 1 : 0);

    // Top-left corner: TL diagonal vs BR-cross (tc-ml)
    bool keep_tl = sim_tl;
    if (sim_tl && cross_tc_ml) {
      // Both diagonals active at this corner — resolve by valence
      int val_diag = val_tl_c;  // TL endpoint valence (cardinal connections via center)
      int val_cross = (sim_tc ? 1 : 0) + (sim_ml ? 1 : 0);  // cross endpoints
      keep_tl = val_diag <= val_cross;  // keep sparser
    }

    // Top-right corner: TR diagonal vs cross (tc-mr)
    bool keep_tr = sim_tr;
    if (sim_tr && cross_tc_mr) {
      int val_diag = val_tr_c;
      int val_cross = (sim_tc ? 1 : 0) + (sim_mr ? 1 : 0);
      keep_tr = val_diag <= val_cross;
    }

    // Bottom-left corner: BL diagonal vs cross (bc-ml)
    bool keep_bl = sim_bl;
    if (sim_bl && cross_bc_ml) {
      int val_diag = val_bl_c;
      int val_cross = (sim_bc ? 1 : 0) + (sim_ml ? 1 : 0);
      keep_bl = val_diag <= val_cross;
    }

    // Bottom-right corner: BR diagonal vs cross (bc-mr)
    bool keep_br = sim_br;
    if (sim_br && cross_bc_mr) {
      int val_diag = val_br_c;
      int val_cross = (sim_bc ? 1 : 0) + (sim_mr ? 1 : 0);
      keep_br = val_diag <= val_cross;
    }

    // --- STEP 5: Edge-aware interpolation ---
    // Blend factors based on proximity to block edge
    float edgeX = abs(subX) * 2.0;  // 0 at center, 1 at edge
    float edgeY = abs(subY) * 2.0;

    // Smooth blend ramps near edges (start blending at 60% from center)
    float bx = smoothstep(0.6, 1.0, edgeX);
    float by = smoothstep(0.6, 1.0, edgeY);

    vec3 result = center;

    // Determine which neighbors are on the near side based on subPos sign
    bool nearLeft = subX < 0.0;
    bool nearTop  = subY < 0.0;

    // Cardinal neighbor references based on proximity
    vec3 nearH  = nearLeft ? ml : mr;   // nearest horizontal neighbor
    bool simH   = nearLeft ? sim_ml : sim_mr;
    vec3 nearV  = nearTop ? tc : bc;    // nearest vertical neighbor
    bool simV   = nearTop ? sim_tc : sim_bc;

    // Diagonal neighbor for the nearest corner
    vec3 nearDiag;
    bool keepDiag;
    bool crossDiag;  // whether the cross-diagonal at this corner is connected
    if (nearLeft && nearTop) {
      nearDiag = tl; keepDiag = keep_tl; crossDiag = cross_tc_ml;
    } else if (!nearLeft && nearTop) {
      nearDiag = tr; keepDiag = keep_tr; crossDiag = cross_tc_mr;
    } else if (nearLeft && !nearTop) {
      nearDiag = bl; keepDiag = keep_bl; crossDiag = cross_bc_ml;
    } else {
      nearDiag = br; keepDiag = keep_br; crossDiag = cross_bc_mr;
    }

    if (bx > 0.001 && by > 0.001) {
      // Corner region: both axes near edge
      float cornerBlend = bx * by;

      if (keepDiag) {
        // Diagonal connected: cell boundary cut at |fx|+|fy|=0.5
        // Signed distance from the diagonal cell boundary
        float fx = abs(subX);
        float fy = abs(subY);
        float sd = fx + fy - 0.5;
        float diagBlend = smoothstep(-0.15, 0.15, sd);
        result = mix(center, nearDiag, diagBlend * cornerBlend);
      } else if (crossDiag) {
        // Cross-diagonal won: blend toward both cardinal neighbors independently
        if (simH) result = mix(result, nearH, bx * 0.5);
        if (simV) result = mix(result, nearV, by * 0.5);
      }
      // else: neither diagonal — sharp corner, keep center
    } else if (bx > 0.001) {
      // Horizontal edge region only
      if (simH) {
        result = mix(center, nearH, bx * 0.5);
      }
    } else if (by > 0.001) {
      // Vertical edge region only
      if (simV) {
        result = mix(center, nearV, by * 0.5);
      }
    }

    gl_FragColor = vec4(result, 1.0);
  }
`;
