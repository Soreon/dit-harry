import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { buildExportZip, downloadBlob } from '../src/lib/backup';
import { createLocalDb } from '../src/lib/db';
import { renderDayMarkdown } from '../src/lib/markdown';
import type { Entry, LocalDb, LocalEntry, LocalSynthesis } from '../src/lib/types';
import { newId } from '../src/lib/util';

/** Lecture minimale d'un zip « stocké » : nom → contenu texte. */
async function unzip(blob: Blob): Promise<Map<string, string>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const skip = view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.set(name, dec.decode(bytes.subarray(start, start + size)));
    p += 46 + nameLen + skip;
  }
  return out;
}

function localTime(day: string, h: number, m: number): string {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h, m).toISOString();
}

function makeEntry(id: string, day: string, h: number, m: number, analyzed = true): LocalEntry {
  return {
    id,
    day,
    createdAt: localTime(day, h, m),
    updatedAt: localTime(day, h, m + 1),
    source: 'voice',
    durationSec: 42,
    audioMime: 'audio/webm',
    audioFileId: `audio-${id}`,
    transcript: `Transcription ${id}.`,
    ...(analyzed
      ? {
          analysis: {
            title: `Titre ${id}`,
            summary: 'Résumé.',
            mood: { score: 1 as const, label: 'bien' },
            themes: ['test'],
            people: [],
            places: [],
            todos: [],
          },
        }
      : {}),
    local: { dirty: true, needsAnalysis: !analyzed, hasLocalAudio: true, attempts: 2, driveFileId: 'x' },
  };
}

function makeSynthesis(day: string): LocalSynthesis {
  return {
    day,
    generatedAt: '2026-10-08T05:00:00.000Z',
    model: 'gemini-3.8-flash',
    basedOn: '1-abcd',
    summary: `Synthèse du ${day}.`,
    mood: { score: 2, label: 'ravi' },
    highlights: ['un moment'],
    themes: ['test'],
    todos: [],
    local: { dirty: false, driveFileId: 'y' },
  };
}

function freshDb(): LocalDb {
  return createLocalDb(`dit-harry-test-backup-${newId()}`);
}

const NOW = new Date(2026, 9, 8, 14, 32, 10);

describe('buildExportZip', () => {
  it('exporte JSON + Markdown par jour + LISEZMOI', async () => {
    const db = freshDb();
    const e1 = makeEntry('b-second', '2026-10-07', 20, 0);
    const e2 = makeEntry('a-first', '2026-10-07', 9, 30);
    const e3 = makeEntry('c-today', '2026-10-08', 8, 0, false);
    const e4 = makeEntry('d-old', '2025-12-31', 23, 50);
    for (const e of [e1, e2, e3, e4]) await db.putEntry(e);
    const s1 = makeSynthesis('2026-10-07');
    const sOrphan = makeSynthesis('2026-10-01');
    await db.putSynthesis(s1);
    await db.putSynthesis(sOrphan);
    await db.setKv('settings', { audioRetentionDays: 90 });

    const { blob, filename } = await buildExportZip(db, NOW);
    expect(filename).toBe('dit-harry-export-2026-10-08.zip');
    expect(blob.type).toBe('application/zip');

    const files = await unzip(blob);
    expect([...files.keys()]).toEqual([
      'LISEZMOI.txt',
      'dit-harry.json',
      'markdown/2025/2025-12-31.md',
      'markdown/2026/2026-10-01.md',
      'markdown/2026/2026-10-07.md',
      'markdown/2026/2026-10-08.md',
    ]);

    // JSON : sans état local, trié chronologiquement
    const json = JSON.parse(files.get('dit-harry.json') ?? '{}') as {
      app: string;
      version: string;
      exportedAt: string;
      entries: Entry[];
      syntheses: LocalSynthesis[];
    };
    expect(json.app).toBe('Dit Harry');
    expect(json.version).toBe(config.version);
    expect(json.exportedAt).toBe(NOW.toISOString());
    expect(json.entries.map((e) => e.id)).toEqual(['d-old', 'a-first', 'b-second', 'c-today']);
    expect(json.syntheses.map((s) => s.day)).toEqual(['2026-10-01', '2026-10-07']);
    for (const e of json.entries) expect(e).not.toHaveProperty('local');
    for (const s of json.syntheses) expect(s).not.toHaveProperty('local');
    const { local: _l, ...e2Plain } = e2;
    void _l;
    expect(json.entries[1]).toEqual(e2Plain);

    // Markdown : identique au rendu de référence
    const strip = ({ local, ...rest }: LocalEntry): Entry => {
      void local;
      return rest;
    };
    const { local: _s, ...s1Plain } = s1;
    void _s;
    expect(files.get('markdown/2026/2026-10-07.md')).toBe(
      renderDayMarkdown('2026-10-07', [e1, e2].map(strip), s1Plain),
    );
    expect(files.get('markdown/2026/2026-10-08.md')).toContain('(analyse en attente)');
    expect(files.get('markdown/2026/2026-10-01.md')).toContain('*Aucune entrée.*');

    // LISEZMOI : en français, mentionne l'audio et la durée de conservation réglée
    const readme = files.get('LISEZMOI.txt') ?? '';
    expect(readme).toContain('jeudi 8 octobre 2026 à 14:32');
    expect(readme).toContain('4 entrées sur 4 jours');
    expect(readme).toContain('enregistrements audio');
    expect(readme).toContain('90 jours');
    expect(readme).toContain('clé Gemini');
  });

  it('fonctionne avec une base vide (durée de conservation par défaut)', async () => {
    const { blob, filename } = await buildExportZip(freshDb(), NOW);
    expect(filename).toBe('dit-harry-export-2026-10-08.zip');
    const files = await unzip(blob);
    expect([...files.keys()]).toEqual(['LISEZMOI.txt', 'dit-harry.json']);
    const json = JSON.parse(files.get('dit-harry.json') ?? '{}') as { entries: unknown[]; syntheses: unknown[] };
    expect(json.entries).toEqual([]);
    expect(json.syntheses).toEqual([]);
    expect(files.get('LISEZMOI.txt')).toContain(`${config.defaultAudioRetentionDays} jours`);
    expect(files.get('LISEZMOI.txt')).toContain('0 entrée sur 0 jour');
  });

  it('est déterministe pour une même date d’export', async () => {
    const db = freshDb();
    await db.putEntry(makeEntry('x', '2026-10-08', 7, 0));
    const a = new Uint8Array(await (await buildExportZip(db, NOW)).blob.arrayBuffer());
    const b = new Uint8Array(await (await buildExportZip(db, NOW)).blob.arrayBuffer());
    expect(a).toEqual(b);
  });
});

