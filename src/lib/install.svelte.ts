/**
 * Installation de l'appli (PWA) : état réactif et écouteurs du navigateur.
 *
 * Chrome n'affiche sa propre proposition (mini-barre en bas de l'écran) que selon ses critères,
 * et plus du tout pendant des mois une fois qu'elle a été fermée. On capture donc
 * `beforeinstallprompt` dès le démarrage — main.ts, avant le montage : l'événement ne se
 * rattrape pas — pour proposer l'installation depuis l'appli (accueil, carte sur l'écran
 * Aujourd'hui, réglages). Règles de décision : install.ts.
 */
import { LS_INSTALL_DISMISSED_AT, isStandaloneDisplay, parseDismissedAt, type InstallOutcome } from './install';

/** Événement propre à Chrome (absent de lib.dom) : la fenêtre d'installation, mise de côté. */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  /** Ouvre la fenêtre d'installation. Exige un appui récent ; utilisable une seule fois. */
  prompt(): Promise<unknown>;
}

/** Liste de requêtes média réduite à ce qu'on utilise. */
export interface DisplayModeQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', cb: () => void): void;
  removeEventListener(type: 'change', cb: () => void): void;
}

/** Ce dont le module a besoin du navigateur (remplaçable dans les tests). */
export interface InstallEnv {
  /** Reçoit `beforeinstallprompt` et `appinstalled` (window). */
  target: EventTarget;
  matchMedia?: (query: string) => DisplayModeQuery;
  referrer?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

const STANDALONE_QUERY = '(display-mode: standalone)';

class InstallState {
  /** Un `beforeinstallprompt` est en réserve : nos boutons peuvent ouvrir la fenêtre de Chrome. */
  canPrompt = $state(false);
  /** Installée pendant cette visite (`appinstalled`, ou proposition acceptée). */
  installed = $state(false);
  /** Ouverte depuis son icône (fenêtre d'appli, sans barre d'adresse). */
  standalone = $state(false);
  /** Fermeture de la carte « Installe Dit Harry », ou refus dans Chrome (ms), ou `null`. */
  dismissedAt = $state<number | null>(null);
}

export const install = new InstallState();

let deferred: BeforeInstallPromptEvent | null = null;
let storage: InstallEnv['storage'];
let disposeCurrent: (() => void) | null = null;

function browserEnv(): InstallEnv {
  let store: InstallEnv['storage'];
  try {
    store = window.localStorage;
  } catch {
    store = undefined; // données de site bloquées : préférence non mémorisée
  }
  return {
    target: window,
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    referrer: document.referrer,
    storage: store,
  };
}

function readDismissedAt(): number | null {
  try {
    return parseDismissedAt(storage?.getItem(LS_INSTALL_DISMISSED_AT) ?? null);
  } catch {
    return null;
  }
}

/**
 * Branche les écouteurs (un seul jeu à la fois : un nouvel appel remplace le précédent).
 * Retourne de quoi les débrancher.
 */
export function initInstall(env: InstallEnv = browserEnv()): () => void {
  disposeCurrent?.();
  storage = env.storage;
  deferred = null;
  install.canPrompt = false;
  install.installed = false;
  install.dismissedAt = readDismissedAt();

  const mq = env.matchMedia?.(STANDALONE_QUERY);
  const referrer = env.referrer ?? '';
  const refreshDisplayMode = (): void => {
    install.standalone = isStandaloneDisplay(mq?.matches ?? false, referrer);
  };
  refreshDisplayMode();

  const onBeforeInstallPrompt = (e: Event): void => {
    // Sans cela, Chrome peut montrer sa mini-barre une fois, puis plus rien pendant des mois
    // si elle est fermée : l'événement est gardé pour nos propres boutons.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    install.canPrompt = true;
    // Chrome ne le propose que si l'appli n'est pas (ou plus) installée.
    install.installed = false;
  };
  const onAppInstalled = (): void => {
    deferred = null;
    install.canPrompt = false;
    install.installed = true;
  };

  env.target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  env.target.addEventListener('appinstalled', onAppInstalled);
  mq?.addEventListener('change', refreshDisplayMode);

  const dispose = (): void => {
    env.target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    env.target.removeEventListener('appinstalled', onAppInstalled);
    mq?.removeEventListener('change', refreshDisplayMode);
    if (disposeCurrent === dispose) disposeCurrent = null;
  };
  disposeCurrent = dispose;
  return dispose;
}

/**
 * Ouvre la fenêtre d'installation de Chrome. À appeler DIRECTEMENT dans le gestionnaire du
 * clic : `prompt()` part avant toute attente (Chrome exige un appui récent). L'événement ne
 * sert qu'une fois, il est oublié tout de suite ; Chrome en renverra un s'il le juge utile.
 */
export function promptInstall(): Promise<InstallOutcome> {
  const ev = deferred;
  deferred = null;
  install.canPrompt = false;
  if (!ev) return Promise.resolve('unavailable');

  let shown: Promise<unknown>;
  try {
    shown = ev.prompt();
  } catch (e) {
    console.warn('[installation]', e);
    return Promise.resolve('unavailable');
  }
  return (async (): Promise<InstallOutcome> => {
    try {
      await shown;
      const choice = await ev.userChoice;
      if (choice.outcome !== 'accepted') {
        // Refus dans la fenêtre de Chrome : même effet que la croix de la carte. Chrome renvoie
        // aussitôt un nouveau `beforeinstallprompt` : sans cela, la carte de l'écran Aujourd'hui
        // reviendrait sur-le-champ. Les boutons de l'accueil et des réglages restent utilisables.
        dismissInstallCard();
        return 'dismissed';
      }
      install.installed = true;
      return 'accepted';
    } catch (e) {
      // Ex. NotAllowedError : appelée sans appui récent de l'utilisateur.
      console.warn('[installation]', e);
      return 'unavailable';
    }
  })();
}

/**
 * Croix de la carte d'installation, ou refus dans la fenêtre de Chrome : ne plus montrer la
 * carte pendant 30 jours.
 */
export function dismissInstallCard(now: number = Date.now()): void {
  install.dismissedAt = now;
  try {
    storage?.setItem(LS_INSTALL_DISMISSED_AT, String(now));
  } catch {
    // stockage plein ou bloqué : la carte reviendra à la prochaine ouverture
  }
}
