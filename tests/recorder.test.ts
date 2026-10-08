import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import { createVoiceRecorder, pickRecordingMimeType, rmsLevel } from '../src/lib/recorder';
import type { LocalDb, RecorderCallbacks, RecordingChunk, RecordingResult } from '../src/lib/types';

describe('pickRecordingMimeType', () => {
  const only = (...types: string[]) => (t: string) => types.includes(t);

  it('préfère WebM/Opus', () => {
    expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('respecte l’ordre de préférence', () => {
    expect(pickRecordingMimeType(only('audio/webm', 'audio/mp4'))).toBe('audio/webm');
    expect(pickRecordingMimeType(only('audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2'))).toBe(
      'audio/mp4;codecs=mp4a.40.2',
    );
    expect(pickRecordingMimeType(only('audio/ogg;codecs=opus', 'audio/mp4'))).toBe('audio/mp4');
    expect(pickRecordingMimeType(only('audio/ogg;codecs=opus'))).toBe('audio/ogg;codecs=opus');
  });

  it('renvoie "" si rien n’est supporté, ignore les exceptions', () => {
    expect(pickRecordingMimeType(() => false)).toBe('');
    const seen: string[] = [];
    const picked = pickRecordingMimeType((t) => {
      seen.push(t);
      if (t.startsWith('audio/webm')) throw new Error('boom');
      return t === 'audio/mp4';
    });
    expect(picked).toBe('audio/mp4');
    expect(seen).toEqual(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']);
  });
});

describe('rmsLevel', () => {
  it('borne le niveau entre 0 et 1 (échelle en dB, plancher -60 dB)', () => {
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel(new Float32Array(128))).toBe(0);
    expect(rmsLevel(new Float32Array(128).fill(1))).toBe(1);
    expect(rmsLevel(new Float32Array(128).fill(0.001))).toBeCloseTo(0, 5);
    expect(rmsLevel(new Float32Array(128).fill(0.1))).toBeCloseTo(2 / 3, 5);
    expect(rmsLevel(new Float32Array(128).fill(2))).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Faux navigateur                                                     */
/* ------------------------------------------------------------------ */

class FakeTrack extends EventTarget {
  kind = 'audio';
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(t: string): boolean {
    return t.startsWith('audio/webm');
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  timeslice: number | undefined;
  finalData = 'FIN';
  readonly stream: FakeStream;
  readonly options: MediaRecorderOptions;
  constructor(stream: FakeStream, options: MediaRecorderOptions = {}) {
    super();
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.state = 'recording';
    this.timeslice = timeslice;
    if (!this.mimeType) this.mimeType = 'audio/webm;codecs=opus';
  }
  emit(text: string): void {
    const ev = new Event('dataavailable');
    Object.assign(ev, { data: new Blob([text], { type: this.mimeType }) });
    this.dispatchEvent(ev);
  }
  stop(): void {
    if (this.state === 'inactive') throw new Error('InvalidStateError');
    this.state = 'inactive';
    // Comme un vrai MediaRecorder : dernier morceau puis `stop`, de façon asynchrone.
    queueMicrotask(() => {
      this.emit(this.finalData);
      this.dispatchEvent(new Event('stop'));
    });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'closed' = 'running';
  amplitude = 0.1;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData: (a: Float32Array) => a.fill(this.amplitude),
    };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
}

class FakeSentinel {
  released = false;
  release = vi.fn(() => {
    this.released = true;
    return Promise.resolve();
  });
}

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  setVisibility(v: 'visible' | 'hidden'): void {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function makeDb() {
  const chunks: RecordingChunk[] = [];
  const db = {
    putChunk: vi.fn((c: RecordingChunk) => {
      chunks.push(c);
      return Promise.resolve();
    }),
    deleteChunks: vi.fn((id: string) => {
      for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i]?.recordingId === id) chunks.splice(i, 1);
      return Promise.resolve();
    }),
  };
  return { db, chunks, asDb: db as unknown as LocalDb };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let stream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;
let sentinels: FakeSentinel[];
let wakeRequest: ReturnType<typeof vi.fn>;
let doc: FakeDocument;

function lastRecorder(): FakeMediaRecorder {
  const r = FakeMediaRecorder.instances.at(-1);
  if (!r) throw new Error('aucun MediaRecorder');
  return r;
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  stream = new FakeStream();
  sentinels = [];
  getUserMedia = vi.fn(() => Promise.resolve(stream));
  wakeRequest = vi.fn(() => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return Promise.resolve(s);
  });
  doc = new FakeDocument();
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, wakeLock: { request: wakeRequest } });
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createVoiceRecorder', () => {
  it('démarre avec les bonnes contraintes et options', async () => {
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb, { audioBitsPerSecond: 32_000, timesliceMs: 5_000, maxDurationSec: 60 });
    expect(rec.status).toBe('idle');
    const p = rec.start();
    expect(rec.status).toBe('starting');
    await p;
    expect(rec.status).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const mr = lastRecorder();
    expect(mr.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 });
    expect(mr.timeslice).toBe(5_000);
    await flush();
    expect(wakeRequest).toHaveBeenCalledWith('screen');
    await rec.cancel();
  });

  it('écrit chaque morceau au fil de l’eau puis assemble le résultat à l’arrêt', async () => {
    const { db, chunks, asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    await rec.start();
    const mr = lastRecorder();
    mr.emit('AAA');
    mr.emit('BB');
    await flush();
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    const first = chunks[0];
    expect(first?.mimeType).toBe('audio/webm');
    expect(first?.blob.size).toBe(3);
    expect(new Set(chunks.map((c) => c.recordingId)).size).toBe(1);

    await flush();
    const result = await rec.stop();
    expect(rec.status).toBe('idle');
    expect(result.recordingId).toBe(first?.recordingId);
    expect(result.startedAt).toBe(first?.startedAt);
    expect(result.mimeType).toBe('audio/webm');
    expect(result.blob.type).toBe('audio/webm');
    expect(await result.blob.text()).toBe('AAABBFIN');
    expect(result.interrupted).toBe(false);
    expect(result.durationSec).toBeGreaterThanOrEqual(0);
    // Le dernier morceau est aussi en base ; rien n'est supprimé par stop()
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(db.deleteChunks).not.toHaveBeenCalled();
    // Tout est libéré
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalled();
    expect(sentinels[0]?.release).toHaveBeenCalled();
  });

  it('protège contre les doubles démarrages / arrêts', async () => {
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    await rec.start();
    await expect(rec.start()).rejects.toThrow('Un enregistrement est déjà en cours.');
    const p1 = rec.stop();
    const p2 = rec.stop();
    expect(rec.status).toBe('stopping');
    expect(await p1).toBe(await p2);
    await expect(rec.stop()).rejects.toBeInstanceOf(AppError);
    // Réutilisable ensuite
    await rec.start();
    expect(rec.status).toBe('recording');
    await rec.stop();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it('cancel() arrête tout et supprime les morceaux', async () => {
    const { db, chunks, asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    await rec.start();
    lastRecorder().emit('AAA');
    await rec.cancel();
    expect(rec.status).toBe('idle');
    expect(db.deleteChunks).toHaveBeenCalledOnce();
    expect(chunks).toEqual([]);
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    await rec.cancel(); // sans effet
  });

  it('cancel() pendant la demande d’accès au micro', async () => {
    let resolveMic: (s: FakeStream) => void = () => undefined;
    getUserMedia.mockImplementation(() => new Promise((r) => (resolveMic = r)));
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    const started = rec.start();
    const cancelled = rec.cancel();
    resolveMic(stream);
    await expect(started).rejects.toThrow('Enregistrement annulé.');
    await cancelled;
    expect(rec.status).toBe('idle');
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('s’arrête tout seul en arrière-plan (interrupted) et retire ses écouteurs', async () => {
    const { db, asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    const auto = new Promise<RecordingResult>((resolve) => {
      void rec.start({ onAutoStop: resolve });
    });
    await flush();
    lastRecorder().emit('X');
    const removeSpy = vi.spyOn(doc, 'removeEventListener');
    doc.setVisibility('hidden');
    const result = await auto;
    expect(result.interrupted).toBe(true);
    expect(await result.blob.text()).toBe('XFIN');
    expect(rec.status).toBe('idle');
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(db.deleteChunks).not.toHaveBeenCalled();
    expect(stream.tracks[0]?.stopped).toBe(true);
  });

  it('ne démarre pas si l’appli est passée en arrière-plan pendant la demande de micro', async () => {
    getUserMedia.mockImplementation(() => {
      doc.visibilityState = 'hidden';
      return Promise.resolve(stream);
    });
    const rec = createVoiceRecorder(makeDb().asDb);
    await expect(rec.start()).rejects.toThrow(/arrière-plan/);
    expect(rec.status).toBe('idle');
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('s’arrête tout seul si la piste se termine', async () => {
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    const onAutoStop = vi.fn();
    await rec.start({ onAutoStop });
    stream.tracks[0]?.dispatchEvent(new Event('ended'));
    await flush();
    await vi.waitFor(() => expect(onAutoStop).toHaveBeenCalledOnce());
    expect((onAutoStop.mock.calls[0]?.[0] as RecordingResult).interrupted).toBe(true);
  });

  it('stop() pendant un arrêt automatique rend le résultat une seule fois', async () => {
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    const onAutoStop = vi.fn();
    await rec.start({ onAutoStop });
    doc.setVisibility('hidden');
    const result = await rec.stop();
    await flush();
    expect(result.interrupted).toBe(true);
    expect(onAutoStop).not.toHaveBeenCalled();
  });

  it('ré-acquiert le Wake Lock au retour au premier plan', async () => {
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb);
    await rec.start();
    await flush();
    expect(sentinels).toHaveLength(1);
    const first = sentinels[0];
    if (first) first.released = true; // relâché par le système
    doc.setVisibility('visible');
    await flush();
    expect(sentinels).toHaveLength(2);
    expect(rec.status).toBe('recording');
    await rec.stop();
    expect(sentinels[1]?.release).toHaveBeenCalled();
  });

  it('chrono, niveau sonore et durée maximale', async () => {
    vi.useFakeTimers();
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb, { maxDurationSec: 3 });
    const ticks: number[] = [];
    const levels: number[] = [];
    let autoResult: RecordingResult | undefined;
    const cb: RecorderCallbacks = {
      onTick: (s) => ticks.push(s),
      onLevel: (l) => levels.push(l),
      onAutoStop: (r) => (autoResult = r),
    };
    await rec.start(cb);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toEqual([0, 1]);
    // ~20 mesures par seconde, toutes dans [0, 1], qui convergent vers le niveau réel
    expect(levels.length).toBeGreaterThanOrEqual(18);
    expect(levels.every((l) => l >= 0 && l <= 1)).toBe(true);
    expect(levels.at(-1)).toBeCloseTo(2 / 3, 2);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(autoResult?.interrupted).toBe(true);
    expect(autoResult?.durationSec).toBe(3);
    expect(ticks).toContain(2);
    expect(rec.status).toBe('idle');
    const n = ticks.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ticks).toHaveLength(n); // plus de minuterie active
  });

  it('continue si l’écriture d’un morceau échoue (copie mémoire)', async () => {
    const { db, asDb } = makeDb();
    db.putChunk.mockImplementation(() => Promise.reject(new Error('quota')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rec = createVoiceRecorder(asDb);
    await rec.start();
    lastRecorder().emit('AB');
    const result = await rec.stop();
    expect(await result.blob.text()).toBe('ABFIN');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('se rabat sur le format par défaut si le format demandé est refusé', async () => {
    class PickyRecorder extends FakeMediaRecorder {
      constructor(s: FakeStream, o: MediaRecorderOptions = {}) {
        if (o.mimeType) throw new DOMException('non', 'NotSupportedError');
        super(s, o);
      }
    }
    vi.stubGlobal('MediaRecorder', PickyRecorder);
    const { asDb } = makeDb();
    const rec = createVoiceRecorder(asDb, { audioBitsPerSecond: 24_000 });
    await rec.start();
    expect(lastRecorder().options).toEqual({ audioBitsPerSecond: 24_000 });
    const result = await rec.stop();
    expect(result.mimeType).toBe('audio/webm');
  });

  describe('erreurs d’accès au micro', () => {
    const cases: [string, string][] = [
      ['NotAllowedError', 'Accès au micro refusé. Autorise le micro pour Dit Harry dans les réglages du navigateur.'],
      ['NotFoundError', 'Aucun micro détecté.'],
      ['OverconstrainedError', 'Aucun micro détecté.'],
      ['NotReadableError', 'Le micro est utilisé par une autre application.'],
    ];
    for (const [name, message] of cases) {
      it(name, async () => {
        getUserMedia.mockImplementation(() => Promise.reject(new DOMException('x', name)));
        const rec = createVoiceRecorder(makeDb().asDb);
        const err = await rec.start().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).message).toBe(message);
        expect((err as AppError).retryable).toBe(false);
        expect(rec.status).toBe('idle');
      });
    }

    it('navigateur sans MediaRecorder', async () => {
      vi.stubGlobal('MediaRecorder', undefined);
      const rec = createVoiceRecorder(makeDb().asDb);
      await expect(rec.start()).rejects.toThrow("Ton navigateur ne permet pas d'enregistrer.");
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(rec.status).toBe('idle');
    });
  });
});
