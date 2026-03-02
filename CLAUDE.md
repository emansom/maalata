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

- **`maalata.ts`**: `CanvasRenderer` class. Creates `UltrafastRenderer`, sets CSS `image-rendering: pixelated`, immediately `stopDisplay()`. Builds 4-stage latency pipeline. Manages CRT display, smoothing display, and idle shutdown.
- **`pipeline.ts`**: USB(8ms) → OS(10ms) → App(125ms) → LCD(25ms) latency simulation.
- **`smoothing-display.ts`**: `SmoothingDisplay` class. Standalone pixel art smoothing. Three-pass rendering: xBRZ analysis (W×H → W×H metadata) → xBRZ freescale blend (W×H → 2W×2H) → RGSS downsample (2W×2H → W×H). Used standalone (with `smoothing: true, crt: false`) or as a delegate inside CRTDisplay. Purely algorithmic — no async loading needed.
- **`crt-display.ts`**: `CRTDisplay` class. Owns its own RAF loop, delegates smoothing to `SmoothingDisplay`, applies CRT shader (12-step effects pipeline) on the smoothed output.
- **`smooth-shaders.ts`**: xBRZ Freescale Multipass pixel art smoothing GLSL ES 3.00 shaders. Two exports: `XBRZ_ANALYSIS_FRAGMENT_SRC` (pass 0 — 3×3+extended neighborhood, YCbCr perceptual distance, 4-corner blend classification with dominant gradient detection, shallow/steep line flags, packed as integer metadata), `XBRZ_BLEND_FRAGMENT_SRC` (pass 1 — decode metadata, smoothstep directional blending at arbitrary scale via `get_left_ratio()`). Both use CRT_VERTEX_SRC as vertex shader.
- **`downsample-shaders.ts`**: RGSS 4x downsample GLSL ES 3.00 fragment shader. 4 rotated grid samples per output pixel. Single stage (2W×2H → W×H).
- **`crt-shaders.ts`**: CRT vertex + fragment GLSL ES 3.00 (barrel distortion, pixel beam, chromatic aberration, etc.).

### Key design decisions

- **Triple-buffered FBOs**: Write → Ready → Display rotation. `submitBatch()` swaps write↔ready. RAF reads from ready. Lock-free via JS single-threading.
- **Pipeline override**: `stopDisplay()` disables auto-flush. Pipeline stages poll `takeCommands()` at 125Hz instead, delivering through 4 delay stages to `submitBatch()`.
- **CRT as overlay**: `CRTDisplay` takes over the display loop on the same GL context, reading from `getReadyTexture()`.
- **Smoothing as standalone or delegate**: `SmoothingDisplay` can run standalone (RAF loop → blit to screen) or as a delegate inside `CRTDisplay` (render to FBO → CRT reads smoothed texture). `CanvasRenderer` selects mode: `crt: true` → CRTDisplay (with smoothing delegation), `crt: false, smoothing: true` → SmoothingDisplay standalone, `crt: false` → passthrough.
- **Idle shutdown**: Stop CRT/smoothing/passthrough RAF loop. `preserveDrawingBuffer: true` keeps last frame visible. Resume = restart RAF.
- **esbuild `mangleProps: /^_/`**: All `_`-prefixed properties are renamed in production. Cross-file methods must NOT use `_` prefix. Each package mangles independently.
- **Pixel beam (Gaussian CRT phosphor dots)**: Step 10 renders each virtual CRT pixel as a 2D Gaussian with brightness-dependent width. Replaces both the sin-based scanlines and mod-based dot mask — on real CRTs, scanline gaps were created by the beam's vertical profile (same physical effect as horizontal dot shaping). Auto-derived from canvas size: `beamScale = max(3.0, height/180)`. No CRTConfig fields; always active.
- **CRT colorspace (BT.1886 → sRGB)**: Shader decodes with γ=2.4 (BT.1886 CRT phosphor response), processes effects in linear space, encodes with γ=2.2 (sRGB). Net gamma 1.09 = authentic CRT contrast. No color primary conversion needed (PC P22 phosphors ≈ sRGB). WebGL RGBA textures have no hardware sRGB — all gamma is manual via `pow()`. See `crt-shaders.ts` file header for full rationale.
- **1:1 pixel art philosophy**: maalata targets 1:1 pixel art rendering. Consumers draw at native resolution and get improved visuals (smoothing, CRT effects) automatically — no code changes needed. All upscaling and processing is handled internally.
- **NEAREST filtering + CSS pixelated**: canvas-ultrafast uses `gl.NEAREST` for all textures (FBOs, text, images) and defaults `imageSmoothingEnabled` to `false`. maalata adds `image-rendering: pixelated` on the canvas element. Together, these ensure pixel-perfect rendering from WebGL texture sampling through browser compositing — no bilinear smoothing at any stage.
- **Pixel art smoothing (xBRZ Freescale + RGSS)**: Three-pass pre-processing in `SmoothingDisplay`: (0) xBRZ analysis — 3×3+extended neighborhood, YCbCr perceptual color distance (Rec.2020 luma), 4-corner blend classification (NONE/NORMAL/DOMINANT), shallow/steep line detection, packed as integer metadata / 255.0 in RGBA8 (W×H → W×H), (1) xBRZ freescale blend — decode metadata, read original pixels, smoothstep directional blending via `get_left_ratio()` at 2× scale (W×H → 2W×2H), (2) RGSS downsample (2W×2H → W×H). Same output size, smooth anti-aliased edges. Purely algorithmic (no LUT, no async loading) — `ready()` resolves immediately. Total VRAM: 6 WH. Bypassed in CRT mode when `_inputSize: [0, 0]`.
- **GLSL ES 3.00**: All shaders across canvas-ultrafast and maalata use `#version 300 es` (GLSL ES 3.00 / WebGL 2.0). `in`/`out` instead of `attribute`/`varying`, `texture()` instead of `texture2D()`, `out vec4 fragColor` instead of `gl_FragColor`, `mat4x3` natively supported.

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

- **`demo/`**: Multi-page demo with two pages:
  - **`index.html`** (`demo/src/main.ts`): CRT demo — full maalata experience with CRT post-processing, pipeline delay, 8 FPS rendering, idle shutdown events.
  - **`smoothing.html`** (`demo/src/smoothing.ts`): Smoothing demo — three canvases: raw (400×400), xBRZ+RGSS smoothed (400×400), and xBRZ-only 2× upscale (800×800, no RGSS downsample). Habbo avatar at native 1:1 size.
