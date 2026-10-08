/**
 * Verrouillage de l'appli : état réactif, verrouillage automatique et cérémonies.
 *
 * - Déverrouillage par clé d'accès de la plateforme (empreinte, visage, code du téléphone),
 *   vérifiée localement (lock.ts), ou par la phrase de secours (PBKDF2).
 * - Configuration propre à l'appareil (IndexedDB `kv` 'lock.config', jamais envoyée à Drive)
 *   + drapeau localStorage lu de façon synchrone à la construction : l'écran de verrouillage
 *   est là dès le premier rendu, avant tout contenu du journal.
 * - L'état « déverrouillé » ne vit qu'en mémoire : rechargement ou démarrage à froid = verrouillé.
 * - Ne touche jamais à un enregistrement ni à une synchro : c'est une barrière d'interface.
 * Voir docs/SPEC.md §15.
 */
import { toAppError } from './errors';
import {
  DEFAULT_LOCK_DELAY_SEC,
  KV_LOCK_ATTEMPTS,
  KV_LOCK_CONFIG,
  LOCK_INACTIVITY_MS,
  LS_LOCK_ENABLED,
  PASSPHRASE_FREE_ATTEMPTS,
  base64Decode,
  base64urlDecode,
  buildCreationOptions,
  buildRequestOptions,
  hasPasskey,
  hashPassphrase,
  isLockDelay,
  normalizeAttempts,
  normalizeLockConfig,
  normalizePassphrase,
  passphraseWaitMs,
  randomBytes,
  remainingWaitMs,
  shouldLockForInactivity,
  shouldLockOnReturn,
  validateNewPassphrase,
  verifyAssertion,
  verifyPassphrase,
  COSE_ES256,
  COSE_RS256,
  WEBAUTHN_TIMEOUT_MS,
  type LockAttempts,
  type LockConfig,
  type PasskeyAssertion,
  type PasskeyAuthenticator,
  type PasskeyRegistration,
} from './lock';
import type { LocalDb } from './types';

/** Issue d'une vérification ou d'une action, message prêt à afficher. */
export interface LockResult {
  ok: boolean;
  message?: string;
}

/** Activation : `passkey` = clé d'accès non créée → proposer le verrou par phrase seule. */
export type EnableResult =
  | { ok: true; withPasskey: boolean }
  | { ok: false; reason: 'invalid' | 'passkey' | 'error'; message: string };

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Ce que le verrou lit du navigateur (remplaçable dans les tests). */
export interface LockEnv {
  /** Reçoit `visibilitychange`. */
  doc: EventTarget;
  /** Reçoit `focus` et les événements d'activité (appui, touche, défilement). */
  win: EventTarget;
  visibilityState(): DocumentVisibilityState;
  /** WebAuthn exige une page qui a le focus. */
  hasFocus(): boolean;
  origin(): string;
  hostname(): string;
}

export interface LockDeps {
  db: LocalDb;
  authenticator: PasskeyAuthenticator;
  /** Drapeau localStorage (défaut `dh.lock.enabled`, voir `lockFlagKey`). */
  flagKey?: string;
  /** Défaut : localStorage s'il est utilisable. */
  storage?: FlagStorage | null;
  env?: Partial<LockEnv>;
  now?: () => number;
  /** Itérations PBKDF2 pour une nouvelle phrase (défaut 600 000 ; réduit dans les tests). */
  iterations?: number;
  /** Enregistrement ou écoute en cours : pas de verrouillage pour inactivité. */
  isBusy?: () => boolean;
  inactivityMs?: number;
  /** Fréquence de contrôle de l'inactivité (ms). */
  checkEveryMs?: number;
  /** L'écran de verrouillage vient de disparaître (ex. notifications mises en attente). */
  onUnlock?: () => void;
}

/** Durée de validité d'une vérification avant une action sensible (désactiver, changer la phrase…). */
const VERIFIED_FOR_MS = 2 * 60 * 1000;
/**
 * Une fenêtre de clé d'accès ne cache pas la page plus longtemps que son délai WebAuthn : au-delà
 * (cérémonie bloquée), l'absence compte même si la cérémonie n'est pas terminée.
 */
const CEREMONY_MAX_MS = 2 * WEBAUTHN_TIMEOUT_MS;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

