import { describe, expect, it } from 'vitest';
import {
  MAX_FUTURE_DAYS,
  MAX_PAST_DAYS,
  NIGHT_END_HOUR,
  foldWhen,
  isDayKey,
  isInWindow,
  lastWeekend,
  nextWeekday,
  nextWeekend,
  parseFrenchWhen,
  previousWeekday,
  weekdayOf,
  windowOf,
  type WhenResult,
} from '../src/lib/when';
import { addDays } from '../src/lib/util';

/*
 * Calendrier de référence (vérifié) :
 *   2026-10-08 = jeudi (jour de la spécification). Octobre 2026 : le 1er est un jeudi,
 *   le 3 un samedi, le 4 un dimanche, le 5 un lundi, le 12 un lundi.
 *   Changements d'heure (Europe) : 2026-03-29 et 2026-10-25. 2028 est bissextile.
 */
const THU = '2026-10-08';

function days(certainty: 'sure' | 'check' | 'pick' | 'ask', list: string[]): WhenResult {
  return { type: 'days', certainty, days: list };
}
const NONE: WhenResult = { type: 'none' };
const UNKNOWN: WhenResult = { type: 'unknown' };

describe('calendrier', () => {
  it('jours de la semaine de référence', () => {
    expect(weekdayOf(THU)).toBe(4);
    expect(weekdayOf('2026-10-05')).toBe(1);
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(weekdayOf('2028-02-29')).toBe(2);
  });

  it('isDayKey : format et existence', () => {
    expect(isDayKey('2026-10-08')).toBe(true);
    expect(isDayKey('2028-02-29')).toBe(true);
    expect(isDayKey('2027-02-29')).toBe(false);
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('2026-13-01')).toBe(false);
    expect(isDayKey('2026-1-8')).toBe(false);
    expect(isDayKey('')).toBe(false);
    expect(isDayKey(20261008)).toBe(false);
    expect(isDayKey(null)).toBe(false);
  });

  it('occurrence précédente / suivante strictement avant / après, même jour de la semaine → 7 jours', () => {
    expect(previousWeekday(THU, 1)).toBe('2026-10-05');
    expect(previousWeekday(THU, 4)).toBe('2026-10-01');
    expect(previousWeekday(THU, 3)).toBe('2026-10-07');
    expect(nextWeekday(THU, 1)).toBe('2026-10-12');
    expect(nextWeekday(THU, 4)).toBe('2026-10-15');
    expect(nextWeekday(THU, 5)).toBe('2026-10-09');
    // Toute la semaine : bornes et jour de la semaine respectés
    for (let d = 5; d <= 11; d++) {
      const ref = `2026-10-${String(d).padStart(2, '0')}`;
      for (let wd = 0; wd < 7; wd++) {
        const p = previousWeekday(ref, wd);
        const n = nextWeekday(ref, wd);
        expect(weekdayOf(p)).toBe(wd);
        expect(weekdayOf(n)).toBe(wd);
        expect(p < ref && p >= addDays(ref, -7)).toBe(true);
        expect(n > ref && n <= addDays(ref, 7)).toBe(true);
      }
    }
  });

  it('week-ends : jamais celui qui contient le jour de référence', () => {
    expect(lastWeekend('2026-10-05')).toEqual(['2026-10-03', '2026-10-04']); // lundi
    expect(lastWeekend(THU)).toEqual(['2026-10-03', '2026-10-04']);
    expect(lastWeekend('2026-10-09')).toEqual(['2026-10-03', '2026-10-04']); // vendredi
    expect(lastWeekend('2026-10-10')).toEqual(['2026-10-03', '2026-10-04']); // samedi
    expect(lastWeekend('2026-10-11')).toEqual(['2026-10-03', '2026-10-04']); // dimanche
    expect(nextWeekend('2026-10-05')).toEqual(['2026-10-10', '2026-10-11']);
    expect(nextWeekend(THU)).toEqual(['2026-10-10', '2026-10-11']);
    expect(nextWeekend('2026-10-10')).toEqual(['2026-10-17', '2026-10-18']);
    expect(nextWeekend('2026-10-11')).toEqual(['2026-10-17', '2026-10-18']);
  });

  it('fenêtre : 31 jours avant, 60 jours après, jour même exclu sauf demande', () => {
    expect(MAX_PAST_DAYS).toBe(31);
    expect(MAX_FUTURE_DAYS).toBe(60);
    expect(windowOf(THU)).toEqual({ min: '2026-09-07', max: '2026-12-07' });
    expect(isInWindow('2026-09-07', THU)).toBe(true);
    expect(isInWindow('2026-09-06', THU)).toBe(false);
    expect(isInWindow('2026-12-07', THU)).toBe(true);
    expect(isInWindow('2026-12-08', THU)).toBe(false);
    expect(isInWindow(THU, THU)).toBe(false);
    expect(isInWindow(THU, THU, true)).toBe(true);
    expect(isInWindow('2026-02-30', THU)).toBe(false);
  });
});

