# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build         # Build maalata (production)
npm run build:dev     # Build maalata (development, sourcemaps, no mangling)
npm run build:all     # Build maalata (prod) + demo (prod)
npm run build:dev-all # Build maalata (dev) + demo (dev)
npm run type-check    # TypeScript type check + lint
npm run clean         # Remove all dist/ directories
npm run verify-demo   # Build dev → serve → Playwright headless test demo

# Serve
npm run serve         # Serve pre-built demo/dist/ on :4173
npm run serve:demo    # Build maalata + demo, serve on :4173
```

## External dependency: canvas-ultrafast

canvas-ultrafast lives in its own project at `~/Projects/canvas-ultrafast/`.
It is linked into this project via `npm link canvas-ultrafast`.
The full source is locally available for modification and bugfixing.
If you modify canvas-ultrafast, rebuild it there before rebuilding maalata.

## Testing

**Always run `npm run verify-demo` after modifying any source file** (`src/`, `demo/src/`).
This script:
1. Builds maalata and the demo in **development mode** (sourcemaps, no minification/mangling)
2. Starts a static server for the demo on :4173
3. Launches headless Chromium via Playwright
4. Tests both demos: CRT demo (`/`) and smoothing demo (`/smoothing.html`)
5. Collects JS exceptions, console.error/warning, failed network requests, visual issues
6. Exits 0 if clean, 1 if any errors were found

Fix all reported errors, then re-run until the exit code is 0 before considering any change complete.

## Documentation

**Always update documentation** when modifying source files:
- **Source code**: Update file headers, JSDoc comments, and inline documentation
- **README.md**: Update relevant sections (architecture, API, algorithm descriptions)
- **CLAUDE.md**: Update architecture descriptions, design decisions, and file listings

## Architecture

Standalone project with demo as a child npm workspace. Depends on canvas-ultrafast (external, via npm link).

### maalata (`src/`)

"2002 era" retro experience. Depends on canvas-ultrafast.

- **`maalata.ts`**: `CanvasRenderer` class. Creates `UltrafastRenderer`, sets CSS `image-rendering: pixelated`, immediately `stopDisplay()`. Builds 4-stage latency pipeline. Orchestrates smoothing and CRT displays independently — both configurable via `RendererConfig` and runtime-toggleable via `setSmoothing()`/`setCRT()`. Manages idle shutdown. Single RAF invariant: exactly one RAF loop runs at a time.
- **`pipeline.ts`**: USB(8ms) → OS(10ms) → App(125ms) → LCD(25ms) latency simulation.
- **`smoothing-display.ts`**: `SmoothingDisplay` class. Standalone pixel art smoothing. Eight-pass rendering: ScaleFX metric/strength/ambiguity/edge-level/3×-output (passes 0-4, W×H → 3W×3H) → sharpsmoother (pass 5) → marching squares (pass 6) → EWA smooth downsample (pass 7, 3W×3H → W×H). All textures use NEAREST filtering exclusively. Uses RGBA16F FBOs for metric/strength passes, ping-pong 3W×3H FBOs for passes 4-6. Requires `EXT_color_buffer_float`. Used standalone (with `smoothing: true, crt: false`) or as a delegate inside CRTDisplay. Purely algorithmic — no async loading needed.
- **`crt-display.ts`**: `CRTDisplay` class. Owns RAF loop when CRT enabled. Accepts optional borrowed `SmoothingDisplay` reference — calls `renderSmoothing()` synchronously before CRT shader when smoothing active. BFI has highest priority: Hz detection, frame capture, and rolling scan run at full RAF cadence regardless of smoothing state. `setSmoothing()` allows runtime toggling of smoothing delegation.
- **`smooth-shaders.ts`**: ScaleFX + Sharpsmoother + Marching Squares pixel art smoothing GLSL ES 3.00 shaders. Seven exports: `SCALEFX_PASS0_FRAGMENT_SRC` (Compuphase color distance), `SCALEFX_PASS1_FRAGMENT_SRC` (corner strength), `SCALEFX_PASS2_FRAGMENT_SRC` (ambiguity resolution, reads metric+strength), `SCALEFX_PASS3_FRAGMENT_SRC` (6-level edge classification), `SCALEFX_PASS4_FRAGMENT_SRC` (3× subpixel output, reads edge-level+original), `SHARPSMOOTHER_FRAGMENT_SRC` (edge-preserving smoothing), `MARCHING_SQUARES_FRAGMENT_SRC` (contour-based edge AA, reads sharpsmoother+original). All use CRT_VERTEX_SRC as vertex shader. ScaleFX ported from libretro GLSL 1.30 → GLSL ES 3.00.
- **`downsample-shaders.ts`**: EWA smooth downsample GLSL ES 3.00 fragment shader. 8×8 raised-cosine polar downsample (64 taps, SUPPORT=1.5), configurable `u_downscaleFactor` (3.0 for main pipeline 3W×3H → W×H, 1.5 for screenshots 3W×3H → 2W×2H). No negative lobes, zero ringing.
- **`crt-shaders.ts`**: CRT vertex + fragment GLSL ES 3.00 (barrel distortion, pixel beam, chromatic aberration, etc.).

### Key design decisions

- **Triple-buffered FBOs**: Write → Ready → Display rotation. `submitBatch()` swaps write↔ready. RAF reads from ready. Lock-free via JS single-threading.
- **Pipeline override**: `stopDisplay()` disables auto-flush. Pipeline stages poll `takeCommands()` at 125Hz instead, delivering through 4 delay stages to `submitBatch()`.
- **CRT as overlay**: `CRTDisplay` takes over the display loop on the same GL context, reading from `getReadyTexture()`.
- **Display state machine**: `CanvasRenderer` uses a formal state machine (`DisplayState`: `crt+smoothing` | `crt-only` | `smoothing-only` | `passthrough` | `suspended`) to govern RAF ownership. All transitions go through `_transitionTo()` which exits the old state (stops RAF) before entering the new one (starts RAF). State is derived from `_crtEnabled` and `_smoothingEnabled` booleans via `_deriveMode()`. Resources are lazy-created on first need via `_ensureCRTDisplay()` / `_ensureSmoothingDisplay()` and kept alive until `destroy()`. Public toggles (`setSmoothing()`, `setCRT()`) update the flag and trigger a transition. This guarantees exactly one RAF loop at all times.
- **Idle shutdown**: CRT displays run continuously (emulating a real display) — idle timeout only applies to smoothing-only and passthrough modes. CRT pauses only on tab visibility change. `preserveDrawingBuffer: true` keeps last frame visible. Resume = restart RAF.
- **esbuild `mangleProps: /^_/`**: All `_`-prefixed properties are renamed in production. Cross-file methods must NOT use `_` prefix. Each package mangles independently.
- **Pixel beam (Gaussian CRT phosphor dots)**: Step 10 renders each virtual CRT pixel as a 2D Gaussian with brightness-dependent width. Replaces both the sin-based scanlines and mod-based dot mask — on real CRTs, scanline gaps were created by the beam's vertical profile (same physical effect as horizontal dot shaping). Auto-derived from canvas size: `beamScale = max(3.0, height/180)`. No CRTConfig fields; always active.
- **CRT colorspace (BT.1886 → sRGB)**: Shader decodes with γ=2.4 (BT.1886 CRT phosphor response), processes effects in linear space, encodes with γ=2.2 (sRGB). Net gamma 1.09 = authentic CRT contrast. No color primary conversion needed (PC P22 phosphors ≈ sRGB). WebGL RGBA textures have no hardware sRGB — all gamma is manual via `pow()`. See `crt-shaders.ts` file header for full rationale.
- **1:1 pixel art philosophy**: maalata targets 1:1 pixel art rendering. Consumers draw at native resolution and get improved visuals (smoothing, CRT effects) automatically — no code changes needed. All upscaling and processing is handled internally.
- **NEAREST filtering + CSS pixelated**: All textures across canvas-ultrafast and maalata use `gl.NEAREST` — no hardware bilinear interpolation at any stage. canvas-ultrafast defaults `imageSmoothingEnabled` to `false`. maalata adds `image-rendering: pixelated` on the canvas element. Together, these ensure pixel-perfect rendering from WebGL texture sampling through browser compositing.
- **Pixel art smoothing (ScaleFX + sharpsmoother + marching squares + EWA smooth)**: Eight-pass pre-processing in `SmoothingDisplay`: (0-4) ScaleFX — Compuphase perceptual color distance, 6-level edge classification with precise slope detection, 3× subpixel output (W×H → 3W×3H), (5) sharpsmoother — edge-preserving 3×3 perceptual-weighted smoothing, (6) marching squares — contour-based edge AA using Compuphase distance, SDF, and smoothstep blending, (7) EWA smooth downsample — raised-cosine 8×8 polar downsample, no negative lobes (3W×3H → W×H). Same output size, SVG-quality anti-aliased edges. Passes 0-1 use RGBA16F FBOs (requires `EXT_color_buffer_float`). All textures use NEAREST filtering exclusively. Purely algorithmic (no LUT, no async loading) — `ready()` resolves immediately. Total VRAM: 25 WH. Smoothing bypass is via null `SmoothingDisplay` reference in CRTDisplay.
- **Canvas size invariant**: The WebGL output must always be the same size as the canvas input. Never change canvas dimensions to accommodate internal pipeline changes. Internal upscaling (e.g., 3× ScaleFX) is purely in GPU FBOs; the downsample step must preserve maximum detail when returning to the original canvas resolution.
- **GLSL ES 3.00**: All shaders across canvas-ultrafast and maalata use `#version 300 es` (GLSL ES 3.00 / WebGL 2.0). `in`/`out` instead of `attribute`/`varying`, `texture()` instead of `texture2D()`, `out vec4 fragColor` instead of `gl_FragColor`, `mat4x3` natively supported.
- **BFI priority**: Black Frame Insertion has the highest priority in the renderer stack. CRTDisplay owns the RAF loop whenever CRT is enabled (states `crt+smoothing` and `crt-only`), ensuring BFI's Hz detection (EMA-smoothed delta with hysteresis), frame capture (blitFramebuffer to history ring), and rolling scan simulation operate at full RAF cadence. Smoothing toggling cannot interrupt BFI timing — smoothing is called synchronously inside CRT's render frame.
- **Single RAF invariant**: Exactly one `requestAnimationFrame` loop runs at any given time. The display state machine enforces stop-before-start on every transition. Priority: CRTDisplay (`crt+smoothing`, `crt-only`) > SmoothingDisplay (`smoothing-only`) > UltrafastRenderer passthrough.

### Renderer events

`CanvasRenderer` dispatches events via `.on(eventType, callback)`. Returns an unsubscribe function.

| Event | When | Callback |
|---|---|---|
| `ready` | Renderer initialized (initial or after restart) | `{ type }` |
| `suspending` | Before idle shutdown (non-CRT modes only) | `{ type, done }` — must call `done()` |
| `resuming` | Restart triggered (non-CRT modes only) | `{ type }` |

### Build output

maalata produces ES + UMD formats with `.d.ts` declarations via `vite-plugin-dts`. Filenames include a per-build content hash. maalata externalizes canvas-ultrafast (not bundled into its output).

### Demo project

- **`demo/`**: Multi-page demo with two pages:
  - **`index.html`** (`demo/src/main.ts`): CRT demo — full maalata experience with CRT post-processing, pipeline delay, 8 FPS rendering, idle shutdown events.
  - **`smoothing.html`** (`demo/src/smoothing.ts`): Smoothing demo — three canvases: raw (400×400), ScaleFX+marching-squares+EWA smoothed (400×400), and ScaleFX+marching-squares 2× upscale (800×800, GPU-downsampled from 3× via EWA smooth). Habbo avatar at native 1:1 size.
