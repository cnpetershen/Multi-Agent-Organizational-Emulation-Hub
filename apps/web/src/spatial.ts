/**
 * What counts as a 3D delivery?
 *
 * A delivered 3D artifact can arrive in two shapes the console can actually show:
 * - a model file (`.obj`/`.stl` text, with `.glb`/`.gltf` still listed as an asset);
 * - an HTML scene (WebGL/three.js, model-viewer, or a CSS `preserve-3d` product tour).
 *
 * This module is deliberately dependency-free and pure so both `results.ts` (classification)
 * and `delivery-package.ts` (preview slots) can ask the same question without a cycle.
 */

export const MODEL_EXTENSIONS: ReadonlySet<string> = new Set(['.obj', '.stl', '.glb', '.gltf', '.fbx', '.ply']);
export const MODEL_RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.obj', '.stl']);

export interface SpatialFile {
  readonly path: string;
  readonly content: string;
}

export function extensionOf(path: string): string {
  const clean = path.trim().toLowerCase().replace(/\\/g, '/');
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

export function isModelAssetPath(path: string): boolean {
  return MODEL_EXTENSIONS.has(extensionOf(path));
}

const SPATIAL_CONTENT = /\b(?:three(?:\.min)?\.js|THREE\.|WebGLRenderer|OrbitControls|PerspectiveCamera|babylon|model-viewer|gltf|glb|shaderMaterial|preserve-3d|translateZ|rotate[XY])\b/i;

/** An HTML page that actually renders in 3D, not a document that merely says "3D". */
export function isThreeDimensionalContent(content: string): boolean {
  if (!/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content)) return false;
  return SPATIAL_CONTENT.test(content);
}

export function isSpatialDelivery(files: readonly SpatialFile[]): boolean {
  return files.some(
    (file) => isModelAssetPath(file.path) || (file.content.trim() !== '' && isThreeDimensionalContent(file.content)),
  );
}