describe('foldWhen', () => {
  it('minuscules, sans accents, tirets et apostrophes en espaces, nombres en chiffres', () => {
    expect(foldWhen('Avant-Hier')).toBe('avant hier');
    expect(foldWhen('  Après-demain, ')).toBe('apres demain');
    expect(foldWhen('il y a vingt-deux jours')).toBe('il y a 22 jours');
    expect(foldWhen('Trente et un')).toBe('31');
    expect(foldWhen('dix-sept')).toBe('17');
    expect(foldWhen('le 1er octobre')).toBe('le 1 octobre');
    expect(foldWhen('le premier octobre')).toBe('le 1 octobre');
    expect(foldWhen('une semaine')).toBe('1 semaine');
    expect(foldWhen("aujourd'hui")).toBe('aujourd hui');
    expect(foldWhen('3/10/2026')).toBe('3/10/2026');
    expect(foldWhen('')).toBe('');
    expect(foldWhen('…')).toBe('');
  });
});

describe('parseFrenchWhen — relatifs (référence : jeudi 8 octobre 2026, 10 h)', () => {
  const cases: [string, WhenResult][] = [
    ['hier', days('sure', ['2026-10-07'])],
    ['Hier soir', days('sure', ['2026-10-07'])],
    ['hier vers midi', days('sure', ['2026-10-07'])],
    ['avant-hier', days('sure', ['2026-10-06'])],
    ['Avant hier', days('sure', ['2026-10-06'])],
    ['avant-avant-hier', days('sure', ['2026-10-05'])],
    ['demain', days('sure', ['2026-10-09'])],
    ['demain matin', days('sure', ['2026-10-09'])],
    ['après-demain', days('sure', ['2026-10-10'])],
    ['apres demain', days('sure', ['2026-10-10'])],
    ['il y a trois jours', days('sure', ['2026-10-05'])],
    ['il y a 3 jours', days('sure', ['2026-10-05'])],
    ['y a deux jours', days('sure', ['2026-10-06'])],
    ['ça fait quatre jours', days('sure', ['2026-10-04'])],
    ['il y a vingt et un jours', days('sure', ['2026-09-17'])],
    ['il y a 1 jour', days('sure', ['2026-10-07'])],
    ['il y a huit jours', days('check', ['2026-10-01', '2026-09-30'])],
    ['il y a quinze jours', days('check', ['2026-09-24', '2026-09-23'])],
    ['il y a une semaine', days('check', ['2026-10-01', '2026-09-30'])],
    ['il y a deux semaines', days('check', ['2026-09-24', '2026-09-23'])],
    ['il y a 0 jour', NONE],
    ['il y a dix semaines', NONE],
    ['dans trois jours', days('sure', ['2026-10-11'])],
    ['dans 1 jour', days('sure', ['2026-10-09'])],
    ['dans huit jours', days('check', ['2026-10-15', '2026-10-16'])],
    ['dans quinze jours', days('check', ['2026-10-22', '2026-10-23'])],
    ['dans une semaine', days('check', ['2026-10-15', '2026-10-16'])],
  ];
  for (const [when, expected] of cases) {
    it(`« ${when} »`, () => {
      expect(parseFrenchWhen(when, THU, '10:00')).toEqual(expected);
    });
  }
});

