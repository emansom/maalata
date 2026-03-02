/**
 * Maalata — "2002 era" Retro Canvas Experience
 *
 * Pixel art canvas renderer with display state machine. Combines
 * canvas-ultrafast's WebGL Canvas 2D renderer with:
 * - NEAREST texture filtering + CSS image-rendering: pixelated (no smoothing)
 * - 4-stage click-to-photon latency pipeline (168ms worst-case)
 * - Pixel art smoothing (ScaleFX + sharpsmoother + AA level2 + EWA smooth)
 * - CRT post-processing shader (barrel distortion, scanlines, etc.)
 * - 60s idle shutdown with transparent restart
 *
 * Renderer stack priority: BFI > CRT > Smoothing > Passthrough.
 * Exactly one requestAnimationFrame loop runs at any given time.
 * Smoothing and CRT are independently toggleable — both via RendererConfig
 * (initial state) and runtime methods (setSmoothing(), setCRT()).
 * All CRT shader effects are additionally toggleable via updateCRTConfig().
 */

import { UltrafastRenderer, CanvasAPI, parseColor, type CanvasCommand } from 'canvas-ultrafast';
import { CRTDisplay, type CRTConfig } from './crt-display';
import { SmoothingDisplay } from './smoothing-display';
import { USBPolling, OSKernelProcessing, ApplicationFrame, LCDPanel } from './pipeline';

export { CanvasAPI } from 'canvas-ultrafast';
export { type CRTConfig } from './crt-display';

export interface RendererConfig {
  canvas: HTMLCanvasElement;
  /** Enable CRT post-processing filter. Default: true. Toggleable at runtime via setCRT(). */
  crt?: boolean;
  /** CRT filter parameters. Only used when crt is enabled. */
  crtConfig?: Partial<CRTConfig>;
  /** Enable pixel art smoothing. Default: true. Toggleable at runtime via setSmoothing(). */
  smoothing?: boolean;
  /** Explicit background color (CSS string). If omitted, auto-detected from DOM. */
  backgroundColor?: string;
}

export type RendererEvent =
  | { type: 'ready' }
  | { type: 'resuming' }
  | { type: 'canvas-replaced'; canvas: HTMLCanvasElement }
  | { type: 'suspending'; done: () => void }
  | { type: 'canvas-replacing'; done: () => void };

/**
 * Display state machine — governs RAF ownership and display mode.
 * Exactly one requestAnimationFrame loop runs at any given time.
 * Priority: CRTDisplay > SmoothingDisplay > UltrafastRenderer passthrough.
 */
type DisplayState =
  | 'crt+smoothing'   // CRTDisplay RAF, smoothing delegate active
  | 'crt-only'        // CRTDisplay RAF, no smoothing
  | 'smoothing-only'  // SmoothingDisplay RAF
  | 'passthrough'     // UltrafastRenderer passthrough
  | 'suspended';      // No RAF (idle shutdown)

export class CanvasRenderer {
  private _canvas: HTMLCanvasElement;
  private _renderer: UltrafastRenderer;
  private _crtDisplay: CRTDisplay | null = null;
  private _smoothingDisplay: SmoothingDisplay | null = null;
  private _crtEnabled: boolean;
  private _smoothingEnabled: boolean;
  private _crtConfig?: Partial<CRTConfig>;
  private _canvasAPI: CanvasAPI;
  private _eventListeners: Map<string, Set<(event: RendererEvent) => void>> = new Map();
  private _initPromise: Promise<void>;
  private _hasContent = false;

  // Pipeline stages
  private _pipelineStages: { destroy(): void }[] = [];

  // Last submitted batch (for visibility change replay)
  private _lastBatch: CanvasCommand[] = [];

  // Display state machine
  private _displayState: DisplayState = 'suspended';
  private _idleTimer: number | null = null;
  private readonly _IDLE_TIMEOUT_MS = 60_000;

  private _boundActivityHandler = (): void => {
    if (this._displayState !== 'suspended') this._resetIdleTimer();
  };

  private _boundVisibilityHandler = (): void => {
    if (document.visibilityState !== 'visible' || this._lastBatch.length === 0) return;
    this._ensureActive();
    this._resetIdleTimer();
    this._renderer.submitBatch(this._lastBatch);
  };

