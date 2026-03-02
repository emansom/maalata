/**
 * verify-demo.js — End-to-end browser test via Playwright
 *
 * Tests the maalata demo.
 * Always builds the library + demo in development mode first (sourcemaps,
 * no mangling, console.* calls preserved), then serves and verifies.
 *
 * Usage: node scripts/verify-demo.js
 * Exit code 0 = clean, 1 = errors found or script failed.
 *
 * Requires: npm install (playwright in devDependencies), npx playwright install chromium
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_SCRIPT = resolve(import.meta.dirname, 'server.js');

// Button center coordinates matching demo src/main.ts layout:
//   buttons at x=20..170, y-ranges: 60-100 / 120-160 / 180-220
const BUTTONS = {
  drawStatic:     { x: 95, y: 80  },
  startAnimation: { x: 95, y: 140 },
  stopAnimation:  { x: 95, y: 200 },
  testPattern:    { x: 95, y: 260 },
};

// Visual verification: sample canvas pixels during animation
const VISUAL_SAMPLE_COUNT    = 10;  // number of snapshots to take
const VISUAL_SAMPLE_INTERVAL = 300; // ms between snapshots
// At least this fraction of samples must contain real animation content
const VISUAL_MIN_CONTENT_RATIO = 0.6;

const DEMO = {
  name: 'maalata',
  distDir: resolve(import.meta.dirname, '../demo/dist'),
  port: 4173,
  settleMs: 2000,       // pipeline needs time to flush first frames
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Sample the canvas pixel data via Playwright screenshot and return a color breakdown.
 */
async function sampleCanvasPixels(page) {
  const screenshotBuffer = await page.locator('#canvas').screenshot({ type: 'png' });
  const base64 = screenshotBuffer.toString('base64');

  /* eslint-disable no-undef -- entire callback runs inside Playwright browser context */
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:image/png;base64,${b64}`;
    });
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, tmp.width, tmp.height);
    const total = tmp.width * tmp.height;
    let dark = 0, green = 0, magenta = 0, orange = 0, blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 30 && g < 30 && b < 50)                          dark++;
      else if (g > 100 && g > r * 1.5 && g > b * 1.5)          green++;
      else if (r > 100 && b > 100 && g < 80)                    magenta++;
      else if (r > 150 && g > 80 && b < 80)                     orange++;
      else if (b > 150 && r < 100 && g < 180)                   blue++;
    }
    return { total, dark, green, magenta, orange, blue };
  }, base64);
  /* eslint-enable no-undef */
}

/**
 * Neutral CRT config — disables all effects, gamma cancels out (2.2/2.2 = identity).
 */
const NEUTRAL_CRT = {
  barrelDistortion: 0, curvature: 0, chromaticAberration: 0,
  staticNoise: 0, horizontalTearing: 0, glowBloom: 0, verticalJitter: 0,
  brightness: 1.0, contrast: 1.0, desaturation: 0,
  flicker: 0, signalLoss: 0, vignetteStrength: 0,
  bfiStrength: 0,
  crtGamma: 2.2, displayGamma: 2.2,
  _inputSize: [0, 0],  // bypass pixel beam for clean measurements
};

/**
 * Sample average color of a rectangular region from a canvas screenshot.
 * Crops 20% edge margin to avoid border effects.
 */
async function sampleRegionColor(page, x, y, w, h) {
  const screenshotBuffer = await page.locator('#canvas').screenshot({ type: 'png' });
  const base64 = screenshotBuffer.toString('base64');

  /* eslint-disable no-undef -- entire callback runs inside Playwright browser context */
  return page.evaluate(async ({ b64, rx, ry, rw, rh }) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:image/png;base64,${b64}`;
    });
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // 20% edge margin
    const mx = Math.floor(rw * 0.2);
    const my = Math.floor(rh * 0.2);
    const sx = rx + mx;
    const sy = ry + my;
    const sw = rw - 2 * mx;
    const sh = rh - 2 * my;

    const { data } = ctx.getImageData(sx, sy, sw, sh);
    let rSum = 0, gSum = 0, bSum = 0;
    const count = sw * sh;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }
    return { r: rSum / count, g: gSum / count, b: bSum / count };
  }, { b64: base64, rx: x, ry: y, rw: w, rh: h });
  /* eslint-enable no-undef */
}

