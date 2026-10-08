import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { AppError } from '../src/lib/errors';
import {
  createGoogleAuth,
  type GisOAuth2,
  type GisOverridableConfig,
  type GisTokenClientConfig,
  type GisTokenResponse,
  type GoogleAuthDeps,
  type KeyValueStorage,
} from '../src/lib/auth';
import type { AuthState } from '../src/lib/types';

/* ------------------------------------------------------------------ */
/* Faux navigateur                                                     */
/* ------------------------------------------------------------------ */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
] as const;
const ALL_SCOPES = SCOPES.join(' ');
const T0 = Date.parse('2026-10-08T08:00:00.000Z');

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** Faux `google.accounts.oauth2` : on déclenche les callbacks à la main. */
function fakeGis() {
  let cfg: GisTokenClientConfig | null = null;
  const requests: GisOverridableConfig[] = [];
  const revoke = vi.fn((_token: string, done?: (r: { successful: boolean }) => void) => done?.({ successful: true }));
  const lib: GisOAuth2 = {
    initTokenClient(c) {
      cfg = c;
      return { requestAccessToken: (o) => void requests.push(o ?? {}) };
    },
    hasGrantedAllScopes(r, first, ...rest) {
      const granted = (r.scope ?? '').split(' ');
      return [first, ...rest].every((s) => granted.includes(s));
    },
    revoke,
  };
  return {
    lib,
    requests,
    revoke,
    get config(): GisTokenClientConfig {
      if (!cfg) throw new Error('initTokenClient non appelé');
      return cfg;
    },
    respond(r: GisTokenResponse) {
      this.config.callback(r);
    },
    fail(type: string) {
      this.config.error_callback?.({ type });
    },
  };
}

function aboutFetch(user: { emailAddress?: string; displayName?: string } = {}, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ user }), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function setup(
  opts: {
    local?: Record<string, string>;
    session?: Record<string, string>;
    clientId?: string;
    deps?: Partial<GoogleAuthDeps>;
    user?: { emailAddress?: string; displayName?: string };
  } = {},
) {
  const gis = fakeGis();
  const local = memoryStorage(opts.local);
  const session = memoryStorage(opts.session);
  const clock = { t: T0 };
  const fetchImpl = aboutFetch(opts.user ?? { emailAddress: 'jean@exemple.fr', displayName: 'Jean' });
  const loadGis = vi.fn(async () => gis.lib);
  const auth = createGoogleAuth(
    { clientId: opts.clientId ?? 'client-123.apps.googleusercontent.com', scopes: SCOPES },
    {
      loadGis,
      local,
      session,
      now: () => clock.t,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...opts.deps,
    },
  );
  const states: AuthState[] = [];
  auth.subscribe((s) => states.push(s));
  return { auth, gis, local, session, clock, fetchImpl, loadGis, states };
}

function storedToken(token: string, expiresAt: number): Record<string, string> {
  return { 'dh.auth.token': JSON.stringify({ token, expiresAt }) };
}