describe('downloadBlob', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clique sur un lien <a download> temporaire puis libère l’URL', () => {
    vi.useFakeTimers();
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const blob = new Blob(['x'], { type: 'application/zip' });
    downloadBlob(blob, 'dit-harry-export-2026-10-08.zip');

    expect(create).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe('blob:fake');
    expect(anchor.download).toBe('dit-harry-export-2026-10-08.zip');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});

describe('buildExportZip — notes d’autres jours', () => {
  function withMentions(e: LocalEntry): LocalEntry {
    return {
      ...e,
      analysis: e.analysis && {
        ...e.analysis,
        mentions: [
          { id: 'p1', kind: 'past', day: '2026-10-03', when: 'samedi dernier', text: 'Mer.', status: 'auto' },
          { id: 'f1', kind: 'future', day: '2026-10-12', when: 'lundi prochain', text: 'Dentiste.', status: 'auto' },
        ],
      },
    };
  }

  it('un jour qui n’a que des notes a sa page ; jamais un jour à venir', async () => {
    const db = freshDb();
    await db.putEntry(withMentions(makeEntry('src', '2026-10-08', 9, 0)));
    const files = await unzip((await buildExportZip(db, NOW)).blob);
    expect(files.get('markdown/2026/2026-10-03.md')).toContain("## Ajouté plus tard\n\n- Mer. *(dit le jeudi 8 octobre 2026 à 09:00, « samedi dernier »)*");
    expect(files.has('markdown/2026/2026-10-12.md')).toBe(false);
    expect(files.get('markdown/2026/2026-10-08.md')).toContain('📌 Prévu pour le lundi 12 octobre 2026 (« lundi prochain »).');
    // Le JSON garde tout, y compris les mentions
    expect(files.get('dit-harry.json')).toContain('"mentions"');
  });

  it('« Rattacher aux autres jours » désactivé : pas de page ni de ligne pour les notes', async () => {
    const db = freshDb();
    await db.setKv('settings', { dayLinks: 'off' });
    await db.putEntry(withMentions(makeEntry('src', '2026-10-08', 9, 0)));
    const files = await unzip((await buildExportZip(db, NOW)).blob);
    expect(files.has('markdown/2026/2026-10-03.md')).toBe(false);
    expect(files.get('markdown/2026/2026-10-08.md')).not.toContain('Prévu pour');
  });
});
