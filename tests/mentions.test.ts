import { describe, expect, it } from 'vitest';
import {
  MAX_MENTIONS,
  activeMentions,
  carryOverMentions,
  collectDayLinks,
  editMention,
  isChoosableDay,
  isKnownSignatureSuffix,
  kindOf,
  linksSignature,
  mentionId,
  mergeAnalysisMentions,
  mergeMentionChoices,
  pendingProposals,
  readMentions,
  resolveMentions,
  restoreMention,
  sanitizeMentions,
  settleMention,
  settledLinks,
  similarity,
  splitSignature,
  synthesisRefs,
} from '../src/lib/mentions';
import type { DayLink, DayMention, Entry, EntryAnalysis, EntryContext } from '../src/lib/types';

/** Jeudi 8 octobre 2026, 10 h. */
const CTX: EntryContext = { day: '2026-10-08', time: '10:00', dayLinks: 'auto' };

function raw(when: string, text: string, date = ''): { when: string; date: string; text: string } {
  return { when, date, text };
}

function mention(over: Partial<DayMention> & { id: string; day: string }): DayMention {
  return { kind: 'past', when: 'hier', text: 'Un fait.', status: 'auto', ...over };
}

function analysis(mentions?: DayMention[]): EntryAnalysis {
  const a: EntryAnalysis = {
    title: 'Titre',
    summary: '',
    mood: { score: 0, label: 'neutre' },
    themes: [],
    people: [],
    places: [],
    todos: [],
  };
  if (mentions) a.mentions = mentions;
  return a;
}

function entry(id: string, day: string, createdAt: string, mentions?: DayMention[]): Entry {
  return {
    id,
    day,
    createdAt,
    updatedAt: createdAt,
    source: 'text',
    transcript: 'texte',
    analysis: analysis(mentions),
  };
}

