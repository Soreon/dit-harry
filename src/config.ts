/** Configuration statique de l'appli (valeurs publiques uniquement — jamais de secret ici). */
export const config = {
  appName: 'Dit Harry',
  version: __APP_VERSION__,
  buildTime: __BUILD_TIME__,

  /** Client OAuth « Application Web » — public, fourni au build (variable de dépôt GitHub). */
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
  /** Mode démo : services Google/Gemini simulés (`npm run dev:mock`). */
  mock: import.meta.env.VITE_MOCK === '1',

  /** Autorisations Drive — toutes deux classées « non sensibles » par Google. */
  scopes: [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/drive.file',
  ],

  /** Modèles par défaut (modifiables dans les réglages). Vérifiés le 2026-10-08. */
  defaultEntryModel: 'gemini-3.5-flash-lite',
  defaultSynthesisModel: 'gemini-3.8-flash',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',

  /** Enregistrement */
  audioBitsPerSecond: 32_000,
  maxRecordingSec: 30 * 60,
  recorderTimesliceMs: 5_000,

  /** Conservation de l'audio dans Drive (jours, glissant). */
  defaultAudioRetentionDays: 365,

  /** Copie visible dans Drive (scope drive.file). */
  mirrorFolderName: 'Dit Harry',

  /** Marge avant expiration du jeton Google (ms). */
  tokenExpiryMarginMs: 5 * 60 * 1000,

  /** Nombre max. de synthèses de jours générées par cycle de synchro. */
  maxSynthesesPerRun: 7,
} as const;

export type AppConfig = typeof config;
