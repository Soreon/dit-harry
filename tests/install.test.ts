import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSTALL_CARD_SNOOZE_MS,
  LS_INSTALL_DISMISSED_AT,
  canOfferInstall,
  installSectionMode,
  isStandaloneDisplay,
  parseDismissedAt,
  shouldShowInstallCard,
} from '../src/lib/install';
import {
  dismissInstallCard,
  initInstall,
  install,
  promptInstall,
  type DisplayModeQuery,
  type InstallEnv,
} from '../src/lib/install.svelte';

/* ------------------------------------------------------------------ */
/* Règles pures                                                        */
/* ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 9, 8, 12);
const DAY = 24 * 60 * 60 * 1000;
const offer = { canPrompt: true, standalone: false, installed: false };

describe('install.ts — règles', () => {
  it('le bouton n’est proposé que si Chrome le permet et que l’appli n’est pas installée', () => {
    expect(canOfferInstall(offer)).toBe(true);
    expect(canOfferInstall({ ...offer, canPrompt: false })).toBe(false);
    expect(canOfferInstall({ ...offer, standalone: true })).toBe(false);
    expect(canOfferInstall({ ...offer, installed: true })).toBe(false);
  });

  it('carte d’installation : jamais pendant un enregistrement', () => {
    const base = { ...offer, recording: false, dismissedAt: null, now: NOW };
    expect(shouldShowInstallCard(base)).toBe(true);
    expect(shouldShowInstallCard({ ...base, recording: true })).toBe(false);
    expect(shouldShowInstallCard({ ...base, canPrompt: false })).toBe(false);
    expect(shouldShowInstallCard({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallCard({ ...base, installed: true })).toBe(false);
  });

  it('carte d’installation : masquée 30 jours après fermeture, puis de retour', () => {
    const base = { ...offer, recording: false, now: NOW };
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - DAY })).toBe(false);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - INSTALL_CARD_SNOOZE_MS + 1 })).toBe(false);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - INSTALL_CARD_SNOOZE_MS })).toBe(true);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW - 90 * DAY })).toBe(true);
    // Horloge recalée un peu en arrière : toujours masquée ; date absurde : pas masquée à vie
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW + 60_000 })).toBe(false);
    expect(shouldShowInstallCard({ ...base, dismissedAt: NOW + 400 * DAY })).toBe(true);
  });

  it('date de fermeture lue dans localStorage', () => {
    expect(parseDismissedAt(null)).toBeNull();
    expect(parseDismissedAt('')).toBeNull();
    expect(parseDismissedAt('abc')).toBeNull();
    expect(parseDismissedAt('0')).toBeNull();
    expect(parseDismissedAt('-5')).toBeNull();
    expect(parseDismissedAt('Infinity')).toBeNull();
    expect(parseDismissedAt(String(NOW))).toBe(NOW);
  });

  it('section « Application » des réglages', () => {
    expect(installSectionMode({ canPrompt: true, standalone: true, installed: false })).toBe('installed');
    expect(installSectionMode({ canPrompt: false, standalone: false, installed: true })).toBe('installed');
    expect(installSectionMode(offer)).toBe('prompt');
    expect(installSectionMode({ canPrompt: false, standalone: false, installed: false })).toBe('manual');
  });

  it('fenêtre d’appli : display-mode standalone, ou application Android (TWA)', () => {
    expect(isStandaloneDisplay(true, '')).toBe(true);
    expect(isStandaloneDisplay(false, 'android-app://com.exemple.dit/')).toBe(true);
    expect(isStandaloneDisplay(false, 'https://www.google.com/')).toBe(false);
    expect(isStandaloneDisplay(false, '')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Écouteurs et fenêtre d'installation                                 */
/* ------------------------------------------------------------------ */

type Choice = { outcome: 'accepted' | 'dismissed'; platform: string };

/** Faux `beforeinstallprompt` : journal des appels de prompt(). */
function bipEvent(opts: { outcome?: Choice['outcome']; promptError?: Error } = {}) {
  const calls: string[] = [];
  const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    platforms: ['web'],
    userChoice: Promise.resolve<Choice>({ outcome: opts.outcome ?? 'accepted', platform: 'web' }),
    prompt: () => {
      calls.push('prompt');
      return opts.promptError ? Promise.reject(opts.promptError) : Promise.resolve();
    },
  });
  return { ev, calls };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

function fakeDisplayMode(matches: boolean) {
  const target = new EventTarget();
  const mq = {
    matches,
    addEventListener: (t: 'change', cb: () => void) => target.addEventListener(t, cb),
    removeEventListener: (t: 'change', cb: () => void) => target.removeEventListener(t, cb),
  } satisfies DisplayModeQuery;
  return {
    mq,
    set(next: boolean) {
      mq.matches = next;
      target.dispatchEvent(new Event('change'));
    },
  };
}

let dispose: (() => void) | undefined;

