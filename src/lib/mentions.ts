/**
 * Mentions d'autres jours : « Ajouté plus tard » (fait passé raconté après coup) et « Prévu »
 * (chose annoncée pour un jour à venir). Voir docs/SPEC.md §16.
 *
 * Principe : on ne réécrit jamais une entrée. La mention est une ANNOTATION de l'entrée qui la
 * contient (`analysis.mentions`) ; on la regroupe par jour visé au moment de l'affichage, du
 * Markdown, de l'export et de la synthèse (`collectDayLinks`). Aucun fichier Drive en plus.
 *
 * Module PUR : validation des réponses du modèle (ancrage dans la transcription, date fixée par
 * le code), conservation des choix de l'utilisateur à la ré-analyse, regroupement, signatures.
 */
import type {
  DayKey,
  DayLink,
  DayMention,
  DayMentionKind,
  DayMentionStatus,
  Entry,
  EntryAnalysis,
  EntryContext,
} from './types';
import { fnv1a } from './util';
import { foldWhen, isDayKey, isInWindow, parseFrenchWhen, type WhenResult } from './when';

/** Mentions gardées par entrée (hors choix de l'utilisateur, toujours conservés). */
export const MAX_MENTIONS = 5;
const MAX_WHEN = 60;
const MAX_TEXT = 300;
/** Au-delà, deux faits sont « le même » (mots pleins en commun / mots pleins en tout). */
const SAME_FACT = 0.6;
/** À la ré-analyse : un candidat aussi proche d'un choix de l'utilisateur est écarté. */
const SAME_AS_USER_CHOICE = 0.5;

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function oneLine(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Tronque proprement (de préférence sur un espace) et ajoute « … ». */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.–—-]+$/u, '')}…`;
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const STOPWORDS = new Set(
  (
    'a ai aie au aux avec c ca ce ces cet cette d dans de des du elle elles en es est et etait ' +
    'etais ete eu il ils j je l la le les leur leurs lui m ma mais me mes moi mon n ne nous on ' +
    'ou par pas pour qu que qui s sa se ses si son sont sur t ta te tes toi ton tu un une vous ' +
    'y suis avons avez avait sommes vais va vont aller allee alle alles allees fait faire tres ' +
    'plus aussi bien tout tous toute toutes'
  ).split(' '),
);

/** Racine grossière : « dîné », « dîner », « dînés » → « din » (comparaison seulement). */
function stem(w: string): string {
  if (w.length < 4 || /^\d+$/.test(w)) return w;
  const s = w.replace(/[sx]$/, '').replace(/(?:er|ez|ee|e)$/, '');
  return s.length >= 3 ? s : w;
}

/** Mots pleins (repliés, sans mots outils, racines grossières). */
export function contentWords(s: string): Set<string> {
  return new Set(
    foldWhen(s)
      .split(' ')
      .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOPWORDS.has(w))
      .map(stem),
  );
}

/** Indice de Jaccard des mots pleins (0 si l'un des textes n'en a aucun). */
export function similarity(a: string, b: string): number {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** past si le jour visé précède le jour de l'entrée, sinon future (prévu, éventuellement le jour même). */
export function kindOf(day: DayKey, sourceDay: DayKey): DayMentionKind {
  return day < sourceDay ? 'past' : 'future';
}

/** Identifiant stable (8 caractères) dérivé du repère et du fait. */
export function mentionId(when: string, text: string): string {
  return fnv1a(`${foldWhen(when)}|${foldWhen(text)}`);
}

/* ------------------------------------------------------------------ */
/* Réponse du modèle → mentions validées                               */
/* ------------------------------------------------------------------ */

interface Decision {
  status: Extract<DayMentionStatus, 'auto' | 'proposed'>;
  day: DayKey;
  choices?: DayKey[];
  modelDay?: DayKey;
}

function autoDecision(day: DayKey): Decision {
  return { status: 'auto', day };
}

/**
 * Proposition : 3 jours au plus, la date (valide) du modèle toujours parmi eux, et retenue comme
 * choix suggéré (`modelDay`).
 */
function proposal(choices: DayKey[], modelDay: DayKey | undefined): Decision {
  const list = unique(choices);
  const days = !modelDay || list.slice(0, 3).includes(modelDay) ? list.slice(0, 3) : [...list.slice(0, 2), modelDay];
  const d: Decision = { status: 'proposed', day: '', choices: days };
  if (modelDay) d.modelDay = modelDay;
  return d;
}

/** Résolution du code + date du modèle → rattaché d'office, proposé, ou rejeté (null). */
function decide(res: WhenResult, source: DayKey, modelDay: DayKey | undefined): Decision | null {
  if (res.type === 'none') return null;
  // Repère inconnu du code : la date du modèle n'est jamais prise d'office.
  if (res.type === 'unknown') return modelDay ? proposal([modelDay], modelDay) : null;
  // La nuit, « demain » peut viser le jour même de l'entrée (la journée qui commence).
  const allowSame = res.certainty === 'ask';
  const days = unique(res.days.filter((d) => isInWindow(d, source, allowSame)));
  const first = days[0];
  if (first === undefined) return null;
  switch (res.certainty) {
    case 'sure':
    case 'check':
      // Désaccord du modèle, même sur un repère sûr (« Lundi, Paul m'a dit qu'il se mariait
      // demain » : demain par rapport à lundi) : on demande, avec les deux jours.
      return !modelDay || modelDay === first ? autoDecision(first) : proposal(days, modelDay);
    case 'pick':
      return modelDay && days.includes(modelDay) ? autoDecision(modelDay) : proposal(days, modelDay);
    case 'ask':
      return proposal(days, modelDay);
  }
}

/** Deux mentions d'une même entrée qui visent le même jour → une seule (textes réunis). */
function mergeSameDay(list: DayMention[]): DayMention[] {
  const out: DayMention[] = [];
  for (const m of list) {
    if (out.some((o) => o.id === m.id)) continue;
    if (m.status === 'auto') {
      const same = out.find((o) => o.status === 'auto' && o.day === m.day);
      if (same) {
        if (similarity(same.text, m.text) < SAME_FACT && !foldWhen(same.text).includes(foldWhen(m.text))) {
          same.text = clipText(`${same.text} ${m.text}`, MAX_TEXT);
        }
        continue;
      }
    } else if (
      out.some(
        (o) => o.status === 'proposed' && sameList(o.choices, m.choices) && similarity(o.text, m.text) >= SAME_FACT,
      )
    ) {
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

/**
 * Le repère replié figure-t-il dans la transcription repliée, comme expression entière ?
 * « hier » trouvé seulement dans « avant-hier » (ou « demain » dans « après-demain ») ne compte
 * pas : le modèle aurait raccourci le repère, et le jour serait faux.
 */
function isAnchored(folded: string, haystack: string): boolean {
  const needle = ` ${folded} `;
  const guard = /^hier\b/.test(folded) ? 'avant' : /^demain\b/.test(folded) ? 'apres' : null;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (!guard || !haystack.slice(0, i + 1).endsWith(` ${guard} `)) return true;
  }
  return false;
}

/**
 * Champ `mentions` brut du modèle → mentions validées (5 au plus) :
 * - le repère `when` doit figurer dans la transcription (forme repliée) : sinon rejeté ;
 * - le jour est fixé par `parseFrenchWhen` (référence : jour et heure de l'entrée), la date du
 *   modèle ne sert qu'à départager ; en cas de désaccord, on demande (proposition) ;
 * - fenêtre : 31 jours avant, 60 jours après ; jour même exclu (sauf « demain » dit la nuit).
 */
export function resolveMentions(raw: unknown, ctx: EntryContext, transcript: string): DayMention[] {
  if (!Array.isArray(raw) || !isDayKey(ctx.day)) return [];
  const source = ctx.day;
  const haystack = ` ${foldWhen(transcript)} `;
  const out: DayMention[] = [];
  for (const item of raw.slice(0, MAX_MENTIONS * 2)) {
    const r = isRecord(item) ? item : {};
    const when = clipText(oneLine(r['when']), MAX_WHEN);
    const text = clipText(oneLine(r['text']), MAX_TEXT);
    const folded = foldWhen(when);
    if (!folded || !text || !isAnchored(folded, haystack)) continue;
    const date = typeof r['date'] === 'string' ? r['date'].trim() : '';
    const modelDay = isInWindow(date, source) ? date : undefined;
    const d = decide(parseFrenchWhen(when, source, ctx.time, modelDay), source, modelDay);
    if (!d) continue;
    const target = d.day || d.choices?.[0] || source;
    const m: DayMention = { id: mentionId(when, text), kind: kindOf(target, source), day: d.day, when, text, status: d.status };
    if (d.choices) m.choices = d.choices;
    if (d.modelDay) m.modelDay = d.modelDay;
    out.push(m);
  }
  return mergeSameDay(out).slice(0, MAX_MENTIONS);
}

/* ------------------------------------------------------------------ */
/* Lecture (données stockées ou venues de Drive : tout est revalidé)   */
/* ------------------------------------------------------------------ */

const STATUSES = new Set<string>(['auto', 'proposed', 'confirmed', 'dismissed']);

/** Liste quelconque → mentions bien formées (les autres sont ignorées, jamais effacées). */
export function sanitizeMentions(list: unknown): DayMention[] {
  if (!Array.isArray(list)) return [];
  const out: DayMention[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const { id, day, when, text, status } = raw;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    if (typeof when !== 'string' || typeof text !== 'string' || text.trim() === '') continue;
    if (typeof status !== 'string' || !STATUSES.has(status)) continue;
    if (typeof day !== 'string' || (day !== '' && !isDayKey(day))) continue;
    // Un rattachement actif a forcément un jour.
    if ((status === 'auto' || status === 'confirmed') && day === '') continue;
    const m: DayMention = {
      id,
      kind: raw['kind'] === 'future' ? 'future' : 'past',
      day,
      when,
      text,
      status: status as DayMentionStatus,
    };
    const choices = Array.isArray(raw['choices']) ? raw['choices'].filter(isDayKey).slice(0, 3) : [];
    if (choices.length > 0) m.choices = choices;
    if (isDayKey(raw['modelDay'])) m.modelDay = raw['modelDay'];
    const decidedAt = raw['decidedAt'];
    if (typeof decidedAt === 'string' && !Number.isNaN(Date.parse(decidedAt))) m.decidedAt = decidedAt;
    seen.add(id);
    out.push(m);
  }
  return out;
}

/** Mentions (bien formées) d'une analyse. */
export function readMentions(analysis: EntryAnalysis | undefined): DayMention[] {
  return sanitizeMentions(analysis?.mentions);
}

/** Mentions qui s'affichent sur leur jour visé (auto ou confirmées, jour valide), `kind` recalculé. */
export function activeMentions(entry: Pick<Entry, 'day' | 'analysis'>): DayMention[] {
  return readMentions(entry.analysis)
    .filter((m) => (m.status === 'auto' || m.status === 'confirmed') && isInWindow(m.day, entry.day, true))
    .map((m) => ({ ...m, kind: kindOf(m.day, entry.day) }));
}

/** Propositions en attente d'un choix de l'utilisateur. */
export function pendingProposals(entry: Pick<Entry, 'analysis'>): DayMention[] {
  return readMentions(entry.analysis).filter((m) => m.status === 'proposed');
}

function bySaid(a: DayLink, b: DayLink): number {
  if (a.sourceCreatedAt !== b.sourceCreatedAt) return a.sourceCreatedAt < b.sourceCreatedAt ? -1 : 1;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

/**
 * Mentions actives de toutes les entrées, regroupées par jour visé, dans l'ordre où elles ont été
 * dites. Un même fait rattaché au même jour par une entrée plus récente porte `repeatOf`.
 */
export function collectDayLinks(entries: readonly Pick<Entry, 'id' | 'day' | 'createdAt' | 'analysis'>[]): Map<DayKey, DayLink[]> {
  const map = new Map<DayKey, DayLink[]>();
  for (const e of entries) {
    for (const mention of activeMentions(e)) {
      const link: DayLink = {
        entryId: e.id,
        sourceDay: e.day,
        sourceCreatedAt: e.createdAt,
        mention,
        ref: `${e.id}/${mention.id}`,
      };
      const list = map.get(mention.day);
      if (list) list.push(link);
      else map.set(mention.day, [link]);
    }
  }
  for (const list of map.values()) {
    list.sort(bySaid);
    list.forEach((l, i) => {
      const earlier = list
        .slice(0, i)
        .find(
          (o) =>
            !o.repeatOf &&
            o.entryId !== l.entryId &&
            o.mention.kind === l.mention.kind &&
            similarity(o.mention.text, l.mention.text) >= SAME_FACT,
        );
      if (earlier) l.repeatOf = earlier.ref;
    });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Ré-analyse : les choix de l'utilisateur sont conservés              */
/* ------------------------------------------------------------------ */

/** Un nouveau candidat qui correspond à un choix de l'utilisateur (même jour, même repère, même fait). */
function matchesUserChoice(kept: DayMention, n: DayMention): boolean {
  if (kept.day !== '' && (n.day === kept.day || (n.choices ?? []).includes(kept.day))) return true;
  if (kept.when !== '' && foldWhen(kept.when) === foldWhen(n.when)) return true;
  return similarity(kept.text, n.text) >= SAME_AS_USER_CHOICE;
}

/**
 * Nouvelle analyse d'une entrée (correction, « Réessayer ») :
 * - les mentions confirmées ou retirées par l'utilisateur sont gardées telles quelles, et les
 *   nouveaux candidats qui leur correspondent sont écartés (un ajout retiré ne revient jamais) ;
 * - les mentions auto et proposées sont remplacées ; leur id est repris si le fait est le même.
 */
export function carryOverMentions(prev: unknown, next: unknown): DayMention[] {
  const before = sanitizeMentions(prev);
  const kept = before.filter((m) => m.status === 'confirmed' || m.status === 'dismissed');
  const replaced = before.filter((m) => m.status === 'auto' || m.status === 'proposed');
  const taken = new Set(kept.map((m) => m.id));
  const out = [...kept];
  const limit = Math.max(MAX_MENTIONS, kept.length);
  for (const n of sanitizeMentions(next)) {
    if (out.length >= limit) break;
    if (kept.some((k) => matchesUserChoice(k, n))) continue;
    const twin = replaced.find(
      (p) => p.day === n.day && foldWhen(p.text) === foldWhen(n.text) && (p.day !== '' || sameList(p.choices, n.choices)),
    );
    let id = twin?.id ?? n.id;
    while (taken.has(id)) id = fnv1a(`${id}#`);
    taken.add(id);
    out.push({ ...n, id });
  }
  return out;
}

