import { config } from '../config';
import { AppError } from './errors';
import type { AiClient, Services, Settings } from './types';
import { createLocalDb } from './db';
import { createGoogleAuth } from './auth';
import { createDriveClient } from './drive';
import { createGeminiClient } from './gemini';
import { createVoiceRecorder } from './recorder';
import { createSyncEngine } from './sync';

/** Fabrique un client Gemini pour le modèle d'entrée ou de synthèse. */
export function createAiFromSettings(settings: Settings, which: 'entry' | 'synthesis'): AiClient {
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey) {
    throw new AppError('invalid-key', 'Ajoute ta clé Gemini dans les réglages.', { retryable: false });
  }
  return createGeminiClient({
    apiKey,
    model: which === 'entry' ? settings.entryModel : settings.synthesisModel,
    thinkingLevel: which === 'synthesis' ? 'low' : undefined,
    baseUrl: config.geminiBaseUrl,
  });
}

/** Conteneur de services : réels, ou simulés en mode démo (`npm run dev:mock`). */
export async function createServices(): Promise<Services> {
  // Condition écrite sur import.meta.env pour que Vite élimine les mocks du build de production.
  if (import.meta.env.VITE_MOCK === '1') {
    const { createMockServices } = await import('./mock/index');
    return createMockServices();
  }

  const db = createLocalDb();
  const auth = createGoogleAuth({ clientId: config.googleClientId, scopes: config.scopes });
  const drive = createDriveClient(auth);
  const sync = createSyncEngine({ db, drive, auth, createAi: createAiFromSettings });

  return {
    db,
    auth,
    drive,
    createAi: createAiFromSettings,
    createRecorder: () =>
      createVoiceRecorder(db, {
        audioBitsPerSecond: config.audioBitsPerSecond,
        maxDurationSec: config.maxRecordingSec,
        timesliceMs: config.recorderTimesliceMs,
      }),
    sync,
  };
}