function setup(env: Partial<InstallEnv> = {}) {
  const target = new EventTarget();
  const storage = memoryStorage();
  dispose = initInstall({ target, storage, ...env });
  return { target, storage };
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe('install.svelte.ts — beforeinstallprompt', () => {
  it('l’événement est retenu (mini-barre de Chrome évitée) et rend l’installation possible', () => {
    const { target } = setup();
    expect(install.canPrompt).toBe(false);
    const { ev } = bipEvent();
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(install.canPrompt).toBe(true);
  });

  it('prompt() est appelé tout de suite (dans le clic), puis l’issue « acceptée » est rendue', async () => {
    const { target } = setup();
    const { ev, calls } = bipEvent({ outcome: 'accepted' });
    target.dispatchEvent(ev);

    const pending = promptInstall();
    // Synchrone : aucune attente avant prompt() (Chrome exige un appui récent)
    expect(calls).toEqual(['prompt']);
    expect(install.canPrompt).toBe(false);
    await expect(pending).resolves.toBe('accepted');
    expect(install.installed).toBe(true);
  });

  it('l’événement ne sert qu’une fois', async () => {
    const { target } = setup();
    const { ev, calls } = bipEvent({ outcome: 'dismissed' });
    target.dispatchEvent(ev);
    await expect(promptInstall()).resolves.toBe('dismissed');
    expect(install.installed).toBe(false);
    await expect(promptInstall()).resolves.toBe('unavailable');
    expect(calls).toEqual(['prompt']);
  });

  it('refus dans la fenêtre de Chrome : la carte reste masquée malgré le nouvel événement', async () => {
    const { target, storage } = setup();
    target.dispatchEvent(bipEvent({ outcome: 'dismissed' }).ev);
    const before = Date.now();
    await expect(promptInstall()).resolves.toBe('dismissed');
    // Chrome renvoie aussitôt un beforeinstallprompt après un refus
    target.dispatchEvent(bipEvent().ev);

    expect(install.dismissedAt).toBeGreaterThanOrEqual(before);
    expect(storage.data.get(LS_INSTALL_DISMISSED_AT)).toBe(String(install.dismissedAt));
    const card = { ...install, recording: false, dismissedAt: install.dismissedAt, now: Date.now() };
    expect(shouldShowInstallCard(card)).toBe(false);
    // L'accueil et les réglages gardent leur bouton
    expect(canOfferInstall(install)).toBe(true);
    expect(installSectionMode(install)).toBe('prompt');
  });

  it('installation acceptée : la carte n’est pas mise en sommeil', async () => {
    const { target, storage } = setup();
    target.dispatchEvent(bipEvent({ outcome: 'accepted' }).ev);
    await expect(promptInstall()).resolves.toBe('accepted');
    expect(install.dismissedAt).toBeNull();
    expect(storage.data.has(LS_INSTALL_DISMISSED_AT)).toBe(false);
  });

  it('sans événement en réserve : « unavailable »', async () => {
    setup();
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('prompt() refusé par Chrome (pas d’appui récent) : « unavailable »', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { target } = setup();
    const err = Object.assign(new Error('refusé'), { name: 'NotAllowedError' });
    target.dispatchEvent(bipEvent({ promptError: err }).ev);
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('appinstalled (ex. depuis le menu de Chrome) : installée, plus de bouton', async () => {
    const { target } = setup();
    target.dispatchEvent(bipEvent().ev);
    target.dispatchEvent(new Event('appinstalled'));
    expect(install.installed).toBe(true);
    expect(install.canPrompt).toBe(false);
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('un nouvel événement après désinstallation rend le bouton', () => {
    const { target } = setup();
    target.dispatchEvent(new Event('appinstalled'));
    target.dispatchEvent(bipEvent().ev);
    expect(install.installed).toBe(false);
    expect(install.canPrompt).toBe(true);
  });

  it('débranché : les événements suivants sont ignorés', () => {
    const { target } = setup();
    dispose?.();
    target.dispatchEvent(bipEvent().ev);
    expect(install.canPrompt).toBe(false);
  });
});

describe('install.svelte.ts — fenêtre d’appli et préférence', () => {
  it('standalone : lu au démarrage et suivi', () => {
    const display = fakeDisplayMode(false);
    setup({ matchMedia: () => display.mq });
    expect(install.standalone).toBe(false);
    display.set(true);
    expect(install.standalone).toBe(true);
  });

  it('standalone : référent android-app:// (application Android)', () => {
    setup({ matchMedia: () => fakeDisplayMode(false).mq, referrer: 'android-app://com.exemple.dit/' });
    expect(install.standalone).toBe(true);
  });

  it('fermeture de la carte : mémorisée et relue au démarrage suivant', () => {
    const { storage } = setup();
    expect(install.dismissedAt).toBeNull();
    dismissInstallCard(NOW);
    expect(install.dismissedAt).toBe(NOW);
    expect(storage.data.get(LS_INSTALL_DISMISSED_AT)).toBe(String(NOW));

    dispose?.();
    dispose = initInstall({ target: new EventTarget(), storage });
    expect(install.dismissedAt).toBe(NOW);
  });

  it('stockage inutilisable : pas d’erreur, la fermeture vaut pour cette visite', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    setup({ storage: broken });
    expect(install.dismissedAt).toBeNull();
    expect(() => dismissInstallCard(NOW)).not.toThrow();
    expect(install.dismissedAt).toBe(NOW);
  });
});
