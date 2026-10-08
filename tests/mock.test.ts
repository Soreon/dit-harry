import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayLink, Entry, EntryContext } from '../src/lib/types';
import { AppError } from '../src/lib/errors';
import { createMockDriveClient, type MockDriveClient } from '../src/lib/mock/drive';
import { createMockAiClient, mockAnalyzeText, mockDetectMentions, mockSynthesizeDay } from '../src/lib/mock/ai';
import { createMockAuth, MOCK_EMAIL, MOCK_TOKEN, type MockAuthStorage } from '../src/lib/mock/auth';
import { createSilentWav, createSimulatedRecorder } from '../src/lib/mock/recorder';
import { seedDemoDrive } from '../src/lib/mock/seed';
import { createMockServices } from '../src/lib/mock/index';
import { DEFAULT_SETTINGS, saveSettings } from '../src/lib/settings';
import { dayKey } from '../src/lib/util';

let dbCounter = 0;
const uniqueDbName = () => `mock-drive-test-${Date.now()}-${dbCounter++}`;

async function expectAppError(p: Promise<unknown>, kind: AppError['kind'], status?: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).kind).toBe(kind);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
}

/* ------------------------------------------------------------------ */
/* Faux Drive                                                          */
/* ------------------------------------------------------------------ */

describe('mock Drive', () => {
  let drive: MockDriveClient;
  let t = Date.parse('2026-10-08T08:00:00.000Z');

  beforeEach(() => {
    t = Date.parse('2026-10-08T08:00:00.000Z');
    drive = createMockDriveClient({ dbName: uniqueDbName(), now: () => new Date(t) });
  });
  afterEach(() => drive.close());

  it('crée, liste, télécharge et met à jour un fichier appData', async () => {
    const meta = await drive.createAppDataFile('entry-a.json', JSON.stringify({ x: 1 }), 'application/json', {
      kind: 'entry',
      day: '2026-10-08',
      entryId: 'a',
    });
    expect(meta.id).toMatch(/^1[\w-]{32}$/);
    expect(meta.name).toBe('entry-a.json');
    expect(meta.createdTime).toBe('2026-10-08T08:00:00.000Z');
    expect(meta.modifiedTime).toBe(meta.createdTime);
    expect(meta.size).toBe('7');
    expect(meta.appProperties).toEqual({ kind: 'entry', day: '2026-10-08', entryId: 'a' });

    const list = await drive.listAppData();
    expect(list).toEqual([meta]);
    expect(await drive.downloadJson<{ x: number }>(meta.id)).toEqual({ x: 1 });

    t += 5000;
    const updated = await drive.updateFileContent(meta.id, JSON.stringify({ x: 2 }), 'application/json');
    expect(updated.id).toBe(meta.id);
    expect(updated.createdTime).toBe(meta.createdTime);
    expect(updated.modifiedTime).toBe('2026-10-08T08:00:05.000Z');
    expect(updated.appProperties).toEqual(meta.appProperties);
    expect(await drive.downloadJson<{ x: number }>(meta.id)).toEqual({ x: 2 });
  });

  it('modifiedTime strictement croissant même dans la même milliseconde', async () => {
    const a = await drive.createAppDataFile('a.json', '{}', 'application/json', { kind: 'settings' });
    const b = await drive.updateFileContent(a.id, '{"v":1}', 'application/json');
    const c = await drive.updateFileContent(a.id, '{"v":2}', 'application/json');
    expect(b.modifiedTime > a.modifiedTime).toBe(true);
    expect(c.modifiedTime > b.modifiedTime).toBe(true);
  });

  it('stocke les blobs audio avec leur type', async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/webm' });
    const meta = await drive.createAppDataFile('audio-a.webm', audio, 'audio/webm', {
      kind: 'audio',
      day: '2026-10-08',
      entryId: 'a',
    });
    expect(meta.size).toBe('5');
    const back = await drive.downloadBlob(meta.id);
    expect(back.type).toBe('audio/webm');
    expect([...new Uint8Array(await back.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it('404 sur fichier absent, suppression idempotente', async () => {
    const meta = await drive.createAppDataFile('x.json', '{}', 'application/json', { kind: 'settings' });
    await drive.deleteFile(meta.id);
    await expectAppError(drive.downloadJson(meta.id), 'other', 404);
    await expectAppError(drive.downloadBlob(meta.id), 'other', 404);
    await expectAppError(drive.updateFileContent(meta.id, '{}', 'application/json'), 'other', 404);
    await expect(drive.deleteFile(meta.id)).resolves.toBeUndefined();
    expect(await drive.listAppData()).toEqual([]);
  });

  it('listAppData ne montre pas les fichiers visibles', async () => {
    await drive.createAppDataFile('settings.json', '{}', 'application/json', { kind: 'settings' });
    const root = await drive.ensureFolder('Dit Harry');
    await drive.upsertTextFile(root, 'note.md', '# hello', 'text/markdown');
    const list = await drive.listAppData();
    expect(list.map((f) => f.name)).toEqual(['settings.json']);
    // Pas de champs propres au mock dans la réponse publique.
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(
      ['appProperties', 'createdTime', 'id', 'mimeType', 'modifiedTime', 'name', 'size'].sort(),
    );
  });

  it('ensureFolder est idempotent et gère les sous-dossiers', async () => {
    const root = await drive.ensureFolder('Dit Harry');
    expect(await drive.ensureFolder('Dit Harry')).toBe(root);
    const y2026 = await drive.ensureFolder('2026', root);
    const y2025 = await drive.ensureFolder('2025', root);
    expect(y2026).not.toBe(y2025);
    expect(await drive.ensureFolder('2026', root)).toBe(y2026);
    // Même nom, autre parent → autre dossier.
    expect(await drive.ensureFolder('2026')).not.toBe(y2026);

    const all = await drive.listAll();
    const folder = all.find((f) => f.id === y2026);
    expect(folder?.mimeType).toBe('application/vnd.google-apps.folder');
    expect(folder?.parents).toEqual([root]);
    expect(folder?.space).toBe('drive');
    expect(folder?.size).toBeUndefined();
  });

  it('ensureFolder / upsertTextFile : 404 si le parent n’existe plus', async () => {
    const root = await drive.ensureFolder('Dit Harry');
    const year = await drive.ensureFolder('2026', root);
    await drive.deleteFile(root); // emporte aussi le sous-dossier
    expect(await drive.listAll()).toEqual([]);
    await expectAppError(drive.ensureFolder('2026', root), 'other', 404);
    await expectAppError(drive.upsertTextFile(year, '2026-10-08.md', 'x', 'text/markdown'), 'other', 404);
  });

  it('upsertTextFile : création, mise à jour par id, par nom, et id disparu', async () => {
    const root = await drive.ensureFolder('Dit Harry');
    const year = await drive.ensureFolder('2026', root);

    const id1 = await drive.upsertTextFile(year, '2026-10-08.md', 'v1', 'text/markdown');
    expect(await drive.readText(id1)).toBe('v1');

    // Avec l'id connu → même fichier.
    expect(await drive.upsertTextFile(year, '2026-10-08.md', 'v2', 'text/markdown', id1)).toBe(id1);
    expect(await drive.readText(id1)).toBe('v2');

    // Sans id → retrouvé par nom dans le parent.
    expect(await drive.upsertTextFile(year, '2026-10-08.md', 'v3', 'text/markdown')).toBe(id1);
    expect(await drive.readText(id1)).toBe('v3');

    // Id disparu (404) → recréé.
    await drive.deleteFile(id1);
    const id2 = await drive.upsertTextFile(year, '2026-10-08.md', 'v4', 'text/markdown', id1);
    expect(id2).not.toBe(id1);
    expect(await drive.readText(id2)).toBe('v4');

    const files = (await drive.listAll()).filter((f) => f.mimeType === 'text/markdown');
    expect(files).toHaveLength(1);
    expect(files[0]?.parents).toEqual([year]);
  });

  it('exige un jeton quand auth est fourni', async () => {
    let token: string | null = null;
    const guarded = createMockDriveClient({
      dbName: uniqueDbName(),
      auth: { getToken: () => token, markExpired: () => undefined },
    });
    try {
      await expectAppError(guarded.listAppData(), 'auth');
      await expectAppError(guarded.about(), 'auth');
      token = 'mock-token';
      expect(await guarded.about()).toEqual({ email: MOCK_EMAIL, name: 'Démo' });
      expect(await guarded.listAppData()).toEqual([]);
    } finally {
      guarded.close();
    }
  });

  it('persiste entre deux instances (même base IndexedDB)', async () => {
    const name = uniqueDbName();
    const a = createMockDriveClient({ dbName: name });
    const meta = await a.createAppDataFile('settings.json', '{"k":1}', 'application/json', { kind: 'settings' });
    await a.setMeta('seeded', true);
    a.close();
    const b = createMockDriveClient({ dbName: name });
    try {
      expect((await b.listAppData()).map((f) => f.id)).toEqual([meta.id]);
      expect(await b.downloadJson(meta.id)).toEqual({ k: 1 });
      expect(await b.getMeta<boolean>('seeded')).toBe(true);
      await b.reset();
      expect(await b.listAll()).toEqual([]);
      expect(await b.getMeta('seeded')).toBeUndefined();
    } finally {
      b.close();
    }
  });

  it('seedDemoDrive dépose des entrées valides de jours passés', async () => {
    const n = await seedDemoDrive(drive, new Date(2026, 9, 8, 12, 0));
    const files = await drive.listAppData();
    expect(files).toHaveLength(n);
    for (const f of files) {
      expect(f.appProperties?.kind).toBe('entry');
      const e = await drive.downloadJson<Entry & { local?: unknown }>(f.id);
      expect(f.name).toBe(`entry-${e.id}.json`);
      expect(f.appProperties).toEqual({ kind: 'entry', day: e.day, entryId: e.id });
      expect(e.day < '2026-10-08').toBe(true);
      expect(e.source).toBe('text');
      expect(e.analysis?.title).toBeTruthy();
      expect(e.local).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Faux Gemini                                                         */
/* ------------------------------------------------------------------ */

describe('mock Gemini', () => {
  const ctx: EntryContext = { day: '2026-10-08', time: '21:15' };

  it('analyse déterministe', () => {
    const text =
      "Ce soir j'ai dîné chez Marie à Lyon, on a beaucoup ri et j'étais vraiment content. " +
      'Je dois appeler le médecin demain. Le travail était calme.';
    const a = mockAnalyzeText(text);
    expect(mockAnalyzeText(text)).toEqual(a);
    expect(a.title).toBe("Ce soir j'ai dîné chez Marie…");
    expect(mockAnalyzeText('Réveil difficile, la nuit a été courte.').title).toBe('Réveil difficile');
    expect(mockAnalyzeText("Aujourd'hui je suis allé au marché avec la voisine").title).toBe(
      "Aujourd'hui je suis allé au marché…",
    );
    expect(a.title.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(a.summary).toBe("Ce soir j'ai dîné chez Marie à Lyon, on a beaucoup ri et j'étais vraiment content.");
    expect(a.mood.score).toBeGreaterThan(0);
    expect(a.people).toEqual(['Marie']);
    expect(a.places).toEqual(['Lyon']);
    expect(a.todos).toEqual(['appeler le médecin demain']);
    expect(a.themes.length).toBeGreaterThan(0);
    expect(a.themes.length).toBeLessThanOrEqual(5);
    for (const t of a.themes) expect(t).toBe(t.toLowerCase());
    expect(a.themes).toContain('repas');
    expect(a.themes).toContain('travail');
  });

  it('humeur : mots-clés positifs, négatifs, négation', () => {
    expect(mockAnalyzeText('Je suis triste et épuisé, tout est difficile.').mood.score).toBe(-2);
    expect(mockAnalyzeText('Une journée difficile.').mood).toEqual({ score: -1, label: 'pas au top' });
    expect(mockAnalyzeText('Rien de spécial.').mood).toEqual({ score: 0, label: 'neutre' });
    expect(mockAnalyzeText('Super journée, quel bonheur, je suis ravi !').mood.score).toBe(2);
    expect(mockAnalyzeText("Je ne suis pas bien aujourd'hui.").mood.score).toBe(-1);
    expect(mockAnalyzeText('Content mais fatigué.').mood).toEqual({ score: 0, label: 'en demi-teinte' });
  });

  it('texte vide et listes vides', () => {
    const a = mockAnalyzeText('   ');
    expect(a.title).toBe('Entrée sans texte');
    expect(a.summary).toBe('');
    expect(a.themes).toEqual([]);
    expect(a.people).toEqual([]);
    expect(a.places).toEqual([]);
    expect(a.todos).toEqual([]);
  });

  it('« il faut que je » n’est pas une action à l’infinitif', () => {
    expect(mockAnalyzeText('Il faut que je dorme plus. Penser à acheter du pain.').todos).toEqual([
      'acheter du pain',
    ]);
  });

  it('analyzeAudio : transcription factice qui mentionne durée et taille', async () => {
    const ai = createMockAiClient({ latencyMs: 0 });
    const wav = createSilentWav(12);
    const r1 = await ai.analyzeAudio(wav, 'audio/wav', ctx);
    const r2 = await ai.analyzeAudio(wav, 'audio/wav', ctx);
    expect(r1).toEqual(r2);
    expect(r1.transcript).toContain('0:12');
    expect(r1.transcript).toContain('94 Ko');
    expect(r1.transcript).toContain('jeudi 8 octobre 2026');
    expect(r1.transcript).toContain('21:15');
    expect(r1.analysis.title).not.toBe('');
    // La note technique ne pollue pas l'analyse.
    expect(r1.analysis.people).not.toContain('Ko');
  });

  it('analyzeAudio : estimation à 32 kbit/s pour le WebM', async () => {
    const ai = createMockAiClient({ latencyMs: 0 });
    const webm = new Blob([new Uint8Array(4000 * 30)], { type: 'audio/webm' }); // 30 s à 32 kbit/s
    const r = await ai.analyzeAudio(webm, 'audio/webm', ctx);
    expect(r.transcript).toContain('0:30');
  });

  it('analyzeAudio : audio vide → inaudible', async () => {
    const ai = createMockAiClient({ latencyMs: 0 });
    const r = await ai.analyzeAudio(new Blob([]), 'audio/webm', ctx);
    expect(r.transcript).toBe('');
    expect(r.analysis.title).toBe('Enregistrement inaudible');
  });

  it('analyzeAudio : refuse plus de 18 Mo', async () => {
    const ai = createMockAiClient({ latencyMs: 0 });
    const big = new Blob([new Uint8Array(18 * 1024 * 1024 + 1)]);
    await expectAppError(ai.analyzeAudio(big, 'audio/webm', ctx), 'other');
  });

  it('latence simulée (~800 ms par défaut)', async () => {
    vi.useFakeTimers();
    try {
      const ai = createMockAiClient();
      let done = false;
      const p = ai.analyzeText('Bonjour.', ctx).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(700);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('synthèse du jour déterministe', async () => {
    const mk = (id: string, time: string, text: string): Entry => ({
      id,
      day: '2026-10-07',
      createdAt: `2026-10-07T${time}:00.000Z`,
      updatedAt: `2026-10-07T${time}:00.000Z`,
      source: 'text',
      transcript: text,
      analysis: mockAnalyzeText(text),
    });
    const entries = [
      mk('b', '20:00', 'Dîner avec Paul, super soirée. Je dois rappeler Paul.'),
      mk('a', '08:00', 'Réunion difficile au travail. Je dois rappeler Paul.'),
    ];
    const ai = createMockAiClient({ latencyMs: 0 });
    const s1 = await ai.synthesizeDay('2026-10-07', entries);
    const s2 = await ai.synthesizeDay('2026-10-07', [...entries].reverse());
    expect(s1).toEqual(s2);
    expect(s1.summary.startsWith("Ce jour-là, j'ai noté 2 moments.")).toBe(true);
    expect(s1.highlights).toEqual(['Réunion difficile au travail', 'Dîner avec Paul']);
    expect(s1.todos).toEqual(['rappeler Paul']);
    expect(s1.mood.label).toBe('en demi-teinte');
    expect(mockSynthesizeDay([]).highlights).toEqual([]);
  });

  it('checkKey accepte toute clé', async () => {
    await expect(createMockAiClient({ latencyMs: 0 }).checkKey()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Fausse authentification                                             */
/* ------------------------------------------------------------------ */

function memoryStorage(): MockAuthStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('mock auth', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connexion en 300 ms, persistée au rechargement, expiration, déconnexion', async () => {
    const storage = memoryStorage();
    const auth = createMockAuth({ storage });
    expect(auth.getState().status).toBe('loading');
    await auth.init();
    expect(auth.getState().status).toBe('signed-out');
    expect(auth.getToken()).toBeNull();

    const seen: string[] = [];
    const unsubscribe = auth.subscribe((s) => seen.push(s.status));
    const p = auth.signIn();
    expect(auth.getState().status).toBe('signing-in');
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(auth.getState()).toMatchObject({ status: 'signed-in', email: MOCK_EMAIL, name: 'Démo' });
    expect(auth.getToken()).toBe(MOCK_TOKEN);
    expect(seen).toEqual(['signed-out', 'signing-in', 'signed-in']);
    unsubscribe();

    // « Rechargement » : nouvelle instance, même stockage.
    const reloaded = createMockAuth({ storage });
    await reloaded.init();
    expect(reloaded.getToken()).toBe(MOCK_TOKEN);

    reloaded.markExpired();
    expect(reloaded.getState().status).toBe('expired');
    expect(reloaded.getToken()).toBeNull();
    const again = createMockAuth({ storage });
    await again.init();
    expect(again.getState()).toMatchObject({ status: 'expired', email: MOCK_EMAIL });

    await again.signOut();
    expect(again.getState().status).toBe('signed-out');
    expect(storage.data.size).toBe(0);
  });

  it('le jeton expire au bout d’une heure (marge comprise)', async () => {
    const auth = createMockAuth({ storage: memoryStorage(), signInDelayMs: 0 });
    await auth.init();
    const p = auth.signIn();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(auth.getToken()).toBe(MOCK_TOKEN);
    await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
    expect(auth.getToken()).toBeNull();
    expect(auth.getState().status).toBe('expired');
  });
});

/* ------------------------------------------------------------------ */
/* Enregistreur simulé                                                 */
/* ------------------------------------------------------------------ */

describe('enregistreur simulé', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('produit un WAV silencieux de la durée écoulée, niveaux et ticks', async () => {
    const deleted: string[] = [];
    const rec = createSimulatedRecorder({ deleteChunks: async (id) => void deleted.push(id) }, { startDelayMs: 0 });
    const levels: number[] = [];
    const ticks: number[] = [];
    expect(rec.status).toBe('idle');
    await rec.start({ onLevel: (l) => levels.push(l), onTick: (s) => ticks.push(s) });
    expect(rec.status).toBe('recording');
    await expect(rec.start()).rejects.toBeInstanceOf(AppError);

    await vi.advanceTimersByTimeAsync(2500);
    const result = await rec.stop();
    expect(rec.status).toBe('idle');
    expect(ticks).toEqual([1, 2]);
    expect(levels.length).toBeGreaterThanOrEqual(45);
    expect(new Set(levels.map((l) => l.toFixed(2))).size).toBeGreaterThan(5);
    for (const l of levels) expect(l >= 0 && l <= 1).toBe(true);

    expect(result.mimeType).toBe('audio/wav');
    expect(result.interrupted).toBe(false);
    expect(result.durationSec).toBeCloseTo(2.5, 1);
    expect(result.blob.type).toBe('audio/wav');
    expect(result.blob.size).toBe(44 + 2.5 * 8000);
    const head = new Uint8Array(await result.blob.slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...head.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...head.subarray(8, 12))).toBe('WAVE');

    await expect(rec.stop()).rejects.toBeInstanceOf(AppError);
    expect(deleted).toEqual([]);
  });

  it('arrêt automatique à la durée maximale', async () => {
    const rec = createSimulatedRecorder({ deleteChunks: async () => undefined }, { startDelayMs: 0, maxDurationSec: 3 });
    const auto: boolean[] = [];
    await rec.start({ onAutoStop: (r) => auto.push(r.interrupted) });
    await vi.advanceTimersByTimeAsync(3100);
    expect(auto).toEqual([true]);
    expect(rec.status).toBe('idle');
  });

  it('cancel supprime les morceaux de l’enregistrement', async () => {
    const deleted: string[] = [];
    const rec = createSimulatedRecorder({ deleteChunks: async (id) => void deleted.push(id) }, { startDelayMs: 0 });
    await rec.start();
    await vi.advanceTimersByTimeAsync(1000);
    await rec.cancel();
    expect(rec.status).toBe('idle');
    expect(deleted).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Intégration : mode démo complet (vrais db.ts / sync.ts)             */
/* ------------------------------------------------------------------ */

describe('createMockServices', () => {
  it('connexion, pull du jeu d’exemple, synthèses, analyse et copie Markdown', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const s = await createMockServices();
    await s.auth.init();
    expect(s.auth.getState().status).toBe('signed-out');
    await s.auth.signIn();
    expect(s.auth.getToken()).toBe(MOCK_TOKEN);

    // Sans clé Gemini : les entrées d'exemple sont tirées du Drive, rien n'est analysé.
    await s.sync.run();
    expect(s.sync.getStatus().needsKey).toBe(true);
    const seeded = await s.db.listEntries();
    expect(seeded).toHaveLength(3);
    // Le mode démo accepte même une clé vide (c'est la synchro qui décide d'analyser ou non).
    expect(() => s.createAi({ ...DEFAULT_SETTINGS, geminiApiKey: '' }, 'entry')).not.toThrow();

    // Avec une clé quelconque : synthèses des jours passés.
    await saveSettings(s.db, { geminiApiKey: 'demo' });
    await s.sync.run();
    const days = [...new Set(seeded.map((e) => e.day))].sort();
    expect((await s.db.listSyntheses()).map((x) => x.day).sort()).toEqual(days);

    // Nouvelle entrée texte du jour → analysée, envoyée, copiée en Markdown.
    const now = new Date();
    await s.db.putEntry({
      id: 'demo-entree',
      day: dayKey(now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      source: 'text',
      transcript: "J'ai marché au parc avec Léa, super moment. Je dois appeler maman.",
      local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 },
    });
    await s.sync.run();
    const e = await s.db.getEntry('demo-entree');
    expect(e?.analysis?.todos).toEqual(['appeler maman']);
    expect(e?.local.dirty).toBe(false);
    expect(e?.local.driveFileId).toBeTruthy();

    const files = await createMockDriveClient().listAll();
    const names = files.filter((f) => f.space === 'drive').map((f) => f.name);
    expect(names).toContain('Dit Harry');
    expect(names).toContain(`${dayKey(now)}.md`);
    for (const d of days) expect(names).toContain(`${d}.md`);
  }, 30_000);
});

describe('enregistreur de démo (createMockServices().createRecorder)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('annulé pendant la demande d’accès au micro : pas de repli sur l’enregistreur simulé', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let grant: (s: MediaStream) => void = () => undefined;
    const stopped: string[] = [];
    const stream = { getTracks: () => [{ stop: () => void stopped.push('piste') }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      onLine: true,
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>((r) => (grant = r)) },
    });
    vi.stubGlobal('MediaRecorder', class {});

    const s = await createMockServices();
    const rec = s.createRecorder();
    const started = rec.start();
    expect(rec.status).toBe('starting');
    const cancelled = rec.cancel();
    grant(stream);

    await expect(started).rejects.toThrow(/annulé/i);
    await cancelled;
    expect(rec.status).toBe('idle');
    expect(stopped).toEqual(['piste']);
  });
});

describe('mock Gemini — mentions d’autres jours (démo)', () => {
  const ctx: EntryContext = { day: '2026-10-08', time: '21:15', dayLinks: 'auto' };

  it('expressions simples reconnues, puis la même validation que les vraies réponses', () => {
    const text =
      "Avant-hier j'ai dîné avec Paul au restaurant. Demain je vais chez le dentiste à 10 h. " +
      'Le week-end dernier on est allés à la mer. Il y a trois jours, réunion difficile. ' +
      'Dans 5 jours je pars à Nantes.';
    const mentions = mockDetectMentions(text, ctx);
    expect(mentions.map((m) => [m.when, m.status, m.day, m.choices ?? null, m.text])).toEqual([
      ['Avant-hier', 'auto', '2026-10-06', null, "J'ai dîné avec Paul au restaurant."],
      ['Demain', 'auto', '2026-10-09', null, 'Je vais chez le dentiste à 10 h.'],
      ['Le week-end dernier', 'proposed', '', ['2026-10-03', '2026-10-04'], 'On est allés à la mer.'],
      ['Il y a trois jours', 'auto', '2026-10-05', null, 'Réunion difficile.'],
      ['Dans 5 jours', 'auto', '2026-10-13', null, 'Je pars à Nantes.'],
    ]);
    expect(mockAnalyzeText(text, ctx).mentions).toEqual(mentions);
  });

  it('jour de la semaine seul : date selon le temps du verbe ; « dernier » / « prochain »', () => {
    const at = (t: string) => mockDetectMentions(t, ctx)[0];
    expect(at("Lundi j'ai vu Hugo.")).toMatchObject({ day: '2026-10-05', status: 'auto', kind: 'past' });
    expect(at('Lundi je vais voir Hugo.')).toMatchObject({ day: '2026-10-12', status: 'auto', kind: 'future' });
    expect(at('Lundi, Hugo.')).toMatchObject({ status: 'proposed', choices: ['2026-10-05', '2026-10-12'] });
    expect(at('Samedi dernier, fête chez Léa.')).toMatchObject({ day: '2026-10-03', status: 'auto' });
    expect(at('Lundi prochain je commence le yoga.')).toMatchObject({ day: '2026-10-12', status: 'auto' });
  });

  it('rien sans détection active, pour une échéance, ou pour le jour même', () => {
    expect(mockDetectMentions('Demain dentiste.', { ...ctx, dayLinks: 'off' })).toEqual([]);
    expect(mockDetectMentions('Demain dentiste.', { day: '2026-10-08', time: '10:00' })).toEqual([]);
    expect(mockAnalyzeText('Demain dentiste.').mentions).toBeUndefined();
    expect(mockDetectMentions('Je dois finir le dossier avant vendredi.', ctx)).toEqual([]);
    expect(mockDetectMentions('Ce soir, cinéma. Ce matin, café.', ctx)).toEqual([]);
  });

  it('synthèse avec notes : prévu jamais présenté comme arrivé, verdicts déterministes', async () => {
    const day: Entry = {
      id: 'd',
      day: '2026-10-06',
      createdAt: '2026-10-06T19:00:00.000Z',
      updatedAt: '2026-10-06T19:00:00.000Z',
      source: 'text',
      transcript: "J'ai dîné avec Paul au restaurant, c'était bien.",
      analysis: mockAnalyzeText("J'ai dîné avec Paul au restaurant, c'était bien."),
    };
    const link = (ref: string, kind: 'past' | 'future', text: string): DayLink => ({
      entryId: ref.split('/')[0] ?? '',
      sourceDay: '2026-10-08',
      sourceCreatedAt: '2026-10-08T07:00:00.000Z',
      mention: { id: ref.split('/')[1] ?? '', kind, day: '2026-10-06', when: 'x', text, status: 'auto' },
      ref,
    });
    const ai = createMockAiClient({ latencyMs: 0 });
    const s = await ai.synthesizeDay('2026-10-06', [day], [
      link('a/1', 'past', "J'ai dîné avec Paul au restaurant."),
      link('b/2', 'past', 'Ensuite balade sur les quais.'),
      link('c/3', 'future', 'Dentiste à 10 h.'),
    ]);
    expect(s.mentionVerdicts).toEqual({ 'a/1': 'deja', 'b/2': 'nouveau' });
    expect(s.summary).toContain("C'était prévu : Dentiste à 10 h.");
    expect(s.summary).toContain('Raconté plus tard : Ensuite balade sur les quais.');
    expect(s.summary).not.toContain('Raconté plus tard : J\'ai dîné');
    const plain = await ai.synthesizeDay('2026-10-06', [day]);
    expect(plain.mentionVerdicts).toBeUndefined();
  });
});
