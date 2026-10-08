import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/*
 * Service worker (public/sw.js) exécuté dans un faux environnement : `self`, `caches` et
 * `fetch` simulés. Les réponses « basic » (même origine) sont imitées, Node ne sait pas en créer.
 */

const SCOPE = 'https://soreon.github.io/dit-harry/';
const INDEX_URL = `${SCOPE}index.html`;
const ASSET_URL = `${SCOPE}assets/index-abc123.js`;
const HTML = `<!doctype html><html><head><script type="module" src="/dit-harry/assets/index-abc123.js"></script><link rel="icon" href="/dit-harry/icons/icon.svg"></head><body></body></html>`;

type FakeResponse = Pick<Response, 'status' | 'statusText' | 'type' | 'headers'> & {
  clone(): FakeResponse;
  text(): Promise<string>;
  blob(): Promise<Blob>;
};

function basic(body: string, status = 200): FakeResponse {
  const res: FakeResponse = {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    type: 'basic',
    headers: new Headers({ 'content-type': 'text/html' }),
    clone: () => basic(body, status),
    text: async () => body,
    blob: async () => new Blob([body]),
  };
  return res;
}

function loadSw(fetchImpl: (input: Request | string, init?: RequestInit) => Promise<FakeResponse>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const keyOf = (u: unknown): string => (typeof u === 'string' ? u : (u as Request).url);
  const caches = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      const s = store;
      return {
        match: async (u: unknown) => s.get(keyOf(u)),
        put: async (u: unknown, r: unknown) => {
          s.set(keyOf(u), r);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
  };
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      listeners[type] = cb;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: async () => undefined },
  };
  const code = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  new Function('self', 'caches', 'fetch', code)(self, caches, fetchImpl);
  return { listeners, stores, self };
}

describe('sw.js', () => {
  it('navigation : la page est toujours revalidée (cache HTTP contourné)', async () => {
    const seen: Request[] = [];
    const sw = loadSw(async (input) => {
      if (typeof input !== 'string') seen.push(input);
      return basic(HTML);
    });
    const req = new Request(SCOPE);
    Object.defineProperty(req, 'mode', { value: 'navigate' });
    let response: Promise<unknown> | undefined;
    sw.listeners.fetch?.({
      request: req,
      respondWith: (p: Promise<unknown>) => {
        response = p;
      },
      waitUntil: () => undefined,
    });
    expect(response).toBeDefined();
    const res = (await response) as FakeResponse;
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cache).toBe('no-cache');
    expect(seen[0]?.url).toBe(SCOPE);
  });

  it('installation : précache complet, page mise en cache, worker activé', async () => {
    const sw = loadSw(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return url === INDEX_URL ? basic(HTML) : basic('contenu');
    });
    let install: Promise<unknown> | undefined;
    sw.listeners.install?.({ waitUntil: (p: Promise<unknown>) => (install = p) });
    await install;
    const [store] = [...sw.stores.values()];
    expect(store?.has(ASSET_URL)).toBe(true);
    expect(store?.has(INDEX_URL)).toBe(true);
    expect(store?.has(SCOPE)).toBe(true);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('installation : un fichier assets/ manquant fait échouer l’installation (l’ancien cache reste)', async () => {
    const sw = loadSw(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === INDEX_URL) return basic(HTML);
      if (url === ASSET_URL) throw new TypeError('Failed to fetch'); // réseau coupé pendant le précache
      return basic('icône');
    });
    let install: Promise<unknown> | undefined;
    sw.listeners.install?.({ waitUntil: (p: Promise<unknown>) => (install = p) });
    await expect(install).rejects.toThrow();
    const [store] = [...sw.stores.values()];
    expect(store?.has(INDEX_URL)).toBe(false); // jamais de page sans ses scripts
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it('installation hors ligne : échec (pas d’activation avec un cache vide)', async () => {
    const sw = loadSw(async () => {
      throw new TypeError('Failed to fetch');
    });
    let install: Promise<unknown> | undefined;
    sw.listeners.install?.({ waitUntil: (p: Promise<unknown>) => (install = p) });
    await expect(install).rejects.toThrow();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });
});
