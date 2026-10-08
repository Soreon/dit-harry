import type { LocalDb, RecorderCallbacks, RecorderStatus, RecordingResult, VoiceRecorder } from '../types';
import { AppError } from '../errors';
import { newId, sleep } from '../util';

/** Fréquence d'échantillonnage du WAV silencieux (8 kHz, 8 bits, mono = 8 Ko/s). */
const SAMPLE_RATE = 8000;
const LEVEL_INTERVAL_MS = 50;
const TICK_INTERVAL_MS = 1000;

/** WAV PCM 8 bits mono rempli de silence (valeur 128). */
export function createSilentWav(durationSec: number, sampleRate = SAMPLE_RATE): Blob {
  const samples = Math.max(0, Math.round(durationSec * sampleRate));
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // taille du bloc fmt
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate, true); // octets par seconde (8 bits mono)
  v.setUint16(32, 1, true); // octets par trame
  v.setUint16(34, 8, true); // bits par échantillon
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Niveau sonore simulé 0..1 : oscillation douce + variations rapides (déterministe). */
export function simulatedLevel(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  const v = 0.4 + 0.25 * Math.sin(t * 2 * Math.PI * 0.6) + 0.15 * Math.sin(t * 2 * Math.PI * 3.7 + 1.3);
  return Math.min(1, Math.max(0, v));
}

/**
 * Enregistreur simulé (mode démo, sans micro) : même contrat que le vrai,
 * produit un WAV silencieux de la durée écoulée, niveau oscillant, ticks chaque seconde.
 */
export function createSimulatedRecorder(
  db: Pick<LocalDb, 'deleteChunks'>,
  opts: { maxDurationSec?: number; startDelayMs?: number } = {},
): VoiceRecorder {
  const maxDurationSec = opts.maxDurationSec ?? 30 * 60;
  const startDelayMs = opts.startDelayMs ?? 200;

  let status: RecorderStatus = 'idle';
  let recordingId = '';
  let startedAtMs = 0;
  let startedAtIso = '';
  let callbacks: RecorderCallbacks = {};
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  function onVisibility(): void {
    if (document.visibilityState === 'hidden' && status === 'recording') autoStop();
  }

  function stopTimers(): void {
    clearInterval(levelTimer);
    clearInterval(tickTimer);
    levelTimer = undefined;
    tickTimer = undefined;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  }

  function finish(interrupted: boolean): RecordingResult {
    status = 'stopping';
    stopTimers();
    const durationSec = Math.round((Date.now() - startedAtMs) / 100) / 10;
    const result: RecordingResult = {
      recordingId,
      blob: createSilentWav(durationSec),
      mimeType: 'audio/wav',
      durationSec,
      startedAt: startedAtIso,
      interrupted,
    };
    status = 'idle';
    return result;
  }

  function autoStop(): void {
    const result = finish(true);
    callbacks.onAutoStop?.(result);
  }

  return {
    get status() {
      return status;
    },

    async start(cb = {}) {
      if (status !== 'idle') {
        throw new AppError('other', 'Un enregistrement est déjà en cours.', { retryable: false });
      }
      status = 'starting';
      callbacks = cb;
      if (startDelayMs > 0) await sleep(startDelayMs);
      if (status !== 'starting') return; // annulé pendant le démarrage
      recordingId = newId();
      startedAtMs = Date.now();
      startedAtIso = new Date(startedAtMs).toISOString();
      status = 'recording';
      levelTimer = setInterval(() => callbacks.onLevel?.(simulatedLevel(Date.now() - startedAtMs)), LEVEL_INTERVAL_MS);
      tickTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtMs) / 1000);
        callbacks.onTick?.(seconds);
        if (seconds >= maxDurationSec) autoStop();
      }, TICK_INTERVAL_MS);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    },

    async stop() {
      if (status !== 'recording') {
        throw new AppError('other', 'Aucun enregistrement en cours.', { retryable: false });
      }
      return finish(false);
    },

    async cancel() {
      const id = recordingId;
      stopTimers();
      status = 'idle';
      if (id) await db.deleteChunks(id).catch(() => undefined);
    },
  };
}