function isUserChoice(m: DayMention): boolean {
  return m.status === 'confirmed' || m.status === 'dismissed';
}

/**
 * Synchro de deux versions d'une même entrée. Les gestes ne touchent pas `updatedAt` : la version
 * retenue par la fusion (`kept`) peut ignorer un choix fait sur l'autre. On garde donc la liste de
 * `kept`, plus les choix de l'utilisateur (confirmer, déplacer, modifier, retirer) des deux
 * versions ; pour une même mention, le geste le plus récent (`decidedAt`) l'emporte, celui de
 * `mine` (cet appareil) à égalité. `null` : rien à reprendre, `kept` reste tel quel.
 */
export function mergeMentionChoices(kept: unknown, mine: unknown, theirs: unknown): DayMention[] | null {
  const base = sanitizeMentions(kept);
  const choices = sanitizeMentions(mine).filter(isUserChoice);
  for (const t of sanitizeMentions(theirs).filter(isUserChoice)) {
    const i = choices.findIndex((c) => c.id === t.id);
    const cur = choices[i];
    if (!cur) choices.push(t);
    else if ((t.decidedAt ?? '') > (cur.decidedAt ?? '')) choices[i] = t;
  }
  const same = (a: DayMention, b: DayMention): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (choices.every((c) => base.some((b) => same(b, c)))) return null;
  return carryOverMentions(choices, base);
}

