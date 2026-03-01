/**
 * CRT Display — Post-processing overlay for the "2002 era" experience.
 *
 * Takes ownership of the display loop on a shared WebGL2 context.
 * Reads from UltrafastRenderer's ready texture and applies CRT shader
 * effects (barrel distortion, scanlines, chromatic aberration, etc.)
 * before blitting to the default framebuffer.
 *
 * Shader lineage:
 * - Ichiaka/CRTFilter (MIT) — original effects pipeline
 * - gingerbeardman/webgl-crt-shader (MIT) — performance optimizations + vignette
 *
 * See crt-shaders.ts for detailed attribution and per-effect documentation.
 *
 * Config is backward-compatible: existing boolean fields (retraceLines, dotMask)
 * are accepted and converted to float uniforms internally. New fields
 * (vignetteStrength, scanlineCount) default to off / current behavior.
 */

import { CRT_VERTEX_SRC, CRT_FRAGMENT_SRC } from './crt-shaders';

export interface CRTConfig {
  barrelDistortion: number;
  curvature: number;
  chromaticAberration: number;
  staticNoise: number;
  horizontalTearing: number;
  glowBloom: number;
  verticalJitter: number;
  retraceLines: boolean;
  scanlineIntensity: number;
  dotMask: boolean;
  brightness: number;
  contrast: number;
  desaturation: number;
  flicker: number;
  signalLoss: number;
  vignetteStrength: number;
  scanlineCount: number;
  bfiStrength: number;
  bfiTargetHz: number;
  bfiGainVsBlur: number;
}

const _DEFAULT_CRT_CONFIG: CRTConfig = {
  barrelDistortion: 0.001,
  curvature: 0.002,
  chromaticAberration: 0.0005,
  staticNoise: 0.001,
  horizontalTearing: 0.00012,
  glowBloom: 0.001,
  verticalJitter: 0.001,
  retraceLines: true,
  scanlineIntensity: 0.6,
  dotMask: false,
  brightness: 0.9,
  contrast: 1.0,
  desaturation: 0.2,
  flicker: 0.01,
  signalLoss: 0.05,
  vignetteStrength: 0,
  scanlineCount: 800,
  bfiStrength: 0,
  bfiTargetHz: 60,
  bfiGainVsBlur: 0.7,
};

interface _CRTUniforms {
  _time: WebGLUniformLocation | null;
  _barrel: WebGLUniformLocation | null;
  _aberration: WebGLUniformLocation | null;
  _noise: WebGLUniformLocation | null;
  _tearing: WebGLUniformLocation | null;
  _glow: WebGLUniformLocation | null;
  _jitter: WebGLUniformLocation | null;
  _dotMask: WebGLUniformLocation | null;
  _brightness: WebGLUniformLocation | null;
  _contrast: WebGLUniformLocation | null;
  _desaturation: WebGLUniformLocation | null;
  _flicker: WebGLUniformLocation | null;
  _scanlineIntensity: WebGLUniformLocation | null;
  _scanlineCount: WebGLUniformLocation | null;
  _curvature: WebGLUniformLocation | null;
  _signalLoss: WebGLUniformLocation | null;
  _vignetteStrength: WebGLUniformLocation | null;
  _bfiStrength: WebGLUniformLocation | null;
  _bfiPhase: WebGLUniformLocation | null;
  _bfiFramesPerHz: WebGLUniformLocation | null;
  _bfiGainVsBlur: WebGLUniformLocation | null;
}

export class CRTDisplay {
  private _gl: WebGL2RenderingContext;
  private _canvas: HTMLCanvasElement;
  private _program: WebGLProgram;
  private _uniforms: _CRTUniforms;
  private _quadVBO: WebGLBuffer;
  private _quadPositionLoc: number;
  private _rafId: number | null = null;
  private _getReadyTexture: () => WebGLTexture;
  private _hasContent: () => boolean;

  // BFI state
  private _frameCount = 0;
  private _bfiActive = false;
  private _measuredHz = 0;
  private _smoothDelta = 0;
  private _lastFrameTime = 0;
  private _bfiCfgStrength = 0;
  private _bfiTargetHz = 60;
  private _bfiGainVsBlur = 0.7;
  private _historyTextures: WebGLTexture[] = [];
  private _historyFbos: WebGLFramebuffer[] = [];
  private _srcFbo: WebGLFramebuffer | null = null;
  private _historyIndex = 0;
  private _lastCrtCycle = -1;
  private _historyInitialized = false;

  constructor(
    gl: WebGL2RenderingContext,
    canvas: HTMLCanvasElement,
    getReadyTexture: () => WebGLTexture,
    hasContent: () => boolean,
    config?: Partial<CRTConfig>,
  ) {
    this._gl = gl;
    this._canvas = canvas;
    this._getReadyTexture = getReadyTexture;
    this._hasContent = hasContent;

    // Create CRT shader program
    this._program = this._createShaderProgram(CRT_VERTEX_SRC, CRT_FRAGMENT_SRC);

    // Cache uniform locations
    this._uniforms = this._cacheCRTUniforms(this._program);

    // Set CRT config uniforms
    this._setCRTConfig(config);

    // Create own fullscreen quad VBO
    this._quadVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    this._quadPositionLoc = gl.getAttribLocation(this._program, 'a_position');
  }

