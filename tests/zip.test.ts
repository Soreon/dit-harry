import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { crc32, createZip } from '../src/lib/zip';

interface ParsedEntry {
  name: string;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  size: number;
  data: Uint8Array;
  localOffset: number;
}

/** Relit une archive zip « stockée » en vérifiant la cohérence en-têtes locaux / répertoire central. */
async function readZip(blob: Blob): Promise<{ entries: ParsedEntry[]; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  expect(view.getUint16(eocd + 8, true)).toBe(count);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);
  expect(view.getUint16(eocd + 20, true)).toBe(0); // pas de commentaire

  const entries: ParsedEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(compSize).toBe(size);

    // En-tête local : mêmes valeurs
    const l = localOffset;
    expect(view.getUint32(l, true)).toBe(0x04034b50);
    expect(view.getUint16(l + 6, true)).toBe(flags);
    expect(view.getUint16(l + 8, true)).toBe(method);
    expect(view.getUint16(l + 10, true)).toBe(time);
    expect(view.getUint16(l + 12, true)).toBe(date);
    expect(view.getUint32(l + 14, true)).toBe(crc);
    expect(view.getUint32(l + 18, true)).toBe(size);
    expect(view.getUint32(l + 22, true)).toBe(size);
    const lNameLen = view.getUint16(l + 26, true);
    const lExtraLen = view.getUint16(l + 28, true);
    expect(dec.decode(bytes.subarray(l + 30, l + 30 + lNameLen))).toBe(name);
    const dataStart = l + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);

    entries.push({ name, flags, method, time, date, crc, size, data, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  expect(p).toBe(cdOffset + cdSize);
  return { entries, bytes };
}

const text = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  it('donne les valeurs de référence', () => {
    expect(crc32(text('hello'))).toBe(0x3610a686);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('createZip', () => {
  it('produit une archive vide valide', async () => {
    const blob = createZip([]);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(22);
    const { entries } = await readZip(blob);
    expect(entries).toEqual([]);
  });

  it('stocke les fichiers sans compression, noms UTF-8, CRC corrects', async () => {
    const binary = new Uint8Array([0, 1, 2, 250, 255]);
    const blob = createZip([
      { path: 'hello.txt', data: 'hello' },
      { path: 'markdown/2026/journée — été 😄.md', data: '# Café\n' },
      { path: 'bin/data.bin', data: binary },
    ]);
    expect(blob.type).toBe('application/zip');
    const { entries } = await readZip(blob);
    expect(entries.map((e) => e.name)).toEqual([
      'hello.txt',
      'markdown/2026/journée — été 😄.md',
      'bin/data.bin',
    ]);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800); // bit 11 : UTF-8
      expect(e.crc).toBe(crc32(e.data));
    }
    expect(entries[0]?.crc).toBe(0x3610a686);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe('hello');
    expect(new TextDecoder().decode(entries[1]?.data)).toBe('# Café\n');
    expect(entries[1]?.size).toBe(text('# Café\n').length);
    expect([...(entries[2]?.data ?? [])]).toEqual([0, 1, 2, 250, 255]);
    expect(entries[0]?.localOffset).toBe(0);
  });

  it('respecte les vues partielles de Uint8Array', async () => {
    const big = new Uint8Array([9, 9, 104, 101, 108, 108, 111, 9]);
    const { entries } = await readZip(createZip([{ path: 'x', data: big.subarray(2, 7) }]));
    expect(new TextDecoder().decode(entries[0]?.data)).toBe('hello');
    expect(entries[0]?.crc).toBe(0x3610a686);
  });

  it('encode la date au format MS-DOS (heure locale), avec une valeur fixe par défaut', async () => {
    const d = new Date(2026, 9, 8, 14, 32, 11);
    const { entries } = await readZip(
      createZip([
        { path: 'a.txt', data: 'a', date: d },
        { path: 'b.txt', data: 'b' },
      ]),
    );
    expect(entries[0]?.time).toBe((14 << 11) | (32 << 5) | 5);
    expect(entries[0]?.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 8);
    // 1980-01-01 00:00:00
    expect(entries[1]?.time).toBe(0);
    expect(entries[1]?.date).toBe((1 << 5) | 1);
  });

  it('est déterministe', async () => {
    const files = [
      { path: 'a.txt', data: 'alpha' },
      { path: 'b/c.txt', data: 'bêta', date: new Date(2026, 0, 2, 3, 4, 6) },
    ];
    const a = new Uint8Array(await createZip(files).arrayBuffer());
    const b = new Uint8Array(await createZip(files).arrayBuffer());
    expect(a).toEqual(b);
  });

  it('normalise les chemins', async () => {
    const { entries } = await readZip(createZip([{ path: '\\dossier\\fichier.txt', data: '' }]));
    expect(entries[0]?.name).toBe('dossier/fichier.txt');
    expect(entries[0]?.size).toBe(0);
    expect(entries[0]?.crc).toBe(0);
  });

  it('refuse un nom vide et un nombre de fichiers excessif', () => {
    expect(() => createZip([{ path: '', data: 'x' }])).toThrow(AppError);
    const file = { path: 'a', data: '' };
    const tooMany = new Array<typeof file>(0x10000).fill(file);
    expect(() => createZip(tooMany)).toThrow(/65 535/);
  });
});
