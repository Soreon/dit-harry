import type { AuthService, AuthState } from '../types';
import { config } from '../../config';

/** Compte de démonstration. */
export const MOCK_EMAIL = 'demo@exemple.fr';
export const MOCK_NAME = 'Démo';
export const MOCK_TOKEN = 'mock-token';

/** Clé localStorage propre au mode démo (distincte des clés `dh.auth.*` du vrai mode). */
const STORAGE_KEY = 'dh.mock.auth';
/** Durée de vie simulée d'un jeton (comme Google : 1 h). */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

type PersistedStatus = 'signed-in' | 'expired';

/** Sous-ensemble de `Storage` utilisé (injectable pour les tests). */
export type MockAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage si disponible, sinon stockage en mémoire (Node, navigation privée stricte…). */
function defaultStorage(): MockAuthStorage {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__dh_mock_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // stockage indisponible : repli en mémoire
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}

/**
 * Authentification simulée : connexion en ~300 ms, compte `demo@exemple.fr`.
 * L'état « connecté » survit au rechargement (localStorage), comme l'email mémorisé du vrai mode.
 */
export function createMockAuth(
  opts: { storage?: MockAuthStorage; signInDelayMs?: number; now?: () => number } = {},
): AuthService {
  const storage = opts.storage ?? defaultStorage();
  const signInDelayMs = opts.signInDelayMs ?? 300;
  const now = opts.now ?? (() => Date.now());

  let state: AuthState = { status: 'loading' };
  const listeners = new Set<(s: AuthState) => void>();

  function setState(next: AuthState): void {
    state = next;
    for (const cb of [...listeners]) cb(state);
  }

  function readPersisted(): PersistedStatus | null {
    try {
      const v = storage.getItem(STORAGE_KEY);
      return v === 'signed-in' || v === 'expired' ? v : null;
    } catch {
      return null;
    }
  }

  function persist(v: PersistedStatus | null): void {
    try {
      if (v) storage.setItem(STORAGE_KEY, v);
      else storage.removeItem(STORAGE_KEY);
    } catch {
      // sans importance en démo
    }
  }

  function signedIn(): AuthState {
    return {
      status: 'signed-in',
      email: MOCK_EMAIL,
      name: MOCK_NAME,
      expiresAt: now() + TOKEN_LIFETIME_MS,
    };
  }

  return {
    async init() {
      const persisted = readPersisted();
      if (persisted === 'signed-in') setState(signedIn());
      else if (persisted === 'expired') setState({ status: 'expired', email: MOCK_EMAIL, name: MOCK_NAME });
      else setState({ status: 'signed-out' });
    },

    getState() {
      return state;
    },

    subscribe(cb) {
      listeners.add(cb);
      cb(state);
      return () => {
        listeners.delete(cb);
      };
    },

    signIn() {
      // Comme le vrai : l'état passe à « signing-in » dans le même tick que le clic.
      setState({ status: 'signing-in', email: state.email, name: state.name });
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          persist('signed-in');
          setState(signedIn());
          resolve();
        }, signInDelayMs);
      });
    },

    getToken() {
      if (state.status !== 'signed-in') return null;
      if (state.expiresAt !== undefined && now() > state.expiresAt - config.tokenExpiryMarginMs) {
        persist('expired');
        setState({ status: 'expired', email: MOCK_EMAIL, name: MOCK_NAME });
        return null;
      }
      return MOCK_TOKEN;
    },

    markExpired() {
      if (state.status === 'signed-in') {
        persist('expired');
        setState({ status: 'expired', email: MOCK_EMAIL, name: MOCK_NAME });
      }
    },

    async signOut() {
      persist(null);
      setState({ status: 'signed-out' });
    },
  };
}