/**
 * Apply CRT config and force a synchronous render via screenshot().
 * The test pattern is already on the ready texture from the "Test Pattern"
 * button click — we only change config and force-render. This avoids
 * pipeline timing uncertainty in headless SwiftShader.
 */
async function applyConfig(page, config) {
  /* eslint-disable no-undef -- callback runs inside Playwright browser context */
  await page.evaluate(async (cfg) => {
    window.maalataRenderer.updateCRTConfig(cfg);
    await window.maalataRenderer.screenshot();
  }, config);
  /* eslint-enable no-undef */
}

function spawnServer(distDir, port) {
  const proc = spawn('node', [SERVER_SCRIPT, distDir, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  proc.on('error', err => process.stderr.write(`[server] spawn error: ${err.message}\n`));
  return proc;
}

async function waitForUrl(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  throw new Error(`${url} did not respond within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const errors = [];
  let browser = null;
  let serverProc = null;
  const appUrl = `http://localhost:${DEMO.port}`;
  const tag = `[${DEMO.name}]`;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    });

    // Start server
    console.log(`${tag} Starting demo server on port ${DEMO.port}...`);
    serverProc = spawnServer(DEMO.distDir, DEMO.port);
    await waitForUrl(appUrl);
    console.log(`${tag} Server up at ${appUrl}\n`);

    const page = await browser.newPage();

    // Wire up error collectors
    page.on('pageerror', err => {
      const msg = `[JS Exception] ${err.message}`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    });

    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const text = `[console.${type}] ${msg.text()}`;
        errors.push(text);
        console.warn(`${tag} ${text}`);
      }
    });

    page.on('requestfailed', req => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('chrome-extension:')) return;
      const reason = req.failure()?.errorText ?? 'unknown';
      const msg = `[requestfailed] ${url} — ${reason}`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    });

    // Navigate and settle
    console.log(`${tag} Navigating to ${appUrl}...`);
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.waitForTimeout(DEMO.settleMs);
    console.log(`${tag} Page settled after load\n`);

    const canvas = page.locator('#canvas');

    // Click "Draw Static"
    console.log(`${tag} Clicking "Draw Static"...`);
    await canvas.click({ position: BUTTONS.drawStatic });
    await page.waitForTimeout(500);

    // Click "Start Animation", sample frames visually
    console.log(`${tag} Clicking "Start Animation"...`);
    await canvas.click({ position: BUTTONS.startAnimation });
    await page.waitForTimeout(500);

    console.log(`${tag} Sampling ${VISUAL_SAMPLE_COUNT} animation frames...`);
    const frameSamples = [];
    for (let i = 0; i < VISUAL_SAMPLE_COUNT; i++) {
      const sample = await sampleCanvasPixels(page);
      if (sample) frameSamples.push(sample);
      if (i < VISUAL_SAMPLE_COUNT - 1) await page.waitForTimeout(VISUAL_SAMPLE_INTERVAL);
    }

    // Analyse visual results
    const contentFrames = frameSamples.filter(s => {
      const nonDark = s.total - s.dark;
      return nonDark > s.total * 0.02;
    });
    const framesWithAnimation = frameSamples.filter(s => {
      return (s.green + s.magenta + s.orange) > 20;
    });

    console.log(`${tag} Visual results: ${contentFrames.length}/${frameSamples.length} frames have content, ` +
      `${framesWithAnimation.length}/${frameSamples.length} frames have animated elements`);
    for (let i = 0; i < frameSamples.length; i++) {
      const s = frameSamples[i];
      const pct = n => ((n / s.total) * 100).toFixed(1);
      console.log(`  frame ${i}: dark=${pct(s.dark)}% green=${pct(s.green)}% magenta=${pct(s.magenta)}% orange=${pct(s.orange)}% blue=${pct(s.blue)}%`);
    }

    if (contentFrames.length < frameSamples.length * VISUAL_MIN_CONTENT_RATIO) {
      const msg = `[visual] Flickering detected: only ${contentFrames.length}/${frameSamples.length} frames had visible content (>2% non-dark pixels)`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }
    if (framesWithAnimation.length < frameSamples.length * VISUAL_MIN_CONTENT_RATIO) {
      const msg = `[visual] Animation not rendering: only ${framesWithAnimation.length}/${frameSamples.length} frames contained animated elements (green/magenta/orange)`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }
    console.log(`${tag} Animation visual sampling complete`);

    // Click "Stop Animation"
    console.log(`${tag} Clicking "Stop Animation"...`);
    await canvas.click({ position: BUTTONS.stopAnimation });
    await page.waitForTimeout(500);

    // -----------------------------------------------------------------------
    // CRT shader tests — test pattern + per-step verification
    // -----------------------------------------------------------------------

    // Click "Test Pattern"
    console.log(`\n${tag} Clicking "Test Pattern"...`);
    await canvas.click({ position: BUTTONS.testPattern });
    await page.waitForTimeout(500);

    // SMPTE bar geometry (matching demo/src/main.ts)
    const BARS_X = 200, BARS_Y = 20, BARS_W = 580, BARS_H = 200;
    const BAR_W = BARS_W / 7;
    // Grayscale ramp geometry
    const RAMP_X = 200, RAMP_Y = 240, RAMP_W = 580, RAMP_H = 60;
    const STEP_W = RAMP_W / 16;

    // --- E2E test: Full pipeline with default config ---
    console.log(`\n${tag} E2E: SMPTE hue verification (default config)...`);
    {
      // Expected SMPTE bars: white, yellow, cyan, green, magenta, red, blue
      const barExpected = [
        { name: 'white',   on: [0,1,2], off: [] },
        { name: 'yellow',  on: [0,1],   off: [2] },
        { name: 'cyan',    on: [1,2],   off: [0] },
        { name: 'green',   on: [1],     off: [0,2] },
        { name: 'magenta', on: [0,2],   off: [1] },
        { name: 'red',     on: [0],     off: [1,2] },
        { name: 'blue',    on: [2],     off: [0,1] },
      ];

      for (let i = 0; i < barExpected.length; i++) {
        const bx = BARS_X + i * BAR_W;
        const color = await sampleRegionColor(page, bx, BARS_Y, BAR_W, BARS_H);
        const channels = [color.r, color.g, color.b];
        const { name, on: onCh, off: offCh } = barExpected[i];

        // "on" channels must be > 50
        for (const ch of onCh) {
          if (channels[ch] < 50) {
            const msg = `[E2E SMPTE] ${name} bar: "on" channel ${ch} = ${channels[ch].toFixed(0)}, expected > 50`;
            errors.push(msg);
            console.error(`${tag} ${msg}`);
          }
        }
        // "off" channels must be < 200
        for (const ch of offCh) {
          if (channels[ch] > 200) {
            const msg = `[E2E SMPTE] ${name} bar: "off" channel ${ch} = ${channels[ch].toFixed(0)}, expected < 200`;
            errors.push(msg);
            console.error(`${tag} ${msg}`);
          }
        }
        // Weakest "on" > 1.3× strongest "off"
        if (onCh.length > 0 && offCh.length > 0) {
          const weakestOn = Math.min(...onCh.map(ch => channels[ch]));
          const strongestOff = Math.max(...offCh.map(ch => channels[ch]));
          if (strongestOff > 0 && weakestOn / strongestOff < 1.3) {
            const msg = `[E2E SMPTE] ${name} bar: hue separation too low — weakest on=${weakestOn.toFixed(0)}, strongest off=${strongestOff.toFixed(0)}, ratio=${(weakestOn / strongestOff).toFixed(2)}`;
            errors.push(msg);
            console.error(`${tag} ${msg}`);
          }
        }
        console.log(`${tag}   ${name}: R=${channels[0].toFixed(0)} G=${channels[1].toFixed(0)} B=${channels[2].toFixed(0)}`);
      }
    }

    // Keep renderer alive — hover resets the 60s idle timer
    await canvas.hover({ position: { x: 400, y: 200 } });

    // E2E: Grayscale monotonicity
    console.log(`\n${tag} E2E: Grayscale monotonicity...`);
    {
      let prevLum = -5;
      let monoOk = true;
      for (let i = 0; i < 16; i++) {
        const sx = RAMP_X + i * STEP_W;
        const color = await sampleRegionColor(page, sx, RAMP_Y, STEP_W, RAMP_H);
        const lum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
        if (lum < prevLum - 5) {
          const msg = `[E2E grayscale] Step ${i}: luminance ${lum.toFixed(1)} < previous ${prevLum.toFixed(1)} (non-monotonic)`;
          errors.push(msg);
          console.error(`${tag} ${msg}`);
          monoOk = false;
        }
        prevLum = lum;
      }
      if (monoOk) console.log(`${tag}   Grayscale monotonicity OK`);
    }

    // Keep renderer alive — hover resets the 60s idle timer
    await canvas.hover({ position: { x: 400, y: 200 } });

    // E2E: Gamma curve (default config, wider tolerance)
    console.log(`\n${tag} E2E: Gamma curve (default config)...`);
    {
      const logInputs = [];
      const logOutputs = [];
      for (let i = 2; i <= 13; i++) {
        const sx = RAMP_X + i * STEP_W;
        const color = await sampleRegionColor(page, sx, RAMP_Y, STEP_W, RAMP_H);
        const inputVal = (i / 15) * 255;
        const outputLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
        if (inputVal > 0 && outputLum > 0) {
          logInputs.push(Math.log(inputVal / 255));
          logOutputs.push(Math.log(outputLum / 255));
        }
      }
      if (logInputs.length >= 4) {
        // Linear regression: logOutput = gamma * logInput + offset
        const n = logInputs.length;
        const sumX = logInputs.reduce((a, b) => a + b, 0);
        const sumY = logOutputs.reduce((a, b) => a + b, 0);
        const sumXY = logInputs.reduce((a, x, i) => a + x * logOutputs[i], 0);
        const sumX2 = logInputs.reduce((a, x) => a + x * x, 0);
        const gamma = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        // Beam's brightness-dependent Gaussian adds non-linear darkening,
        // shifting measured gamma above the pure colorspace 1.09.
        console.log(`${tag}   Measured effective gamma: ${gamma.toFixed(3)} (expected ≈ 1.2, tolerance ±0.3)`);
        if (Math.abs(gamma - 1.2) > 0.3) {
          const msg = `[E2E gamma] Measured gamma ${gamma.toFixed(3)} outside expected range 0.9–1.5`;
          errors.push(msg);
          console.error(`${tag} ${msg}`);
        }
      } else {
        console.warn(`${tag}   Not enough data points for gamma regression`);
      }
    }

    // Keep renderer alive — hover resets the 60s idle timer
    await canvas.hover({ position: { x: 400, y: 200 } });

    // --- Unit test: Passthrough (neutral config) ---
    // Test pattern is already on the ready texture from "Test Pattern" button.
    // Switch to neutral config and verify white bar ≈ 255.
    console.log(`\n${tag} Unit: Passthrough (neutral config)...`);
    {
      await applyConfig(page, NEUTRAL_CRT);
      const color = await sampleRegionColor(page, BARS_X, BARS_Y, BAR_W, BARS_H);
      console.log(`${tag}   White bar: R=${color.r.toFixed(0)} G=${color.g.toFixed(0)} B=${color.b.toFixed(0)} (expected ≈ 255 ±15)`);
      const avg = (color.r + color.g + color.b) / 3;
      if (Math.abs(avg - 255) > 15) {
        const msg = `[Unit passthrough] White bar average ${avg.toFixed(0)}, expected ≈ 255 (±15)`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // --- Unit test: CRT gamma (BT.1886) ---
    console.log(`\n${tag} Unit: CRT gamma (crtGamma=2.4)...`);
    {
      await applyConfig(page, { ...NEUTRAL_CRT, crtGamma: 2.4 });
      const logInputs = [];
      const logOutputs = [];
      for (let i = 2; i <= 13; i++) {
        const sx = RAMP_X + i * STEP_W;
        const color = await sampleRegionColor(page, sx, RAMP_Y, STEP_W, RAMP_H);
        const inputVal = (i / 15) * 255;
        const outputLum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
        if (inputVal > 0 && outputLum > 0) {
          logInputs.push(Math.log(inputVal / 255));
          logOutputs.push(Math.log(outputLum / 255));
        }
      }
      if (logInputs.length >= 4) {
        const n = logInputs.length;
        const sumX = logInputs.reduce((a, b) => a + b, 0);
        const sumY = logOutputs.reduce((a, b) => a + b, 0);
        const sumXY = logInputs.reduce((a, x, i) => a + x * logOutputs[i], 0);
        const sumX2 = logInputs.reduce((a, x) => a + x * x, 0);
        const gamma = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        console.log(`${tag}   Measured gamma: ${gamma.toFixed(3)} (expected ≈ 1.09, tolerance ±0.15)`);
        if (Math.abs(gamma - 1.09) > 0.15) {
          const msg = `[Unit gamma] Measured gamma ${gamma.toFixed(3)} outside expected range 0.94–1.24`;
          errors.push(msg);
          console.error(`${tag} ${msg}`);
        }
      } else {
        const msg = `[Unit gamma] Not enough data points for gamma regression`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // --- Unit test: Pixel beam darkening ---
    console.log(`\n${tag} Unit: Pixel beam darkening...`);
    {
      // Enable beam (default canvas size) with CRT gamma 2.4/2.2
      await applyConfig(page, { ...NEUTRAL_CRT, crtGamma: 2.4, _inputSize: null });
      // Sample white bar — beam Gaussian profile darkens averaged pixels
      const color = await sampleRegionColor(page, BARS_X, BARS_Y, BAR_W, BARS_H);
      const avg = (color.r + color.g + color.b) / 3;
      // White bar with beam: bright pixels have wide sigma (~0.44) but still
      // darken significantly due to Gaussian falloff near cell edges.
      // Average should be well below 255 but above 50.
      console.log(`${tag}   White bar avg: ${avg.toFixed(0)} (expected 50–230, beam active)`);
      if (avg > 230 || avg < 50) {
        const msg = `[Unit beam] White bar average ${avg.toFixed(0)}, expected 50–230 (beam should darken)`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // --- Unit test: Brightness ---
    console.log(`\n${tag} Unit: Brightness (0.5)...`);
    {
      await applyConfig(page, { ...NEUTRAL_CRT, brightness: 0.5 });
      const color = await sampleRegionColor(page, BARS_X, BARS_Y, BAR_W, BARS_H);
      const avg = (color.r + color.g + color.b) / 3;
      console.log(`${tag}   White bar avg: ${avg.toFixed(0)} (expected ≈ 128 ±15)`);
      if (Math.abs(avg - 128) > 15) {
        const msg = `[Unit brightness] White bar average ${avg.toFixed(0)}, expected ≈ 128 (±15)`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // --- Unit test: Contrast ---
    console.log(`\n${tag} Unit: Contrast (2.0)...`);
    {
      await applyConfig(page, { ...NEUTRAL_CRT, contrast: 2.0 });
      // Sample 75% gray step (step index 11, input ≈ 187)
      const sx = RAMP_X + 11 * STEP_W;
      const color = await sampleRegionColor(page, sx, RAMP_Y, STEP_W, RAMP_H);
      const avg = (color.r + color.g + color.b) / 3;
      // Expected: ((187/255 - 0.5) * 2.0 + 0.5) * 255 ≈ 228
      const expected = ((((11 / 15) * 255) / 255 - 0.5) * 2.0 + 0.5) * 255;
      console.log(`${tag}   75%% gray avg: ${avg.toFixed(0)} (expected ≈ ${expected.toFixed(0)} ±20)`);
      if (Math.abs(avg - expected) > 20) {
        const msg = `[Unit contrast] 75% gray average ${avg.toFixed(0)}, expected ≈ ${expected.toFixed(0)} (±20)`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // --- Unit test: Desaturation ---
    console.log(`\n${tag} Unit: Desaturation (0.5)...`);
    {
      await applyConfig(page, { ...NEUTRAL_CRT, desaturation: 0.5 });
      // Sample red bar (6th color patch: pure R at patchX + 0*patchWidth)
      // Actually the 5th SMPTE bar is red (index 5): bars[5] = [255, 0, 0]
      const redBarX = BARS_X + 5 * BAR_W;
      const color = await sampleRegionColor(page, redBarX, BARS_Y, BAR_W, BARS_H);
      // lum = 0.299*255 = 76.2; R = mix(255, 76.2, 0.5) = 165.6; G = mix(0, 76.2, 0.5) = 38.1
      console.log(`${tag}   Red bar: R=${color.r.toFixed(0)} G=${color.g.toFixed(0)} B=${color.b.toFixed(0)} (expected ≈ 166, 38, 38 ±20)`);
      if (Math.abs(color.r - 166) > 20 || Math.abs(color.g - 38) > 20 || Math.abs(color.b - 38) > 20) {
        const msg = `[Unit desaturation] Red bar R=${color.r.toFixed(0)} G=${color.g.toFixed(0)} B=${color.b.toFixed(0)}, expected ≈ (166, 38, 38) ±20`;
        errors.push(msg);
        console.error(`${tag} ${msg}`);
      }
    }

    // Restore default config
    console.log(`\n${tag} Restoring default CRT config...`);
    await applyConfig(page, {});

    await page.close();

    // -----------------------------------------------------------------
    // Smoothing demo tests
    // -----------------------------------------------------------------

    const smoothingUrl = `${appUrl}/smoothing.html`;
    console.log(`\n${tag} Navigating to ${smoothingUrl}...`);

    const smoothPage = await browser.newPage();

    // Wire up error collectors for smoothing page
    smoothPage.on('pageerror', err => {
      const msg = `[smoothing JS Exception] ${err.message}`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    });

    smoothPage.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const text = msg.text();
        // Ignore willReadFrequently hints — browser perf advisory, not an error
        if (text.includes('willReadFrequently')) return;
        const formatted = `[smoothing console.${type}] ${text}`;
        errors.push(formatted);
        console.warn(`${tag} ${formatted}`);
      }
    });

    smoothPage.on('requestfailed', req => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('chrome-extension:')) return;
      const reason = req.failure()?.errorText ?? 'unknown';
      const msg = `[smoothing requestfailed] ${url} — ${reason}`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    });

    await smoothPage.goto(smoothingUrl, { waitUntil: 'load' });
    await smoothPage.waitForTimeout(DEMO.settleMs);
    console.log(`${tag} Smoothing page settled\n`);

    // Verify both canvases have visible content (avatar rendered at 1:1)
    console.log(`${tag} Smoothing: content verification via screenshots...`);

    /**
     * Count unique RGB colors in the central region of a canvas screenshot.
     * The avatar is drawn at 1:1 centered on a canvas — the central region
     * crosses avatar body edges where smoothing creates intermediate blend
     * values. canvasSize is the logical canvas size (e.g. 400 or 800).
     */
    async function sampleUniqueColors(locator, canvasSize = 400) {
      const screenshotBuffer = await locator.screenshot({ type: 'png' });
      const base64 = screenshotBuffer.toString('base64');

      /* eslint-disable no-undef -- callback runs inside Playwright browser context */
      return smoothPage.evaluate(async ({ b64, logicalSize }) => {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
        const tmp = document.createElement('canvas');
        tmp.width = img.width;
        tmp.height = img.height;
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        // Scale factor: screenshot may differ from canvas buffer size
        const scaleX = img.width / logicalSize;
        const scaleY = img.height / logicalSize;

        // Sample central strip across the canvas (crosses avatar body edges)
        const stripY = Math.round((logicalSize / 2) * scaleY);
        const stripStartX = Math.round((logicalSize * 0.25) * scaleX);
        const stripEndX = Math.round((logicalSize * 0.75) * scaleX);
        const colors = new Set();

        for (let x = stripStartX; x < stripEndX; x++) {
          const { data } = ctx.getImageData(x, stripY, 1, 1);
          colors.add(`${data[0]},${data[1]},${data[2]}`);
        }

        // Also check that the canvas has non-trivial content (not all black)
        const fullData = ctx.getImageData(0, 0, img.width, img.height).data;
        let nonBlack = 0;
        for (let i = 0; i < fullData.length; i += 4) {
          if (fullData[i] > 10 || fullData[i + 1] > 10 || fullData[i + 2] > 10) nonBlack++;
        }
        const contentRatio = nonBlack / (img.width * img.height);

        return { uniqueColors: colors.size, contentRatio };
      }, { b64: base64, logicalSize: canvasSize });
      /* eslint-enable no-undef */
    }

    const rawResult = await sampleUniqueColors(smoothPage.locator('#canvas-raw'));
    const smoothResult = await sampleUniqueColors(smoothPage.locator('#canvas-smooth'));

    console.log(`${tag}   Raw: ${rawResult.uniqueColors} unique colors, ${(rawResult.contentRatio * 100).toFixed(1)}% content`);
    console.log(`${tag}   Smooth: ${smoothResult.uniqueColors} unique colors, ${(smoothResult.contentRatio * 100).toFixed(1)}% content`);

    // Both canvases must have visible content
    if (rawResult.contentRatio < 0.05) {
      const msg = `[smoothing] Raw canvas has too little content: ${(rawResult.contentRatio * 100).toFixed(1)}% non-black`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }
    if (smoothResult.contentRatio < 0.05) {
      const msg = `[smoothing] Smoothed canvas has too little content: ${(smoothResult.contentRatio * 100).toFixed(1)}% non-black`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }

    // Smoothed canvas should have more unique colors than raw
    // (hq4x creates intermediate blend values at pixel art edges)
    if (smoothResult.uniqueColors > rawResult.uniqueColors) {
      console.log(`${tag}   Smoothing produces anti-aliased edges (${smoothResult.uniqueColors} > ${rawResult.uniqueColors} unique colors)`);
    } else {
      const msg = `[smoothing] Smoothed canvas should have more unique colors than raw (${smoothResult.uniqueColors} <= ${rawResult.uniqueColors})`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }

    // xBRZ-only canvas (800×800, 2× upscale without RGSS downsample)
    // Wait for the setTimeout in smoothing.ts to capture the xBRZ output
    await smoothPage.waitForTimeout(500);

    const xbrzResult = await sampleUniqueColors(smoothPage.locator('#canvas-xbrz'), 800);
    console.log(`${tag}   xBRZ: ${xbrzResult.uniqueColors} unique colors, ${(xbrzResult.contentRatio * 100).toFixed(1)}% content`);

    if (xbrzResult.contentRatio < 0.05) {
      const msg = `[smoothing] xBRZ canvas has too little content: ${(xbrzResult.contentRatio * 100).toFixed(1)}% non-black`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }
    if (xbrzResult.uniqueColors <= rawResult.uniqueColors) {
      const msg = `[smoothing] xBRZ canvas should have more unique colors than raw (${xbrzResult.uniqueColors} <= ${rawResult.uniqueColors})`;
      errors.push(msg);
      console.error(`${tag} ${msg}`);
    }

    console.log(`${tag} Smoothing content verification complete`);

    await smoothPage.close();

  } finally {
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(300); }
    if (browser) await browser.close().catch(() => {});
  }

  // Final report
  console.log(`\n${'='.repeat(70)}`);
  if (errors.length === 0) {
    console.log('[verify] \u2713 Demo clean. No errors found.');
  } else {
    console.error(`[verify] \u2717 ${errors.length} error(s) found:`);
    for (const e of errors) console.error(`  \u2022 ${e}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[verify] Fatal error:', err);
  process.exit(1);
});
