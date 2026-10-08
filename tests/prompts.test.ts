import { describe, expect, it } from 'vitest';
import {
  ENTRY_AUDIO_PROMPT,
  ENTRY_AUDIO_PROMPT_WITH_MENTIONS,
  ENTRY_AUDIO_SCHEMA,
  ENTRY_AUDIO_SCHEMA_WITH_MENTIONS,
  ENTRY_TEXT_PROMPT,
  ENTRY_TEXT_PROMPT_WITH_MENTIONS,
  ENTRY_TEXT_SCHEMA,
  ENTRY_TEXT_SCHEMA_WITH_MENTIONS,
  INAUDIBLE_TITLE,
  MENTIONS_RULE,
  SYNTHESIS_ADDITIONS_RULES,
  SYNTHESIS_PLANNED_RULES,
  SYNTHESIS_PROMPT,
  SYNTHESIS_SCHEMA,
  SYNTHESIS_SCHEMA_WITH_ADDITIONS,
  SYSTEM_INSTRUCTION,
  audioSchemaFor,
  buildAudioRequestText,
  buildSynthesisInput,
  buildSynthesisRequestText,
  buildTextRequestText,
  formatDayMarks,
  formatEntryContext,
  isInaudibleTranscript,
  normalizeAnalysis,
  normalizeSynthesis,
  normalizeTranscript,
  synthesisRefMap,
  synthesisSchemaFor,
  textSchemaFor,
} from '../src/lib/prompts';
import type { JsonSchema } from '../src/lib/prompts';
import type { DayLink, Entry, EntryContext } from '../src/lib/types';
import { formatDayFr } from '../src/lib/util';

/** Date ISO correspondant à une heure LOCALE du 8 octobre 2026 (indépendant du fuseau). */
function at(h: number, m: number): string {
  return new Date(2026, 9, 8, h, m).toISOString();
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    day: '2026-10-08',
    createdAt: at(8, 15),
    updatedAt: at(8, 20),
    source: 'text',
    transcript: 'Bonjour.',
    ...over,
  };
}

/** Mots-clés JSON Schema acceptés par Gemini (api-notes §1.4). */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'minimum',
  'maximum',
]);

function walk(schema: JsonSchema, visit: (s: JsonSchema, path: string) => void, path = '$'): void {
  visit(schema, path);
  for (const [k, sub] of Object.entries(schema.properties ?? {})) walk(sub, visit, `${path}.${k}`);
  if (schema.items) walk(schema.items, visit, `${path}[]`);
}

