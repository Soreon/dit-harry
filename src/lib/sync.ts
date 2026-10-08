/**
 * Moteur de synchronisation — voir docs/SPEC.md §8.
 *
 * Un cycle `run()` enchaîne : analyse → pull → push → synthèse → ménage → miroir.
 * Une seule exécution à la fois ; un appel pendant une exécution programme UNE ré-exécution.
 */
import { config } from '../config';
import { updateKv, withKvLock } from './db';
import { AppError, isAppError, toAppError } from './errors';
import { renderDayMarkdown } from './markdown';
import { loadSettings, mergeSettings, normalizeSettings } from './settings';
import type {
  AiClient,
  AuthService,
  DayKey,
  DaySynthesis,
  DriveClient,
  DriveFileMeta,
  Entry,
  EntryAnalysis,
  EntryContext,
  ISODate,
  LocalDb,
  LocalEntry,
  LocalSynthesis,
  Mood,
  Settings,
  SyncEngine,
  SyncStatus,
} from './types';
import { audioExtension, dayKey, entriesSignature, fnv1a, stripMimeParams, timeHHmm } from './util';

export interface SyncDeps {
  db: LocalDb;
  drive: DriveClient;
  auth: Pick<AuthService, 'getToken' | 'markExpired'>;
  createAi: (settings: Settings, which: 'entry' | 'synthesis') => AiClient;
  now?: () => Date;
  isOnline?: () => boolean;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const KV = {
  settings: 'settings',
  settingsDirty: 'sync.settingsDirty',
  settingsFileId: 'sync.settingsFileId',
  settingsModifiedTime: 'sync.settingsModifiedTime',
  lastSyncAt: 'sync.lastSyncAt',
  pendingDeletes: 'sync.pendingDeletes',
  forceSynthesisDays: 'sync.forceSynthesisDays',
  lastHousekeeping: 'sync.lastHousekeeping',
  /** Interne à sync.ts : échecs de synthèse par jour (évite de réessayer à chaque cycle). */
  synthesisBackoff: 'sync.synthesisBackoff',
  mirrorState: 'mirror.state',
} as const;

/** Au-delà de ce nombre de tentatives d'analyse, plus de nouvel essai automatique. */
const MAX_AUTO_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** « Jamais » : +100 ans (filtres de sécurité → pas de nouvel essai automatique). */
const NEVER_MS = 100 * 365 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const JSON_MIME = 'application/json';
const MD_MIME = 'text/markdown';

const RE_ENTRY = /^entry-(.+)\.json$/;
const RE_AUDIO = /^audio-(.+)\.[A-Za-z0-9]+$/;
const RE_DAY = /^day-(\d{4}-\d{2}-\d{2})\.json$/;

/* ------------------------------------------------------------------ */
/* Types internes                                                      */
/* ------------------------------------------------------------------ */

interface MirrorState {
  rootId?: string;
  yearIds: Record<string, string>;
  days: Record<DayKey, { fileId: string; sig: string }>;
}

interface SynthesisFailure {
  sig: string;
  attempts: number;
  retryAfter: ISODate;
}

interface RemoteIndex {
  settings?: DriveFileMeta;
  entries: Map<string, DriveFileMeta>;
  syntheses: Map<DayKey, DriveFileMeta>;
  audio: { meta: DriveFileMeta; entryId?: string }[];
}

/** État d'un cycle. */
interface Ctx {
  force: boolean;
  settings: Settings;
  /** Dernière erreur notable du cycle (→ `lastError`). */
  error?: AppError;
  needsAuth: boolean;
  needsKey: boolean;
  /** Données locales modifiées depuis la dernière notification. */
  changed: boolean;
  /** Listing Drive du pull (réutilisé par le ménage). */
  remote?: RemoteIndex;
  /** Le pull n'a pas pu tout télécharger : ne pas en déduire de suppressions. */
  pullIncomplete: boolean;
}

/* ------------------------------------------------------------------ */
/* Fonctions pures                                                     */
/* ------------------------------------------------------------------ */

/** Nb d'entrées non analysées, non envoyées, ou dont l'audio n'est pas encore dans Drive. */
export function pendingCountOf(entries: LocalEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (
      e.local.needsAnalysis ||
      e.local.dirty ||
      (e.source === 'voice' && e.local.hasLocalAudio && !e.audioFileId)
    ) {
      n++;
    }
  }
  return n;
}

function defaultIsOnline(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
    ? navigator.onLine
    : true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** JSON à clés triées (comparaison de contenu indépendante de l'ordre des clés). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (!isRecord(val)) return val;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(val).sort()) out[k] = val[k];
    return out;
  });
}

function toRemoteEntry(e: LocalEntry | Entry): Entry {
  const copy: Entry & { local?: unknown } = { ...e };
  delete copy.local;
  return copy;
}

function toRemoteSynthesis(s: LocalSynthesis | DaySynthesis): DaySynthesis {
  const copy: DaySynthesis & { local?: unknown } = { ...s };
  delete copy.local;
  return copy;
}

function sameEntryContent(a: LocalEntry | Entry, b: LocalEntry | Entry): boolean {
  return stableJson(toRemoteEntry(a)) === stableJson(toRemoteEntry(b));
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
}

function byCreatedAsc<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Analyse à (re)faire maintenant ? */
function isDueForAnalysis(e: LocalEntry, nowMs: number, force: boolean): boolean {
  if (!e.local.needsAnalysis) return false;
  if (force) return true;
  if (e.local.attempts >= MAX_AUTO_ATTEMPTS) return false;
  return !e.local.retryAfter || timeOf(e.local.retryAfter) <= nowMs;
}

/** Entrée encore en attente d'une analyse qui sera retentée automatiquement. */
function isRetryablePending(e: LocalEntry): boolean {
  return (
    e.local.needsAnalysis && e.local.errorKind !== 'safety' && e.local.attempts < MAX_AUTO_ATTEMPTS
  );
}

/** Erreur qui interrompt toutes les étapes distantes. */
function isFatalRemote(err: AppError): boolean {
  return err.kind === 'auth' || err.kind === 'network' || err.kind === 'quota';
}