  /** Render one CRT frame — reads ready texture, applies effects, blits to screen. */
  render(): void {
    if (!this._hasContent()) return;

    const gl = this._gl;
    const u = this._uniforms;

    // BFI: detect cycle boundary, capture frame, bind history, set uniforms
    if (this._bfiActive && this._historyInitialized) {
      const framesPerHz = this._measuredHz / this._bfiTargetHz;
      const currentCycle = Math.floor(this._frameCount / framesPerHz);

      if (currentCycle !== this._lastCrtCycle) {
        this._lastCrtCycle = currentCycle;
        this._historyIndex = (this._historyIndex + 1) % 3;
        this._captureFrame();
      }

      // Bind history textures: TEXTURE1=prev2, TEXTURE2=prev1, TEXTURE3=curr
      const idx = this._historyIndex;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._historyTextures[(idx + 1) % 3]);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._historyTextures[(idx + 2) % 3]);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._historyTextures[idx]);
    }

    // Bind default framebuffer (display canvas)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);

    // Bind ready texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._getReadyTexture());

    // Use CRT program
    gl.useProgram(this._program);
    gl.uniform1f(u._time, performance.now() / 1000.0);

    // BFI uniforms
    if (this._bfiActive && this._historyInitialized) {
      const framesPerHz = this._measuredHz / this._bfiTargetHz;
      const phase = (this._frameCount % framesPerHz) / framesPerHz;
      gl.uniform1f(u._bfiStrength!, this._bfiCfgStrength);
      gl.uniform1f(u._bfiPhase!, phase);
      gl.uniform1f(u._bfiFramesPerHz!, framesPerHz);
      gl.uniform1f(u._bfiGainVsBlur!, this._bfiGainVsBlur);
    } else {
      gl.uniform1f(u._bfiStrength!, 0.0);
    }

    // Draw fullscreen quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
    gl.enableVertexAttribArray(this._quadPositionLoc);
    gl.vertexAttribPointer(this._quadPositionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.BLEND);
  }

  /** Start CRT RAF display loop. */
  start(): void {
    if (this._rafId !== null) return;
    // Reset BFI timing state for re-calibration after idle resume
    this._lastFrameTime = 0;
    this._smoothDelta = 0;
    this._bfiActive = false;
    this._loop();
  }

  /** Stop CRT RAF display loop. */
  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Clean up resources. */
  destroy(): void {
    this.stop();
    const gl = this._gl;
    gl.deleteProgram(this._program);
    gl.deleteBuffer(this._quadVBO);

    // Clean up BFI frame history resources
    for (const tex of this._historyTextures) gl.deleteTexture(tex);
    for (const fbo of this._historyFbos) gl.deleteFramebuffer(fbo);
    if (this._srcFbo) gl.deleteFramebuffer(this._srcFbo);
    this._historyTextures = [];
    this._historyFbos = [];
    this._srcFbo = null;
    this._historyInitialized = false;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _loop(): void {
    this._rafId = requestAnimationFrame(() => this._loop());
    this._frameCount = (this._frameCount + 1) % 100000;
    if (this._bfiCfgStrength > 0) {
      this._updateHz();
    }
    this.render();
  }

  private _cacheCRTUniforms(program: WebGLProgram): _CRTUniforms {
    const gl = this._gl;
    return {
      _time:              gl.getUniformLocation(program, 'u_time'),
      _barrel:            gl.getUniformLocation(program, 'u_barrel'),
      _aberration:        gl.getUniformLocation(program, 'u_aberration'),
      _noise:             gl.getUniformLocation(program, 'u_noise'),
      _tearing:           gl.getUniformLocation(program, 'u_tearing'),
      _glow:              gl.getUniformLocation(program, 'u_glow'),
      _jitter:            gl.getUniformLocation(program, 'u_jitter'),
      _dotMask:           gl.getUniformLocation(program, 'u_dotMask'),
      _brightness:        gl.getUniformLocation(program, 'u_brightness'),
      _contrast:          gl.getUniformLocation(program, 'u_contrast'),
      _desaturation:      gl.getUniformLocation(program, 'u_desaturation'),
      _flicker:           gl.getUniformLocation(program, 'u_flicker'),
      _scanlineIntensity: gl.getUniformLocation(program, 'u_scanlineIntensity'),
      _scanlineCount:     gl.getUniformLocation(program, 'u_scanlineCount'),
      _curvature:         gl.getUniformLocation(program, 'u_curvature'),
      _signalLoss:        gl.getUniformLocation(program, 'u_signalLoss'),
      _vignetteStrength:  gl.getUniformLocation(program, 'u_vignetteStrength'),
      _bfiStrength:       gl.getUniformLocation(program, 'u_bfiStrength'),
      _bfiPhase:          gl.getUniformLocation(program, 'u_bfiPhase'),
      _bfiFramesPerHz:    gl.getUniformLocation(program, 'u_bfiFramesPerHz'),
      _bfiGainVsBlur:     gl.getUniformLocation(program, 'u_bfiGainVsBlur'),
    };
  }

  private _setCRTConfig(config?: Partial<CRTConfig>): void {
    const gl = this._gl;
    const c = { ..._DEFAULT_CRT_CONFIG, ...config };
    const u = this._uniforms;

    gl.useProgram(this._program);
    gl.uniform1f(u._barrel!, c.barrelDistortion);
    gl.uniform1f(u._aberration!, c.chromaticAberration);
    gl.uniform1f(u._noise!, c.staticNoise);
    gl.uniform1f(u._tearing!, c.horizontalTearing);
    gl.uniform1f(u._glow!, c.glowBloom);
    gl.uniform1f(u._jitter!, c.verticalJitter);
    gl.uniform1f(u._brightness!, c.brightness);
    gl.uniform1f(u._contrast!, c.contrast);
    gl.uniform1f(u._desaturation!, c.desaturation);
    gl.uniform1f(u._flicker!, c.flicker);
    gl.uniform1f(u._curvature!, c.curvature);
    gl.uniform1f(u._signalLoss!, c.signalLoss);
    gl.uniform1f(u._scanlineCount!, c.scanlineCount);
    gl.uniform1f(u._vignetteStrength!, c.vignetteStrength);

    // Backward compatibility: boolean retraceLines controls scanlineIntensity
    // When retraceLines is false, zero out scanline intensity to disable the effect
    gl.uniform1f(u._scanlineIntensity!, c.retraceLines ? c.scanlineIntensity : 0.0);

    // Backward compatibility: boolean dotMask converted to float intensity
    // true → 1.0 (full effect), false → 0.0 (disabled via early-out in shader)
    gl.uniform1f(u._dotMask!, c.dotMask ? 1.0 : 0.0);

    const texLoc = gl.getUniformLocation(this._program, 'u_texture');
    gl.uniform1i(texLoc, 0);

    // BFI config
    this._bfiCfgStrength = c.bfiStrength;
    this._bfiTargetHz = c.bfiTargetHz;
    this._bfiGainVsBlur = c.bfiGainVsBlur;
    gl.uniform1f(u._bfiStrength!, 0.0); // starts off, activated by Hz detection
    gl.uniform1f(u._bfiGainVsBlur!, c.bfiGainVsBlur);

    // Initialize frame history ring buffer if BFI is configured
    if (c.bfiStrength > 0 && !this._historyInitialized) {
      this._initHistory();

      // Set sampler uniform bindings (once)
      const prev2Loc = gl.getUniformLocation(this._program, 'u_framePrev2');
      const prev1Loc = gl.getUniformLocation(this._program, 'u_framePrev1');
      const currLoc = gl.getUniformLocation(this._program, 'u_frameCurr');
      gl.uniform1i(prev2Loc, 1);
      gl.uniform1i(prev1Loc, 2);
      gl.uniform1i(currLoc, 3);
    }
  }

  /** Allocate 3 history textures + FBOs + source FBO for frame capture. */
  private _initHistory(): void {
    const gl = this._gl;
    const w = this._canvas.width;
    const h = this._canvas.height;

    for (let i = 0; i < 3; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._historyTextures.push(tex);

      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this._historyFbos.push(fbo);
    }

    // Source FBO for reading from ready texture via blitFramebuffer
    this._srcFbo = gl.createFramebuffer()!;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._historyInitialized = true;
  }

  /** GPU-copy ready texture into current history slot via blitFramebuffer. */
  private _captureFrame(): void {
    const gl = this._gl;
    const w = this._canvas.width;
    const h = this._canvas.height;

    // Bind ready texture as READ source
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._srcFbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._getReadyTexture(), 0);

    // Bind current history slot as DRAW target
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._historyFbos[this._historyIndex]);

    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** EMA-based Hz detection with hysteresis for BFI activation. */
  private _updateHz(): void {
    const now = performance.now();
    if (this._lastFrameTime === 0) {
      this._lastFrameTime = now;
      return;
    }

    const delta = now - this._lastFrameTime;
    this._lastFrameTime = now;

    // Tab-background guard: reset EMA when delta > 100ms
    if (delta > 100) {
      this._smoothDelta = 0;
      return;
    }

    // EMA with alpha ≈ 0.05 (converges in ~20 frames)
    if (this._smoothDelta === 0) {
      this._smoothDelta = delta;
    } else {
      this._smoothDelta += (delta - this._smoothDelta) * 0.05;
    }

    this._measuredHz = 1000 / this._smoothDelta;

    const framesPerHz = this._measuredHz / this._bfiTargetHz;

    // Hysteresis: activate at ≥120Hz, deactivate at <110Hz
    // Guard: only activate when framesPerHz ≥ 1.5
    if (!this._bfiActive) {
      if (this._measuredHz >= 120 && framesPerHz >= 1.5) {
        this._bfiActive = true;
      }
    } else {
      if (this._measuredHz < 110) {
        this._bfiActive = false;
      }
    }
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