describe('resolveMentions — décisions', () => {
  it('repère sûr → rattaché d’office (passé et à venir)', () => {
    const out = resolveMentions(
      [raw('avant-hier', "J'ai dîné avec Paul au restaurant."), raw('demain', 'Je vais chez le dentiste à 10 h.')],
      CTX,
      "Avant-hier, j'ai dîné avec Paul au restaurant. Demain je vais chez le dentiste à 10 h.",
    );
    expect(out).toEqual([
      {
        id: mentionId('avant-hier', "J'ai dîné avec Paul au restaurant."),
        kind: 'past',
        day: '2026-10-06',
        when: 'avant-hier',
        text: "J'ai dîné avec Paul au restaurant.",
        status: 'auto',
      },
      {
        id: mentionId('demain', 'Je vais chez le dentiste à 10 h.'),
        kind: 'future',
        day: '2026-10-09',
        when: 'demain',
        text: 'Je vais chez le dentiste à 10 h.',
        status: 'auto',
      },
    ]);
    expect(out[0]?.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ancrage : le repère doit figurer dans la transcription (casse, accents, nombres ignorés)', () => {
    expect(resolveMentions([raw('hier', 'Un fait.')], CTX, "Aujourd'hui rien.")).toEqual([]);
    expect(resolveMentions([raw('il y a trois jours', 'Un fait.')], CTX, 'Il y a 3 jours, un fait.')).toHaveLength(1);
    expect(resolveMentions([raw('AVANT-HIER', 'Un fait.')], CTX, 'avant hier un fait')).toHaveLength(1);
    expect(resolveMentions([raw('Après-demain', 'Un fait.')], CTX, 'apres-demain : un fait')).toHaveLength(1);
    // « hier » trouvé seulement dans « avant-hier » : le repère a été raccourci, rejeté
    expect(resolveMentions([raw('hier', 'Un fait.')], CTX, 'Avant-hier, un fait.')).toEqual([]);
    expect(resolveMentions([raw('demain', 'Un fait.')], CTX, 'Après-demain, un fait.')).toEqual([]);
    expect(resolveMentions([raw('hier', 'Un fait.')], CTX, 'Avant-hier rien, mais hier un fait.')).toHaveLength(1);
    // Mot entier seulement
    expect(resolveMentions([raw('lundi', 'Un fait.', '2026-10-12')], CTX, 'Les lundis sont durs.')).toEqual([]);
  });

  it('désaccord du modèle sur une règle sûre : proposition [code, modèle], modèle suggéré', () => {
    const [m] = resolveMentions([raw('avant-hier', 'Un fait.', '2026-10-05')], CTX, 'avant-hier un fait');
    expect(m).toMatchObject({ day: '', status: 'proposed', choices: ['2026-10-06', '2026-10-05'], modelDay: '2026-10-05' });
    const [same] = resolveMentions([raw('avant-hier', 'Un fait.', '2026-10-06')], CTX, 'avant-hier un fait');
    expect(same).toMatchObject({ day: '2026-10-06', status: 'auto' });
    expect(same?.modelDay).toBeUndefined();
    // Discours rapporté : « demain » par rapport à lundi, pas au jour de l'entrée.
    const [said] = resolveMentions(
      [raw('demain', 'Paul se marie.', '2026-10-06')],
      CTX,
      'Lundi, Paul m’a annoncé qu’il se mariait demain.',
    );
    expect(said).toMatchObject({ status: 'proposed', day: '', choices: ['2026-10-09', '2026-10-06'], modelDay: '2026-10-06' });
    // Date explicite : même règle
    const [d] = resolveMentions([raw('le 3 octobre', 'Fait.', '2026-10-04')], CTX, 'le 3 octobre fait');
    expect(d).toMatchObject({ status: 'proposed', choices: ['2026-10-03', '2026-10-04'] });
  });

  it('jour de la semaine suivi d’une heure : jamais pris pour un jour du mois', () => {
    const t = 'Rendez-vous chez le dentiste mardi 10 h.';
    expect(resolveMentions([raw('mardi 10 h', 'Rendez-vous chez le dentiste.', '2026-10-13')], CTX, t)[0]).toMatchObject({
      kind: 'future',
      day: '2026-10-13',
      status: 'auto',
    });
    // Sans date du modèle : on demande entre les deux mardis
    expect(resolveMentions([raw('mardi 10 h', 'Dentiste.')], CTX, t)[0]).toMatchObject({
      status: 'proposed',
      choices: ['2026-10-06', '2026-10-13'],
    });
  });

  it('proposition : la date valide du modèle est toujours parmi les choix (3 au plus)', () => {
    // « mardi 5 » : le 5 n'est pas un mardi → on demande ; le modèle propose le mardi 6
    const [m] = resolveMentions([raw('mardi 5', 'Fait.', '2026-10-06')], CTX, 'mardi 5 fait');
    expect(m?.choices).toEqual(['2026-10-05', '2026-11-05', '2026-10-06']);
    expect(m?.modelDay).toBe('2026-10-06');
    // Week-end : date du modèle hors du week-end ajoutée
    const [w] = resolveMentions([raw('le week-end dernier', 'Mer.', '2026-10-02')], CTX, 'le week-end dernier mer');
    expect(w?.choices).toEqual(['2026-10-03', '2026-10-04', '2026-10-02']);
  });

  it('alternatives et énumérations proposées, périodes ignorées', () => {
    expect(resolveMentions([raw('hier ou avant-hier', "J'ai croisé Paul.")], CTX, "Hier ou avant-hier, j'ai croisé Paul.")[0]).toMatchObject({
      status: 'proposed',
      day: '',
      choices: ['2026-10-06', '2026-10-07'],
    });
    expect(resolveMentions([raw('les 3 et 4 octobre', 'Lyon.')], CTX, 'Les 3 et 4 octobre, Lyon.')[0]).toMatchObject({
      status: 'proposed',
      choices: ['2026-10-03', '2026-10-04'],
    });
    expect(resolveMentions([raw('du 3 au 5 octobre', 'Lyon.', '2026-10-03')], CTX, 'Du 3 au 5 octobre, Lyon.')).toEqual([]);
  });

  it('« lundi dernier » : sûr si le modèle concorde ou se tait, sinon proposition [code, modèle]', () => {
    const t = 'lundi dernier un fait';
    expect(resolveMentions([raw('lundi dernier', 'Un fait.')], CTX, t)[0]).toMatchObject({ day: '2026-10-05', status: 'auto' });
    expect(resolveMentions([raw('lundi dernier', 'Un fait.', '2026-10-05')], CTX, t)[0]).toMatchObject({ status: 'auto' });
    expect(resolveMentions([raw('lundi dernier', 'Un fait.', '2026-09-28')], CTX, t)[0]).toEqual({
      id: mentionId('lundi dernier', 'Un fait.'),
      kind: 'past',
      day: '',
      when: 'lundi dernier',
      text: 'Un fait.',
      status: 'proposed',
      choices: ['2026-10-05', '2026-09-28'],
      modelDay: '2026-09-28',
    });
  });

  it('« lundi » seul : le modèle choisit passé ou à venir ; sinon on demande', () => {
    const t = 'lundi je vois Paul';
    expect(resolveMentions([raw('lundi', 'Je vois Paul.', '2026-10-12')], CTX, t)[0]).toMatchObject({
      kind: 'future',
      day: '2026-10-12',
      status: 'auto',
    });
    expect(resolveMentions([raw('lundi', "J'ai vu Paul.", '2026-10-05')], CTX, t)[0]).toMatchObject({
      kind: 'past',
      day: '2026-10-05',
      status: 'auto',
    });
    expect(resolveMentions([raw('lundi', 'Paul.')], CTX, t)[0]).toMatchObject({
      status: 'proposed',
      day: '',
      choices: ['2026-10-05', '2026-10-12'],
    });
    // Date du modèle hors des choix : ajoutée (3 au plus)
    expect(resolveMentions([raw('lundi', 'Paul.', '2026-10-13')], CTX, t)[0]?.choices).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-13',
    ]);
  });

  it('week-end : toujours proposé (samedi ou dimanche), présélection du modèle', () => {
    const [m] = resolveMentions(
      [raw('le week-end dernier', 'On est allés à la mer.', '2026-10-04')],
      CTX,
      'Le week-end dernier on est allés à la mer.',
    );
    expect(m).toMatchObject({ status: 'proposed', day: '', choices: ['2026-10-03', '2026-10-04'], modelDay: '2026-10-04' });
    const [n] = resolveMentions([raw('le week-end dernier', 'Mer.')], CTX, 'le week-end dernier, mer');
    expect(n?.modelDay).toBeUndefined();
  });

  it('la nuit : « hier » et « demain » proposés ; « demain » peut viser le jour même', () => {
    const night = { ...CTX, time: '01:10' };
    expect(resolveMentions([raw('hier', 'Fait.')], night, 'hier fait')[0]).toMatchObject({
      status: 'proposed',
      kind: 'past',
      choices: ['2026-10-07', '2026-10-06'],
    });
    const [d] = resolveMentions([raw('demain', 'Dentiste.', '2026-10-09')], night, 'demain dentiste');
    expect(d).toMatchObject({ status: 'proposed', kind: 'future', choices: ['2026-10-08', '2026-10-09'], modelDay: '2026-10-09' });
  });

  it('repère inconnu : proposé seulement avec une date du modèle valide', () => {
    expect(resolveMentions([raw('pendant les vacances', 'Fait.', '2026-10-01')], CTX, 'pendant les vacances fait')[0]).toMatchObject({
      status: 'proposed',
      choices: ['2026-10-01'],
    });
    expect(resolveMentions([raw('pendant les vacances', 'Fait.')], CTX, 'pendant les vacances fait')).toEqual([]);
  });

  it('période floue ou jour même : rejeté, même avec une date du modèle', () => {
    for (const when of ['la semaine dernière', 'récemment', "l'autre jour", 'ce matin', 'ce soir', 'la semaine prochaine']) {
      expect(resolveMentions([raw(when, 'Fait.', '2026-10-05')], CTX, `${when} fait`)).toEqual([]);
    }
    expect(resolveMentions([raw('le 8 octobre', 'Fait.')], CTX, 'le 8 octobre fait')).toEqual([]);
  });

  it('fenêtre : 31 jours avant, 60 après ; date du modèle hors fenêtre ou invalide ignorée', () => {
    expect(resolveMentions([raw('il y a 31 jours', 'Fait.')], CTX, 'il y a 31 jours fait')[0]?.day).toBe('2026-09-07');
    expect(resolveMentions([raw('il y a 32 jours', 'Fait.')], CTX, 'il y a 32 jours fait')).toEqual([]);
    expect(resolveMentions([raw('dans 60 jours', 'Fait.')], CTX, 'dans 60 jours fait')[0]?.day).toBe('2026-12-07');
    expect(resolveMentions([raw('dans 61 jours', 'Fait.')], CTX, 'dans 61 jours fait')).toEqual([]);
    for (const date of ['2026-12-31', '2026-02-30', 'demain', '2026-10-08', '']) {
      expect(resolveMentions([raw('à Noël', 'Fait.', date)], CTX, 'à noël fait')).toEqual([]);
    }
    expect(resolveMentions([{ when: 'lundi', date: 42, text: 'Fait.' }], CTX, 'lundi fait')[0]?.status).toBe('proposed');
  });

  it('même jour visé deux fois : une seule mention (textes réunis), doublons retirés', () => {
    const out = resolveMentions(
      [raw('hier', "J'ai vu Paul."), raw('hier soir', "On a regardé un film."), raw('hier', "J'ai vu Paul.")],
      CTX,
      "Hier j'ai vu Paul. Hier soir on a regardé un film.",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("J'ai vu Paul. On a regardé un film.");
  });

  it('5 mentions au plus ; entrées illisibles ignorées ; longueurs bornées', () => {
    const many = Array.from({ length: 12 }, (_, i) => raw(`il y a ${i + 1} jours`, `Fait numéro ${i + 1}.`));
    const transcript = many.map((m) => `${m.when} ${m.text}`).join(' ');
    expect(resolveMentions(many, CTX, transcript)).toHaveLength(MAX_MENTIONS);
    expect(resolveMentions([null, 'hier', 3, { when: 'hier' }, { text: 'x' }], CTX, 'hier x')).toEqual([]);
    expect(resolveMentions('hier', CTX, 'hier')).toEqual([]);
    expect(resolveMentions([raw('hier', 'Fait.')], { ...CTX, day: 'nimporte' }, 'hier fait')).toEqual([]);
    const [long] = resolveMentions([raw('hier', 'mot '.repeat(200))], CTX, 'hier');
    expect(long?.text.length).toBeLessThanOrEqual(300);
  });

  it('identifiant stable et déterministe', () => {
    const a = resolveMentions([raw('hier', 'Fait.')], CTX, 'hier fait');
    const b = resolveMentions([raw('Hier', 'fait')], CTX, 'hier fait');
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(mentionId('hier', 'Autre fait.')).not.toBe(a[0]?.id);
  });
});

