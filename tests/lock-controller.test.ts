import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalDb } from '../src/lib/db';
import {
  KV_LOCK_ATTEMPTS,
  KV_LOCK_CONFIG,
  hashPassphrase,
  lockFlagKey,
  type LockConfig,
  type PasskeyAssertion,
  type PasskeyAuthenticator,
} from '../src/lib/lock';
import { LockController, type LockDeps } from '../src/lib/lock.svelte';
import { createSimulatedAuthenticator } from '../src/lib/mock/passkey';
import type { LocalDb } from '../src/lib/types';

/* ------------------------------------------------------------------ */
/* Banc d'essai : navigateur simulé, horloge manuelle                  */
/* ------------------------------------------------------------------ */

const HOST = 'soreon.github.io';
const ORIGIN = `https://${HOST}`;
const PHRASE = 'mon chat Félix';
const ITERATIONS = 1000;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

let dbSeq = 0;

interface Bench {
  db: LocalDb;
  storage: ReturnType<typeof memoryStorage>;
  authenticator: PasskeyAuthenticator;
  doc: EventTarget;
  win: EventTarget;
  page: { visible: boolean; focused: boolean; hostname: string; origin: string };
  clock: { t: number };
  busy: { value: boolean };
  make(overrides?: Partial<LockDeps>): LockController;
  hide(): void;
  show(): void;
}

