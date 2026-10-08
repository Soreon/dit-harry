import type { AiClient, DaySynthesis, Entry, EntryAnalysis, EntryContext, Mood } from '../types';
import { AppError } from '../errors';
import { formatDayFr, formatDuration, sleep, stripMimeParams } from '../util';

/* ------------------------------------------------------------------ */
/* Analyse déterministe d'un texte (heuristiques françaises simples)   */
/* ------------------------------------------------------------------ */

/** Minuscules sans accents, pour comparer des mots. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

const STOPWORDS = new Set(
  (
    'a ai aie aies ait alors au aucun aussi autre autres aux avec avais avait avant avoir ' +
    'beaucoup bien bon c ca car ce ceci cela celle celui ces cet cette ceux chaque chez comme ' +
    'comment d dans de des deja depuis dois doit donc dont du elle elles en encore entre es est ' +
    'et etaient etais etait ete etre eu eux faire fais fait faut fois font ici il ils j je jour ' +
    'juste l la le les leur leurs lui m ma mais me meme mes moi mon n ne ni non nos notre nous ' +
    'on ont ou par parce pas peu peut peux plus pour pourquoi puis qu quand que quel quelle ' +
    'quelque quelques qui quoi s sa sans se ses si sinon soi soir son sont sous suis sur t ta ' +
    'tant te tes toi ton tous tout toute toutes tres trop tu un une va vais vers veux vont vos ' +
    'votre vous y matin journee aujourd hui demain hier vraiment chose choses temps petit ' +
    'petite ensuite apres enfin assez avoir quelqu cote ko mo transcription simulee mode demo ' +
    'enregistrement environ'
  ).split(' '),
);

const POSITIVE = new Set(
  (
    'heureux heureuse content contente joie joyeux joyeuse super genial geniale ravi ravie ' +
    'sourire souri rire ri chouette serein sereine serenite apaise apaisee calme fier fiere ' +
    'reussi reussite plaisir bonheur merci gratitude adore aime magnifique agreable excellent ' +
    'excellente top enthousiaste motive motivee soulage soulagee detendu detendue bien belle beau ' +
    'energie repose reposee beaute'
  ).split(' '),
);

const NEGATIVE = new Set(
  (
    'triste tristesse fatigue fatiguee epuise epuisee stress stresse stressee stressant ' +
    'stressante angoisse angoissee anxieux anxieuse inquiet inquiete colere enerve enervee decu ' +
    'decue deception peur pleure pleurer larmes difficile dur dure nul nulle seul seule solitude ' +
    'malade mal mauvais mauvaise deprime deprimee agace agacee frustre frustree frustration ' +
    'perdu perdue lourd lourde creve marre'
  ).split(' '),
);

const NEGATORS = new Set(['pas', 'plus', 'jamais', 'ni', 'guere']);
const PLACE_PREPOSITIONS = new Set(['a', 'au', 'aux', 'en', 'dans', 'depuis', 'vers']);

interface Token {
  text: string;
  folded: string;
  index: number;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\p{L}+/gu)) {
    out.push({ text: m[0], folded: fold(m[0]), index: m.index });
  }
  return out;
}

/** Vrai si le mot commence une phrase (début du texte, ou après . ! ? … : en ignorant ( « " ). */
function startsSentence(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /[\s(«"“'’]/u.test(text.charAt(i))) i--;
  return i < 0 || /[.!?…:]/u.test(text.charAt(i));
}

function isCapitalized(word: string): boolean {
  const first = word.charAt(0);
  return first !== first.toLowerCase() && word.length >= 2;
}

function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?…](?=\s|$)/u.exec(t);
  return (m ? m[0] : t).trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/u, '')}…`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const v = it.trim();
    const k = fold(v);
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const words = (s: string) => s.split(/\s+/u).filter(Boolean);

/** Titre : première proposition de la première phrase (jusqu'à la virgule), 6 mots au plus. */
function makeTitle(text: string): string {
  const sentence = firstSentence(text).replace(/[.!?…]+$/u, '');
  const clause = words(sentence.split(/[,:;(—–]/u)[0] ?? '');
  const picked = clause.length >= 2 ? clause : words(sentence);
  if (picked.length === 0) return 'Entrée sans texte';
  if (picked.length <= 6) return capitalize(picked.join(' ').replace(/[,;:]+$/u, ''));
  const cut = picked.slice(0, 6);
  // Pas de petit mot outil en fin de titre tronqué (« … avec la… »).
  const isFiller = (w: string) => fold(w).length <= 3 && STOPWORDS.has(fold(w));
  while (cut.length > 2 && isFiller(cut.at(-1) ?? '')) cut.pop();
  return capitalize(`${cut.join(' ').replace(/[,;:]+$/u, '')}…`);
}

/** Humeur : libellé selon le score (épicène, 1 à 3 mots). */
function moodFromScore(score: Mood['score'], mixed: boolean): Mood {
  switch (score) {
    case 2:
      return { score, label: 'au top' };
    case 1:
      return { score, label: mixed ? 'plutôt bien' : 'bien' };
    case 0:
      return { score, label: mixed ? 'en demi-teinte' : 'neutre' };
    case -1:
      return { score, label: mixed ? 'un peu à plat' : 'pas au top' };
    case -2:
      return { score, label: 'au plus bas' };
  }
}

function clampScore(n: number): Mood['score'] {
  if (n >= 2) return 2;
  if (n >= 1) return 1;
  if (n <= -2) return -2;
  if (n <= -1) return -1;
  return 0;
}

function detectMood(tokens: Token[]): Mood {
  let pos = 0;
  let neg = 0;
  tokens.forEach((t, i) => {
    const polarity = POSITIVE.has(t.folded) ? 1 : NEGATIVE.has(t.folded) ? -1 : 0;
    if (!polarity) return;
    // Négation simple : « pas bien », « plus jamais content »…
    const negated = [tokens[i - 1], tokens[i - 2]].some((p) => p && NEGATORS.has(p.folded));
    if ((polarity > 0) !== negated) pos++;
    else neg++;
  });
  const diff = pos - neg;
  const score = clampScore(diff >= 3 ? 2 : diff <= -3 ? -2 : Math.sign(diff));
  return moodFromScore(score, pos > 0 && neg > 0);
}

function detectNames(text: string, tokens: Token[]): { people: string[]; places: string[] } {
  const people: string[] = [];
  const places: string[] = [];
  tokens.forEach((t, i) => {
    if (!isCapitalized(t.text) || STOPWORDS.has(t.folded) || startsSentence(text, t.index)) return;
    const prev = tokens[i - 1];
    if (prev && PLACE_PREPOSITIONS.has(prev.folded)) places.push(t.text);
    else people.push(t.text);
  });
  return { people: dedupe(people), places: dedupe(places) };
}

/** Mots-clés (minuscules sans accents, singulier) → thème. */
const THEME_KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  ['travail', ['travail', 'bureau', 'reunion', 'projet', 'dossier', 'collegue', 'boulot', 'client', 'chef', 'mail']],
  ['famille', ['maman', 'papa', 'mere', 'pere', 'frere', 'soeur', 'famille', 'parent', 'enfant', 'fils', 'fille']],
  ['amitié', ['ami', 'amie', 'copain', 'copine', 'pote', 'amitie']],
  ['santé', ['medecin', 'malade', 'sante', 'sommeil', 'nuit', 'dormi', 'sport', 'courir', 'course', 'yoga']],
  ['nature', ['parc', 'balade', 'promenade', 'marcher', 'marche', 'foret', 'mer', 'montagne', 'jardin', 'soleil']],
  ['lecture', ['livre', 'lire', 'lu', 'lecture', 'roman', 'page']],
  ['repas', ['diner', 'dine', 'dejeuner', 'manger', 'mange', 'cafe', 'pain', 'restaurant', 'repas', 'cuisine']],
  ['voyage', ['train', 'voyage', 'vacances', 'avion', 'billet', 'valise', 'retour']],
  ['maison', ['maison', 'appartement', 'menage', 'rangement', 'travaux']],
  ['loisirs', ['film', 'serie', 'musique', 'concert', 'jeu', 'dessin', 'photo']],
  ['argent', ['argent', 'budget', 'banque', 'facture', 'impot']],
];

const KEYWORD_TO_THEME = new Map<string, string>(
  THEME_KEYWORDS.flatMap(([theme, words]) => words.map((w) => [w, theme] as const)),
);

/** Singulier approximatif : « réunions » → « reunion », « travaux » reste tel quel s'il est connu. */
function themeOf(folded: string): string | undefined {
  return KEYWORD_TO_THEME.get(folded) ?? KEYWORD_TO_THEME.get(folded.replace(/[sx]$/u, ''));
}

/** Thèmes : catégories de mots-clés, complétées par les mots qui reviennent au moins 2 fois. */
function detectThemes(tokens: Token[], exclude: Set<string>): string[] {
  const counts = new Map<string, { word: string; count: number; first: number }>();
  const bump = (key: string, word: string, i: number) => {
    const c = counts.get(key);
    if (c) c.count++;
    else counts.set(key, { word, count: 1, first: i });
  };
  const frequent = new Map<string, { word: string; count: number; first: number }>();
  tokens.forEach((t, i) => {
    if (exclude.has(t.folded)) return;
    const theme = themeOf(t.folded);
    if (theme) {
      bump(`theme:${theme}`, theme, i);
      return;
    }
    if (t.folded.length < 5 || STOPWORDS.has(t.folded)) return;
    if (POSITIVE.has(t.folded) || NEGATIVE.has(t.folded)) return;
    const c = frequent.get(t.folded);
    if (c) c.count++;
    else frequent.set(t.folded, { word: t.text.toLowerCase(), count: 1, first: i });
  });
  for (const [k, c] of frequent) if (c.count >= 2) counts.set(`word:${k}`, c);
  return dedupe(
    [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((c) => c.word),
  ).slice(0, 3);
}

const TODO_RE =
  /\b(?:je dois|il faut|il faudrait|il faudra|penser à|ne pas oublier de|n['’]oublie pas de|j['’]ai prévu de)\s+([^.!?;,\n]+)/giu;

function detectTodos(text: string): string[] {
  const todos: string[] = [];
  for (const m of text.matchAll(TODO_RE)) {
    const clause = (m[1] ?? '').trim();
    // « il faut que je… » : subjonctif, pas une action à l'infinitif.
    if (!clause || /^qu/iu.test(clause)) continue;
    todos.push(clause.split(/\s+/u).slice(0, 10).join(' '));
  }
  return dedupe(todos);
}

/** Analyse déterministe dérivée du texte (même texte → même résultat). */
export function mockAnalyzeText(text: string): EntryAnalysis {
  const clean = text.trim();
  const tokens = tokenize(clean);
  const { people, places } = detectNames(clean, tokens);
  const exclude = new Set([...people, ...places].map(fold));
  return {
    title: makeTitle(clean),
    summary: truncate(firstSentence(clean), 240),
    mood: detectMood(tokens),
    themes: detectThemes(tokens, exclude),
    people,
    places,
    todos: detectTodos(clean),
  };
}

/* ------------------------------------------------------------------ */
/* Transcription simulée                                               */
/* ------------------------------------------------------------------ */

const SAMPLE_TRANSCRIPTS = [
  "Ce matin j'ai pris le temps de marcher jusqu'au parc avec Léa. Il faisait beau et ça m'a fait du bien, un vrai moment de calme. Je dois appeler maman ce soir.",
  "Journée chargée au travail, beaucoup de réunions et du stress. La fatigue se fait sentir mais le projet avance. Je dois finir le dossier pour Paul avant vendredi.",
  "Soirée tranquille à la maison. J'ai lu quelques pages de mon livre et repensé à la discussion avec Samir, ça m'a fait plaisir. Penser à acheter du pain demain matin.",
  "Petit déjeuner en terrasse à Lyon avec Camille, on a beaucoup ri. Le soleil, le café, rien de plus. Ne pas oublier de réserver le train du retour.",
];

/** Durée estimée : en-tête WAV si présent, sinon débit de 32 kbit/s (Opus de l'appli). */
async function estimateDurationSec(audio: Blob, mimeType: string): Promise<number> {
  if (stripMimeParams(mimeType) === 'audio/wav' && audio.size > 44) {
    const head = new DataView(await audio.slice(0, 44).arrayBuffer());
    const byteRate = head.getUint32(28, true);
    if (byteRate > 0) return (audio.size - 44) / byteRate;
  }
  return (audio.size * 8) / 32_000;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

const MAX_INLINE_AUDIO_BYTES = 18 * 1024 * 1024;

/** Transcription factice : un texte d'exemple (choisi selon la taille) + note sur l'enregistrement. */
export async function mockTranscribe(
  audio: Blob,
  mimeType: string,
  ctx: EntryContext,
): Promise<{ body: string; transcript: string }> {
  if (audio.size === 0) return { body: '', transcript: '' };
  const sample = SAMPLE_TRANSCRIPTS[audio.size % SAMPLE_TRANSCRIPTS.length] ?? '';
  const duration = formatDuration(await estimateDurationSec(audio, mimeType));
  const note =
    `(Transcription simulée en mode démo : enregistrement de ${duration}, ` +
    `${formatSize(audio.size)}, ${formatDayFr(ctx.day)} à ${ctx.time}.)`;
  return { body: sample, transcript: `${sample}\n\n${note}` };
}

/* ------------------------------------------------------------------ */
/* Synthèse du jour                                                    */
/* ------------------------------------------------------------------ */

type SynthesisResult = Pick<DaySynthesis, 'summary' | 'mood' | 'highlights' | 'themes' | 'todos'>;

/** Synthèse déterministe à partir des analyses des entrées. */
export function mockSynthesizeDay(entries: Entry[]): SynthesisResult {
  const analyzed = entries
    .filter((e): e is Entry & { analysis: EntryAnalysis } => !!e.analysis)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  if (analyzed.length === 0) {
    return {
      summary: "Je n'ai rien noté de particulier ce jour-là.",
      mood: { score: 0, label: 'neutre' },
      highlights: [],
      themes: [],
      todos: [],
    };
  }

  const n = analyzed.length;
  // Formulation valable pour n'importe quel jour (la synthèse est surtout écrite le lendemain)
  const intro = n === 1 ? "Ce jour-là, j'ai noté un seul moment." : `Ce jour-là, j'ai noté ${n} moments.`;
  const summaries = analyzed
    .map((e) => e.analysis.summary.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((s) => (/[.!?…]$/u.test(s) ? s : `${s}.`));

  const scores = analyzed.map((e) => e.analysis.mood.score);
  const avg = scores.reduce<number>((a, b) => a + b, 0) / n;
  const mixed = scores.some((s) => s > 0) && scores.some((s) => s < 0);
  const mood = moodFromScore(clampScore(Math.round(avg)), mixed);

  const themeCounts = new Map<string, number>();
  for (const e of analyzed) {
    for (const t of e.analysis.themes) themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
  }
  const themes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  return {
    summary: [intro, ...summaries].join(' '),
    mood,
    highlights: dedupe(analyzed.map((e) => e.analysis.title)).slice(0, 5),
    themes,
    todos: dedupe(analyzed.flatMap((e) => e.analysis.todos)),
  };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Gemini simulé : latence ~800 ms, résultats déterministes, aucune requête réseau. */
export function createMockAiClient(opts: { latencyMs?: number } = {}): AiClient {
  const latencyMs = opts.latencyMs ?? 800;

  async function call(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new AppError('network', 'Pas de connexion : Gemini est injoignable.');
    }
    if (latencyMs > 0) await sleep(latencyMs);
  }

  return {
    async analyzeAudio(audio, mimeType, ctx) {
      if (audio.size > MAX_INLINE_AUDIO_BYTES) {
        throw new AppError('other', 'Enregistrement trop long pour être analysé (plus de 18 Mo).', {
          retryable: false,
        });
      }
      await call();
      const { body, transcript } = await mockTranscribe(audio, mimeType, ctx);
      if (!body) {
        return {
          transcript: '',
          analysis: {
            title: 'Enregistrement inaudible',
            summary: '',
            mood: { score: 0, label: 'neutre' },
            themes: [],
            people: [],
            places: [],
            todos: [],
          },
        };
      }
      // L'analyse porte sur le texte d'exemple (la note technique est ignorée).
      return { transcript, analysis: mockAnalyzeText(body) };
    },

    async analyzeText(text) {
      await call();
      return mockAnalyzeText(text);
    },

    async synthesizeDay(_day, entries) {
      await call();
      return mockSynthesizeDay(entries);
    },

    async checkKey() {
      await call();
    },
  };
}
