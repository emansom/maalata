/**
 * Standalone Pixel Art Smoothing Display
 *
 * Nine-pass rendering pipeline that smooths pixel art edges without CRT
 * effects. Targets 1:1 pixel art — consumers draw at native resolution and
 * get improved visuals automatically, no code changes needed.
 *
 * NEAREST filtering is inherited from canvas-ultrafast (all FBO textures use
 * gl.NEAREST by default). AA level2 passes (6, 7) temporarily switch input
 * textures to LINEAR for fractional-texel bilinear interpolation, then
 * restore NEAREST after rendering.
 *
 *   Pass 0: ScaleFX metric — Compuphase color distance (W×H → W×H RGBA16F)
 *   Pass 1: ScaleFX strength — corner interpolation (W×H → W×H RGBA16F)
 *   Pass 2: ScaleFX ambiguity — dominance voting (W×H → W×H RGBA8)
 *   Pass 3: ScaleFX edge level — 6-level classification (W×H → W×H RGBA8)
 *   Pass 4: ScaleFX 3× output — tag decode → color lookup (W×H → 3W×3H RGBA8)
 *   Pass 5: Sharpsmoother — edge-preserving smoothing (3W×3H → 3W×3H RGBA8)
 *   Pass 6: AA level2 pass 1 — 13-point directional AA (3W×3H → 3W×3H RGBA8)
 *   Pass 7: AA level2 pass 2 — 4-point diagonal AA (3W×3H → 3W×3H RGBA8)
 *   Pass 8: EWA smooth downsample — raised-cosine polar 8×8 (3W×3H → W×H RGBA8)
 *
 * Can be used standalone (render() blits to screen) or as a delegate inside
 * CRTDisplay (renderSmoothing() + getSmoothedTexture() for CRT to read).
 *
 * screenshotUpscaled() uses the EWA smooth downsample shader on the GPU to
 * reduce the 3W×3H post-AA FBO to 2W×2H, then reads via readPixels and
 * returns as an ImageBitmap — useful for visualizing the ScaleFX+AA output
 * at 2× resolution.
 *
 * ScaleFX uses Compuphase perceptual color distance with 6-level edge
 * classification and precise slope detection. Passes 0-3 output packed
 * metadata (not colors); pass 4 reads original pixels and maps 3×3 subpixel
 * grid to source colors. Sharpsmoother adds edge-preserving color blending.
 * AA level2 provides multi-directional anti-aliasing refinement. Purely
 * algorithmic — no lookup tables or async loading needed.
 *
 * Total VRAM: 25 WH (2×RGBA16F W×H + 2×RGBA8 W×H + 2×RGBA8 3W×3H + 1×RGBA8 W×H).
 * Requires EXT_color_buffer_float for RGBA16F render targets (99%+ WebGL2).
 */

import { CRT_VERTEX_SRC } from './crt-shaders';
import {
  SCALEFX_PASS0_FRAGMENT_SRC,
  SCALEFX_PASS1_FRAGMENT_SRC,
  SCALEFX_PASS2_FRAGMENT_SRC,
  SCALEFX_PASS3_FRAGMENT_SRC,
  SCALEFX_PASS4_FRAGMENT_SRC,
  SHARPSMOOTHER_FRAGMENT_SRC,
  AA_LEVEL2_PASS1_FRAGMENT_SRC,
  AA_LEVEL2_PASS2_FRAGMENT_SRC,
} from './smooth-shaders';
import { DOWNSAMPLE_FRAGMENT_SRC } from './downsample-shaders';

export class SmoothingDisplay {
  private _gl: WebGL2RenderingContext;
  private _canvas: HTMLCanvasElement;
  private _getReadyTexture: () => WebGLTexture;
  private _hasContent: () => boolean;
  private _rafId: number | null = null;

  // Fullscreen quad VBO (shared by all programs)
  private _quadVBO: WebGLBuffer;

  // --- 9 shader programs ---
  private _pass0Program: WebGLProgram;  // ScaleFX metric
  private _pass1Program: WebGLProgram;  // ScaleFX strength
  private _pass2Program: WebGLProgram;  // ScaleFX ambiguity
  private _pass3Program: WebGLProgram;  // ScaleFX edge level
  private _pass4Program: WebGLProgram;  // ScaleFX 3× output
  private _pass5Program: WebGLProgram;  // Sharpsmoother
  private _pass6Program: WebGLProgram;  // AA level2 pass 1
  private _pass7Program: WebGLProgram;  // AA level2 pass 2
  private _pass8Program: WebGLProgram;  // EWA smooth downsample

