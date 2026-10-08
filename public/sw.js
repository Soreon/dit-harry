/*
 * Dit Harry — service worker écrit à la main (sans Workbox).
 *
 * - Navigation : réseau d'abord (délai max NAV_TIMEOUT_MS), repli sur index.html en cache.
 * - Fichiers de l'appli (même origine, GET) : cache d'abord, puis réseau (et mise en cache).
 *   Les fichiers hashés de Vite (assets/) ne changent jamais ; les autres (manifeste, icônes)
 *   sont servis depuis le cache puis rafraîchis en arrière-plan.
 * - JAMAIS de cache pour les autres origines (Google, Gemini) ni pour les requêtes non-GET :
 *   le navigateur les traite normalement.
 * - BUILD_ID est remplacé à chaque déploiement par la GitHub Action (.github/workflows/deploy.yml) :
 *   le fichier change, le navigateur installe la nouvelle version, et `activate` supprime
 *   les anciens caches (anciens fichiers hashés compris).
 */

/* global self, caches */

const BUILD_ID = '__DIT_HARRY_BUILD_ID__';
const CACHE = `dit-harry-${BUILD_ID}`;
/** Au-delà, on sert la page en cache (réseau lent / « lie-fi »). */
const NAV_TIMEOUT_MS = 4000;

const SCOPE = new URL(self.registration.scope);
const ROOT_URL = new URL('./', SCOPE).href;
const INDEX_URL = new URL('index.html', SCOPE).href;
const ASSETS_PATH = new URL('assets/', SCOPE).pathname;

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  // Précache atomique : s'il échoue, l'installation échoue, l'ancien worker et son cache
  // (complet) restent en place, et le navigateur réessaiera à la prochaine visite. Sinon
  // `activate` supprimerait le dernier cache utilisable hors ligne.
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});

/**
 * Met en cache les fichiers que la page référence, puis « ./ » et « ./index.html » (en dernier :
 * le cache n'a jamais de page sans ses scripts). Rejette si la page ou un fichier indispensable
 * (assets/ : JS, CSS) n'a pas pu être récupéré.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch(INDEX_URL, { cache: 'no-cache' }); // hors ligne → rejet → install échoue
  if (!isCacheable(res)) throw new Error(`index.html indisponible (${res.status})`);
  const html = await res.clone().text();
  await cacheReferencedFiles(cache, html);
  await putShell(cache, res);
}

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  // Lectures partielles (médias) et bizarrerie connue des DevTools : laisser passer.
  if (req.headers.has('range')) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
  } else {
    event.respondWith(handleFile(event));
  }
});

/** Réseau d'abord avec délai ; repli sur la page en cache ; sinon page « hors ligne ». */
function handleNavigation(event) {
  const req = event.request;
  let caching = Promise.resolve();
  // `no-cache` : toujours revalider auprès du serveur (304 si inchangé). Sans cela, le cache
  // HTTP (GitHub Pages : max-age=600) peut rendre l'ANCIENNE page juste après un déploiement ;
  // elle remplacerait la nouvelle dans CACHE et pointerait vers des fichiers hashés supprimés
  // (écran blanc). Avec un `init`, le mode « navigate » devient « same-origin » ; la redirection
  // reste « manual », donc la réponse reste valable pour cette navigation.
  const network = fetch(new Request(req, { cache: 'no-cache' })).then((res) => {
    if (isCacheable(res) && isShellUrl(req.url)) {
      // Copie prise avant que la page ne lise le corps ; mise en cache sans retarder la réponse.
      const copy = res.clone();
      caching = caches.open(CACHE).then((cache) => putShell(cache, copy));
    }
    return res;
  });
  // Garde le worker en vie jusqu'à la fin de la mise en cache, même si le cache a répondu avant.
  event.waitUntil(
    network
      .then(() => caching)
      .then(noop, noop),
  );

  return (async () => {
    try {
      const res = await withTimeout(network, NAV_TIMEOUT_MS);
      if (res.status < 500) return res;
      const cached = await cachedShell();
      return cached ?? res;
    } catch {
      const cached = await cachedShell();
      if (cached) return cached;
      try {
        return await network;
      } catch {
        return offlineResponse();
      }
    }
  })();
}

/** Cache d'abord ; rafraîchissement en arrière-plan pour les fichiers non hashés. */
async function handleFile(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) {
    if (!isHashedAsset(req.url)) {
      extendLifetime(
        event,
        fetch(req).then((res) => (isCacheable(res) ? cache.put(req, res) : undefined)),
      );
    }
    return cached;
  }
  const res = await fetch(req);
  if (isCacheable(res)) extendLifetime(event, cache.put(req, res.clone()));
  return res;
}

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

function noop() {}

function extendLifetime(event, promise) {
  const safe = promise.then(noop, noop);
  try {
    event.waitUntil(safe);
  } catch {
    // Événement déjà terminé : la promesse continue sans garantie, ce n'est pas grave.
  }
}

/** Seules les réponses complètes, réussies et de même origine sont mises en cache. */
function isCacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic';
}

function isShellUrl(href) {
  const u = new URL(href);
  return u.origin === SCOPE.origin && (u.pathname === SCOPE.pathname || u.pathname === `${SCOPE.pathname}index.html`);
}

function isHashedAsset(href) {
  return new URL(href).pathname.startsWith(ASSETS_PATH);
}

/** Enregistre la page sous « ./ » et « ./index.html » (réponse reconstruite : pas de redirection mémorisée). */
async function putShell(cache, res) {
  const body = await res.blob();
  const init = { status: res.status, statusText: res.statusText, headers: res.headers };
  await cache.put(INDEX_URL, new Response(body, init));
  await cache.put(ROOT_URL, new Response(body, init));
}

async function cachedShell() {
  const cache = await caches.open(CACHE);
  return (await cache.match(INDEX_URL)) ?? (await cache.match(ROOT_URL));
}

/**
 * Fichiers de même origine référencés par index.html (scripts, styles, manifeste, icônes).
 * Rejette si un fichier hashé (assets/ : indispensable au démarrage) manque ; les autres
 * (icônes, manifeste) seront mis en cache à leur première utilisation.
 */
async function cacheReferencedFiles(cache, html) {
  const urls = new Set();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g)) {
    let u;
    try {
      u = new URL(m[1], INDEX_URL);
    } catch {
      continue;
    }
    if (u.origin !== SCOPE.origin || !u.pathname.startsWith(SCOPE.pathname) || isShellUrl(u.href)) continue;
    urls.add(u.href);
  }
  await Promise.all(
    [...urls].map(async (url) => {
      const required = isHashedAsset(url);
      try {
        if (await cache.match(url)) return;
        const res = await fetch(url, { cache: 'no-cache' });
        if (isCacheable(res)) await cache.put(url, res);
        else if (required) throw new Error(`${url} indisponible (${res.status})`);
      } catch (e) {
        if (required) throw e;
      }
    }),
  );
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function offlineResponse() {
  const html =
    '<!doctype html><html lang="fr"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Dit Harry — hors ligne</title>' +
    '<body style="font-family:system-ui,sans-serif;background:#f6f1e9;color:#2b2420;padding:2rem">' +
    '<h1 style="font-family:ui-serif,Georgia,serif">Hors ligne</h1>' +
    '<p>Dit Harry n’a pas encore pu être enregistré sur cet appareil. ' +
    'Reconnecte-toi à Internet puis réessaie.</p></body></html>';
  return new Response(html, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
