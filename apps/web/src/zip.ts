/**
 * A tiny store-only ZIP writer.
 *
 * The delivery package is a set of text files the browser already holds. Adding a ZIP library
 * for "download all" would be a dependency for one button, so this module writes the container
 * itself: local headers, central directory, end record, CRC-32, method 0 (stored). No
 * compression, no filesystem, no clock dependence beyond a fixed DOS timestamp.
 *
 * The output is a normal `.zip` that any unzip tool opens; the unit test pins the signatures and
 * the stored byte ranges rather than trusting a browser download.
 */

export interface ZipEntry {
  readonly path: string;
  readonly content: string;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** DOS time/date fixed at 1980-01-01 00:00 so two calls with the same entries are identical. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

interface Prepared {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

/**
 * Build a ZIP from UTF-8 text entries. Paths are stored as given; callers pass artifact-relative
 * POSIX paths, never absolute ones (the download is data, not a filesystem write).
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared: Prepared[] = [];
  let offset = 0;
  for (const entry of entries) {
    // The package is assembled from delivery data, so the path is untrusted input. Drop `..`,
    // empty and drive-only segments before writing a header: a downloaded ZIP must not be able
    // to plant a file outside the folder the operator chose to extract into.
    const safe = entry.path
      .replace(/\\/g, '/')
      .split('/')
      .filter((part) => part !== '' && part !== '.' && part !== '..' && !/^[A-Za-z]:$/.test(part))
      .join('/') || 'artifact';
    const name = encoder.encode(safe);
    const data = encoder.encode(entry.content);
    prepared.push({ name, data, crc: crc32(data), offset });
    offset += 30 + name.length + data.length;
  }

  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const total = offset + centralSize + 22;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  let cursor = 0;
  for (const entry of prepared) {
    u32(view, cursor, 0x04034b50);
    u16(view, cursor + 4, 20);
    u16(view, cursor + 6, 0x0800);
    u16(view, cursor + 8, 0);
    u16(view, cursor + 10, DOS_TIME);
    u16(view, cursor + 12, DOS_DATE);
    u32(view, cursor + 14, entry.crc);
    u32(view, cursor + 18, entry.data.length);
    u32(view, cursor + 22, entry.data.length);
    u16(view, cursor + 26, entry.name.length);
    u16(view, cursor + 28, 0);
    bytes.set(entry.name, cursor + 30);
    bytes.set(entry.data, cursor + 30 + entry.name.length);
    cursor += 30 + entry.name.length + entry.data.length;
  }

  const centralStart = cursor;
  for (const entry of prepared) {
    u32(view, cursor, 0x02014b50);
    u16(view, cursor + 4, 20);
    u16(view, cursor + 6, 20);
    u16(view, cursor + 8, 0x0800);
    u16(view, cursor + 10, 0);
    u16(view, cursor + 12, DOS_TIME);
    u16(view, cursor + 14, DOS_DATE);
    u32(view, cursor + 16, entry.crc);
    u32(view, cursor + 20, entry.data.length);
    u32(view, cursor + 24, entry.data.length);
    u16(view, cursor + 28, entry.name.length);
    u16(view, cursor + 30, 0);
    u16(view, cursor + 32, 0);
    u16(view, cursor + 34, 0);
    u16(view, cursor + 36, 0);
    u32(view, cursor + 38, 0);
    u32(view, cursor + 42, entry.offset);
    bytes.set(entry.name, cursor + 46);
    cursor += 46 + entry.name.length;
  }

  const centralEnd = cursor;
  u32(view, cursor, 0x06054b50);
  u16(view, cursor + 4, 0);
  u16(view, cursor + 6, 0);
  u16(view, cursor + 8, prepared.length);
  u16(view, cursor + 10, prepared.length);
  u32(view, cursor + 12, centralEnd - centralStart);
  u32(view, cursor + 16, centralStart);
  u16(view, cursor + 20, 0);

  return bytes;
}

/** A download filename derived from a delivery title, without characters a filesystem rejects. */
export function zipNameOf(title: string): string {
  const clean = title
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80);
  return `${clean === '' ? 'delivery' : clean}.zip`;
}