const MSG = {
  verifyFirst: 'Confirme d’abord que c’est toi (empreinte ou phrase de secours).',
  noPasskey: 'Aucune empreinte n’est enregistrée pour Dit Harry sur ce téléphone.',
  refused: 'Vérification refusée. Réessaie, ou utilise ta phrase de secours.',
  emptyPassphrase: 'Saisis ta phrase de secours.',
  unreadable: 'Le verrou n’a pas pu être lu sur ce téléphone.',
};

function defaultStorage(): FlagStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // données de site bloquées
  }
}

function defaultEnv(): LockEnv {
  const hasDoc = typeof document !== 'undefined';
  return {
    doc: hasDoc ? document : new EventTarget(),
    win: typeof window !== 'undefined' ? window : new EventTarget(),
    visibilityState: () => (hasDoc ? document.visibilityState : 'visible'),
    hasFocus: () => (hasDoc && typeof document.hasFocus === 'function' ? document.hasFocus() : true),
    origin: () => (typeof location !== 'undefined' ? (location.origin ?? '') : ''),
    hostname: () => (typeof location !== 'undefined' ? (location.hostname ?? '') : ''),
  };
}

function errorName(e: unknown): string {
  return e instanceof DOMException || e instanceof Error ? e.name : '';
}

/** Échec de `navigator.credentials.get()` → message, ou undefined s'il n'y a rien à dire. */
function assertionErrorMessage(e: unknown): string | undefined {
  switch (errorName(e)) {
    case 'AbortError':
      return undefined;
    case 'NotAllowedError':
      return 'Empreinte non vérifiée (annulée ou trop longue). Réessaie, ou utilise ta phrase de secours, par exemple si la clé d’accès a été supprimée.';
    case 'SecurityError':
      return 'Cette adresse ne peut pas utiliser la clé d’accès de Dit Harry : utilise ta phrase de secours.';
    default:
      return 'L’empreinte n’a pas pu être vérifiée. Réessaie, ou utilise ta phrase de secours.';
  }
}

/** Échec de `navigator.credentials.create()` → message. */
function creationErrorMessage(e: unknown): string {
  switch (errorName(e)) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'La clé d’accès n’a pas été créée : demande annulée ou restée sans réponse.';
    case 'InvalidStateError':
      return 'Une clé d’accès Dit Harry existe déjà sur ce téléphone et n’a pas pu être remplacée.';
    case 'NotSupportedError':
      return 'Ce téléphone ne sait pas créer de clé d’accès utilisable par Dit Harry.';
    case 'SecurityError':
      return 'Cette adresse ne permet pas de créer une clé d’accès.';
    default:
      return 'La clé d’accès n’a pas pu être créée.';
  }
}

/** Clé d'accès renvoyée par l'authentificateur : utilisable pour vérifier plus tard ? */
function checkRegistration(reg: PasskeyRegistration): PasskeyRegistration {
  const algOk = reg.alg === COSE_ES256 || reg.alg === COSE_RS256;
  let bytesOk = false;
  try {
    bytesOk = base64urlDecode(reg.credentialId).length > 0 && base64Decode(reg.publicKeySpki).length > 0;
  } catch {
    bytesOk = false;
  }
  if (!algOk || !bytesOk) throw new DOMException('Clé d’accès inutilisable.', 'NotSupportedError');
  return reg;
}

/**
 * Message après une phrase fausse. L'attente imposée n'y figure pas : les écrans affichent leur
 * propre compte à rebours (`waitMs()`), et ce message reste juste une fois l'attente finie.
 */
function wrongPassphraseMessage(failures: number): string {
  const left = PASSPHRASE_FREE_ATTEMPTS - failures;
  if (left > 0 && left <= 2) {
    return `Phrase de secours incorrecte. Encore ${left === 1 ? 'un essai' : `${left} essais`} avant une attente.`;
  }
  return 'Phrase de secours incorrecte.';
}

export class LockController {
  /* --- État réactif ------------------------------------------------ */
  /** Verrou actif sur cet appareil (drapeau au démarrage, puis configuration lue). */
  enabled = $state(false);
  /** Écran de verrouillage affiché. */
  locked = $state(false);
  /** Configuration lue (présente ou non). */
  loaded = $state(false);
  loadError = $state<string | null>(null);
  config = $state.raw<LockConfig | null>(null);
  /** Création ou vérification d'une clé d'accès en cours. */
  passkeyPending = $state(false);
  /** Calcul de la phrase de secours en cours (PBKDF2). */
  passphrasePending = $state(false);
  attempts = $state.raw<LockAttempts>({ failures: 0, retryAt: 0 });
  /** Dernier échec de déverrouillage (écran de verrouillage). */
  unlockError = $state<string | null>(null);