function bench(opts: { authenticator?: PasskeyAuthenticator; db?: LocalDb; storage?: ReturnType<typeof memoryStorage> } = {}): Bench {
  const page = { visible: true, focused: true, hostname: HOST, origin: ORIGIN };
  const doc = new EventTarget();
  const win = new EventTarget();
  const clock = { t: Date.UTC(2026, 9, 8, 12) };
  const busy = { value: false };
  const storage = opts.storage ?? memoryStorage();
  const db = opts.db ?? createLocalDb(`lock-test-${++dbSeq}-${Date.now()}`);
  const authenticator =
    opts.authenticator ??
    createSimulatedAuthenticator({ delayMs: 0, storage: memoryStorage(), origin: () => page.origin });
  const b: Bench = {
    db,
    storage,
    authenticator,
    doc,
    win,
    page,
    clock,
    busy,
    make(overrides = {}) {
      return new LockController({
        db,
        authenticator,
        storage,
        now: () => clock.t,
        iterations: ITERATIONS,
        isBusy: () => busy.value,
        env: {
          doc,
          win,
          visibilityState: () => (page.visible ? 'visible' : 'hidden'),
          hasFocus: () => page.focused,
          origin: () => page.origin,
          hostname: () => page.hostname,
        },
        ...overrides,
      });
    },
    hide() {
      page.visible = false;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    show() {
      page.visible = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
  return b;
}

/** Laisse passer les promesses en cours (IndexedDB simulée, WebCrypto). */
async function settle(lock: LockController): Promise<void> {
  for (let i = 0; i < 50 && (lock.passkeyPending || lock.passphrasePending); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 5));
}

/** Contrôleur démarré, verrou activé (empreinte + phrase), déverrouillé. */
async function enabledLock(
  b: Bench,
  withPasskey = true,
  overrides: Partial<LockDeps> = {},
): Promise<{ lock: LockController; stop: () => void }> {
  const lock = b.make(overrides);
  const stop = lock.start();
  await lock.load();
  const r = await lock.enable(PHRASE, PHRASE, withPasskey);
  expect(r).toEqual({ ok: true, withPasskey });
  return { lock, stop };
}

/**
 * Fenêtre système de l'empreinte qui reste ouverte : chaque `get()` attend `succeed()` (doigt
 * posé, assertion réelle de l'authentificateur simulé) ou `cancel()` (annulée).
 */
function holdGet(b: Bench) {
  const real = b.authenticator.get.bind(b.authenticator);
  const prompts: { succeed: () => void; cancel: () => void }[] = [];
  const spy = vi.spyOn(b.authenticator, 'get').mockImplementation(
    (o) =>
      new Promise<PasskeyAssertion>((resolve, reject) => {
        prompts.push({
          succeed: () => resolve(real(o)),
          cancel: () => reject(new DOMException('annulé', 'NotAllowedError')),
        });
      }),
  );
  const last = () => {
    const p = prompts.at(-1);
    if (!p) throw new Error('aucune demande d’empreinte');
    return p;
  };
  return { spy, last };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('LockController — activation et démarrage', () => {
  it('sans verrou : rien n’est verrouillé, ni avant ni après lecture', async () => {
    const b = bench();
    const lock = b.make();
    expect(lock.enabled).toBe(false);
    expect(lock.locked).toBe(false);
    await lock.load();
    expect(lock.loaded).toBe(true);
    expect(lock.enabled).toBe(false);
  });

  it('activation : clé d’accès + phrase enregistrées sur l’appareil, drapeau posé, reste ouverte', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    expect(lock.enabled).toBe(true);
    expect(lock.locked).toBe(false);
    expect(b.storage.getItem('dh.lock.enabled')).toBe('1');
    const stored = await b.db.getKv<LockConfig>(KV_LOCK_CONFIG);
    expect(stored).toMatchObject({ enabled: true, rpId: HOST, alg: -7, delaySec: 60 });
    expect(stored?.credentialId).toBeTruthy();
    expect(stored?.publicKeySpki).toBeTruthy();
    expect(stored?.passphrase.iterations).toBe(ITERATIONS);
    expect(lock.passkeyUsable).toBe(true);
    stop();
  });

  it('phrase invalide : rien n’est créé', async () => {
    const b = bench();
    const create = vi.spyOn(b.authenticator, 'create');
    const lock = b.make();
    const r = await lock.enable('abc', 'abc', true);
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect(create).not.toHaveBeenCalled();
    expect(await b.db.getKv(KV_LOCK_CONFIG)).toBeUndefined();
  });

  it('la création de la clé d’accès part avant toute attente (geste de l’utilisateur)', async () => {
    const b = bench();
    const create = vi.spyOn(b.authenticator, 'create');
    const lock = b.make();
    const pending = lock.enable(PHRASE, PHRASE, true);
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0]?.[0];
    expect(options?.rp.id).toBe(HOST);
    expect(options?.authenticatorSelection?.authenticatorAttachment).toBe('platform');
    expect((await pending).ok).toBe(true);
  });

  it('clé d’accès refusée → proposition de verrou par phrase seule', async () => {
    const b = bench();
    vi.spyOn(b.authenticator, 'create').mockRejectedValue(new DOMException('annulé', 'NotAllowedError'));
    const lock = b.make();
    const r = await lock.enable(PHRASE, PHRASE, true);
    expect(r).toMatchObject({ ok: false, reason: 'passkey' });
    expect(r.ok ? '' : r.message).toMatch(/annulée/);
    expect(lock.enabled).toBe(false);
    expect(b.storage.getItem('dh.lock.enabled')).toBeNull();

    const r2 = await lock.enable(PHRASE, PHRASE, false);
    expect(r2).toEqual({ ok: true, withPasskey: false });
    expect(lock.config?.credentialId).toBeUndefined();
    expect(lock.passkeyUsable).toBe(false);
  });

  it('démarrage à froid : verrouillée dès la construction (drapeau), avant de lire IndexedDB', async () => {
    const b = bench();
    const first = await enabledLock(b);
    first.stop();

    b.page.focused = false; // pas de lancement automatique de l'empreinte pour ce test
    const lock = b.make();
    expect(lock.locked).toBe(true);
    expect(lock.loaded).toBe(false);
    const stop = lock.start();
    await lock.load();
    expect(lock.locked).toBe(true);
    expect(lock.passkeyUsable).toBe(true);
    expect(await lock.unlockWithPasskey()).toBe(true);
    expect(lock.locked).toBe(false);
    stop();
  });

  it('démarrage à froid, page active : l’empreinte est proposée tout de suite', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    const get = vi.spyOn(b.authenticator, 'get');
    const lock = b.make();
    const stop = lock.start();
    await lock.load();
    expect(get).toHaveBeenCalledTimes(1);
    await settle(lock);
    expect(lock.locked).toBe(false);
    stop();
  });

  it('page sans focus : l’empreinte attend le focus, puis une seule fois', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    vi.spyOn(b.authenticator, 'get').mockRejectedValue(new DOMException('pas de geste', 'NotAllowedError'));
    b.page.focused = false;
    const lock = b.make();
    const stop = lock.start();
    await lock.load();
    expect(b.authenticator.get).not.toHaveBeenCalled();
    b.page.focused = true;
    b.win.dispatchEvent(new Event('focus'));
    await settle(lock);
    expect(b.authenticator.get).toHaveBeenCalledTimes(1);
    // Échec du lancement automatique : silencieux, le bouton reste
    expect(lock.unlockError).toBeNull();
    expect(lock.locked).toBe(true);
    b.win.dispatchEvent(new Event('focus'));
    await settle(lock);
    expect(b.authenticator.get).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drapeau orphelin (configuration absente) : déverrouillée et drapeau retiré', async () => {
    const b = bench();
    b.storage.setItem('dh.lock.enabled', '1');
    const lock = b.make();
    expect(lock.locked).toBe(true);
    await lock.load();
    expect(lock.locked).toBe(false);
    expect(lock.enabled).toBe(false);
    expect(b.storage.getItem('dh.lock.enabled')).toBeNull();
  });

  it('drapeau perdu mais configuration présente : verrouillée à la lecture, drapeau rétabli', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    b.storage.removeItem('dh.lock.enabled');
    b.page.focused = false;
    const lock = b.make();
    expect(lock.locked).toBe(false);
    await lock.load();
    expect(lock.locked).toBe(true);
    expect(b.storage.getItem('dh.lock.enabled')).toBe('1');
  });

  it('lecture impossible avec le drapeau posé : reste verrouillée, erreur affichable', async () => {
    const b = bench();
    b.storage.setItem('dh.lock.enabled', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(b.db, 'getKv').mockRejectedValue(new Error('IDB cassée'));
    const lock = b.make();
    await lock.load();
    expect(lock.locked).toBe(true);
    expect(lock.loadError).toMatch(/n’a pas pu être lu/);
  });
});

