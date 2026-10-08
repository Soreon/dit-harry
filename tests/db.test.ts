import { describe, expect, it } from 'vitest';
import { createLocalDb, updateEntry, updateKv, withEntryLock, withKvLock } from '../src/lib/db';
import type { LocalEntry, LocalSynthesis, RecordingChunk } from '../src/lib/types';

function freshDb(): { name: string; db: ReturnType<typeof createLocalDb> } {
  const name = `test-db-${crypto.randomUUID()}`;
  return { name, db: createLocalDb(name) };
}

function entry(id: string, day: string, createdAt: string): LocalEntry {
  return {
    id,
    day,
    createdAt,
    updatedAt: createdAt,
    source: 'text',
    transcript: `texte ${id}`,
    local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 },
  };
}

function synthesis(day: string): LocalSynthesis {
  return {
    day,
    generatedAt: `${day}T23:00:00.000Z`,
    model: 'm',
    basedOn: '1-abc',
    summary: `Résumé ${day}`,
    mood: { score: 1, label: 'content' },
    highlights: [],
    themes: [],
    todos: [],
    local: { dirty: false },
  };
}

describe('createLocalDb', () => {
  it('stocke, relit et supprime des entrées ; listes triées du plus récent au plus ancien', async () => {
    const { db } = freshDb();
    await db.putEntry(entry('a', '2026-10-07', '2026-10-07T08:00:00.000Z'));
    await db.putEntry(entry('b', '2026-10-08', '2026-10-08T09:00:00.000Z'));
    await db.putEntry(entry('c', '2026-10-08', '2026-10-08T07:00:00.000Z'));

    expect((await db.getEntry('b'))?.transcript).toBe('texte b');
    expect(await db.getEntry('zzz')).toBeUndefined();
    expect((await db.listEntries()).map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect((await db.listEntriesByDay('2026-10-08')).map((e) => e.id)).toEqual(['b', 'c']);
    expect(await db.listEntriesByDay('2026-01-01')).toEqual([]);

    // put = remplacement
    await db.putEntry({ ...entry('a', '2026-10-07', '2026-10-07T08:00:00.000Z'), transcript: 'modifié' });
    expect((await db.getEntry('a'))?.transcript).toBe('modifié');

    await db.deleteEntry('b');
    expect((await db.listEntries()).map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('gère les synthèses par jour', async () => {
    const { db } = freshDb();
    await db.putSynthesis(synthesis('2026-10-06'));
    await db.putSynthesis(synthesis('2026-10-07'));
    expect((await db.getSynthesis('2026-10-07'))?.summary).toBe('Résumé 2026-10-07');
    expect((await db.listSyntheses()).map((s) => s.day)).toEqual(['2026-10-07', '2026-10-06']);
    await db.deleteSynthesis('2026-10-07');
    expect(await db.getSynthesis('2026-10-07')).toBeUndefined();
  });

  it('stocke les Blobs audio tels quels', async () => {
    const { db } = freshDb();
    await db.putAudio('e1', new Blob(['bonjour'], { type: 'audio/webm' }));
    const blob = await db.getAudio('e1');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('audio/webm');
    expect(await blob?.text()).toBe('bonjour');
    await db.deleteAudio('e1');
    expect(await db.getAudio('e1')).toBeUndefined();
    // suppression d'une clé absente : pas d'erreur
    await db.deleteAudio('absent');
  });

  it('gère les morceaux d\'enregistrement (tri, ids, suppression ciblée)', async () => {
    const { db } = freshDb();
    const chunk = (recordingId: string, index: number): RecordingChunk => ({
      recordingId,
      index,
      blob: new Blob([`${recordingId}-${index}`]),
      mimeType: 'audio/webm',
      startedAt: '2026-10-08T10:00:00.000Z',
    });
    await db.putChunk(chunk('r1', 2));
    await db.putChunk(chunk('r1', 0));
    await db.putChunk(chunk('r2', 0));
    await db.putChunk(chunk('r1', 10));
    await db.putChunk(chunk('r1', 1));

    const r1 = await db.getChunks('r1');
    expect(r1.map((c) => c.index)).toEqual([0, 1, 2, 10]);
    expect(await r1[3]?.blob.text()).toBe('r1-10');
    expect((await db.listRecordingIds()).sort()).toEqual(['r1', 'r2']);

    await db.deleteChunks('r1');
    expect(await db.getChunks('r1')).toEqual([]);
    expect((await db.getChunks('r2')).length).toBe(1);
    expect(await db.listRecordingIds()).toEqual(['r2']);
  });

  it('gère le stockage clé/valeur', async () => {
    const { db } = freshDb();
    expect(await db.getKv('absent')).toBeUndefined();
    await db.setKv('sync.pendingDeletes', ['a', 'b']);
    await db.setKv('sync.settingsDirty', false);
    await db.setKv('mirror.state', { yearIds: { '2026': 'y' }, days: {} });
    expect(await db.getKv<string[]>('sync.pendingDeletes')).toEqual(['a', 'b']);
    expect(await db.getKv<boolean>('sync.settingsDirty')).toBe(false);
    expect(await db.getKv('mirror.state')).toEqual({ yearIds: { '2026': 'y' }, days: {} });
    await db.deleteKv('sync.pendingDeletes');
    expect(await db.getKv('sync.pendingDeletes')).toBeUndefined();
  });

  it('clearAll vide tous les stores', async () => {
    const { db } = freshDb();
    await db.putEntry(entry('a', '2026-10-07', '2026-10-07T08:00:00.000Z'));
    await db.putSynthesis(synthesis('2026-10-07'));
    await db.putAudio('a', new Blob(['x']));
    await db.putChunk({
      recordingId: 'r',
      index: 0,
      blob: new Blob(['x']),
      mimeType: 'audio/webm',
      startedAt: '2026-10-08T10:00:00.000Z',
    });
    await db.setKv('k', 1);
    await db.clearAll();
    expect(await db.listEntries()).toEqual([]);
    expect(await db.listSyntheses()).toEqual([]);
    expect(await db.getAudio('a')).toBeUndefined();
    expect(await db.listRecordingIds()).toEqual([]);
    expect(await db.getKv('k')).toBeUndefined();
  });

  it('isole les bases par nom et persiste entre instances', async () => {
    const { name, db } = freshDb();
    await db.setKv('k', 'v');
    expect(await createLocalDb(name).getKv('k')).toBe('v');
    expect(await createLocalDb(`${name}-autre`).getKv('k')).toBeUndefined();
  });

  it('libère la connexion sur versionchange puis rouvre la base', async () => {
    const { name, db } = freshDb();
    await db.setKv('k', 'v');
    // Une suppression de la base déclenche versionchange : elle ne doit pas rester bloquée.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('suppression bloquée'));
    });
    // La base est recréée (vide) à la prochaine opération.
    expect(await db.getKv('k')).toBeUndefined();
    await db.setKv('k', 'w');
    expect(await db.getKv('k')).toBe('w');
  });
});

describe('updateKv / withKvLock', () => {
  it('lectures-modifications-écritures concurrentes : aucune écriture perdue', async () => {
    const { db } = freshDb();
    await db.setKv('liste', ['x']);
    const add = (v: string) => updateKv(db, 'liste', (cur) => [...(Array.isArray(cur) ? (cur as string[]) : []), v]);
    // Section verrouillée lente (comme la synchro) pendant que d'autres ajouts arrivent
    const slow = withKvLock(db, async () => {
      const cur = (await db.getKv<string[]>('liste')) ?? [];
      await new Promise((r) => setTimeout(r, 20));
      await db.setKv('liste', cur.filter((v) => v !== 'x'));
    });
    await Promise.all([slow, add('a'), add('b')]);
    expect(await db.getKv('liste')).toEqual(['a', 'b']);
  });

  it('une section en erreur ne bloque pas les suivantes', async () => {
    const { db } = freshDb();
    await expect(withKvLock(db, () => Promise.reject(new Error('boum')))).rejects.toThrow('boum');
    expect(await updateKv(db, 'n', (cur) => (typeof cur === 'number' ? cur : 0) + 1)).toBe(1);
    expect(await db.getKv('n')).toBe(1);
  });
});

describe('updateEntry / withEntryLock', () => {
  it('modifications concurrentes d’une entrée : aucune écriture perdue', async () => {
    const { db } = freshDb();
    await db.putEntry({ ...entry('e', '2026-10-08', '2026-10-08T08:00:00.000Z'), transcript: '' });
    // Section lente (comme la synchro : lecture, attente, écriture) pendant d'autres modifications
    const slow = withEntryLock(db, async () => {
      const cur = await db.getEntry('e');
      await new Promise((r) => setTimeout(r, 20));
      if (cur) await db.putEntry({ ...cur, transcript: `${cur.transcript}S` });
    });
    const edits = ['a', 'b', 'c'].map((v) => updateEntry(db, 'e', (cur) => ({ ...cur, transcript: cur.transcript + v })));
    await Promise.all([slow, ...edits]);
    expect((await db.getEntry('e'))?.transcript).toBe('Sabc');
  });

  it('updateEntry : entrée absente ou fn → null : rien n’est écrit', async () => {
    const { db } = freshDb();
    expect(await updateEntry(db, 'absente', (cur) => cur)).toBeUndefined();
    await db.putEntry(entry('e', '2026-10-08', '2026-10-08T08:00:00.000Z'));
    expect(await updateEntry(db, 'e', () => null)).toBeUndefined();
    expect((await db.getEntry('e'))?.transcript).toBe('texte e');
    await expect(withEntryLock(db, () => Promise.reject(new Error('boum')))).rejects.toThrow('boum');
    expect((await updateEntry(db, 'e', (cur) => ({ ...cur, transcript: 'ok' })))?.transcript).toBe('ok');
  });
});
