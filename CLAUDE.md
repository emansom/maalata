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
If you modify canvas-ultrafast, rebuild it there before rebuilding maalata.

## Testing

**Always run `npm run verify-demo` after modifying any source file** (`src/`, `demo/src/`).
This script:
1. Builds maalata and the demo in **development mode** (sourcemaps, no minification/mangling)
2. Starts a static server for the demo on :4173
3. Launches headless Chromium via Playwright
4. Navigates, clicks all buttons, samples 10 animation frames
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

- **`maalata.ts`**: `CanvasRenderer` class. Creates `UltrafastRenderer`, immediately `stopDisplay()`. Builds 4-stage latency pipeline. Manages CRT display and idle shutdown.
- **`pipeline.ts`**: USB(8ms) → OS(10ms) → App(125ms) → LCD(25ms) latency simulation.
- **`crt-display.ts`**: `CRTDisplay` class. Owns its own RAF loop, reads ready texture from UltrafastRenderer, applies four-pass rendering: 4x nearest-neighbor upscale → Kopf-Lischinski smoothing → RGSS 4x downsample → CRT shader.
- **`smooth-shaders.ts`**: Kopf-Lischinski pixel art smoothing fragment GLSL (block detection, YUV similarity, diagonal resolution, edge-aware interpolation). Operates on 4x upscaled texture.
- **`downsample-shaders.ts`**: RGSS 4x downsample fragment GLSL. 4 rotated grid samples per output pixel for anti-aliased reduction from 4x to native resolution.
- **`crt-shaders.ts`**: CRT vertex + fragment GLSL (barrel distortion, pixel beam, chromatic aberration, etc.).

### Key design decisions

- **Triple-buffered FBOs**: Write → Ready → Display rotation. `submitBatch()` swaps write↔ready. RAF reads from ready. Lock-free via JS single-threading.
- **Pipeline override**: `stopDisplay()` disables auto-flush. Pipeline stages poll `takeCommands()` at 125Hz instead, delivering through 4 delay stages to `submitBatch()`.
- **CRT as overlay**: `CRTDisplay` takes over the display loop on the same GL context, reading from `getReadyTexture()`.
- **Idle shutdown**: Stop CRT/passthrough RAF loop. `preserveDrawingBuffer: true` keeps last frame visible. Resume = restart RAF.
- **esbuild `mangleProps: /^_/`**: All `_`-prefixed properties are renamed in production. Cross-file methods must NOT use `_` prefix. Each package mangles independently.
- **Pixel beam (Gaussian CRT phosphor dots)**: Step 10 renders each virtual CRT pixel as a 2D Gaussian with brightness-dependent width. Replaces both the sin-based scanlines and mod-based dot mask — on real CRTs, scanline gaps were created by the beam's vertical profile (same physical effect as horizontal dot shaping). Auto-derived from canvas size: `beamScale = max(3.0, height/180)`. No CRTConfig fields; always active.
- **CRT colorspace (BT.1886 → sRGB)**: Shader decodes with γ=2.4 (BT.1886 CRT phosphor response), processes effects in linear space, encodes with γ=2.2 (sRGB). Net gamma 1.09 = authentic CRT contrast. No color primary conversion needed (PC P22 phosphors ≈ sRGB). WebGL RGBA textures have no hardware sRGB — all gamma is manual via `pow()`. See `crt-shaders.ts` file header for full rationale.
- **Pixel art smoothing (4x Kopf-Lischinski + RGSS)**: Three-pass pre-processing: (1) nearest-neighbor 4x upscale via `blitFramebuffer` (W×H → 2W×2H), (2) Kopf-Lischinski smoothing at 4x resolution in `smooth-shaders.ts` — block detection, YUV similarity graph (Y<=48, U<=7, V<=6), diagonal crossing resolution via valence heuristic, edge-aware interpolation with smoothstep(0.3, 1.0) tuned for 4x blocks, (3) RGSS 4x downsample in `downsample-shaders.ts` — 4 rotated grid samples per output pixel back to native resolution. Same output size, 4× spatial precision for edge interpolation. Bypassed when `_inputSize: [0, 0]`. Always active.

### Renderer events

`CanvasRenderer` dispatches events via `.on(eventType, callback)`. Returns an unsubscribe function.

| Event | When | Callback |
|---|---|---|
| `ready` | Renderer initialized (initial or after restart) | `{ type }` |
| `suspending` | Before idle shutdown | `{ type, done }` — must call `done()` |
| `resuming` | Restart triggered | `{ type }` |
| `canvas-replacing` | Backward compat no-op | `{ type, done }` — must call `done()` |
| `canvas-replaced` | Backward compat no-op | `{ type, canvas }` |

### Build output

maalata produces ES + UMD formats with `.d.ts` declarations via `vite-plugin-dts`. Filenames include a per-build content hash. maalata externalizes canvas-ultrafast (not bundled into its output).

### Demo project

- **`demo/`**: Tests the full maalata experience — CRT, pipeline delay, 8 FPS rendering, idle shutdown events.