describe('parseFrenchWhen — jours de la semaine', () => {
  const cases: [string, WhenResult][] = [
    ['lundi dernier', days('check', ['2026-10-05'])],
    ['samedi dernier', days('check', ['2026-10-03'])],
    ['mercredi passé', days('check', ['2026-10-07'])],
    // Même jour de la semaine que le jour de référence : une semaine avant / après.
    ['jeudi dernier', days('check', ['2026-10-01'])],
    ['jeudi', days('pick', ['2026-10-01', '2026-10-15'])],
    ['jeudi prochain', days('check', ['2026-10-15'])],
    // Seul : passé ou à venir, le temps du verbe départage (le modèle).
    ['lundi', days('pick', ['2026-10-05', '2026-10-12'])],
    ['ce lundi', days('pick', ['2026-10-05', '2026-10-12'])],
    ['mardi soir', days('pick', ['2026-10-06', '2026-10-13'])],
    // « prochain » dans la semaine calendaire de la référence : celui-ci ou le suivant ?
    ['lundi prochain', days('check', ['2026-10-12'])],
    ['samedi prochain', days('ask', ['2026-10-10', '2026-10-17'])],
    ['vendredi qui vient', days('ask', ['2026-10-09', '2026-10-16'])],
    ['lundi de la semaine dernière', days('sure', ['2026-09-28'])],
    ['vendredi la semaine passée', days('sure', ['2026-10-02'])],
    ['mardi de la semaine prochaine', days('sure', ['2026-10-13'])],
    ['lundi en huit', days('sure', ['2026-10-19'])],
    ['lundi 5', days('sure', ['2026-10-05'])],
    ['lundi le 12', days('sure', ['2026-10-12'])],
    // Le 5 n'est pas un mardi (le 5 septembre est hors de la fenêtre) : on demande.
    ['mardi 5', days('ask', ['2026-10-05', '2026-11-05'])],
    // Jour de la semaine suivi d'une HEURE : pas un jour du mois (sinon mardi 10 novembre !).
    ['mardi 10 h', days('pick', ['2026-10-06', '2026-10-13'])],
    ['mardi 10h', days('pick', ['2026-10-06', '2026-10-13'])],
    ['mardi 9 h', days('pick', ['2026-10-06', '2026-10-13'])],
    ['dimanche 18 heures', days('pick', ['2026-10-04', '2026-10-11'])],
    ['lundi 8 h 30', days('pick', ['2026-10-05', '2026-10-12'])],
    ['mercredi 11 h', days('pick', ['2026-10-07', '2026-10-14'])],
    ['mardi 10:30', days('pick', ['2026-10-06', '2026-10-13'])],
    ['mardi à 10 h', days('pick', ['2026-10-06', '2026-10-13'])],
    ['lundi prochain 9 h', days('check', ['2026-10-12'])],
  ];
  for (const [when, expected] of cases) {
    it(`« ${when} »`, () => {
      expect(parseFrenchWhen(when, THU, '10:00')).toEqual(expected);
    });
  }

  it('« dimanche prochain » dit un samedi : demain ou dans huit jours', () => {
    expect(parseFrenchWhen('dimanche prochain', '2026-10-10')).toEqual(days('ask', ['2026-10-11', '2026-10-18']));
  });

  it('« lundi prochain » dit un dimanche : demain (semaine suivante), sûr', () => {
    expect(parseFrenchWhen('lundi prochain', '2026-10-11')).toEqual(days('check', ['2026-10-12']));
  });

  it('« lundi dernier » dit un mardi : la veille', () => {
    expect(parseFrenchWhen('lundi dernier', '2026-10-06')).toEqual(days('check', ['2026-10-05']));
  });
});