function isNotFound(e: unknown): boolean {
  return isAppError(e) && e.status === 404;
}

/**
 * Entrée utilisable pour une synthèse : analysée ET avec du texte. Une entrée « Enregistrement
 * inaudible » (transcription vide) est ignorée — gemini.ts refuse une synthèse sans texte.
 */
function isSynthesizable(e: LocalEntry): boolean {
  return !!e.analysis && e.transcript.trim() !== '';
}

/** Le jour a-t-il (ou aura-t-il, une fois analysé) de quoi écrire une synthèse ? */
function dayHasContent(list: LocalEntry[] | undefined): boolean {
  return !!list && list.some((e) => e.local.needsAnalysis || isSynthesizable(e));
}

function groupByDay(entries: LocalEntry[]): Map<DayKey, LocalEntry[]> {
  const map = new Map<DayKey, LocalEntry[]>();
  for (const e of entries) {
    const list = map.get(e.day);
    if (list) list.push(e);
    else map.set(e.day, [e]);
  }
  return map;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Contenu de `sync.pendingDeletes` (ids non vides seulement). */
function idList(v: unknown): string[] {
  return stringList(v).filter((x) => x !== '');
}

function parseMood(v: unknown): Mood {
  if (isRecord(v) && typeof v.score === 'number' && typeof v.label === 'string') {
    const s = Math.max(-2, Math.min(2, Math.round(v.score))) as Mood['score'];
    return { score: s, label: v.label };
  }
  return { score: 0, label: 'neutre' };
}

/** Valide le JSON d'une entrée téléchargée depuis Drive. */
function parseRemoteEntry(raw: unknown, entryId: string): Entry | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : entryId;
  if (id !== entryId) return null;
  if (
    typeof raw.day !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    (raw.source !== 'voice' && raw.source !== 'text')
  ) {
    return null;
  }
  const e: Entry = {
    id,
    day: raw.day,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    source: raw.source,
    transcript: typeof raw.transcript === 'string' ? raw.transcript : '',
  };
  if (typeof raw.durationSec === 'number') e.durationSec = raw.durationSec;
  if (typeof raw.audioMime === 'string') e.audioMime = raw.audioMime;
  if (typeof raw.audioFileId === 'string' || raw.audioFileId === null) e.audioFileId = raw.audioFileId;
  if (typeof raw.audioExpired === 'boolean') e.audioExpired = raw.audioExpired;
  if (typeof raw.transcriptEdited === 'boolean') e.transcriptEdited = raw.transcriptEdited;
  if (isRecord(raw.analysis) && typeof raw.analysis.title === 'string') {
    e.analysis = raw.analysis as unknown as EntryAnalysis;
  }
  if (typeof raw.analysisModel === 'string') e.analysisModel = raw.analysisModel;
  if (typeof raw.analyzedAt === 'string') e.analyzedAt = raw.analyzedAt;
  return e;
}

/** Valide le JSON d'une synthèse téléchargée depuis Drive. */
function parseRemoteSynthesis(raw: unknown, day: DayKey): DaySynthesis | null {
  if (!isRecord(raw)) return null;
  if (raw.day !== day || typeof raw.generatedAt !== 'string' || typeof raw.summary !== 'string') {
    return null;
  }
  return {
    day,
    generatedAt: raw.generatedAt,
    model: typeof raw.model === 'string' ? raw.model : '',
    basedOn: typeof raw.basedOn === 'string' ? raw.basedOn : '',
    summary: raw.summary,
    mood: parseMood(raw.mood),
    highlights: stringList(raw.highlights),
    themes: stringList(raw.themes),
    todos: stringList(raw.todos),
  };
}

/**
 * Champs techniques (audio) : jamais perdus lors d'une fusion, quelle que soit la version
 * gagnante — l'expiration l'emporte, sinon on garde l'id audio connu.
 */
function mergeTechnical(winner: Entry, other: Entry): Entry {
  const out: Entry = { ...winner };
  if (winner.audioExpired || other.audioExpired) {
    out.audioExpired = true;
    out.audioFileId = null;
  } else if (!winner.audioFileId && other.audioFileId) {
    out.audioFileId = other.audioFileId;
  }
  return out;
}

/** Range les fichiers de l'appDataFolder par type (appProperties, sinon nom du fichier). */
function classify(files: DriveFileMeta[]): RemoteIndex {
  const idx: RemoteIndex = { entries: new Map(), syntheses: new Map(), audio: [] };
  const newer = (a: DriveFileMeta | undefined, b: DriveFileMeta): DriveFileMeta =>
    !a || timeOf(b.modifiedTime) > timeOf(a.modifiedTime) ? b : a;
  for (const f of files) {
    const p = f.appProperties ?? {};
    let kind = p.kind;
    if (!kind) {
      if (f.name === 'settings.json') kind = 'settings';
      else if (RE_ENTRY.test(f.name)) kind = 'entry';
      else if (RE_DAY.test(f.name)) kind = 'synthesis';
      else if (RE_AUDIO.test(f.name)) kind = 'audio';
    }
    switch (kind) {
      case 'settings':
        idx.settings = newer(idx.settings, f);
        break;
      case 'entry': {
        const id = p.entryId ?? RE_ENTRY.exec(f.name)?.[1];
        if (id) idx.entries.set(id, newer(idx.entries.get(id), f));
        break;
      }
      case 'synthesis': {
        const day = p.day ?? RE_DAY.exec(f.name)?.[1];
        if (day) idx.syntheses.set(day, newer(idx.syntheses.get(day), f));
        break;
      }
      case 'audio': {
        const entryId = p.entryId ?? RE_AUDIO.exec(f.name)?.[1];
        idx.audio.push(entryId ? { meta: f, entryId } : { meta: f });
        break;
      }
      default:
        break;
    }
  }
  return idx;
}