  // --- Uniform locations ---
  private _pass0SourceSizeLoc: WebGLUniformLocation | null;
  private _pass0PositionLoc: number;

  private _pass1SourceSizeLoc: WebGLUniformLocation | null;
  private _pass1PositionLoc: number;

  private _pass2SourceSizeLoc: WebGLUniformLocation | null;
  private _pass2PositionLoc: number;

  private _pass3SourceSizeLoc: WebGLUniformLocation | null;
  private _pass3PositionLoc: number;

  private _pass4SourceSizeLoc: WebGLUniformLocation | null;
  private _pass4PositionLoc: number;

  private _pass5SourceSizeLoc: WebGLUniformLocation | null;
  private _pass5PositionLoc: number;

  private _pass6SourceSizeLoc: WebGLUniformLocation | null;
  private _pass6PositionLoc: number;

  private _pass7SourceSizeLoc: WebGLUniformLocation | null;
  private _pass7PositionLoc: number;

  private _pass8SourceSizeLoc: WebGLUniformLocation | null;
  private _pass8DownscaleFactorLoc: WebGLUniformLocation | null;
  private _pass8PositionLoc: number;

  // --- FBO textures ---
  private _metricTexture: WebGLTexture;      // W×H RGBA16F (pass 0 output)
  private _strengthTexture: WebGLTexture;    // W×H RGBA16F (pass 1 output)
  private _ambiguityTexture: WebGLTexture;   // W×H RGBA8 (pass 2 output)
  private _edgeLevelTexture: WebGLTexture;   // W×H RGBA8 (pass 3 output)
  private _upscaledA: WebGLTexture;          // 3W×3H RGBA8 (ping-pong A)
  private _upscaledB: WebGLTexture;          // 3W×3H RGBA8 (ping-pong B)
  private _intermediateTexture: WebGLTexture; // W×H RGBA8 (pass 8 output)

  // --- FBOs ---
  private _metricFbo: WebGLFramebuffer;
  private _strengthFbo: WebGLFramebuffer;
  private _ambiguityFbo: WebGLFramebuffer;
  private _edgeLevelFbo: WebGLFramebuffer;
  private _upscaledAFbo: WebGLFramebuffer;
  private _upscaledBFbo: WebGLFramebuffer;
  private _intermediateFbo: WebGLFramebuffer;

  constructor(
    gl: WebGL2RenderingContext,
    canvas: HTMLCanvasElement,
    getReadyTexture: () => WebGLTexture,
    hasContent: () => boolean,
  ) {
    this._gl = gl;
    this._canvas = canvas;
    this._getReadyTexture = getReadyTexture;
    this._hasContent = hasContent;

    // Check for RGBA16F render target support
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      throw new Error('maalata: EXT_color_buffer_float required for ScaleFX smoothing pipeline');
    }

    const w = canvas.width;
    const h = canvas.height;
    const w3 = w * 3;
    const h3 = h * 3;