describe('lecture des mentions stockées', () => {
  it('sanitizeMentions : ignore ce qui est mal formé, garde les propositions sans jour', () => {
    const list = sanitizeMentions([
      mention({ id: 'a1', day: '2026-10-06' }),
      mention({ id: 'a1', day: '2026-10-05' }), // id déjà vu
      { ...mention({ id: 'b', day: '2026-10-06' }), status: 'bizarre' },
      mention({ id: 'c', day: '2026-02-30' }),
      mention({ id: 'd', day: '' }), // auto sans jour
      mention({ id: 'e', day: '', status: 'proposed', choices: ['2026-10-03', 'x', '2026-10-04'] }),
      mention({ id: 'f', day: '2026-10-06', text: '  ' }),
      { id: 'g', day: '2026-10-06', status: 'auto', when: 'hier' },
      'texte',
      null,
    ]);
    expect(list.map((m) => m.id)).toEqual(['a1', 'e']);
    expect(list[1]?.choices).toEqual(['2026-10-03', '2026-10-04']);
    expect(sanitizeMentions(undefined)).toEqual([]);
    expect(readMentions(undefined)).toEqual([]);
  });

  it('activeMentions : auto et confirmées, dans la fenêtre, genre recalculé d’après le jour', () => {
    const e = entry('e1', '2026-10-08', '2026-10-08T08:00:00.000Z', [
      mention({ id: 'a', day: '2026-10-06' }),
      mention({ id: 'b', day: '2026-10-10', kind: 'past', status: 'confirmed' }),
      mention({ id: 'c', day: '', status: 'proposed', choices: ['2026-10-03'] }),
      mention({ id: 'd', day: '2026-10-05', status: 'dismissed' }),
      mention({ id: 'f', day: '2025-01-01' }),
    ]);
    expect(activeMentions(e).map((m) => [m.id, m.kind])).toEqual([
      ['a', 'past'],
      ['b', 'future'],
    ]);
    expect(pendingProposals(e).map((m) => m.id)).toEqual(['c']);
    expect(kindOf('2026-10-08', '2026-10-08')).toBe('future');
  });
});

