/**
 * Moteur de synchronisation — voir docs/SPEC.md §8.
 *
 * Un cycle `run()` enchaîne : analyse → pull → push → synthèse → ménage → miroir.
 * Une seule exécution à la fois ; un appel pendant une exécution programme UNE ré-exécution.
 */
import { config } from '../config';
import { updateEntry, updateKv, withEntryLock, withKvLock } from './db';
import { AppError, isAppError, toAppError } from './errors';
import { renderDayMarkdown } from './markdown';
import {
  collectDayLinks,
  isKnownSignatureSuffix,
  linksSignature,
  mergeAnalysisMentions,
  mergeMentionChoices,
  settledLinks,
  splitSignature,
} from './mentions';
import { loadSettings, mergeSettings, normalizeSettings } from './settings';
import type {
  AccountConflict,
  AiClient,
  AuthService,
  DayKey,
  DayLink,
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
  MentionVerdict,
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
  ownerEmail: 'device.ownerEmail',
} as const;

/**
 * Clé `kv` : email du compte Google à qui appartiennent les données de cet appareil.
 * Posée au premier cycle connecté d'un appareil vierge ; effacée avec la base (`clearAll`).
 */
export const KV_DEVICE_OWNER = KV.ownerEmail;

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
  /** `settings.json` n'a pas pu être lu : la rétention locale n'est peut-être pas la bonne. */
  settingsPullFailed: boolean;
  /** Compte du jeton vérifié (propriétaire des données) : opérations Drive permises. */
  remoteReady: boolean;
}

/**
 * Interne : le jeton Google a changé depuis la vérification du compte (reconnexion pendant le
 * cycle, peut-être avec un autre compte). Les étapes distantes s'arrêtent, un cycle est relancé.
 */
