import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  isModelAssetPath,
  isSpatialDelivery,
  isThreeDimensionalContent,
} from '../../../apps/web/src/spatial';

/**
 * The 3D classifier is shared by the delivery page and the package. A CSS product tour (the
 * actual live demo `3D 产品导览`) has no canvas/three.js at all: it must still count as 3D, while
 * a normal document that merely contains the word "3D" must not.
 */

describe('3D delivery classifier', () => {
  const cssTour = [
    '<!doctype html><html><head><style>',
    '.scene{perspective:1200px}.card{transform-style:preserve-3d;transform:rotateY(20deg) translateZ(40px)}',
    '</style></head><body><div class="scene"><div class="card"></div></div></body></html>',
  ].join('');

  it('recognizes a CSS preserve-3d product tour', () => {
    expect(isThreeDimensionalContent(cssTour)).toBe(true);
    expect(isSpatialDelivery([{ path: 'index.html', content: cssTour }])).toBe(true);
  });

  it('recognizes WebGL/three.js scenes and model files', () => {
    expect(isThreeDimensionalContent('<!doctype html><script src="three.min.js"></script><canvas></canvas>')).toBe(true);
    expect(isSpatialDelivery([{ path: 'scene/product.obj', content: 'v 0 0 0' }])).toBe(true);
    expect(isModelAssetPath('scene/product.glb')).toBe(true);
  });

  it('does not classify a static page or a plain document as 3D', () => {
    expect(isThreeDimensionalContent('<html><body><h1>3D strategy</h1></body></html>')).toBe(false);
    expect(isSpatialDelivery([{ path: 'notes.md', content: 'A 3D strategy document.' }])).toBe(false);
  });

  it('keeps extension lookup case-insensitive and separator-safe', () => {
    expect(extensionOf('SCENE\\Product.OBJ')).toBe('.obj');
    expect(isModelAssetPath('SCENE/Product.STL')).toBe(true);
  });
});
