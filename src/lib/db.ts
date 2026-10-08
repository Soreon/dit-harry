/**
 * Stockage local IndexedDB (sans bibliothèque).
 * Schéma v1 — voir docs/SPEC.md §3.3 :
 *   entries   (clé `id`, index `day`)
 *   syntheses (clé `day`)
 *   audio     (clé = entryId, valeur Blob)
 *   chunks    (clé composite [recordingId, index], index `recordingId`)
 *   kv        (clé libre)
 */
import { AppError } from './errors';
import { lockFlagKey } from './lock';
import type { DayKey, LocalDb, LocalEntry, LocalSynthesis, RecordingChunk } from './types';
import { byCreatedDesc } from './util';

const DB_VERSION = 1;

type StoreName = 'entries' | 'syntheses' | 'audio' | 'chunks' | 'kv';
const ALL_STORES: StoreName[] = ['entries', 'syntheses', 'audio', 'chunks', 'kv'];

/** Création / migration du schéma. */
function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const entries = db.createObjectStore('entries', { keyPath: 'id' });
    entries.createIndex('day', 'day', { unique: false });
    db.createObjectStore('syntheses', { keyPath: 'day' });
    db.createObjectStore('audio');
    const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] });
    chunks.createIndex('recordingId', 'recordingId', { unique: false });
    db.createObjectStore('kv');
  }
  // Versions futures : ajouter ici les migrations `if (oldVersion < 2) { … }`.
}

/** Convertit une erreur IndexedDB en AppError (message français). */
function toDbError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError') {
    return new AppError(
      'other',
      'Le stockage de cet appareil est plein. Libère de la place puis réessaie.',
      { retryable: false, cause: e },
    );
  }
  const msg = e instanceof Error ? e.message : String(e ?? 'inconnue');
  return new AppError('other', `Erreur de stockage local : ${msg}`, { retryable: false, cause: e });
}

function sortChunks(list: RecordingChunk[]): RecordingChunk[] {
  return list.sort((a, b) => a.index - b.index);
}

