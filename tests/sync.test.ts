import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rendu Markdown simplifié et déterministe pour tester le miroir indépendamment de markdown.ts.
vi.mock('../src/lib/markdown', () => ({
  renderDayMarkdown: (
    day: string,
    entries: { id: string; updatedAt: string; analysis?: { title: string } }[],
    synthesis?: { summary: string },
  ) =>
    [
      `# ${day}`,
      ...entries.map((e) => `- ${e.id} ${e.updatedAt} ${e.analysis?.title ?? ''}`),
      synthesis ? `> ${synthesis.summary}` : '',
    ].join('\n'),
}));

import { AppError } from '../src/lib/errors';
import { createLocalDb, updateEntry } from '../src/lib/db';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/lib/settings';
import { createSyncEngine, pendingCountOf } from '../src/lib/sync';
import type {
  AiClient,
  DaySynthesis,
  DriveClient,
  DriveFileMeta,
  Entry,
  EntryAnalysis,
  EntryContext,
  LocalDb,
  LocalEntry,
  Settings,
  SyncEngine,
} from '../src/lib/types';
import { dayKey, entriesSignature } from '../src/lib/util';

/* ------------------------------------------------------------------ */
/* Faux Drive en mémoire                                               */
/* ------------------------------------------------------------------ */

interface FakeFile {
  meta: DriveFileMeta;
  content: string | Blob;
  parent: string;
  folder?: boolean;
}

const notFound = () => new AppError('other', 'Fichier introuvable.', { status: 404 });

class FakeDrive implements DriveClient {
  files = new Map<string, FakeFile>();
  calls: Record<string, number> = {};
  /** Renvoie une erreur à lever pour cet appel, ou undefined. */
  fail: ((op: string, args: unknown[]) => Error | undefined) | null = null;
  /** Point d'attente optionnel (single-flight). */
  gate: ((op: string) => Promise<void> | undefined) | null = null;
  private n = 0;

  constructor(private readonly clock: () => Date) {}

  private async hit(op: string, args: unknown[]): Promise<void> {
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    const wait = this.gate?.(op);
    if (wait) await wait;
    const err = this.fail?.(op, args);
    if (err) throw err;
  }

  private stamp(): string {
    this.n++;
    return new Date(this.clock().getTime() + this.n).toISOString();
  }

  private add(name: string, content: string | Blob, parent: string, mimeType: string, props?: Record<string, string>, createdTime?: string, folder = false): FakeFile {
    const t = this.stamp();
    const id = `f${this.n}`;
    const meta: DriveFileMeta = { id, name, mimeType, createdTime: createdTime ?? t, modifiedTime: t };
    if (props) meta.appProperties = { ...props };
    const f: FakeFile = { meta, content, parent, folder };
    this.files.set(id, f);
    return f;
  }

  /** Fichier créé « par un autre appareil ». */
  seedAppData(name: string, content: string | Blob, props: Record<string, string>, createdTime?: string): DriveFileMeta {
    return { ...this.add(name, content, 'appDataFolder', 'application/json', props, createdTime).meta };
  }

  /** Modification « par un autre appareil ». */
  remoteEdit(id: string, content: string): void {
    const f = this.files.get(id);
    if (!f) throw new Error('absent');
    f.content = content;
    f.meta = { ...f.meta, modifiedTime: this.stamp() };
  }

  byName(name: string, parent = 'appDataFolder'): FakeFile | undefined {
    return [...this.files.values()].find((f) => f.meta.name === name && f.parent === parent);
  }

  json<T>(name: string): T {
    const f = this.byName(name);
    if (!f || typeof f.content !== 'string') throw new Error(`absent : ${name}`);
    return JSON.parse(f.content) as T;
  }

  mirrorFile(day: string): FakeFile | undefined {
    const root = this.byName('Dit Harry', 'root');
    const year = root && this.byName(day.slice(0, 4), root.meta.id);
    return year && this.byName(`${day}.md`, year.meta.id);
  }

  remove(id: string): void {
    this.files.delete(id);
    for (const [cid, f] of [...this.files]) if (f.parent === id) this.remove(cid);
  }

  async about() {
    await this.hit('about', []);
    return { email: 'moi@exemple.fr', name: 'Moi' };
  }

  async listAppData(): Promise<DriveFileMeta[]> {
    await this.hit('listAppData', []);
    return [...this.files.values()].filter((f) => f.parent === 'appDataFolder').map((f) => ({ ...f.meta }));
  }

  async downloadJson<T>(fileId: string): Promise<T> {
    await this.hit('downloadJson', [fileId]);
    const f = this.files.get(fileId);
    if (!f) throw notFound();
    const text = typeof f.content === 'string' ? f.content : await f.content.text();
    return JSON.parse(text) as T;
  }

  async downloadBlob(fileId: string): Promise<Blob> {
    await this.hit('downloadBlob', [fileId]);
    const f = this.files.get(fileId);
    if (!f) throw notFound();
    return typeof f.content === 'string' ? new Blob([f.content]) : f.content;
  }

  async createAppDataFile(name: string, body: Blob | string, mimeType: string, appProperties: Record<string, string>): Promise<DriveFileMeta> {
    await this.hit('createAppDataFile', [name, body, mimeType, appProperties]);
    return { ...this.add(name, body, 'appDataFolder', mimeType, appProperties).meta };
  }

  async updateFileContent(fileId: string, body: Blob | string, mimeType: string): Promise<DriveFileMeta> {
    await this.hit('updateFileContent', [fileId, body, mimeType]);
    const f = this.files.get(fileId);
    if (!f) throw notFound();
    f.content = body;
    f.meta = { ...f.meta, mimeType, modifiedTime: this.stamp() };
    return { ...f.meta };
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.hit('deleteFile', [fileId]);
    this.remove(fileId);
  }

  async ensureFolder(name: string, parentId?: string): Promise<string> {
    await this.hit('ensureFolder', [name, parentId]);
    const parent = parentId ?? 'root';
    if (parentId && !this.files.has(parentId)) throw notFound();
    const found = [...this.files.values()].find((f) => f.folder && f.meta.name === name && f.parent === parent);
    if (found) return found.meta.id;
    return this.add(name, '', parent, 'application/vnd.google-apps.folder', undefined, undefined, true).meta.id;
  }

  async upsertTextFile(parentId: string, name: string, content: string, mimeType: string, existingId?: string): Promise<string> {
    await this.hit('upsertTextFile', [parentId, name, content, mimeType, existingId]);
    const existing = existingId ? this.files.get(existingId) : undefined;
    if (existing) {
      existing.content = content;
      existing.meta = { ...existing.meta, modifiedTime: this.stamp() };
      return existing.meta.id;
    }
    if (!this.files.has(parentId)) throw notFound();
    const byName = this.byName(name, parentId);
    if (byName) {
      byName.content = content;
      return byName.meta.id;
    }
    return this.add(name, content, parentId, mimeType).meta.id;
  }
}

/* ------------------------------------------------------------------ */
/* Fausse IA                                                           */
/* ------------------------------------------------------------------ */

function analysisFor(text: string): EntryAnalysis {
  return {
    title: `Titre ${text.slice(0, 40)}`,
    summary: `J'ai dit : ${text}`,
    mood: { score: 1, label: 'content' },
    themes: ['test'],
    people: [],
    places: [],
    todos: [],
  };
}

class FakeAi implements AiClient {
  audioCalls: { mime: string; ctx: EntryContext }[] = [];
  textCalls: string[] = [];
  synthCalls: { day: string; ids: string[] }[] = [];
  fail: ((op: 'audio' | 'text' | 'synth', arg: string) => Error | undefined) | null = null;

  async analyzeAudio(audio: Blob, mimeType: string, ctx: EntryContext) {
    this.audioCalls.push({ mime: mimeType, ctx });
    const err = this.fail?.('audio', mimeType);
    if (err) throw err;
    const text = await audio.text();
    return { transcript: `Transcription de ${text}`, analysis: analysisFor(text) };
  }

