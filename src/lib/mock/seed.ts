import type { DriveClient, Entry } from '../types';
import { config } from '../../config';
import { addDays, dayKey, newId, parseDayKey } from '../util';
import { mockAnalyzeText } from './ai';

/** Entrées d'exemple déposées dans le faux Drive au premier lancement du mode démo. */
const SAMPLES: readonly { daysAgo: number; hour: number; minute: number; text: string }[] = [
  {
    daysAgo: 3,
    hour: 19,
    minute: 5,
    text:
      "Journée au bureau assez stressante, la réunion avec Claire s'est mal passée. " +
      'Un peu de fatigue ce soir. Il faudrait que je prenne du temps pour moi ce week-end.',
  },
  {
    daysAgo: 1,
    hour: 8,
    minute: 10,
    text:
      'Réveil difficile, la nuit a été courte. Mais le café en terrasse avec Camille ' +
      "m'a fait du bien. Je dois réserver les billets de train pour aller à Nantes.",
  },
  {
    daysAgo: 1,
    hour: 21,
    minute: 30,
    text:
      'Belle soirée : dîner chez Hugo, on a beaucoup ri. ' +
      "Ça m'a fait plaisir de le revoir après tout ce temps.",
  },
];

/**
 * Dépose quelques entrées texte déjà analysées (jours passés) dans l'appDataFolder simulé.
 * Au premier cycle de synchro, elles sont « tirées » du Drive et les synthèses des jours
 * passés sont générées automatiquement — comme avec un vrai compte.
 * Retourne le nombre d'entrées créées.
 */
export async function seedDemoDrive(drive: DriveClient, now: Date = new Date()): Promise<number> {
  const today = dayKey(now);
  for (const s of SAMPLES) {
    const day = addDays(today, -s.daysAgo);
    const at = parseDayKey(day);
    at.setHours(s.hour, s.minute, 0, 0);
    const createdAt = at.toISOString();
    const analyzedAt = new Date(at.getTime() + 60_000).toISOString();
    const id = newId();
    const entry: Entry = {
      id,
      day,
      createdAt,
      updatedAt: analyzedAt,
      source: 'text',
      transcript: s.text,
      analysis: mockAnalyzeText(s.text),
      analysisModel: config.defaultEntryModel,
      analyzedAt,
    };
    await drive.createAppDataFile(`entry-${id}.json`, JSON.stringify(entry), 'application/json', {
      kind: 'entry',
      day,
      entryId: id,
    });
  }
  return SAMPLES.length;
}
