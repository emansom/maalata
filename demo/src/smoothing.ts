/**
 * Smoothing Demo — Comparison of raw, ScaleFX+EWA smoothed, and ScaleFX+AA pixel art.
 *
 * Three canvases:
 * - Raw (400×400): passthrough rendering, no smoothing
 * - Smoothed (400×400): ScaleFX 5-pass → sharpsmoother → AA level2 → EWA smooth downsample
 * - ScaleFX+AA (800×800): ScaleFX+sharpsmoother+AA at 3×, GPU-downsampled to 2× via EWA smooth
 *
 * Draws a Habbo avatar at its native 1:1 pixel size (128×220), centered on
 * the canvas. maalata targets 1:1 pixel art — consumers draw at native
 * resolution and get improved visuals automatically, no code changes needed.
 */

import { CanvasRenderer } from 'maalata';

const canvasRaw = document.getElementById('canvas-raw') as HTMLCanvasElement;
const canvasSmooth = document.getElementById('canvas-smooth') as HTMLCanvasElement;
const canvasXbrz = document.getElementById('canvas-xbrz') as HTMLCanvasElement;

if (!canvasRaw || !canvasSmooth || !canvasXbrz) throw new Error('Canvas elements not found');

async function initializeDemo() {
  const rendererRaw = new CanvasRenderer({ canvas: canvasRaw, crt: false, smoothing: false });
  const rendererSmooth = new CanvasRenderer({ canvas: canvasSmooth, crt: false, smoothing: true });

  const ctxRaw = rendererRaw.getCanvasAPI();
  const ctxSmooth = rendererSmooth.getCanvasAPI();

  // Load the Habbo avatar image
  const avatarImg = new Image();
  avatarImg.src = '/habbo-avatar.png';

  await new Promise<void>((resolve, reject) => {
    avatarImg.onload = () => resolve();
    avatarImg.onerror = () => reject(new Error('Failed to load habbo-avatar.png'));
  });

  // Create an OffscreenCanvas to convert the image to ImageBitmap for drawImage
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = avatarImg.width;
  tmpCanvas.height = avatarImg.height;
  const tmpCtx = tmpCanvas.getContext('2d')!;
  tmpCtx.drawImage(avatarImg, 0, 0);
  const avatarBitmap = await createImageBitmap(tmpCanvas);

  function drawScene(ctx: ReturnType<typeof rendererRaw.getCanvasAPI>) {
    const { width, height } = rendererRaw.getCanvasSize();

    // Dark background
    ctx.fillStyle = '#1a1a2a';
    ctx.fillRect(0, 0, width, height);

    // Draw Habbo avatar at native 1:1 pixel size, centered on canvas
    ctx.imageSmoothingEnabled = false;
    const avatarX = Math.floor((width - avatarImg.width) / 2);
    const avatarY = Math.floor((height - avatarImg.height) / 2);
    ctx.drawImage(avatarBitmap, avatarX, avatarY);
  }

  await rendererRaw.ready();
  await rendererSmooth.ready();

  drawScene(ctxRaw);
  drawScene(ctxSmooth);

  // Wait for pipeline to deliver content (168ms worst-case), then capture xBRZ output
  setTimeout(async () => {
    const bitmap = await rendererSmooth.screenshotUpscaled();
    if (bitmap && canvasXbrz) {
      const ctx2d = canvasXbrz.getContext('2d')!;
      ctx2d.imageSmoothingEnabled = false;
      ctx2d.drawImage(bitmap, 0, 0);
    }
  }, 300);

  // Expose for verify-demo automated testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.smoothingRendererRaw = rendererRaw;
  w.smoothingRendererSmooth = rendererSmooth;
  w.smoothingDrawScene = () => { drawScene(ctxRaw); drawScene(ctxSmooth); };
}

initializeDemo().catch(err => console.error('Failed to initialize smoothing demo:', err));
