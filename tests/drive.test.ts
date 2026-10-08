import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import {
  createDriveClient,
  escapeQueryValue,
  FILE_FIELDS,
  FOLDER_MIME,
  RESUMABLE_THRESHOLD,
} from '../src/lib/drive';
import type { DriveFileMeta } from '../src/lib/types';

/* ------------------------------------------------------------------ */
/* Faux fetch                                                          */
/* ------------------------------------------------------------------ */

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function googleError(status: number, reason: string): Response {
  return json({ error: { code: status, message: reason, errors: [{ domain: 'global', reason, message: reason }] } }, status);
}

function meta(id: string, extra: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id,
    name: `${id}.json`,
    mimeType: 'application/json',
    createdTime: '2026-10-08T07:00:00.000Z',
    modifiedTime: '2026-10-08T07:00:01.000Z',
    ...extra,
  };
}

function fakeAuth(token: string | null = 'tok-123') {
  return { getToken: vi.fn(() => token), markExpired: vi.fn() };
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof Blob) return body.text();
  if (typeof body === 'string') return body;
  throw new Error('corps inattendu');
}

async function catchError(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

/** Découpe un corps multipart/related en parties { headers, content }. */
function parseMultipart(text: string, boundary: string): { headers: string; content: string }[] {
  expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
  expect(text.endsWith(`\r\n--${boundary}--`)).toBe(true);
  const inner = text.slice(`--${boundary}\r\n`.length, text.length - `\r\n--${boundary}--`.length);
  return inner.split(`\r\n--${boundary}\r\n`).map((part) => {
    const sep = part.indexOf('\r\n\r\n');
    return { headers: part.slice(0, sep), content: part.slice(sep + 4) };
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('drive — requêtes de base', () => {
  it('envoie le jeton en Bearer et lit about.user', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ user: { emailAddress: 'jean@exemple.fr', displayName: 'Jean' } }),
    );
    const auth = fakeAuth();
    const drive = createDriveClient(auth, fetch);
    await expect(drive.about()).resolves.toEqual({ email: 'jean@exemple.fr', name: 'Jean' });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.headers.get('Authorization')).toBe('Bearer tok-123');
    expect(c.url.origin + c.url.pathname).toBe('https://www.googleapis.com/drive/v3/about');
    expect(c.url.searchParams.get('fields')).toBe('user');
    expect(auth.getToken).toHaveBeenCalled();
  });

  it('about : email absent → chaîne vide', async () => {
    const { fetch } = fakeFetch(() => json({ user: { displayName: 'Jean' } }));
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.about()).resolves.toEqual({ email: '', name: 'Jean' });
  });

  it('sans jeton → AppError auth, aucun appel réseau', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const drive = createDriveClient(fakeAuth(null), fetch);
    const err = await catchError(drive.listAppData());
    expect(err.kind).toBe('auth');
    expect(calls).toHaveLength(0);
  });

  it('relit le jeton à chaque appel', async () => {
    let token = 'a';
    const auth = { getToken: vi.fn(() => token), markExpired: vi.fn() };
    const { fetch, calls } = fakeFetch(() => json({ user: {} }));
    const drive = createDriveClient(auth, fetch);
    await drive.about();
    token = 'b';
    await drive.about();
    expect(calls.map((c) => c.headers.get('Authorization'))).toEqual(['Bearer a', 'Bearer b']);
  });
});

