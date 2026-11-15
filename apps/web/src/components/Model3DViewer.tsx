import { useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../i18n';
import { normalizeModel, type Model3D } from '../model3d';

/**
 * A small, dependency-free 3D stage for the delivery package.
 *
 * Supported text models (OBJ/STL) are drawn as a rotating wireframe on a 2D canvas with a real
 * perspective projection, so a delivered model is inspectable without pulling in three.js. The
 * animation stops under `prefers-reduced-motion` and the component still renders one frame.
 *
 * Unsupported binary formats are *not* faked: the placeholder says "3D asset" and names the
 * format, while the file itself remains downloadable from the package.
 */

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function project(point: Point, width: number, height: number, angle: number): Point & { readonly depth: number } {
  const cosY = Math.cos(angle);
  const sinY = Math.sin(angle);
  const cosX = Math.cos(0.42);
  const sinX = Math.sin(0.42);
  const x = point.x * cosY - point.z * sinY;
  const z = point.x * sinY + point.z * cosY;
  const y = point.y * cosX - z * sinX;
  const depth = point.y * sinX + z * cosX;
  const perspective = 2.7 / (2.7 + depth);
  const scale = Math.min(width, height) * 0.42;
  return {
    x: width / 2 + x * scale * perspective,
    y: height / 2 + y * scale * perspective,
    z: depth,
    depth,
  };
}

export function Model3DViewer({
  model,
  label,
}: {
  readonly model: Model3D | null;
  readonly label?: string;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const normalized = useMemo(() => model === null ? null : normalizeModel(model), [model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || normalized === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let frame = 0;
    let start = 0;

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, canvas.clientWidth);
      height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (angle: number): void => {
      context.clearRect(0, 0, width, height);
      const points = normalized.vertices.map((vertex) => project(vertex, width, height, angle));
      for (const [fromIndex, toIndex] of normalized.edges) {
        const from = points[fromIndex];
        const to = points[toIndex];
        if (from === undefined || to === undefined) continue;
        const alpha = Math.max(0.18, Math.min(0.85, 0.56 - (from.depth + to.depth) * 0.12));
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = `rgba(105, 196, 162, ${alpha})`;
        context.lineWidth = 1.05;
        context.stroke();
      }
      for (const point of points) {
        const alpha = Math.max(0.2, Math.min(0.8, 0.62 - point.depth * 0.16));
        context.beginPath();
        context.arc(point.x, point.y, 1.35, 0, Math.PI * 2);
        context.fillStyle = `rgba(170, 245, 214, ${alpha})`;
        context.fill();
      }
    };

    const tick = (time: number): void => {
      if (start === 0) start = time;
      draw(reduced ? 0.72 : (time - start) / 2600);
      if (!reduced) frame = window.requestAnimationFrame(tick);
    };

    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); draw(0.72); }) : null;
    observer?.observe(canvas);
    frame = window.requestAnimationFrame(tick);

    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [normalized]);

  if (normalized === null) {
    return (
      <div className="model3d-stage placeholder" aria-label={label ?? '3D asset'}>
        <div className="model3d-cube" aria-hidden="true"><i /><i /><i /></div>
        <b>{label ?? model?.sourcePath ?? '3D asset'}</b>
        <small>{model?.format ?? label?.split('.').pop()?.toUpperCase() ?? '3D'} · {t('package.assetReady')}</small>
      </div>
    );
  }

  return (
    <div className="model3d-stage" aria-label={label ?? normalized.sourcePath}>
      <canvas ref={canvasRef} className="model3d-canvas" />
      <span className="model3d-caption">
        <b>{label ?? normalized.sourcePath}</b>
        <small>{normalized.format.toUpperCase()} · {t('package.vertices', { count: normalized.vertices.length })} · {t('package.autoRotate')}</small>
      </span>
    </div>
  );
}