  /* --- Interne ------------------------------------------------------- */
  readonly authenticator: PasskeyAuthenticator;
  readonly hostname: string;
  private readonly db: LocalDb;
  private readonly env: LockEnv;
  private readonly storage: FlagStorage | null;
  private readonly flagKey: string;
  private readonly now: () => number;
  private readonly iterations: number | undefined;
  private readonly isBusy: () => boolean;
  private readonly inactivityMs: number;
  private readonly checkEveryMs: number;
  private readonly onUnlock: () => void;
  private hiddenAt: number | null = null;
  private lastActivity: number;
  private verifiedUntil = 0;
  /** Incrémenté à chaque verrouillage : une vérification commencée avant ne vaut plus. */
  private lockEpoch = 0;
  /** Cérémonies WebAuthn en cours : la fenêtre système ne doit pas déclencher le verrou. */
  private ceremonies = 0;
  /** Page cachée pendant une cérémonie (peut-être par la fenêtre système elle-même). */
  private hiddenInCeremony = false;
  /** Proposer la clé d'accès dès que l'écran apparaît (démarrage, retour au premier plan). */
  private autoPromptArmed = false;

  constructor(deps: LockDeps) {
    this.db = deps.db;
    this.authenticator = deps.authenticator;
    this.env = { ...defaultEnv(), ...deps.env };
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    this.flagKey = deps.flagKey ?? LS_LOCK_ENABLED;
    this.now = deps.now ?? Date.now;
    this.iterations = deps.iterations;
    this.isBusy = deps.isBusy ?? (() => false);
    this.inactivityMs = deps.inactivityMs ?? LOCK_INACTIVITY_MS;
    this.checkEveryMs = deps.checkEveryMs ?? 15_000;
    this.onUnlock = deps.onUnlock ?? (() => undefined);
    this.hostname = this.env.hostname();
    this.lastActivity = this.now();

    // Lecture synchrone : verrouillé dès le premier rendu, sans attendre IndexedDB.
    const flagged = this.readFlag() === '1';
    this.enabled = flagged;
    this.locked = flagged;
    this.autoPromptArmed = flagged;
  }

  /* --- Dérivés (getters : réactifs, `config` est un état) ------------- */

  /** La configuration a une clé d'accès créée pour un autre domaine (ex. développement local). */
  get rpMismatch(): boolean {
    return hasPasskey(this.config) && this.config.rpId !== this.hostname;
  }

  /** Le bouton « Déverrouiller » (clé d'accès) peut servir ici. */
  get passkeyUsable(): boolean {
    return hasPasskey(this.config) && this.authenticator.supported && this.config.rpId === this.hostname;
  }

  get delaySec(): number {
    return this.config?.delaySec ?? DEFAULT_LOCK_DELAY_SEC;
  }

  /* ================================================================== */
  /* Démarrage / arrêt                                                   */
  /* ================================================================== */

  /** Branche les écouteurs et lit la configuration. Retourne de quoi tout débrancher. */
  start(): () => void {
    const { doc, win } = this.env;
    const activity = { capture: true, passive: true } as const;
    doc.addEventListener('visibilitychange', this.onVisibilityChange);
    win.addEventListener('pageshow', this.onPageShow);
    win.addEventListener('focus', this.onFocus);
    for (const type of ACTIVITY_EVENTS) win.addEventListener(type, this.onActivity, activity);
    const timer = setInterval(this.checkInactivity, this.checkEveryMs);
    void this.load();
    return () => {
      doc.removeEventListener('visibilitychange', this.onVisibilityChange);
      win.removeEventListener('pageshow', this.onPageShow);
      win.removeEventListener('focus', this.onFocus);
      for (const type of ACTIVITY_EVENTS) win.removeEventListener(type, this.onActivity, activity);
      clearInterval(timer);
    };
  }

