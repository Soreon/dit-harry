/**
 * Mode démo (`npm run dev:mock`, VITE_MOCK=1) : Google et Gemini sont simulés,
 * mais la base locale, la synchronisation et l'enregistreur sont les VRAIS modules.
 * Importé dynamiquement par services.ts : absent du build de production.
 */
import type { LocalDb, RecorderCallbacks, Services, Settings, VoiceRecorder } from '../types';
import { config } from '../../config';
import { AppError } from '../errors';
import { createLocalDb } from '../db';
import { createSyncEngine } from '../sync';
import { createVoiceRecorder } from '../recorder';
import { createMockAuth } from './auth';
import { createMockDriveClient, MOCK_DRIVE_DB_NAME } from './drive';
import { createMockAiClient } from './ai';
import { createSimulatedRecorder } from './recorder';
import { seedDemoDrive } from './seed';

/**
 * Base locale du mode démo. Distincte de 'dit-harry' : sur http://localhost:5173 le vrai mode
 * et la démo partagent la même origine, il ne faut jamais mélanger leurs données.
 */
export const MOCK_LOCAL_DB_NAME = 'dit-harry-demo';

/** Latence simulée d'un appel Drive (ms) : assez pour voir les phases de synchro. */
const DRIVE_LATENCY_MS = 150;

/** Micro utilisable ? (API présentes ; le refus éventuel est géré au démarrage). */
function canUseMicrophone(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * Enregistreur de démo : le vrai si le micro fonctionne, sinon (API absente, refus,
 * pas de micro) l'enregistreur simulé — blob silencieux et niveau oscillant.
 */
function createDemoRecorder(db: LocalDb): VoiceRecorder {
  let real: VoiceRecorder | null = null;
  const simulated = createSimulatedRecorder(db, { maxDurationSec: config.maxRecordingSec });
  let active: VoiceRecorder | null = null;
  /** Incrémenté par cancel() : un démarrage annulé ne doit pas basculer sur le simulé. */
  let cancels = 0;

  return {
    get status() {
      return active?.status ?? 'idle';
    },

    async start(cb?: RecorderCallbacks) {
      if (active && active.status !== 'idle') {
        throw new AppError('other', 'Un enregistrement est déjà en cours.', { retryable: false });
      }
      const startedAfter = cancels;
      if (canUseMicrophone()) {
        real ??= createVoiceRecorder(db, {
          audioBitsPerSecond: config.audioBitsPerSecond,
          maxDurationSec: config.maxRecordingSec,
          timesliceMs: config.recorderTimesliceMs,
        });
        active = real;
        try {
          await real.start(cb);
          return;
        } catch (e) {
          // Annulé pendant la demande d'accès au micro : on s'arrête là (pas de repli).
          if (cancels !== startedAfter) throw e;
          console.info('[Dit Harry démo] Micro indisponible, enregistrement simulé.', e);
        }
      }
      active = simulated;
      await simulated.start(cb);
    },

    stop() {
      if (!active) {
        return Promise.reject(new AppError('other', 'Aucun enregistrement en cours.', { retryable: false }));
      }
      return active.stop();
    },

    async cancel() {
      cancels++;
      await active?.cancel();
    },
  };
}

/** Dépose le jeu de données d'exemple une seule fois (faux Drive neuf). */
async function seedOnce(): Promise<void> {
  const admin = createMockDriveClient({ dbName: MOCK_DRIVE_DB_NAME });
  try {
    if (await admin.getMeta<boolean>('seeded')) return;
    if ((await admin.listAll()).length === 0) await seedDemoDrive(admin);
    await admin.setMeta('seeded', true);
  } finally {
    admin.close();
  }
}

export async function createMockServices(): Promise<Services> {
  console.info('[Dit Harry] Mode démo : connexion Google, Drive et Gemini simulés.');

  const db = createLocalDb(MOCK_LOCAL_DB_NAME);
  const auth = createMockAuth();
  const drive = createMockDriveClient({ dbName: MOCK_DRIVE_DB_NAME, auth, latencyMs: DRIVE_LATENCY_MS });

  try {
    await seedOnce();
  } catch (e) {
    console.warn('[Dit Harry démo] Jeu de données d’exemple non créé.', e);
  }

  // En démo, n'importe quelle clé non vide « fonctionne » ; la synchro ne lance l'analyse
  // que si une clé est saisie, ce qui permet de montrer l'écran « clé manquante ».
  const createAi = (_settings: Settings, _which: 'entry' | 'synthesis') => createMockAiClient();

  const sync = createSyncEngine({ db, drive, auth, createAi });

  return {
    db,
    auth,
    drive,
    createAi,
    createRecorder: () => createDemoRecorder(db),
    sync,
  };
}
