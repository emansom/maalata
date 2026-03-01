import { CanvasRenderer } from 'maalata';

interface CanvasButton {
  label: string;
  x: number; y: number; width: number; height: number;
  action: () => void;
}

let pageCanvas = document.getElementById('canvas') as HTMLCanvasElement;
if (!pageCanvas) throw new Error('Canvas element not found');

async function initializeDemo() {
  const renderer = new CanvasRenderer({
    canvas: pageCanvas,
    crt: true,
    crtConfig: {
      scanlineIntensity: 0.6,
      chromaticAberration: 0.0005,
      flicker: 0.020,
    },
  });
  const ctx = renderer.getCanvasAPI();

  let animationRunning = false;
  let animationStartTime = 0;
  let pausedByVisibility = false;

  const FRAME_INTERVAL_MS = 1000 / 8; // 8 FPS render cycle
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const buttons: CanvasButton[] = [
    { label: 'Draw Static',     x: 20, y: 60,  width: 150, height: 40, action: () => { stopAnimation(); renderStaticUI(); } },
    { label: 'Start Animation', x: 20, y: 120, width: 150, height: 40, action: startAnimation },
    { label: 'Stop Animation',  x: 20, y: 180, width: 150, height: 40, action: stopAnimation },
    { label: 'Test Pattern',    x: 20, y: 240, width: 150, height: 40, action: () => { stopAnimation(); renderTestPattern(); } },
  ];

  function drawButtons() {
    for (const btn of buttons) {
      ctx.fillStyle = 'rgba(74, 158, 255, 0.9)';
      ctx.fillRect(btn.x, btn.y, btn.width, btn.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '13px monospace';
      ctx.fillText(btn.label, btn.x + 10, btn.y + 26);
    }
  }

  function renderTestPattern() {
    const { width, height } = renderer.getCanvasSize();
    ctx.fillStyle = '#1a1a2a';
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('Maalata Demo', 20, 35);

    // SMPTE color bars: white, yellow, cyan, green, magenta, red, blue
    const bars = [
      [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
      [255, 0, 255], [255, 0, 0], [0, 0, 255],
    ];
    const barsX = 200, barsY = 20, barsW = 580, barsH = 200;
    const barWidth = barsW / bars.length;
    for (let i = 0; i < bars.length; i++) {
      const [r, g, b] = bars[i];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(barsX + i * barWidth, barsY, barWidth, barsH);
    }

    // Grayscale ramp: 16 steps from black to white
    const rampX = 200, rampY = 240, rampW = 580, rampH = 60;
    const stepWidth = rampW / 16;
    for (let i = 0; i < 16; i++) {
      const v = Math.round((i / 15) * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(rampX + i * stepWidth, rampY, stepWidth, rampH);
    }

    // Color patches: pure R, G, B, orange, violet, sky blue
    const patches = [
      [255, 0, 0], [0, 255, 0], [0, 0, 255],
      [255, 165, 0], [148, 0, 211], [135, 206, 235],
    ];
    const patchX = 200, patchY = 320, patchW = 580, patchH = 60;
    const patchWidth = patchW / patches.length;
    for (let i = 0; i < patches.length; i++) {
      const [r, g, b] = patches[i];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(patchX + i * patchWidth, patchY, patchWidth, patchH);
    }

    // Labels
    ctx.fillStyle = '#ffffff';
    ctx.font = '11px monospace';
    ctx.fillText('SMPTE Color Bars', barsX, barsY - 4);
    ctx.fillText('Grayscale Ramp (16 steps)', rampX, rampY - 4);
    ctx.fillText('Color Patches', patchX, patchY - 4);

    drawButtons();
  }

  function renderStaticUI() {
    const { width, height } = renderer.getCanvasSize();
    ctx.fillStyle = '#1a1a2a';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('Maalata Demo', 20, 35);
    drawButtons();
  }

  function renderAnimation() {
    if (!animationRunning) return;
    const { width, height } = renderer.getCanvasSize();
    const elapsed = performance.now() - animationStartTime;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);

    const alpha = Math.abs(Math.sin((elapsed / 1000) * Math.PI));
    ctx.fillStyle = `rgba(0, 255, 136, ${alpha * 0.8})`;
    ctx.fillRect(200, 60, 100, 100);

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((elapsed / 1000) * Math.PI);
    ctx.strokeStyle = '#ff00ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(-50, -50, 100, 100);
    ctx.restore();

    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < width; x += 5) {
      const y = height / 2 + Math.sin((x + elapsed / 10) / 30) * 50;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    drawButtons();
  }

  async function scheduleFrame() {
    await delay(FRAME_INTERVAL_MS);
    if (!animationRunning) return;
    renderAnimation();
    scheduleFrame();
  }

  function startAnimation() {
    if (animationRunning) return;
    animationRunning = true;
    animationStartTime = performance.now();
    scheduleFrame();
  }

  function stopAnimation() {
    animationRunning = false;
    pausedByVisibility = false;
  }

  function handleCanvasClick(e: MouseEvent) {
    const rect = pageCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const btn of buttons) {
      if (x >= btn.x && x <= btn.x + btn.width && y >= btn.y && y <= btn.y + btn.height) {
        btn.action();
        break;
      }
    }
  }

  function handleCanvasMouseMove(e: MouseEvent) {
    const rect = pageCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const overButton = buttons.some(
      btn => x >= btn.x && x <= btn.x + btn.width && y >= btn.y && y <= btn.y + btn.height
    );
    pageCanvas.style.cursor = overButton ? 'pointer' : 'default';
  }

  function attachClickHandlers() {
    pageCanvas.addEventListener('click', handleCanvasClick);
    pageCanvas.addEventListener('mousemove', handleCanvasMouseMove);
  }
  function detachClickHandlers() {
    pageCanvas.removeEventListener('click', handleCanvasClick);
    pageCanvas.removeEventListener('mousemove', handleCanvasMouseMove);
  }

  renderer.on('canvas-replacing', ({ done }) => { detachClickHandlers(); done(); });
  renderer.on('canvas-replaced', ({ canvas }) => { pageCanvas = canvas; attachClickHandlers(); });
  renderer.on('ready',     () => { renderStaticUI(); });
  renderer.on('resuming',  () => { /* worker restarting — ready fires shortly */ });
  renderer.on('suspending', ({ done }) => { stopAnimation(); done(); });

  // Update reference to visible canvas (may differ from original after CRT filter swap)
  pageCanvas = renderer.getCanvas();
  attachClickHandlers();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (animationRunning) {
        stopAnimation();
        pausedByVisibility = true;
      }
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      startAnimation();
    }
  });

  // Expose for verify-demo per-step testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.maalataRenderer = renderer;
  w.maalataRenderTestPattern = renderTestPattern;

  await renderer.ready();
  renderStaticUI();
}

initializeDemo().catch(err => console.error('Failed to initialize demo:', err));
