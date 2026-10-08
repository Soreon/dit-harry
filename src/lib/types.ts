/**
 * Contrat partagé de Dit Harry : modèle de données + interfaces des services.
 * Toute implémentation (réelle ou mock) DOIT respecter ces signatures.
 * Voir docs/SPEC.md pour le comportement attendu.
 */

/* ------------------------------------------------------------------ */
/* Modèle de données                                                   */
/* ------------------------------------------------------------------ */

/** Jour calendaire LOCAL au format 'YYYY-MM-DD'. */
export type DayKey = string;
/** Date ISO 8601 UTC (`new Date().toISOString()`). */
export type ISODate = string;

/** Humeur : score de -2 (très mal) à +2 (très bien) + libellé court en français. */
export interface Mood {
  score: -2 | -1 | 0 | 1 | 2;
  label: string;
}

/** Analyse d'une entrée, produite par Gemini. */
export interface EntryAnalysis {
  title: string;
  summary: string;
  mood: Mood;
  themes: string[];
  people: string[];
  places: string[];
  todos: string[];
  /**
   * Faits que l'entrée situe sur un AUTRE jour précis (« avant-hier », « demain »…), rattachés à
   * ce jour-là. Facultatif (absent des entrées plus anciennes ou sans mention). Voir SPEC §16.
   */
  mentions?: DayMention[];
}

/** past : fait raconté après coup (jour visé < jour de l'entrée) ; future : chose prévue. */
export type DayMentionKind = 'past' | 'future';

/**
 * auto : rattaché d'office (repère sans ambiguïté) ; proposed : jour à choisir parmi `choices` ;
 * confirmed : choisi, déplacé ou corrigé par l'utilisateur ; dismissed : retiré par l'utilisateur.
 * Seuls auto et confirmed apparaissent sur le jour visé. confirmed et dismissed survivent à une
 * nouvelle analyse de l'entrée.
 */
export type DayMentionStatus = 'auto' | 'proposed' | 'confirmed' | 'dismissed';

/** Mention d'un autre jour, portée par l'entrée qui la contient (jamais copiée ailleurs). */
export interface DayMention {
  /** 8 caractères, stable (interface, références des synthèses). */
  id: string;
  kind: DayMentionKind;
  /** Jour visé ; '' tant qu'une proposition n'est pas tranchée. */
  day: DayKey;
  /** Repère de temps tel que dit (≤ 60 caractères), ex. « avant-hier ». */
  when: string;
  /** Le fait, en 1 ou 2 phrases à la première personne (≤ 300 caractères). */
  text: string;
  status: DayMentionStatus;
  /** Jours possibles d'une proposition (1 à 3). */
  choices?: DayKey[];
  /** Date donnée par le modèle pour une proposition : toujours parmi `choices`, choix suggéré. */
  modelDay?: DayKey;
  /**
   * Moment du dernier geste de l'utilisateur sur cette mention (choisir, déplacer, modifier,
   * retirer, rétablir). Les gestes ne touchent pas `updatedAt` : c'est lui qui départage deux
   * appareils qui ont chacun changé la même mention.
   */
  decidedAt?: ISODate;
}

/** Réglage « Rattacher aux autres jours » : automatique (défaut) ou désactivé. */
export type DayLinksMode = 'auto' | 'off';

/** Verdict de la synthèse du jour visé sur un fait raconté plus tard. */
export type MentionVerdict = 'nouveau' | 'complete' | 'deja';

/**
 * Mention active d'une entrée, vue depuis le jour qu'elle vise. Dérivée des entrées à la
 * lecture (`collectDayLinks`), jamais stockée.
 */
export interface DayLink {
  entryId: string;
  /** Jour de l'entrée qui contient la mention. */
  sourceDay: DayKey;
  sourceCreatedAt: ISODate;
  /** `kind` recalculé d'après le jour visé. */
  mention: DayMention;
  /** `${entryId}/${mention.id}` : clé des verdicts de synthèse et de l'interface. */
  ref: string;
  /** Même fait déjà rattaché à ce jour par une entrée précédente (sa `ref`). */
  repeatOf?: string;
}

export type EntrySource = 'voice' | 'text';

/**
 * Entrée de journal telle que stockée dans Drive (`entry-<id>.json`, appDataFolder).
 * Ne contient AUCUN champ local (pas de `local`).
 */
