import { config } from '../config';
import { AppError, isAppError } from './errors';
import type { AuthService, AuthState } from './types';

/* ------------------------------------------------------------------ */
/* Types minimaux de Google Identity Services (sans dépendance @types)  */
/* Voir docs/api-notes.md §2.                                          */
/* ------------------------------------------------------------------ */

export interface GisTokenResponse {
  access_token?: string;
  /** Secondes (≈ 3599) — parfois une chaîne : toujours passer par Number(). */
  expires_in?: number | string;
  /** Scopes accordés, séparés par des espaces. */
  scope?: string;
  token_type?: string;
  prompt?: string;
  hd?: string;
  state?: string;
  /** Erreur OAuth, ex. 'access_denied'. */
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/** Erreur « non OAuth » (popup fermée, bloquée…). */
export interface GisNonOAuthError {
  type: string;
  message?: string;
}

export interface GisOverridableConfig {
  scope?: string;
  include_granted_scopes?: boolean;
  prompt?: string;
  login_hint?: string;
  state?: string;
}

export interface GisTokenClientConfig extends GisOverridableConfig {
  client_id: string;
  scope: string;
  callback: (r: GisTokenResponse) => void;
  error_callback?: (e: GisNonOAuthError) => void;
}

export interface GisTokenClient {
  requestAccessToken(overrideConfig?: GisOverridableConfig): void;
}

export interface GisOAuth2 {
  initTokenClient(config: GisTokenClientConfig): GisTokenClient;
  hasGrantedAllScopes(r: GisTokenResponse, firstScope: string, ...restScopes: string[]): boolean;
  revoke(
    accessToken: string,
    done?: (r: { successful: boolean; error?: string; error_description?: string }) => void,
  ): void;
}

/** Sous-ensemble de `Storage` utilisé (injectable pour les tests). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Dépendances injectables (tests sous Node) ; toutes facultatives. */
export interface GoogleAuthDeps {
  /** Charge GIS et renvoie `google.accounts.oauth2`. Défaut : balise <script> dynamique. */
  loadGis?: () => Promise<GisOAuth2>;
  /** Stockage du compte (email, nom). Défaut : localStorage. */
  local?: KeyValueStorage;
  /** Stockage du jeton. Défaut : sessionStorage. */
  session?: KeyValueStorage;
  /** Horloge (epoch ms). */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Délai max. de chargement du script GIS (ms). */
  loadTimeoutMs?: number;
  /** Filet de sécurité si GIS ne rappelle jamais après l'ouverture de la popup (ms). */
  signInTimeoutMs?: number;
  /** Délai max. d'attente de la révocation à la déconnexion (ms). */
  revokeTimeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const LS_EMAIL = 'dh.auth.email';
const LS_NAME = 'dh.auth.name';
const SS_TOKEN = 'dh.auth.token';

/** Durée de vie supposée si Google n'indique pas `expires_in` (s). */
const DEFAULT_EXPIRES_IN_SEC = 3600;

const MSG_NO_CLIENT_ID = 'Identifiant client Google manquant (VITE_GOOGLE_CLIENT_ID).';
const MSG_GIS_UNAVAILABLE =
  "Le service de connexion Google n'a pas pu être chargé. Vérifie ta connexion Internet, puis réessaie.";
const MSG_GIS_LOADING = 'Le service de connexion Google est en cours de chargement. Réessaie dans un instant.';
const MSG_GIS_INIT = "La connexion Google n'a pas pu être initialisée. Recharge la page, puis réessaie.";
const MSG_POPUP_BLOCKED =
  "La fenêtre de connexion Google n'a pas pu s'ouvrir. Autorise les fenêtres pop-up pour ce site, puis réessaie.";
const MSG_POPUP_CLOSED = 'Connexion annulée : la fenêtre Google a été fermée.';
const MSG_SIGNIN_FAILED = 'La connexion à Google a échoué. Réessaie.';
const MSG_SIGNIN_TIMEOUT = "La connexion à Google n'a pas abouti. Réessaie.";
const MSG_ACCESS_DENIED =
  "Tu as refusé l'accès à Google Drive. Dit Harry en a besoin pour sauvegarder ton journal.";
const MSG_MISSING_SCOPES =
  "Il faut cocher les deux autorisations Google Drive (le dossier caché de l'appli et le dossier « Dit Harry »). Reconnecte-toi et coche les deux cases.";
const MSG_TOKEN_REJECTED = 'Google a refusé le jeton de connexion. Réessaie.';

/* ------------------------------------------------------------------ */
/* Chargement du script GIS                                            */
/* ------------------------------------------------------------------ */

function readGis(): GisOAuth2 | undefined {
  const g = (globalThis as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google;
  return g?.accounts?.oauth2;
}

/** Chargement en cours (partagé : une seule balise <script> à la fois). */
let gisScriptLoad: Promise<void> | null = null;

/** Insère `<script src=".../gsi/client" async defer>` et attend `onload`. */
function loadGisScript(): Promise<GisOAuth2> {
  const ready = readGis();
  if (ready) return Promise.resolve(ready);
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('document indisponible : impossible de charger GIS'));
  }
  gisScriptLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      // Retirer la balise pour qu'un nouvel essai en crée une neuve
      s.remove();
      gisScriptLoad = null;
      reject(new Error('Échec du chargement de ' + GIS_SRC));
    };
    document.head.appendChild(s);
  });
  return gisScriptLoad.then(() => {
    const g = readGis();
    if (!g) {
      gisScriptLoad = null;
      throw new Error('GIS chargé mais google.accounts.oauth2 absent');
    }
    return g;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Délai dépassé (${ms} ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

function memoryStorage(): KeyValueStorage {
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}

/** localStorage / sessionStorage s'ils sont accessibles, sinon stockage en mémoire. */
function browserStorage(kind: 'localStorage' | 'sessionStorage'): KeyValueStorage {
  try {
    const s = (globalThis as Partial<Record<typeof kind, Storage>>)[kind];
    if (s) return s;
  } catch {
    // accès refusé (cookies bloqués…) : repli en mémoire
  }
  return memoryStorage();
}

function safeGet(s: KeyValueStorage, key: string): string | null {
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(s: KeyValueStorage, key: string, value: string | null | undefined): void {
  try {
    if (value) s.setItem(key, value);
    else s.removeItem(key);
  } catch {
    // stockage plein ou interdit : sans conséquence (l'état reste en mémoire)
  }
}

interface StoredToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

function parseStoredToken(raw: string | null): StoredToken | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') {
      const { token, expiresAt } = v as Record<string, unknown>;
      if (typeof token === 'string' && token && typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
        return { token, expiresAt };
      }
    }
  } catch {
    // JSON corrompu : ignoré
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

interface Waiter {
  resolve: () => void;
  reject: (e: AppError) => void;
}

/**
 * Authentification Google (GIS, « token model », sans backend donc sans refresh token).
 * Le 2e paramètre est réservé aux tests (injection des globales du navigateur).
 */
export function createGoogleAuth(
  opts: { clientId: string; scopes: readonly string[] },
  deps: GoogleAuthDeps = {},
): AuthService {
  const clientId = opts.clientId.trim();
  const scopes = [...opts.scopes];
  const local = deps.local ?? browserStorage('localStorage');
  const session = deps.session ?? browserStorage('sessionStorage');
  const now = deps.now ?? (() => Date.now());
  const doFetch: typeof fetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const loadGis = deps.loadGis ?? loadGisScript;
  const loadTimeoutMs = deps.loadTimeoutMs ?? 20_000;
  const signInTimeoutMs = deps.signInTimeoutMs ?? 5 * 60_000;
  const revokeTimeoutMs = deps.revokeTimeoutMs ?? 5_000;

  let gis: GisOAuth2 | null = null;
  let client: GisTokenClient | null = null;
  let initPromise: Promise<void> | null = null;
  /** Promesses `signIn()` en attente de la réponse GIS (le callback n'est pas surchargeable). */
  let waiters: Waiter[] = [];
  /** Une popup a été demandée et GIS n'a pas encore répondu. */
  let popupOpen = false;
  let popupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Après un consentement incomplet : redemander explicitement le consentement. */
  let forceConsent = false;
  const listeners = new Set<(s: AuthState) => void>();

  let account: { email?: string; name?: string } = readAccount();
  // Jeton restauré dès la création : utilisable pendant le chargement de GIS (hors ligne compris)
  let token: StoredToken | null = restoreToken();

  let state: AuthState = clientId
    ? withAccount({ status: 'loading' })
    : { status: 'error', error: MSG_NO_CLIENT_ID };

  /* --- État ---------------------------------------------------------- */

  function readAccount(): { email?: string; name?: string } {
    const out: { email?: string; name?: string } = {};
    const email = safeGet(local, LS_EMAIL);
    const name = safeGet(local, LS_NAME);
    if (email) out.email = email;
    if (name) out.name = name;
    return out;
  }

  function persistAccount(): void {
    safeSet(local, LS_EMAIL, account.email);
    safeSet(local, LS_NAME, account.name);
  }

  function restoreToken(): StoredToken | null {
    const t = parseStoredToken(safeGet(session, SS_TOKEN));
    if (t && !isExpired(t)) return t;
    if (t) safeSet(session, SS_TOKEN, null);
    return null;
  }

  function isExpired(t: StoredToken): boolean {
    return now() > t.expiresAt - config.tokenExpiryMarginMs;
  }

  function dropToken(): void {
    token = null;
    safeSet(session, SS_TOKEN, null);
  }

  function withAccount(s: AuthState): AuthState {
    const out: AuthState = { ...s };
    if (account.email) out.email = account.email;
    if (account.name) out.name = account.name;
    return out;
  }

  /** État « au repos » : jeton valide → connecté ; compte connu → expiré ; sinon déconnecté. */
  function restingState(): AuthState {
    if (token && !isExpired(token)) return withAccount({ status: 'signed-in', expiresAt: token.expiresAt });
    if (account.email) return withAccount({ status: 'expired' });
    return { status: 'signed-out' };
  }

  function setState(next: AuthState): void {
    state = next;
    for (const cb of [...listeners]) {
      try {
        cb(state);
      } catch (e) {
        console.error('[auth] abonné', e);
      }
    }
  }

  /* --- Attente de la popup ------------------------------------------- */

  function clearPopupTimer(): void {
    if (popupTimer !== null) {
      clearTimeout(popupTimer);
      popupTimer = null;
    }
  }

  function resolveAll(): void {
    const list = waiters;
    waiters = [];
    for (const w of list) w.resolve();
  }

  function rejectAll(err: AppError): void {
    const list = waiters;
    waiters = [];
    for (const w of list) w.reject(err);
  }

  /**
   * Échec de connexion : rejette les `signIn()` en attente.
   * `asError` → état 'error' avec le message (sauf si un jeton valide existe encore) ;
   * sinon → état au repos (expiré si compte connu, sinon déconnecté).
   */
  function failSignIn(message: string, asError: boolean): void {
    const rest = restingState();
    setState(asError && rest.status !== 'signed-in' ? withAccount({ status: 'error', error: message }) : rest);
    rejectAll(new AppError('auth', message));
  }

  /* --- Réponses GIS -------------------------------------------------- */

  async function onTokenResponse(lib: GisOAuth2, r: GisTokenResponse): Promise<void> {
    // Toujours traité, même après un `popup_closed` (docs/api-notes.md §2.7)
    popupOpen = false;
    clearPopupTimer();

    if (r.error) {
      failSignIn(r.error === 'access_denied' ? MSG_ACCESS_DENIED : MSG_SIGNIN_FAILED, true);
      return;
    }
    const [firstScope, ...restScopes] = scopes;
    if (firstScope !== undefined && !lib.hasGrantedAllScopes(r, firstScope, ...restScopes)) {
      // Consentement granulaire : une case n'a pas été cochée
      forceConsent = true;
      failSignIn(MSG_MISSING_SCOPES, true);
      return;
    }
    const accessToken = r.access_token;
    if (!accessToken) {
      failSignIn(MSG_SIGNIN_FAILED, true);
      return;
    }
    const expiresIn = Number(r.expires_in);
    const expiresAt =
      now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_SEC) * 1000;

    // Pas d'openid : email et nom viennent de Drive (about.get)
    try {
      const user = await fetchUser(accessToken);
      if (user.email && user.email !== account.email) {
        account = { email: user.email };
        if (user.name) account.name = user.name;
      } else if (user.name) {
        account = { ...account, name: user.name };
      }
      persistAccount();
    } catch (e) {
      if (isAppError(e) && e.kind === 'auth') {
        failSignIn(MSG_TOKEN_REJECTED, true);
        return;
      }
      // Erreur réseau passagère : le jeton reste valable, on garde le compte mémorisé
      console.warn('[auth] about', e);
    }

    token = { token: accessToken, expiresAt };
    safeSet(session, SS_TOKEN, JSON.stringify(token));
    forceConsent = false;
    setState(withAccount({ status: 'signed-in', expiresAt }));
    resolveAll();
  }

  function onPopupError(e: GisNonOAuthError): void {
    // Erreur tardive (après une réponse) : ignorée
    if (!popupOpen) return;
    popupOpen = false;
    clearPopupTimer();
    const message =
      e.type === 'popup_failed_to_open'
        ? MSG_POPUP_BLOCKED
        : e.type === 'popup_closed'
          ? MSG_POPUP_CLOSED
          : MSG_SIGNIN_FAILED;
    failSignIn(message, false);
  }

  async function fetchUser(accessToken: string): Promise<{ email: string; name: string }> {
    const res = await doFetch(ABOUT_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 401 || res.status === 403) {
      throw new AppError('auth', MSG_TOKEN_REJECTED, { status: res.status });
    }
    if (!res.ok) {
      throw new AppError('network', `Google Drive indisponible (erreur ${res.status}).`, { status: res.status });
    }
    const data = (await res.json()) as { user?: { emailAddress?: unknown; displayName?: unknown } } | null;
    const email = data?.user?.emailAddress;
    const name = data?.user?.displayName;
    return {
      email: typeof email === 'string' ? email : '',
      name: typeof name === 'string' ? name : '',
    };
  }

  /* --- Initialisation ------------------------------------------------- */

  async function doInit(): Promise<void> {
    if (state.status !== 'loading') setState(withAccount({ status: 'loading' }));
    let lib: GisOAuth2;
    try {
      lib = await withTimeout(loadGis(), loadTimeoutMs);
    } catch (e) {
      console.warn('[auth] GIS', e);
      // Un jeton encore valide reste utilisable sans GIS (Drive n'en a pas besoin)
      const rest = restingState();
      setState(rest.status === 'signed-in' ? rest : withAccount({ status: 'error', error: MSG_GIS_UNAVAILABLE }));
      return;
    }
    try {
      gis = lib;
      client = lib.initTokenClient({
        client_id: clientId,
        scope: scopes.join(' '),
        callback: (r) => void onTokenResponse(lib, r),
        error_callback: (e) => onPopupError(e),
      });
    } catch (e) {
      console.error('[auth] initTokenClient', e);
      client = null;
      const rest = restingState();
      setState(rest.status === 'signed-in' ? rest : withAccount({ status: 'error', error: MSG_GIS_INIT }));
      return;
    }
    if (token && isExpired(token)) dropToken();
    setState(restingState());
  }

  /**
   * Charge GIS puis restaure l'état. Ne rejette pas : un échec se lit dans l'état ('error'),
   * et un nouvel appel (ou `signIn()`) relance le chargement.
   */
  function init(): Promise<void> {
    if (!clientId) {
      setState({ status: 'error', error: MSG_NO_CLIENT_ID });
      return Promise.resolve();
    }
    if (client) return Promise.resolve();
    initPromise ??= doInit().finally(() => {
      initPromise = null;
    });
    return initPromise;
  }

  /* --- Révocation ----------------------------------------------------- */

  function revoke(accessToken: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, revokeTimeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      try {
        if (gis) {
          // 'invalid_token' = déjà expiré/révoqué : traité comme un succès
          gis.revoke(accessToken, () => done());
        } else {
          doFetch(REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: accessToken }).toString(),
          }).then(done, done);
        }
      } catch {
        done();
      }
    });
  }

  /* --- API publique --------------------------------------------------- */

  return {
    init,

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
      if (!clientId) return Promise.reject(new AppError('auth', MSG_NO_CLIENT_ID, { retryable: false }));
      if (!client) {
        // GIS pas (encore) prêt : relancer le chargement ; la popup exigera un nouvel appui
        const message = initPromise ? MSG_GIS_LOADING : MSG_GIS_UNAVAILABLE;
        void init();
        return Promise.reject(new AppError('auth', message));
      }
      const pending = new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
      const email = account.email;
      const request: GisOverridableConfig =
        email && !forceConsent ? { prompt: '', login_hint: email } : { prompt: 'consent' };
      if (email && forceConsent) request.login_hint = email;

      setState(withAccount({ status: 'signing-in' }));
      popupOpen = true;
      try {
        // Même tick que le clic : aucun `await` avant cet appel
        client.requestAccessToken(request);
      } catch (e) {
        console.error('[auth] requestAccessToken', e);
        popupOpen = false;
        failSignIn(MSG_SIGNIN_FAILED, false);
        return pending;
      }
      if (popupOpen) {
        clearPopupTimer();
        popupTimer = setTimeout(() => {
          popupTimer = null;
          if (!popupOpen) return;
          popupOpen = false;
          failSignIn(MSG_SIGNIN_TIMEOUT, false);
        }, signInTimeoutMs);
      }
      return pending;
    },

    getToken() {
      if (!token) return null;
      if (isExpired(token)) {
        dropToken();
        if (state.status === 'signed-in') setState(withAccount({ status: 'expired' }));
        return null;
      }
      return token.token;
    },

    markExpired() {
      dropToken();
      if (state.status === 'signed-in') setState(withAccount({ status: 'expired' }));
    },

    async signOut() {
      const accessToken = token?.token;
      dropToken();
      account = {};
      persistAccount();
      forceConsent = false;
      popupOpen = false;
      clearPopupTimer();
      setState({ status: 'signed-out' });
      rejectAll(new AppError('auth', 'Déconnecté de Google.', { retryable: false }));
      if (accessToken) await revoke(accessToken);
    },
  };
}
