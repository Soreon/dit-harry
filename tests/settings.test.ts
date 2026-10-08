import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createLocalDb } from '../src/lib/db';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  saveSettings,
} from '../src/lib/settings';
import type { Settings } from '../src/lib/types';

function freshDb() {
  return createLocalDb(`test-settings-${crypto.randomUUID()}`);
}

function settings(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('DEFAULT_SETTINGS', () => {
  it('reprend la configuration', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      geminiApiKey: '',
      entryModel: config.defaultEntryModel,
      synthesisModel: config.defaultSynthesisModel,
      mirrorEnabled: true,
      audioRetentionDays: config.defaultAudioRetentionDays,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('loadSettings', () => {
  it('renvoie les valeurs par défaut sur une base vide', async () => {
    expect(await loadSettings(freshDb())).toEqual(DEFAULT_SETTINGS);
  });

  it('complète les réglages stockés par les valeurs par défaut et ignore les valeurs invalides', async () => {
    const db = freshDb();
    await db.setKv('settings', {
      geminiApiKey: 'CLE',
      mirrorEnabled: false,
      audioRetentionDays: -3,
      entryModel: '',
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(await loadSettings(db)).toEqual({
      ...DEFAULT_SETTINGS,
      geminiApiKey: 'CLE',
      mirrorEnabled: false,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('normalizeSettings tolère n\'importe quelle entrée', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ audioRetentionDays: 30.4, geminiApiKey: '  k  ' })).toMatchObject({
      audioRetentionDays: 30,
      geminiApiKey: 'k',
    });
  });
});

describe('saveSettings', () => {
  it('applique le patch, date la modification et marque les réglages à envoyer', async () => {
    const db = freshDb();
    const before = Date.now();
    const saved = await saveSettings(db, {
      geminiApiKey: 'NOUVELLE',
      updatedAt: '2000-01-01T00:00:00.000Z', // ignoré : toujours « maintenant »
    });
    const after = Date.now();
    expect(saved.geminiApiKey).toBe('NOUVELLE');
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved.updatedAt)).toBeLessThanOrEqual(after);
    expect(await db.getKv('settings')).toEqual(saved);
    expect(await db.getKv('sync.settingsDirty')).toBe(true);

    const again = await saveSettings(db, { mirrorEnabled: false });
    expect(again).toMatchObject({ geminiApiKey: 'NOUVELLE', mirrorEnabled: false });
    expect(await loadSettings(db)).toEqual(again);
  });
});

describe('mergeSettings', () => {
  const older = '2026-10-01T10:00:00.000Z';
  const newer = '2026-10-05T10:00:00.000Z';

  it('le plus récent gagne', () => {
    const local = settings({ geminiApiKey: 'L', mirrorEnabled: true, updatedAt: older });
    const remote = settings({ geminiApiKey: 'R', mirrorEnabled: false, updatedAt: newer });
    expect(mergeSettings(local, remote)).toEqual(remote);
    expect(mergeSettings(remote, local)).toEqual(remote);
  });

  it('égalité → la version locale', () => {
    const local = settings({ geminiApiKey: 'L', updatedAt: newer });
    const remote = settings({ geminiApiKey: 'R', updatedAt: newer });
    expect(mergeSettings(local, remote)).toEqual(local);
  });

  it('ne remplace jamais une clé locale par une clé distante vide', () => {
    const local = settings({ geminiApiKey: 'L', audioRetentionDays: 365, updatedAt: older });
    const remote = settings({ geminiApiKey: '', audioRetentionDays: 30, updatedAt: newer });
    expect(mergeSettings(local, remote)).toEqual({ ...remote, geminiApiKey: 'L' });
  });

  it('adopte la clé distante sur un appareil neuf', () => {
    const local = { ...DEFAULT_SETTINGS };
    const remote = settings({ geminiApiKey: 'R', updatedAt: older });
    expect(mergeSettings(local, remote).geminiApiKey).toBe('R');
  });
});