describe('parseFrenchWhen — dates explicites', () => {
  const cases: [string, WhenResult][] = [
    ['le 3 octobre', days('sure', ['2026-10-03'])],
    ['le 3 octobre 2026', days('sure', ['2026-10-03'])],
    ['le trois octobre', days('sure', ['2026-10-03'])],
    ['le 15 octobre', days('sure', ['2026-10-15'])],
    ['le premier octobre', days('sure', ['2026-10-01'])],
    ['le 1er octobre', days('sure', ['2026-10-01'])],
    ['le 30 novembre', days('sure', ['2026-11-30'])],
    ['le 3 oct', days('sure', ['2026-10-03'])],
    ['le 3/10', days('sure', ['2026-10-03'])],
    ['03/10/2026', days('sure', ['2026-10-03'])],
    ['3/10/26', days('sure', ['2026-10-03'])],
    ['le lundi 5 octobre', days('sure', ['2026-10-05'])],
    // Jour de la semaine incohérent avec la date : on demande.
    ['le mardi 5 octobre', days('ask', ['2026-10-05'])],
    // Jour même : rien à rattacher.
    ['le 8 octobre', NONE],
    ['le 8 octobre 2025', NONE],
    // Date inexistante
    ['le 31 septembre', NONE],
    ['le 31/09', NONE],
    // Bornes : R − 31 et R + 60 inclus
    ['le 7 septembre', days('sure', ['2026-09-07'])],
    ['le 6 septembre', NONE],
    ['le 7 décembre', days('sure', ['2026-12-07'])],
    ['le 8 décembre', NONE],
    // Jour seul : ce mois-ci, le suivant ou le précédent, dans la fenêtre → le modèle choisit.
    ['le 3', days('pick', ['2026-10-03', '2026-11-03'])],
    ['le 8', days('pick', ['2026-09-08', '2026-11-08'])],
    ['le 31', days('pick', ['2026-10-31'])],
  ];
  for (const [when, expected] of cases) {
    it(`« ${when} »`, () => {
      expect(parseFrenchWhen(when, THU, '10:00')).toEqual(expected);
    });
  }

  it('« le 10 h » n’est pas une date', () => {
    expect(parseFrenchWhen('le 10 h', THU)).toEqual(UNKNOWN);
    expect(parseFrenchWhen('le 10 30', THU)).toEqual(UNKNOWN);
  });
});

describe('parseFrenchWhen — alternatives, énumérations et périodes', () => {
  const cases: [string, WhenResult][] = [
    // Alternative : jamais rattachée d'office, les jours possibles dans l'ordre du calendrier.
    ['hier ou avant-hier', days('ask', ['2026-10-06', '2026-10-07'])],
    ['demain ou après-demain', days('ask', ['2026-10-09', '2026-10-10'])],
    ['lundi dernier ou mardi dernier', days('ask', ['2026-10-05', '2026-10-06'])],
    ['le 3 ou le 4 octobre', days('ask', ['2026-10-03', '2026-10-04'])],
    // Un des choix n'est pas un autre jour : on demande quand même.
    ['ce soir ou demain', days('ask', ['2026-10-09'])],
    // Énumération de jours (le mois vaut pour les deux) : on demande lequel.
    ['les 3 et 4 octobre', days('ask', ['2026-10-03', '2026-10-04'])],
    ['samedi 3 et dimanche 4 octobre', days('ask', ['2026-10-03', '2026-10-04'])],
    ['hier et avant-hier', days('ask', ['2026-10-06', '2026-10-07'])],
    // « et » avec un repère du jour même : seul l'autre jour compte.
    ['hier soir et ce matin', days('sure', ['2026-10-07'])],
    ['hier entre midi et deux', days('sure', ['2026-10-07'])],
    ['mardi entre 10 h et 12 h', days('pick', ['2026-10-06', '2026-10-13'])],
    // « vingt et un » n'est pas une énumération.
    ['il y a vingt et un jours', days('sure', ['2026-09-17'])],
    // Périodes de plusieurs jours : rien.
    ['du 3 au 5 octobre', NONE],
    ['du lundi au mercredi', NONE],
    ['entre le 3 et le 5 octobre', NONE],
    ['entre lundi et mercredi', NONE],
    ['de lundi à mercredi', NONE],
    // Rien de reconnu des deux côtés
    ['ce matin ou ce soir', NONE],
    ['à Noël ou au nouvel an', UNKNOWN],
  ];
  for (const [when, expected] of cases) {
    it(`« ${when} »`, () => {
      expect(parseFrenchWhen(when, THU, '10:00')).toEqual(expected);
    });
  }

  it('« lundi ou mardi » : passé ou à venir selon la date du modèle, 3 jours au plus sinon', () => {
    expect(parseFrenchWhen('lundi ou mardi', THU, '10:00', '2026-10-06')).toEqual(days('ask', ['2026-10-05', '2026-10-06']));
    expect(parseFrenchWhen('lundi ou mardi', THU, '10:00', '2026-10-12')).toEqual(days('ask', ['2026-10-12', '2026-10-13']));
    // Sans indice : les 3 jours les plus proches
    expect(parseFrenchWhen('lundi ou mardi', THU, '10:00')).toEqual(days('ask', ['2026-10-05', '2026-10-06', '2026-10-12']));
  });
});