  /** Lit la configuration (démarrage, ou « Réessayer » après une erreur de lecture). */
  async load(): Promise<void> {
    try {
      const [raw, attempts] = await Promise.all([
        this.db.getKv<unknown>(KV_LOCK_CONFIG),
        this.db.getKv<unknown>(KV_LOCK_ATTEMPTS),
      ]);
      this.attempts = normalizeAttempts(attempts);
      const config = normalizeLockConfig(raw);
      this.config = config;
      this.loadError = null;
      if (config) {
        this.writeFlag(true);
        if (!this.enabled) {
          // Drapeau perdu (stockage du navigateur partiellement effacé) : verrouillé comme au
          // démarrage, puisque personne ne s'est encore identifié.
          this.enabled = true;
          this.locked = true;
          this.autoPromptArmed = true;
        }
      } else {
        // Pas de verrou (ou configuration illisible) : jamais d'écran sans issue.
        this.writeFlag(false);
        this.enabled = false;
        this.release();
      }
      this.loaded = true;
      this.tryAutoPrompt();
    } catch (e) {
      console.warn('[verrou] lecture impossible', e);
      // Drapeau posé : on reste verrouillé (l'écran propose de réessayer).
      this.loadError = MSG.unreadable;
    }
  }

  /** Verrou retiré (désactivation, données de l'appareil effacées) : état de départ, sans verrou. */
  reset(): void {
    this.writeFlag(false);
    this.config = null;
    this.enabled = false;
    this.loaded = true;
    this.loadError = null;
    this.attempts = { failures: 0, retryAt: 0 };
    this.unlockError = null;
    this.verifiedUntil = 0;
    this.hiddenAt = null;
    this.release();
  }

  /**
   * Données de l'appareil effacées (`db.clearAll()`) : plus de verrou, et la clé d'accès devenue
   * inutile est signalée au gestionnaire de mots de passe (sinon une seconde « Dit Harry — verrou »
   * s'y ajouterait à la prochaine activation, et on pourrait supprimer la mauvaise).
   */
  forgetAndReset(): void {
    const config = this.config;
    this.reset();
    if (hasPasskey(config)) void this.authenticator.forget?.(config.rpId, config.credentialId);
  }

  /* ================================================================== */
  /* Verrouillage automatique                                            */
  /* ================================================================== */

  /**
   * « Verrouiller maintenant », retour après le délai, inactivité. Pas de lancement automatique
   * de l'empreinte ensuite (seulement au démarrage et au retour au premier plan).
   */
  lock(): void {
    if (!this.enabled || this.locked) return;
    this.locked = true;
    this.lockEpoch++;
    this.autoPromptArmed = false;
    this.unlockError = null;
    this.verifiedUntil = 0;
    this.hiddenAt = null;
  }

  private unlock(): void {
    this.unlockError = null;
    this.hiddenAt = null;
    this.lastActivity = this.now();
    if (this.attempts.failures > 0 || this.attempts.retryAt > 0) void this.saveAttempts({ failures: 0, retryAt: 0 });
    this.release();
  }

  /** L'écran de verrouillage disparaît (déverrouillage, verrou retiré). */
  private release(): void {
    const wasLocked = this.locked;
    this.locked = false;
    this.autoPromptArmed = false;
    if (wasLocked) this.onUnlock();
  }

  private onVisibilityChange = (): void => {
    const now = this.now();
    if (this.env.visibilityState() !== 'visible') {
      // La fenêtre système d'une clé d'accès (ex. code du téléphone en plein écran) peut cacher
      // la page : la décision attend la fin de la cérémonie (`endCeremony`) ou le retour.
      this.hiddenInCeremony = this.ceremonies > 0;
      if (!this.enabled || this.locked) return;
      this.hiddenAt = now;
      // « Immédiat » : verrouillé avant la capture de l'écran des applis récentes (au mieux).
      if (this.ceremonies === 0 && this.delaySec === 0) this.lock();
      return;
    }
    const hiddenAt = this.hiddenAt;
    const hiddenInCeremony = this.hiddenInCeremony;
    this.hiddenAt = null;
    this.hiddenInCeremony = false;
    this.lastActivity = now;
    if (this.enabled && !this.locked && shouldLockOnReturn(hiddenAt, now, this.delaySec)) {
      // Cérémonie encore en cours : seule une absence plus longue qu'une fenêtre système compte.
      if (this.ceremonies === 0 || (hiddenAt !== null && now - hiddenAt >= CEREMONY_MAX_MS)) this.lock();
    }
    // L'écran de verrouillage réapparaît : proposer l'empreinte tout de suite. Pas pendant une
    // cérémonie, ni quand seule sa fenêtre a caché la page : une demande annulée ne se rouvre pas
    // d'elle-même (sinon, en boucle, plus moyen d'atteindre la phrase de secours).
    if (this.locked && this.ceremonies === 0 && !hiddenInCeremony) {
      this.autoPromptArmed = true;
      this.tryAutoPrompt();
    }
  };