/**
 * Analyse précédente + nouvelle analyse → analyse à enregistrer. Détection désactivée : rien de
 * nouveau n'a été cherché, les mentions existantes restent telles quelles (masquées, pas effacées).
 */
export function mergeAnalysisMentions(
  prev: EntryAnalysis | undefined,
  next: EntryAnalysis,
  detection: boolean,
): EntryAnalysis {
  const list = detection ? carryOverMentions(prev?.mentions, next.mentions) : sanitizeMentions(prev?.mentions);
  const out: EntryAnalysis = { ...next };
  if (list.length > 0) out.mentions = list;
  else delete out.mentions;
  return out;
}

/* ------------------------------------------------------------------ */
/* Gestes de l'utilisateur                                             */
/* ------------------------------------------------------------------ */

/** Rattache (ou déplace) une mention à `day` : confirmée, `kind` recalculé. */
export function settleMention(m: DayMention, day: DayKey, sourceDay: DayKey): DayMention {
  const out: DayMention = { ...m, day, kind: kindOf(day, sourceDay), status: 'confirmed' };
  delete out.choices;
  return out;
}

/** Nouveau texte (rogné, borné) : la mention devient confirmée. null si le texte est vide. */
export function editMention(m: DayMention, text: string): DayMention | null {
  const t = clipText(oneLine(text), MAX_TEXT);
  if (!t || m.day === '') return null;
  return { ...m, text: t, status: 'confirmed' };
}