describe('collectDayLinks', () => {
  const e1 = entry('e1', '2026-10-08', '2026-10-08T07:00:00.000Z', [
    mention({ id: 'm1', day: '2026-10-06', text: "J'ai dîné avec Paul au restaurant italien." }),
    mention({ id: 'm2', day: '2026-10-09', kind: 'future', when: 'demain', text: 'Dentiste à 10 h.' }),
    mention({ id: 'm3', day: '', status: 'proposed', choices: ['2026-10-03', '2026-10-04'] }),
  ]);
  const e0 = entry('e0', '2026-10-07', '2026-10-07T21:00:00.000Z', [
    mention({ id: 'n1', day: '2026-10-06', text: 'Dîner avec Paul au restaurant italien, super.' }),
    mention({ id: 'n2', day: '2026-10-06', status: 'dismissed', text: 'Autre chose.' }),
  ]);
  const e2 = entry('e2', '2026-10-08', '2026-10-08T09:00:00.000Z', [
    mention({ id: 'p1', day: '2026-10-06', text: 'Courses au marché.' }),
  ]);

  it('regroupe par jour visé, dans l’ordre où les faits ont été dits ; propositions et retraits exclus', () => {
    const map = collectDayLinks([e2, e1, e0]);
    expect([...map.keys()].sort()).toEqual(['2026-10-06', '2026-10-09']);
    const d6 = map.get('2026-10-06') ?? [];
    expect(d6.map((l) => l.ref)).toEqual(['e0/n1', 'e1/m1', 'e2/p1']);
    expect(d6[0]).toMatchObject({ entryId: 'e0', sourceDay: '2026-10-07', sourceCreatedAt: '2026-10-07T21:00:00.000Z' });
    expect(map.get('2026-10-09')?.[0]?.mention.kind).toBe('future');
  });

  it('même fait rattaché par une entrée plus récente → repeatOf', () => {
    const d6 = collectDayLinks([e0, e1, e2]).get('2026-10-06') ?? [];
    expect(d6.find((l) => l.ref === 'e1/m1')?.repeatOf).toBe('e0/n1');
    expect(d6.find((l) => l.ref === 'e0/n1')?.repeatOf).toBeUndefined();
    expect(d6.find((l) => l.ref === 'e2/p1')?.repeatOf).toBeUndefined();
  });

  it('données invalides ignorées', () => {
    const bad = { ...e1, analysis: { ...analysis(), mentions: 'x' as unknown as DayMention[] } };
    expect(collectDayLinks([bad, { ...e1, analysis: undefined }]).size).toBe(0);
  });
});

