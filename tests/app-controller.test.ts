import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDb } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import { AppController } from '../src/lib/app.svelte';
import type {
  AuthService,
  AuthState,
  DriveClient,
  LocalDb,
  LocalEntry,
  RecorderCallbacks,
  RecordingResult,
  Services,
  SyncEngine,
  SyncStatus,
  VoiceRecorder,
} from '../src/lib/types';

/* ------------------------------------------------------------------ */
/* Environnement navigateur minimal (le contrôleur lit location, window…) */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  const win = Object.assign(new EventTarget(), { scrollTo: () => undefined });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('history', { back: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Faux services                                                       */
/* ------------------------------------------------------------------ */

let dbSeq = 0;

function fakeAuth(initial: AuthState = { status: 'signed-in', email: 'moi@exemple.fr' }) {
  let state = initial;
  const subs = new Set<(s: AuthState) => void>();
  const calls: string[] = [];
  const auth: AuthService = {
    init: async () => undefined,
    getState: () => state,
    subscribe(cb) {
      subs.add(cb);
      cb(state);
      return () => subs.delete(cb);
    },
    signIn() {
      calls.push('signIn');
      return Promise.resolve();
    },
    getToken: () => 'jeton',
    markExpired: () => undefined,
    signOut: async () => {
      state = { status: 'signed-out' };
      for (const cb of subs) cb(state);
    },
  };
  return { auth, calls };
}

function fakeSync() {
  const runs: ({ force?: boolean } | undefined)[] = [];
  const status: SyncStatus = { running: false, phase: 'idle', pendingCount: 0, needsAuth: false, needsKey: false };
  const sync: SyncEngine = {
    run: async (opts) => {
      runs.push(opts);
    },
    getStatus: () => status,
    subscribe(cb) {
      cb(status);
      return () => undefined;
    },
    onDataChanged: () => () => undefined,
  };
  return { sync, runs, status };
}

/** Enregistreur simulé : l'appelant fournit le résultat de stop(). */
function fakeRecorder(db: LocalDb, result: RecordingResult) {
  let cbs: RecorderCallbacks = {};
  const rec: VoiceRecorder & { cbs: () => RecorderCallbacks } = {
    status: 'idle',
    async start(cb) {
      cbs = cb ?? {};
      await db.putChunk({
        recordingId: result.recordingId,
        index: 0,
        blob: result.blob,
        mimeType: result.mimeType,
        startedAt: result.startedAt,
      });
    },
    stop: async () => result,
    cancel: async () => {
      await db.deleteChunks(result.recordingId);
    },
    cbs: () => cbs,
  };
  return rec;
}

function makeServices(opts: { checkKey?: () => Promise<void>; recorder?: (db: LocalDb) => VoiceRecorder } = {}) {
  const db = createLocalDb(`ctrl-test-${++dbSeq}-${Date.now()}`);
  const { auth, calls } = fakeAuth();
  const { sync, runs, status: syncStatus } = fakeSync();
  const drive = {
    downloadBlob: async () => new Blob(['distant'], { type: 'audio/webm' }),
  } as unknown as DriveClient;
  const services: Services = {
    db,
    auth,
    drive,
    sync,
    createAi: () => ({
      analyzeAudio: () => Promise.reject(new Error('non utilisé')),
      analyzeText: () => Promise.reject(new Error('non utilisé')),
      synthesizeDay: () => Promise.reject(new Error('non utilisé')),
      checkKey: opts.checkKey ?? (async () => undefined),
    }),
    createRecorder: () => (opts.recorder ? opts.recorder(db) : fakeRecorder(db, voiceResult('rec-x'))),
  };
  return { services, db, runs, authCalls: calls, syncStatus };
}

function voiceResult(recordingId: string): RecordingResult {
  return {
    recordingId,
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationSec: 12.4,
    startedAt: '2026-10-08T07:30:00.000Z',
    interrupted: false,
  };
}

function textEntry(id: string, local: Partial<LocalEntry['local']> = {}): LocalEntry {
  return {
    id,
    day: '2026-10-08',
    createdAt: '2026-10-08T08:00:00.000Z',
    updatedAt: '2026-10-08T08:00:00.000Z',
    source: 'text',
    transcript: 'Texte',
    local: { dirty: false, needsAnalysis: false, hasLocalAudio: false, attempts: 0, ...local },
  };
}

/* ------------------------------------------------------------------ */

describe('AppController', () => {
  it('démarrage : récupère les enregistrements interrompus puis synchronise', async () => {
    const { services, db, runs } = makeServices();
    const r = voiceResult('rec-1');
    await db.putChunk({ recordingId: 'rec-1', index: 1, blob: new Blob(['b']), mimeType: 'audio/webm;codecs=opus', startedAt: r.startedAt });
    await db.putChunk({ recordingId: 'rec-1', index: 0, blob: new Blob(['a']), mimeType: 'audio/webm;codecs=opus', startedAt: r.startedAt });

    const app = new AppController(services);
    await app.start();

    expect(app.ready).toBe(true);
    const e = await db.getEntry('rec-1');
    expect(e?.source).toBe('voice');
    expect(e?.audioMime).toBe('audio/webm');
    expect(e?.createdAt).toBe(r.startedAt);
    expect(e?.local).toMatchObject({ dirty: true, needsAnalysis: true, hasLocalAudio: true, attempts: 0 });
    const audio = await db.getAudio('rec-1');
    expect(await audio?.text()).toBe('ab');
    expect(await db.listRecordingIds()).toEqual([]);
    expect(app.entries.map((x) => x.id)).toEqual(['rec-1']);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    app.destroy();
  });

  it('enregistrement : stop → entrée voix, audio local, morceaux supprimés, synchro', async () => {
    const result = voiceResult('rec-2');
    const { services, db, runs } = makeServices({ recorder: (d) => fakeRecorder(d, result) });
    const app = new AppController(services);
    await app.start();
    const before = runs.length;

    await app.startRecording();
    expect(app.recording.status).toBe('recording');
    expect(await db.listRecordingIds()).toEqual(['rec-2']);
    await app.stopRecording();

    expect(app.recording.status).toBe('idle');
    const e = await db.getEntry('rec-2');
    expect(e?.durationSec).toBe(12);
    expect(e?.day).toBe('2026-10-08');
    expect(e?.audioFileId).toBeNull();
    expect(await db.getAudio('rec-2')).toBeDefined();
    expect(await db.listRecordingIds()).toEqual([]);
    expect(runs.length).toBeGreaterThan(before);
    app.destroy();
  });

  it('arrêt automatique : un seul enregistrement même si stop() arrive aussi', async () => {
    const result = { ...voiceResult('rec-3'), interrupted: true };
    let rec: ReturnType<typeof fakeRecorder> | undefined;
    const { services, db } = makeServices({
      recorder: (d) => (rec = fakeRecorder(d, result)),
    });
    const app = new AppController(services);
    await app.start();
    await app.startRecording();
    rec?.cbs().onAutoStop?.(result);
    await app.stopRecording(); // ignoré : déjà traité
    await vi.waitFor(async () => expect(await db.getEntry('rec-3')).toBeDefined());
    expect((await db.listEntries()).length).toBe(1);
    app.destroy();
  });

  it('entrée texte, correction, réessai', async () => {
    const { services, db, runs } = makeServices();
    const app = new AppController(services);
    await app.start();

    expect(await app.addTextEntry('   ')).toBe(false);
    app.textDraft = 'Une belle journée';
    expect(await app.addTextEntry(app.textDraft)).toBe(true);
    expect(app.textDraft).toBe('');
    const [e] = await db.listEntries();
    expect(e).toMatchObject({ source: 'text', transcript: 'Une belle journée' });
    expect(e?.local).toMatchObject({ dirty: true, needsAnalysis: true, hasLocalAudio: false });

    await db.putEntry({ ...e!, local: { ...e!.local, needsAnalysis: false, dirty: false, error: 'x', attempts: 3 } });
    expect(await app.updateTranscript(e!.id, 'Une très belle journée')).toBe(true);
    const corrected = await db.getEntry(e!.id);
    expect(corrected?.transcriptEdited).toBe(true);
    expect(corrected?.local).toMatchObject({ dirty: true, needsAnalysis: true, attempts: 0 });
    expect(corrected?.local.error).toBeUndefined();
    expect(corrected!.updatedAt >= e!.updatedAt).toBe(true);

    await db.putEntry({ ...corrected!, local: { ...corrected!.local, attempts: 6, retryAfter: '2099-01-01T00:00:00.000Z', error: 'Bloqué' } });
    await app.retryEntry(e!.id);
    const retried = await db.getEntry(e!.id);
    expect(retried?.local).toMatchObject({ attempts: 0, needsAnalysis: true });
    expect(retried?.local.retryAfter).toBeUndefined();
    expect(runs.at(-1)).toEqual({ force: true });
    app.destroy();
  });

  it('suppression : efface en local et programme la suppression Drive', async () => {
    const { services, db } = makeServices();
    await db.setKv('sync.pendingDeletes', ['ancien']);
    await db.putEntry({ ...textEntry('e1', { driveFileId: 'f-json' }), source: 'voice', audioFileId: 'f-audio' });
    await db.putAudio('e1', new Blob(['x']));
    const app = new AppController(services);
    await app.start();

    await app.deleteEntry('e1');
    expect(await db.getEntry('e1')).toBeUndefined();
    expect(await db.getAudio('e1')).toBeUndefined();
    expect(await db.getKv<string[]>('sync.pendingDeletes')).toEqual(['ancien', 'f-json', 'f-audio']);
    expect(app.entries).toEqual([]);
    app.destroy();
  });

  it('synthèse manuelle : ajoute le jour aux jours forcés', async () => {
    const { services, db, runs } = makeServices();
    const app = new AppController(services);
    await app.start();
    const before = runs.length;
    await app.requestSynthesis('2026-10-08');
    expect(await db.getKv<string[]>('sync.forceSynthesisDays')).toEqual(['2026-10-08']);
    expect(runs.length).toBe(before + 1);
    expect(app.synthesisRequested).toEqual([]);
    app.destroy();
  });

  it('synthèse manuelle sans résultat : le toast explique pourquoi', async () => {
    const { services, db, syncStatus } = makeServices();
    const app = new AppController(services);
    await app.start();
    const last = () => app.toasts.at(-1)?.message ?? '';

    syncStatus.needsAuth = true;
    await app.requestSynthesis('2026-10-07');
    expect(last()).toMatch(/reconnecte-toi à Google/);

    syncStatus.needsAuth = false;
    await db.putEntry({ ...textEntry('p1', { needsAnalysis: true }), day: '2026-10-07' });
    await app.reload();
    await app.requestSynthesis('2026-10-07');
    expect(last()).toMatch(/dès que toutes les entrées du jour seront analysées/);

    syncStatus.lastError = 'Quota Gemini atteint, nouvel essai plus tard.';
    await app.requestSynthesis('2026-10-07');
    expect(app.toasts.at(-1)).toMatchObject({ kind: 'error', message: syncStatus.lastError });
    app.destroy();
  });

  it('connexion : auth.signIn() appelé de façon synchrone', () => {
    const { services, authCalls } = makeServices();
    const app = new AppController(services);
    app.signIn();
    expect(authCalls).toEqual(['signIn']);
  });

  it('clé Gemini : refusée → non enregistrée ; acceptée → enregistrée', async () => {
    let valid = false;
    const { services } = makeServices({
      checkKey: async () => {
        if (!valid) throw new AppError('invalid-key', 'Clé refusée', { retryable: false });
      },
    });
    const app = new AppController(services);
    await app.start();

    const bad = await app.checkGeminiKey('mauvaise');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/^Clé Gemini refusée\./);
    expect(app.settings.geminiApiKey).toBe('');

    valid = true;
    const good = await app.checkGeminiKey('  bonne-cle  ');
    expect(good.ok).toBe(true);
    expect(app.settings.geminiApiKey).toBe('bonne-cle');
    expect(app.hasKey).toBe(true);
    app.destroy();
  });

  it('clé Gemini : le message précis de gemini.ts (clé limitée à d’autres sites) est gardé', async () => {
    const referrer = "Clé Gemini refusée depuis ce site : autorise l'adresse de l'appli dans les restrictions de la clé.";
    const { services } = makeServices({
      checkKey: async () => {
        throw new AppError('invalid-key', referrer, { retryable: false, status: 403 });
      },
    });
    const app = new AppController(services);
    await app.start();
    expect(await app.checkGeminiKey('cle')).toEqual({ ok: false, message: referrer });
    app.destroy();
  });

  it('lecture audio : blob local, sinon Drive ; URL mise en cache et révoquée', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    const { services, db } = makeServices();
    const app = new AppController(services);
    const local = { ...textEntry('a'), source: 'voice' as const, audioMime: 'audio/webm' };
    await db.putAudio('a', new Blob(['x']));
    expect(await app.audioUrl(local)).toBe('blob:0');
    expect(await app.audioUrl(local)).toBe('blob:0');
    const remote = { ...textEntry('b'), source: 'voice' as const, audioFileId: 'f-b' };
    expect(await app.audioUrl(remote)).toBe('blob:1');
    expect(await app.audioUrl({ ...textEntry('c'), source: 'voice' })).toBeNull();
    app.releaseAudio('a');
    expect(revoked).toEqual(['blob:0']);
    app.releaseAudio();
    expect(revoked).toEqual(['blob:0', 'blob:1']);
    vi.restoreAllMocks();
  });
});