describe('LockController — déverrouillage', () => {
  it('phrase de secours : 5 essais libres, puis 30 s d’attente qui doublent ; essais conservés', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    lock.lock();
    expect(lock.locked).toBe(true);

    for (let i = 1; i <= 4; i++) {
      expect(await lock.unlockWithPassphrase('pas la bonne')).toBe(false);
      expect(lock.unlockError).toMatch(/incorrecte/);
    }
    expect(lock.unlockError).toMatch(/Encore un essai/);
    expect(await lock.unlockWithPassphrase('toujours pas')).toBe(false);
    // L'attente est affichée par l'écran (compte à rebours), pas figée dans le message
    expect(lock.unlockError).toBe('Phrase de secours incorrecte.');
    expect(lock.waitMs()).toBe(30_000);

    // Pendant l'attente, même la bonne phrase est refusée (sans calcul)
    expect(await lock.unlockWithPassphrase(PHRASE)).toBe(false);
    expect(lock.unlockError).toMatch(/Trop d’essais/);

    // Redémarrage : l'attente est toujours là
    const again = b.make();
    await again.load();
    expect(again.attempts.failures).toBe(5);
    expect(again.waitMs()).toBe(30_000);

    b.clock.t += 30_000;
    expect(await lock.unlockWithPassphrase('encore faux')).toBe(false);
    expect(lock.waitMs()).toBe(60_000);
    b.clock.t += 60_000;
    expect(await lock.unlockWithPassphrase(` ${PHRASE} `)).toBe(true);
    expect(lock.locked).toBe(false);
    expect(lock.attempts).toEqual({ failures: 0, retryAt: 0 });
    expect(await b.db.getKv(KV_LOCK_ATTEMPTS)).toBeUndefined();
    stop();
  });

  it('empreinte refusée (assertion d’une autre origine) : reste verrouillée', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    lock.lock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = b.authenticator.get.bind(b.authenticator);
    vi.spyOn(b.authenticator, 'get').mockImplementation(async (o) => {
      const a = await real(o);
      const client = JSON.parse(new TextDecoder().decode(a.clientDataJSON)) as Record<string, unknown>;
      return { ...a, clientDataJSON: new TextEncoder().encode(JSON.stringify({ ...client, origin: 'https://autre.github.io' })) };
    });
    expect(await lock.unlockWithPasskey()).toBe(false);
    expect(lock.locked).toBe(true);
    expect(lock.unlockError).toMatch(/refusée/);
    expect(warn).toHaveBeenCalledWith('[verrou] assertion refusée :', 'origin');
    stop();
  });

  it('deux phrases fausses de suite : le message est retiré pendant le calcul (annoncé de nouveau)', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    lock.lock();
    expect(await lock.unlockWithPassphrase('pas la bonne')).toBe(false);
    expect(lock.unlockError).toBe('Phrase de secours incorrecte.');
    const second = lock.unlockWithPassphrase('toujours pas');
    expect(lock.unlockError).toBeNull();
    expect(await second).toBe(false);
    expect(lock.unlockError).toBe('Phrase de secours incorrecte.');
    stop();
  });

  it('onUnlock : appelé quand l’écran de verrouillage disparaît, pas avant', async () => {
    const b = bench();
    const onUnlock = vi.fn();
    const { lock, stop } = await enabledLock(b, true, { onUnlock });
    expect(onUnlock).not.toHaveBeenCalled();
    lock.lock();
    expect(await lock.unlockWithPassphrase('pas la bonne')).toBe(false);
    expect(onUnlock).not.toHaveBeenCalled();
    expect(await lock.unlockWithPasskey()).toBe(true);
    expect(onUnlock).toHaveBeenCalledTimes(1);
    lock.lock();
    lock.reset();
    expect(onUnlock).toHaveBeenCalledTimes(2);
    stop();
  });

  it('empreinte annulée : message, bouton de nouveau utilisable', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    lock.lock();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(b.authenticator, 'get').mockRejectedValueOnce(new DOMException('annulé', 'NotAllowedError'));
    expect(await lock.unlockWithPasskey()).toBe(false);
    expect(lock.unlockError).toMatch(/phrase de secours/);
    expect(lock.passkeyPending).toBe(false);
    expect(await lock.unlockWithPasskey()).toBe(true);
    stop();
  });

  it('clé d’accès d’un autre domaine (ex. développement local) : phrase seule', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    b.page.hostname = 'localhost';
    const lock = b.make();
    await lock.load();
    expect(lock.rpMismatch).toBe(true);
    expect(lock.passkeyUsable).toBe(false);
    expect(await lock.unlockWithPasskey()).toBe(false);
    expect(await lock.unlockWithPassphrase(PHRASE)).toBe(true);
  });
});