describe('drive — listAppData', () => {
  it('gère la pagination et demande les bons champs', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get('pageToken') === 'p2'
        ? json({ files: [meta('c')] })
        : json({ nextPageToken: 'p2', files: [meta('a'), meta('b', { appProperties: { kind: 'entry' } })] }),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    const files = await drive.listAppData();
    expect(files.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(files[1]?.appProperties).toEqual({ kind: 'entry' });

    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first.method).toBe('GET');
    expect(first.url.origin + first.url.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(first.url.searchParams.get('spaces')).toBe('appDataFolder');
    expect(first.url.searchParams.get('pageSize')).toBe('1000');
    expect(first.url.searchParams.get('fields')).toBe(`nextPageToken,files(${FILE_FIELDS})`);
    expect(first.url.searchParams.get('q')).toBe('trashed = false');
    expect(first.url.searchParams.has('pageToken')).toBe(false);
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('p2');
  });

  it('jeton de page refusé (400) → reprend une fois depuis le début', async () => {
    let rejected = false;
    const { fetch, calls } = fakeFetch((c) => {
      const pt = c.url.searchParams.get('pageToken');
      if (pt === 'bad' && !rejected) {
        rejected = true;
        return googleError(400, 'invalid');
      }
      if (pt === 'bad') return json({ files: [meta('b')] });
      return json({ nextPageToken: 'bad', files: [meta('a')] });
    });
    const drive = createDriveClient(fakeAuth(), fetch);
    const files = await drive.listAppData();
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(4);
  });
});

describe('drive — création', () => {
  it('multipart : boundary, métadonnées (appDataFolder + appProperties) puis contenu', async () => {
    const { fetch, calls } = fakeFetch(() => json(meta('new-1')));
    const drive = createDriveClient(fakeAuth(), fetch);
    const content = JSON.stringify({ id: 'e1', transcript: 'Bonjour à toi' });
    const props = { kind: 'entry', day: '2026-10-08', entryId: 'e1' };
    const res = await drive.createAppDataFile('entry-e1.json', content, 'application/json', props);
    expect(res.id).toBe('new-1');

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.origin + c.url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(c.url.searchParams.get('uploadType')).toBe('multipart');
    expect(c.url.searchParams.get('fields')).toBe(FILE_FIELDS);
    expect(c.headers.get('Authorization')).toBe('Bearer tok-123');

    const ct = c.headers.get('Content-Type') ?? '';
    const m = /^multipart\/related; boundary=(.+)$/.exec(ct);
    expect(m).not.toBeNull();
    const boundary = m![1]!;

    expect(c.body).toBeInstanceOf(Blob);
    const parts = parseMultipart(await bodyText(c.body), boundary);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers).toBe('Content-Type: application/json; charset=UTF-8');
    expect(JSON.parse(parts[0]!.content)).toEqual({
      name: 'entry-e1.json',
      mimeType: 'application/json',
      parents: ['appDataFolder'],
      appProperties: props,
    });
    expect(parts[1]!.headers).toBe('Content-Type: application/json');
    expect(parts[1]!.content).toBe(content);
  });

  it('multipart avec un Blob audio : octets inclus tels quels', async () => {
    const { fetch, calls } = fakeFetch(() => json(meta('aud', { mimeType: 'audio/webm' })));
    const drive = createDriveClient(fakeAuth(), fetch);
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 13, 10]);
    await drive.createAppDataFile('audio-e1.webm', new Blob([bytes], { type: 'audio/webm' }), 'audio/webm', {
      kind: 'audio',
      day: '2026-10-08',
      entryId: 'e1',
    });
    const c = calls[0]!;
    const boundary = /boundary=(.+)$/.exec(c.headers.get('Content-Type') ?? '')![1]!;
    const raw = new Uint8Array(await (c.body as Blob).arrayBuffer());
    const marker = new TextEncoder().encode('Content-Type: audio/webm\r\n\r\n');
    const start = indexOf(raw, marker) + marker.length;
    const end = start + bytes.length;
    expect(Array.from(raw.slice(start, end))).toEqual(Array.from(bytes));
    expect(new TextDecoder().decode(raw.slice(end))).toBe(`\r\n--${boundary}--`);
  });

  it('> 5 Mo → resumable : session (POST) puis PUT sans Authorization', async () => {
    const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz';
    const { fetch, calls } = fakeFetch((c, i) =>
      i === 0
        ? new Response(null, { status: 200, headers: { Location: session } })
        : json(meta('big', { mimeType: 'audio/webm', size: String(RESUMABLE_THRESHOLD + 1) })),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    const blob = new Blob([new Uint8Array(RESUMABLE_THRESHOLD + 1)], { type: 'audio/webm' });
    const props = { kind: 'audio', day: '2026-10-08', entryId: 'e2' };
    const res = await drive.createAppDataFile('audio-e2.webm', blob, 'audio/webm', props);
    expect(res.id).toBe('big');

    expect(calls).toHaveLength(2);
    const [init, put] = [calls[0]!, calls[1]!];
    expect(init.method).toBe('POST');
    expect(init.url.searchParams.get('uploadType')).toBe('resumable');
    expect(init.url.searchParams.get('fields')).toBe(FILE_FIELDS);
    expect(init.headers.get('Authorization')).toBe('Bearer tok-123');
    expect(init.headers.get('X-Upload-Content-Type')).toBe('audio/webm');
    expect(init.headers.get('X-Upload-Content-Length')).toBe(String(RESUMABLE_THRESHOLD + 1));
    expect(init.headers.get('Content-Type')).toBe('application/json; charset=UTF-8');
    expect(JSON.parse(await bodyText(init.body))).toEqual({
      name: 'audio-e2.webm',
      mimeType: 'audio/webm',
      parents: ['appDataFolder'],
      appProperties: props,
    });

    expect(put.method).toBe('PUT');
    expect(put.url.toString()).toBe(session);
    expect(put.headers.get('Authorization')).toBeNull();
    expect(put.headers.get('Content-Type')).toBe('audio/webm');
    expect(put.body).toBe(blob);
  });

  it('exactement 5 Mo → reste en multipart', async () => {
    const { fetch, calls } = fakeFetch(() => json(meta('x')));
    const drive = createDriveClient(fakeAuth(), fetch);
    await drive.createAppDataFile('a.bin', new Blob([new Uint8Array(RESUMABLE_THRESHOLD)]), 'audio/webm', {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('uploadType')).toBe('multipart');
  });

  it('session resumable sans Location → bad-response', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 200 }));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(
      drive.createAppDataFile('a.webm', new Blob([new Uint8Array(RESUMABLE_THRESHOLD + 10)]), 'audio/webm', {}),
    );
    expect(err.kind).toBe('bad-response');
  });

  it('réponse incomplète → relit les métadonnées', async () => {
    const { fetch, calls } = fakeFetch((c, i) => (i === 0 ? json({ id: 'f1', name: 'x' }) : json(meta('f1'))));
    const drive = createDriveClient(fakeAuth(), fetch);
    const res = await drive.createAppDataFile('x', '{}', 'application/json', {});
    expect(res.modifiedTime).toBe('2026-10-08T07:00:01.000Z');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url.pathname).toBe('/drive/v3/files/f1');
    expect(calls[1]!.url.searchParams.get('fields')).toBe(FILE_FIELDS);
  });
});

