/**
 * maalata — "2002 era" retro canvas experience
 *
 * Combines canvas-ultrafast (WebGL Canvas 2D renderer) with a
 * historically-accurate latency pipeline and CRT post-processing.
 */

export { CanvasRenderer } from './maalata';
export { CanvasAPI } from 'canvas-ultrafast';
export type { CRTConfig } from './crt-display';
export type { RendererConfig, RendererEvent } from './maalata';
