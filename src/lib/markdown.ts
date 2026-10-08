import { activeMentions } from './mentions';
import type { DayKey, DayLink, DaySynthesis, Entry, Mood } from './types';
import { formatDayFr, formatDayFrTitle, formatDuration, timeHHmm } from './util';

/**
 * Rendu Markdown (français) d'une journée : synthèse + entrées.
 * Utilisé pour la copie visible dans Drive et pour l'export zip.
 *
 * La sortie est DÉTERMINISTE (mêmes données → même texte) : elle est hachée pour détecter
 * les changements. Aucun HTML n'est produit ; le contenu (transcriptions, sorties Gemini)
 * est neutralisé juste assez pour ne pas casser la structure du document.
 */

const MOOD_EMOJI: Record<Mood['score'], string> = {
  [-2]: '😞',
  [-1]: '🙁',
  0: '😐',
  1: '🙂',
  2: '😄',
};

function moodText(mood: Mood): string {
  const emoji = MOOD_EMOJI[mood.score] ?? MOOD_EMOJI[0];
  const label = inline(mood.label);
  return label ? `${emoji} ${label}` : emoji;
}

/** Empêche l'interprétation d'une balise HTML (`<div`, `</p`, `<!--`, `<?`). */
function noHtml(s: string): string {
  return s.replace(/<(?=[A-Za-z/!?])/g, '\\<');
}

/**
 * Neutralise un début de ligne qui changerait la structure : titre (`#`), bloc de code
 * délimité (```/~~~, qui avalerait le reste du document), citation (`>`).
 */
function safeLineStart(line: string): string {
  return /^(#{1,6}(\s|$)|`{3,}|~{3,}|>)/.test(line) ? `\\${line}` : line;
}

/** Texte sur une seule ligne (titres, éléments de liste, métadonnées). */
function inline(s: string): string {
  return noHtml(s.replace(/\s+/g, ' ').trim());
}

/** Élément de liste à puces. */
function listItem(s: string): string {
  return `- ${safeLineStart(inline(s))}`;
}

/** Liste à puces, ou null si vide. */
function bulletList(items: readonly string[]): string | null {
  const lines = items.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.length ? lines.map(listItem).join('\n') : null;
}

/** Liste « a, b, c » (éléments vides ignorés). */
function commaList(items: readonly string[]): string {
  return items
    .map(inline)
    .filter(Boolean)
    .join(', ');
}

/** Texte libre → paragraphes : chaque ligne non vide devient un paragraphe. */
function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((l) => safeLineStart(noHtml(l)));
}

/** Tri stable et déterministe : chronologique, puis par id. */
function byCreatedAsc(a: Entry, b: Entry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** « 08:15 » d'une date ISO, ou '' si illisible. */
function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeHHmm(d);
}

/** « le samedi 10 octobre 2026 à 08:15 » */
function saidOn(link: DayLink): string {
  const t = timeOf(link.sourceCreatedAt);
  return `le ${formatDayFr(link.sourceDay)}${t ? ` à ${t}` : ''}`;
}

/** « « avant-hier » » (repère cité), ou '' */
function quoted(when: string): string {
  const w = inline(when);
  return w ? `« ${w} »` : '';
}

/** Lignes « ↪ Noté aussi au … » / « 📌 Prévu pour le … » sous l'entrée qui contient les mentions. */
function mentionLines(entry: Entry): string[] {
  return activeMentions(entry).map((m) => {
    const q = quoted(m.when);
    const said = q ? ` (${q})` : '';
    return m.kind === 'past'
      ? `↪ Noté aussi au ${formatDayFr(m.day)}${said}.`
      : `📌 Prévu pour le ${formatDayFr(m.day)}${said}.`;
  });
}