describe('drive — mise à jour, téléchargement, suppression', () => {
  it('updateFileContent : PATCH uploadType=media', async () => {
    const { fetch, calls } = fakeFetch(() => json(meta('f1')));
    const drive = createDriveClient(fakeAuth(), fetch);
    await drive.updateFileContent('f1', '{"a":1}', 'application/json');
    const c = calls[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.origin + c.url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files/f1');
    expect(c.url.searchParams.get('uploadType')).toBe('media');
    expect(c.url.searchParams.get('fields')).toBe(FILE_FIELDS);
    expect(c.headers.get('Content-Type')).toBe('application/json');
    expect(await bodyText(c.body)).toBe('{"a":1}');
  });

  it('updateFileContent > 5 Mo : session PATCH resumable sans corps, puis PUT', async () => {
    const session = 'https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=resumable&upload_id=abc';
    const { fetch, calls } = fakeFetch((c, i) =>
      i === 0 ? new Response(null, { status: 200, headers: { Location: session } }) : json(meta('f1')),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    const blob = new Blob([new Uint8Array(RESUMABLE_THRESHOLD + 1)]);
    await drive.updateFileContent('f1', blob, 'audio/webm');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe('/upload/drive/v3/files/f1');
    expect(calls[0]!.url.searchParams.get('uploadType')).toBe('resumable');
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers.get('X-Upload-Content-Length')).toBe(String(RESUMABLE_THRESHOLD + 1));
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.headers.get('Authorization')).toBeNull();
  });

  it('downloadJson / downloadBlob : alt=media', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.pathname.endsWith('/j') ? json({ hello: 'monde' }) : new Response(new Uint8Array([1, 2, 3])),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.downloadJson<{ hello: string }>('j')).resolves.toEqual({ hello: 'monde' });
    const blob = await drive.downloadBlob('b');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(calls.every((c) => c.url.searchParams.get('alt') === 'media')).toBe(true);
    expect(calls[0]!.url.pathname).toBe('/drive/v3/files/j');
  });

  it('downloadJson : JSON illisible → bad-response', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>oups</html>'));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.downloadJson('x'));
    expect(err.kind).toBe('bad-response');
  });

  it('deleteFile : DELETE, 204 ou 404 = succès', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.pathname.endsWith('/gone') ? googleError(404, 'notFound') : new Response(null, { status: 204 }),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.deleteFile('ok')).resolves.toBeUndefined();
    await expect(drive.deleteFile('gone')).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(calls[0]!.url.toString()).toBe('https://www.googleapis.com/drive/v3/files/ok');
  });
});