/** Rétablit une mention retirée : confirmée si elle avait un jour, sinon de nouveau proposée. */
export function restoreMention(m: DayMention): DayMention {
  return { ...m, status: m.day !== '' ? 'confirmed' : 'proposed' };
}

/** Le jour visé peut-il être choisi pour une entrée du jour `sourceDay` ? */
export function isChoosableDay(day: string, sourceDay: DayKey, choices: readonly DayKey[] = []): boolean {
  return choices.includes(day) || isInWindow(day, sourceDay, false);
}

/* ------------------------------------------------------------------ */
/* Synthèse : signature et références                                  */
/* ------------------------------------------------------------------ */

const LINKS_SUFFIX_RE = /^\+a\d+-[0-9a-f]{8}$/;

/**
 * Signature de synthèse d'un jour : `base` (= entriesSignature des entrées analysées) suivie, s'il
 * y a des notes d'autres jours, de `+a<n>-<hash du contenu>`. Sans note : `base` à l'identique
 * (aucune régénération au déploiement). C'est le contenu qui compte, pas `updatedAt` : une
 * ré-analyse qui redonne les mêmes faits ne régénère rien. Seules comptent les notes envoyées au
 * modèle (`synthesisRefs`) : une répétition (`repeatOf`) n'en fait pas partie ; si l'original
 * disparaît, elle prend sa place et la signature change.
 */