  /**
   * Fin d'une cérémonie WebAuthn. Réussie : la personne est là, la page cachée par la fenêtre
   * système n'était pas un départ. Sinon, page toujours cachée : c'est un vrai départ (Accueil,
   * appel, écran éteint pendant la demande), compté comme tel.
   */
  private endCeremony(present: boolean): void {
    this.ceremonies = Math.max(0, this.ceremonies - 1);
    if (this.ceremonies > 0 || !this.enabled || this.locked) return;
    if (present) {
      this.hiddenAt = null;
      return;
    }
    if (this.env.visibilityState() === 'visible') return;
    this.hiddenInCeremony = false;
    this.hiddenAt ??= this.now();
    if (this.delaySec === 0) this.lock();
  }

  /** Page restaurée depuis le cache avant/arrière (onglet Chrome) : même règle qu'un retour. */
  private onPageShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) this.onVisibilityChange();
  };

  private onFocus = (): void => {
    this.tryAutoPrompt();
  };

  private onActivity = (): void => {
    this.lastActivity = this.now();
  };

  private checkInactivity = (): void => {
    if (!this.enabled || this.locked || this.ceremonies > 0) return;
    if (this.env.visibilityState() !== 'visible') return;
    const now = this.now();
    const busy = this.isBusy();
    if (busy || now < this.lastActivity) {
      // Enregistrement en cours (ou horloge recalée) : le compte repart de maintenant.
      this.lastActivity = now;
      return;
    }
    if (shouldLockForInactivity({ lastActivity: this.lastActivity, now, busy, inactivityMs: this.inactivityMs })) {
      this.lock();
    }
  };

  /**
   * Lance la vérification par clé d'accès une fois par apparition de l'écran de verrouillage,
   * page visible et active. Sans succès (ex. activation de l'utilisateur exigée), le bouton reste.
   */
  private tryAutoPrompt(): void {
    if (!this.autoPromptArmed || !this.locked || !this.loaded || !this.passkeyUsable || this.passkeyPending) return;
    if (this.env.visibilityState() !== 'visible' || !this.env.hasFocus()) return;
    this.autoPromptArmed = false;
    void this.unlockWithPasskey(true);
  }

  /* ================================================================== */
  /* Déverrouillage                                                      */
  /* ================================================================== */

  /**
   * Clé d'accès → vérification locale de l'assertion. `navigator.credentials.get()` part avant
   * toute attente (à appeler directement dans le clic).
   */
  private passkeyCeremony(silent: boolean): Promise<LockResult> {
    const config = this.config;
    if (!hasPasskey(config) || !this.passkeyUsable) return Promise.resolve({ ok: false, message: MSG.noPasskey });
    if (this.passkeyPending) return Promise.resolve({ ok: false });
    const challenge = randomBytes(32);
    let pending: Promise<PasskeyAssertion>;
    this.ceremonies++;
    this.passkeyPending = true;
    try {
      pending = this.authenticator.get(
        buildRequestOptions({ rpId: config.rpId, credentialId: config.credentialId, challenge }),
      );
    } catch (e) {
      pending = Promise.reject(e);
    }
    return (async (): Promise<LockResult> => {
      let result: LockResult = { ok: false };
      try {
        const assertion = await pending;
        const check = await verifyAssertion(assertion, {
          challenge,
          origin: this.env.origin(),
          rpId: config.rpId,
          credentialId: config.credentialId,
          publicKeySpki: config.publicKeySpki,
          alg: config.alg,
        });
        if (check.ok) {
          result = { ok: true };
        } else {
          console.warn('[verrou] assertion refusée :', check.reason);
          result = { ok: false, message: MSG.refused };
        }
      } catch (e) {
        if (!silent) console.info('[verrou] clé d’accès', e);
        result = { ok: false, message: silent ? undefined : assertionErrorMessage(e) };
      } finally {
        this.passkeyPending = false;
        this.endCeremony(result.ok);
      }
      return result;
    })();
  }

  /** Bouton « Déverrouiller » (ou lancement automatique : échec silencieux). */
  unlockWithPasskey(auto = false): Promise<boolean> {
    if (!this.locked) return Promise.resolve(true);
    if (!auto) {
      this.unlockError = null;
      // Demande faite à la main : le lancement automatique n'a plus lieu d'être.
      this.autoPromptArmed = false;
    }
    return this.passkeyCeremony(auto).then((r) => {
      if (r.ok) {
        if (this.locked) this.unlock();
        return true;
      }
      if (r.message && this.locked) this.unlockError = r.message;
      return false;
    });
  }

  async unlockWithPassphrase(passphrase: string): Promise<boolean> {
    if (!this.locked) return true;
    // Message retiré pendant le calcul : le même échec, de nouveau affiché, est de nouveau annoncé
    // par les lecteurs d'écran (zone `aria-live`).
    this.unlockError = null;
    const r = await this.checkPassphrase(passphrase);
    if (r.ok) {
      if (this.locked) this.unlock();
      return true;
    }
    if (r.message) this.unlockError = r.message;
    return false;
  }

  /** Attente restante avant un nouvel essai de phrase (ms). */
  waitMs(now = this.now()): number {
    return remainingWaitMs(this.attempts, now);
  }

  private async checkPassphrase(passphrase: string): Promise<LockResult> {
    const config = this.config;
    if (!config) return { ok: false, message: this.loadError ?? MSG.unreadable };
    if (this.passphrasePending) return { ok: false };
    const wait = this.waitMs();
    if (wait > 0) return { ok: false, message: 'Trop d’essais : attends la fin du décompte avant de réessayer.' };
    if (normalizePassphrase(passphrase) === '') return { ok: false, message: MSG.emptyPassphrase };
    this.passphrasePending = true;
    try {
      if (await verifyPassphrase(passphrase, config.passphrase)) {
        if (this.attempts.failures > 0) await this.saveAttempts({ failures: 0, retryAt: 0 });
        return { ok: true };
      }
      const failures = this.attempts.failures + 1;
      const waitMs = passphraseWaitMs(failures);
      await this.saveAttempts({ failures, retryAt: waitMs > 0 ? this.now() + waitMs : 0 });
      return { ok: false, message: wrongPassphraseMessage(failures) };
    } catch (e) {
      return { ok: false, message: `Vérification impossible. ${toAppError(e).message}` };
    } finally {
      this.passphrasePending = false;
    }
  }

  private async saveAttempts(attempts: LockAttempts): Promise<void> {
    this.attempts = attempts;
    try {
      if (attempts.failures === 0 && attempts.retryAt === 0) await this.db.deleteKv(KV_LOCK_ATTEMPTS);
      else await this.db.setKv(KV_LOCK_ATTEMPTS, attempts);
    } catch (e) {
      console.warn('[verrou] essais non enregistrés', e);
    }
  }

  /* ================================================================== */
  /* Réglages                                                            */
  /* ================================================================== */

  /** Empreinte (ou autre vérification de l'utilisateur) proposée par ce téléphone ? */
  async checkPasskeyAvailable(): Promise<boolean> {
    try {
      return this.authenticator.supported && (await this.authenticator.isAvailable());
    } catch {
      return false;
    }
  }

  /**
   * Active le verrou : phrase de secours obligatoire, puis clé d'accès si `withPasskey`.
   * `navigator.credentials.create()` part avant toute attente (à appeler dans le clic) ; le
   * calcul de la phrase se fait pendant que la fenêtre du téléphone est ouverte.
   */
  enable(passphrase: string, confirm: string, withPasskey: boolean): Promise<EnableResult> {
    const invalid = validateNewPassphrase(passphrase, confirm);
    if (invalid) return Promise.resolve({ ok: false, reason: 'invalid', message: invalid });
    if (this.enabled) {
      return Promise.resolve({ ok: false, reason: 'error', message: 'Le verrouillage est déjà activé.' });
    }
    const rpId = this.hostname;
    let created: Promise<PasskeyRegistration> | null = null;
    if (withPasskey) {
      this.ceremonies++;
      this.passkeyPending = true;
      try {
        created = this.authenticator.create(
          buildCreationOptions({ rpId, userId: randomBytes(16), challenge: randomBytes(32) }),
        );
      } catch (e) {
        created = Promise.reject(e);
      }
    }
    this.passphrasePending = true;
    const hashed = hashPassphrase(passphrase, { iterations: this.iterations });

    return (async (): Promise<EnableResult> => {
      let registration: PasskeyRegistration | null = null;
      try {
        if (created) {
          try {
            registration = checkRegistration(await created);
          } catch (e) {
            hashed.catch(() => undefined);
            console.info('[verrou] création de la clé d’accès', e);
            return { ok: false, reason: 'passkey', message: creationErrorMessage(e) };
          } finally {
            this.passkeyPending = false;
            this.endCeremony(registration !== null);
          }
        }
        const config: LockConfig = {
          enabled: true,
          passphrase: await hashed,
          delaySec: DEFAULT_LOCK_DELAY_SEC,
          createdAt: new Date(this.now()).toISOString(),
        };
        if (registration) {
          config.credentialId = registration.credentialId;
          config.publicKeySpki = registration.publicKeySpki;
          config.alg = registration.alg;
          config.rpId = rpId;
        }
        await this.saveConfig(config);
        await this.saveAttempts({ failures: 0, retryAt: 0 });
        this.enabled = true;
        this.locked = false;
        this.loaded = true;
        this.lastActivity = this.now();
        // Appli quittée pendant l'enregistrement : l'absence compte dès maintenant.
        this.hiddenAt = this.env.visibilityState() === 'visible' ? null : this.now();
        return { ok: true, withPasskey: !!registration };
      } catch (e) {
        // Clé créée mais configuration non enregistrée : elle ne servirait à rien.
        if (registration) void this.authenticator.forget?.(rpId, registration.credentialId);
        return {
          ok: false,
          reason: 'error',
          message: `Le verrouillage n’a pas pu être enregistré. ${toAppError(e).message}`,
        };
      } finally {
        this.passphrasePending = false;
      }
    })();
  }

  /** Confirmation par clé d'accès avant une action sensible (à appeler dans le clic). */
  verifyWithPasskey(): Promise<LockResult> {
    if (this.locked) return Promise.resolve({ ok: false });
    const epoch = this.lockEpoch;
    return this.passkeyCeremony(false).then((r) => this.afterVerification(r, epoch));
  }

  /** Confirmation par phrase de secours avant une action sensible (mêmes limites d'essais). */
  async verifyWithPassphrase(passphrase: string): Promise<LockResult> {
    if (this.locked) return { ok: false };
    const epoch = this.lockEpoch;
    return this.afterVerification(await this.checkPassphrase(passphrase), epoch);
  }

  /** Vérification réussie : valable 2 min, sauf si l'appli s'est verrouillée pendant le calcul. */
  private afterVerification(r: LockResult, epoch: number): LockResult {
    if (!r.ok) return r;
    if (this.locked || epoch !== this.lockEpoch) return { ok: false };
    this.verifiedUntil = this.now() + VERIFIED_FOR_MS;
    return r;
  }

  /** Une vérification récente (et pas de verrouillage depuis) autorise les actions sensibles. */
  get verified(): boolean {
    return !this.locked && this.now() < this.verifiedUntil;
  }

  /** Fin du parcours sensible (annulé ou terminé). */
  endVerification(): void {
    this.verifiedUntil = 0;
  }

  async setDelay(delaySec: number): Promise<LockResult> {
    const config = this.config;
    if (!config || !isLockDelay(delaySec)) return { ok: false, message: 'Délai non pris en charge.' };
    if (config.delaySec === delaySec) return { ok: true };
    try {
      await this.saveConfig({ ...config, delaySec });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: toAppError(e).message };
    }
  }

  async changePassphrase(passphrase: string, confirm: string): Promise<LockResult> {
    const config = this.config;
    if (!config) return { ok: false, message: MSG.unreadable };
    if (!this.verified) return { ok: false, message: MSG.verifyFirst };
    const invalid = validateNewPassphrase(passphrase, confirm);
    if (invalid) return { ok: false, message: invalid };
    const epoch = this.lockEpoch;
    this.passphrasePending = true;
    try {
      const hash = await hashPassphrase(passphrase, { iterations: this.iterations });
      // Verrouillée pendant le calcul : la confirmation ne vaut plus.
      if (epoch !== this.lockEpoch) return { ok: false };
      await this.saveConfig({ ...(this.config ?? config), passphrase: hash });
      await this.saveAttempts({ failures: 0, retryAt: 0 });
      this.verifiedUntil = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, message: `La phrase n’a pas pu être changée. ${toAppError(e).message}` };
    } finally {
      this.passphrasePending = false;
    }
  }

  /**
   * Nouvelle clé d'accès (l'ancienne a été supprimée, ou verrou par phrase seule) : après une
   * vérification, à appeler dans le clic. L'ancienne clé est signalée comme inutile.
   */
  reenrollPasskey(): Promise<LockResult> {
    const config = this.config;
    if (!config) return Promise.resolve({ ok: false, message: MSG.unreadable });
    if (!this.verified) return Promise.resolve({ ok: false, message: MSG.verifyFirst });
    if (this.passkeyPending) return Promise.resolve({ ok: false });
    const rpId = this.hostname;
    const epoch = this.lockEpoch;
    let created: Promise<PasskeyRegistration>;
    this.ceremonies++;
    this.passkeyPending = true;
    try {
      created = this.authenticator.create(buildCreationOptions({ rpId, userId: randomBytes(16), challenge: randomBytes(32) }));
    } catch (e) {
      created = Promise.reject(e);
    }
    return (async (): Promise<LockResult> => {
      let registration: PasskeyRegistration | null = null;
      try {
        registration = checkRegistration(await created);
      } catch (e) {
        console.info('[verrou] création de la clé d’accès', e);
        return { ok: false, message: creationErrorMessage(e) };
      } finally {
        this.passkeyPending = false;
        this.endCeremony(registration !== null);
      }
      if (epoch !== this.lockEpoch) {
        // Verrouillée entre-temps : la confirmation ne vaut plus, la nouvelle clé ne sert à rien.
        void this.authenticator.forget?.(rpId, registration.credentialId);
        return { ok: false };
      }
      const current = this.config ?? config;
      try {
        await this.saveConfig({ ...current, ...registration, rpId });
      } catch (e) {
        void this.authenticator.forget?.(rpId, registration.credentialId);
        return { ok: false, message: `La nouvelle empreinte n’a pas pu être enregistrée. ${toAppError(e).message}` };
      }
      if (hasPasskey(current) && current.credentialId !== registration.credentialId) {
        void this.authenticator.forget?.(current.rpId, current.credentialId);
      }
      this.verifiedUntil = 0;
      return { ok: true };
    })();
  }

  /**
   * Désactive le verrou (après une vérification, jamais depuis l'écran de verrouillage) ; la clé
   * d'accès est signalée comme inutile.
   */
  async disable(): Promise<LockResult> {
    const config = this.config;
    if (!config) return { ok: false, message: MSG.unreadable };
    if (!this.verified) return { ok: false, message: MSG.verifyFirst };
    try {
      await this.db.deleteKv(KV_LOCK_CONFIG);
      await this.db.deleteKv(KV_LOCK_ATTEMPTS);
    } catch (e) {
      return { ok: false, message: `Le verrouillage n’a pas pu être désactivé. ${toAppError(e).message}` };
    }
    // Configuration effacée : plus de verrou (rester verrouillé sans configuration serait sans issue).
    this.forgetAndReset();
    return { ok: true };
  }

  /* ================================================================== */
  /* Stockage                                                            */
  /* ================================================================== */

  private async saveConfig(config: LockConfig): Promise<void> {
    await this.db.setKv(KV_LOCK_CONFIG, config);
    this.config = config;
    this.writeFlag(true);
  }

  private readFlag(): string | null {
    try {
      return this.storage?.getItem(this.flagKey) ?? null;
    } catch {
      return null;
    }
  }

  private writeFlag(on: boolean): void {
    try {
      if (on) this.storage?.setItem(this.flagKey, '1');
      else this.storage?.removeItem(this.flagKey);
    } catch {
      // stockage bloqué : la configuration IndexedDB reste la référence (verrou au chargement)
    }
  }
}