describe('carryOverMentions (nouvelle analyse)', () => {
  const dismissed = mention({ id: 'd1', day: '2026-10-07', when: 'hier', text: "J'ai vu Paul au café.", status: 'dismissed' });
  const moved = mention({ id: 'c1', day: '2026-10-03', when: 'le week-end dernier', text: 'Mer.', status: 'confirmed' });
  const auto = mention({ id: 'a1', day: '2026-10-06', when: 'avant-hier', text: 'Dîner chez Hugo.' });

  it('un ajout retiré ne revient jamais ; un ajout déplacé est gardé', () => {
    const next = [
      mention({ id: 'x1', day: '2026-10-07', when: 'hier', text: "J'ai vu Paul au café, sympa." }),
      mention({ id: 'x2', day: '', status: 'proposed', when: 'le week-end dernier', text: 'Mer.', choices: ['2026-10-03', '2026-10-04'] }),
    ];
    expect(carryOverMentions([dismissed, moved], next)).toEqual([dismissed, moved]);
  });

  it('auto et proposées remplacées ; id repris si même jour et même fait ; nouveaux ajoutés', () => {
    const next = [
      mention({ id: 'new1', day: '2026-10-06', when: 'avant-hier', text: 'Dîner chez Hugo.' }),
      mention({ id: 'new2', day: '2026-10-09', kind: 'future', when: 'demain', text: 'Cinéma.' }),
    ];
    const out = carryOverMentions([auto, moved], next);
    expect(out.map((m) => m.id)).toEqual(['c1', 'a1', 'new2']);
  });

  it('ids uniques même en cas de collision', () => {
    const next = [mention({ id: 'c1', day: '2026-10-09', kind: 'future', when: 'demain', text: 'Autre chose.' })];
    const out = carryOverMentions([moved], next);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((m) => m.id)).size).toBe(2);
  });

  it('mergeMentionChoices (synchro) : les choix des deux appareils sont gardés, le geste le plus récent l’emporte', () => {
    const remoteAuto = mention({ id: 'a1', day: '2026-10-06', when: 'avant-hier', text: 'Dîner chez Hugo.' });
    const localDismissed: DayMention = { ...remoteAuto, status: 'dismissed', decidedAt: '2026-10-08T10:00:00.000Z' };
    // Version distante plus récente (ré-analyse) qui ignore le retrait fait ici : il est repris
    expect(mergeMentionChoices([remoteAuto, moved], [localDismissed], [remoteAuto, moved])).toEqual([localDismissed, moved]);
    // Version locale retenue : le déplacement fait sur l'autre appareil est repris
    const remoteMoved: DayMention = { ...remoteAuto, day: '2026-10-05', status: 'confirmed', decidedAt: '2026-10-08T11:00:00.000Z' };
    expect(mergeMentionChoices([remoteAuto], [remoteAuto], [remoteMoved])).toEqual([remoteMoved]);
    // Choix contraires sur la même mention : le plus récent l'emporte, de quelque côté qu'il soit
    expect(mergeMentionChoices([remoteMoved], [localDismissed], [remoteMoved])).toBeNull();
    expect(mergeMentionChoices([localDismissed], [localDismissed], [remoteMoved])).toEqual([remoteMoved]);
    // À égalité (ou sans horodatage) : celui d'ici
    const undated: DayMention = { ...remoteMoved, decidedAt: undefined };
    const localUndated: DayMention = { ...localDismissed, decidedAt: undefined };
    expect(mergeMentionChoices([undated], [localUndated], [undated])).toEqual([sanitizeMentions([localUndated])[0]]);
    // Deux choix différents le même jour visé : tous deux gardés
    const other: DayMention = mention({ id: 'b2', day: '2026-10-06', when: 'mardi', text: 'Piscine.', status: 'confirmed' });
    expect(mergeMentionChoices([localDismissed], [localDismissed], [other])?.map((m) => m.id)).toEqual(['a1', 'b2']);
    // Rien à reprendre : null (la version retenue reste telle quelle, ordre compris)
    expect(mergeMentionChoices([remoteAuto, moved], [moved], [remoteAuto, moved])).toBeNull();
    expect(mergeMentionChoices([remoteAuto], undefined, 'x')).toBeNull();
    // L'horodatage est relu (et ignoré s'il est illisible)
    expect(sanitizeMentions([{ ...remoteMoved, decidedAt: 'hier' }])[0]?.decidedAt).toBeUndefined();
    expect(sanitizeMentions([remoteMoved])[0]?.decidedAt).toBe('2026-10-08T11:00:00.000Z');
  });

  it('mergeAnalysisMentions : détection désactivée → mentions précédentes gardées telles quelles', () => {
    const prev = analysis([auto, dismissed]);
    const next = analysis();
    expect(mergeAnalysisMentions(prev, next, false).mentions).toEqual([auto, dismissed]);
    expect(mergeAnalysisMentions(prev, next, true).mentions).toEqual([dismissed]);
    const none = mergeAnalysisMentions(undefined, analysis([]), true);
    expect('mentions' in none).toBe(false);
    expect(mergeAnalysisMentions(undefined, analysis([auto]), true).mentions).toEqual([auto]);
  });
});