  async analyzeText(text: string) {
    this.textCalls.push(text);
    const err = this.fail?.('text', text);
    if (err) throw err;
    return analysisFor(text);
  }

  async synthesizeDay(day: string, entries: Entry[]) {
    this.synthCalls.push({ day, ids: entries.map((e) => e.id) });
    const err = this.fail?.('synth', day);
    if (err) throw err;
    return {
      summary: `Synthèse du ${day} (${entries.length})`,
      mood: { score: 1 as const, label: 'bien' },
      highlights: ['un moment'],
      themes: ['vie'],
      todos: [],
    };
  }

  async checkKey() {}
}

/* ------------------------------------------------------------------ */
/* Banc d'essai                                                        */
/* ------------------------------------------------------------------ */

interface Bench {
  db: LocalDb;
  drive: FakeDrive;
  ai: FakeAi;
  auth: { token: string | null; getToken: () => string | null; markExpired: ReturnType<typeof vi.fn> };
  clock: { t: number };
  online: { value: boolean };
  sync: SyncEngine;
  createAi: ReturnType<typeof vi.fn>;
}

const TODAY = new Date(2026, 9, 8, 10, 0, 0); // 8 octobre 2026, 10 h (heure locale)
const YESTERDAY_EVENING = new Date(2026, 9, 7, 21, 0, 0);

async function bench(settings: Partial<Settings> = { geminiApiKey: 'CLE' }): Promise<Bench> {
  const db = createLocalDb(`test-sync-${crypto.randomUUID()}`);
  await db.setKv('settings', { ...DEFAULT_SETTINGS, ...settings });
  // Données de l'appareil : celles du compte du faux Drive (voir FakeDrive.about).
  await db.setKv('device.ownerEmail', 'moi@exemple.fr');
  const clock = { t: TODAY.getTime() };
  const now = () => new Date(clock.t);
  const drive = new FakeDrive(now);
  const ai = new FakeAi();
  const auth = {
    token: 'jeton' as string | null,
    getToken: () => auth.token,
    markExpired: vi.fn(() => {
      auth.token = null;
    }),
  };
  const online = { value: true };
  const createAi = vi.fn((s: Settings) => {
    if (!s.geminiApiKey.trim()) throw new AppError('invalid-key', 'Ajoute ta clé Gemini.', { retryable: false });
    return ai;
  });
  const sync = createSyncEngine({ db, drive, auth, createAi, now, isOnline: () => online.value });
  return { db, drive, ai, auth, clock, online, sync, createAi };
}

function voiceEntry(id: string, created: Date, extra: Partial<LocalEntry> = {}): LocalEntry {
  const iso = created.toISOString();
  return {
    id,
    day: dayKey(created),
    createdAt: iso,
    updatedAt: iso,
    source: 'voice',
    durationSec: 42,
    audioMime: 'audio/webm',
    audioFileId: null,
    transcript: '',
    local: { dirty: true, needsAnalysis: true, hasLocalAudio: true, attempts: 0 },
    ...extra,
  };
}

function textEntry(id: string, created: Date, text: string, extra: Partial<LocalEntry> = {}): LocalEntry {
  const iso = created.toISOString();
  return {
    id,
    day: dayKey(created),
    createdAt: iso,
    updatedAt: iso,
    source: 'text',
    transcript: text,
    local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 },
    ...extra,
  };
}

async function addVoice(db: LocalDb, e: LocalEntry, sound = 'son'): Promise<void> {
  await db.putAudio(e.id, new Blob([sound], { type: 'audio/webm;codecs=opus' }));
  await db.putEntry(e);
}

async function getEntry(db: LocalDb, id: string): Promise<LocalEntry> {
  const e = await db.getEntry(id);
  if (!e) throw new Error(`entrée absente : ${id}`);
  return e;
}