describe('parseFrenchWhen — week-ends', () => {
  it('« le week-end dernier » : samedi ou dimanche, à demander', () => {
    expect(parseFrenchWhen('le week-end dernier', THU)).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    expect(parseFrenchWhen('le weekend dernier', THU)).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    expect(parseFrenchWhen('le week-end passé', THU)).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    // Dit le samedi ou le dimanche : le précédent
    expect(parseFrenchWhen('le week-end dernier', '2026-10-10')).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    expect(parseFrenchWhen('le week-end dernier', '2026-10-11')).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
  });

  it('« le week-end prochain »', () => {
    expect(parseFrenchWhen('le week-end prochain', THU)).toEqual(days('ask', ['2026-10-10', '2026-10-11']));
    expect(parseFrenchWhen('le week-end prochain', '2026-10-10')).toEqual(days('ask', ['2026-10-17', '2026-10-18']));
  });

  it('« ce week-end » : côté donné par le modèle, sinon lundi–mercredi = passé, jeudi–vendredi = à venir', () => {
    expect(parseFrenchWhen('ce week-end', THU)).toEqual(days('ask', ['2026-10-10', '2026-10-11']));
    expect(parseFrenchWhen('ce week-end', THU, '10:00', '2026-10-04')).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    expect(parseFrenchWhen('ce week-end', '2026-10-05')).toEqual(days('ask', ['2026-10-03', '2026-10-04']));
    expect(parseFrenchWhen('ce week-end', '2026-10-05', '10:00', '2026-10-10')).toEqual(
      days('ask', ['2026-10-10', '2026-10-11']),
    );
    // Dit pendant le week-end : il contient le jour même
    expect(parseFrenchWhen('ce week-end', '2026-10-10')).toEqual(NONE);
    expect(parseFrenchWhen('ce week-end', '2026-10-11')).toEqual(NONE);
  });
});

describe('parseFrenchWhen — périodes floues, jour même, inconnu', () => {
  for (const when of [
    'la semaine dernière',
    'la semaine prochaine',
    'récemment',
    "l'autre jour",
    'un jour',
    'il y a quelques jours',
    'dans quelques jours',
    'ce matin',
    'ce soir',
    'cette nuit',
    "aujourd'hui",
    'cet après-midi',
    "tout à l'heure",
    'le mois dernier',
    "l'année prochaine",
    'bientôt',
    'la veille',
    'le lendemain',
    '',
  ]) {
    it(`« ${when} » → rien`, () => {
      expect(parseFrenchWhen(when, THU)).toEqual(NONE);
    });
  }

  it('repère inconnu → seule la date du modèle pourra servir', () => {
    expect(parseFrenchWhen('pendant les vacances', THU)).toEqual(UNKNOWN);
    expect(parseFrenchWhen('à Noël', THU)).toEqual(UNKNOWN);
  });

  it('jour de référence invalide → rien', () => {
    expect(parseFrenchWhen('hier', '2026-02-30')).toEqual(NONE);
    expect(parseFrenchWhen('hier', 'hier')).toEqual(NONE);
  });
});

describe('parseFrenchWhen — la nuit (avant 4 h)', () => {
  it(`seuil : ${NIGHT_END_HOUR} h`, () => {
    expect(NIGHT_END_HOUR).toBe(4);
    expect(parseFrenchWhen('hier', THU, '03:59')).toEqual(days('ask', ['2026-10-07', '2026-10-06']));
    expect(parseFrenchWhen('hier', THU, '04:00')).toEqual(days('sure', ['2026-10-07']));
    expect(parseFrenchWhen('hier', THU, '00:00')).toEqual(days('ask', ['2026-10-07', '2026-10-06']));
  });

  const cases: [string, WhenResult][] = [
    ['hier', days('ask', ['2026-10-07', '2026-10-06'])],
    ['avant-hier', days('ask', ['2026-10-06', '2026-10-05'])],
    // « demain » dit à 1 h du matin : la journée qui commence (le jour même) ou le lendemain
    ['demain', days('ask', ['2026-10-08', '2026-10-09'])],
    ['après-demain', days('ask', ['2026-10-09', '2026-10-10'])],
    ['il y a 3 jours', days('ask', ['2026-10-05', '2026-10-04'])],
    ['dans 3 jours', days('ask', ['2026-10-10', '2026-10-11'])],
    // Jours nommés et dates : pas d'effet de la nuit
    ['lundi dernier', days('check', ['2026-10-05'])],
    ['le 3 octobre', days('sure', ['2026-10-03'])],
  ];
  for (const [when, expected] of cases) {
    it(`« ${when} » à 01:30`, () => {
      expect(parseFrenchWhen(when, THU, '01:30')).toEqual(expected);
    });
  }

  it('heure illisible : traitée comme la journée', () => {
    expect(parseFrenchWhen('hier', THU, '')).toEqual(days('sure', ['2026-10-07']));
    expect(parseFrenchWhen('hier', THU, 'xx')).toEqual(days('sure', ['2026-10-07']));
  });
});