describe('gestes', () => {
  const p = mention({ id: 'p', day: '', status: 'proposed', choices: ['2026-10-03', '2026-10-04'], when: 'le week-end dernier' });

  it('settleMention : confirmée, genre recalculé, choix retirés', () => {
    expect(settleMention(p, '2026-10-04', '2026-10-08')).toEqual({ ...mention({ id: 'p', day: '2026-10-04', status: 'confirmed', when: 'le week-end dernier' }) });
    expect(settleMention(mention({ id: 'q', day: '2026-10-06' }), '2026-10-12', '2026-10-08').kind).toBe('future');
  });

  it('editMention : texte rogné et borné ; vide ou proposition → null', () => {
    const m = mention({ id: 'a', day: '2026-10-06' });
    expect(editMention(m, '  Nouveau   texte. ')).toMatchObject({ text: 'Nouveau texte.', status: 'confirmed' });
    expect(editMention(m, '   ')).toBeNull();
    expect(editMention(p, 'x')).toBeNull();
    expect(editMention(m, 'a'.repeat(500))?.text.length).toBeLessThanOrEqual(300);
  });

  it('restoreMention : confirmée si elle avait un jour, sinon de nouveau proposée', () => {
    expect(restoreMention(mention({ id: 'a', day: '2026-10-06', status: 'dismissed' })).status).toBe('confirmed');
    expect(restoreMention({ ...p, status: 'dismissed' }).status).toBe('proposed');
  });

  it('isChoosableDay : fenêtre, jour même refusé sauf s’il fait partie des choix', () => {
    expect(isChoosableDay('2026-10-01', '2026-10-08')).toBe(true);
    expect(isChoosableDay('2026-10-08', '2026-10-08')).toBe(false);
    expect(isChoosableDay('2026-10-08', '2026-10-08', ['2026-10-08', '2026-10-09'])).toBe(true);
    expect(isChoosableDay('2026-12-25', '2026-10-08')).toBe(false);
    expect(isChoosableDay('n', '2026-10-08')).toBe(false);
  });
});