export function createLocalDb(name: string = 'dit-harry'): LocalDb {
  let dbPromise: Promise<IDBDatabase> | null = null;

  /** Ouvre (ou réutilise) la connexion. */
  function getDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new AppError('other', 'Le stockage local (IndexedDB) est indisponible sur ce navigateur.', {
            retryable: false,
          }),
        );
        return;
      }
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(name, DB_VERSION);
      } catch (e) {
        reject(toDbError(e));
        return;
      }
      req.onupgradeneeded = (ev) => {
        upgrade(req.result, ev.oldVersion);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Un autre onglet (ou une suppression) demande une nouvelle version : on libère la
        // connexion pour ne pas le bloquer ; la prochaine opération rouvrira la base.
        db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
        };
        // Fermeture inattendue (ex. stockage effacé par le navigateur).
        db.onclose = () => {
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        reject(toDbError(req.error));
      };
      req.onblocked = () => {
        // Une ancienne connexion (autre onglet) n'a pas encore fermé : l'ouverture reprendra
        // d'elle-même dès qu'elle le fera (nos connexions ferment sur `versionchange`).
      };
    });
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    return p;
  }

  /**
   * Exécute `fn` dans une transaction. `fn` lance ses requêtes de façon synchrone et retourne
   * une fonction qui lit le résultat ; la promesse est résolue à la fin (`complete`) de la
   * transaction, donc après écriture effective.
   */
  async function tx<T>(
    stores: StoreName | StoreName[],
    mode: IDBTransactionMode,
    fn: (t: IDBTransaction) => () => T,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = await getDb();
      let t: IDBTransaction;
      try {
        t = db.transaction(stores, mode);
      } catch (e) {
        // Connexion fermée entre-temps (versionchange) → on rouvre une fois.
        if (attempt === 0 && e instanceof DOMException && e.name === 'InvalidStateError') {
          const cached = dbPromise;
          if (cached && (await cached.catch(() => null)) === db && dbPromise === cached) {
            dbPromise = null;
          }
          continue;
        }
        throw toDbError(e);
      }
      return new Promise<T>((resolve, reject) => {
        let read: () => T;
        try {
          read = fn(t);
        } catch (e) {
          try {
            t.abort();
          } catch {
            // transaction déjà terminée
          }
          reject(toDbError(e));
          return;
        }
        t.oncomplete = () => {
          try {
            resolve(read());
          } catch (e) {
            reject(toDbError(e));
          }
        };
        t.onerror = () => reject(toDbError(t.error));
        t.onabort = () => reject(toDbError(t.error ?? new DOMException('Transaction annulée', 'AbortError')));
      });
    }
  }

  function getOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx(store, 'readonly', (t) => {
      const req = t.objectStore(store).get(key);
      return () => req.result as T | undefined;
    });
  }

  function getAll<T>(store: StoreName): Promise<T[]> {
    return tx(store, 'readonly', (t) => {
      const req = t.objectStore(store).getAll();
      return () => req.result as T[];
    });
  }

  function putOne(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    return tx(store, 'readwrite', (t) => {
      if (key === undefined) t.objectStore(store).put(value);
      else t.objectStore(store).put(value, key);
      return () => undefined;
    });
  }

  function deleteOne(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
    return tx(store, 'readwrite', (t) => {
      t.objectStore(store).delete(key);
      return () => undefined;
    });
  }

  return {
    // --- Entrées ---
    getEntry: (id) => getOne<LocalEntry>('entries', id),
    putEntry: (entry) => putOne('entries', entry),
    deleteEntry: (id) => deleteOne('entries', id),
    async listEntries() {
      const list = await getAll<LocalEntry>('entries');
      return list.sort(byCreatedDesc);
    },
    listEntriesByDay(day: DayKey) {
      return tx('entries', 'readonly', (t) => {
        const req = t.objectStore('entries').index('day').getAll(day);
        return () => (req.result as LocalEntry[]).sort(byCreatedDesc);
      });
    },

    // --- Synthèses ---
    getSynthesis: (day) => getOne<LocalSynthesis>('syntheses', day),
    putSynthesis: (s) => putOne('syntheses', s),
    deleteSynthesis: (day) => deleteOne('syntheses', day),
    async listSyntheses() {
      const list = await getAll<LocalSynthesis>('syntheses');
      // Plus récent d'abord.
      return list.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    },

    // --- Audio ---
    putAudio: (entryId, blob) => putOne('audio', blob, entryId),
    getAudio: (entryId) => getOne<Blob>('audio', entryId),
    deleteAudio: (entryId) => deleteOne('audio', entryId),

    // --- Morceaux d'enregistrement ---
    putChunk: (chunk) => putOne('chunks', chunk),
    getChunks(recordingId) {
      return tx('chunks', 'readonly', (t) => {
        const req = t.objectStore('chunks').index('recordingId').getAll(recordingId);
        return () => sortChunks(req.result as RecordingChunk[]);
      });
    },
    listRecordingIds() {
      return tx('chunks', 'readonly', (t) => {
        const req = t.objectStore('chunks').getAllKeys();
        return () => {
          const ids = new Set<string>();
          for (const key of req.result) {
            if (Array.isArray(key) && typeof key[0] === 'string') ids.add(key[0]);
          }
          return [...ids];
        };
      });
    },
    deleteChunks(recordingId) {
      return deleteOne(
        'chunks',
        IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]),
      );
    },

    // --- Clé/valeur ---
    getKv: <T>(key: string) => getOne<T>('kv', key),
    setKv: <T>(key: string, value: T) => putOne('kv', value, key),
    deleteKv: (key) => deleteOne('kv', key),

    async clearAll() {
      await tx(ALL_STORES, 'readwrite', (t) => {
        for (const s of ALL_STORES) t.objectStore(s).clear();
        return () => undefined;
      });
      // Le verrou (kv `lock.config`) vient d'être effacé : son drapeau synchrone aussi, sinon
      // l'écran de verrouillage s'afficherait au démarrage sans configuration.
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(lockFlagKey(name));
      } catch {
        // stockage bloqué : le drapeau orphelin est effacé à la lecture de la configuration
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lectures-modifications-écritures de `kv` sérialisées                */
/* ------------------------------------------------------------------ */

/** File d'attente par base (même contexte JS : contrôleur et synchro partagent l'objet `db`). */
const kvQueues = new WeakMap<LocalDb, Promise<void>>();
/** Idem pour les lectures-modifications-écritures du store `entries`. */
const entryQueues = new WeakMap<LocalDb, Promise<void>>();

function serialize<T>(queues: WeakMap<LocalDb, Promise<void>>, db: LocalDb, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(db) ?? Promise.resolve();
  const p = prev.then(fn);
  queues.set(
    db,
    p.then(
      () => undefined,
      () => undefined,
    ),
  );
  return p;
}

/**
 * Exécute `fn` seule : deux sections `withKvLock` sur la même base ne s'entrelacent jamais.
 * À utiliser pour les clés `kv` lues puis réécrites par plusieurs acteurs à la fois
 * (contrôleur ET synchro) : `sync.pendingDeletes`, `sync.forceSynthesisDays`, `settings`.
 * Sans cela, une écriture intercalée entre la lecture et l'écriture de l'autre est perdue
 * (ex. un id Drive à supprimer oublié → l'entrée supprimée revient au pull suivant).
 * Ne jamais imbriquer deux sections (interblocage) ni y faire d'appel réseau.
 */
export function withKvLock<T>(db: LocalDb, fn: () => Promise<T>): Promise<T> {
  return serialize(kvQueues, db, fn);
}

/**
 * Exécute `fn` seule vis-à-vis des autres sections `withEntryLock` de la même base : les
 * lectures-modifications-écritures d'entrées du contrôleur ET de la synchro ne s'entrelacent
 * jamais (sinon une correction écrite entre la lecture et l'écriture de l'autre est écrasée).
 * Jamais d'appel réseau dedans, jamais de `withEntryLock` imbriqué. Seule imbrication permise :
 * une section d'entrées peut appeler `withKvLock`/`updateKv` — jamais l'inverse (interblocage).
 */
export function withEntryLock<T>(db: LocalDb, fn: () => Promise<T>): Promise<T> {
  return serialize(entryQueues, db, fn);
}

/**
 * Lit l'entrée `id`, calcule la nouvelle version avec `fn` (null = ne rien écrire) et l'écrit,
 * sous `withEntryLock`. Retourne l'entrée écrite, ou undefined (absente / rien écrit).
 */
export function updateEntry(
  db: LocalDb,
  id: string,
  fn: (current: LocalEntry) => LocalEntry | null,
): Promise<LocalEntry | undefined> {
  return withEntryLock(db, async () => {
    const cur = await db.getEntry(id);
    if (!cur) return undefined;
    const next = fn(cur);
    if (!next) return undefined;
    await db.putEntry(next);
    return next;
  });
}

/** Lit une clé `kv`, calcule la nouvelle valeur avec `fn` et l'écrit, sous `withKvLock`. */
export function updateKv<T>(db: LocalDb, key: string, fn: (current: unknown) => T): Promise<T> {
  return withKvLock(db, async () => {
    const next = fn(await db.getKv<unknown>(key));
    await db.setKv(key, next);
    return next;
  });
}
