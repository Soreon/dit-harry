import { config } from '../config';
import { AppError, isAppError } from './errors';
import type {
  LocalDb,
  RecorderCallbacks,
  RecorderStatus,
  RecordingChunk,
  RecordingResult,
  VoiceRecorder,
} from './types';
import { newId, stripMimeParams } from './util';

/**
 * Enregistreur vocal (cible : Chrome Android) — voir docs/SPEC.md §7.
 * - MediaRecorder avec `timeslice` : chaque morceau est écrit tout de suite dans IndexedDB
 *   (store `chunks`) pour pouvoir récupérer l'enregistrement après un plantage ;
 * - niveau sonore via AudioContext + AnalyserNode ;
 * - Wake Lock écran pendant l'enregistrement ;
 * - arrêt automatique en arrière-plan, piste coupée ou durée maximale atteinte.
 */

/** Formats essayés, par ordre de préférence. */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** Si le navigateur ne dit rien du format produit (cas improbable). */
const FALLBACK_MIME = 'audio/webm';
/** Période de mise à jour du niveau sonore (~20 Hz) et de vérification du chrono. */
const LEVEL_INTERVAL_MS = 50;
/** Délai max. d'attente de l'événement `stop` du MediaRecorder. */
const STOP_TIMEOUT_MS = 4_000;
/** Plancher du vu-mètre (dBFS) : en dessous → 0. */
const LEVEL_FLOOR_DB = -60;

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

const MSG = {
  unsupported: "Ton navigateur ne permet pas d'enregistrer.",
  denied: 'Accès au micro refusé. Autorise le micro pour Dit Harry dans les réglages du navigateur.',
  noMic: 'Aucun micro détecté.',
  busy: 'Le micro est utilisé par une autre application.',
  micOther: "Impossible d'accéder au micro.",
  startFailed: "Impossible de démarrer l'enregistrement.",
  alreadyRunning: 'Un enregistrement est déjà en cours.',
  notRecording: 'Aucun enregistrement en cours.',
  cancelled: 'Enregistrement annulé.',
  hidden: "L'enregistrement n'a pas démarré : l'appli est passée en arrière-plan.",
} as const;

/** Premier format supporté parmi les candidats, sinon '' (format par défaut du navigateur). */
export function pickRecordingMimeType(isTypeSupported: (t: string) => boolean): string {
  for (const type of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // certains navigateurs lèvent une exception pour un type inconnu : on passe au suivant
    }
  }
  return '';
}

/** Niveau instantané 0..1 d'un bloc d'échantillons (RMS en dBFS, plancher -60 dB). */
export function rmsLevel(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

/** Traduit une erreur de getUserMedia en message français. */
function microphoneError(e: unknown): AppError {
  const name =
    typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new AppError('other', MSG.denied, { retryable: false, cause: e });
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new AppError('other', MSG.noMic, { retryable: false, cause: e });
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new AppError('other', MSG.busy, { retryable: false, cause: e });
    default:
      return new AppError('other', MSG.micOther, { retryable: false, cause: e });
  }
}

function getMediaRecorderCtor(): typeof MediaRecorder | undefined {
  return typeof MediaRecorder === 'function' ? MediaRecorder : undefined;
}

function getMediaDevices(): MediaDevices | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  return md && typeof md.getUserMedia === 'function' ? md : undefined;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return g.AudioContext ?? g.webkitAudioContext;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // piste déjà arrêtée
    }
  }
}

/** Crée le MediaRecorder ; si le format demandé est refusé, retombe sur le format par défaut. */
function createMediaRecorder(
  Ctor: typeof MediaRecorder,
  stream: MediaStream,
  mimeType: string,
  audioBitsPerSecond: number,
): MediaRecorder {
  const attempts: MediaRecorderOptions[] = [];
  if (mimeType) attempts.push({ mimeType, audioBitsPerSecond });
  attempts.push({ audioBitsPerSecond }, {});
  let lastError: unknown;
  for (const options of attempts) {
    try {
      return new Ctor(stream, options);
    } catch (e) {
      lastError = e;
    }
  }
  throw new AppError('other', MSG.unsupported, { retryable: false, cause: lastError });
}