  constructor(config: RendererConfig) {
    this._canvas = config.canvas;
    this._crtEnabled = config.crt ?? true;
    this._smoothingEnabled = config.smoothing ?? true;
    this._crtConfig = config.crtConfig;

    // Create UltrafastRenderer on the user's canvas
    this._renderer = new UltrafastRenderer(this._canvas);

    // Pixel-perfect browser compositing — prevent subpixel smoothing on CSS-scaled canvas
    this._canvas.style.imageRendering = 'pixelated';

    // Immediately stop the passthrough display — we control the display loop
    this._renderer.stopDisplay();

    // Get the shared CanvasAPI from the renderer
    this._canvasAPI = this._renderer.getCanvasAPI();

    // Apply explicit background color override, or use canvas-ultrafast's auto-detected value
    if (config.backgroundColor) {
      const c = parseColor(config.backgroundColor);
      this._renderer.setBackgroundColor(c[0], c[1], c[2]);
    }

    // Transition to the derived display mode
    this._transitionTo(this._deriveMode());

    // Build the 4-stage latency pipeline
    this._buildPipeline();

    // Activity listeners for idle detection
    this._attachActivityListeners(this._canvas);
    document.addEventListener('visibilitychange', this._boundVisibilityHandler);

    // Smoothing is purely algorithmic — no async loading needed.
    // ready() resolves immediately (backwards-compatible for consumers that await it).
    this._initPromise = Promise.resolve();
    this._resetIdleTimer();

    // Dispatch ready event asynchronously
    queueMicrotask(() => this._dispatchEvent({ type: 'ready' }));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public ready(): Promise<void> {
    return this._initPromise;
  }

  public getCanvas(): HTMLCanvasElement {
    return this._renderer.getCanvas();
  }

  public getCanvasAPI(): CanvasAPI {
    return this._canvasAPI;
  }

  public on<K extends RendererEvent['type']>(
    eventType: K,
    callback: (event: Extract<RendererEvent, { type: K }>) => void
  ): () => void {
    if (!this._eventListeners.has(eventType)) {
      this._eventListeners.set(eventType, new Set());
    }
    this._eventListeners.get(eventType)!.add(callback as (event: RendererEvent) => void);

    return () => {
      const listeners = this._eventListeners.get(eventType);
      if (listeners) {
        listeners.delete(callback as (event: RendererEvent) => void);
      }
    };
  }

  public updateCRTConfig(config: Partial<CRTConfig>): void {
    if (this._crtDisplay) this._crtDisplay.updateConfig(config);
  }

  /** Set the background color at runtime (e.g. for theme switching). */
  public setBackgroundColor(color: string): void {
    const c = parseColor(color);
    this._renderer.setBackgroundColor(c[0], c[1], c[2]);
    if (this._crtDisplay) this._crtDisplay.setBgColor(c[0], c[1], c[2]);
  }

  /**
   * Toggle pixel art smoothing at runtime. Lazy-creates SmoothingDisplay on
   * first enable. When CRT is active, updates the smoothing delegate
   * reference (no RAF change); when CRT is off, swaps between smoothing
   * RAF and passthrough.
   */
  public setSmoothing(enabled: boolean): void {
    if (enabled === this._smoothingEnabled) return;
    this._smoothingEnabled = enabled;
    if (this._displayState !== 'suspended') {
      this._transitionTo(this._deriveMode());
    }
  }

  /**
   * Toggle CRT post-processing at runtime. Lazy-creates CRTDisplay on first
   * enable. Uses stop-before-start RAF switching. BFI reactivates with Hz
   * re-calibration on re-enable.
   */
  public setCRT(enabled: boolean): void {
    if (enabled === this._crtEnabled) return;
    this._crtEnabled = enabled;
    if (this._displayState !== 'suspended') {
      this._transitionTo(this._deriveMode());
    }
  }

  /**
   * Capture the ScaleFX+AA upscaled texture as a GPU-downsampled 2W×2H
   * ImageBitmap (3W×3H internal → 2W×2H via EWA smooth downsample).
   * Returns null if smoothing is disabled.
   */
  public async screenshotUpscaled(): Promise<ImageBitmap | null> {
    if (this._smoothingEnabled && this._smoothingDisplay) {
      return this._smoothingDisplay.screenshotUpscaled();
    }
    return null;
  }

  public screenshot(): Promise<ImageBitmap> {
    // Force a synchronous render so the canvas has the latest frame.
    // Works in any display state including suspended — sync smoothing
    // delegate to match current _smoothingEnabled flag before rendering.
    if (this._crtEnabled && this._crtDisplay) {
      this._crtDisplay.setSmoothing(
        this._smoothingEnabled && this._smoothingDisplay ? this._smoothingDisplay : null
      );
      this._crtDisplay.render();
    } else if (this._smoothingEnabled && this._smoothingDisplay) {
      this._smoothingDisplay.render();
    }
    // Ensure all GL commands complete before reading the canvas buffer.
    // Required for CPU-based GL implementations (e.g. SwiftShader in headless
    // Chromium) where drawArrays may not finish before createImageBitmap.
    this._renderer.getGL().finish();
    return createImageBitmap(this._canvas);
  }

  public getCanvasSize(): { width: number; height: number } {
    return this._renderer.getCanvasSize();
  }

  public destroy(): void {
    document.removeEventListener('visibilitychange', this._boundVisibilityHandler);
    this._detachActivityListeners(this._canvas);
    this._cancelIdleTimer();
    this._destroyPipeline();
    // Exit current state (stop any active RAF)
    this._exitState(this._displayState);
    if (this._crtDisplay) {
      this._crtDisplay.destroy();
      this._crtDisplay = null;
    }
    if (this._smoothingDisplay) {
      this._smoothingDisplay.destroy();
      this._smoothingDisplay = null;
    }
    this._renderer.destroy();
    this._displayState = 'suspended';
    this._eventListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Private: display state machine
  // -------------------------------------------------------------------------

  /** Derive the target display mode from current feature flags. */
  private _deriveMode(): DisplayState {
    if (this._crtEnabled && this._smoothingEnabled) return 'crt+smoothing';
    if (this._crtEnabled) return 'crt-only';
    if (this._smoothingEnabled) return 'smoothing-only';
    return 'passthrough';
  }

  /** Transition between display states — stop-before-start guarantees no duplicate RAF loops. */
  private _transitionTo(newState: DisplayState): void {
    if (this._displayState === newState) return;
    this._exitState(this._displayState);
    this._enterState(newState);
    this._displayState = newState;
  }

  /** Exit a display state (stop RAF / passthrough). */
  private _exitState(state: DisplayState): void {
    switch (state) {
      case 'crt+smoothing':
      case 'crt-only':
        this._crtDisplay!.stop();
        break;
      case 'smoothing-only':
        this._smoothingDisplay!.stop();
        break;
      case 'passthrough':
        this._renderer.stopDisplay();
        break;
      case 'suspended':
        break;
    }
  }

  /** Enter a display state (start RAF / passthrough). */
  private _enterState(state: DisplayState): void {
    switch (state) {
      case 'crt+smoothing':
        this._ensureSmoothingDisplay();
        this._ensureCRTDisplay();
        this._crtDisplay!.setSmoothing(this._smoothingDisplay!);
        this._crtDisplay!.start();
        break;
      case 'crt-only':
        this._ensureCRTDisplay();
        this._crtDisplay!.setSmoothing(null);
        this._crtDisplay!.start();
        break;
      case 'smoothing-only':
        this._ensureSmoothingDisplay();
        this._smoothingDisplay!.start();
        break;
      case 'passthrough':
        this._renderer.startDisplay();
        break;
      case 'suspended':
        break;
    }
  }

  /** Create SmoothingDisplay on first need, kept alive until destroy(). */
  private _ensureSmoothingDisplay(): void {
    if (this._smoothingDisplay) return;
    this._smoothingDisplay = new SmoothingDisplay(
      this._renderer.getGL(),
      this._canvas,
      () => this._renderer.getReadyTexture(),
      () => this._hasContent,
    );
  }

  /** Create CRTDisplay on first need, kept alive until destroy(). */
  private _ensureCRTDisplay(): void {
    if (this._crtDisplay) return;
    this._crtDisplay = new CRTDisplay(
      this._renderer.getGL(),
      this._canvas,
      () => this._renderer.getReadyTexture(),
      () => this._hasContent,
      this._crtConfig,
    );
    const [bgR, bgG, bgB] = this._renderer.getBackgroundColor();
    this._crtDisplay.setBgColor(bgR, bgG, bgB);
  }

  // -------------------------------------------------------------------------
  // Private: click-to-photon pipeline
  // -------------------------------------------------------------------------

  private _buildPipeline(): void {
    const usb = new USBPolling(() => this._canvasAPI.takeCommands());
    const os  = new OSKernelProcessing();
    const app = new ApplicationFrame();
    const lcd = new LCDPanel();

    usb.pipeTo(os).pipeTo(app).pipeTo(lcd);
    lcd.pipe((batch) => this._submitToRenderer(batch));

    this._pipelineStages = [usb, os, app, lcd];
  }

  private _destroyPipeline(): void {
    for (const stage of this._pipelineStages) stage.destroy();
    this._pipelineStages = [];
  }

  private _submitToRenderer(batch: CanvasCommand[]): void {
    if (batch.length === 0) return;
    this._ensureActive();
    this._resetIdleTimer();
    this._renderer.submitBatch(batch);
    this._hasContent = true;
    this._lastBatch = batch;
  }

  // -------------------------------------------------------------------------
  // Private: idle shutdown lifecycle
  // -------------------------------------------------------------------------

  private _attachActivityListeners(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('mousemove', this._boundActivityHandler);
    canvas.addEventListener('mousedown', this._boundActivityHandler);
    canvas.addEventListener('touchstart', this._boundActivityHandler, { passive: true });
    canvas.addEventListener('touchmove', this._boundActivityHandler, { passive: true });
  }

  private _detachActivityListeners(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener('mousemove', this._boundActivityHandler);
    canvas.removeEventListener('mousedown', this._boundActivityHandler);
    canvas.removeEventListener('touchstart', this._boundActivityHandler);
    canvas.removeEventListener('touchmove', this._boundActivityHandler);
  }

  private _resetIdleTimer(): void {
    this._cancelIdleTimer();
    this._idleTimer = window.setTimeout(() => {
      this._suspend();
    }, this._IDLE_TIMEOUT_MS);
  }

  private _cancelIdleTimer(): void {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  private async _suspend(): Promise<void> {
    if (this._displayState === 'suspended') return;
    this._cancelIdleTimer();
    await this._dispatchAwaited('suspending');
    this._transitionTo('suspended');
  }

  private _ensureActive(): void {
    if (this._displayState !== 'suspended') return;

    this._dispatchEvent({ type: 'resuming' });

    // Backward-compatible no-op events
    this._dispatchEvent({ type: 'canvas-replacing', done: () => {} } as RendererEvent);

    this._transitionTo(this._deriveMode());
    this._resetIdleTimer();

    this._dispatchEvent({ type: 'ready' });
    this._dispatchEvent({ type: 'canvas-replaced', canvas: this.getCanvas() });
  }

  // -------------------------------------------------------------------------
  // Private: event system
  // -------------------------------------------------------------------------

  private _dispatchEvent(event: RendererEvent): void {
    const listeners = this._eventListeners.get(event.type);
    if (listeners) {
      listeners.forEach(listener => listener(event));
    }
  }

  private async _dispatchAwaited(eventType: string): Promise<void> {
    const listeners = this._eventListeners.get(eventType);
    if (!listeners || listeners.size === 0) return;

    const acks = [...listeners].map(listener =>
      new Promise<void>(resolve => {
        switch (eventType) {
          case "canvas-replacing":
          case "suspending":
            listener({ type: eventType, done: resolve } as RendererEvent);
            break;
          case "canvas-replaced":
            listener({ type: eventType, canvas: this.getCanvas() } as RendererEvent);
            break;
          default:
            listener({ type: eventType } as RendererEvent);
        }
      })
    );

    await Promise.race([
      Promise.all(acks),
      new Promise<void>(resolve => window.setTimeout(resolve, 5_000))
    ]);
  }
}