async function catchError(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('auth — démarrage', () => {
  it("identifiant client vide → état error, GIS jamais chargé", async () => {
    const { auth, loadGis } = setup({ clientId: '  ' });
    await auth.init();
    expect(auth.getState().status).toBe('error');
    expect(auth.getState().error).toContain('VITE_GOOGLE_CLIENT_ID');
    expect(loadGis).not.toHaveBeenCalled();
    const err = await catchError(auth.signIn());
    expect(err.kind).toBe('auth');
  });

  it("état 'loading' (avec le compte mémorisé) jusqu'au chargement de GIS", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const gis = fakeGis();
    const { auth } = setup({
      local: { 'dh.auth.email': 'jean@exemple.fr' },
      deps: { loadGis: () => gate.then(() => gis.lib) },
    });
    expect(auth.getState()).toMatchObject({ status: 'loading', email: 'jean@exemple.fr' });
    const p = auth.init();
    await Promise.resolve();
    expect(auth.getState().status).toBe('loading');
    release?.();
    await p;
    expect(auth.getState().status).toBe('expired');
  });

  it('rien de mémorisé → signed-out', async () => {
    const { auth, gis } = setup();
    await auth.init();
    expect(auth.getState()).toEqual({ status: 'signed-out' });
    expect(gis.config.client_id).toBe('client-123.apps.googleusercontent.com');
    expect(gis.config.scope).toBe(ALL_SCOPES);
  });

  it('email mémorisé sans jeton → expired', async () => {
    const { auth } = setup({ local: { 'dh.auth.email': 'jean@exemple.fr', 'dh.auth.name': 'Jean' } });
    await auth.init();
    expect(auth.getState()).toEqual({ status: 'expired', email: 'jean@exemple.fr', name: 'Jean' });
    expect(auth.getToken()).toBeNull();
  });

  it('jeton sessionStorage encore valide → signed-in', async () => {
    const expiresAt = T0 + 30 * 60_000;
    const { auth } = setup({
      local: { 'dh.auth.email': 'jean@exemple.fr' },
      session: storedToken('tok-ok', expiresAt),
    });
    await auth.init();
    expect(auth.getState()).toEqual({ status: 'signed-in', email: 'jean@exemple.fr', expiresAt });
    expect(auth.getToken()).toBe('tok-ok');
  });

  it('jeton sessionStorage dans la marge → expired et effacé', async () => {
    const { auth, session } = setup({
      local: { 'dh.auth.email': 'jean@exemple.fr' },
      session: storedToken('tok-old', T0 + config.tokenExpiryMarginMs - 1),
    });
    await auth.init();
    expect(auth.getState().status).toBe('expired');
    expect(auth.getToken()).toBeNull();
    expect(session.data.has('dh.auth.token')).toBe(false);
  });

  it('jeton sessionStorage corrompu → ignoré', async () => {
    const { auth } = setup({ session: { 'dh.auth.token': '{pas du json' } });
    await auth.init();
    expect(auth.getState().status).toBe('signed-out');
  });

  it('GIS ne se charge pas à temps → error (message FR), puis nouvel essai possible', async () => {
    const gis = fakeGis();
    let attempt = 0;
    const loadGis = vi.fn(() => {
      attempt++;
      return attempt === 1 ? new Promise<GisOAuth2>(() => {}) : Promise.resolve(gis.lib);
    });
    const { auth } = setup({
      local: { 'dh.auth.email': 'jean@exemple.fr' },
      deps: { loadGis, loadTimeoutMs: 10 },
    });
    await auth.init();
    expect(auth.getState()).toMatchObject({ status: 'error', email: 'jean@exemple.fr' });
    expect(auth.getState().error).toMatch(/connexion Google/);

    // signIn() sans client GIS : rejette tout de suite et relance le chargement
    const err = await catchError(auth.signIn());
    expect(err.kind).toBe('auth');
    await auth.init();
    expect(loadGis).toHaveBeenCalledTimes(2);
    expect(auth.getState().status).toBe('expired');
  });

  it('échec de chargement de GIS mais jeton valide → reste signed-in', async () => {
    const { auth } = setup({
      session: storedToken('tok-ok', T0 + 3_600_000),
      deps: { loadGis: () => Promise.reject(new Error('hors ligne')) },
    });
    await auth.init();
    expect(auth.getState().status).toBe('signed-in');
    expect(auth.getToken()).toBe('tok-ok');
  });

  it("subscribe appelle immédiatement le callback puis à chaque changement ; désinscription", async () => {
    const { auth } = setup();
    const seen: string[] = [];
    const off = auth.subscribe((s) => seen.push(s.status));
    expect(seen).toEqual(['loading']);
    await auth.init();
    expect(seen).toEqual(['loading', 'signed-out']);
    off();
    auth.signIn().catch(() => {});
    expect(seen).toEqual(['loading', 'signed-out']);
  });
});