/** Appelle un callback de l'UI sans laisser une exception casser l'enregistrement. */
function notify(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('[recorder] callback', e);
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Session {
  id: string;
  startedAt: Date;
  /** Date.now() au démarrage (la durée vient de l'horloge, pas de l'audio). */
  startMs: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  /** MIME sans paramètres ('' tant qu'inconnu). */
  mimeType: string;
  cb: RecorderCallbacks;
  /** Copie mémoire des morceaux, dans l'ordre. */
  blobs: Blob[];
  nextIndex: number;
  /** File des écritures IndexedDB (séquentielle). */
  writes: Promise<void>;
  /** Résolue à l'événement `stop` du MediaRecorder. */
  stopped: Promise<void>;
  audioCtx?: AudioContext;
  analyser?: AnalyserNode;
  samples?: Float32Array<ArrayBuffer>;
  level: number;
  lastSecond: number;
  levelTimer?: ReturnType<typeof setInterval>;
  maxTimer?: ReturnType<typeof setTimeout>;
  wakeLock?: WakeLockSentinel;
  /** Désinscriptions des écouteurs (document, pistes). */
  cleanups: (() => void)[];
  /** Arrêt en cours (même promesse pour tous les appelants). */
  finishing?: Promise<RecordingResult>;
  /** Le résultat d'un arrêt automatique doit être livré à `onAutoStop`. */
  deliverAutoStop: boolean;
  /** Résultat assemblé : tout morceau tardif est ignoré. */
  closed: boolean;
}

interface StartAttempt {
  cancelled: boolean;
  done: Promise<void>;
}

export function createVoiceRecorder(
  db: LocalDb,
  opts: { audioBitsPerSecond?: number; maxDurationSec?: number; timesliceMs?: number } = {},
): VoiceRecorder {
  const audioBitsPerSecond = opts.audioBitsPerSecond ?? config.audioBitsPerSecond;
  const maxDurationSec = opts.maxDurationSec ?? config.maxRecordingSec;
  const timesliceMs = opts.timesliceMs ?? config.recorderTimesliceMs;

  let status: RecorderStatus = 'idle';
  let session: Session | null = null;
  let starting: StartAttempt | null = null;

  function isCurrent(s: Session): boolean {
    return session === s && status === 'recording';
  }

  /* ---------------------------- morceaux ---------------------------- */

  function onData(s: Session, ev: BlobEvent): void {
    const blob = ev.data as Blob | undefined;
    if (s.closed || !blob || blob.size === 0) return;
    if (!s.mimeType && blob.type) s.mimeType = stripMimeParams(blob.type);
    const chunk: RecordingChunk = {
      recordingId: s.id,
      index: s.nextIndex++,
      blob,
      mimeType: s.mimeType || FALLBACK_MIME,
      startedAt: s.startedAt.toISOString(),
    };
    s.blobs.push(blob);
    // Écritures en série : un échec n'empêche ni la suite ni l'enregistrement (copie mémoire).
    s.writes = s.writes
      .then(() => db.putChunk(chunk))
      .catch((e: unknown) => console.warn('[recorder] écriture du morceau impossible', e));
  }

  /* --------------------------- niveau sonore ------------------------ */

  function setupLevelMeter(s: Session): void {
    const Ctx = getAudioContextCtor();
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      s.audioCtx = ctx;
      const source = ctx.createMediaStreamSource(s.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Pas de connexion à la sortie : on mesure sans renvoyer le son dans le haut-parleur.
      source.connect(analyser);
      s.analyser = analyser;
      s.samples = new Float32Array(analyser.fftSize);
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch (e) {
      // vu-mètre indisponible : on enregistre quand même
      console.warn('[recorder] vu-mètre indisponible', e);
    }
  }

  function sampleLevel(s: Session): void {
    if (!s.analyser || !s.samples) return;
    s.analyser.getFloatTimeDomainData(s.samples);
    const raw = rmsLevel(s.samples);
    // Lissage : montée rapide, descente plus douce.
    s.level += (raw - s.level) * (raw > s.level ? 0.5 : 0.15);
    const level = s.level < 0.001 ? 0 : Math.min(1, s.level);
    notify(() => s.cb.onLevel?.(level));
  }

  function onInterval(s: Session): void {
    if (!isCurrent(s)) return;
    sampleLevel(s);
    const seconds = Math.floor((Date.now() - s.startMs) / 1000);
    if (seconds !== s.lastSecond) {
      s.lastSecond = seconds;
      notify(() => s.cb.onTick?.(seconds));
    }
  }

  /* ----------------------------- Wake Lock -------------------------- */

  async function acquireWakeLock(s: Session): Promise<void> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || !navigator.wakeLock) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!isCurrent(s) || (s.wakeLock && !s.wakeLock.released)) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      s.wakeLock = sentinel;
    } catch {
      // échec silencieux (batterie faible, navigateur non compatible…)
    }
  }

  function releaseWakeLock(s: Session): void {
    const sentinel = s.wakeLock;
    s.wakeLock = undefined;
    if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
  }

  /* ------------------------------ arrêt ----------------------------- */

  function clearTimers(s: Session): void {
    if (s.levelTimer !== undefined) clearInterval(s.levelTimer);
    if (s.maxTimer !== undefined) clearTimeout(s.maxTimer);
    s.levelTimer = undefined;
    s.maxTimer = undefined;
  }

  function teardown(s: Session): void {
    for (const off of s.cleanups.splice(0)) off();
    clearTimers(s);
    stopTracks(s.stream);
    releaseWakeLock(s);
    const ctx = s.audioCtx;
    s.audioCtx = undefined;
    s.analyser = undefined;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }

  /** Arrête l'enregistrement et assemble le résultat (une seule fois par session). */
  function finish(s: Session, interrupted: boolean): Promise<RecordingResult> {
    if (s.finishing) return s.finishing;
    status = 'stopping';
    const endMs = Date.now();
    clearTimers(s);
    s.finishing = (async (): Promise<RecordingResult> => {
      try {
        if (s.recorder.state !== 'inactive') {
          try {
            s.recorder.stop(); // → dernier `dataavailable`, puis `stop`
          } catch {
            // déjà arrêté
          }
        }
        await withTimeout(s.stopped, STOP_TIMEOUT_MS);
        // Tous les morceaux sont en base avant de rendre la main (le contrôleur les supprime ensuite).
        await s.writes;
        const mimeType = s.mimeType || FALLBACK_MIME;
        return {
          recordingId: s.id,
          blob: new Blob(s.blobs, { type: mimeType }),
          mimeType,
          durationSec: Math.max(0, Math.round((endMs - s.startMs) / 100) / 10),
          startedAt: s.startedAt.toISOString(),
          interrupted,
        };
      } finally {
        s.closed = true;
        teardown(s);
        if (session === s) {
          session = null;
          status = 'idle';
        }
      }
    })();
    return s.finishing;
  }

  /** Arrêt non demandé : le résultat part vers `onAutoStop`. */
  function autoStop(s: Session): void {
    if (!isCurrent(s)) return;
    s.deliverAutoStop = true;
    finish(s, true).then(
      (result) => {
        if (s.deliverAutoStop) notify(() => s.cb.onAutoStop?.(result));
      },
      (e: unknown) => console.error('[recorder] arrêt automatique', e),
    );
  }

  /* ----------------------------- démarrage -------------------------- */

  function begin(stream: MediaStream, Ctor: typeof MediaRecorder, cb: RecorderCallbacks): void {
    const requested = pickRecordingMimeType((t) =>
      typeof Ctor.isTypeSupported === 'function' ? Ctor.isTypeSupported(t) : false,
    );
    const recorder = createMediaRecorder(Ctor, stream, requested, audioBitsPerSecond);

    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });

    const startedAt = new Date();
    const s: Session = {
      id: newId(),
      startedAt,
      startMs: startedAt.getTime(),
      stream,
      recorder,
      mimeType: '',
      cb,
      blobs: [],
      nextIndex: 0,
      writes: Promise.resolve(),
      stopped,
      level: 0,
      lastSecond: 0,
      cleanups: [],
      deliverAutoStop: false,
      closed: false,
    };

    recorder.addEventListener('dataavailable', (ev) => onData(s, ev));
    recorder.addEventListener('stop', () => {
      resolveStopped();
      // Arrêt venu du navigateur (erreur d'encodage, micro coupé…)
      autoStop(s);
    });
    recorder.addEventListener('error', () => autoStop(s));

    recorder.start(timesliceMs);
    s.mimeType = stripMimeParams(recorder.mimeType || requested);

    session = s;
    status = 'recording';

    setupLevelMeter(s);
    s.levelTimer = setInterval(() => onInterval(s), LEVEL_INTERVAL_MS);
    if (maxDurationSec > 0) s.maxTimer = setTimeout(() => autoStop(s), maxDurationSec * 1000);

    if (typeof document !== 'undefined') {
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') {
          autoStop(s);
        } else if (isCurrent(s) && (!s.wakeLock || s.wakeLock.released)) {
          void acquireWakeLock(s);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      s.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    const onTrackEnded = (): void => autoStop(s);
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', onTrackEnded);
      s.cleanups.push(() => track.removeEventListener('ended', onTrackEnded));
    }

    void acquireWakeLock(s);
    notify(() => cb.onTick?.(0));
  }

  async function doStart(cb: RecorderCallbacks, attempt: StartAttempt): Promise<void> {
    const Ctor = getMediaRecorderCtor();
    const mediaDevices = getMediaDevices();
    if (!Ctor || !mediaDevices) {
      status = 'idle';
      throw new AppError('other', MSG.unsupported, { retryable: false });
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    } catch (e) {
      status = 'idle';
      throw microphoneError(e);
    }

    if (attempt.cancelled) {
      stopTracks(stream);
      status = 'idle';
      throw new AppError('other', MSG.cancelled, { retryable: false });
    }
    // Appli passée en arrière-plan pendant la demande d'autorisation : on ne démarre pas.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      stopTracks(stream);
      status = 'idle';
      throw new AppError('other', MSG.hidden, { retryable: false });
    }

    try {
      begin(stream, Ctor, cb);
    } catch (e) {
      if (session) teardown(session);
      else stopTracks(stream);
      session = null;
      status = 'idle';
      throw isAppError(e) ? e : new AppError('other', MSG.startFailed, { retryable: false, cause: e });
    }
  }

  /* ------------------------------ API ------------------------------- */

  function start(cb: RecorderCallbacks = {}): Promise<void> {
    if (status !== 'idle') {
      return Promise.reject(new AppError('other', MSG.alreadyRunning, { retryable: false }));
    }
    status = 'starting';
    const attempt: StartAttempt = { cancelled: false, done: Promise.resolve() };
    starting = attempt;
    const done = doStart(cb, attempt).finally(() => {
      if (starting === attempt) starting = null;
    });
    attempt.done = done;
    return done;
  }

  function stop(): Promise<RecordingResult> {
    const s = session;
    if (!s) return Promise.reject(new AppError('other', MSG.notRecording, { retryable: false }));
    if (s.finishing) {
      // Arrêt automatique déjà en cours : le résultat est rendu ici (et pas aussi à onAutoStop).
      s.deliverAutoStop = false;
      return s.finishing;
    }
    return finish(s, false);
  }

  async function cancel(): Promise<void> {
    if (status === 'starting' && starting) {
      const attempt = starting;
      attempt.cancelled = true;
      await attempt.done.catch(() => undefined);
      return;
    }
    const s = session;
    if (!s) return;
    s.deliverAutoStop = false;
    try {
      await finish(s, false);
    } catch {
      // on supprime les morceaux quoi qu'il arrive
    }
    await db.deleteChunks(s.id);
  }

  return {
    get status(): RecorderStatus {
      return status;
    },
    start,
    stop,
    cancel,
  };
}
