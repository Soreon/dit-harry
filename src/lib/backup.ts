import { config } from '../config';
import { renderDayMarkdown } from './markdown';
import type { DayKey, DaySynthesis, Entry, LocalDb, LocalEntry, LocalSynthesis, Settings } from './types';
import { dayKey, formatDayFr, timeHHmm } from './util';
import { createZip, type ZipInput } from './zip';

/**
 * Export manuel : archive zip téléchargée sur l'appareil, contenant
 * - `dit-harry.json` : toutes les entrées et synthèses (sans l'état local) ;
 * - `markdown/<AAAA>/<AAAA-MM-JJ>.md` : une page lisible par jour ;
 * - `LISEZMOI.txt` : explications.
 * L'audio n'est pas inclus (il reste dans Drive pendant la durée de conservation).
 */

export interface ExportFile {
  app: string;
  version: string;
  exportedAt: string;
  entries: Entry[];
  syntheses: DaySynthesis[];
}

/** Délai avant de libérer l'URL du blob : Chrome Android lit le blob après le clic. */
const REVOKE_DELAY_MS = 10_000;

function withoutLocal<T extends { local: unknown }>(x: T): Omit<T, 'local'> {
  const { local, ...rest } = x;
  void local;
  return rest;
}

function toEntry(e: LocalEntry): Entry {
  return withoutLocal(e);
}

function toSynthesis(s: LocalSynthesis): DaySynthesis {
  return withoutLocal(s);
}

function byCreatedThenId(a: Entry, b: Entry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

function readme(now: Date, entryCount: number, dayCount: number, retentionDays: number): string {
  return [
    'Dit Harry — export de ton journal',
    '==================================',
    '',
    `Exporté le ${formatDayFr(dayKey(now))} à ${timeHHmm(now)}.`,
    `${plural(entryCount, 'entrée', 'entrées')} sur ${plural(dayCount, 'jour', 'jours')}.`,
    '',
    'Contenu de cette archive',
    '------------------------',
    '',
    '- markdown/<année>/<AAAA-MM-JJ>.md',
    '  Une page par jour, lisible avec n’importe quel éditeur de texte : la synthèse',
    '  du jour, puis chaque entrée (heure, titre, humeur, transcription, choses à faire).',
    '',
    '- dit-harry.json',
    '  Toutes tes données (entrées, transcriptions, analyses et synthèses) au format',
    '  JSON, pour les archiver ou les réutiliser dans un autre outil.',
    '',
    'Ce qui n’est pas dans l’archive',
    '-------------------------------',
    '',
    '- Les enregistrements audio. Ils restent dans ton Google Drive (espace caché de',
    `  l’appli) pendant ${plural(retentionDays, 'jour', 'jours')} après l’enregistrement, comme`,
    '  choisi dans les réglages, puis ils sont supprimés automatiquement. Les',
    '  transcriptions, elles, sont gardées.',
    '- Tes réglages, et en particulier ta clé Gemini.',
    '',
  ].join('\n');
}

/** Construit l'archive d'export à partir de la base locale. */
export async function buildExportZip(
  db: LocalDb,
  now: Date = new Date(),
): Promise<{ blob: Blob; filename: string }> {
  const [localEntries, localSyntheses, settings] = await Promise.all([
    db.listEntries(),
    db.listSyntheses(),
    db.getKv<Partial<Settings>>('settings'),
  ]);

  const entries = localEntries.map(toEntry).sort(byCreatedThenId);
  const syntheses = localSyntheses
    .map(toSynthesis)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const exportData: ExportFile = {
    app: config.appName,
    version: config.version,
    exportedAt: now.toISOString(),
    entries,
    syntheses,
  };

  // Regroupement par jour (entrées et/ou synthèse)
  const byDay = new Map<DayKey, Entry[]>();
  for (const e of entries) {
    const list = byDay.get(e.day);
    if (list) list.push(e);
    else byDay.set(e.day, [e]);
  }
  const synthesisByDay = new Map<DayKey, DaySynthesis>(syntheses.map((s) => [s.day, s]));
  const days = [...new Set<DayKey>([...byDay.keys(), ...synthesisByDay.keys()])].sort();

  const retention =
    typeof settings?.audioRetentionDays === 'number' && settings.audioRetentionDays > 0
      ? settings.audioRetentionDays
      : config.defaultAudioRetentionDays;

  const files: ZipInput[] = [
    { path: 'LISEZMOI.txt', data: readme(now, entries.length, days.length, retention), date: now },
    { path: 'dit-harry.json', data: `${JSON.stringify(exportData, null, 2)}\n`, date: now },
  ];
  for (const day of days) {
    files.push({
      path: `markdown/${day.slice(0, 4)}/${day}.md`,
      data: renderDayMarkdown(day, byDay.get(day) ?? [], synthesisByDay.get(day)),
      date: now,
    });
  }

  return { blob: createZip(files), filename: `dit-harry-export-${dayKey(now)}.zip` };
}

/** Propose le fichier au téléchargement (lien `<a download>` temporaire). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