describe('drive — erreurs', () => {
  it('401 → auth.markExpired() + AppError auth', async () => {
    const { fetch } = fakeFetch(() => googleError(401, 'authError'));
    const auth = fakeAuth();
    const drive = createDriveClient(auth, fetch);
    const err = await catchError(drive.listAppData());
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(auth.markExpired).toHaveBeenCalledTimes(1);
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('403 %s → quota', async (reason) => {
    const { fetch } = fakeFetch(() => googleError(403, reason));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.downloadBlob('x'));
    expect(err.kind).toBe('quota');
    expect(err.retryable).toBe(true);
  });

  it('429 → quota (Retry-After lu si exposé)', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } }, 429, { 'Retry-After': '7' }),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.about());
    expect(err.kind).toBe('quota');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('403 storageQuotaExceeded → other « Drive plein »', async () => {
    const { fetch } = fakeFetch(() => googleError(403, 'storageQuotaExceeded'));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.createAppDataFile('a', 'x', 'text/plain', {}));
    expect(err.kind).toBe('other');
    expect(err.message).toContain('Ton Google Drive est plein');
  });

  it('403 insufficientPermissions → auth (consentement à refaire)', async () => {
    const { fetch } = fakeFetch(() => googleError(403, 'insufficientPermissions'));
    const auth = fakeAuth();
    const drive = createDriveClient(auth, fetch);
    const err = await catchError(drive.listAppData());
    expect(err.kind).toBe('auth');
    expect(auth.markExpired).toHaveBeenCalled();
  });

  it('404 → other avec status 404', async () => {
    const { fetch } = fakeFetch(() => googleError(404, 'notFound'));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.downloadJson('nope'));
    expect(err.kind).toBe('other');
    expect(err.status).toBe(404);
  });

  it('5xx → network', async () => {
    const { fetch } = fakeFetch(() => new Response('Service Unavailable', { status: 503 }));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.listAppData());
    expect(err.kind).toBe('network');
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('TypeError de fetch → network', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch;
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.about());
    expect(err.kind).toBe('network');
  });
});

