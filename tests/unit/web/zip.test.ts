import { describe, expect, it } from 'vitest';
import { createZip, crc32, zipNameOf } from '../../../apps/web/src/zip';

/**
 * The package download is a real ZIP container, not a concatenated blob. These assertions pin
 * the signatures and the stored bytes; `crc32` is checked against the standard "123456789" vector.
 */

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('zip writer', () => {
  it('computes the standard CRC-32 vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes local headers, stored bytes, a central directory and an end record', () => {
    const zip = createZip([
      { path: 'brief.md', content: '# Brief\n\nhello\n' },
      { path: 'game/index.html', content: '<!doctype html><canvas></canvas>' },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const decoded = text(zip);
    expect(decoded).toContain('brief.md');
    expect(decoded).toContain('game/index.html');
    expect(decoded).toContain('# Brief');
    expect(decoded).toContain('<!doctype html>');
    // The end record is the last 22 bytes when the comment is empty.
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 12, true)).toBe(2);
  });

  it('normalizes backslashes and strips traversal segments in entered paths', () => {
    const zip = createZip([
      { path: '\\client\\app.js', content: 'console.log(1)' },
      { path: '../../etc/passwd', content: 'nope' },
    ]);
    expect(text(zip)).toContain('client/app.js');
    expect(text(zip)).toContain('etc/passwd');
    expect(text(zip)).not.toContain('../');
  });

  it('produces a safe download name', () => {
    expect(zipNameOf('3D 产品/导览: v1')).toBe('3D 产品-导览- v1.zip');
    expect(zipNameOf('   ')).toBe('delivery.zip');
  });
});