class AccountChangedError extends AppError {
  constructor() {
    super('auth', 'Le compte Google a changé pendant la synchronisation.');
    this.name = 'AccountChangedError';
  }
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Cet appareil garde-t-il un journal déjà synchronisé (entrées, synthèses, suppressions en
 * attente, ou trace d'une synchro passée) ? Les réglages seuls ne comptent pas.
 */
export async function hasLocalJournal(db: LocalDb): Promise<boolean> {
  const [entries, syntheses, deletes, settingsId, lastSync] = await Promise.all([
    db.listEntries(),
    db.listSyntheses(),
    db.getKv<unknown>(KV.pendingDeletes),
    db.getKv<unknown>(KV.settingsFileId),
    db.getKv<unknown>(KV.lastSyncAt),
  ]);
  return (
    entries.length > 0 || syntheses.length > 0 || idList(deletes).length > 0 || !!settingsId || !!lastSync
  );
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

/** Échec passager (quota, réseau) : retardé, mais pas compté comme une tentative. */
function isTransient(err: AppError): boolean {
  return err.kind === 'quota' || err.kind === 'network';
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

/**
 * L'audio d'une entrée peut-il expirer (rétention) ? Seulement si son contenu ne dépend plus de
 * lui : analyse faite, et analyse ou transcription présente. Une entrée jamais transcrite (filtres,
 * quota, pas de clé…) garde son audio : c'est la seule copie de ce qui a été dit.
 */
function audioDisposable(e: LocalEntry): boolean {
  return !e.local.needsAnalysis && (!!e.analysis || e.transcript.trim() !== '');
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

const VERDICTS = new Set<string>(['nouveau', 'complete', 'deja']);

/** Verdicts de synthèse valides (les autres valeurs sont ignorées). */
function parseVerdicts(v: unknown): Record<string, MentionVerdict> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, MentionVerdict> = {};
  for (const [ref, verdict] of Object.entries(v)) {
    if (typeof verdict === 'string' && VERDICTS.has(verdict)) out[ref] = verdict as MentionVerdict;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Valide le JSON d'une synthèse téléchargée depuis Drive. */
function parseRemoteSynthesis(raw: unknown, day: DayKey): DaySynthesis | null {
  if (!isRecord(raw)) return null;
  if (raw.day !== day || typeof raw.generatedAt !== 'string' || typeof raw.summary !== 'string') {
    return null;
  }
  const s: DaySynthesis = {
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
  // Reconstruit champ par champ : sans cette ligne, les verdicts se perdraient à chaque pull.
  const verdicts = parseVerdicts(raw.mentionVerdicts);
  if (verdicts) s.mentionVerdicts = verdicts;
  return s;
}

/** Notes d'autres jours, par jour visé (vide si « Rattacher aux autres jours » est désactivé). */
function linksByDayOf(entries: readonly LocalEntry[], settings: Settings): Map<DayKey, DayLink[]> {
  return settings.dayLinks === 'off' ? new Map() : collectDayLinks(entries);
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

/**
 * Mentions d'autres jours : la liste de la version retenue (`merged`), plus les choix de
 * l'utilisateur faits sur l'une ou l'autre version (ceux de `mine`, cet appareil, l'emportent).
 */
function withMentionChoices(merged: Entry, mine: Entry, theirs: Entry): Entry {
  if (!merged.analysis) return merged;
  const list = mergeMentionChoices(merged.analysis.mentions, mine.analysis?.mentions, theirs.analysis?.mentions);
  if (!list) return merged;
  const analysis: EntryAnalysis = { ...merged.analysis };
  if (list.length > 0) analysis.mentions = list;
  else delete analysis.mentions;
  return { ...merged, analysis };
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
  const { db, auth, createAi } = deps;
  const rawDrive = deps.drive;
  const now = deps.now ?? (() => new Date());
  const isOnline = deps.isOnline ?? defaultIsOnline;

  /** Compte Google vérifié pour un jeton (un seul appel `about()` par jeton). */
  let verified: { token: string; email: string } | null = null;
  /** Jeton dont le compte est le propriétaire des données : seul autorisé pour Drive ce cycle. */
  let remoteToken: string | null = null;
  /** Dernier conflit de compte constaté, et le jeton concerné. */
  let conflict: { token: string; value: AccountConflict } | null = null;

  /**
   * Garde-fou : aucun appel Drive (hors `about`) avec un jeton autre que celui vérifié au début
   * du cycle — les données d'un compte ne partent jamais dans le Drive d'un autre.
   */
  function assertSameAccount(): void {
    const token = auth.getToken();
    // Sans jeton, le client Drive lève lui-même AppError('auth').
    if (token !== null && token !== remoteToken) throw new AccountChangedError();
  }

  const drive: DriveClient = {
    about: () => rawDrive.about(),
    async listAppData() {
      assertSameAccount();
      return rawDrive.listAppData();
    },
    async downloadJson<T>(fileId: string): Promise<T> {
      assertSameAccount();
      return rawDrive.downloadJson<T>(fileId);
    },
    async downloadBlob(fileId) {
      assertSameAccount();
      return rawDrive.downloadBlob(fileId);
    },
    async createAppDataFile(name, body, mimeType, appProperties) {
      assertSameAccount();
      return rawDrive.createAppDataFile(name, body, mimeType, appProperties);
    },
    async updateFileContent(fileId, body, mimeType) {
      assertSameAccount();
      return rawDrive.updateFileContent(fileId, body, mimeType);
    },
    async deleteFile(fileId) {
      assertSameAccount();
      return rawDrive.deleteFile(fileId);
    },
    async ensureFolder(name, parentId) {
      assertSameAccount();
      return rawDrive.ensureFolder(name, parentId);
    },
    async upsertTextFile(parentId, name, content, mimeType, existingId) {
      assertSameAccount();
      return rawDrive.upsertTextFile(parentId, name, content, mimeType, existingId);
    },
  };

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

  /** Lecture-modification-écriture d'une entrée, sérialisée avec celles du contrôleur. */
  function patchEntry(
    id: string,
    fn: (cur: LocalEntry) => LocalEntry | null,
  ): Promise<LocalEntry | undefined> {
    return updateEntry(db, id, fn);
  }

  /** Erreur qui a interrompu les étapes distantes. */
  function remoteStepsError(ctx: Ctx, e: unknown): void {
    if (e instanceof AccountChangedError) {
      // Jeton remplacé pendant le cycle : on recommence, le compte sera revérifié.
      rerunRequested = true;
      return;
    }
    const err = toAppError(e);
    if (err.kind === 'auth') markExpired(ctx);
    else note(ctx, err);
  }

  /**
   * Étape 0 — le compte du jeton est-il celui à qui appartiennent les données locales ?
   * Appareil vierge : le compte est adopté. Autre compte, ou données d'un compte inconnu →
   * conflit, aucune opération Drive (rien ne part dans le Drive d'un autre compte, aucune
   * suppression n'est déduite du Drive d'un autre compte).
   */
  async function verifyAccount(ctx: Ctx, token: string): Promise<boolean> {
    let email: string;
    if (verified && verified.token === token) {
      email = verified.email;
    } else {
      email = (await rawDrive.about()).email.trim();
      if (!email) {
        throw new AppError(
          'other',
          "Google Drive n'a pas indiqué ton compte : synchronisation suspendue, nouvel essai plus tard.",
        );
      }
      verified = { token, email };
    }
    const owner = await withKvLock(db, async () => {
      const cur = await db.getKv<unknown>(KV.ownerEmail);
      if (typeof cur === 'string' && cur.trim()) return cur.trim();
      if (await hasLocalJournal(db)) return undefined; // données d'un compte inconnu
      await db.setKv(KV.ownerEmail, email);
      ctx.changed = true;
      return email;
    });
    if (owner !== undefined && sameEmail(owner, email)) {
      conflict = null;
      remoteToken = token;
      return true;
    }
    conflict = { token, value: owner === undefined ? { current: email } : { owner, current: email } };
    return false;
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
    const ectx: EntryContext = {
      day: snap.day,
      time: timeHHmm(new Date(snap.createdAt)),
      // Désactivé : ni consigne, ni repères, ni champ `mentions` dans la requête.
      dayLinks: ctx.settings.dayLinks === 'off' ? 'off' : 'auto',
    };
    if (snap.source === 'voice' && !snap.transcriptEdited) {
      let blob = await db.getAudio(snap.id);
      if (!blob) {
        if (!snap.audioFileId) {
          throw new AppError('other', "Audio introuvable : l'enregistrement n'est ni sur cet appareil ni dans Drive.");
        }
        if (!auth.getToken() || !ctx.remoteReady) {
          // L'audio est dans Drive : on attend la reconnexion (ou un compte vérifié), sans
          // compter d'échec.
          if (!auth.getToken()) ctx.needsAuth = true;
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
        // Quota et réseau sont passagers : seul le délai s'applique, sans user les essais
        // automatiques (un quota journalier épuisé les consommerait tous en une soirée).
        if (!isTransient(err)) local.attempts = cur.local.attempts + 1;
        const delay =
          err.kind === 'safety' ? NEVER_MS : (err.retryAfterMs ?? backoffMs(cur.local.attempts + 1));
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
            // Les choix faits sur les mentions d'autres jours (confirmer, déplacer, retirer)
            // survivent à la nouvelle analyse ; détection désactivée → mentions gardées telles quelles.
            analysis: mergeAnalysisMentions(cur.analysis, result.analysis, ctx.settings.dayLinks !== 'off'),
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
          if (e instanceof AccountChangedError) rerunRequested = true;
          else markExpired(ctx);
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
      ctx.settingsPullFailed = true;
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
        // Lecture-fusion-écriture sous verrou : une correction simultanée n'est pas écrasée.
        const written = await withEntryLock(db, async () => {
          const cur = await db.getEntry(entryId);
          if (!cur) {
            if (known) return false; // supprimée localement pendant le téléchargement
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
          return true;
        });
        if (written) ctx.changed = true;
      } catch (e) {
        ctx.pullIncomplete = true;
        remoteItemError(ctx, e);
      }
    }

    // Entrées supprimées depuis un autre appareil.
    for (const known of locals) {
      const fileId = known.local.driveFileId;
      if (!fileId || remote.has(known.id)) continue;
      const changed = await withEntryLock(db, async () => {
        const cur = await db.getEntry(known.id);
        if (!cur || cur.local.driveFileId !== fileId) return false;
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
        return true;
      });
      if (changed) ctx.changed = true;
    }
  }

  /** Fusion d'une entrée locale connue avec sa version distante modifiée. */
  function mergeEntry(cur: LocalEntry, remote: Entry, meta: DriveFileMeta): LocalEntry {
    const remoteWins = !cur.local.dirty || timeOf(remote.updatedAt) > timeOf(cur.updatedAt);
    if (remoteWins) {
      const local0 = toRemoteEntry(cur);
      let merged = mergeTechnical(remote, local0);
      // Geste fait ici (pas encore envoyé) sur une mention : la version distante plus récente ne
      // l'efface pas (les gestes ne touchent pas `updatedAt`). Il sera renvoyé (dirty ci-dessous).
      if (cur.local.dirty) merged = withMentionChoices(merged, local0, remote);
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
    // La locale gagne (plus récente, ou égalité) : elle sera renvoyée, avec les gestes faits sur
    // l'autre appareil (mentions) que la version locale ne connaît pas.
    const local0 = toRemoteEntry(cur);
    const merged = withMentionChoices(mergeTechnical(local0, remote), local0, remote);
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
        // Entrée supprimée pendant l'envoi : seul un fichier CRÉÉ par cet envoi est à supprimer.
        // Le fichier existant a déjà été mis en attente par celui qui a supprimé l'entrée ; s'il
        // ne l'a pas été (base effacée pendant l'envoi), le supprimer ferait disparaître une
        // entrée intacte de Drive, donc de tous les appareils.
        if (!saved && meta.id !== snap.local.driveFileId) await addPendingDeletes([meta.id]);
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
      // Sous verrou : une demande de nouvelle analyse ne peut pas s'intercaler.
      const dropped = await withEntryLock(db, async () => {
        const cur = await db.getEntry(e.id);
        if (!cur || !cur.audioFileId || cur.local.needsAnalysis) return false;
        await db.putEntry({ ...cur, local: { ...cur.local, hasLocalAudio: false } });
        await db.deleteAudio(e.id);
        return true;
      });
      if (dropped) ctx.changed = true;
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
          // Même règle que pour les entrées : seul un fichier créé par cet envoi.
          if (meta.id !== snap.local.driveFileId) await addPendingDeletes([meta.id]);
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
        /** Notes d'autres jours, dites avant aujourd'hui, qui visent ce jour (faits racontés plus tard, choses prévues). */
        links: DayLink[];
        /** Seules les notes d'autres jours ont changé depuis la synthèse existante. */
        linksOnly: boolean;
      };
      const linksOn = ctx.settings.dayLinks !== 'off';
      const linksByDay = linksByDayOf(entries, ctx.settings);
      // Entrées dont l'analyse va être refaite : leurs mentions peuvent encore changer.
      const pendingSources = new Set(entries.filter(isRetryablePending).map((e) => e.id));
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
        const base = entriesSignature(analyzed);
        // Notes dites avant aujourd'hui seulement : celles d'aujourd'hui sont intégrées une fois,
        // demain, toutes ensemble (jamais de régénération le jour même où elles sont dites).
        const links = settledLinks(linksByDay.get(day) ?? [], today);
        // Sans note d'un autre jour : exactement la signature d'avant (aucune régénération).
        const sig = linksSignature(base, links);
        const existing = synthByDay.get(day);
        let linksOnly = false;
        if (!isForced) {
          if (existing && existing.basedOn === sig) continue;
          // Une entrée source d'une note attend une nouvelle analyse : jour gelé jusque-là (ses
          // mentions peuvent encore changer).
          if (links.some((l) => pendingSources.has(l.entryId))) continue;
          if (existing) {
            const prev = splitSignature(existing.basedOn);
            // Signature d'une version plus récente de l'appli : pas de régénération automatique.
            if (!isKnownSignatureSuffix(prev.suffix)) continue;
            linksOnly = prev.base === base;
            // Désactivé : jamais de régénération pour des notes d'autres jours.
            if (linksOnly && !linksOn) continue;
          }
          const f = failures[day];
          if (f && f.sig === sig && timeOf(f.retryAfter) > nowMs) continue;
        }
        candidates.push({ day, analyzed, sig, forced: isForced, links, linksOnly });
      }
      // Demandes manuelles d'abord, puis les jours les plus récents ; en dernier, les jours qui ne
      // changent que par des notes d'autres jours.
      candidates.sort((a, b) => {
        if (a.forced !== b.forced) return a.forced ? -1 : 1;
        if (a.linksOnly !== b.linksOnly) return a.linksOnly ? 1 : -1;
        return a.day < b.day ? 1 : a.day > b.day ? -1 : 0;
      });
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
              const res =
                c.links.length > 0
                  ? await ai.synthesizeDay(c.day, input, c.links)
                  : await ai.synthesizeDay(c.day, input);
              rejectedKey = null;
              const prev = await db.getSynthesis(c.day);
              const local: LocalSynthesis['local'] = { dirty: true };
              if (prev?.local.driveFileId) local.driveFileId = prev.local.driveFileId;
              if (prev?.local.remoteModifiedTime) local.remoteModifiedTime = prev.local.remoteModifiedTime;
              const synthesis: LocalSynthesis = {
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
              };
              const verdicts = parseVerdicts(res.mentionVerdicts);
              if (verdicts) synthesis.mentionVerdicts = verdicts;
              await db.putSynthesis(synthesis);
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
              const prevAttempts = prevFail && prevFail.sig === c.sig ? prevFail.attempts : 0;
              // Quota / réseau : délai seulement, pas de tentative comptée (voir l'analyse).
              const attempts = prevAttempts + (isTransient(err) ? 0 : 1);
              const delay =
                err.kind === 'safety' || attempts >= MAX_AUTO_ATTEMPTS
                  ? NEVER_MS
                  : (err.retryAfterMs ?? backoffMs(prevAttempts + 1));
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
    // `settings.json` illisible ce cycle : la durée locale peut être celle par défaut (nouvel
    // appareil) au lieu de celle choisie → on attend un cycle où les réglages sont lus.
    if (ctx.settingsPullFailed) return;
    setStatus({ phase: 'housekeeping' });

    const cutoff = now().getTime() - ctx.settings.audioRetentionDays * DAY_MS;
    const expired = remote.audio.filter((a) => {
      const t = Date.parse(a.meta.createdTime);
      return !Number.isNaN(t) && t < cutoff;
    });
    let touched = false;
    /** Fichiers laissés faute de savoir (pull incomplet) : ménage à refaire au prochain cycle. */
    let deferred = false;
    if (expired.length > 0) {
      const entries = await db.listEntries();
      for (const { meta, entryId } of expired) {
        try {
          const id = entryId ?? entries.find((e) => e.audioFileId === meta.id)?.id;
          const cur = id !== undefined ? await db.getEntry(id) : undefined;
          if (cur) {
            // Un autre fichier audio est référencé : celui-ci n'est qu'un doublon (supprimable).
            const duplicate = !!cur.audioFileId && cur.audioFileId !== meta.id;
            // Entrée pas (encore) transcrite : l'audio est la seule copie de son contenu.
            if (!duplicate && !audioDisposable(cur)) continue;
          } else if (ctx.pullIncomplete || (id !== undefined && remote.entries.has(id))) {
            // Entrée inconnue ici mais présente (ou peut-être présente) dans Drive : on ignore
            // si elle est transcrite → on attend qu'elle soit tirée.
            deferred = true;
            continue;
          }
          // Sinon : audio expiré d'une entrée transcrite, doublon, ou fichier orphelin.
          await drive.deleteFile(meta.id);
          if (id === undefined) continue;
          const saved = await withEntryLock(db, async () => {
            const e = await db.getEntry(id);
            if (!e) return false;
            if (e.audioFileId && e.audioFileId !== meta.id) return false;
            if (e.audioExpired && !e.audioFileId && !e.local.hasLocalAudio) return false;
            if (!audioDisposable(e)) {
              // Nouvelle analyse demandée pendant la suppression : l'audio local (s'il existe)
              // reste, et sera renvoyé dans Drive.
              if (e.audioFileId !== meta.id) return false;
              await db.putEntry({ ...e, audioFileId: null, local: { ...e.local, dirty: true } });
              return true;
            }
            // Champs techniques : `dirty` sans toucher à `updatedAt`.
            await db.putEntry({
              ...e,
              audioFileId: null,
              audioExpired: true,
              local: { ...e.local, dirty: true, hasLocalAudio: false },
            });
            await db.deleteAudio(id);
            return true;
          });
          if (saved) {
            ctx.changed = true;
            touched = true;
          }
        } catch (e) {
          remoteItemError(ctx, e);
        }
      }
    }
    if (!deferred) await db.setKv(KV.lastHousekeeping, today);
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
    const allEntries = await db.listEntries();
    const byDay = groupByDay(allEntries);
    const synthByDay = new Map((await db.listSyntheses()).map((s) => [s.day, s]));
    const linksOn = ctx.settings.dayLinks !== 'off';
    const linksByDay = linksByDayOf(allEntries, ctx.settings);
    // Jours qui n'ont que des notes d'autres jours : copiés aussi (sinon la règle « jour disparu »
    // effacerait leur fichier), mais jamais avant leur date (pas de fichier pour un jour à venir).
    const today = dayKey(now());
    const linkDays = [...linksByDay.keys()].filter((d) => d <= today);
    const days = [...new Set([...byDay.keys(), ...synthByDay.keys(), ...linkDays])].sort().reverse();

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
          const md = renderDayMarkdown(
            day,
            entries,
            synth ? toRemoteSynthesis(synth) : undefined,
            linksOn ? (linksByDay.get(day) ?? []) : undefined,
          );
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
    remoteToken = null;
    const ctx: Ctx = {
      force,
      settings: { ...(await safeLoadSettings()) },
      needsAuth: false,
      needsKey: false,
      changed: false,
      pullIncomplete: false,
      settingsPullFailed: false,
      remoteReady: false,
    };
    try {
      refreshKeyFlag(ctx);
      ctx.needsAuth = !auth.getToken();
      setStatus({ running: true, needsKey: ctx.needsKey, needsAuth: ctx.needsAuth });
      await refreshPending();

      const online = isOnline();
      // 0. Compte Google : vérifié avant toute opération Drive.
      const token = online ? auth.getToken() : null;
      if (token) {
        try {
          ctx.remoteReady = await verifyAccount(ctx, token);
        } catch (e) {
          remoteStepsError(ctx, e);
        }
      }

      // 1. Analyse
      if (online) await stepAnalyze(ctx);

      // 2 → 6 : jeton Google (du compte propriétaire des données) requis
      if (online) {
        if (!auth.getToken()) {
          ctx.needsAuth = true;
        } else if (ctx.remoteReady) {
          let remoteOk = false;
          try {
            await stepPull(ctx);
            await stepPush(ctx);
            await stepSynthesis(ctx);
            await stepHousekeeping(ctx);
            await stepMirror(ctx);
            remoteOk = true;
          } catch (e) {
            remoteStepsError(ctx, e);
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
    // Le conflit concerne un jeton : il disparaît avec lui (déconnexion, expiration).
    const tokenNow = auth.getToken();
    const accountConflict = conflict && conflict.token === tokenNow ? conflict.value : undefined;
    setStatus({
      needsAuth: ctx.needsAuth,
      needsKey: ctx.needsKey,
      lastError: ctx.error?.message,
      lastErrorKind: ctx.error?.kind,
      accountConflict,
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