export interface Entry {
  id: string;
  day: DayKey;
  createdAt: ISODate;
  updatedAt: ISODate;
  source: EntrySource;
  /** Voix uniquement. */
  durationSec?: number;
  /** MIME de l'audio sans paramètres (ex. 'audio/webm'). */
  audioMime?: string;
  /** Id Drive du fichier audio `audio-<id>.<ext>` (appDataFolder), null si pas (encore) envoyé. */
  audioFileId?: string | null;
  /** true quand l'audio a été supprimé par la rétention glissante. */
  audioExpired?: boolean;
  /** Transcription nettoyée (voix) ou texte saisi (texte). '' tant que non transcrit. */
  transcript: string;
  /** true si l'utilisateur a corrigé la transcription à la main. */
  transcriptEdited?: boolean;
  analysis?: EntryAnalysis;
  analysisModel?: string;
  analyzedAt?: ISODate;
}

export type ErrorKind =
  | 'auth' // jeton Google absent/expiré
  | 'invalid-key' // clé Gemini absente ou refusée
  | 'quota' // 429 / quota dépassé
  | 'safety' // réponse bloquée par les filtres
  | 'network' // hors ligne / erreur réseau / 5xx
  | 'bad-response' // réponse illisible / JSON invalide
  | 'other';

/** État purement local d'une entrée (jamais envoyé à Drive). */
export interface EntryLocalState {
  /** L'entrée JSON doit être (ré)écrite dans Drive. */
  dirty: boolean;
  /** Analyse Gemini à faire (ou à refaire). */
  needsAnalysis: boolean;
  /** L'audio est présent dans le store IndexedDB `audio` (pas encore envoyé, ou cache). */
  hasLocalAudio: boolean;
  /** Id Drive du fichier `entry-<id>.json`. */
  driveFileId?: string;
  /** modifiedTime Drive de la dernière version connue (pull/push). */
  remoteModifiedTime?: string;
  /** Nombre d'échecs consécutifs d'analyse. */
  attempts: number;
  /** Dernière erreur, message en français pour l'utilisateur. */
  error?: string;
  errorKind?: ErrorKind;
  /** Ne pas retenter automatiquement avant cette date (backoff). */
  retryAfter?: ISODate;
}

export interface LocalEntry extends Entry {
  local: EntryLocalState;
}

/** Synthèse d'une journée (`day-<YYYY-MM-DD>.json`, appDataFolder). */
export interface DaySynthesis {
  day: DayKey;
  generatedAt: ISODate;
  model: string;
  /** Signature des entrées utilisées (voir `entriesSignature`). Si elle change → régénérer. */
  basedOn: string;
  summary: string;
  mood: Mood;
  highlights: string[];
  themes: string[];
  todos: string[];
  /**
   * Faits racontés plus tard intégrés à cette synthèse : `ref` (`${entryId}/${mentionId}`) →
   * verdict (nouveau, complète, déjà présent). Facultatif.
   */
  mentionVerdicts?: Record<string, MentionVerdict>;
}

export interface SynthesisLocalState {
  dirty: boolean;
  driveFileId?: string;
  remoteModifiedTime?: string;
  error?: string;
  errorKind?: ErrorKind;
  retryAfter?: ISODate;
}

export interface LocalSynthesis extends DaySynthesis {
  local: SynthesisLocalState;
}

