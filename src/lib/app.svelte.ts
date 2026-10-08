/**
 * Contrôleur réactif de l'interface (runes Svelte 5).
 * Détient l'état affiché (compte, réglages, entrées, synthèses, synchro, enregistreur,
 * notifications) et les actions appelées par les composants. Voir docs/SPEC.md §9.
 */
import { createContext } from 'svelte';
import { config } from '../config';
import { buildExportZip, downloadBlob } from './backup';
import { updateKv } from './db';
import { toAppError } from './errors';
import { DEFAULT_SETTINGS, loadSettings, saveSettings as storeSettings } from './settings';
import { pendingCountOf } from './sync';
import type {
  AuthState,
  DayKey,
  EntryLocalState,
  LocalEntry,
  LocalSynthesis,
  RecorderStatus,
  RecordingResult,
  Services,
  Settings,
  SyncStatus,
  VoiceRecorder,
} from './types';
import { dayKey, newId, sleep, stripMimeParams } from './util';
import { groupDays, parseRoute, routeHash, type DayGroup, type Route } from '../components/helpers';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export interface RecordingState {
  status: RecorderStatus;
  /** Niveau sonore lissé 0..1. */
  level: number;
  /** Secondes écoulées. */
  seconds: number;
}

/** Résultat d'une vérification de clé Gemini, message prêt à afficher. */
export interface KeyCheckResult {
  ok: boolean;
  message: string;
}

const KV_PENDING_DELETES = 'sync.pendingDeletes';
const KV_FORCE_SYNTHESIS = 'sync.forceSynthesisDays';
/** Préférence d'appareil : jour où l'on a répondu « Plus tard » à l'écran de clé Gemini. */
const LS_KEY_LATER = 'dh.ui.keyLater';
/** Délai minimal entre deux synchros déclenchées par le retour au premier plan. */
const RESYNC_ON_FOCUS_MS = 2 * 60 * 1000;
/** Attente maximale de `auth.init()` avant la première synchro. */
const AUTH_INIT_WAIT_MS = 8_000;

const IDLE_SYNC: SyncStatus = {
  running: false,
  phase: 'idle',
  pendingCount: 0,
  needsAuth: false,
  needsKey: false,
};

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // stockage indisponible (navigation privée…) : préférence non mémorisée
  }
}

/** Liste de chaînes lue dans `kv` (valeur quelconque → tableau propre). */
function kvStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function sameSettings(a: Settings, b: Settings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Settings)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** État local remis à zéro pour une nouvelle analyse. */
function withFreshAnalysis(local: EntryLocalState, dirty: boolean): EntryLocalState {
  return {
    ...local,
    dirty: local.dirty || dirty,
    needsAnalysis: true,
    attempts: 0,
    error: undefined,
    errorKind: undefined,
    retryAfter: undefined,
  };
}

export class AppController {
  readonly services: Services;

  /* --- État réactif ------------------------------------------------ */
  route = $state.raw<Route>(parseRoute(location.hash));
  auth = $state.raw<AuthState>({ status: 'loading' });
  settings = $state.raw<Settings>(DEFAULT_SETTINGS);
  entries = $state.raw<LocalEntry[]>([]);
  syntheses = $state.raw<Record<DayKey, LocalSynthesis>>({});
  syncStatus = $state.raw<SyncStatus>(IDLE_SYNC);
  online = $state(navigator.onLine);
  today = $state(dayKey());
  /** Horloge (rafraîchie toutes les 30 s) pour les dates relatives. */
  now = $state.raw(new Date());
  /** Données locales chargées (réglages, entrées, récupération faite). */
  ready = $state(false);
  /** Au moins un cycle de synchro terminé (connecté ou hors ligne). */
  firstSyncDone = $state(false);
  keyLaterDay = $state<string | null>(readLocal(LS_KEY_LATER));
  recording = $state<RecordingState>({ status: 'idle', level: 0, seconds: 0 });
  toasts = $state.raw<Toast[]>([]);
  /** Jours dont la synthèse a été demandée et pas encore obtenue. */
  synthesisRequested = $state.raw<DayKey[]>([]);
  exporting = $state(false);
  /** Brouillon de saisie texte (gardé si on ferme la feuille). */
  textDraft = $state('');