function normalizeMirrorState(raw: unknown): MirrorState {
  const state: MirrorState = { yearIds: {}, days: {} };
  if (!isRecord(raw)) return state;
  if (typeof raw.rootId === 'string' && raw.rootId) state.rootId = raw.rootId;
  if (isRecord(raw.yearIds)) {
    for (const [y, id] of Object.entries(raw.yearIds)) if (typeof id === 'string') state.yearIds[y] = id;
  }
  if (isRecord(raw.days)) {
    for (const [d, v] of Object.entries(raw.days)) {
      if (isRecord(v) && typeof v.fileId === 'string' && typeof v.sig === 'string') {
        state.days[d] = { fileId: v.fileId, sig: v.sig };
      }
    }
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Moteur                                                              */
/* ------------------------------------------------------------------ */

export function createSyncEngine(deps: SyncDeps): SyncEngine {
  const { db, drive, auth, createAi } = deps;
  const now = deps.now ?? (() => new Date());
  const isOnline = deps.isOnline ?? defaultIsOnline;

  let status: SyncStatus = {
    running: false,
    phase: 'idle',
    pendingCount: 0,
    needsAuth: false,
    needsKey: false,
  };
  const statusListeners = new Set<(s: SyncStatus) => void>();
  const dataListeners = new Set<() => void>();

  let current: Promise<void> | null = null;
  let rerunRequested = false;
  let rerunForce = false;
  let cycleStarted = false;
  /** Clé Gemini refusée au dernier essai : on ne la réessaie pas à chaque cycle (sauf `force`). */
  let rejectedKey: string | null = null;

  /* --- Notifications --------------------------------------------- */

  function setStatus(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch };
    const snapshot = { ...status };
    for (const cb of statusListeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.error('[sync] abonné au statut en erreur', e);
      }
    }
  }

  function emitDataChanged(): void {
    for (const cb of dataListeners) {
      try {
        cb();
      } catch (e) {
        console.error('[sync] abonné onDataChanged en erreur', e);
      }
    }
  }

  async function refreshPending(): Promise<void> {
    setStatus({ pendingCount: pendingCountOf(await db.listEntries()) });
  }

  /** Notifie l'UI si des données locales ont changé depuis la dernière notification. */
  async function flush(ctx: Ctx): Promise<void> {
    if (!ctx.changed) return;
    ctx.changed = false;
    await refreshPending();
    emitDataChanged();
  }

  // Statut initial (dernier cycle, nb en attente) — sans attendre un premier cycle.
  void (async () => {
    try {
      const [last, entries] = await Promise.all([
        db.getKv<string>(KV.lastSyncAt),
        db.listEntries(),
      ]);
      if (!cycleStarted) {
        setStatus({ pendingCount: pendingCountOf(entries), ...(last ? { lastSyncAt: last } : {}) });
      }
    } catch {
      // base indisponible : le premier cycle remontera l'erreur
    }
  })();

  /* --- Utilitaires -------------------------------------------------- */

  function note(ctx: Ctx, err: AppError): void {
    ctx.error = err;
  }

  function markExpired(ctx: Ctx): void {
    ctx.needsAuth = true;
    try {
      auth.markExpired();
    } catch {
      // sans importance
    }
  }

  /** Erreur sur un élément distant : fatale → remontée ; sinon notée, on continue. */
  function remoteItemError(ctx: Ctx, e: unknown): void {
    const err = toAppError(e);
    if (isFatalRemote(err)) throw err;
    console.warn('[sync]', err.message, e);
    note(ctx, err);
  }

  function refreshKeyFlag(ctx: Ctx): void {
    const key = ctx.settings.geminiApiKey.trim();
    ctx.needsKey = !key || key === rejectedKey;
  }

  async function patchEntry(
    id: string,
    fn: (cur: LocalEntry) => LocalEntry | null,
  ): Promise<LocalEntry | undefined> {
    const cur = await db.getEntry(id);
    if (!cur) return undefined;
    const next = fn(cur);
    if (!next) return undefined;
    await db.putEntry(next);
    return next;
  }

  async function getPendingDeletes(): Promise<string[]> {
    return idList(await db.getKv<unknown>(KV.pendingDeletes));
  }

  async function getDayList(key: string): Promise<DayKey[]> {
    return stringList(await db.getKv<unknown>(key));
  }

  /** Ajout à `sync.pendingDeletes`, sérialisé avec les écritures du contrôleur. */
  async function addPendingDeletes(ids: (string | null | undefined)[]): Promise<void> {
    const add = ids.filter((x): x is string => !!x);
    if (add.length === 0) return;
    await updateKv(db, KV.pendingDeletes, (cur) => [...new Set([...idList(cur), ...add])]);
  }

  /** Met à jour un fichier existant, ou le crée (pas d'id, ou 404). */
  async function upsertAppData(
    existingId: string | undefined,
    name: string,
    body: string | Blob,
    mime: string,
    props: Record<string, string>,
  ): Promise<DriveFileMeta> {
    if (existingId) {
      try {
        return await drive.updateFileContent(existingId, body, mime);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    return drive.createAppDataFile(name, body, mime, props);
  }

  /* --- 1. Analyse --------------------------------------------------- */

  async function analyzeOne(
    ai: AiClient,
    snap: LocalEntry,
    ctx: Ctx,
  ): Promise<{ transcript?: string; analysis: EntryAnalysis } | null> {
    const ectx: EntryContext = { day: snap.day, time: timeHHmm(new Date(snap.createdAt)) };
    if (snap.source === 'voice' && !snap.transcriptEdited) {
      let blob = await db.getAudio(snap.id);
      if (!blob) {
        if (!snap.audioFileId) {
          throw new AppError('other', "Audio introuvable : l'enregistrement n'est ni sur cet appareil ni dans Drive.");
        }
        if (!auth.getToken()) {
          // L'audio est dans Drive : on attend la reconnexion, sans compter d'échec.
          ctx.needsAuth = true;
          return null;
        }
        blob = await drive.downloadBlob(snap.audioFileId);
      }
      const mime = stripMimeParams(snap.audioMime || blob.type || 'audio/webm');
      const r = await ai.analyzeAudio(blob, mime, ectx);
      return { transcript: r.transcript, analysis: r.analysis };
    }
    return { analysis: await ai.analyzeText(snap.transcript, ectx) };
  }

  async function recordAnalysisFailure(id: string, err: AppError, countAttempt: boolean): Promise<void> {
    const nowMs = now().getTime();
    await patchEntry(id, (cur) => {
      if (!cur.local.needsAnalysis) return null;
      const local = { ...cur.local, error: err.message, errorKind: err.kind };
      if (countAttempt) {
        local.attempts = cur.local.attempts + 1;
        const delay =
          err.kind === 'safety' ? NEVER_MS : (err.retryAfterMs ?? backoffMs(local.attempts));
        local.retryAfter = new Date(nowMs + delay).toISOString();
      }
      return { ...cur, local };
    });
  }

  async function stepAnalyze(ctx: Ctx): Promise<void> {
    const key = ctx.settings.geminiApiKey.trim();
    if (!key || (key === rejectedKey && !ctx.force)) {
      ctx.needsKey = true;
      return;
    }
    const nowMs = now().getTime();
    // listEntries est trié du plus récent au plus ancien.
    const todo = (await db.listEntries()).filter((e) => isDueForAnalysis(e, nowMs, ctx.force));
    if (todo.length === 0) return;

    let ai: AiClient;
    try {
      ai = createAi(ctx.settings, 'entry');
    } catch (e) {
      const err = toAppError(e);
      if (err.kind === 'invalid-key') ctx.needsKey = true;
      else note(ctx, err);
      return;
    }

    setStatus({ phase: 'analyzing' });
    for (const snap of todo) {
      try {
        const result = await analyzeOne(ai, snap, ctx);
        if (!result) continue;
        rejectedKey = null;
        ctx.needsKey = false;
        const at = now().toISOString();
        const saved = await patchEntry(snap.id, (cur) => {
          // Modifiée (corrigée) pendant l'analyse : on jette ce résultat, le prochain cycle refera.
          if (!sameEntryContent(cur, snap)) return null;
          const local = { ...cur.local, needsAnalysis: false, attempts: 0, dirty: true };
          delete local.error;
          delete local.errorKind;
          delete local.retryAfter;
          const next: LocalEntry = {
            ...cur,
            analysis: result.analysis,
            analysisModel: ctx.settings.entryModel,
            analyzedAt: at,
            updatedAt: at,
            local,
          };
          if (result.transcript !== undefined) next.transcript = result.transcript;
          return next;
        });
        if (saved) {
          ctx.changed = true;
          await flush(ctx);
        }
      } catch (e) {
        const err = toAppError(e);
        if (err.kind === 'auth') {
          // Téléchargement de l'audio refusé : pas la faute de l'entrée.
          markExpired(ctx);
          continue;
        }
        if (err.kind === 'invalid-key') {
          rejectedKey = key;
          ctx.needsKey = true;
          await recordAnalysisFailure(snap.id, err, false);
          ctx.changed = true;
          break;
        }
        await recordAnalysisFailure(snap.id, err, true);
        ctx.changed = true;
        if (err.kind === 'quota' || err.kind === 'network') {
          note(ctx, err);
          break;
        }
      }
    }
    await flush(ctx);
  }

  /* --- 2. Pull ------------------------------------------------------ */

  async function pullSettings(ctx: Ctx, meta: DriveFileMeta | undefined): Promise<void> {
    const knownId = await db.getKv<string>(KV.settingsFileId);
    if (!meta) {
      if (knownId) {
        // Fichier supprimé à distance : on le recréera avec nos réglages.
        await db.deleteKv(KV.settingsFileId);
        await db.deleteKv(KV.settingsModifiedTime);
        await db.setKv(KV.settingsDirty, true);
      }
      return;
    }
    const knownTime = await db.getKv<string>(KV.settingsModifiedTime);
    if (meta.id === knownId && meta.modifiedTime === knownTime) return;
    try {
      const remote = normalizeSettings(await drive.downloadJson<unknown>(meta.id));
      // Lecture-fusion-écriture sous verrou : un saveSettings() simultané n'est pas écrasé.
      const merged = await withKvLock(db, async () => {
        const local = await loadSettings(db);
        const m = mergeSettings(local, remote);
        if (stableJson(m) !== stableJson(local)) {
          await db.setKv(KV.settings, m);
          ctx.changed = true;
        }
        await db.setKv(KV.settingsDirty, stableJson(m) !== stableJson(remote));
        return m;
      });
      await db.setKv(KV.settingsFileId, meta.id);
      await db.setKv(KV.settingsModifiedTime, meta.modifiedTime);
      const oldKey = ctx.settings.geminiApiKey.trim();
      ctx.settings = merged;
      refreshKeyFlag(ctx);
      // Nouvelle clé reçue d'un autre appareil : l'analyse (étape 1) est déjà passée → on relance.
      if (merged.geminiApiKey.trim() && merged.geminiApiKey.trim() !== oldKey) rerunRequested = true;
    } catch (e) {
      remoteItemError(ctx, e);
    }
  }

  async function pullEntries(ctx: Ctx, remote: Map<string, DriveFileMeta>): Promise<void> {
    const pendingDeletes = new Set(await getPendingDeletes());
    const locals = await db.listEntries();
    const localById = new Map(locals.map((e) => [e.id, e]));

    for (const [entryId, meta] of remote) {
      if (pendingDeletes.has(meta.id)) continue; // supprimée ici, suppression distante en attente
      const known = localById.get(entryId);
      if (
        known &&
        known.local.driveFileId === meta.id &&
        known.local.remoteModifiedTime === meta.modifiedTime
      ) {
        continue;
      }
      try {
        const remoteEntry = parseRemoteEntry(await drive.downloadJson<unknown>(meta.id), entryId);
        if (!remoteEntry) {
          throw new AppError('bad-response', `Entrée illisible dans Drive (${meta.name}).`, {
            retryable: false,
          });
        }
        const cur = await db.getEntry(entryId);
        if (!cur) {
          if (known) continue; // supprimée localement pendant le téléchargement
          await db.putEntry({
            ...remoteEntry,
            local: {
              dirty: false,
              needsAnalysis: !remoteEntry.analysis,
              hasLocalAudio: false,
              driveFileId: meta.id,
              remoteModifiedTime: meta.modifiedTime,
              attempts: 0,
            },
          });
        } else {
          await db.putEntry(mergeEntry(cur, remoteEntry, meta));
        }
        ctx.changed = true;
      } catch (e) {
        ctx.pullIncomplete = true;
        remoteItemError(ctx, e);
      }
    }

    // Entrées supprimées depuis un autre appareil.
    for (const known of locals) {
      const fileId = known.local.driveFileId;
      if (!fileId || remote.has(known.id)) continue;
      const cur = await db.getEntry(known.id);
      if (!cur || cur.local.driveFileId !== fileId) continue;
      if (cur.local.dirty) {
        // Modifiée ici : on oublie l'ancien fichier, elle sera recréée au push.
        const local = { ...cur.local };
        delete local.driveFileId;
        delete local.remoteModifiedTime;
        await db.putEntry({ ...cur, local });
      } else {
        await db.deleteEntry(cur.id);
        await db.deleteAudio(cur.id);
      }
      ctx.changed = true;
    }
  }

  /** Fusion d'une entrée locale connue avec sa version distante modifiée. */
  function mergeEntry(cur: LocalEntry, remote: Entry, meta: DriveFileMeta): LocalEntry {
    const remoteWins = !cur.local.dirty || timeOf(remote.updatedAt) > timeOf(cur.updatedAt);
    if (remoteWins) {
      const merged = mergeTechnical(remote, toRemoteEntry(cur));
      const local = {
        ...cur.local, // garde notamment hasLocalAudio
        driveFileId: meta.id,
        remoteModifiedTime: meta.modifiedTime,
        // Un champ technique connu ici seulement → à renvoyer.
        dirty: stableJson(merged) !== stableJson(remote),
        needsAnalysis: !merged.analysis,
      };
      if (merged.analysis) {
        local.attempts = 0;
        delete local.error;
        delete local.errorKind;
        delete local.retryAfter;
      }
      return { ...merged, local };
    }
    // La locale gagne (plus récente, ou égalité) : elle sera renvoyée.
    const merged = mergeTechnical(toRemoteEntry(cur), remote);
    return {
      ...merged,
      local: { ...cur.local, driveFileId: meta.id, remoteModifiedTime: meta.modifiedTime, dirty: true },
    };
  }

  async function pullSyntheses(ctx: Ctx, remote: Map<DayKey, DriveFileMeta>): Promise<void> {
    const pendingDeletes = new Set(await getPendingDeletes());
    const locals = await db.listSyntheses();
    const localByDay = new Map(locals.map((s) => [s.day, s]));

    for (const [day, meta] of remote) {
      if (pendingDeletes.has(meta.id)) continue;
      const known = localByDay.get(day);
      if (
        known &&
        known.local.driveFileId === meta.id &&
        known.local.remoteModifiedTime === meta.modifiedTime
      ) {
        continue;
      }
      try {
        const remoteSynth = parseRemoteSynthesis(await drive.downloadJson<unknown>(meta.id), day);
        if (!remoteSynth) {
          throw new AppError('bad-response', `Synthèse illisible dans Drive (${meta.name}).`, {
            retryable: false,
          });
        }
        const cur = await db.getSynthesis(day);
        if (!cur && known) continue; // supprimée localement pendant le téléchargement
        if (!cur || !cur.local.dirty || timeOf(remoteSynth.generatedAt) > timeOf(cur.generatedAt)) {
          await db.putSynthesis({
            ...remoteSynth,
            local: { dirty: false, driveFileId: meta.id, remoteModifiedTime: meta.modifiedTime },
          });
        } else {
          await db.putSynthesis({
            ...cur,
            local: { ...cur.local, driveFileId: meta.id, remoteModifiedTime: meta.modifiedTime, dirty: true },
          });
        }
        ctx.changed = true;
      } catch (e) {
        ctx.pullIncomplete = true;
        remoteItemError(ctx, e);
      }
    }

    for (const known of locals) {
      const fileId = known.local.driveFileId;
      if (!fileId || remote.has(known.day)) continue;
      const cur = await db.getSynthesis(known.day);
      if (!cur || cur.local.driveFileId !== fileId) continue;
      if (cur.local.dirty) {
        const local = { ...cur.local };
        delete local.driveFileId;
        delete local.remoteModifiedTime;
        await db.putSynthesis({ ...cur, local });
      } else {
        await db.deleteSynthesis(cur.day);
      }
      ctx.changed = true;
    }
  }

  async function stepPull(ctx: Ctx): Promise<void> {
    setStatus({ phase: 'pulling' });
    const remote = classify(await drive.listAppData());
    ctx.remote = remote;
    await pullSettings(ctx, remote.settings);
    await pullEntries(ctx, remote.entries);
    await pullSyntheses(ctx, remote.syntheses);
    await flush(ctx);
  }

  /* --- 3. Push ------------------------------------------------------ */

  async function processPendingDeletes(ctx: Ctx): Promise<void> {
    const list = await getPendingDeletes();
    if (list.length === 0) return;
    const done = new Set<string>();
    try {
      for (const id of list) {
        try {
          await drive.deleteFile(id);
          done.add(id);
        } catch (e) {
          remoteItemError(ctx, e);
        }
      }
    } finally {
      if (done.size > 0) {
        // Relire sous verrou : le contrôleur a pu en ajouter pendant ce temps.
        await updateKv(db, KV.pendingDeletes, (cur) => idList(cur).filter((id) => !done.has(id)));
      }
    }
  }

  async function uploadAudio(ctx: Ctx): Promise<void> {
    const entries = await db.listEntries();
    for (const e of entries) {
      if (e.source !== 'voice' || !e.local.hasLocalAudio || e.audioFileId || e.audioExpired) continue;
      try {
        const blob = await db.getAudio(e.id);
        if (!blob) {
          await patchEntry(e.id, (cur) => ({ ...cur, local: { ...cur.local, hasLocalAudio: false } }));
          ctx.changed = true;
          continue;
        }
        const mime = stripMimeParams(e.audioMime || blob.type || 'audio/webm');
        const meta = await drive.createAppDataFile(`audio-${e.id}.${audioExtension(mime)}`, blob, mime, {
          kind: 'audio',
          day: e.day,
          entryId: e.id,
        });
        // Champ technique : `dirty` sans toucher à `updatedAt`.
        const saved = await patchEntry(e.id, (cur) =>
          cur.audioFileId ? null : { ...cur, audioFileId: meta.id, local: { ...cur.local, dirty: true } },
        );
        if (!saved) await addPendingDeletes([meta.id]); // entrée supprimée pendant l'envoi
        ctx.changed = true;
      } catch (err) {
        remoteItemError(ctx, err);
      }
    }
  }

  async function pushEntries(ctx: Ctx): Promise<void> {
    const dirty = (await db.listEntries()).filter((e) => e.local.dirty);
    for (const snap of dirty) {
      try {
        const meta = await upsertAppData(
          snap.local.driveFileId,
          `entry-${snap.id}.json`,
          JSON.stringify(toRemoteEntry(snap)),
          JSON_MIME,
          { kind: 'entry', day: snap.day, entryId: snap.id },
        );
        const saved = await patchEntry(snap.id, (cur) => ({
          ...cur,
          local: {
            ...cur.local,
            driveFileId: meta.id,
            remoteModifiedTime: meta.modifiedTime,
            // Modifiée pendant l'envoi → reste à renvoyer.
            dirty: !sameEntryContent(cur, snap),
          },
        }));
        if (!saved) await addPendingDeletes([meta.id]);
        ctx.changed = true;
      } catch (e) {
        remoteItemError(ctx, e);
      }
    }
  }

  /** Audio local supprimé une fois dans Drive et l'analyse faite. */
  async function dropUploadedLocalAudio(ctx: Ctx): Promise<void> {
    const entries = await db.listEntries();
    for (const e of entries) {
      if (!e.local.hasLocalAudio || !e.audioFileId || e.local.needsAnalysis) continue;
      const saved = await patchEntry(e.id, (cur) =>
        cur.audioFileId && !cur.local.needsAnalysis
          ? { ...cur, local: { ...cur.local, hasLocalAudio: false } }
          : null,
      );
      if (saved) {
        await db.deleteAudio(e.id);
        ctx.changed = true;
      }
    }
  }

  async function pushSyntheses(ctx: Ctx): Promise<void> {
    const dirty = (await db.listSyntheses()).filter((s) => s.local.dirty);
    for (const snap of dirty) {
      try {
        const meta = await upsertAppData(
          snap.local.driveFileId,
          `day-${snap.day}.json`,
          JSON.stringify(toRemoteSynthesis(snap)),
          JSON_MIME,
          { kind: 'synthesis', day: snap.day },
        );
        const cur = await db.getSynthesis(snap.day);
        if (!cur) {
          await addPendingDeletes([meta.id]);
        } else {
          const unchanged = stableJson(toRemoteSynthesis(cur)) === stableJson(toRemoteSynthesis(snap));
          await db.putSynthesis({
            ...cur,
            local: {
              ...cur.local,
              driveFileId: meta.id,
              remoteModifiedTime: meta.modifiedTime,
              dirty: !unchanged,
            },
          });
        }
        ctx.changed = true;
      } catch (e) {
        remoteItemError(ctx, e);
      }
    }
  }

  async function pushSettings(ctx: Ctx): Promise<void> {
    if ((await db.getKv<boolean>(KV.settingsDirty)) !== true) return;
    try {
      const s = await loadSettings(db);
      const knownId = await db.getKv<string>(KV.settingsFileId);
      const meta = await upsertAppData(knownId, 'settings.json', JSON.stringify(s), JSON_MIME, {
        kind: 'settings',
      });
      await db.setKv(KV.settingsFileId, meta.id);
      await db.setKv(KV.settingsModifiedTime, meta.modifiedTime);
      // Réglages modifiés pendant l'envoi → rester « à envoyer ».
      await withKvLock(db, async () => {
        const after = await loadSettings(db);
        if (stableJson(after) === stableJson(s)) await db.setKv(KV.settingsDirty, false);
      });
    } catch (e) {
      remoteItemError(ctx, e);
    }
  }

  async function stepPush(ctx: Ctx): Promise<void> {
    setStatus({ phase: 'pushing' });
    await processPendingDeletes(ctx);
    await uploadAudio(ctx);
    await pushEntries(ctx);
    await dropUploadedLocalAudio(ctx);
    await pushSyntheses(ctx);
    await pushSettings(ctx);
    await flush(ctx);
  }

  /* --- 4. Synthèse -------------------------------------------------- */

  async function stepSynthesis(ctx: Ctx): Promise<void> {
    const entries = await db.listEntries();
    const byDay = groupByDay(entries);
    const syntheses = await db.listSyntheses();
    const synthByDay = new Map(syntheses.map((s) => [s.day, s]));
    let toPush = false;

    // Jour avec synthèse mais sans entrée (ou seulement des entrées inaudibles, toutes
    // analysées) → supprimer la synthèse (sauf pull incomplet).
    if (!ctx.pullIncomplete) {
      for (const s of syntheses) {
        if (dayHasContent(byDay.get(s.day))) continue;
        await db.deleteSynthesis(s.day);
        await addPendingDeletes([s.local.driveFileId]);
        synthByDay.delete(s.day);
        ctx.changed = true;
        toPush = true;
      }
    }

    const key = ctx.settings.geminiApiKey.trim();
    const keyUsable = !!key && (key !== rejectedKey || ctx.force);
    if (!keyUsable) ctx.needsKey = true;

    if (keyUsable) {
      const nowMs = now().getTime();
      const today = dayKey(now());
      const forced = new Set(await getDayList(KV.forceSynthesisDays));
      const failuresRaw = await db.getKv<unknown>(KV.synthesisBackoff);
      const failures: Record<DayKey, SynthesisFailure> = isRecord(failuresRaw)
        ? (failuresRaw as Record<DayKey, SynthesisFailure>)
        : {};
      // Demande manuelle pour un jour sans aucune entrée : rien à faire.
      const doneForced = new Set<DayKey>([...forced].filter((d) => !byDay.has(d)));

      type Candidate = {
        day: DayKey;
        analyzed: LocalEntry[];
        sig: string;
        forced: boolean;
      };
      const candidates: Candidate[] = [];
      for (const [day, list] of byDay) {
        const isForced = forced.has(day);
        if (!(day < today || isForced)) continue;
        const analyzed = list.filter(isSynthesizable);
        if (analyzed.length === 0) {
          // Rien à synthétiser ; une demande manuelle reste en attente si des analyses arrivent.
          if (isForced && !list.some(isRetryablePending)) doneForced.add(day);
          continue;
        }
        if (list.some(isRetryablePending)) continue;
        const sig = entriesSignature(analyzed);
        const existing = synthByDay.get(day);
        if (!isForced) {
          if (existing && existing.basedOn === sig) continue;
          const f = failures[day];
          if (f && f.sig === sig && timeOf(f.retryAfter) > nowMs) continue;
        }
        candidates.push({ day, analyzed, sig, forced: isForced });
      }
      // Demandes manuelles d'abord, puis les jours les plus récents.
      candidates.sort((a, b) =>
        a.forced !== b.forced ? (a.forced ? -1 : 1) : a.day < b.day ? 1 : a.day > b.day ? -1 : 0,
      );
      const batch = candidates.slice(0, config.maxSynthesesPerRun);

      if (batch.length > 0) {
        let ai: AiClient | null = null;
        try {
          ai = createAi(ctx.settings, 'synthesis');
        } catch (e) {
          const err = toAppError(e);
          if (err.kind === 'invalid-key') ctx.needsKey = true;
          else note(ctx, err);
        }
        if (ai) {
          setStatus({ phase: 'synthesizing' });
          for (const c of batch) {
            try {
              const input = c.analyzed.map(toRemoteEntry).sort(byCreatedAsc);
              const res = await ai.synthesizeDay(c.day, input);
              rejectedKey = null;
              const prev = await db.getSynthesis(c.day);
              const local: LocalSynthesis['local'] = { dirty: true };
              if (prev?.local.driveFileId) local.driveFileId = prev.local.driveFileId;
              if (prev?.local.remoteModifiedTime) local.remoteModifiedTime = prev.local.remoteModifiedTime;
              await db.putSynthesis({
                day: c.day,
                generatedAt: now().toISOString(),
                model: ctx.settings.synthesisModel,
                basedOn: c.sig,
                summary: res.summary,
                mood: res.mood,
                highlights: res.highlights,
                themes: res.themes,
                todos: res.todos,
                local,
              });
              delete failures[c.day];
              if (c.forced) doneForced.add(c.day);
              ctx.changed = true;
              toPush = true;
            } catch (e) {
              const err = toAppError(e);
              if (err.kind === 'invalid-key') {
                rejectedKey = key;
                ctx.needsKey = true;
                break;
              }
              const prevFail = failures[c.day];
              const attempts = (prevFail && prevFail.sig === c.sig ? prevFail.attempts : 0) + 1;
              const delay =
                err.kind === 'safety' || attempts >= MAX_AUTO_ATTEMPTS
                  ? NEVER_MS
                  : (err.retryAfterMs ?? backoffMs(attempts));
              const retryAfter = new Date(nowMs + delay).toISOString();
              failures[c.day] = { sig: c.sig, attempts, retryAfter };
              if (c.forced) doneForced.add(c.day);
              const prev = await db.getSynthesis(c.day);
              if (prev) {
                await db.putSynthesis({
                  ...prev,
                  local: { ...prev.local, error: err.message, errorKind: err.kind, retryAfter },
                });
                ctx.changed = true;
              }
              note(ctx, err);
              if (err.kind === 'quota' || err.kind === 'network') break;
            }
          }
        }
      }

      // Mémoriser : demandes manuelles traitées, échecs (jours encore existants seulement).
      if (doneForced.size > 0) {
        await updateKv(db, KV.forceSynthesisDays, (cur) => stringList(cur).filter((d) => !doneForced.has(d)));
      }
      for (const d of Object.keys(failures)) if (!byDay.has(d)) delete failures[d];
      await db.setKv(KV.synthesisBackoff, failures);
    }

    await flush(ctx);
    // Envoi immédiat si on a toujours un jeton.
    if (toPush && auth.getToken()) {
      setStatus({ phase: 'pushing' });
      await processPendingDeletes(ctx);
      await pushSyntheses(ctx);
      await flush(ctx);
    }
  }

  /* --- 5. Ménage (rétention audio) ---------------------------------- */

  async function stepHousekeeping(ctx: Ctx): Promise<void> {
    const today = dayKey(now());
    if ((await db.getKv<string>(KV.lastHousekeeping)) === today) return;
    const remote = ctx.remote;
    if (!remote) return;
    setStatus({ phase: 'housekeeping' });

    const cutoff = now().getTime() - ctx.settings.audioRetentionDays * DAY_MS;
    const expired = remote.audio.filter((a) => {
      const t = Date.parse(a.meta.createdTime);
      return !Number.isNaN(t) && t < cutoff;
    });
    let touched = false;
    if (expired.length > 0) {
      const entries = await db.listEntries();
      for (const { meta, entryId } of expired) {
        try {
          await drive.deleteFile(meta.id);
          const id = entryId ?? entries.find((e) => e.audioFileId === meta.id)?.id;
          if (!id) continue;
          const saved = await patchEntry(id, (cur) => {
            // Un autre fichier audio est référencé : celui-ci n'était qu'un doublon.
            if (cur.audioFileId && cur.audioFileId !== meta.id) return null;
            if (cur.audioExpired && !cur.audioFileId && !cur.local.hasLocalAudio) return null;
            // Champs techniques : `dirty` sans toucher à `updatedAt`.
            return {
              ...cur,
              audioFileId: null,
              audioExpired: true,
              local: { ...cur.local, dirty: true, hasLocalAudio: false },
            };
          });
          if (saved) {
            await db.deleteAudio(id);
            ctx.changed = true;
            touched = true;
          }
        } catch (e) {
          remoteItemError(ctx, e);
        }
      }
    }
    await db.setKv(KV.lastHousekeeping, today);
    if (touched) {
      setStatus({ phase: 'pushing' });
      await pushEntries(ctx);
    }
    await flush(ctx);
  }

  /* --- 6. Miroir Markdown ------------------------------------------- */

  async function stepMirror(ctx: Ctx): Promise<void> {
    if (!ctx.settings.mirrorEnabled) return;
    setStatus({ phase: 'mirroring' });

    const state = normalizeMirrorState(await db.getKv<unknown>(KV.mirrorState));
    const save = (): Promise<void> => db.setKv(KV.mirrorState, state);
    const byDay = groupByDay(await db.listEntries());
    const synthByDay = new Map((await db.listSyntheses()).map((s) => [s.day, s]));
    const days = [...new Set([...byDay.keys(), ...synthByDay.keys()])].sort().reverse();

    const folderFor = async (day: DayKey): Promise<string> => {
      let rootId = state.rootId;
      if (!rootId) {
        rootId = await drive.ensureFolder(config.mirrorFolderName);
        state.rootId = rootId;
        await save();
      }
      const year = day.slice(0, 4);
      let yearId = state.yearIds[year];
      if (!yearId) {
        yearId = await drive.ensureFolder(year, rootId);
        state.yearIds[year] = yearId;
        await save();
      }
      return yearId;
    };

    let cacheReset = false;
    for (let pass = 0; pass < 2; pass++) {
      let restart = false;
      for (const day of days) {
        try {
          const entries = (byDay.get(day) ?? []).map(toRemoteEntry).sort(byCreatedAsc);
          const synth = synthByDay.get(day);
          const md = renderDayMarkdown(day, entries, synth ? toRemoteSynthesis(synth) : undefined);
          const sig = fnv1a(md);
          if (state.days[day]?.sig === sig) continue;
          const parentId = await folderFor(day);
          const fileId = await drive.upsertTextFile(parentId, `${day}.md`, md, MD_MIME, state.days[day]?.fileId);
          state.days[day] = { fileId, sig };
          await save();
        } catch (e) {
          if (isNotFound(e) && !cacheReset) {
            // Dossier en cache supprimé : vider le cache des dossiers, tout réécrire, une seule fois.
            // (Les ids de fichiers sont gardés : upsertTextFile recrée ceux qui ont disparu.)
            cacheReset = true;
            delete state.rootId;
            state.yearIds = {};
            for (const info of Object.values(state.days)) info.sig = '';
            await save();
            restart = true;
            break;
          }
          remoteItemError(ctx, e);
        }
      }
      if (!restart) break;
    }

    // Jours disparus → supprimer leur fichier.
    const present = new Set(days);
    for (const [day, info] of Object.entries(state.days)) {
      if (present.has(day)) continue;
      try {
        await drive.deleteFile(info.fileId);
        delete state.days[day];
        await save();
      } catch (e) {
        remoteItemError(ctx, e);
      }
    }
  }

  /* --- Cycle complet ------------------------------------------------ */

  async function cycle(force: boolean): Promise<void> {
    cycleStarted = true;
    const ctx: Ctx = {
      force,
      settings: { ...(await safeLoadSettings()) },
      needsAuth: false,
      needsKey: false,
      changed: false,
      pullIncomplete: false,
    };
    try {
      refreshKeyFlag(ctx);
      ctx.needsAuth = !auth.getToken();
      setStatus({ running: true, needsKey: ctx.needsKey, needsAuth: ctx.needsAuth });
      await refreshPending();

      const online = isOnline();
      // 1. Analyse
      if (online) await stepAnalyze(ctx);

      // 2 → 6 : jeton Google requis
      if (online) {
        if (!auth.getToken()) {
          ctx.needsAuth = true;
        } else {
          let remoteOk = false;
          try {
            await stepPull(ctx);
            await stepPush(ctx);
            await stepSynthesis(ctx);
            await stepHousekeeping(ctx);
            await stepMirror(ctx);
            remoteOk = true;
          } catch (e) {
            const err = toAppError(e);
            if (err.kind === 'auth') markExpired(ctx);
            else note(ctx, err);
          }
          // 7. Fin de cycle
          if (remoteOk) {
            const at = now().toISOString();
            await db.setKv(KV.lastSyncAt, at);
            setStatus({ lastSyncAt: at });
          }
        }
      }
    } catch (e) {
      // Erreur inattendue (stockage local…)
      console.error('[sync] cycle interrompu', e);
      note(ctx, toAppError(e));
    }
    try {
      await flush(ctx);
      await refreshPending();
    } catch {
      // ignoré
    }
    setStatus({
      needsAuth: ctx.needsAuth,
      needsKey: ctx.needsKey,
      lastError: ctx.error?.message,
      lastErrorKind: ctx.error?.kind,
    });
  }

  async function safeLoadSettings(): Promise<Settings> {
    try {
      return await loadSettings(db);
    } catch {
      return normalizeSettings(undefined);
    }
  }

  /* --- API publique ------------------------------------------------- */

  function run(opts?: { force?: boolean }): Promise<void> {
    const force = opts?.force === true;
    if (current) {
      rerunRequested = true;
      if (force) rerunForce = true;
      return current;
    }
    rerunRequested = false;
    rerunForce = false;
    let start: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      start = r;
    });
    const p = (async () => {
      await started;
      let f = force;
      try {
        for (;;) {
          await cycle(f);
          if (!rerunRequested) break;
          f = rerunForce;
          rerunRequested = false;
          rerunForce = false;
        }
      } catch (e) {
        console.error('[sync] erreur inattendue', e);
      } finally {
        current = null;
        setStatus({ running: false, phase: 'idle' });
      }
    })();
    // `current` est posé AVANT toute notification : un abonné qui rappelle run() obtient la
    // même promesse (pas de second cycle concurrent).
    current = p;
    setStatus({ running: true });
    start();
    return p;
  }

  return {
    run,
    getStatus: () => ({ ...status }),
    subscribe(cb) {
      statusListeners.add(cb);
      try {
        cb({ ...status });
      } catch (e) {
        console.error('[sync] abonné au statut en erreur', e);
      }
      return () => {
        statusListeners.delete(cb);
      };
    },
    onDataChanged(cb) {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
  };
}
