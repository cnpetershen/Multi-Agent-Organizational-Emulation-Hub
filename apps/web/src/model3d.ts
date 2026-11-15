/**
 * A dependency-free reader for the 3D formats a delivered project can actually carry as text.
 *
 * The console's preview runtime can already iframe a delivered 3D *page* (three.js, WebGL,
 * model-viewer). A `.obj` or `.stl` file has no page to iframe, so this module turns its text
 * into vertices and edges and lets the delivery package draw an honest wireframe. Unsupported
 * formats (binary glTF, FBX) are still *listed* as 3D assets by the package; this parser simply
 * declines to pretend it can render them.
 */

export type ModelFormat = 'obj' | 'stl';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Model3D {
  readonly format: ModelFormat;
  readonly sourcePath: string;
  readonly vertices: readonly Vec3[];
  readonly edges: readonly (readonly [number, number])[];
}

export interface NormalizedModel {
  readonly format: ModelFormat;
  readonly sourcePath: string;
  readonly vertices: readonly Vec3[];
  readonly edges: readonly (readonly [number, number])[];
  /** A rough bounding radius after centring, for the viewer's own framing. */
  readonly radius: number;
}

const numberPattern = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)';

function extensionOf(path: string): string {
  const clean = path.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  return dot <= 0 ? '' : clean.slice(dot);
}

/** Parse a Wavefront OBJ: `v x y z` vertices and `f a b c …` polygons. */
export function parseObj(text: string, sourcePath = 'model.obj'): Model3D | null {
  const vertices: Vec3[] = [];
  const edges: [number, number][] = [];
  const seen = new Set<string>();

  const addVertex = (x: number, y: number, z: number): number => {
    vertices.push({ x, y, z });
    return vertices.length - 1;
  };
  const addEdge = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0 || from >= vertices.length || to >= vertices.length) return;
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([from, to]);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) addVertex(x, y, z);
      continue;
    }
    if (parts[0] === 'f' && parts.length >= 4) {
      const indices: number[] = [];
      for (const token of parts.slice(1)) {
        const first = token.split('/')[0] ?? '';
        const value = Number(first);
        if (!Number.isInteger(value) || value === 0) continue;
        indices.push(value > 0 ? value - 1 : vertices.length + value);
      }
      for (let index = 0; index < indices.length; index += 1) {
        const from = indices[index];
        const to = indices[(index + 1) % indices.length];
        if (from !== undefined && to !== undefined) addEdge(from, to);
      }
    }
  }

  return vertices.length >= 3 && edges.length > 0
    ? { format: 'obj', sourcePath, vertices, edges }
    : null;
}

/** Parse an ASCII STL: every `vertex x y z` triplet is one triangle. */
export function parseStl(text: string, sourcePath = 'model.stl'): Model3D | null {
  const vertices: Vec3[] = [];
  const edges: [number, number][] = [];
  const pattern = new RegExp(`vertex\\s+${numberPattern}\\s+${numberPattern}\\s+${numberPattern}`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if ([x, y, z].every(Number.isFinite)) vertices.push({ x, y, z });
  }
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    edges.push([index, index + 1], [index + 1, index + 2], [index + 2, index]);
  }
  return vertices.length >= 3 && edges.length > 0
    ? { format: 'stl', sourcePath, vertices, edges }
    : null;
}

/** Which delivered file can be rendered as a 3D model, if any. */
export function modelFromFile(path: string, content: string): Model3D | null {
  const extension = extensionOf(path);
  if (extension === '.obj') return parseObj(content, path);
  if (extension === '.stl') return parseStl(content, path);
  return null;
}

/** Center the model at the origin, scale it to roughly unit radius, and keep its edge list. */
export function normalizeModel(model: Model3D): NormalizedModel {
  if (model.vertices.length === 0) return { ...model, radius: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of model.vertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    minZ = Math.min(minZ, vertex.z);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
    maxZ = Math.max(maxZ, vertex.z);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  return {
    format: model.format,
    sourcePath: model.sourcePath,
    edges: model.edges,
    radius: 1,
    vertices: model.vertices.map((vertex) => ({
      x: (vertex.x - centerX) / span,
      y: (vertex.y - centerY) / span,
      z: (vertex.z - centerZ) / span,
    })),
  };
}

export const MODEL_EXTENSIONS: ReadonlySet<string> = new Set(['.obj', '.stl', '.glb', '.gltf', '.fbx', '.ply']);
export const MODEL_RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.obj', '.stl']);