describe('auth — connexion', () => {
  it("première connexion : prompt 'consent', puis about → email/nom mémorisés, jeton en session", async () => {
    const { auth, gis, local, session, fetchImpl, states } = setup();
    await auth.init();
    const p = auth.signIn();
    expect(gis.requests).toEqual([{ prompt: 'consent' }]);
    expect(auth.getState().status).toBe('signing-in');

    gis.respond({ access_token: 'tok-1', expires_in: '3599', scope: ALL_SCOPES, token_type: 'Bearer' });
    await p;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://www.googleapis.com/drive/v3/about?fields=user');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-1');

    const expiresAt = T0 + 3599 * 1000;
    expect(auth.getState()).toEqual({ status: 'signed-in', email: 'jean@exemple.fr', name: 'Jean', expiresAt });
    expect(local.data.get('dh.auth.email')).toBe('jean@exemple.fr');
    expect(local.data.get('dh.auth.name')).toBe('Jean');
    expect(JSON.parse(session.data.get('dh.auth.token') ?? 'null')).toEqual({ token: 'tok-1', expiresAt });
    expect(auth.getToken()).toBe('tok-1');
    expect(states.map((s) => s.status)).toEqual(['loading', 'signed-out', 'signing-in', 'signed-in']);
  });

  it("email connu : prompt '' + login_hint", async () => {
    const { auth, gis } = setup({ local: { 'dh.auth.email': 'jean@exemple.fr' } });
    await auth.init();
    const p = auth.signIn();
    expect(gis.requests).toEqual([{ prompt: '', login_hint: 'jean@exemple.fr' }]);
    gis.respond({ access_token: 'tok', expires_in: 3599, scope: ALL_SCOPES });
    await p;
    expect(auth.getState().status).toBe('signed-in');
  });

  it('une autorisation non cochée → état error explicite, rejet, puis consentement redemandé', async () => {
    const { auth, gis, session } = setup();
    await auth.init();
    const p = auth.signIn();
    gis.respond({ access_token: 'tok-partiel', expires_in: 3599, scope: SCOPES[0] });
    const err = await catchError(p);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/deux autorisations/);
    expect(auth.getState().status).toBe('error');
    expect(auth.getState().error).toMatch(/deux autorisations/);
    expect(auth.getToken()).toBeNull();
    expect(session.data.has('dh.auth.token')).toBe(false);

    auth.signIn().catch(() => {});
    expect(gis.requests[1]).toEqual({ prompt: 'consent' });
  });

  it("refus (access_denied) → error et rejet", async () => {
    const { auth, gis } = setup();
    await auth.init();
    const p = auth.signIn();
    gis.respond({ error: 'access_denied' });
    const err = await catchError(p);
    expect(err.message).toMatch(/refusé/);
    expect(auth.getState().status).toBe('error');
  });

  it('popup fermée → rejet, état expired si email connu', async () => {
    const { auth, gis } = setup({ local: { 'dh.auth.email': 'jean@exemple.fr' } });
    await auth.init();
    const p = auth.signIn();
    gis.fail('popup_closed');
    const err = await catchError(p);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/fermée/);
    expect(auth.getState()).toEqual({ status: 'expired', email: 'jean@exemple.fr' });
  });

  it('popup bloquée → message pop-up, état signed-out sans compte connu', async () => {
    const { auth, gis } = setup();
    await auth.init();
    const p = auth.signIn();
    gis.fail('popup_failed_to_open');
    const err = await catchError(p);
    expect(err.message).toMatch(/pop-up/);
    expect(auth.getState().status).toBe('signed-out');
  });

  it('jeton reçu après popup_closed → accepté quand même', async () => {
    const { auth, gis } = setup();
    await auth.init();
    const p = auth.signIn();
    gis.fail('popup_closed');
    await catchError(p);
    gis.respond({ access_token: 'tard', expires_in: 3599, scope: ALL_SCOPES });
    await vi.waitFor(() => expect(auth.getState().status).toBe('signed-in'));
    expect(auth.getToken()).toBe('tard');
  });

  it('about en 401 → connexion refusée', async () => {
    const { auth, gis } = setup({ deps: { fetchImpl: aboutFetch({}, 401) as unknown as typeof fetch } });
    await auth.init();
    const p = auth.signIn();
    gis.respond({ access_token: 'tok', expires_in: 3599, scope: ALL_SCOPES });
    const err = await catchError(p);
    expect(err.kind).toBe('auth');
    expect(auth.getToken()).toBeNull();
  });

  it('about en erreur réseau → connecté quand même (compte mémorisé conservé)', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { auth, gis } = setup({
      local: { 'dh.auth.email': 'jean@exemple.fr' },
      deps: { fetchImpl: failing as unknown as typeof fetch },
    });
    await auth.init();
    const p = auth.signIn();
    gis.respond({ access_token: 'tok', expires_in: 3599, scope: ALL_SCOPES });
    await p;
    expect(auth.getState()).toMatchObject({ status: 'signed-in', email: 'jean@exemple.fr' });
    warn.mockRestore();
  });

  it('GIS ne rappelle jamais → filet de sécurité', async () => {
    const { auth } = setup({ deps: { signInTimeoutMs: 10 } });
    await auth.init();
    const err = await catchError(auth.signIn());
    expect(err.kind).toBe('auth');
    expect(auth.getState().status).toBe('signed-out');
  });
});

describe('auth — jeton', () => {
  async function signedIn(expiresIn = 3600) {
    const ctx = setup();
    await ctx.auth.init();
    const p = ctx.auth.signIn();
    ctx.gis.respond({ access_token: 'tok', expires_in: expiresIn, scope: ALL_SCOPES });
    await p;
    return ctx;
  }

  it('getToken respecte la marge puis passe à expired', async () => {
    const { auth, clock, session } = await signedIn(3600);
    const expiresAt = T0 + 3_600_000;
    clock.t = expiresAt - config.tokenExpiryMarginMs;
    expect(auth.getToken()).toBe('tok');
    expect(auth.getState().status).toBe('signed-in');

    clock.t += 1;
    expect(auth.getToken()).toBeNull();
    expect(auth.getState()).toMatchObject({ status: 'expired', email: 'jean@exemple.fr' });
    expect(session.data.has('dh.auth.token')).toBe(false);
  });

  it('markExpired invalide le jeton', async () => {
    const { auth, session } = await signedIn();
    auth.markExpired();
    expect(auth.getToken()).toBeNull();
    expect(auth.getState().status).toBe('expired');
    expect(session.data.has('dh.auth.token')).toBe(false);
  });

  it('signOut révoque le jeton et oublie le compte', async () => {
    const { auth, gis, local, session } = await signedIn();
    await auth.signOut();
    expect(gis.revoke).toHaveBeenCalledWith('tok', expect.any(Function));
    expect(auth.getState()).toEqual({ status: 'signed-out' });
    expect(auth.getToken()).toBeNull();
    expect(local.data.size).toBe(0);
    expect(session.data.size).toBe(0);
  });

  it('signOut sans GIS chargé → révocation par fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const { auth } = setup({
      session: storedToken('tok-x', T0 + 3_600_000),
      deps: { loadGis: () => Promise.reject(new Error('hors ligne')), fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    await auth.init();
    await auth.signOut();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(call[1].method).toBe('POST');
    expect(String(call[1].body)).toBe('token=tok-x');
    expect(auth.getState().status).toBe('signed-out');
  });
});