describe('parseFrenchWhen — changements de mois, d’année, d’heure ; année bissextile', () => {
  it('début de mois', () => {
    expect(parseFrenchWhen('hier', '2026-10-01')).toEqual(days('sure', ['2026-09-30']));
    expect(parseFrenchWhen('avant-hier', '2026-10-01')).toEqual(days('sure', ['2026-09-29']));
    expect(parseFrenchWhen('lundi dernier', '2026-10-01')).toEqual(days('check', ['2026-09-28']));
    expect(parseFrenchWhen('demain', '2026-09-30')).toEqual(days('sure', ['2026-10-01']));
    expect(parseFrenchWhen('dans 3 jours', '2026-02-27')).toEqual(days('sure', ['2026-03-02']));
  });

  it('changement d’année : l’année se déduit de la fenêtre', () => {
    expect(parseFrenchWhen('hier', '2027-01-01')).toEqual(days('sure', ['2026-12-31']));
    expect(parseFrenchWhen('avant-hier', '2027-01-01')).toEqual(days('sure', ['2026-12-30']));
    expect(parseFrenchWhen('le 30 décembre', '2027-01-01')).toEqual(days('sure', ['2026-12-30']));
    expect(parseFrenchWhen('le 31/12', '2027-01-01')).toEqual(days('sure', ['2026-12-31']));
    expect(parseFrenchWhen('le 2 janvier', '2026-12-30')).toEqual(days('sure', ['2027-01-02']));
    expect(parseFrenchWhen('dans 3 jours', '2026-12-30')).toEqual(days('sure', ['2027-01-02']));
    expect(parseFrenchWhen('le 3', '2026-12-30')).toEqual(days('pick', ['2026-12-03', '2027-01-03']));
    // Le 31 décembre 2026 est un jeudi
    expect(parseFrenchWhen('jeudi dernier', '2027-01-01')).toEqual(days('check', ['2026-12-31']));
  });

  it('passage à l’heure d’hiver (25 octobre 2026) et d’été (29 mars 2026)', () => {
    expect(parseFrenchWhen('hier', '2026-10-26')).toEqual(days('sure', ['2026-10-25']));
    expect(parseFrenchWhen('avant-hier', '2026-10-26')).toEqual(days('sure', ['2026-10-24']));
    expect(parseFrenchWhen('samedi dernier', '2026-10-26')).toEqual(days('check', ['2026-10-24']));
    expect(parseFrenchWhen('dans 2 jours', '2026-10-24')).toEqual(days('sure', ['2026-10-26']));
    expect(parseFrenchWhen('le week-end dernier', '2026-10-27')).toEqual(days('ask', ['2026-10-24', '2026-10-25']));
    expect(parseFrenchWhen('hier', '2026-03-30')).toEqual(days('sure', ['2026-03-29']));
    expect(parseFrenchWhen('après-demain', '2026-03-28')).toEqual(days('sure', ['2026-03-30']));
    expect(parseFrenchWhen('il y a 3 jours', '2026-03-31')).toEqual(days('sure', ['2026-03-28']));
  });

  it('29 février', () => {
    expect(parseFrenchWhen('hier', '2028-03-01')).toEqual(days('sure', ['2028-02-29']));
    expect(parseFrenchWhen('le 29 février', '2028-03-01')).toEqual(days('sure', ['2028-02-29']));
    expect(parseFrenchWhen('mardi dernier', '2028-03-01')).toEqual(days('check', ['2028-02-29']));
    expect(parseFrenchWhen('le 29 février', '2027-03-01')).toEqual(NONE);
    expect(parseFrenchWhen('hier', '2027-03-01')).toEqual(days('sure', ['2027-02-28']));
  });
});
