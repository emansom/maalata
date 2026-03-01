/**
 * Click-to-Photon Latency Pipeline
 *
 * Models 4 discrete stages of a 2002-era hardware/software pipeline,
 * from USB input polling to LCD panel response. Each stage is a class with
 * historically-accurate timing derived from real measurements of the era.
 *
 * Total worst-case latency: 8 + 10 + 125 + 25 = 168ms
 * Average latency: ~119ms (USB avg 4ms, AppFrame avg 62.5ms phase jitter)
 *
 * GPU queuing latency is now handled by real WebGL triple-buffer FBOs in
 * the WebGLRenderer rather than a simulated delay stage. The triple buffer
 * provides natural 1–2 frame buffering (0–33ms at 60Hz) that replaces the
 * previous 50ms GPUDriverQueue setTimeout.
 *
 * References:
 * - Dan Luu's input lag measurements (iMac G4 2002)
 * - USB 1.1 HID polling specification (125Hz default)
 * - Windows XP timer resolution and scheduling
 * - 2002 TN panel response times (Dell 1504FP: 25ms)
 */

import type { CanvasCommand } from 'canvas-ultrafast';

type Sink = (batch: CanvasCommand[]) => void;

// ---------------------------------------------------------------------------
// Base classes
// ---------------------------------------------------------------------------

abstract class PipelineStage {
  protected _sink: Sink | null = null;

  /** Connect output to a raw callback. No _ prefix: cross-file access. */
  pipe(sink: Sink): void { this._sink = sink; }

  /** Connect output to the next stage. Returns the target for chaining. */
  pipeTo(stage: PipelineStage): PipelineStage {
    this._sink = (batch) => stage.receive(batch);
    return stage;
  }

  /** Accept a batch of commands from the previous stage. */
  abstract receive(batch: CanvasCommand[]): void;

  /** Tear down timers and resources. */
  abstract destroy(): void;

  protected _forward(batch: CanvasCommand[]): void { this._sink?.(batch); }
}

/**
 * A pipeline stage that applies a fixed delay before forwarding.
 * Subclasses only need to declare _DELAY_MS.
 */
abstract class DelayStage extends PipelineStage {
  protected abstract readonly _DELAY_MS: number;
  private _timers: ReturnType<typeof setTimeout>[] = [];

  receive(batch: CanvasCommand[]): void {
    const timer = setTimeout(() => {
      const idx = this._timers.indexOf(timer);
      if (idx !== -1) this._timers.splice(idx, 1);
      this._forward(batch);
    }, this._DELAY_MS);
    this._timers.push(timer);
  }

  destroy(): void {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }
}

// ---------------------------------------------------------------------------
// Stage 1: USB Polling (pull-based, 125Hz / 8ms)
// ---------------------------------------------------------------------------

/**
 * Polls the CanvasAPI command buffer at 8ms intervals — mirrors how USB 1.1
 * HID host controllers poll devices at a fixed 125Hz rate, reading whatever
 * input reports have accumulated since the last poll.
 */
export class USBPolling extends PipelineStage {
  private readonly _POLL_MS = 8;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _source: (() => CanvasCommand[]) | null;

  constructor(source: () => CanvasCommand[]) {
    super();
    this._source = source;
    this._interval = setInterval(() => this._poll(), this._POLL_MS);
  }

  private _poll(): void {
    const cmds = this._source?.();
    if (cmds && cmds.length > 0) this._forward(cmds);
  }

  receive(): void {} // Pull-based; ignores pushed batches
  destroy(): void {
    if (this._interval !== null) { clearInterval(this._interval); this._interval = null; }
    this._source = null;
  }
}

// ---------------------------------------------------------------------------
// Stage 2: OS Kernel Processing (10ms delay)
// ---------------------------------------------------------------------------

/**
 * Windows XP interrupt handling: ISR processes USB completion (~1ms),
 * DPC queues the input message (~1ms), thread scheduling adds jitter
 * on a loaded 2002 system. 10ms total accounts for realistic scheduling
 * latency without conflating with the 15.6ms timer tick (which only
 * affects Sleep()-based timing, not input delivery).
 */
export class OSKernelProcessing extends DelayStage {
  protected readonly _DELAY_MS = 10;
}

// ---------------------------------------------------------------------------
// Stage 3: Application Frame (collecting, 125ms tick / 8 FPS)
// ---------------------------------------------------------------------------

/**
 * Game loop processes all pending input once per frame. Collects incoming
 * batches between frame boundaries, delivers as one merged batch at each
 * 125ms tick. The demo's own 8 FPS drawing loop and this stage's 125ms
 * tick are unsynchronized, creating 0–125ms phase jitter (avg 62.5ms) —
 * historically accurate since USB polling and app frame ticks were never
 * synchronized in 2002.
 */
export class ApplicationFrame extends PipelineStage {
  private readonly _FRAME_MS = 125;
  private _buffer: CanvasCommand[] = [];
  private _interval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this._interval = setInterval(() => this._tick(), this._FRAME_MS);
  }

  receive(batch: CanvasCommand[]): void {
    this._buffer.push(...batch);
  }

  private _tick(): void {
    if (this._buffer.length === 0) return;
    const batch = this._buffer;
    this._buffer = [];
    this._forward(batch);
  }

  destroy(): void {
    if (this._interval !== null) { clearInterval(this._interval); this._interval = null; }
    this._buffer = [];
  }
}

// ---------------------------------------------------------------------------
// Stage 4: LCD Panel (25ms delay)
// ---------------------------------------------------------------------------

/**
 * 2002 TN panel physical pixel transition time. The Dell 1504FP (2002)
 * was rated 25ms. GTG transitions were 30–40ms. The 50ms figure only
 * applied to VA/IPS panels, which were rare on desktops.
 */
export class LCDPanel extends DelayStage {
  protected readonly _DELAY_MS = 25;
}