/** Section « Prévu » (choses annoncées pour ce jour) ou « Ajouté plus tard » (faits racontés après). */
function linkBlocks(links: readonly DayLink[], kind: 'past' | 'future', synthesis?: DaySynthesis): string[] {
  const list = links.filter((l) => l.mention.kind === kind);
  if (list.length === 0) return [];
  const items = list.map((l) => {
    const text = inline(l.mention.text);
    const q = quoted(l.mention.when);
    const verdict = synthesis?.mentionVerdicts?.[l.ref];
    if (verdict === 'deja' || l.repeatOf) {
      // Déjà raconté ce jour-là (verdict de la synthèse) ou par une entrée précédente : renvoi.
      const head = verdict === 'deja' ? 'Tu y es revenu' : kind === 'past' ? 'Raconté aussi' : 'Annoncé aussi';
      return `- ↩ ${head} ${saidOn(l)}${q ? ` (${q})` : ''} : ${text}`;
    }
    const extra = verdict === 'complete' ? ' — complète ce jour-là' : '';
    return `- ${safeLineStart(text)} *(${kind === 'past' ? 'dit' : 'annoncé'} ${saidOn(l)}${q ? `, ${q}` : ''}${extra})*`;
  });
  return [kind === 'past' ? '## Ajouté plus tard' : '## Prévu', items.join('\n')];
}

function entryBlocks(entry: Entry, withMentions: boolean): string[] {
  const blocks: string[] = [];
  const a = entry.analysis;
  const created = new Date(entry.createdAt);
  const time = Number.isNaN(created.getTime()) ? '--:--' : timeHHmm(created);
  const title = a ? inline(a.title) || '(sans titre)' : '(analyse en attente)';
  blocks.push(`### ${time} — ${title}`);

  const meta: string[] = [];
  if (entry.source === 'text') meta.push('Écrite au clavier');
  if (a) meta.push(`Humeur : ${moodText(a.mood)}`);
  if (entry.source === 'voice' && typeof entry.durationSec === 'number' && entry.durationSec > 0) {
    meta.push(`Durée : ${formatDuration(entry.durationSec)}`);
  }
  if (a) {
    const themes = commaList(a.themes);
    const people = commaList(a.people);
    const places = commaList(a.places);
    if (themes) meta.push(`Thèmes : ${themes}`);
    if (people) meta.push(`Personnes : ${people}`);
    if (places) meta.push(`Lieux : ${places}`);
  }
  if (meta.length) blocks.push(meta.join(' · '));

  const paras = paragraphs(entry.transcript);
  if (paras.length) {
    blocks.push(...paras);
  } else if (entry.source === 'voice' && !a) {
    blocks.push('*(transcription en attente)*');
  } else {
    blocks.push('*(aucun texte)*');
  }

  const todos = a ? bulletList(a.todos) : null;
  if (todos) blocks.push('**À faire**', todos);
  if (withMentions) {
    const lines = mentionLines(entry);
    if (lines.length) blocks.push(lines.join('  \n'));
  }
  return blocks;
}

function synthesisBlocks(s: DaySynthesis): string[] {
  const blocks: string[] = ['## Synthèse'];
  const summary = paragraphs(s.summary);
  if (summary.length) blocks.push(...summary);

  const highlights = bulletList(s.highlights);
  if (highlights) blocks.push('**Moments forts**', highlights);

  const todos = bulletList(s.todos);
  if (todos) blocks.push('**À faire**', todos);

  const themes = commaList(s.themes);
  if (themes) blocks.push(`**Thèmes** : ${themes}`);
  return blocks;
}

/**
 * Markdown d'une journée. Se termine par un unique saut de ligne.
 * `links` (notes d'autres jours qui visent ce jour) : fourni quand « Rattacher aux autres jours »
 * est actif ; ajoute « Prévu », « Ajouté plus tard » et, sous chaque entrée, les jours auxquels
 * elle a été rattachée. Sans note ni mention, le texte est identique à celui d'avant.
 */
export function renderDayMarkdown(
  day: DayKey,
  entries: Entry[],
  synthesis?: DaySynthesis,
  links?: readonly DayLink[],
): string {
  const blocks: string[] = [`# ${formatDayFrTitle(day)}`];

  if (synthesis) {
    blocks.push(`**Humeur du jour** : ${moodText(synthesis.mood)}`);
    blocks.push(...synthesisBlocks(synthesis));
  }

  if (links) blocks.push(...linkBlocks(links, 'future', synthesis));

  blocks.push('## Entrées');
  const sorted = [...entries].sort(byCreatedAsc);
  if (sorted.length === 0) {
    blocks.push('*Aucune entrée.*');
  } else {
    for (const entry of sorted) blocks.push(...entryBlocks(entry, !!links));
  }

  if (links) blocks.push(...linkBlocks(links, 'past', synthesis));

  return `${blocks.join('\n\n')}\n`;
}
