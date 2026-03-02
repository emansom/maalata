/**
 * Standalone Pixel Art Smoothing Display
 *
 * Three-pass rendering pipeline that smooths pixel art edges without CRT
 * effects. Targets 1:1 pixel art — consumers draw at native resolution and
 * get improved visuals automatically, no code changes needed.
 *
 * NEAREST filtering is inherited from canvas-ultrafast (all FBO textures use
 * gl.NEAREST by default), so no per-draw filter overrides are needed.
 *
 *   Pass 0: xBRZ analysis — blend metadata output (W×H → W×H)
 *   Pass 1: xBRZ freescale blend — smoothstep directional blending (W×H → 2W×2H)
 *   Pass 2: RGSS downsample — rotated grid anti-aliasing (2W×2H → W×H)
 *
 * Can be used standalone (render() blits to screen) or as a delegate inside
 * CRTDisplay (renderSmoothing() + getSmoothedTexture() for CRT to read).
 *
 * screenshotUpscaled() reads the 2W×2H upscaled FBO (pass 1 output, before
 * RGSS downsample) via readPixels and returns it as an ImageBitmap — useful
 * for visualizing the xBRZ freescale output at native 2× resolution.
 *
 * xBRZ Freescale uses YCbCr perceptual color distance with dominant gradient
 * detection and shallow/steep line classification. Pass 0 outputs packed
 * blend metadata (not colors); pass 1 reads original pixels and applies
 * smoothstep blending at arbitrary scale factors. Purely algorithmic — no
 * lookup tables or async loading needed.
 *
 * Total VRAM: 6 WH (analysis W×H + upscaled 2W×2H + intermediate W×H).
 */