describe('LockController — verrouillage automatique', () => {
  it('retour avant le délai : ouverte ; après : verrouillée', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    b.page.focused = false;
    b.hide();
    b.clock.t += 59_000;
    b.show();
    expect(lock.locked).toBe(false);
    b.hide();
    b.clock.t += 60_000;
    b.show();
    expect(lock.locked).toBe(true);
    stop();
  });

  it('page restaurée depuis le cache avant/arrière : même règle qu’un retour', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    b.page.focused = false;
    b.page.visible = false;
    b.doc.dispatchEvent(new Event('visibilitychange'));
    b.clock.t += 2 * 60_000;
    b.page.visible = true;
    b.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(lock.locked).toBe(false);
    b.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(lock.locked).toBe(true);
    stop();
  });

  it('délai « Immédiat » : verrouillée dès que l’appli passe en arrière-plan', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    expect((await lock.setDelay(0)).ok).toBe(true);
    expect((await b.db.getKv<LockConfig>(KV_LOCK_CONFIG))?.delaySec).toBe(0);
    b.hide();
    expect(lock.locked).toBe(true);
    expect((await lock.setDelay(42)).ok).toBe(false);
    stop();
  });

  it('retour au premier plan verrouillée : l’empreinte est proposée automatiquement', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    const get = vi.spyOn(b.authenticator, 'get');
    lock.lock(); // « Verrouiller maintenant » : pas de lancement automatique
    expect(get).not.toHaveBeenCalled();
    b.hide();
    b.show();
    expect(get).toHaveBeenCalledTimes(1);
    await settle(lock);
    expect(lock.locked).toBe(false);
    stop();
  });

  it('la fenêtre système de l’empreinte (code du téléphone en plein écran) ne déclenche pas le verrou', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    await lock.setDelay(0);
    const held = holdGet(b);
    const pending = lock.verifyWithPasskey();
    b.hide();
    expect(lock.locked).toBe(false);
    b.clock.t += 20_000;
    b.show();
    expect(lock.locked).toBe(false);
    held.last().succeed();
    expect((await pending).ok).toBe(true);
    expect(lock.verified).toBe(true);
    stop();
  });

  it('empreinte vérifiée alors que la page est encore cachée : pas de verrou au retour', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    await lock.setDelay(0);
    const held = holdGet(b);
    const pending = lock.verifyWithPasskey();
    b.hide();
    held.last().succeed();
    expect((await pending).ok).toBe(true);
    expect(lock.locked).toBe(false);
    b.clock.t += 5_000;
    b.show();
    expect(lock.locked).toBe(false);
    expect(lock.verified).toBe(true);
    stop();
  });

  it('appli quittée pendant la demande d’empreinte (Immédiat) : verrouillée, et encore au retour', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    await lock.setDelay(0);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const held = holdGet(b);
    const pending = lock.verifyWithPasskey();
    b.hide(); // Accueil, appel, écran éteint…
    expect(lock.locked).toBe(false); // peut-être la fenêtre système : on attend
    held.last().cancel(); // la demande tombe, la page est toujours cachée
    expect((await pending).ok).toBe(false);
    expect(lock.locked).toBe(true);
    b.page.focused = false;
    b.clock.t += 2 * 3_600_000;
    b.show();
    expect(lock.locked).toBe(true);
    stop();
  });

  it('appli quittée pendant la demande d’empreinte (1 minute) : l’absence compte au retour', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const held = holdGet(b);
    const pending = lock.verifyWithPasskey();
    b.hide();
    held.last().cancel();
    expect((await pending).ok).toBe(false);
    expect(lock.locked).toBe(false);
    b.page.focused = false;
    b.clock.t += 2 * 3_600_000;
    b.show();
    expect(lock.locked).toBe(true);
    stop();
  });

  it('demande d’empreinte restée en suspens : une longue absence verrouille quand même', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    const held = holdGet(b);
    const pending = lock.verifyWithPasskey();
    b.hide();
    b.page.focused = false;
    b.clock.t += 10 * 60_000;
    b.show();
    expect(lock.locked).toBe(true);
    // La demande aboutit après le verrouillage : la confirmation ne vaut plus
    held.last().succeed();
    expect(await pending).toEqual({ ok: false });
    expect(lock.verified).toBe(false);
    expect(lock.locked).toBe(true);
    stop();
  });

  it('demande annulée après le code du téléphone (page cachée puis revenue) : pas rouverte d’elle-même', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    lock.lock();
    const held = holdGet(b);
    const pending = lock.unlockWithPasskey(); // bouton « Déverrouiller »
    b.hide();
    b.show();
    held.last().cancel();
    expect(await pending).toBe(false);
    b.win.dispatchEvent(new Event('focus'));
    expect(held.spy).toHaveBeenCalledTimes(1);

    // Variante : l'annulation arrive avant le retour de la page
    const again = lock.unlockWithPasskey();
    b.hide();
    held.last().cancel();
    expect(await again).toBe(false);
    b.show();
    b.win.dispatchEvent(new Event('focus'));
    expect(held.spy).toHaveBeenCalledTimes(2);
    expect(lock.locked).toBe(true);
    stop();
  });

  it('après un déverrouillage, « Verrouiller maintenant » ne relance pas l’empreinte au focus', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    const held = holdGet(b);
    const lock = b.make();
    const stop = lock.start();
    await lock.load(); // démarrage à froid : lancement automatique
    expect(held.spy).toHaveBeenCalledTimes(1);
    b.hide(); // fenêtre système pendant la demande
    b.show();
    held.last().succeed();
    await settle(lock);
    expect(lock.locked).toBe(false);
    lock.lock();
    b.win.dispatchEvent(new Event('focus'));
    expect(held.spy).toHaveBeenCalledTimes(1);
    expect(lock.locked).toBe(true);
    stop();
  });

  it('demande faite au bouton avant le focus : pas de seconde demande automatique ensuite', async () => {
    const b = bench();
    (await enabledLock(b)).stop();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const held = holdGet(b);
    b.page.focused = false;
    const lock = b.make();
    const stop = lock.start();
    await lock.load();
    expect(held.spy).not.toHaveBeenCalled();
    const pending = lock.unlockWithPasskey();
    held.last().cancel();
    expect(await pending).toBe(false);
    b.page.focused = true;
    b.win.dispatchEvent(new Event('focus'));
    expect(held.spy).toHaveBeenCalledTimes(1);
    stop();
  });

  it('inactivité : 5 min sans toucher l’écran → verrouillée, sauf pendant un enregistrement', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    b.page.focused = false;

    b.clock.t += 4 * 60_000;
    b.win.dispatchEvent(new Event('pointerdown'));
    b.clock.t += 4 * 60_000;
    vi.advanceTimersByTime(15_000);
    expect(lock.locked).toBe(false);

    b.busy.value = true;
    b.clock.t += 20 * 60_000;
    vi.advanceTimersByTime(15_000);
    expect(lock.locked).toBe(false);

    // Fin de l'enregistrement : le compte repart de la dernière vérification
    b.busy.value = false;
    b.clock.t += 4 * 60_000;
    vi.advanceTimersByTime(15_000);
    expect(lock.locked).toBe(false);
    b.clock.t += 60_000;
    vi.advanceTimersByTime(15_000);
    expect(lock.locked).toBe(true);
    stop();
  });
});

