# maalata

2002-era retro canvas experience — historically-calibrated latency pipeline and CRT post-processing over [canvas-ultrafast](https://github.com/emansom/canvas-ultrafast).

## Why

When porting classic Flash and Shockwave codebases to HTML5, the animations become too fluid and responsive. The original experience ran at 4–8 FPS on 50/60Hz displays with real USB polling delays, OS scheduling jitter, and slow LCD panels between the user's click and the photon hitting their eye. That entire pipeline contributed to the feel. Removing it makes the port feel wrong, even when every sprite is pixel-perfect.

maalata restores the authentic click-to-photon latency of a 2002 desktop — USB 1.1 polling, Windows XP scheduling, 8 FPS application loops, TN panel response — and layers CRT post-processing on top. The limitation is strictly visual: the browser continues to process interaction at native refresh rates.

## How it works

### Click-to-photon latency pipeline

Four discrete stages model the full path from input device to screen, each with historically-accurate timing:

```
  click/keypress
       │
       ▼
 ┌───────────┐
 │ USB Poll   │  8ms fixed       USB 1.1 HID host controller polls
 │ (125 Hz)   │                  at 125 Hz — reads whatever input
 └─────┬─────┘                  reports accumulated since last poll
       │
       ▼
 ┌───────────┐
 │ OS Kernel  │  10ms fixed      Windows XP ISR → DPC → thread
 │            │                  scheduling on a loaded system
 └─────┬─────┘
       │
       ▼
 ┌───────────┐
 │ App Frame  │  125ms collect   Game loop processes all pending
 │ (8 FPS)    │                  input once per frame tick —
 └─────┬─────┘                  0–125ms phase jitter (avg 62.5ms)
       │
       ▼
 ┌───────────┐
 │ LCD Panel  │  25ms fixed      2002 TN panel pixel transition
 │            │                  (Dell 1504FP rated 25ms)
 └─────┬─────┘
       │
       ▼
    photon
```

Worst-case: **168ms** (8 + 10 + 125 + 25). Average: **~119ms**. GPU queuing latency is handled by canvas-ultrafast's real WebGL triple-buffer FBOs rather than a simulated delay stage.

### CRT post-processing

A single combined GLSL fragment shader applies 10 effect stages in an optimized order — all UV modifications happen before any texture reads:

1. **Barrel distortion + curvature** — screen warp with OOB early-out
2. **Vertical jitter** — UV offset (conditional)
3. **Horizontal tearing** — UV offset (conditional)
4. **Texture sampling** — 4-way branch: BFI x aberration (1/3/3/9 reads)
5. **Static noise** — time-seeded hash for animated grain
6. **Glow/bloom** — smoothstep-based (no extra texture reads)
7. **Signal loss** — scanline-frequency intensity modulation
8. **Lighting mask** — scanlines + flicker + vignette in a single multiply
9. **Dot mask** — RGB sub-pixel pattern (float intensity)
10. **Color** — desaturation, contrast, brightness

Every effect block is guarded by a `> 0.0001` threshold check for early-out when disabled. The shader was combined from three MIT-licensed sources — see [Inspiration & prior art](#inspiration--prior-art) for full attribution.

**Black Frame Insertion (BFI)** — On displays running at 120Hz+, a rolling scan simulates CRT phosphor decay using a 3-frame trailing buffer. Hz detection uses an EMA-smoothed `requestAnimationFrame` delta with hysteresis (activate at 120Hz, deactivate below 110Hz). Per-channel overlap intervals and gamma-correct blending prevent banding artifacts.

## API overview

```ts
import { CanvasRenderer } from 'maalata';

const renderer = new CanvasRenderer({
  canvas: document.getElementById('canvas') as HTMLCanvasElement,
  crt: true,
  crtConfig: {
    scanlineIntensity: 0.6,
    chromaticAberration: 0.0005,
    flicker: 0.02,
  },
});

// Canvas 2D-compatible drawing API (provided by canvas-ultrafast)
const ctx = renderer.getCanvasAPI();

ctx.fillStyle = '#1a1a2a';
ctx.fillRect(0, 0, 640, 480);
ctx.fillStyle = '#ffffff';
ctx.font = 'bold 20px monospace';
ctx.fillText('Hello from 2002', 20, 35);

// Events
renderer.on('ready', () => { /* initial render */ });
renderer.on('suspending', ({ done }) => { /* idle shutdown after 60s — clean up, call done() */ });
renderer.on('resuming', () => { /* transparent restart on next interaction */ });

// Cleanup
renderer.destroy();
```

### Key exports

| Export | Role |
|---|---|
| `CanvasRenderer` | Latency pipeline + CRT display + idle lifecycle |
| `CanvasAPI` | Canvas 2D-compatible command recording (re-exported from canvas-ultrafast) |
| `CRTConfig` | All CRT shader parameters (barrel, scanlines, BFI, etc.) |
| `RendererConfig` | Constructor options (canvas, crt toggle, CRT config) |
| `RendererEvent` | Union type for lifecycle events |

### CanvasRenderer methods

| Method | Description |
|---|---|
| `getCanvasAPI()` | Return the `CanvasAPI` drawing interface |
| `getCanvas()` | Return the active `<canvas>` element |
| `getCanvasSize()` | Return `{ width, height }` |
| `on(event, callback)` | Subscribe to lifecycle events; returns unsubscribe function |
| `screenshot()` | Capture current CRT-processed frame as `ImageBitmap` |
| `ready()` | `Promise<void>` that resolves when the renderer is initialized |
| `destroy()` | Release all WebGL resources and detach listeners |

## Origin & name

maalata is developed for [HabboWidgets](https://github.com/Quackster/HabboWidgets). Existing rendering libraries didn't fit this highly specific use case, and extracting it into a standalone library prevents code duplication across retro-style web projects.

*Maalata* is Finnish for "to paint" — a homage to the Finnish roots of the early 2000s web-game scene (Habbo Hotel) that inspired this project.

## Inspiration & prior art

### Latency pipeline

The click-to-photon pipeline stages are derived from real hardware measurements and specifications of the era:

- **Dan Luu** — [Input lag measurements](https://danluu.com/input-lag/) on an iMac G4 (2002), providing the reference framework for total click-to-photon latency
- **USB 1.1 HID specification** — 125Hz default polling rate (8ms intervals)
- **Windows XP scheduling** — ISR/DPC interrupt handling and thread scheduling latency
- **Dell 1504FP** — 2002 TN panel rated at 25ms pixel response time

### CRT shader

The combined fragment shader draws from three MIT-licensed implementations:

- **[Ichiaka/CRTFilter](https://github.com/Ichiaka/CRTFilter)** (MIT) — Original basis for the effects pipeline: barrel distortion, chromatic aberration, static noise, horizontal tearing, glow/bloom, vertical jitter, signal loss, scanlines, dot mask, desaturation, contrast/brightness, flicker
- **[gingerbeardman/webgl-crt-shader](https://github.com/gingerbeardman/webgl-crt-shader)** (MIT) — Performance optimizations: early-out guards, OOB check after barrel distortion, Chebyshev-distance vignette, `highp` precision selection, combined lighting mask, configurable scanline count
- **[Blur Busters CRT Beam Simulator](https://github.com/blurbusters/crt-beam-simulator)** (MIT) — By Mark Rejhon and Timothy Lottes. Rolling scan BFI with phosphor decay and variable per-pixel MPRT. Adapted: 3-frame trailing buffer, interval overlap formula, gamma-correct operations, gain-vs-blur tradeoff, per-channel independent processing

### Rendering backend

- **[canvas-ultrafast](https://github.com/emansom/canvas-ultrafast)** — WebGL2-accelerated Canvas 2D engine providing triple-buffered FBOs, command recording, and the ready texture that maalata's CRT shader reads from

## License

[AGPL-3.0-only](LICENSE)