  /* --- Dérivés ------------------------------------------------------- */
  days: DayGroup[] = $derived(groupDays(this.entries, this.syntheses));
  todayEntries: LocalEntry[] = $derived(this.days.find((d) => d.day === this.today)?.entries ?? []);
  pendingCount: number = $derived(pendingCountOf(this.entries));
  hasKey: boolean = $derived(this.settings.geminiApiKey.trim() !== '');
  /** Un compte Google est connu sur cet appareil (même si le jeton a expiré). */
  hasAccount: boolean = $derived(this.auth.status === 'signed-in' || !!this.auth.email);
  /** Bandeau « Se reconnecter ». */
  needsReconnect: boolean = $derived(
    this.hasAccount && (this.auth.status === 'expired' || this.auth.status === 'error'),
  );
  showKeySetup: boolean = $derived(
    this.hasAccount && this.ready && this.firstSyncDone && !this.hasKey && this.keyLaterDay !== this.today,
  );

  /* --- Interne ------------------------------------------------------- */
  private started = false;
  private disposers: (() => void)[] = [];
  private recorder: VoiceRecorder | null = null;
  private audioUrls = new Map<string, string>();
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;
  private toastSeq = 0;
  private previousHash = '';

  constructor(services: Services) {
    this.services = services;
    this.auth = services.auth.getState();
    this.syncStatus = services.sync.getStatus();
  }

  /* ================================================================== */
  /* Démarrage / arrêt                                                   */
  /* ================================================================== */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { auth, sync, db } = this.services;

    this.disposers.push(
      auth.subscribe((s) => this.onAuthChange(s)),
      sync.subscribe((s) => {
        this.syncStatus = s;
      }),
      sync.onDataChanged(() => void this.reload()),
    );
    this.listen(window, 'hashchange', this.onHashChange);
    this.listen(window, 'online', this.onOnline);
    this.listen(window, 'offline', this.onOffline);
    this.listen(document, 'visibilitychange', this.onVisibilityChange);
    const timer = setInterval(() => this.tick(), 30_000);
    this.disposers.push(() => clearInterval(timer));

    void this.requestPersistentStorage();
    const authReady = auth.init().catch((e: unknown) => console.warn('[auth] init', e));

    try {
      this.settings = await loadSettings(db);
      await this.reload();
      await this.recoverRecordings();
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
    } finally {
      this.ready = true;
    }