export function linksSignature(base: string, links: readonly DayLink[]): string {
  const sent = links.filter((l) => !l.repeatOf);
  if (sent.length === 0) return base;
  const keys = sent.map((l) => `${l.entryId}:${l.mention.day}:${fnv1a(foldWhen(l.mention.text))}`).sort();
  return `${base}+a${sent.length}-${fnv1a(keys.join('|'))}`;
}

/**
 * Notes qu'une synthèse écrite aujourd'hui reçoit : celles dites AVANT aujourd'hui. Celles dites
 * aujourd'hui attendent le lendemain, toutes ensemble (une seule régénération, à la première
 * ouverture du lendemain), même quand le jour visé est généré aujourd'hui pour une autre raison :
 * une série de notes dites dans la journée ne relance jamais la synthèse le jour même.
 */
export function settledLinks(links: readonly DayLink[], today: DayKey): DayLink[] {
  return links.filter((l) => l.sourceDay < today);
}

/** `basedOn` → partie « entrées » et suffixe « notes d'autres jours » (éventuellement vide). */
export function splitSignature(sig: string): { base: string; suffix: string } {
  const i = sig.indexOf('+');
  return i < 0 ? { base: sig, suffix: '' } : { base: sig.slice(0, i), suffix: sig.slice(i) };
}

/** Suffixe écrit par cette version (ou absent) ? Un suffixe inconnu vient d'une version plus récente. */
export function isKnownSignatureSuffix(suffix: string): boolean {
  return suffix === '' || LINKS_SUFFIX_RE.test(suffix);
}

export interface SynthesisRef {
  /** « A1 », « A2 »… (faits racontés plus tard) ; « P1 »… (prévu). */
  ref: string;
  link: DayLink;
}

/** Notes envoyées à la synthèse (une seule fois par fait), numérotées dans l'ordre où elles ont été dites. */
export function synthesisRefs(links: readonly DayLink[]): { past: SynthesisRef[]; future: SynthesisRef[] } {
  const past: SynthesisRef[] = [];
  const future: SynthesisRef[] = [];
  for (const link of links.filter((l) => !l.repeatOf).sort(bySaid)) {
    if (link.mention.kind === 'past') past.push({ ref: `A${past.length + 1}`, link });
    else future.push({ ref: `P${future.length + 1}`, link });
  }
  return { past, future };
}
