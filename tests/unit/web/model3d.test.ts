import { describe, expect, it } from 'vitest';
import { modelFromFile, normalizeModel, parseObj, parseStl } from '../../../apps/web/src/model3d';

/**
 * The delivery package's 3D stage is only as honest as its reader. These tests use the smallest
 * real OBJ/STL payloads: a triangle and a tetrahedron. Unsupported formats must return null so
 * the UI can say "3D asset" instead of drawing a fake model.
 */

const TRIANGLE_OBJ = [
  '# a triangle',
  'v 0 0 0',
  'v 1 0 0',
  'v 0 1 0',
  'f 1 2 3',
].join('\n');

const TETRA_STL = [
  'solid tetra',
  'facet normal 0 0 1',
  'outer loop',
  'vertex 0 0 0',
  'vertex 1 0 0',
  'vertex 0 1 0',
  'endloop',
  'endfacet',
  'facet normal 0 0 -1',
  'outer loop',
  'vertex 0 0 0',
  'vertex 0 1 0',
  'vertex 0 0 1',
  'endloop',
  'endfacet',
  'endsolid tetra',
].join('\n');

describe('3D model reader', () => {
  it('reads an OBJ triangle and its three edges', () => {
    const model = parseObj(TRIANGLE_OBJ);
    expect(model?.format).toBe('obj');
    expect(model?.vertices).toHaveLength(3);
    expect(model?.edges).toHaveLength(3);
  });

  it('reads ASCII STL triangles', () => {
    const model = parseStl(TETRA_STL);
    expect(model?.vertices).toHaveLength(6);
    expect(model?.edges).toHaveLength(6);
  });

  it('selects a reader by extension and declines unsupported formats', () => {
    expect(modelFromFile('scene/model.obj', TRIANGLE_OBJ)?.format).toBe('obj');
    expect(modelFromFile('scene/model.stl', TETRA_STL)?.format).toBe('stl');
    expect(modelFromFile('scene/model.glb', 'glTF')).toBeNull();
  });

  it('centres and scales a model without dropping its topology', () => {
    const model = parseObj(TRIANGLE_OBJ);
    expect(model).not.toBeNull();
    const normalized = normalizeModel(model!);
    const xs = normalized.vertices.map((vertex) => vertex.x);
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 5);
    expect(Math.max(...xs)).toBeCloseTo(0.5, 5);
    expect(normalized.edges).toHaveLength(3);
  });

  it('declines an OBJ with no faces and an STL with fewer than three vertices', () => {
    expect(parseObj('v 0 0 0\nv 1 0 0')).toBeNull();
    expect(parseStl('solid empty\nendsolid empty')).toBeNull();
  });
});