/** Entrée modifiée localement par l'utilisateur (comme le contrôleur). */
async function editLocally(db: LocalDb, id: string, patch: Partial<Entry>, needsAnalysis = false): Promise<void> {
  const e = await getEntry(db, id);
  await db.putEntry({ ...e, ...patch, local: { ...e.local, dirty: true, needsAnalysis } });
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('pendingCountOf', () => {
  it('compte les entrées à analyser, à envoyer, ou dont l’audio n’est pas dans Drive', () => {
    const base = textEntry('a', TODAY, 'x', { local: { dirty: false, needsAnalysis: false, hasLocalAudio: false, attempts: 0 } });
    expect(pendingCountOf([base])).toBe(0);
    expect(pendingCountOf([{ ...base, local: { ...base.local, dirty: true } }])).toBe(1);
    expect(pendingCountOf([{ ...base, local: { ...base.local, needsAnalysis: true } }])).toBe(1);
    const voice = voiceEntry('v', TODAY, { local: { dirty: false, needsAnalysis: false, hasLocalAudio: true, attempts: 0 } });
    expect(pendingCountOf([voice])).toBe(1);
    expect(pendingCountOf([{ ...voice, audioFileId: 'f1' }])).toBe(0);
    expect(pendingCountOf([base, voice, { ...base, id: 'b', local: { ...base.local, dirty: true } }])).toBe(2);
  });
});

describe('createSyncEngine', () => {
  let b: Bench;
  beforeEach(async () => {
    b = await bench();
  });

  it('nouvelle entrée vocale : analysée, audio envoyé, entrée poussée, audio local supprimé', async () => {
    await addVoice(b.db, voiceEntry('v1', TODAY), 'bonjour');
    const dataChanged = vi.fn();
    b.sync.onDataChanged(dataChanged);

    await b.sync.run();

    expect(b.ai.audioCalls).toHaveLength(1);
    expect(b.ai.audioCalls[0]).toEqual({ mime: 'audio/webm', ctx: { day: '2026-10-08', time: '10:00' } });
    const e = await getEntry(b.db, 'v1');
    expect(e.transcript).toBe('Transcription de bonjour');
    expect(e.analysis?.title).toBe('Titre bonjour');
    expect(e.analysisModel).toBe(DEFAULT_SETTINGS.entryModel);
    expect(e.analyzedAt).toBe(TODAY.toISOString());
    // updatedAt avancé par l'analyse seulement (l'envoi de l'audio ne le touche pas)
    expect(e.updatedAt).toBe(TODAY.toISOString());
    expect(e.local).toMatchObject({ dirty: false, needsAnalysis: false, hasLocalAudio: false, attempts: 0 });
    expect(e.local.error).toBeUndefined();
    expect(await b.db.getAudio('v1')).toBeUndefined();

    const audio = b.drive.byName('audio-v1.webm');
    expect(audio?.meta.mimeType).toBe('audio/webm');
    expect(audio?.meta.appProperties).toEqual({ kind: 'audio', day: '2026-10-08', entryId: 'v1' });
    expect(e.audioFileId).toBe(audio?.meta.id);

    const file = b.drive.byName('entry-v1.json');
    expect(file?.meta.appProperties).toEqual({ kind: 'entry', day: '2026-10-08', entryId: 'v1' });
    expect(e.local.driveFileId).toBe(file?.meta.id);
    expect(e.local.remoteModifiedTime).toBe(file?.meta.modifiedTime);
    const remote = b.drive.json<Record<string, unknown>>('entry-v1.json');
    expect(remote.local).toBeUndefined();
    expect(remote).toMatchObject({ id: 'v1', transcript: 'Transcription de bonjour', audioFileId: audio?.meta.id });

    // Pas de synthèse automatique le jour même
    expect(b.ai.synthCalls).toEqual([]);
    // Miroir
    expect(b.drive.mirrorFile('2026-10-08')).toBeDefined();

    const st = b.sync.getStatus();
    expect(st).toMatchObject({ running: false, phase: 'idle', pendingCount: 0, needsAuth: false, needsKey: false });
    expect(st.lastSyncAt).toBe(TODAY.toISOString());
    expect(st.lastError).toBeUndefined();
    expect(await b.db.getKv('sync.lastSyncAt')).toBe(TODAY.toISOString());
    expect(dataChanged).toHaveBeenCalled();
  });

  it('entrée texte : analysée à partir du texte puis poussée', async () => {
    await b.db.putEntry(textEntry('t1', TODAY, 'Belle journée au parc'));
    await b.sync.run();
    expect(b.ai.textCalls).toEqual(['Belle journée au parc']);
    expect(b.ai.audioCalls).toEqual([]);
    const e = await getEntry(b.db, 't1');
    expect(e.analysis?.title).toBe('Titre Belle journée au parc');
    expect(e.transcript).toBe('Belle journée au parc');
    expect(e.local.dirty).toBe(false);
    expect(b.drive.json<Entry>('entry-t1.json').analysis?.title).toBe('Titre Belle journée au parc');
  });

  it('transcription corrigée : ré-analyse par le texte, sans l’audio', async () => {
    await addVoice(b.db, voiceEntry('v1', TODAY, { transcript: 'texte corrigé', transcriptEdited: true }));
    await b.sync.run();
    expect(b.ai.audioCalls).toEqual([]);
    expect(b.ai.textCalls).toEqual(['texte corrigé']);
    expect((await getEntry(b.db, 'v1')).transcript).toBe('texte corrigé');
  });

  it('analyse avec l’audio téléchargé depuis Drive quand il n’est plus en local', async () => {
    const audio = b.drive.seedAppData('audio-v9.webm', new Blob(['distant'], { type: 'audio/webm' }), {
      kind: 'audio',
      day: '2026-10-08',
      entryId: 'v9',
    });
    await b.db.putEntry(
      voiceEntry('v9', TODAY, {
        audioFileId: audio.id,
        local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 },
      }),
    );
    await b.sync.run();
    expect((await getEntry(b.db, 'v9')).transcript).toBe('Transcription de distant');
    expect(b.drive.calls.downloadBlob).toBe(1);
  });

  it('audio introuvable → erreur notée sur l’entrée, avec backoff', async () => {
    await b.db.putEntry(voiceEntry('v1', TODAY, { local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 } }));
    await b.sync.run();
    const e = await getEntry(b.db, 'v1');
    expect(e.local.attempts).toBe(1);
    expect(e.local.error).toMatch(/Audio introuvable/);
    expect(e.local.retryAfter).toBe(new Date(TODAY.getTime() + 60_000).toISOString());
  });

  it('pull : entrée connue seulement à distance → créée en local', async () => {
    const remote: Entry = {
      id: 'r1',
      day: '2026-10-06',
      createdAt: new Date(2026, 9, 6, 9, 0).toISOString(),
      updatedAt: new Date(2026, 9, 6, 9, 5).toISOString(),
      source: 'text',
      transcript: 'écrit ailleurs',
      analysis: analysisFor('écrit ailleurs'),
    };
    const meta = b.drive.seedAppData('entry-r1.json', JSON.stringify(remote), { kind: 'entry', day: remote.day, entryId: 'r1' });
    const remote2: Entry = { ...remote, id: 'r2', transcript: 'pas encore analysé' };
    delete remote2.analysis;
    b.drive.seedAppData('entry-r2.json', JSON.stringify(remote2), { kind: 'entry', day: remote.day, entryId: 'r2' });

    await b.sync.run();

    const e = await getEntry(b.db, 'r1');
    expect(e).toMatchObject({ ...remote, local: { dirty: false, needsAnalysis: false, hasLocalAudio: false, driveFileId: meta.id, remoteModifiedTime: meta.modifiedTime, attempts: 0 } });
    expect((await getEntry(b.db, 'r2')).local.needsAnalysis).toBe(true);
    // pas de ré-envoi inutile
    expect(b.drive.calls.updateFileContent ?? 0).toBe(0);

    // second cycle : l'entrée non analysée l'est maintenant
    await b.sync.run();
    expect(b.ai.textCalls).toEqual(['pas encore analysé']);
    expect((await getEntry(b.db, 'r2')).local).toMatchObject({ needsAnalysis: false, dirty: false });
  });

  it('suppression à distance → supprimée en local (ou recréée si modifiée ici)', async () => {
    await addVoice(b.db, voiceEntry('v1', TODAY));
    await b.db.putEntry(textEntry('t1', TODAY, 'texte'));
    await b.sync.run();
    const v1 = await getEntry(b.db, 'v1');
    const t1 = await getEntry(b.db, 't1');

    // Un autre appareil supprime les deux ; t1 a été modifiée ici entre-temps.
    b.drive.remove(v1.local.driveFileId ?? '');
    b.drive.remove(t1.local.driveFileId ?? '');
    await editLocally(b.db, 't1', { transcript: 'texte modifié', updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() });

    await b.sync.run();
    expect(await b.db.getEntry('v1')).toBeUndefined();
    const t1b = await getEntry(b.db, 't1');
    expect(t1b.local.dirty).toBe(false);
    expect(t1b.local.driveFileId).toBeDefined();
    expect(t1b.local.driveFileId).not.toBe(t1.local.driveFileId);
    expect(b.drive.json<Entry>('entry-t1.json').transcript).toBe('texte modifié');
  });

  it('conflit : le plus récent (updatedAt) gagne', async () => {
    await b.db.putEntry(textEntry('a', TODAY, 'original A'));
    await b.db.putEntry(textEntry('b', TODAY, 'original B'));
    await b.sync.run();
    const a = await getEntry(b.db, 'a');
    const bb = await getEntry(b.db, 'b');

    const t = (h: number) => new Date(TODAY.getTime() + h * HOUR).toISOString();
    // A : distante plus récente que la modification locale → la distante gagne
    b.drive.remoteEdit(a.local.driveFileId ?? '', JSON.stringify({ ...a, local: undefined, transcript: 'A distante', updatedAt: t(2) }));
    await editLocally(b.db, 'a', { transcript: 'A locale', updatedAt: t(1) });
    // B : locale plus récente → la locale gagne et écrase la distante
    b.drive.remoteEdit(bb.local.driveFileId ?? '', JSON.stringify({ ...bb, local: undefined, transcript: 'B distante', updatedAt: t(1) }));
    await editLocally(b.db, 'b', { transcript: 'B locale', updatedAt: t(2) });

    await b.sync.run();
    const a2 = await getEntry(b.db, 'a');
    expect(a2.transcript).toBe('A distante');
    expect(a2.local.dirty).toBe(false);
    expect(b.drive.json<Entry>('entry-a.json').transcript).toBe('A distante');
    const b2 = await getEntry(b.db, 'b');
    expect(b2.transcript).toBe('B locale');
    expect(b2.local.dirty).toBe(false);
    expect(b.drive.json<Entry>('entry-b.json').transcript).toBe('B locale');
  });

  it('conflit : une modification distante non conflictuelle est prise, les champs techniques locaux conservés', async () => {
    await addVoice(b.db, voiceEntry('v1', TODAY));
    await b.sync.run();
    const v1 = await getEntry(b.db, 'v1');
    const audioId = v1.audioFileId;
    expect(audioId).toBeTruthy();
    // version distante d'un appareil qui ignorait l'id audio
    b.drive.remoteEdit(
      v1.local.driveFileId ?? '',
      JSON.stringify({ ...v1, local: undefined, audioFileId: null, transcript: 'retouche', updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() }),
    );
    await b.sync.run();
    const v2 = await getEntry(b.db, 'v1');
    expect(v2.transcript).toBe('retouche');
    expect(v2.audioFileId).toBe(audioId);
    expect(b.drive.json<Entry>('entry-v1.json').audioFileId).toBe(audioId);
  });

  it('erreur « safety » : pas de nouvel essai automatique, essai manuel possible', async () => {
    b.ai.fail = (op) => (op === 'text' ? new AppError('safety', 'Réponse bloquée par les filtres.', { retryable: false }) : undefined);
    await b.db.putEntry(textEntry('t1', TODAY, 'sujet sensible'));
    await b.sync.run();
    const e = await getEntry(b.db, 't1');
    expect(e.local).toMatchObject({ attempts: 1, errorKind: 'safety', error: 'Réponse bloquée par les filtres.', needsAnalysis: true });
    expect(Date.parse(e.local.retryAfter ?? '')).toBeGreaterThan(TODAY.getTime() + 50 * 365 * DAY);
    // l'entrée est quand même envoyée
    expect(e.local.dirty).toBe(false);

    b.clock.t += 2 * DAY;
    await b.sync.run();
    expect(b.ai.textCalls).toHaveLength(1);

    b.ai.fail = null;
    await b.sync.run({ force: true });
    expect(b.ai.textCalls).toHaveLength(2);
    expect((await getEntry(b.db, 't1')).local).toMatchObject({ needsAnalysis: false, attempts: 0 });
  });

  it('quota : arrêt de l’étape, backoff (retryAfterMs ou exponentiel), audio quand même envoyé', async () => {
    b.ai.fail = () => new AppError('quota', 'Quota Gemini atteint.', { retryAfterMs: 120_000 });
    await addVoice(b.db, voiceEntry('v1', new Date(TODAY.getTime() - HOUR)));
    await b.db.putEntry(textEntry('t2', TODAY, 'deux'));
    await b.sync.run();

    // plus récente d'abord, puis arrêt de l'étape
    expect(b.ai.textCalls).toEqual(['deux']);
    expect(b.ai.audioCalls).toEqual([]);
    const t2 = await getEntry(b.db, 't2');
    // Quota : délai seulement, pas de tentative comptée (les 5 essais auto restent intacts)
    expect(t2.local).toMatchObject({ attempts: 0, errorKind: 'quota' });
    expect(t2.local.retryAfter).toBe(new Date(TODAY.getTime() + 120_000).toISOString());
    expect((await getEntry(b.db, 'v1')).local.attempts).toBe(0);
    expect(b.sync.getStatus()).toMatchObject({ lastErrorKind: 'quota', lastError: 'Quota Gemini atteint.' });

    // l'audio est envoyé même sans analyse, sans toucher à updatedAt ; l'audio local est gardé
    const v1 = await getEntry(b.db, 'v1');
    expect(v1.audioFileId).toBeTruthy();
    expect(v1.updatedAt).toBe(v1.createdAt);
    expect(v1.local.hasLocalAudio).toBe(true);
    expect(await b.db.getAudio('v1')).toBeDefined();

    // backoff exponentiel sans retryAfterMs : 30 s × 2^tentatives
    b.ai.fail = (op) => (op === 'audio' ? new AppError('network', 'Connexion impossible.') : new AppError('quota', 'Quota.', { retryAfterMs: 120_000 }));
    b.clock.t += 10_000; // t2 encore en attente, v1 disponible
    await b.sync.run();
    expect(b.ai.audioCalls).toHaveLength(1);
    expect(b.ai.textCalls).toHaveLength(1);
    expect((await getEntry(b.db, 'v1')).local.retryAfter).toBe(new Date(b.clock.t + 60_000).toISOString());
    expect(b.sync.getStatus().lastErrorKind).toBe('network');
  });

  it('au-delà de 5 tentatives : plus d’essai automatique', async () => {
    b.ai.fail = () => new AppError('bad-response', 'Réponse illisible.', { retryable: true });
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    for (let i = 0; i < 8; i++) {
      await b.sync.run();
      b.clock.t += 2 * HOUR;
    }
    expect(b.ai.textCalls).toHaveLength(5);
    expect((await getEntry(b.db, 't1')).local.attempts).toBe(5);
  });

  it('quota répété (ex. quota journalier) : les 5 essais automatiques ne sont pas consommés', async () => {
    b.ai.fail = () => new AppError('quota', 'Quota quotidien Gemini atteint.', { retryAfterMs: 30_000 });
    await b.db.putEntry(textEntry('q1', TODAY, 'beaucoup'));
    for (let i = 0; i < 8; i++) {
      await b.sync.run();
      b.clock.t += HOUR;
    }
    expect(b.ai.textCalls).toHaveLength(8);
    expect((await getEntry(b.db, 'q1')).local).toMatchObject({ attempts: 0, errorKind: 'quota', needsAnalysis: true });
    // quota rétabli : l'analyse se fait toute seule
    b.ai.fail = null;
    await b.sync.run();
    expect((await getEntry(b.db, 'q1')).analysis).toBeDefined();
  });

  it('correction pendant l’analyse : jamais écrasée par le résultat de l’analyse (verrou des entrées)', async () => {
    await b.db.putEntry(textEntry('t3', TODAY, 'original'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const analyze = b.ai.analyzeText.bind(b.ai);
    b.ai.analyzeText = async (text: string) => {
      started = true;
      await gate;
      return analyze(text);
    };
    const p = b.sync.run();
    await vi.waitFor(() => expect(started).toBe(true));
    // Comme le contrôleur (updateTranscript) : lecture-écriture sous le verrou des entrées,
    // le résultat de l'analyse arrivant dans le même tick.
    const correction = updateEntry(b.db, 't3', (e) => ({
      ...e,
      transcript: 'CORRECTION UTILISATEUR',
      transcriptEdited: true,
      updatedAt: new Date(b.clock.t + 1000).toISOString(),
      local: { ...e.local, dirty: true, needsAnalysis: true, attempts: 0 },
    }));
    release();
    await correction;
    await p;
    const e = await getEntry(b.db, 't3');
    expect(e.transcript).toBe('CORRECTION UTILISATEUR');
    // jamais l'analyse de l'ancien texte marquée comme faite
    expect(e.local.needsAnalysis || e.analysis?.title === 'Titre CORRECTION UTILISATEUR').toBe(true);
    expect(e.analysis?.title).not.toBe('Titre original');
  });

  it('entrée effacée localement pendant l’envoi de son fichier existant : le fichier n’est pas supprimé de Drive', async () => {
    await b.db.putEntry(textEntry('t1', TODAY, 'intacte'));
    await b.sync.run();
    const t1 = await getEntry(b.db, 't1');
    const fileId = t1.local.driveFileId ?? '';
    expect(b.drive.files.has(fileId)).toBe(true);
    await editLocally(b.db, 't1', { transcript: 'modifiée', updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    b.drive.gate = (op) => (op === 'updateFileContent' ? gate : undefined);
    const p = b.sync.run();
    await vi.waitFor(() => expect(b.drive.calls.updateFileContent).toBe(1));
    await b.db.clearAll(); // « Effacer les données de cet appareil » pendant l'envoi
    release();
    await p;

    expect((await b.db.getKv<string[]>('sync.pendingDeletes')) ?? []).not.toContain(fileId);
    expect(b.drive.files.has(fileId)).toBe(true);
  });

  it('entrée supprimée pendant la CRÉATION de son fichier : le nouveau fichier est mis en attente de suppression', async () => {
    await b.db.putEntry(textEntry('t2', TODAY, 'nouvelle', { local: { dirty: true, needsAnalysis: false, hasLocalAudio: false, attempts: 0 } }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    b.drive.gate = (op) => (op === 'createAppDataFile' ? gate : undefined);
    const p = b.sync.run();
    await vi.waitFor(() => expect(b.drive.calls.createAppDataFile).toBe(1));
    await b.db.deleteEntry('t2');
    release();
    await p;
    // supprimé dans la foulée (synthèse/ménage ne relancent pas les suppressions) ou en attente
    const created = b.drive.byName('entry-t2.json');
    const pending = (await b.db.getKv<string[]>('sync.pendingDeletes')) ?? [];
    expect(created === undefined || pending.includes(created.meta.id)).toBe(true);
    await b.sync.run();
    expect(b.drive.byName('entry-t2.json')).toBeUndefined();
  });

  it('jeton absent → needsAuth, aucune opération distante', async () => {
    b.auth.token = null;
    await b.db.putEntry(textEntry('t1', TODAY, 'hors connexion'));
    await b.sync.run();
    expect(b.sync.getStatus().needsAuth).toBe(true);
    expect(b.drive.calls).toEqual({});
    // l'analyse ne dépend pas de Google
    expect((await getEntry(b.db, 't1')).analysis).toBeDefined();
    expect(b.sync.getStatus().lastSyncAt).toBeUndefined();
  });

  it('erreur d’authentification → markExpired, needsAuth, arrêt des étapes distantes', async () => {
    b.drive.fail = (op) => (op === 'listAppData' ? new AppError('auth', 'Session Google expirée.') : undefined);
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    await b.sync.run();
    expect(b.auth.markExpired).toHaveBeenCalled();
    expect(b.sync.getStatus()).toMatchObject({ needsAuth: true, running: false });
    expect(b.drive.calls.createAppDataFile).toBeUndefined();
    expect(b.sync.getStatus().lastSyncAt).toBeUndefined();
  });

  it('erreur réseau → arrêt, lastError', async () => {
    b.drive.fail = (op) => (op === 'createAppDataFile' ? new AppError('network', 'Connexion impossible.') : undefined);
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    await b.db.putEntry(textEntry('t2', TODAY, 'y'));
    await b.sync.run();
    expect(b.drive.calls.createAppDataFile).toBe(1);
    expect(b.sync.getStatus()).toMatchObject({ lastErrorKind: 'network', needsAuth: false });
    expect(b.sync.getStatus().pendingCount).toBe(2);
    expect(b.drive.calls.upsertTextFile).toBeUndefined();
  });

  it('hors ligne → rien n’est tenté', async () => {
    b.online.value = false;
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    await b.sync.run();
    expect(b.ai.textCalls).toEqual([]);
    expect(b.drive.calls).toEqual({});
    expect(b.sync.getStatus().pendingCount).toBe(1);
  });

  it('clé Gemini absente → needsKey, pas d’analyse mais envoi quand même', async () => {
    b = await bench({ geminiApiKey: '' });
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    await b.sync.run();
    expect(b.createAi).not.toHaveBeenCalled();
    expect(b.sync.getStatus()).toMatchObject({ needsKey: true, lastError: undefined });
    const e = await getEntry(b.db, 't1');
    expect(e.local).toMatchObject({ needsAnalysis: true, dirty: false, attempts: 0 });
  });

  it('clé refusée → needsKey, pas de nouvel essai avec la même clé', async () => {
    b.ai.fail = () => new AppError('invalid-key', 'Clé Gemini refusée.', { retryable: false });
    await b.db.putEntry(textEntry('t1', TODAY, 'x'));
    await b.db.putEntry(textEntry('t2', new Date(TODAY.getTime() - HOUR), 'y'));
    await b.sync.run();
    expect(b.ai.textCalls).toHaveLength(1);
    expect(b.sync.getStatus().needsKey).toBe(true);
    expect((await getEntry(b.db, 't1')).local).toMatchObject({ errorKind: 'invalid-key', attempts: 0 });

    await b.sync.run();
    expect(b.ai.textCalls).toHaveLength(1);

    b.ai.fail = null;
    await saveSettings(b.db, { geminiApiKey: 'NOUVELLE' });
    await b.sync.run();
    expect(b.ai.textCalls).toHaveLength(3);
    expect(b.sync.getStatus().needsKey).toBe(false);
  });

  describe('synthèses', () => {
    async function seedTwoDays(): Promise<void> {
      await b.db.putEntry(textEntry('y1', YESTERDAY_EVENING, 'hier soir'));
      await b.db.putEntry(textEntry('y2', new Date(2026, 9, 7, 8, 0), 'hier matin'));
      await b.db.putEntry(textEntry('d1', TODAY, 'aujourd’hui'));
    }

    it('jours passés seulement, puis jours demandés ; régénération si les entrées changent', async () => {
      await seedTwoDays();
      await b.sync.run();
      expect(b.ai.synthCalls).toEqual([{ day: '2026-10-07', ids: ['y2', 'y1'] }]);
      const s = await b.db.getSynthesis('2026-10-07');
      const analyzed = [await getEntry(b.db, 'y1'), await getEntry(b.db, 'y2')];
      expect(s).toMatchObject({ day: '2026-10-07', model: DEFAULT_SETTINGS.synthesisModel, basedOn: entriesSignature(analyzed), summary: 'Synthèse du 2026-10-07 (2)' });
      expect(s?.local.dirty).toBe(false);
      const remote = b.drive.json<DaySynthesis & { local?: unknown }>('day-2026-10-07.json');
      expect(remote.summary).toBe('Synthèse du 2026-10-07 (2)');
      expect(remote.local).toBeUndefined();
      expect(b.drive.byName('day-2026-10-07.json')?.meta.appProperties).toEqual({ kind: 'synthesis', day: '2026-10-07' });

      // rien de nouveau → pas de régénération
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(1);

      // demande manuelle pour aujourd'hui
      await b.db.setKv('sync.forceSynthesisDays', ['2026-10-08']);
      await b.sync.run();
      expect(b.ai.synthCalls.map((c) => c.day)).toEqual(['2026-10-07', '2026-10-08']);
      expect(await b.db.getKv('sync.forceSynthesisDays')).toEqual([]);
      expect(await b.db.getSynthesis('2026-10-08')).toBeDefined();

      // correction d'une entrée d'hier → ré-analyse → nouvelle signature → régénération
      b.clock.t += HOUR;
      await editLocally(b.db, 'y1', { transcript: 'hier soir corrigé', transcriptEdited: true, updatedAt: new Date(b.clock.t).toISOString() }, true);
      await b.sync.run();
      expect(b.ai.synthCalls.map((c) => c.day)).toEqual(['2026-10-07', '2026-10-08', '2026-10-07']);
      expect((await b.db.getSynthesis('2026-10-07'))?.basedOn).not.toBe(s?.basedOn);
      // aujourd'hui (non demandé) n'est pas régénéré automatiquement
      await editLocally(b.db, 'd1', { transcript: 'changé', updatedAt: new Date(b.clock.t).toISOString() });
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(3);
    });

    it('pas de synthèse tant qu’une entrée du jour attend une analyse retentable', async () => {
      b.ai.fail = (op, arg) => (op === 'text' && arg === 'hier matin' ? new AppError('bad-response', 'Réponse illisible.', { retryable: true }) : undefined);
      await seedTwoDays();
      await b.sync.run();
      expect(b.ai.synthCalls).toEqual([]);
      // erreur définitive (safety) → la synthèse se fait avec les entrées analysées
      b.ai.fail = (op, arg) => (op === 'text' && arg === 'hier matin' ? new AppError('safety', 'Bloqué.', { retryable: false }) : undefined);
      b.clock.t += HOUR;
      await b.sync.run();
      expect(b.ai.synthCalls).toEqual([{ day: '2026-10-07', ids: ['y1'] }]);
    });

    it('jour sans entrée → synthèse supprimée (locale, Drive et miroir)', async () => {
      await seedTwoDays();
      await b.sync.run();
      expect(b.drive.byName('day-2026-10-07.json')).toBeDefined();
      expect(b.drive.mirrorFile('2026-10-07')).toBeDefined();

      // l'utilisateur supprime les deux entrées d'hier (comme le contrôleur)
      const ids: string[] = [];
      for (const id of ['y1', 'y2']) {
        const e = await getEntry(b.db, id);
        await b.db.deleteEntry(id);
        if (e.local.driveFileId) ids.push(e.local.driveFileId);
      }
      await b.db.setKv('sync.pendingDeletes', ids);
      await b.sync.run();

      expect(await b.db.getSynthesis('2026-10-07')).toBeUndefined();
      expect(b.drive.byName('day-2026-10-07.json')).toBeUndefined();
      expect(b.drive.byName('entry-y1.json')).toBeUndefined();
      expect(b.drive.mirrorFile('2026-10-07')).toBeUndefined();
      expect(b.drive.mirrorFile('2026-10-08')).toBeDefined();
      expect(await b.db.getKv('sync.pendingDeletes')).toEqual([]);
    });

    it('entrées inaudibles seulement → pas d’appel de synthèse, pas d’erreur ; synthèse périmée supprimée', async () => {
      const inaudible = (id: string, at: Date): LocalEntry =>
        voiceEntry(id, at, {
          transcript: '',
          analysis: { ...analysisFor(''), title: 'Enregistrement inaudible' },
          local: { dirty: true, needsAnalysis: false, hasLocalAudio: true, attempts: 0 },
        });
      await addVoice(b.db, inaudible('v1', YESTERDAY_EVENING));
      await b.db.putEntry(textEntry('y1', new Date(2026, 9, 7, 8, 0), 'hier matin'));
      await b.sync.run();
      // seule l'entrée avec du texte est envoyée à la synthèse
      expect(b.ai.synthCalls).toEqual([{ day: '2026-10-07', ids: ['y1'] }]);
      expect(b.drive.byName('day-2026-10-07.json')).toBeDefined();

      // l'utilisateur supprime l'entrée texte : il ne reste qu'un enregistrement inaudible
      const y1 = await getEntry(b.db, 'y1');
      await b.db.deleteEntry('y1');
      await b.db.setKv('sync.pendingDeletes', [y1.local.driveFileId]);
      await b.db.setKv('sync.forceSynthesisDays', ['2026-10-07']);
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(1);
      expect(await b.db.getSynthesis('2026-10-07')).toBeUndefined();
      expect(b.drive.byName('day-2026-10-07.json')).toBeUndefined();
      expect(await b.db.getKv('sync.forceSynthesisDays')).toEqual([]);
      expect(b.sync.getStatus().lastError).toBeUndefined();
      // le fichier miroir du jour reste (l'entrée inaudible existe toujours)
      expect(b.drive.mirrorFile('2026-10-07')).toBeDefined();
    });

    it('synthèse : un quota répété n’épuise pas les essais automatiques', async () => {
      b.ai.fail = (op) => (op === 'synth' ? new AppError('quota', 'Quota.', { retryAfterMs: 60_000 }) : undefined);
      await seedTwoDays();
      for (let i = 0; i < 7; i++) {
        await b.sync.run();
        b.clock.t += 2 * 60_000;
      }
      expect(b.ai.synthCalls).toHaveLength(7);
      b.ai.fail = null;
      await b.sync.run();
      expect(await b.db.getSynthesis('2026-10-07')).toBeDefined();
    });

    it('erreur de synthèse : notée, pas de nouvel essai immédiat', async () => {
      b.ai.fail = (op) => (op === 'synth' ? new AppError('bad-response', 'Réponse illisible.', { retryable: true }) : undefined);
      await seedTwoDays();
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(1);
      expect(b.sync.getStatus().lastErrorKind).toBe('bad-response');
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(1);
      b.ai.fail = null;
      b.clock.t += HOUR;
      await b.sync.run();
      expect(b.ai.synthCalls).toHaveLength(2);
      expect(await b.db.getSynthesis('2026-10-07')).toBeDefined();
    });
  });

  it('ménage : audio au-delà de la rétention supprimé, une fois par jour', async () => {
    const old = new Date(2025, 8, 1, 9, 0);
    const audio = b.drive.seedAppData('audio-o1.webm', new Blob(['vieux']), { kind: 'audio', day: dayKey(old), entryId: 'o1' }, old.toISOString());
    const entry: LocalEntry = voiceEntry('o1', old, {
      audioFileId: audio.id,
      transcript: 'il y a longtemps',
      analysis: analysisFor('il y a longtemps'),
      local: { dirty: false, needsAnalysis: false, hasLocalAudio: false, attempts: 0 },
    });
    const meta = b.drive.seedAppData('entry-o1.json', JSON.stringify({ ...entry, local: undefined }), { kind: 'entry', day: entry.day, entryId: 'o1' });
    await b.db.putEntry({ ...entry, local: { ...entry.local, driveFileId: meta.id, remoteModifiedTime: meta.modifiedTime } });
    // synthèse existante pour ne pas en générer une
    const recent = b.drive.seedAppData('audio-o2.webm', new Blob(['récent']), { kind: 'audio', day: '2026-10-01', entryId: 'o2' }, new Date(2026, 9, 1).toISOString());

    await b.sync.run();
    expect(b.drive.files.has(audio.id)).toBe(false);
    expect(b.drive.files.has(recent.id)).toBe(true);
    const e = await getEntry(b.db, 'o1');
    expect(e).toMatchObject({ audioFileId: null, audioExpired: true, updatedAt: entry.updatedAt });
    expect(e.local.dirty).toBe(false);
    expect(b.drive.json<Entry>('entry-o1.json')).toMatchObject({ audioFileId: null, audioExpired: true });
    expect(await b.db.getKv('sync.lastHousekeeping')).toBe('2026-10-08');

    // un autre fichier expiré apparaît : pas de nouveau ménage le même jour
    const old2 = b.drive.seedAppData('audio-o3.webm', new Blob(['x']), { kind: 'audio', day: dayKey(old), entryId: 'o3' }, old.toISOString());
    await b.sync.run();
    expect(b.drive.files.has(old2.id)).toBe(true);
    b.clock.t += DAY;
    await b.sync.run();
    expect(b.drive.files.has(old2.id)).toBe(false);
    expect(await b.db.getKv('sync.lastHousekeeping')).toBe('2026-10-09');
  });

  it('ménage : l’audio d’une entrée jamais transcrite est gardé (seule copie de son contenu)', async () => {
    b = await bench({ geminiApiKey: 'CLE', audioRetentionDays: 7 });
    b.ai.fail = (op) => (op === 'audio' ? new AppError('safety', 'Bloqué par les filtres.', { retryable: false }) : undefined);
    await addVoice(b.db, voiceEntry('s1', TODAY), 'secret');
    await b.sync.run();
    let e = await getEntry(b.db, 's1');
    const audioId = e.audioFileId ?? '';
    expect(audioId).toBeTruthy();
    expect(e.local).toMatchObject({ needsAnalysis: true, hasLocalAudio: true, errorKind: 'safety' });

    // 8 jours plus tard (rétention 7 jours) : toujours pas transcrite → audio gardé partout
    b.clock.t += 8 * DAY;
    await b.sync.run();
    e = await getEntry(b.db, 's1');
    expect(e.audioExpired).toBeFalsy();
    expect(e.audioFileId).toBe(audioId);
    expect(b.drive.files.has(audioId)).toBe(true);
    expect(await b.db.getAudio('s1')).toBeDefined();

    // Pas de clé non plus : même règle (entrée en attente d'analyse)
    await addVoice(b.db, voiceEntry('k1', new Date(b.clock.t)), 'sans clé');
    await saveSettings(b.db, { geminiApiKey: '' });
    await b.sync.run();
    b.clock.t += 8 * DAY;
    await b.sync.run();
    expect((await getEntry(b.db, 'k1')).audioExpired).toBeFalsy();
    expect(await b.db.getAudio('k1')).toBeDefined();

    // Une fois transcrite (nouvel essai manuel), l'audio expire normalement au ménage suivant
    await saveSettings(b.db, { geminiApiKey: 'CLE' });
    b.ai.fail = null;
    await b.sync.run({ force: true });
    b.clock.t += DAY;
    await b.sync.run();
    e = await getEntry(b.db, 's1');
    expect(e).toMatchObject({ audioFileId: null, audioExpired: true, transcript: 'Transcription de secret' });
    expect(b.drive.files.has(audioId)).toBe(false);
  });

  it('ménage : audio d’une entrée inconnue ici → gardé tant que le pull est incomplet, supprimé si orphelin', async () => {
    const old = new Date(2025, 8, 1, 9, 0);
    const orphan = b.drive.seedAppData('audio-z1.webm', new Blob(['x']), { kind: 'audio', day: dayKey(old), entryId: 'z1' }, old.toISOString());
    // Entrée présente dans Drive mais illisible : on ne sait pas si elle est transcrite.
    const broken = b.drive.seedAppData('entry-z2.json', 'pas du JSON', { kind: 'entry', day: dayKey(old), entryId: 'z2' });
    const z2Audio = b.drive.seedAppData('audio-z2.webm', new Blob(['y']), { kind: 'audio', day: dayKey(old), entryId: 'z2' }, old.toISOString());
    await b.sync.run();
    expect(b.drive.files.has(orphan.id)).toBe(true);
    expect(b.drive.files.has(z2Audio.id)).toBe(true);
    expect(await b.db.getKv('sync.lastHousekeeping')).toBeUndefined(); // ménage à refaire

    b.drive.remove(broken.id);
    await b.sync.run();
    expect(b.drive.files.has(orphan.id)).toBe(false);
    expect(b.drive.files.has(z2Audio.id)).toBe(false);
  });

  describe('miroir Markdown', () => {
    it('crée le fichier du jour, ne renvoie pas un jour inchangé', async () => {
      await b.db.putEntry(textEntry('t1', TODAY, 'miroir'));
      await b.sync.run();
      const file = b.drive.mirrorFile('2026-10-08');
      expect(file).toBeDefined();
      expect(file?.content).toContain('- t1 ');
      expect(b.drive.calls.upsertTextFile).toBe(1);
      const state = await b.db.getKv<{ rootId?: string; yearIds: Record<string, string>; days: Record<string, { fileId: string; sig: string }> }>('mirror.state');
      expect(state?.days['2026-10-08']?.fileId).toBe(file?.meta.id);
      expect(state?.rootId).toBeDefined();
      expect(state?.yearIds['2026']).toBeDefined();

      await b.sync.run();
      expect(b.drive.calls.upsertTextFile).toBe(1);
      expect(b.drive.calls.ensureFolder).toBe(2);

      await editLocally(b.db, 't1', { updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() });
      await b.sync.run();
      expect(b.drive.calls.upsertTextFile).toBe(2);
      expect(b.drive.calls.ensureFolder).toBe(2); // dossiers en cache
    });

    it('dossier en cache supprimé (404) → cache vidé, nouvel essai', async () => {
      await b.db.putEntry(textEntry('t1', TODAY, 'miroir'));
      await b.db.putEntry(textEntry('y1', YESTERDAY_EVENING, 'hier'));
      await b.sync.run();
      const root = b.drive.byName('Dit Harry', 'root');
      expect(root).toBeDefined();
      b.drive.remove(root?.meta.id ?? '');

      await editLocally(b.db, 't1', { updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() });
      await b.sync.run();
      expect(b.sync.getStatus().lastError).toBeUndefined();
      expect(b.drive.mirrorFile('2026-10-08')).toBeDefined();
      // tous les jours sont réécrits dans le nouveau dossier
      expect(b.drive.mirrorFile('2026-10-07')).toBeDefined();
    });

    it('désactivé → aucun appel', async () => {
      b = await bench({ geminiApiKey: 'CLE', mirrorEnabled: false });
      await b.db.putEntry(textEntry('t1', TODAY, 'x'));
      await b.sync.run();
      expect(b.drive.calls.ensureFolder).toBeUndefined();
      expect(b.drive.calls.upsertTextFile).toBeUndefined();
    });
  });

  describe('réglages', () => {
    it('réglages distants plus récents : fusionnés, clé reçue → analyse dans la foulée', async () => {
      b = await bench({ geminiApiKey: '' });
      b.drive.seedAppData(
        'settings.json',
        JSON.stringify({ ...DEFAULT_SETTINGS, geminiApiKey: 'DISTANTE', mirrorEnabled: false, updatedAt: '2026-10-01T10:00:00.000Z' }),
        { kind: 'settings' },
      );
      await b.db.putEntry(textEntry('t1', TODAY, 'x'));
      await b.sync.run();
      const s = await loadSettings(b.db);
      expect(s).toMatchObject({ geminiApiKey: 'DISTANTE', mirrorEnabled: false });
      expect(await b.db.getKv('sync.settingsDirty')).toBe(false);
      expect((await getEntry(b.db, 't1')).analysis).toBeDefined();
      expect(b.sync.getStatus().needsKey).toBe(false);
      expect(b.drive.calls.upsertTextFile).toBeUndefined();
    });

    it('réglages modifiés localement → envoyés', async () => {
      const saved = await saveSettings(b.db, { audioRetentionDays: 30 });
      await b.sync.run();
      expect(b.drive.json<Settings>('settings.json')).toEqual(saved);
      expect(await b.db.getKv('sync.settingsDirty')).toBe(false);
      const id = await b.db.getKv<string>('sync.settingsFileId');
      expect(id).toBe(b.drive.byName('settings.json')?.meta.id);

      await saveSettings(b.db, { audioRetentionDays: 60 });
      await b.sync.run();
      expect(b.drive.json<Settings>('settings.json').audioRetentionDays).toBe(60);
      expect([...b.drive.files.values()].filter((f) => f.meta.name === 'settings.json')).toHaveLength(1);
    });
  });

  it('une seule exécution à la fois, une seule ré-exécution programmée', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    b.drive.gate = (op) => (op === 'listAppData' && b.drive.calls.listAppData === 1 ? gate : undefined);
    const statuses: boolean[] = [];
    b.sync.subscribe((s) => statuses.push(s.running));

    const p1 = b.sync.run();
    const p2 = b.sync.run();
    const p3 = b.sync.run({ force: true });
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(b.sync.getStatus().running).toBe(true);
    release();
    await p1;
    expect(b.drive.calls.listAppData).toBe(2);
    expect(b.sync.getStatus().running).toBe(false);
    expect(statuses[0]).toBe(false); // appel immédiat à l'abonnement
    expect(statuses.at(-1)).toBe(false);

    // nouvel appel après la fin → nouveau cycle
    await b.sync.run();
    expect(b.drive.calls.listAppData).toBe(3);
  });

  it('un abonné qui relance run() pendant la notification ne crée pas de cycle concurrent', async () => {
    const inner: Promise<void>[] = [];
    b.sync.subscribe((s) => {
      if (s.running && inner.length === 0) inner.push(b.sync.run());
    });
    const p = b.sync.run();
    expect(inner[0]).toBe(p);
    await p;
    expect(b.drive.calls.listAppData).toBe(2);
  });

  it('entrée supprimée localement : suppression distante en attente, pas de résurrection', async () => {
    await addVoice(b.db, voiceEntry('v1', TODAY));
    await b.sync.run();
    const e = await getEntry(b.db, 'v1');
    await b.db.deleteEntry('v1');
    await b.db.setKv('sync.pendingDeletes', [e.local.driveFileId, e.audioFileId]);
    // la suppression distante échoue une première fois (élément) → elle reste en attente
    b.drive.fail = (op) => (op === 'deleteFile' ? new AppError('other', 'Refusé.', { status: 403 }) : undefined);
    await b.sync.run();
    expect(await b.db.getEntry('v1')).toBeUndefined();
    expect(await b.db.getKv('sync.pendingDeletes')).toHaveLength(2);
    b.drive.fail = null;
    await b.sync.run();
    expect(await b.db.getKv('sync.pendingDeletes')).toEqual([]);
    expect(b.drive.byName('entry-v1.json')).toBeUndefined();
    expect(b.drive.byName('audio-v1.webm')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Compte Google propriétaire des données de l'appareil                */
/* ------------------------------------------------------------------ */

describe('createSyncEngine — compte Google', () => {
  class AccountDrive extends FakeDrive {
    constructor(
      clock: () => Date,
      readonly email: string,
    ) {
      super(clock);
    }

    override async about() {
      await super.about();
      return { email: this.email, name: this.email };
    }
  }

  /** Client Drive qui, comme le vrai, agit sur le compte du jeton courant. */
  function routedDrive(drives: Record<string, FakeDrive>, token: () => string | null): DriveClient {
    const pick = (): FakeDrive => {
      const t = token();
      const d = t ? drives[t] : undefined;
      if (!d) throw new AppError('auth', 'Pas de jeton.');
      return d;
    };
    return {
      about: () => pick().about(),
      listAppData: () => pick().listAppData(),
      downloadJson<T>(id: string) {
        return pick().downloadJson<T>(id);
      },
      downloadBlob: (id) => pick().downloadBlob(id),
      createAppDataFile: (n, body, m, p) => pick().createAppDataFile(n, body, m, p),
      updateFileContent: (id, body, m) => pick().updateFileContent(id, body, m),
      deleteFile: (id) => pick().deleteFile(id),
      ensureFolder: (n, p) => pick().ensureFolder(n, p),
      upsertTextFile: (p, n, c, m, e) => pick().upsertTextFile(p, n, c, m, e),
    };
  }

  async function twoAccounts() {
    const db = createLocalDb(`test-sync-compte-${crypto.randomUUID()}`);
    await db.setKv('settings', { ...DEFAULT_SETTINGS, geminiApiKey: 'CLE' });
    const clock = { t: TODAY.getTime() };
    const now = () => new Date(clock.t);
    const driveA = new AccountDrive(now, 'moi@exemple.fr');
    const driveB = new AccountDrive(now, 'travail@exemple.fr');
    const auth = {
      token: 'jeton-A' as string | null,
      getToken: () => auth.token,
      markExpired: vi.fn(() => {
        auth.token = null;
      }),
    };
    const ai = new FakeAi();
    const drive = routedDrive({ 'jeton-A': driveA, 'jeton-B': driveB }, () => auth.token);
    const sync = createSyncEngine({ db, drive, auth, createAi: () => ai, now, isOnline: () => true });
    return { db, driveA, driveB, auth, ai, sync, clock };
  }

  it('appareil vierge : compte adopté ; autre compte → conflit, rien n’est envoyé, tiré ni supprimé', async () => {
    const t = await twoAccounts();
    await t.sync.run();
    expect(await t.db.getKv('device.ownerEmail')).toBe('moi@exemple.fr');
    for (const id of ['a1', 'a2', 'a3']) await t.db.putEntry(textEntry(id, TODAY, `texte ${id}`));
    await t.sync.run();
    expect(t.driveA.byName('entry-a1.json')).toBeDefined();

    // Jeton expiré : a1 supprimée (suppression Drive en attente), a2 corrigée.
    t.auth.token = null;
    const a1 = await getEntry(t.db, 'a1');
    await t.db.deleteEntry('a1');
    await t.db.setKv('sync.pendingDeletes', [a1.local.driveFileId]);
    await editLocally(t.db, 'a2', { transcript: 'deux corrigé', updatedAt: new Date(TODAY.getTime() + HOUR).toISOString() });

    // Reconnexion… avec un autre compte Google.
    t.auth.token = 'jeton-B';
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toEqual({ owner: 'moi@exemple.fr', current: 'travail@exemple.fr' });
    expect(t.driveB.files.size).toBe(0);
    expect(Object.keys(t.driveB.calls)).toEqual(['about']);
    expect((await t.db.listEntries()).map((e) => e.id).sort()).toEqual(['a2', 'a3']);
    expect(await t.db.getKv('sync.pendingDeletes')).toEqual([a1.local.driveFileId]);
    expect((await getEntry(t.db, 'a2')).local.dirty).toBe(true);
    expect(t.auth.markExpired).not.toHaveBeenCalled();

    // Le compte n'est vérifié qu'une fois par jeton.
    await t.sync.run();
    expect(t.driveB.calls.about).toBe(1);
    expect(t.driveB.files.size).toBe(0);

    // Retour au bon compte : la synchro reprend, rien n'a été perdu.
    t.auth.token = 'jeton-A';
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toBeUndefined();
    expect(t.driveA.byName('entry-a1.json')).toBeUndefined();
    expect(t.driveA.json<Entry>('entry-a2.json').transcript).toBe('deux corrigé');
    expect(t.driveA.byName('entry-a3.json')).toBeDefined();
    expect(await t.db.getKv('sync.pendingDeletes')).toEqual([]);
  });

  it('conflit : il disparaît avec le jeton (déconnexion)', async () => {
    const t = await twoAccounts();
    await t.sync.run();
    t.auth.token = 'jeton-B';
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toBeDefined();
    t.auth.token = null;
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toBeUndefined();
  });

  it('données locales sans propriétaire connu → conflit sans propriétaire ; une fois adoptées, synchro normale', async () => {
    const t = await twoAccounts();
    await t.db.putEntry(textEntry('x1', TODAY, 'ancien journal'));
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toEqual({ current: 'moi@exemple.fr' });
    expect(t.driveA.files.size).toBe(0);
    expect(await t.db.getKv('device.ownerEmail')).toBeUndefined();

    await t.db.setKv('device.ownerEmail', 'MOI@exemple.fr'); // « C'est mon journal » (casse ignorée)
    await t.sync.run();
    expect(t.sync.getStatus().accountConflict).toBeUndefined();
    expect(t.driveA.byName('entry-x1.json')).toBeDefined();
  });

  it('jeton remplacé pendant le cycle par celui d’un autre compte : aucun appel Drive avec ce jeton', async () => {
    const t = await twoAccounts();
    await t.sync.run(); // adopte A
    await t.db.putEntry(textEntry('n1', TODAY, 'nouvelle'));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const analyze = t.ai.analyzeText.bind(t.ai);
    t.ai.analyzeText = async (text: string) => {
      started = true;
      await gate;
      return analyze(text);
    };
    const p = t.sync.run();
    await vi.waitFor(() => expect(started).toBe(true));
    t.auth.token = 'jeton-B'; // reconnexion avec un autre compte pendant l'analyse
    release();
    await p;

    expect(t.driveB.files.size).toBe(0);
    expect(Object.keys(t.driveB.calls)).toEqual(['about']);
    expect(t.sync.getStatus().accountConflict).toEqual({ owner: 'moi@exemple.fr', current: 'travail@exemple.fr' });
    expect(t.auth.markExpired).not.toHaveBeenCalled();
    const n1 = await getEntry(t.db, 'n1');
    expect(n1.analysis).toBeDefined();
    expect(n1.local.dirty).toBe(true);
  });

  it('Drive n’indique pas le compte → synchro distante suspendue (rien n’est supposé)', async () => {
    const t = await twoAccounts();
    vi.spyOn(t.driveA, 'about').mockResolvedValue({ email: '', name: '' });
    await t.db.putEntry(textEntry('e1', TODAY, 'texte'));
    await t.sync.run();
    expect(t.driveA.files.size).toBe(0);
    expect(t.sync.getStatus().lastError).toMatch(/n'a pas indiqué ton compte/);
    expect(await t.db.getKv('device.ownerEmail')).toBeUndefined();
  });
});