import { CRT_VERTEX_SRC } from './crt-shaders';
import {
  XBRZ_ANALYSIS_FRAGMENT_SRC,
  XBRZ_BLEND_FRAGMENT_SRC,
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

  // Pass 0: xBRZ analysis (source W×H → metadata W×H)
  private _analysisProgram: WebGLProgram;
  private _analysisSourceSizeLoc: WebGLUniformLocation | null;
  private _analysisPositionLoc: number;
  private _analysisFbo: WebGLFramebuffer;
  private _analysisTexture: WebGLTexture;

  // Pass 1: xBRZ freescale blend (W×H metadata + W×H original → 2W×2H)
  private _upscaleProgram: WebGLProgram;
  private _upscaleSourceSizeLoc: WebGLUniformLocation | null;
  private _upscaleOutputSizeLoc: WebGLUniformLocation | null;
  private _upscalePositionLoc: number;
  private _upscaledFbo: WebGLFramebuffer;
  private _upscaledTexture: WebGLTexture;

  // Pass 2: RGSS downsample (2W×2H → W×H)
  private _downsampleProgram: WebGLProgram;
  private _downsampleSourceSizeLoc: WebGLUniformLocation | null;
  private _downsamplePositionLoc: number;

  // Final output FBO (W × H)
  private _intermediateFbo: WebGLFramebuffer;
  private _intermediateTexture: WebGLTexture;

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

    const w = canvas.width;
    const h = canvas.height;
    const w2 = w * 2;
    const h2 = h * 2;

    // Create fullscreen quad VBO
    this._quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    // --- Pass 0: xBRZ analysis program (CRT vertex + analysis fragment) ---
    this._analysisProgram = this._createShaderProgram(
      CRT_VERTEX_SRC, XBRZ_ANALYSIS_FRAGMENT_SRC);
    gl.useProgram(this._analysisProgram);
    this._analysisSourceSizeLoc = gl.getUniformLocation(
      this._analysisProgram, 'u_sourceSize');
    this._analysisPositionLoc = gl.getAttribLocation(
      this._analysisProgram, 'a_position');
    const analysisSourceLoc = gl.getUniformLocation(
      this._analysisProgram, 'u_source');
    gl.uniform1i(analysisSourceLoc, 0);  // texture unit 0

    // Analysis FBO (W × H)
    this._analysisTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._analysisTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._analysisFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._analysisFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this._analysisTexture, 0);

    // --- Pass 1: xBRZ freescale blend program (CRT vertex + blend fragment) ---
    this._upscaleProgram = this._createShaderProgram(
      CRT_VERTEX_SRC, XBRZ_BLEND_FRAGMENT_SRC);
    gl.useProgram(this._upscaleProgram);
    this._upscaleSourceSizeLoc = gl.getUniformLocation(
      this._upscaleProgram, 'u_sourceSize');
    this._upscaleOutputSizeLoc = gl.getUniformLocation(
      this._upscaleProgram, 'u_outputSize');
    this._upscalePositionLoc = gl.getAttribLocation(
      this._upscaleProgram, 'a_position');
    const upscaleSourceLoc = gl.getUniformLocation(
      this._upscaleProgram, 'u_source');
    gl.uniform1i(upscaleSourceLoc, 0);   // texture unit 0: pass0 metadata
    const upscaleOriginalLoc = gl.getUniformLocation(
      this._upscaleProgram, 'u_original');
    gl.uniform1i(upscaleOriginalLoc, 1); // texture unit 1: original source

    // Upscaled FBO (2W × 2H)
    this._upscaledTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w2, h2, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._upscaledFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this._upscaledTexture, 0);

    // --- Pass 2: RGSS downsample program (CRT vertex + downsample fragment) ---
    this._downsampleProgram = this._createShaderProgram(
      CRT_VERTEX_SRC, DOWNSAMPLE_FRAGMENT_SRC);
    gl.useProgram(this._downsampleProgram);
    this._downsampleSourceSizeLoc = gl.getUniformLocation(
      this._downsampleProgram, 'u_sourceSize');
    this._downsamplePositionLoc = gl.getAttribLocation(
      this._downsampleProgram, 'a_position');
    const downsampleTexLoc = gl.getUniformLocation(
      this._downsampleProgram, 'u_texture');
    gl.uniform1i(downsampleTexLoc, 0);

    // Final output FBO (W × H)
    this._intermediateTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this._intermediateTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._intermediateFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._intermediateFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this._intermediateTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Run passes 0-2 (xBRZ analysis → xBRZ freescale blend → RGSS downsample) into internal FBO. */
  renderSmoothing(): void {
    const gl = this._gl;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const w2 = w * 2;
    const h2 = h * 2;

    const readyTex = this._getReadyTexture();

    // --- Pass 0: xBRZ analysis (W×H → W×H metadata) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._analysisFbo);
    gl.viewport(0, 0, w, h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readyTex);

    gl.useProgram(this._analysisProgram);
    gl.uniform2f(this._analysisSourceSizeLoc!, w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.enableVertexAttribArray(this._analysisPositionLoc);
    gl.vertexAttribPointer(
      this._analysisPositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 1: xBRZ freescale blend (W×H metadata + W×H original → 2W×2H) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledFbo);
    gl.viewport(0, 0, w2, h2);

    // Unit 0: pass0 metadata
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._analysisTexture);
    // Unit 1: original ready texture
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readyTex);

    gl.useProgram(this._upscaleProgram);
    gl.uniform2f(this._upscaleSourceSizeLoc!, w, h);
    gl.uniform2f(this._upscaleOutputSizeLoc!, w2, h2);
    gl.enableVertexAttribArray(this._upscalePositionLoc);
    gl.vertexAttribPointer(
      this._upscalePositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Pass 2: RGSS downsample (2W×2H → W×H) ---
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._intermediateFbo);
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this._upscaledTexture);
    gl.useProgram(this._downsampleProgram);
    gl.uniform2f(this._downsampleSourceSizeLoc!, w2, h2);
    gl.enableVertexAttribArray(this._downsamplePositionLoc);
    gl.vertexAttribPointer(
      this._downsamplePositionLoc, 2, gl.FLOAT, false, 0, 0);
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
   * Read the 2W×2H upscaled FBO (pass 1 output, before RGSS downsample)
   * via readPixels, flip Y, and return as an ImageBitmap.
   */
  async screenshotUpscaled(): Promise<ImageBitmap> {
    if (this._hasContent()) this.renderSmoothing();
    const gl = this._gl;
    const w = this._canvas.width, h = this._canvas.height;
    const w2 = w * 2, h2 = h * 2;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._upscaledFbo);
    const pixels = new Uint8Array(w2 * h2 * 4);
    gl.readPixels(0, 0, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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
    gl.deleteProgram(this._analysisProgram);
    gl.deleteProgram(this._upscaleProgram);
    gl.deleteProgram(this._downsampleProgram);
    gl.deleteBuffer(this._quadVBO);
    gl.deleteFramebuffer(this._analysisFbo);
    gl.deleteTexture(this._analysisTexture);
    gl.deleteFramebuffer(this._upscaledFbo);
    gl.deleteTexture(this._upscaledTexture);
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