    // Create fullscreen quad VBO
    this._quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    // --- Pass 0: ScaleFX metric ---
    this._pass0Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SCALEFX_PASS0_FRAGMENT_SRC);
    gl.useProgram(this._pass0Program);
    this._pass0SourceSizeLoc = gl.getUniformLocation(this._pass0Program, 'u_sourceSize');
    this._pass0PositionLoc = gl.getAttribLocation(this._pass0Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass0Program, 'u_source'), 0);

    // --- Pass 1: ScaleFX strength ---
    this._pass1Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SCALEFX_PASS1_FRAGMENT_SRC);
    gl.useProgram(this._pass1Program);
    this._pass1SourceSizeLoc = gl.getUniformLocation(this._pass1Program, 'u_sourceSize');
    this._pass1PositionLoc = gl.getAttribLocation(this._pass1Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass1Program, 'u_source'), 0);

    // --- Pass 2: ScaleFX ambiguity ---
    this._pass2Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SCALEFX_PASS2_FRAGMENT_SRC);
    gl.useProgram(this._pass2Program);
    this._pass2SourceSizeLoc = gl.getUniformLocation(this._pass2Program, 'u_sourceSize');
    this._pass2PositionLoc = gl.getAttribLocation(this._pass2Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass2Program, 'u_source'), 0);
    gl.uniform1i(gl.getUniformLocation(this._pass2Program, 'u_metricTex'), 1);

    // --- Pass 3: ScaleFX edge level ---
    this._pass3Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SCALEFX_PASS3_FRAGMENT_SRC);
    gl.useProgram(this._pass3Program);
    this._pass3SourceSizeLoc = gl.getUniformLocation(this._pass3Program, 'u_sourceSize');
    this._pass3PositionLoc = gl.getAttribLocation(this._pass3Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass3Program, 'u_source'), 0);

    // --- Pass 4: ScaleFX 3× output ---
    this._pass4Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SCALEFX_PASS4_FRAGMENT_SRC);
    gl.useProgram(this._pass4Program);
    this._pass4SourceSizeLoc = gl.getUniformLocation(this._pass4Program, 'u_sourceSize');
    this._pass4PositionLoc = gl.getAttribLocation(this._pass4Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass4Program, 'u_source'), 0);
    gl.uniform1i(gl.getUniformLocation(this._pass4Program, 'u_originalTex'), 1);

    // --- Pass 5: Sharpsmoother ---
    this._pass5Program = this._createShaderProgram(
      CRT_VERTEX_SRC, SHARPSMOOTHER_FRAGMENT_SRC);
    gl.useProgram(this._pass5Program);
    this._pass5SourceSizeLoc = gl.getUniformLocation(this._pass5Program, 'u_sourceSize');
    this._pass5PositionLoc = gl.getAttribLocation(this._pass5Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass5Program, 'u_source'), 0);

    // --- Pass 6: AA level2 pass 1 ---
    this._pass6Program = this._createShaderProgram(
      CRT_VERTEX_SRC, AA_LEVEL2_PASS1_FRAGMENT_SRC);
    gl.useProgram(this._pass6Program);
    this._pass6SourceSizeLoc = gl.getUniformLocation(this._pass6Program, 'u_sourceSize');
    this._pass6PositionLoc = gl.getAttribLocation(this._pass6Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass6Program, 'u_source'), 0);

    // --- Pass 7: AA level2 pass 2 ---
    this._pass7Program = this._createShaderProgram(
      CRT_VERTEX_SRC, AA_LEVEL2_PASS2_FRAGMENT_SRC);
    gl.useProgram(this._pass7Program);
    this._pass7SourceSizeLoc = gl.getUniformLocation(this._pass7Program, 'u_sourceSize');
    this._pass7PositionLoc = gl.getAttribLocation(this._pass7Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass7Program, 'u_source'), 0);

    // --- Pass 8: EWA smooth downsample ---
    this._pass8Program = this._createShaderProgram(
      CRT_VERTEX_SRC, DOWNSAMPLE_FRAGMENT_SRC);
    gl.useProgram(this._pass8Program);
    this._pass8SourceSizeLoc = gl.getUniformLocation(this._pass8Program, 'u_sourceSize');
    this._pass8DownscaleFactorLoc = gl.getUniformLocation(this._pass8Program, 'u_downscaleFactor');
    this._pass8PositionLoc = gl.getAttribLocation(this._pass8Program, 'a_position');
    gl.uniform1i(gl.getUniformLocation(this._pass8Program, 'u_texture'), 0);

    // --- Create FBO textures ---

    // Metric texture: W×H RGBA16F
    this._metricTexture = this._createTexture(w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this._metricFbo = this._createFbo(this._metricTexture);

    // Strength texture: W×H RGBA16F
    this._strengthTexture = this._createTexture(w, h, gl.RGBA16F, gl.RGBA, gl.FLOAT);
    this._strengthFbo = this._createFbo(this._strengthTexture);

    // Ambiguity texture: W×H RGBA8
    this._ambiguityTexture = this._createTexture(w, h, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    this._ambiguityFbo = this._createFbo(this._ambiguityTexture);

    // Edge level texture: W×H RGBA8
    this._edgeLevelTexture = this._createTexture(w, h, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    this._edgeLevelFbo = this._createFbo(this._edgeLevelTexture);

    // Upscaled A: 3W×3H RGBA8 (ping-pong)
    this._upscaledA = this._createTexture(w3, h3, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    this._upscaledAFbo = this._createFbo(this._upscaledA);

    // Upscaled B: 3W×3H RGBA8 (ping-pong)
    this._upscaledB = this._createTexture(w3, h3, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    this._upscaledBFbo = this._createFbo(this._upscaledB);

    // Intermediate texture: W×H RGBA8 (final output)
    this._intermediateTexture = this._createTexture(w, h, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    this._intermediateFbo = this._createFbo(this._intermediateTexture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Run passes 0-8 (ScaleFX → sharpsmoother → AA → EWA downsample) into internal FBO. */
  renderSmoothing(): void {
    const gl = this._gl;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const w3 = w * 3;
    const h3 = h * 3;

    const readyTex = this._getReadyTexture();

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.disable(gl.BLEND);

    // --- Pass 0: ScaleFX metric (original → metricTex, W×H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._metricFbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readyTex);
    gl.useProgram(this._pass0Program);
    gl.uniform2f(this._pass0SourceSizeLoc!, w, h);
    gl.enableVertexAttribArray(this._pass0PositionLoc);
    gl.vertexAttribPointer(this._pass0PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 1: ScaleFX strength (metricTex → strengthTex, W×H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._strengthFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._metricTexture);
    gl.useProgram(this._pass1Program);
    gl.uniform2f(this._pass1SourceSizeLoc!, w, h);
    gl.enableVertexAttribArray(this._pass1PositionLoc);
    gl.vertexAttribPointer(this._pass1PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 2: ScaleFX ambiguity (strengthTex + metricTex → ambiguityTex, W×H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._ambiguityFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._strengthTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._metricTexture);
    gl.useProgram(this._pass2Program);
    gl.uniform2f(this._pass2SourceSizeLoc!, w, h);
    gl.enableVertexAttribArray(this._pass2PositionLoc);
    gl.vertexAttribPointer(this._pass2PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 3: ScaleFX edge level (ambiguityTex → edgeLevelTex, W×H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._edgeLevelFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._ambiguityTexture);
    gl.useProgram(this._pass3Program);
    gl.uniform2f(this._pass3SourceSizeLoc!, w, h);
    gl.enableVertexAttribArray(this._pass3PositionLoc);
    gl.vertexAttribPointer(this._pass3PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 4: ScaleFX 3× output (edgeLevelTex + original → upscaledA, 3W×3H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledAFbo);
    gl.viewport(0, 0, w3, h3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._edgeLevelTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readyTex);
    gl.useProgram(this._pass4Program);
    gl.uniform2f(this._pass4SourceSizeLoc!, w, h);
    gl.enableVertexAttribArray(this._pass4PositionLoc);
    gl.vertexAttribPointer(this._pass4PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 5: Sharpsmoother (upscaledA → upscaledB, 3W×3H, NEAREST) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledBFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledA);
    gl.useProgram(this._pass5Program);
    gl.uniform2f(this._pass5SourceSizeLoc!, w3, h3);
    gl.enableVertexAttribArray(this._pass5PositionLoc);
    gl.vertexAttribPointer(this._pass5PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 6: AA level2 pass 1 (upscaledB → upscaledA, 3W×3H, LINEAR) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledAFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledB);
    // AA passes need LINEAR filtering for fractional texel offsets
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.useProgram(this._pass6Program);
    gl.uniform2f(this._pass6SourceSizeLoc!, w3, h3);
    gl.enableVertexAttribArray(this._pass6PositionLoc);
    gl.vertexAttribPointer(this._pass6PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // Restore NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // --- Pass 7: AA level2 pass 2 (upscaledA → upscaledB, 3W×3H, LINEAR) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledBFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledA);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.useProgram(this._pass7Program);
    gl.uniform2f(this._pass7SourceSizeLoc!, w3, h3);
    gl.enableVertexAttribArray(this._pass7PositionLoc);
    gl.vertexAttribPointer(this._pass7PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // Restore NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // --- Pass 8: EWA smooth downsample (upscaledB → intermediateTex, W×H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._intermediateFbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledB);
    gl.useProgram(this._pass8Program);
    gl.uniform2f(this._pass8SourceSizeLoc!, w3, h3);
    gl.uniform1f(this._pass8DownscaleFactorLoc!, 3.0);
    gl.enableVertexAttribArray(this._pass8PositionLoc);
    gl.vertexAttribPointer(this._pass8PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.enable(gl.BLEND);
  }

  /** Return the smoothed texture for CRTDisplay integration. */
  getSmoothedTexture(): WebGLTexture {
    return this._intermediateTexture;
  }

  /** Render smoothed output to screen (standalone mode). */
  render(): void {
    if (!this._hasContent()) return;

    this.renderSmoothing();

    // Blit intermediate FBO → default framebuffer
    const gl = this._gl;
    const w = this._canvas.width;
    const h = this._canvas.height;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._intermediateFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** Start RAF display loop (standalone mode). */
  start(): void {
    if (this._rafId !== null) return;
    this._loop();
  }

  /** Stop RAF display loop. */
  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * GPU-downsample the 3W×3H post-AA FBO to 2W×2H using the EWA smooth
   * downsample shader at u_downscaleFactor=1.5, then read via readPixels
   * and return as an ImageBitmap.
   */
  async screenshotUpscaled(): Promise<ImageBitmap> {
    if (this._hasContent()) this.renderSmoothing();
    const gl = this._gl;
    const w = this._canvas.width, h = this._canvas.height;
    const w2 = w * 2, h2 = h * 2;
    const w3 = w * 3, h3 = h * 3;

    // Create temporary texture + FBO at 2W×2H
    const tmpTexture = this._createTexture(w2, h2, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE);
    const tmpFbo = this._createFbo(tmpTexture);

    // Render through EWA smooth downsample at 1.5× scale (3W×3H → 2W×2H)
    gl.viewport(0, 0, w2, h2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledB);
    gl.useProgram(this._pass8Program);
    gl.uniform2f(this._pass8SourceSizeLoc!, w3, h3);
    gl.uniform1f(this._pass8DownscaleFactorLoc!, 1.5);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.enableVertexAttribArray(this._pass8PositionLoc);
    gl.vertexAttribPointer(
      this._pass8PositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.BLEND);

    // Read pixels from temp FBO
    const pixels = new Uint8Array(w2 * h2 * 4);
    gl.readPixels(0, 0, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Clean up temp resources
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tmpFbo);
    gl.deleteTexture(tmpTexture);

    // Flip Y (WebGL bottom-up → canvas top-down)
    const rowSize = w2 * 4;
    const temp = new Uint8Array(rowSize);
    for (let y = 0, yEnd = h2 >> 1; y < yEnd; y++) {
      const top = y * rowSize, bot = (h2 - 1 - y) * rowSize;
      temp.set(pixels.subarray(top, top + rowSize));
      pixels.copyWithin(top, bot, bot + rowSize);
      pixels.set(temp, bot);
    }

    return createImageBitmap(new ImageData(new Uint8ClampedArray(pixels.buffer), w2, h2));
  }

  /** Clean up all GL resources. */
  destroy(): void {
    this.stop();
    const gl = this._gl;

    // Delete 9 programs
    gl.deleteProgram(this._pass0Program);
    gl.deleteProgram(this._pass1Program);
    gl.deleteProgram(this._pass2Program);
    gl.deleteProgram(this._pass3Program);
    gl.deleteProgram(this._pass4Program);
    gl.deleteProgram(this._pass5Program);
    gl.deleteProgram(this._pass6Program);
    gl.deleteProgram(this._pass7Program);
    gl.deleteProgram(this._pass8Program);

    // Delete quad VBO
    gl.deleteBuffer(this._quadVBO);

    // Delete 7 FBOs + 7 textures
    gl.deleteFramebuffer(this._metricFbo);
    gl.deleteTexture(this._metricTexture);
    gl.deleteFramebuffer(this._strengthFbo);
    gl.deleteTexture(this._strengthTexture);
    gl.deleteFramebuffer(this._ambiguityFbo);
    gl.deleteTexture(this._ambiguityTexture);
    gl.deleteFramebuffer(this._edgeLevelFbo);
    gl.deleteTexture(this._edgeLevelTexture);
    gl.deleteFramebuffer(this._upscaledAFbo);
    gl.deleteTexture(this._upscaledA);
    gl.deleteFramebuffer(this._upscaledBFbo);
    gl.deleteTexture(this._upscaledB);
    gl.deleteFramebuffer(this._intermediateFbo);
    gl.deleteTexture(this._intermediateTexture);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _loop(): void {
    this._rafId = requestAnimationFrame(() => this._loop());
    this.render();
  }

  private _createTexture(
    width: number, height: number,
    internalFormat: number, format: number, type: number,
  ): WebGLTexture {
    const gl = this._gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0,
      format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private _createFbo(texture: WebGLTexture): WebGLFramebuffer {
    const gl = this._gl;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, texture, 0);
    return fbo;
  }

  private _createShaderProgram(vSrc: string, fSrc: string): WebGLProgram {
    const gl = this._gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vSrc);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fSrc);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  private _compileShader(type: number, source: string): WebGLShader {
    const gl = this._gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }
}
