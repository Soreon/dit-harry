/**
 * Réglages : valeurs par défaut, chargement (kv 'settings' ∪ défauts), sauvegarde et fusion
 * avec la copie Drive (`settings.json`, appDataFolder). Voir docs/SPEC.md §2 et §3.
 */
import { config } from '../config';
import { withKvLock } from './db';
import type { LocalDb, Settings } from './types';

const KV_SETTINGS = 'settings';
const KV_DIRTY = 'sync.settingsDirty';

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  geminiApiKey: '',
  entryModel: config.defaultEntryModel,
  synthesisModel: config.defaultSynthesisModel,
  // L'utilisateur a choisi « les deux » sauvegardes : copie visible activée par défaut.
  mirrorEnabled: true,
  audioRetentionDays: config.defaultAudioRetentionDays,
  updatedAt: '1970-01-01T00:00:00.000Z',
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * Valide un objet de réglages quelconque (kv local ou JSON Drive) : chaque champ invalide ou
 * absent prend sa valeur par défaut.
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {};
  const days = typeof r.audioRetentionDays === 'number' ? r.audioRetentionDays : Number.NaN;
  return {
    geminiApiKey: typeof r.geminiApiKey === 'string' ? r.geminiApiKey.trim() : DEFAULT_SETTINGS.geminiApiKey,
    entryModel: nonEmptyString(r.entryModel) ?? DEFAULT_SETTINGS.entryModel,
    synthesisModel: nonEmptyString(r.synthesisModel) ?? DEFAULT_SETTINGS.synthesisModel,
    mirrorEnabled: typeof r.mirrorEnabled === 'boolean' ? r.mirrorEnabled : DEFAULT_SETTINGS.mirrorEnabled,
    audioRetentionDays:
      Number.isFinite(days) && days >= 1 ? Math.round(days) : DEFAULT_SETTINGS.audioRetentionDays,
    updatedAt: isIsoDate(r.updatedAt) ? r.updatedAt : DEFAULT_SETTINGS.updatedAt,
  };
}

/** Réglages locaux (kv 'settings') complétés par les valeurs par défaut. */
export async function loadSettings(db: LocalDb): Promise<Settings> {
  const stored = await db.getKv<unknown>(KV_SETTINGS);
  return normalizeSettings(stored);
}

/**
 * Applique `patch`, date la modification (`updatedAt = maintenant`), enregistre en local et
 * marque les réglages à envoyer dans Drive (kv 'sync.settingsDirty').
 */
export function saveSettings(db: LocalDb, patch: Partial<Settings>): Promise<Settings> {
  // Sérialisé avec la fusion faite par la synchro (sync.ts) : aucune des deux écritures ne se perd.
  return withKvLock(db, async () => {
    const current = await loadSettings(db);
    const next = normalizeSettings({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await db.setKv(KV_SETTINGS, next);
    await db.setKv(KV_DIRTY, true);
    return next;
  });
}

/**
 * Fusion « dernier qui écrit gagne » sur `updatedAt` (égalité → local).
 * Exception : une clé Gemini locale non vide n'est jamais remplacée par une clé distante vide.
 */
export function mergeSettings(local: Settings, remote: Settings): Settings {
  const lt = Date.parse(local.updatedAt);
  const rt = Date.parse(remote.updatedAt);
  const remoteWins = (Number.isNaN(lt) ? 0 : lt) < (Number.isNaN(rt) ? 0 : rt);
  if (!remoteWins) return { ...local };
  const merged: Settings = { ...remote };
  if (!remote.geminiApiKey.trim() && local.geminiApiKey.trim()) {
    merged.geminiApiKey = local.geminiApiKey;
  }
  return merged;
}
