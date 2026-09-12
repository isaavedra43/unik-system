import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'zlib';
import {
  detectMimeFromBytes,
  inspectSvg,
  looksLikeText,
  normalizeMime,
  readImageDimensions,
  sanitizeSvg,
  validateFileContent,
} from './file-validation';
import { bufferRandomAccess, readZipDirectory, readZipEntry, isTraversalName } from './zip-reader';

function png(width = 3, height = 2): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Builds a minimal, valid ZIP (deflate) with the given entries. */
function zip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const compressed = e.store ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(e.store ? 0 : 8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const limits = { maxBytes: 10 * 1024 * 1024, allowedMimeTypes: [] as string[] };

describe('detectMimeFromBytes', () => {
  it('detects common formats by magic bytes', () => {
    expect(detectMimeFromBytes(png())?.mimeType).toBe('image/png');
    expect(detectMimeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mimeType).toBe('image/jpeg');
    expect(detectMimeFromBytes(Buffer.from('%PDF-1.7'))?.mimeType).toBe('application/pdf');
    expect(detectMimeFromBytes(Buffer.from('PK\x03\x04'))?.mimeType).toBe('application/zip');
    expect(detectMimeFromBytes(Buffer.from('MZ\x90\x00'))?.mimeType).toBe(
      'application/x-msdownload'
    );
    expect(detectMimeFromBytes(Buffer.from('hola mundo'))).toBeNull();
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(readImageDimensions(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
  });
});

describe('validateFileContent', () => {
  it('rejects a fake MIME: a PDF declared as PNG', async () => {
    const head = Buffer.from('%PDF-1.4 fake');
    const res = await validateFileContent({
      declaredMimeType: 'image/png',
      declaredSize: head.length,
      actualSize: head.length,
      head,
      limits,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no coincide/);
    expect(res.detectedMimeType).toBe('application/pdf');
  });

  it('rejects a file bigger than the authorized size and size mismatches', async () => {
    const head = png();
    const tooBig = await validateFileContent({
      declaredMimeType: 'image/png',
      declaredSize: 100,
      actualSize: 100,
      head,
      limits: { maxBytes: 50, allowedMimeTypes: [] },
    });
    expect(tooBig.ok).toBe(false);
    const mismatch = await validateFileContent({
      declaredMimeType: 'image/png',
      declaredSize: 100,
      actualSize: 90,
      head,
      limits,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toMatch(/distinto al declarado/);
  });

  it('never accepts executables even when the target allows anything', async () => {
    const head = Buffer.from('MZ\x90\x00\x03');
    const res = await validateFileContent({
      declaredMimeType: 'application/octet-stream',
      declaredSize: head.length,
      actualSize: head.length,
      head,
      limits,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/ejecutables/);
  });

  it('accepts a real PNG and extracts dimensions', async () => {
    const head = png(120, 80);
    const res = await validateFileContent({
      declaredMimeType: 'image/png',
      declaredSize: head.length,
      actualSize: head.length,
      head,
      limits: { maxBytes: 1000, allowedMimeTypes: ['image/png', 'image/jpeg'] },
    });
    expect(res.ok).toBe(true);
    expect(res.detectedMimeType).toBe('image/png');
    expect(res.metadata.width).toBe(120);
    expect(res.metadata.height).toBe(80);
  });

  it('enforces the allowed list using the detected type', async () => {
    const head = png();
    const res = await validateFileContent({
      declaredMimeType: 'image/png',
      declaredSize: head.length,
      actualSize: head.length,
      head,
      limits: { maxBytes: 1000, allowedMimeTypes: ['application/pdf'] },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no permitido/);
  });

  it('accepts text declared as text/csv and rejects binary declared as text', async () => {
    const csv = Buffer.from('a,b\n1,2\n');
    const ok = await validateFileContent({
      declaredMimeType: 'text/csv',
      declaredSize: csv.length,
      actualSize: csv.length,
      head: csv,
      limits,
    });
    expect(ok.ok).toBe(true);
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]);
    const bad = await validateFileContent({
      declaredMimeType: 'text/plain',
      declaredSize: bin.length,
      actualSize: bin.length,
      head: bin,
      limits,
    });
    expect(bad.ok).toBe(false);
  });

  it('flags SVG as download-only and detects active content', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
    const res = await validateFileContent({
      declaredMimeType: 'image/svg+xml',
      declaredSize: svg.length,
      actualSize: svg.length,
      head: svg,
      limits,
    });
    expect(res.ok).toBe(true);
    expect(res.downloadOnly).toBe(true);
    expect(res.metadata.svgSafeForPreview).toBe(false);
  });

  it('treats audio/webm and video/webm as the same container (voice notes)', async () => {
    const head = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('....webm....'),
    ]);
    const res = await validateFileContent({
      declaredMimeType: 'audio/webm',
      declaredSize: head.length,
      actualSize: head.length,
      head,
      limits,
    });
    expect(res.ok).toBe(true);
    expect(res.detectedMimeType).toBe('audio/webm');
  });

  it('identifies an XLSX package inside a zip and rejects a plain zip declared as xlsx', async () => {
    const xlsx = zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    ]);
    const okRes = await validateFileContent({
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: xlsx.length,
      actualSize: xlsx.length,
      head: xlsx.subarray(0, 64),
      randomAccess: bufferRandomAccess(xlsx),
      limits,
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.detectedMimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(okRes.metadata.zipEntries).toBe(2);

    const plain = zip([{ name: 'readme.txt', data: Buffer.from('hola') }]);
    const badRes = await validateFileContent({
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredSize: plain.length,
      actualSize: plain.length,
      head: plain.subarray(0, 64),
      randomAccess: bufferRandomAccess(plain),
      limits,
    });
    expect(badRes.ok).toBe(false);
  });

  it('rejects archives that expand beyond the limit or contain traversal paths', async () => {
    const big = zip([{ name: 'big.bin', data: Buffer.alloc(2 * 1024 * 1024, 0) }]);
    const bomb = await validateFileContent({
      declaredMimeType: 'application/zip',
      declaredSize: big.length,
      actualSize: big.length,
      head: big.subarray(0, 64),
      randomAccess: bufferRandomAccess(big),
      limits: { ...limits, maxZipExpansionBytes: 1024 * 1024 },
    });
    expect(bomb.ok).toBe(false);
    expect(bomb.reason).toMatch(/descomprimido/);

    const traversal = zip([{ name: '../../etc/passwd', data: Buffer.from('x') }]);
    const trav = await validateFileContent({
      declaredMimeType: 'application/zip',
      declaredSize: traversal.length,
      actualSize: traversal.length,
      head: traversal.subarray(0, 64),
      randomAccess: bufferRandomAccess(traversal),
      limits,
    });
    expect(trav.ok).toBe(false);
    expect(trav.reason).toMatch(/rutas no permitidas/);
  });
});

describe('zip-reader', () => {
  it('reads the central directory and inflates one entry with a cap', async () => {
    const data = Buffer.from('hello hello hello hello');
    const archive = zip([
      { name: 'a.txt', data },
      { name: 'dir/', data: Buffer.alloc(0), store: true },
    ]);
    const dir = await readZipDirectory(bufferRandomAccess(archive));
    expect(dir.zip64).toBe(false);
    expect(dir.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/']);
    expect(dir.entries[1].isDirectory).toBe(true);
    const content = await readZipEntry(bufferRandomAccess(archive), dir.entries[0], 1024);
    expect(content.toString()).toBe(data.toString());
    await expect(readZipEntry(bufferRandomAccess(archive), dir.entries[0], 4)).rejects.toThrow();
  });

  it('flags traversal names', () => {
    expect(isTraversalName('../x')).toBe(true);
    expect(isTraversalName('/abs')).toBe(true);
    expect(isTraversalName('C:\\win')).toBe(true);
    expect(isTraversalName('ok/file.txt')).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizes MIME aliases', () => {
    expect(normalizeMime('image/JPG')).toBe('image/jpeg');
    expect(normalizeMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeMime('audio/x-wav')).toBe('audio/wav');
  });

  it('sanitizes SVG previews', () => {
    const dirty =
      '<svg onload="x()"><script>1</script><a href="http://evil"/><circle r="1"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|onload|http:\/\/evil/);
    expect(clean).toMatch(/<circle/);
    expect(inspectSvg(clean).safe).toBe(true);
  });

  it('detects binary vs text', () => {
    expect(looksLikeText(Buffer.from('plain text\nline'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x41]))).toBe(false);
  });
});