describe('LockController — actions protégées', () => {
  it('désactiver exige une vérification ; la clé d’accès est oubliée, le drapeau retiré', async () => {
    const b = bench();
    const forget = vi.spyOn(b.authenticator, 'forget');
    const { lock, stop } = await enabledLock(b);
    const credentialId = lock.config?.credentialId;

    expect(await lock.disable()).toMatchObject({ ok: false });
    expect(lock.enabled).toBe(true);

    expect((await lock.verifyWithPassphrase('fausse')).ok).toBe(false);
    expect((await lock.verifyWithPassphrase(PHRASE)).ok).toBe(true);
    expect(await lock.disable()).toEqual({ ok: true });
    expect(lock.enabled).toBe(false);
    expect(b.storage.getItem('dh.lock.enabled')).toBeNull();
    expect(await b.db.getKv(KV_LOCK_CONFIG)).toBeUndefined();
    expect(forget).toHaveBeenCalledWith(HOST, credentialId);
    stop();
  });

  it('la vérification expire au bout de 2 minutes, et au verrouillage', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    expect((await lock.verifyWithPasskey()).ok).toBe(true);
    expect(lock.verified).toBe(true);
    b.clock.t += 2 * 60_000;
    expect(lock.verified).toBe(false);
    expect((await lock.verifyWithPasskey()).ok).toBe(true);
    lock.lock();
    expect(lock.verified).toBe(false);
    stop();
  });

  it('verrouillée pendant une vérification : elle ne vaut plus, « désactiver » ne déverrouille pas', async () => {
    const b = bench();
    const forget = vi.spyOn(b.authenticator, 'forget');
    const { lock, stop } = await enabledLock(b);
    const pending = lock.verifyWithPassphrase(PHRASE); // PBKDF2 en cours…
    lock.lock(); // …et l'appli se verrouille (écran éteint, inactivité)
    expect(await pending).toEqual({ ok: false });
    expect(lock.verified).toBe(false);
    expect(await lock.disable()).toMatchObject({ ok: false });
    expect(lock.locked).toBe(true);
    expect(lock.enabled).toBe(true);
    expect(await b.db.getKv(KV_LOCK_CONFIG)).toBeDefined();
    expect(forget).not.toHaveBeenCalled();
    // Depuis l'écran de verrouillage, une vérification des réglages ne sert à rien
    expect(await lock.verifyWithPassphrase(PHRASE)).toEqual({ ok: false });
    expect(lock.verified).toBe(false);
    stop();
  });

  it('verrouillée pendant le changement de phrase ou d’empreinte : rien n’est enregistré', async () => {
    const b = bench();
    const forget = vi.spyOn(b.authenticator, 'forget');
    const { lock, stop } = await enabledLock(b);
    const credentialId = lock.config?.credentialId;

    expect((await lock.verifyWithPassphrase(PHRASE)).ok).toBe(true);
    const change = lock.changePassphrase('nouvelle phrase', 'nouvelle phrase');
    lock.lock();
    expect(await change).toEqual({ ok: false });
    expect(await lock.unlockWithPassphrase(PHRASE)).toBe(true);

    expect((await lock.verifyWithPassphrase(PHRASE)).ok).toBe(true);
    const reenroll = lock.reenrollPasskey();
    lock.lock();
    expect(await reenroll).toEqual({ ok: false });
    expect(lock.config?.credentialId).toBe(credentialId);
    // La clé créée pour rien est signalée, pas l'ancienne
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget.mock.calls[0]?.[1]).not.toBe(credentialId);
    expect(await lock.unlockWithPasskey()).toBe(true);
    stop();
  });

  it('changer la phrase de secours', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b);
    expect(await lock.changePassphrase('nouvelle phrase', 'nouvelle phrase')).toMatchObject({ ok: false });
    await lock.verifyWithPasskey();
    expect(await lock.changePassphrase('court', 'court')).toMatchObject({ ok: false });
    expect(await lock.changePassphrase('nouvelle phrase', 'nouvelle phrase')).toEqual({ ok: true });
    lock.lock();
    expect(await lock.unlockWithPassphrase(PHRASE)).toBe(false);
    expect(await lock.unlockWithPassphrase('nouvelle phrase')).toBe(true);
    stop();
  });

  it('réenregistrer l’empreinte : nouvelle clé utilisable, l’ancienne signalée', async () => {
    const b = bench();
    const forget = vi.spyOn(b.authenticator, 'forget');
    const { lock, stop } = await enabledLock(b);
    const old = lock.config?.credentialId;
    expect(await lock.reenrollPasskey()).toMatchObject({ ok: false });
    await lock.verifyWithPassphrase(PHRASE);
    expect(await lock.reenrollPasskey()).toEqual({ ok: true });
    expect(lock.config?.credentialId).not.toBe(old);
    expect(forget).toHaveBeenCalledWith(HOST, old);
    lock.lock();
    expect(await lock.unlockWithPasskey()).toBe(true);
    stop();
  });

  it('verrou par phrase seule → ajouter l’empreinte', async () => {
    const b = bench();
    const { lock, stop } = await enabledLock(b, false);
    expect(lock.passkeyUsable).toBe(false);
    await lock.verifyWithPassphrase(PHRASE);
    expect(await lock.reenrollPasskey()).toEqual({ ok: true });
    expect(lock.passkeyUsable).toBe(true);
    stop();
  });

  it('effacement des données de l’appareil : verrou levé, clé d’accès signalée comme inutile', async () => {
    const b = bench();
    const forget = vi.spyOn(b.authenticator, 'forget');
    const { lock, stop } = await enabledLock(b);
    const credentialId = lock.config?.credentialId;
    lock.lock();
    lock.forgetAndReset();
    expect(lock.locked).toBe(false);
    expect(lock.enabled).toBe(false);
    expect(b.storage.getItem('dh.lock.enabled')).toBeNull();
    expect(forget).toHaveBeenCalledWith(HOST, credentialId);
    stop();
  });
});

describe('db.clearAll et le drapeau du verrou', () => {
  it('efface le drapeau propre à la base, pas celui d’une autre', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const name = `lock-clear-${Date.now()}`;
    const db = createLocalDb(name);
    await db.setKv(KV_LOCK_CONFIG, { enabled: true, passphrase: await hashPassphrase(PHRASE, { iterations: 10 }) });
    storage.setItem(lockFlagKey(name), '1');
    storage.setItem('dh.lock.enabled', '1');
    await db.clearAll();
    expect(await db.getKv(KV_LOCK_CONFIG)).toBeUndefined();
    expect(storage.getItem(lockFlagKey(name))).toBeNull();
    expect(storage.getItem('dh.lock.enabled')).toBe('1');
  });
});