describe('drive — copie visible', () => {
  it('escapeQueryValue : antislash puis apostrophe', () => {
    expect(escapeQueryValue("quinn's paper\\essay")).toBe("quinn\\'s paper\\\\essay");
  });

  it('ensureFolder : dossier trouvé → pas de création', async () => {
    const { fetch, calls } = fakeFetch(() => json({ files: [{ id: 'fold-1', name: 'Dit Harry' }] }));
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.ensureFolder('Dit Harry')).resolves.toBe('fold-1');
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('GET');
    expect(c.url.searchParams.get('q')).toBe(
      `mimeType = '${FOLDER_MIME}' and name = 'Dit Harry' and trashed = false and 'root' in parents`,
    );
  });

  it("ensureFolder : absent → création avec parent, nom échappé dans q", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.method === 'GET' ? json({ files: [] }) : json({ id: 'new-fold' })));
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.ensureFolder("L'an 2026", 'root-id')).resolves.toBe('new-fold');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('q')).toBe(
      `mimeType = '${FOLDER_MIME}' and name = 'L\\'an 2026' and trashed = false and 'root-id' in parents`,
    );
    const create = calls[1]!;
    expect(create.method).toBe('POST');
    expect(create.url.origin + create.url.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(create.url.searchParams.get('fields')).toBe('id');
    expect(JSON.parse(await bodyText(create.body))).toEqual({
      name: "L'an 2026",
      mimeType: FOLDER_MIME,
      parents: ['root-id'],
    });
  });

  it('upsertTextFile : existingId → PATCH du contenu', async () => {
    const { fetch, calls } = fakeFetch(() => json(meta('md-1', { mimeType: 'text/markdown' })));
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(
      drive.upsertTextFile('year-1', '2026-10-08.md', '# Jour', 'text/markdown', 'md-1'),
    ).resolves.toBe('md-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.searchParams.get('uploadType')).toBe('media');
    expect(calls[0]!.headers.get('Content-Type')).toBe('text/markdown');
  });

  it('upsertTextFile : existingId en 404 → recréé (multipart dans le dossier parent)', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === 'PATCH') return googleError(404, 'notFound');
      if (c.method === 'GET') return json({ files: [] });
      return json(meta('md-2', { name: '2026-10-08.md', mimeType: 'text/markdown' }));
    });
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(
      drive.upsertTextFile('year-1', '2026-10-08.md', '# Jour é', 'text/markdown', 'md-old'),
    ).resolves.toBe('md-2');
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'GET', 'POST']);
    const create = calls[2]!;
    expect(create.url.searchParams.get('uploadType')).toBe('multipart');
    const boundary = /boundary=(.+)$/.exec(create.headers.get('Content-Type') ?? '')![1]!;
    const parts = parseMultipart(await bodyText(create.body), boundary);
    expect(JSON.parse(parts[0]!.content)).toEqual({
      name: '2026-10-08.md',
      mimeType: 'text/markdown',
      parents: ['year-1'],
    });
    expect(parts[1]!.headers).toBe('Content-Type: text/markdown');
    expect(parts[1]!.content).toBe('# Jour é');
  });

  it('upsertTextFile : sans id, fichier du même nom trouvé → mis à jour', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.method === 'GET' ? json({ files: [{ id: 'md-3', name: '2026-10-08.md' }] }) : json(meta('md-3')),
    );
    const drive = createDriveClient(fakeAuth(), fetch);
    await expect(drive.upsertTextFile('year-1', '2026-10-08.md', 'x', 'text/markdown')).resolves.toBe('md-3');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[0]!.url.searchParams.get('q')).toContain("name = '2026-10-08.md' and 'year-1' in parents");
    expect(calls[1]!.url.pathname).toBe('/upload/drive/v3/files/md-3');
  });

  it("upsertTextFile : erreur autre que 404 sur le PATCH → propagée", async () => {
    const { fetch, calls } = fakeFetch(() => new Response('', { status: 500 }));
    const drive = createDriveClient(fakeAuth(), fetch);
    const err = await catchError(drive.upsertTextFile('p', 'n.md', 'x', 'text/markdown', 'id-1'));
    expect(err.kind).toBe('network');
    expect(calls).toHaveLength(1);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