/** Réglages, synchronisés dans Drive (`settings.json`, appDataFolder) + copie locale. */
export interface Settings {
  geminiApiKey: string;
  entryModel: string;
  synthesisModel: string;
  /** Copie automatique en Markdown dans un dossier Drive visible « Dit Harry ». */
  mirrorEnabled: boolean;
  audioRetentionDays: number;
  /** « Rattacher aux autres jours » (absent = 'auto'). */
  dayLinks?: DayLinksMode;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Stockage local (IndexedDB)                                          */
/* ------------------------------------------------------------------ */

export interface RecordingChunk {
  recordingId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  /** Date de début de l'enregistrement (pour la récupération après crash). */
  startedAt: ISODate;
}

export interface LocalDb {
  // Entrées
  getEntry(id: string): Promise<LocalEntry | undefined>;
  putEntry(entry: LocalEntry): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  listEntries(): Promise<LocalEntry[]>;
  listEntriesByDay(day: DayKey): Promise<LocalEntry[]>;
  // Synthèses
  getSynthesis(day: DayKey): Promise<LocalSynthesis | undefined>;
  putSynthesis(s: LocalSynthesis): Promise<void>;
  deleteSynthesis(day: DayKey): Promise<void>;
  listSyntheses(): Promise<LocalSynthesis[]>;
  // Audio (blob complet par entrée)
  putAudio(entryId: string, blob: Blob): Promise<void>;
  getAudio(entryId: string): Promise<Blob | undefined>;
  deleteAudio(entryId: string): Promise<void>;
  // Morceaux d'enregistrement en cours (récupération après crash)
  putChunk(chunk: RecordingChunk): Promise<void>;
  getChunks(recordingId: string): Promise<RecordingChunk[]>;
  listRecordingIds(): Promise<string[]>;
  deleteChunks(recordingId: string): Promise<void>;
  // Clé/valeur divers (réglages locaux, état de synchro, miroir…)
  getKv<T>(key: string): Promise<T | undefined>;
  setKv<T>(key: string, value: T): Promise<void>;
  deleteKv(key: string): Promise<void>;
  /** Efface toute la base (déconnexion « oublier cet appareil »). */
  clearAll(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Authentification Google (GIS token model)                           */
/* ------------------------------------------------------------------ */

export type AuthStatus =
  | 'loading' // script GIS en cours de chargement
  | 'signed-out' // jamais connecté sur cet appareil (ou déconnecté)
  | 'signing-in' // popup ouverte
  | 'signed-in' // jeton valide
  | 'expired' // déjà connecté, mais jeton expiré → bouton « Se reconnecter »
  | 'error';

export interface AuthState {
  status: AuthStatus;
  email?: string;
  name?: string;
  /** epoch ms */
  expiresAt?: number;
  error?: string;
}

export interface AuthService {
  /** Charge le script GIS et restaure l'état (email mémorisé, jeton sessionStorage encore valide). */
  init(): Promise<void>;
  getState(): AuthState;
  /** S'abonne aux changements ; appelle immédiatement `cb` avec l'état courant. Retourne la désinscription. */
  subscribe(cb: (s: AuthState) => void): () => void;
  /**
   * Ouvre la popup Google. DOIT être appelé de façon SYNCHRONE dans un gestionnaire de clic
   * (sinon Chrome Android bloque la popup). Résout quand le jeton est obtenu, rejette sinon.
   */
  signIn(): Promise<void>;
  /** Jeton valide (marge `tokenExpiryMarginMs` incluse) ou null. Ne déclenche jamais de popup. */
  getToken(): string | null;
  /** À appeler quand une API répond 401 : invalide le jeton, état → 'expired'. */
  markExpired(): void;
  /** Révoque le jeton et oublie le compte sur cet appareil. */
  signOut(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Google Drive (REST v3)                                              */
/* ------------------------------------------------------------------ */

export type AppDataKind = 'entry' | 'audio' | 'synthesis' | 'settings';

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  size?: string;
  appProperties?: Record<string, string>;
}

export interface DriveClient {
  /** Utilisateur connecté (about.get?fields=user). */
  about(): Promise<{ email: string; name: string }>;
  /** TOUS les fichiers de l'appDataFolder (pagination gérée), non supprimés. */
  listAppData(): Promise<DriveFileMeta[]>;
  downloadJson<T>(fileId: string): Promise<T>;
  downloadBlob(fileId: string): Promise<Blob>;
  /** Crée un fichier dans appDataFolder (multipart ≤ 5 Mo, resumable au-delà). */
  createAppDataFile(
    name: string,
    body: Blob | string,
    mimeType: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFileMeta>;
  /** Remplace le contenu d'un fichier existant. */
  updateFileContent(fileId: string, body: Blob | string, mimeType: string): Promise<DriveFileMeta>;
  /** Suppression définitive (404 considéré comme succès). */
  deleteFile(fileId: string): Promise<void>;
  /** Copie visible (drive.file) : trouve ou crée un dossier créé par l'appli. Retourne son id. */
  ensureFolder(name: string, parentId?: string): Promise<string>;
  /** Copie visible : crée ou met à jour un fichier texte. Retourne son id. */
  upsertTextFile(
    parentId: string,
    name: string,
    content: string,
    mimeType: string,
    existingId?: string,
  ): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

export interface EntryContext {
  day: DayKey;
  /** Heure locale 'HH:mm'. */
  time: string;
  /**
   * 'auto' : détecter les mentions d'autres jours (consigne, repères et champ `mentions`).
   * Absent ou 'off' : requête sans rien de tout cela (0 token de plus).
   */
  dayLinks?: DayLinksMode;
}

/** Résultat d'une synthèse de jour (verdicts seulement si des faits racontés plus tard sont fournis). */
export type SynthesisResult = Pick<DaySynthesis, 'summary' | 'mood' | 'highlights' | 'themes' | 'todos'> & {
  mentionVerdicts?: Record<string, MentionVerdict>;
};

export interface AiClient {
  /** Audio → transcription nettoyée + analyse, en un seul appel (modèle d'entrée). */
  analyzeAudio(
    audio: Blob,
    mimeType: string,
    ctx: EntryContext,
  ): Promise<{ transcript: string; analysis: EntryAnalysis }>;
  /** Texte (saisi ou corrigé) → analyse (modèle d'entrée). */
  analyzeText(text: string, ctx: EntryContext): Promise<EntryAnalysis>;
  /**
   * Entrées analysées d'un jour → synthèse (modèle de synthèse). `links` : notes d'autres jours
   * qui visent ce jour (faits racontés plus tard, choses prévues) ; facultatif.
   */
  synthesizeDay(day: DayKey, entries: Entry[], links?: DayLink[]): Promise<SynthesisResult>;
  /** Vérifie la clé (appel léger). Lève AppError('invalid-key') si refusée. */
  checkKey(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Enregistreur                                                        */
/* ------------------------------------------------------------------ */

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecordingResult {
  recordingId: string;
  blob: Blob;
  /** MIME sans paramètres (ex. 'audio/webm'). */
  mimeType: string;
  durationSec: number;
  startedAt: ISODate;
  /** true si l'arrêt n'a pas été demandé par l'utilisateur (arrière-plan, limite de durée, piste coupée). */
  interrupted: boolean;
}

export interface RecorderCallbacks {
  /** Niveau sonore 0..1, ~20 fois/s. */
  onLevel?(level: number): void;
  /** Secondes écoulées, 1 fois/s. */
  onTick?(seconds: number): void;
  /** Arrêt non demandé (voir RecordingResult.interrupted) — le résultat est fourni. */
  onAutoStop?(result: RecordingResult): void;
}

export interface VoiceRecorder {
  readonly status: RecorderStatus;
  /** Demande le micro et démarre. Lève AppError en cas de refus / micro indisponible. */
  start(cb?: RecorderCallbacks): Promise<void>;
  stop(): Promise<RecordingResult>;
  /** Abandonne et supprime les morceaux. */
  cancel(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Synchronisation                                                     */
/* ------------------------------------------------------------------ */

export type SyncPhase =
  | 'idle'
  | 'analyzing'
  | 'pulling'
  | 'pushing'
  | 'synthesizing'
  | 'housekeeping'
  | 'mirroring';

/**
 * Le compte Google connecté n'est pas celui à qui appartiennent les données de cet appareil :
 * la synchronisation Drive est suspendue jusqu'au choix de l'utilisateur.
 */
export interface AccountConflict {
  /** Compte propriétaire des données locales ; absent s'il est inconnu (données plus anciennes). */
  owner?: string;
  /** Compte du jeton Google actuel. */
  current: string;
}

export interface SyncStatus {
  running: boolean;
  phase: SyncPhase;
  /** Entrées non analysées ou non envoyées. */
  pendingCount: number;
  lastSyncAt?: ISODate;
  lastError?: string;
  lastErrorKind?: ErrorKind;
  /** true si un jeton Google est requis pour continuer (bandeau « Se reconnecter »). */
  needsAuth: boolean;
  /** true si la clé Gemini manque ou est refusée. */
  needsKey: boolean;
  /** Défini si le compte connecté n'est pas le propriétaire des données locales (Drive en pause). */
  accountConflict?: AccountConflict;
}

export interface SyncEngine {
  /** Cycle complet ; un seul à la fois (appels concurrents → même promesse). */
  run(opts?: { force?: boolean }): Promise<void>;
  getStatus(): SyncStatus;
  subscribe(cb: (s: SyncStatus) => void): () => void;
  /** Notifié après toute modification de données locales par la synchro (pour rafraîchir l'UI). */
  onDataChanged(cb: () => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Conteneur de services                                               */
/* ------------------------------------------------------------------ */

export interface Services {
  db: LocalDb;
  auth: AuthService;
  /** Client Drive : lit le jeton via auth.getToken() à chaque appel ; lève AppError('auth') sans jeton. */
  drive: DriveClient;
  /** Fabrique un client Gemini pour un modèle donné ; lève AppError('invalid-key') si clé vide. */
  createAi(settings: Settings, which: 'entry' | 'synthesis'): AiClient;
  createRecorder(): VoiceRecorder;
  sync: SyncEngine;
}