    // Script Google lent ou bloqué : ne pas retarder indéfiniment la première synchro
    await Promise.race([authReady, sleep(AUTH_INIT_WAIT_MS)]);
    await this.runSync();
  }

  destroy(): void {
    for (const off of this.disposers.splice(0)) off();
    this.releaseAudio();
    this.started = false;
  }

  private listen(target: EventTarget, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  private async requestPersistentStorage(): Promise<void> {
    try {
      if (navigator.storage && 'persist' in navigator.storage) await navigator.storage.persist();
    } catch {
      // non bloquant
    }
  }

  private onAuthChange(s: AuthState): void {
    const prev = this.auth.status;
    this.auth = s;
    // Passage à « connecté » → synchro (le démarrage lance déjà la sienne une fois prêt)
    if (s.status === 'signed-in' && prev !== 'signed-in' && this.ready) void this.runSync();
  }

  private onHashChange = (): void => {
    const next = parseRoute(location.hash);
    this.previousHash = routeHash(this.route);
    this.route = next;
    window.scrollTo({ top: 0 });
  };

  private onOnline = (): void => {
    this.online = true;
    void this.runSync();
  };

  private onOffline = (): void => {
    this.online = false;
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    this.tick();
    const last = this.syncStatus.lastSyncAt ? Date.parse(this.syncStatus.lastSyncAt) : 0;
    if (!this.syncStatus.running && Date.now() - last > RESYNC_ON_FOCUS_MS) void this.runSync();
  };

  private tick(): void {
    this.now = new Date();
    const d = dayKey(this.now);
    if (d !== this.today) this.today = d;
  }

  /* ================================================================== */
  /* Navigation                                                          */
  /* ================================================================== */

  /** Remonte vers `target` (ex. '#/journal') ; utilise l'historique si on en vient. */
  goUp(target: string): void {
    if (this.previousHash === routeHash(parseRoute(target))) history.back();
    else location.hash = target;
  }

  /* ================================================================== */
  /* Données                                                             */
  /* ================================================================== */

  /** Relit entrées, synthèses et réglages depuis IndexedDB (appels groupés). */
  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    const { db } = this.services;
    this.reloading = (async () => {
      do {
        this.reloadAgain = false;
        const [entries, syntheses, settings] = await Promise.all([
          db.listEntries(),
          db.listSyntheses(),
          loadSettings(db),
        ]);
        this.entries = entries;
        this.syntheses = Object.fromEntries(syntheses.map((s) => [s.day, s]));
        // Même contenu → même objet : évite d'écraser un champ de réglage en cours de saisie
        if (!sameSettings(settings, this.settings)) this.settings = settings;
      } while (this.reloadAgain);
    })().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  getEntry(id: string): LocalEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  getDay(day: DayKey): DayGroup {
    return this.days.find((d) => d.day === day) ?? { day, entries: [] };
  }

  /* ================================================================== */
  /* Synchronisation                                                     */
  /* ================================================================== */

  async runSync(opts?: { force?: boolean }, manual = false): Promise<void> {
    const signedIn = this.auth.status === 'signed-in';
    try {
      await this.services.sync.run(opts);
    } catch (e) {
      const err = toAppError(e);
      if (manual) this.toast(err.message, 'error');
      else console.warn('[sync]', err);
    } finally {
      if (signedIn || !this.online) this.firstSyncDone = true;
    }
  }

  /** Bouton « Synchroniser maintenant ». */
  async syncNow(): Promise<void> {
    await this.runSync({ force: true }, true);
    const s = this.syncStatus;
    if (s.lastError && !s.needsAuth) this.toast(s.lastError, 'error');
    else if (!s.needsAuth) this.toast('Synchronisation terminée.', 'success');
  }

  /* ================================================================== */
  /* Compte Google                                                       */
  /* ================================================================== */

  /**
   * Ouvre la popup Google. DOIT rester synchrone jusqu'à `auth.signIn()` : appelée
   * directement depuis un `onclick`, sinon Chrome Android bloque la popup.
   */
  signIn(): void {
    const pending = this.services.auth.signIn();
    pending.then(
      () => this.toast('Connecté à Google.', 'success'),
      (e: unknown) => this.toast(toAppError(e).message, 'error'),
    );
  }

  async signOut(clearDevice: boolean): Promise<void> {
    if (this.recorder) await this.cancelRecording();
    try {
      await this.services.auth.signOut();
    } catch (e) {
      console.warn('[auth] signOut', e);
    }
    if (clearDevice) {
      try {
        await this.services.db.clearAll();
      } catch (e) {
        this.toast(toAppError(e).message, 'error');
      }
      this.releaseAudio();
      writeLocal(LS_KEY_LATER, null);
      this.keyLaterDay = null;
      this.textDraft = '';
    }
    this.firstSyncDone = false;
    await this.reload();
    location.hash = '#/';
    this.toast(clearDevice ? 'Déconnecté, données de cet appareil effacées.' : 'Déconnecté.', 'info');
  }

  /* ================================================================== */
  /* Enregistrement vocal                                                */
  /* ================================================================== */

  async startRecording(): Promise<void> {
    if (this.recorder || this.recording.status !== 'idle' || !this.ready) return;
    const rec = this.services.createRecorder();
    this.recorder = rec;
    this.recording = { status: 'starting', level: 0, seconds: 0 };
    try {
      await rec.start({
        onLevel: (level) => {
          if (this.recorder === rec) this.recording.level = level;
        },
        onTick: (seconds) => {
          if (this.recorder === rec) this.recording.seconds = seconds;
        },
        onAutoStop: (result) => void this.finishRecording(rec, Promise.resolve(result), true),
      });
      if (this.recorder === rec && this.recording.status === 'starting') this.recording.status = 'recording';
    } catch (e) {
      // Démarrage annulé par l'utilisateur : pas d'erreur à afficher
      if (this.recorder !== rec) return;
      this.recorder = null;
      this.resetRecording();
      this.toast(toAppError(e).message, 'error');
    }
  }

  async stopRecording(): Promise<void> {
    const rec = this.recorder;
    if (!rec || this.recording.status !== 'recording') return;
    await this.finishRecording(rec, rec.stop(), false);
  }

  async cancelRecording(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    try {
      await rec.cancel();
    } catch (e) {
      console.warn('[recorder] cancel', e);
    } finally {
      this.resetRecording();
    }
    this.toast('Enregistrement annulé.', 'info');
  }

  private async finishRecording(rec: VoiceRecorder, result: Promise<RecordingResult>, auto: boolean): Promise<void> {
    // Un seul traitement par enregistrement (arrêt manuel et arrêt auto peuvent se croiser)
    if (this.recorder !== rec) return;
    this.recorder = null;
    this.recording.status = 'stopping';
    try {
      const res = await result;
      if (res.blob.size === 0) {
        await this.services.db.deleteChunks(res.recordingId);
        this.toast("L'enregistrement est vide, rien n'a été gardé.", 'error');
        return;
      }
      await this.storeRecording(res);
      await this.reload();
      this.toast(
        auto ? 'Enregistrement arrêté automatiquement — il est bien gardé.' : 'Entrée enregistrée.',
        'success',
      );
      void this.runSync();
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
    } finally {
      this.resetRecording();
    }
  }

  private resetRecording(): void {
    this.recording = { status: 'idle', level: 0, seconds: 0 };
  }

  /**
   * Enregistre un résultat d'enregistrement comme nouvelle entrée voix.
   * L'id de l'entrée reprend celui de l'enregistrement : une récupération après
   * crash ne peut donc pas créer de doublon.
   */
  private async storeRecording(res: RecordingResult): Promise<void> {
    const { db } = this.services;
    const id = res.recordingId || newId();
    const started = new Date(res.startedAt);
    const startedAt = Number.isNaN(started.getTime()) ? new Date() : started;
    const entry: LocalEntry = {
      id,
      day: dayKey(startedAt),
      createdAt: startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'voice',
      durationSec: Math.max(0, Math.round(res.durationSec)),
      audioMime: stripMimeParams(res.mimeType || res.blob.type) || 'audio/webm',
      audioFileId: null,
      transcript: '',
      local: { dirty: true, needsAnalysis: true, hasLocalAudio: true, attempts: 0 },
    };
    await db.putAudio(id, res.blob);
    await db.putEntry(entry);
    await db.deleteChunks(res.recordingId);
  }

  /** Démarrage : transforme les morceaux d'enregistrements interrompus en entrées. */
  private async recoverRecordings(): Promise<void> {
    const { db } = this.services;
    let recovered = 0;
    for (const recordingId of await db.listRecordingIds()) {
      try {
        const chunks = (await db.getChunks(recordingId)).sort((a, b) => a.index - b.index);
        const first = chunks[0];
        if (!first || (await db.getEntry(recordingId))) {
          await db.deleteChunks(recordingId);
          continue;
        }
        const mimeType = stripMimeParams(first.mimeType) || 'audio/webm';
        const blob = new Blob(
          chunks.map((c) => c.blob),
          { type: mimeType },
        );
        if (blob.size === 0) {
          await db.deleteChunks(recordingId);
          continue;
        }
        await this.storeRecording({
          recordingId,
          blob,
          mimeType,
          // Estimation : un morceau par tranche de `recorderTimesliceMs`
          durationSec: (chunks.length * config.recorderTimesliceMs) / 1000,
          startedAt: first.startedAt,
          interrupted: true,
        });
        recovered++;
      } catch (e) {
        console.warn('[récupération]', recordingId, e);
      }
    }
    if (recovered > 0) {
      await this.reload();
      this.toast(
        recovered === 1
          ? 'Un enregistrement interrompu a été récupéré.'
          : `${recovered} enregistrements interrompus ont été récupérés.`,
        'success',
      );
    }
  }

  /* ================================================================== */
  /* Entrées                                                             */
  /* ================================================================== */

  async addTextEntry(text: string): Promise<boolean> {
    const transcript = text.trim();
    if (!transcript) return false;
    const now = new Date();
    const iso = now.toISOString();
    const entry: LocalEntry = {
      id: newId(),
      day: dayKey(now),
      createdAt: iso,
      updatedAt: iso,
      source: 'text',
      transcript,
      local: { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 },
    };
    try {
      await this.services.db.putEntry(entry);
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
      return false;
    }
    this.textDraft = '';
    await this.reload();
    this.toast('Entrée enregistrée.', 'success');
    void this.runSync();
    return true;
  }

  /** Correction de la transcription → ré-analyse à partir du texte corrigé. */
  async updateTranscript(id: string, text: string): Promise<boolean> {
    const transcript = text.trim();
    if (!transcript) return false;
    const { db } = this.services;
    const e = await db.getEntry(id);
    if (!e) return false;
    if (e.transcript === transcript) return true;
    await db.putEntry({
      ...e,
      transcript,
      transcriptEdited: true,
      updatedAt: new Date().toISOString(),
      local: withFreshAnalysis(e.local, true),
    });
    await this.reload();
    this.toast('Correction enregistrée, nouvelle analyse en cours.', 'success');
    void this.runSync();
    return true;
  }

  async deleteEntry(id: string): Promise<void> {
    const { db } = this.services;
    const e = await db.getEntry(id);
    if (!e) return;
    await db.deleteEntry(id);
    await db.deleteAudio(id);
    const remoteIds = [e.local.driveFileId, e.audioFileId].filter((x): x is string => !!x);
    if (remoteIds.length > 0) {
      // Sous verrou : la synchro réécrit aussi cette liste (voir db.ts, updateKv).
      await updateKv(db, KV_PENDING_DELETES, (cur) => [...new Set([...kvStrings(cur), ...remoteIds])]);
    }
    this.releaseAudio(id);
    await this.reload();
    this.toast('Entrée supprimée.', 'info');
    void this.runSync();
  }

  async retryEntry(id: string): Promise<void> {
    const { db } = this.services;
    const e = await db.getEntry(id);
    if (!e) return;
    await db.putEntry({ ...e, local: withFreshAnalysis(e.local, false) });
    await this.reload();
    await this.runSync({ force: true });
  }

  /* ================================================================== */
  /* Synthèses                                                           */
  /* ================================================================== */

  /** « Générer maintenant » / « Régénérer » pour un jour. */
  async requestSynthesis(day: DayKey): Promise<void> {
    const { db } = this.services;
    if (this.synthesisRequested.includes(day)) return;
    this.synthesisRequested = [...this.synthesisRequested, day];
    const before = this.syntheses[day]?.generatedAt;
    try {
      // Jour forcé : la synchro le (re)génère même si la signature n'a pas changé
      await updateKv(db, KV_FORCE_SYNTHESIS, (cur) => {
        const days = kvStrings(cur);
        return days.includes(day) ? days : [...days, day];
      });
      await this.runSync();
      await this.reload();
      const after = this.syntheses[day]?.generatedAt;
      const s = this.syncStatus;
      if (after && after !== before) this.toast('Synthèse prête.', 'success');
      else if (s.lastError) this.toast(s.lastError, 'error');
      else if (!this.online) this.toast('Synthèse en attente : tu es hors ligne.', 'info');
      else if (s.needsAuth) this.toast('Synthèse en attente : reconnecte-toi à Google.', 'info');
      else if (s.needsKey) this.toast('Synthèse impossible : Gemini refuse ta clé. Vérifie-la dans les réglages.', 'error');
      else if (this.getDay(day).entries.some((e) => e.local.needsAnalysis)) {
        // Le jour reste demandé (sync.forceSynthesisDays) : la synthèse suivra les analyses.
        this.toast('La synthèse sera écrite dès que toutes les entrées du jour seront analysées.', 'info');
      }
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
    } finally {
      this.synthesisRequested = this.synthesisRequested.filter((d) => d !== day);
    }
  }

  /* ================================================================== */
  /* Audio                                                               */
  /* ================================================================== */

  /** URL lisible par <audio> : blob local, sinon téléchargé depuis Drive (cache mémoire). */
  async audioUrl(entry: LocalEntry): Promise<string | null> {
    const cached = this.audioUrls.get(entry.id);
    if (cached) return cached;
    let blob = await this.services.db.getAudio(entry.id);
    if (!blob && entry.audioFileId) blob = await this.services.drive.downloadBlob(entry.audioFileId);
    if (!blob) return null;
    if (!blob.type && entry.audioMime) blob = new Blob([blob], { type: entry.audioMime });
    const url = URL.createObjectURL(blob);
    this.audioUrls.set(entry.id, url);
    return url;
  }

  /** Révoque l'URL d'une entrée (ou toutes). */
  releaseAudio(id?: string): void {
    for (const [key, url] of this.audioUrls) {
      if (id === undefined || key === id) {
        URL.revokeObjectURL(url);
        this.audioUrls.delete(key);
      }
    }
  }

  /* ================================================================== */
  /* Réglages                                                            */
  /* ================================================================== */

  async saveSettings(patch: Partial<Settings>, quiet = false): Promise<boolean> {
    try {
      this.settings = await storeSettings(this.services.db, patch);
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
      return false;
    }
    if (!quiet) this.toast('Réglage enregistré.', 'success');
    void this.runSync();
    return true;
  }

  /**
   * Vérifie une clé Gemini puis l'enregistre si elle est acceptée (ou si la
   * vérification est impossible faute de réseau).
   */
  async checkGeminiKey(key: string): Promise<KeyCheckResult> {
    const geminiApiKey = key.trim();
    if (!geminiApiKey) return { ok: false, message: 'Colle ta clé Gemini dans le champ.' };
    let message = 'Clé vérifiée et enregistrée.';
    try {
      await this.services.createAi({ ...this.settings, geminiApiKey }, 'entry').checkKey();
    } catch (e) {
      const err = toAppError(e);
      if (err.kind === 'invalid-key') {
        // gemini.ts précise certains refus (clé limitée à d'autres sites, API non activée) :
        // ce message-là est plus utile que le texte générique.
        const specific = /depuis ce site|pas activée/.test(err.message);
        return {
          ok: false,
          message: specific
            ? err.message
            : "Clé Gemini refusée. Vérifie que tu l'as copiée en entier, ou crée une nouvelle clé dans AI Studio.",
        };
      }
      if (err.kind !== 'network') return { ok: false, message: err.message };
      message = 'Clé enregistrée. Vérification impossible sans connexion : elle sera testée plus tard.';
    }
    const saved = await this.saveSettings({ geminiApiKey }, true);
    if (!saved) return { ok: false, message: "La clé n'a pas pu être enregistrée." };
    // Les analyses bloquées faute de clé repartent tout de suite
    void this.runSync({ force: true });
    return { ok: true, message };
  }

  /** « Plus tard » sur l'écran de clé : ne plus le montrer aujourd'hui. */
  dismissKeySetup(): void {
    this.keyLaterDay = this.today;
    writeLocal(LS_KEY_LATER, this.today);
  }

  /* ================================================================== */
  /* Sauvegarde                                                          */
  /* ================================================================== */

  async exportZip(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    try {
      const { blob, filename } = await buildExportZip(this.services.db);
      downloadBlob(blob, filename);
      this.toast('Export prêt : regarde dans tes téléchargements.', 'success');
    } catch (e) {
      this.toast(toAppError(e).message, 'error');
    } finally {
      this.exporting = false;
    }
  }

  /* ================================================================== */
  /* Notifications                                                       */
  /* ================================================================== */

  toast(message: string, kind: Toast['kind'] = 'info', ms?: number): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, message, kind }].slice(-3);
    setTimeout(() => this.dismissToast(id), ms ?? (kind === 'error' ? 6500 : 3500));
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

const [getAppContext, setAppContext] = createContext<AppController>();

/** À appeler dans un composant pour récupérer le contrôleur. */
export const useApp: () => AppController = getAppContext;
/** À appeler une fois, à l'initialisation du composant racine. */
export const provideApp: (app: AppController) => AppController = setAppContext;