describe('prompts', () => {
  it('sont en français et couvrent les consignes de SPEC §6', () => {
    for (const p of [SYSTEM_INSTRUCTION, ENTRY_AUDIO_PROMPT, ENTRY_TEXT_PROMPT, SYNTHESIS_PROMPT]) {
      expect(p.length).toBeGreaterThan(200);
    }
    expect(SYSTEM_INSTRUCTION).toMatch(/n'invente jamais/);
    expect(ENTRY_AUDIO_PROMPT).toContain('« euh »');
    expect(ENTRY_AUDIO_PROMPT).toMatch(/Ne reformule pas, ne résume pas/);
    expect(ENTRY_AUDIO_PROMPT).toContain(INAUDIBLE_TITLE);
    expect(ENTRY_AUDIO_PROMPT).toContain('transcript = ""');
    for (const p of [ENTRY_AUDIO_PROMPT, ENTRY_TEXT_PROMPT]) {
      expect(p).toContain('8 mots au maximum');
      expect(p).toContain('première personne');
      expect(p).toContain("à l'infinitif");
      expect(p).toMatch(/-2, -1, 0, 1, 2/);
      expect(p).toContain('liste vide');
    }
    expect(SYNTHESIS_PROMPT).toContain('3 à 6 phrases');
    expect(SYNTHESIS_PROMPT).toContain('2 à 5 moments forts');
    expect(SYNTHESIS_PROMPT).toMatch(/dédoublonn|fusionne/);
  });

  it('formatEntryContext : date en toutes lettres + heure', () => {
    expect(formatEntryContext({ day: '2026-10-08', time: '07:42' })).toBe(
      `Date : ${formatDayFr('2026-10-08')}, heure : 07:42`,
    );
    expect(formatEntryContext({ day: '2026-10-08', time: '07:42' })).toContain('8 octobre 2026');
  });

  it('buildTextRequestText délimite le texte de l’entrée', () => {
    const t = buildTextRequestText('  Mon texte.  ', { day: '2026-10-08', time: '21:05' });
    expect(t.startsWith(ENTRY_TEXT_PROMPT)).toBe(true);
    expect(t).toContain('heure : 21:05');
    expect(t).toContain('<entree>\nMon texte.\n</entree>');
  });
});

describe('schémas JSON', () => {
  it('n’utilisent que des mots-clés acceptés par Gemini', () => {
    for (const schema of [
      ENTRY_AUDIO_SCHEMA,
      ENTRY_TEXT_SCHEMA,
      SYNTHESIS_SCHEMA,
      ENTRY_AUDIO_SCHEMA_WITH_MENTIONS,
      ENTRY_TEXT_SCHEMA_WITH_MENTIONS,
      SYNTHESIS_SCHEMA_WITH_ADDITIONS,
    ]) {
      walk(schema, (s, path) => {
        for (const k of Object.keys(s)) expect(ALLOWED_KEYWORDS.has(k), `${path}.${k}`).toBe(true);
        if (s.type === 'object') {
          // tout champ déclaré est requis
          expect([...(s.required ?? [])].sort(), path).toEqual(Object.keys(s.properties ?? {}).sort());
        }
      });
      // sérialisable tel quel
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    }
  });

  it('audio : transcription en premier, puis les champs d’analyse', () => {
    expect(Object.keys(ENTRY_AUDIO_SCHEMA.properties ?? {})).toEqual([
      'transcript',
      'title',
      'summary',
      'mood',
      'themes',
      'people',
      'places',
      'todos',
    ]);
    const score = ENTRY_AUDIO_SCHEMA.properties?.['mood']?.properties?.['score'];
    expect(score?.type).toBe('integer');
    expect(score?.enum).toEqual([-2, -1, 0, 1, 2]);
    expect(ENTRY_AUDIO_SCHEMA.properties?.['themes']?.maxItems).toBe(5);
  });

  it('texte : analyse seule (pas de transcription)', () => {
    expect(Object.keys(ENTRY_TEXT_SCHEMA.properties ?? {})).toEqual([
      'title',
      'summary',
      'mood',
      'themes',
      'people',
      'places',
      'todos',
    ]);
  });

  it('synthèse : résumé, humeur, moments forts, thèmes, à faire', () => {
    expect(Object.keys(SYNTHESIS_SCHEMA.properties ?? {})).toEqual([
      'summary',
      'mood',
      'highlights',
      'themes',
      'todos',
    ]);
    expect(SYNTHESIS_SCHEMA.properties?.['highlights']?.maxItems).toBe(5);
  });
});

describe('buildSynthesisInput', () => {
  it('liste horodatée triée chronologiquement, jour en toutes lettres', () => {
    const entries: Entry[] = [
      entry({
        id: 'b',
        createdAt: at(18, 30),
        transcript: 'Soirée calme.\n\n\n\nJe lis.',
        analysis: {
          title: 'Soirée lecture',
          summary: '',
          mood: { score: 1, label: 'serein' },
          themes: [],
          people: [],
          places: [],
          todos: [],
        },
      }),
      entry({
        id: 'a',
        createdAt: at(7, 5),
        transcript: 'Réveil difficile.',
        analysis: {
          title: 'Réveil',
          summary: '',
          mood: { score: -1, label: 'fatigué' },
          themes: [],
          people: [],
          places: [],
          todos: [],
        },
      }),
      entry({ id: 'c', createdAt: at(12, 0), transcript: 'Déjeuner avec Marie.' }),
    ];
    const out = buildSynthesisInput('2026-10-08', entries);
    expect(out).toContain(formatDayFr('2026-10-08'));
    expect(out).toContain('3 entrées');
    const i1 = out.indexOf('07:05 — Réveil\nRéveil difficile.');
    const i2 = out.indexOf('12:00 — Sans titre\nDéjeuner avec Marie.');
    const i3 = out.indexOf('18:30 — Soirée lecture\nSoirée calme.\n\nJe lis.');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // l'entrée d'origine n'est pas modifiée (tri sur une copie)
    expect(entries.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('singulier pour une seule entrée', () => {
    expect(buildSynthesisInput('2026-10-08', [entry()])).toContain('(1 entrée,');
  });
});

describe('normalizeAnalysis', () => {
  it('valeurs par défaut pour une entrée illisible', () => {
    for (const raw of [null, undefined, 'texte', 42, [1, 2], {}]) {
      expect(normalizeAnalysis(raw)).toEqual({
        title: 'Sans titre',
        summary: '',
        mood: { score: 0, label: 'neutre' },
        themes: [],
        people: [],
        places: [],
        todos: [],
      });
    }
  });

  it('garde une analyse correcte telle quelle', () => {
    const a = {
      title: 'Déjeuner avec Marie',
      summary: "J'ai déjeuné avec Marie. C'était bien.",
      mood: { score: 1, label: 'content' },
      themes: ['amitié', 'travail'],
      people: ['Marie'],
      places: ['Lyon'],
      todos: ['rappeler Paul'],
    };
    expect(normalizeAnalysis(a)).toEqual(a);
  });

  it('borne et arrondit le score', () => {
    const score = (s: unknown) => normalizeAnalysis({ mood: { score: s, label: 'x' } }).mood.score;
    expect(score(5)).toBe(2);
    expect(score(-7)).toBe(-2);
    expect(score(1.6)).toBe(2);
    expect(score(-0.4)).toBe(0);
    expect(Object.is(score(-0.4), -0)).toBe(false);
    expect(score('1')).toBe(1);
    expect(score('-1,2')).toBe(-1);
    expect(score('beaucoup')).toBe(0);
    expect(score(Number.NaN)).toBe(0);
    expect(score(null)).toBe(0);
  });

  it('libellé d’humeur : rogné, minuscules, défaut selon le score', () => {
    expect(normalizeAnalysis({ mood: { score: 2, label: '  Fatigué   mais CONTENT. ' } }).mood).toEqual({
      score: 2,
      label: 'fatigué mais content',
    });
    expect(normalizeAnalysis({ mood: { score: -2 } }).mood).toEqual({ score: -2, label: 'très mal' });
    expect(normalizeAnalysis({ mood: 1 }).mood).toEqual({ score: 1, label: 'plutôt bien' });
    expect(normalizeAnalysis({ mood: 'serein' }).mood).toEqual({ score: 0, label: 'serein' });
    expect(normalizeAnalysis({ mood: { score: 0, label: 'x'.repeat(100) } }).mood.label.length).toBeLessThanOrEqual(40);
  });

  it('rogne, dédoublonne (casse et accents ignorés), retire vides et non-chaînes', () => {
    const a = normalizeAnalysis({
      title: '  « Une   journée\n chargée. »  ',
      summary: '  Ligne   un.\r\n\r\n\r\nLigne deux.  ',
      themes: ['Travail', ' travail ', '#Famille', 'famille', '', '   ', null, 3],
      people: ['Éric', 'eric', 'Marie', { nom: 'x' }],
      places: 'Paris',
      todos: ['- Appeler le plombier.', 'appeler le plombier', '2. réserver le train'],
    });
    expect(a.title).toBe('Une journée chargée');
    expect(a.summary).toBe('Ligne un.\n\nLigne deux.');
    expect(a.themes).toEqual(['travail', 'famille', '3']);
    expect(a.people).toEqual(['Éric', 'Marie']);
    expect(a.places).toEqual(['Paris']);
    expect(a.todos).toEqual(['Appeler le plombier.', 'réserver le train']);
  });

  it('borne le nombre d’éléments et la longueur des chaînes', () => {
    const many = Array.from({ length: 30 }, (_, i) => `élément ${i}`);
    const a = normalizeAnalysis({
      title: 'mot '.repeat(60),
      summary: 'phrase longue '.repeat(200),
      themes: many,
      people: many,
      places: many,
      todos: many,
    });
    expect(a.title.length).toBeLessThanOrEqual(80);
    expect(a.title.endsWith('…')).toBe(true);
    expect(a.summary.length).toBeLessThanOrEqual(800);
    expect(a.themes).toHaveLength(5);
    expect(a.people).toHaveLength(10);
    expect(a.places).toHaveLength(10);
    expect(a.todos).toHaveLength(15);
    const longTodo = normalizeAnalysis({ todos: ['a'.repeat(500)] }).todos[0] ?? '';
    expect(longTodo.length).toBeLessThanOrEqual(160);
  });

  it('ne coupe pas un émoji en deux', () => {
    const title = `${'a'.repeat(78)}😄😄`;
    const out = normalizeAnalysis({ title }).title;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});

describe('normalizeSynthesis', () => {
  it('valeurs par défaut', () => {
    expect(normalizeSynthesis(undefined)).toEqual({
      summary: '',
      mood: { score: 0, label: 'neutre' },
      highlights: [],
      themes: [],
      todos: [],
    });
  });

  it('normalise et borne', () => {
    const s = normalizeSynthesis({
      summary: '  Une belle journée.  ',
      mood: { score: '3', label: 'Ravi' },
      highlights: ['A', 'a', 'B', 'C', 'D', 'E', 'F'],
      themes: ['Sport', 'SPORT', 'Lecture'],
      todos: ['Appeler maman', 'appeler maman.', 'Payer le loyer'],
      extra: 'ignoré',
    });
    expect(s).toEqual({
      summary: 'Une belle journée.',
      mood: { score: 2, label: 'ravi' },
      highlights: ['A', 'B', 'C', 'D', 'E'],
      themes: ['sport', 'lecture'],
      todos: ['Appeler maman', 'Payer le loyer'],
    });
  });
});

describe('transcription', () => {
  it('normalizeTranscript conserve les paragraphes', () => {
    expect(normalizeTranscript('  Bonjour   toi.\r\n\r\n\r\n  Suite.  ')).toBe('Bonjour toi.\n\nSuite.');
    expect(normalizeTranscript(undefined)).toBe('');
  });

  it('isInaudibleTranscript', () => {
    expect(isInaudibleTranscript('')).toBe(true);
    expect(isInaudibleTranscript(' [inaudible] … [Inaudible]. ')).toBe(true);
    expect(isInaudibleTranscript('Bonjour [inaudible].')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Mentions d'autres jours (« Rattacher aux autres jours »)            */
/* ------------------------------------------------------------------ */

const AUTO: EntryContext = { day: '2026-10-08', time: '07:42', dayLinks: 'auto' };
const OFF: EntryContext = { day: '2026-10-08', time: '07:42', dayLinks: 'off' };

describe('mentions — prompts et schémas', () => {
  it('schémas : `mentions` en DERNIÈRE clé et requis ; transcription toujours en premier', () => {
    const audioKeys = Object.keys(ENTRY_AUDIO_SCHEMA_WITH_MENTIONS.properties ?? {});
    expect(audioKeys[0]).toBe('transcript');
    expect(audioKeys.at(-1)).toBe('mentions');
    expect(audioKeys.slice(0, -1)).toEqual(Object.keys(ENTRY_AUDIO_SCHEMA.properties ?? {}));
    expect(Object.keys(ENTRY_TEXT_SCHEMA_WITH_MENTIONS.properties ?? {}).at(-1)).toBe('mentions');
    expect(ENTRY_AUDIO_SCHEMA_WITH_MENTIONS.required?.at(-1)).toBe('mentions');
    const items = ENTRY_TEXT_SCHEMA_WITH_MENTIONS.properties?.['mentions']?.items;
    expect(Object.keys(items?.properties ?? {})).toEqual(['when', 'date', 'text']);
    expect(ENTRY_TEXT_SCHEMA_WITH_MENTIONS.properties?.['mentions']?.maxItems).toBe(5);
    // Les schémas d'origine ne changent pas
    expect('mentions' in (ENTRY_AUDIO_SCHEMA.properties ?? {})).toBe(false);
    expect(Object.keys(SYNTHESIS_SCHEMA_WITH_ADDITIONS.properties ?? {}).at(-1)).toBe('additions');
    expect('additions' in (SYNTHESIS_SCHEMA.properties ?? {})).toBe(false);
  });

  it('consigne courte, insérée dans la liste des champs, absente des prompts d’origine', () => {
    expect(MENTIONS_RULE.length).toBeLessThan(1200);
    expect(MENTIONS_RULE).toContain('« avant-hier »');
    expect(MENTIONS_RULE).toContain('« demain »');
    expect(MENTIONS_RULE).toContain('Le plus souvent, la liste est vide.');
    expect(ENTRY_AUDIO_PROMPT).not.toContain('mentions');
    expect(ENTRY_TEXT_PROMPT).not.toContain('mentions');
    for (const p of [ENTRY_AUDIO_PROMPT_WITH_MENTIONS, ENTRY_TEXT_PROMPT_WITH_MENTIONS]) {
      const i = p.indexOf(MENTIONS_RULE);
      expect(i).toBeGreaterThan(p.indexOf('- todos :'));
      expect(i).toBeLessThan(p.indexOf("Chaque élément n'apparaît qu'une fois."));
    }
    expect(ENTRY_AUDIO_PROMPT_WITH_MENTIONS.replace(`\n${MENTIONS_RULE}`, '')).toBe(ENTRY_AUDIO_PROMPT);
  });

  it('repères calculés par le code : jours de la semaine, peu de chiffres, chaque jour nommé une fois', () => {
    const marks = formatDayMarks('2026-10-08');
    expect(marks).toBe(
      'Repères : jours passés : jeudi 1 octobre, vendredi 2, samedi 3, dimanche 4, lundi 5, mardi 6 (avant-hier), ' +
        'mercredi 7 (hier) ; jours à venir : vendredi 9 octobre (demain), samedi 10 (après-demain), dimanche 11, ' +
        'lundi 12, mardi 13, mercredi 14, jeudi 15.',
    );
    // Aucune date AAAA-MM-JJ (≈ 10 jetons chacune), « hier » et « demain » nommés une seule fois
    expect(marks).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(marks.match(/\(hier\)/g)).toHaveLength(1);
    expect(marks.length).toBeLessThan(280);
    // Changement de mois : le mois est écrit au premier jour de chaque mois
    expect(formatDayMarks('2026-10-02')).toContain(
      'jours passés : vendredi 25 septembre, samedi 26, dimanche 27, lundi 28, mardi 29, mercredi 30 (avant-hier), jeudi 1 octobre (hier)',
    );
    // Changement d'année : l'année n'est écrite que si elle diffère de celle de l'entrée
    expect(formatDayMarks('2026-12-31')).toContain('jours à venir : vendredi 1 janvier 2027 (demain), samedi 2 (après-demain)');
    expect(formatDayMarks('2027-01-02')).toContain('jours passés : samedi 26 décembre 2026, dimanche 27,');
    expect(formatDayMarks('2027-01-02')).toContain('jeudi 31 (avant-hier), vendredi 1 janvier (hier)');
  });

  it('coût : consigne, repères et schéma ajoutent moins de 1 400 caractères (≈ 400 jetons, SPEC §16.9)', () => {
    const ctx: EntryContext = { day: '2026-10-08', time: '07:42', dayLinks: 'auto' };
    const off: EntryContext = { ...ctx, dayLinks: 'off' };
    const prompt = buildTextRequestText('x', ctx).length - buildTextRequestText('x', off).length;
    const schema = JSON.stringify(textSchemaFor(ctx)).length - JSON.stringify(textSchemaFor(off)).length;
    expect(prompt + schema).toBeLessThan(1400);
    // Les chiffres coûtent environ un jeton chacun : peu de chiffres dans les repères
    expect(formatDayMarks('2026-10-08').match(/\d/g)?.length ?? 0).toBeLessThanOrEqual(24);
  });

  it('requêtes : repères, consigne et schéma seulement si la détection est active', () => {
    expect(formatEntryContext(OFF)).toBe(formatEntryContext({ day: '2026-10-08', time: '07:42' }));
    expect(formatEntryContext(AUTO)).toBe(`${formatEntryContext(OFF)}\n${formatDayMarks('2026-10-08')}`);
    expect(buildAudioRequestText(OFF)).toBe(`${ENTRY_AUDIO_PROMPT}\n\n${formatEntryContext(OFF)}`);
    expect(buildAudioRequestText(AUTO).startsWith(ENTRY_AUDIO_PROMPT_WITH_MENTIONS)).toBe(true);
    expect(buildTextRequestText('x', AUTO)).toContain('Repères :');
    expect(buildTextRequestText('x', OFF)).not.toContain('Repères');
    expect(audioSchemaFor(AUTO)).toBe(ENTRY_AUDIO_SCHEMA_WITH_MENTIONS);
    expect(audioSchemaFor(OFF)).toBe(ENTRY_AUDIO_SCHEMA);
    expect(audioSchemaFor({ day: '2026-10-08', time: '07:42' })).toBe(ENTRY_AUDIO_SCHEMA);
    expect(textSchemaFor(AUTO)).toBe(ENTRY_TEXT_SCHEMA_WITH_MENTIONS);
    expect(textSchemaFor(OFF)).toBe(ENTRY_TEXT_SCHEMA);
  });
});

describe('normalizeAnalysis — mentions', () => {
  const base = {
    title: 'Dîner',
    summary: '',
    mood: { score: 1, label: 'content' },
    themes: [],
    people: [],
    places: [],
    todos: [],
  };
  const mentions = [
    { when: 'avant-hier', date: '2026-10-06', text: "J'ai dîné avec Paul." },
    { when: 'hier', date: '', text: 'Inventé.' },
  ];

  it('validées (ancrage, jour fixé par le code) seulement si la détection est active', () => {
    const a = normalizeAnalysis({ ...base, mentions }, AUTO, "Avant-hier j'ai dîné avec Paul.");
    expect(a.mentions).toHaveLength(1);
    expect(a.mentions?.[0]).toMatchObject({ day: '2026-10-06', kind: 'past', status: 'auto', when: 'avant-hier' });
    // Détection inactive : champ ignoré
    expect('mentions' in normalizeAnalysis({ ...base, mentions }, OFF, "Avant-hier j'ai dîné avec Paul.")).toBe(false);
    expect('mentions' in normalizeAnalysis({ ...base, mentions })).toBe(false);
    // Rien de valide : pas de champ (analyse identique à celle d'avant)
    expect(normalizeAnalysis({ ...base, mentions: [] }, AUTO, 'x')).toEqual(normalizeAnalysis(base));
    expect(normalizeAnalysis({ ...base, mentions: 'n/a' }, AUTO, 'x')).toEqual(normalizeAnalysis(base));
  });
});

describe('synthèse — notes d’autres jours', () => {
  function link(
    ref: string,
    kind: 'past' | 'future',
    text: string,
    extra: { when?: string; sourceDay?: string; sourceCreatedAt?: string; repeatOf?: string } = {},
  ): DayLink {
    const [entryId = '', id = ''] = ref.split('/');
    const l: DayLink = {
      entryId,
      sourceDay: extra.sourceDay ?? '2026-10-10',
      sourceCreatedAt: extra.sourceCreatedAt ?? new Date(2026, 9, 10, 8, 15).toISOString(),
      mention: { id, kind, day: '2026-10-08', when: extra.when ?? 'avant-hier', text, status: 'auto' },
      ref,
    };
    if (extra.repeatOf) l.repeatOf = extra.repeatOf;
    return l;
  }
  const added = link('e9/m1', 'past', "J'ai dîné avec Paul.");
  const repeat = link('e10/m2', 'past', 'Dîné avec Paul.', { repeatOf: 'e9/m1' });
  const planned = link('e7/m3', 'future', 'Je vais chez le dentiste à 10 h.', {
    when: 'demain',
    sourceDay: '2026-10-07',
    sourceCreatedAt: new Date(2026, 9, 7, 21, 4).toISOString(),
  });

  it('sans note : texte et schéma identiques à ceux d’avant', () => {
    const entries = [entry()];
    expect(buildSynthesisRequestText('2026-10-08', entries, [])).toBe(buildSynthesisRequestText('2026-10-08', entries));
    expect(buildSynthesisInput('2026-10-08', entries, [])).toBe(buildSynthesisInput('2026-10-08', entries));
    expect(buildSynthesisRequestText('2026-10-08', entries)).toBe(
      `${SYNTHESIS_PROMPT}\n\n${buildSynthesisInput('2026-10-08', entries)}`,
    );
    expect(synthesisSchemaFor([])).toBe(SYNTHESIS_SCHEMA);
    expect(synthesisSchemaFor(undefined)).toBe(SYNTHESIS_SCHEMA);
  });

  it('ajouts [A…] et prévu [P…] après les entrées, une fois par fait, avec leurs consignes', () => {
    const text = buildSynthesisRequestText('2026-10-08', [entry()], [repeat, planned, added]);
    expect(text).toContain(SYNTHESIS_ADDITIONS_RULES);
    expect(text).toContain(SYNTHESIS_PLANNED_RULES);
    expect(text).toContain(
      "## Ajouts racontés les jours suivants, dans d'autres entrées\n[A1] (dit le samedi 10 octobre 2026 à 08:15, « avant-hier ») J'ai dîné avec Paul.",
    );
    expect(text).toContain(
      '## Prévu pour ce jour (annoncé plus tôt)\n[P1] (annoncé le mercredi 7 octobre 2026 à 21:04, « demain ») Je vais chez le dentiste à 10 h.',
    );
    expect(text).not.toContain('Dîné avec Paul.');
    expect(text).not.toContain('[A2] (');
    expect(text.indexOf('### 08:15')).toBeLessThan(text.indexOf('[A1] ('));
    expect(SYNTHESIS_PLANNED_RULES).toMatch(/Ne dis JAMAIS qu'une chose prévue a eu lieu/);
    expect(synthesisSchemaFor([planned, added])).toBe(SYNTHESIS_SCHEMA_WITH_ADDITIONS);
    // Seulement du prévu : pas de verdicts à demander
    expect(synthesisSchemaFor([planned])).toBe(SYNTHESIS_SCHEMA);
    expect(buildSynthesisRequestText('2026-10-08', [entry()], [planned])).not.toContain(SYNTHESIS_ADDITIONS_RULES);
    expect(synthesisRefMap([planned, added, repeat])).toEqual({ A1: 'e9/m1' });
  });

  it('verdicts : références connues seulement, statuts valides, première réponse retenue', () => {
    const refs = { A1: 'e9/m1', A2: 'e10/m2' };
    const s = normalizeSynthesis(
      {
        summary: 'Journée.',
        additions: [
          { ref: 'A1', status: 'deja' },
          { ref: '[A2]', status: 'Complète' },
          { ref: 'A1', status: 'nouveau' },
          { ref: 'A9', status: 'nouveau' },
          { ref: 'A2', status: 'peut-être' },
          'n/a',
        ],
      },
      refs,
    );
    expect(s.mentionVerdicts).toEqual({ 'e9/m1': 'deja', 'e10/m2': 'complete' });
    expect(normalizeSynthesis({ summary: 'x' }, refs).mentionVerdicts).toEqual({});
    expect('mentionVerdicts' in normalizeSynthesis({ summary: 'x', additions: [{ ref: 'A1', status: 'deja' }] })).toBe(
      false,
    );
  });
});