describe('signature de synthèse', () => {
  function link(entryId: string, id: string, day: string, text: string, sourceDay = '2026-10-08'): DayLink {
    return {
      entryId,
      sourceDay,
      sourceCreatedAt: `${sourceDay}T08:00:00.000Z`,
      mention: mention({ id, day, text }),
      ref: `${entryId}/${id}`,
    };
  }

  it('sans note : identique à la signature des entrées (aucune régénération au déploiement)', () => {
    expect(linksSignature('2-abcdef01', [])).toBe('2-abcdef01');
  });

  it('une répétition (jamais envoyée au modèle) ne change pas la signature', () => {
    const a = link('e1', 'm1', '2026-10-05', "J'ai dîné avec Paul au restaurant italien.", '2026-10-06');
    const rep = { ...link('e2', 'm2', '2026-10-05', 'Dîner avec Paul au restaurant italien.', '2026-10-07'), repeatOf: 'e1/m1' };
    expect(linksSignature('1-x', [a, rep])).toBe(linksSignature('1-x', [a]));
    // L'original disparaît : la répétition prend sa place, la signature change
    expect(linksSignature('1-x', [{ ...rep, repeatOf: undefined }])).not.toBe(linksSignature('1-x', [a]));
    // Seulement des répétitions (cas dégénéré) : rien n'est envoyé
    expect(linksSignature('1-x', [rep])).toBe('1-x');
  });

  it('settledLinks : seules les notes dites avant aujourd’hui', () => {
    const old = link('e1', 'm1', '2026-10-05', 'A.', '2026-10-07');
    const now = link('e2', 'm2', '2026-10-05', 'B.', '2026-10-08');
    expect(settledLinks([old, now], '2026-10-08')).toEqual([old]);
    expect(settledLinks([old, now], '2026-10-09')).toEqual([old, now]);
  });

  it('avec notes : suffixe dépendant du contenu, pas de l’ordre', () => {
    const a = link('e1', 'm1', '2026-10-06', 'Dîner avec Paul.');
    const b = link('e2', 'm2', '2026-10-06', 'Courses.');
    const sig = linksSignature('2-abcdef01', [a, b]);
    expect(sig).toMatch(/^2-abcdef01\+a2-[0-9a-f]{8}$/);
    expect(linksSignature('2-abcdef01', [b, a])).toBe(sig);
    // Même fait reformulé à la casse près : même signature ; autre fait : autre signature
    expect(linksSignature('2-abcdef01', [{ ...a, mention: { ...a.mention, text: 'dîner avec paul' } }, b])).toBe(sig);
    expect(linksSignature('2-abcdef01', [{ ...a, mention: { ...a.mention, text: 'Dîner avec Marie.' } }, b])).not.toBe(sig);
    // Le nouvel id d'une ré-analyse identique ne change rien
    expect(linksSignature('2-abcdef01', [{ ...a, mention: { ...a.mention, id: 'zz' }, ref: 'e1/zz' }, b])).toBe(sig);
    expect(splitSignature(sig)).toEqual({ base: '2-abcdef01', suffix: sig.slice('2-abcdef01'.length) });
    expect(splitSignature('2-abcdef01')).toEqual({ base: '2-abcdef01', suffix: '' });
    expect(isKnownSignatureSuffix(splitSignature(sig).suffix)).toBe(true);
    expect(isKnownSignatureSuffix('')).toBe(true);
    expect(isKnownSignatureSuffix('+z9-autre')).toBe(false);
  });

  it('références [A1] (faits racontés plus tard) et [P1] (prévu), répétitions exclues', () => {
    const l1 = { ...link('e2', 'm', '2026-10-06', 'B.'), sourceCreatedAt: '2026-10-08T09:00:00.000Z' };
    const l2 = { ...link('e1', 'm', '2026-10-06', 'A.'), sourceCreatedAt: '2026-10-07T09:00:00.000Z' };
    const l3 = { ...link('e3', 'm', '2026-10-06', 'A bis.'), repeatOf: 'e1/m' };
    const f1 = { ...link('e4', 'm', '2026-10-06', 'Prévu.'), mention: mention({ id: 'm', day: '2026-10-06', kind: 'future', text: 'Prévu.' }) };
    const { past, future } = synthesisRefs([l1, l2, l3, f1]);
    expect(past.map((r) => [r.ref, r.link.ref])).toEqual([
      ['A1', 'e1/m'],
      ['A2', 'e2/m'],
    ]);
    expect(future.map((r) => [r.ref, r.link.ref])).toEqual([['P1', 'e4/m']]);
  });

  it('similarity : mots pleins', () => {
    expect(similarity("J'ai dîné avec Paul au restaurant.", 'Dîner avec Paul au restaurant')).toBeGreaterThanOrEqual(0.5);
    expect(similarity('Courses au marché.', 'Cinéma avec Hugo.')).toBe(0);
    expect(similarity('', 'x')).toBe(0);
  });
});
