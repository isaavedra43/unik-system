/**
 * Browser upload client for the object storage.
 *
 * Flow: initiate → PUT parts straight to storage (R2 presigned URL or the
 * local emulator endpoint) → complete → wait until the server validates the
 * file (status "ready") or rejects it.
 *
 * Features: progress per byte, per-part retry with backoff, cancellation via
 * AbortSignal, resumable part signing (parts are re-signed in small batches so
 * URLs never expire mid-upload) and a status poll after completion.
 *
 * The browser never learns bucket names, keys or credentials: it only sees
 * short-lived per-part authorizations and opaque ids.
 */

export interface UploadTarget {
  type: string;
  id: string;
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  phase:
    | 'initiating'
    | 'uploading'
    | 'completing'
    | 'validating'
    | 'ready'
    | 'rejected'
    | 'error'
    | 'aborted';
}

export interface UploadResult {
  uploadId: string;
  objectId: string;
  /** Module record id (attachment id) when the target creates one. */
  referenceId: string | null;
  status: 'ready' | 'rejected';
  rejectionReason: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadOptions {
  target: UploadTarget;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Max attempts per part (default 4). */
  maxPartAttempts?: number;
  /** How long to wait for validation before giving up (default 120s). */
  validationTimeoutMs?: number;
  /** Override the declared MIME type (e.g. voice notes recorded as webm). */
  mimeType?: string;
  fileName?: string;
}

interface SignedPart {
  partNumber: number;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  contentLength: number;
}

interface InitiateResponse {
  uploadId: string;
  objectId: string;
  referenceId: string | null;
  multipart: boolean;
  partSize: number;
  partCount: number;
  expiresAt: string;
  parts: SignedPart[];
}

export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: 'network' | 'server' | 'rejected' | 'aborted' | 'timeout'
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const PART_BATCH = 4;

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new UploadError((data as { error?: string }).error ?? fallback, 'server');
  }
  return (await res.json()) as T;
}

function putPart(
  part: SignedPart,
  blob: Blob,
  onBytes: (loaded: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(part.method, part.url, true);
    for (const [k, v] of Object.entries(part.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onBytes(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') ?? '';
        resolve(etag);
      } else {
        reject(
          new UploadError(
            `La subida de la parte ${part.partNumber} falló (${xhr.status})`,
            'server'
          )
        );
      }
    };
    xhr.onerror = () => reject(new UploadError('Error de red al subir el archivo', 'network'));
    xhr.onabort = () => reject(new UploadError('Subida cancelada', 'aborted'));
    if (signal) {
      if (signal.aborted) {
        reject(new UploadError('Subida cancelada', 'aborted'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new UploadError('Subida cancelada', 'aborted'));
      },
      { once: true }
    );
  });
}

export async function uploadFile(file: Blob, options: UploadOptions): Promise<UploadResult> {
  const fileName = options.fileName ?? (file instanceof File ? file.name : 'archivo');
  const mimeType = options.mimeType ?? file.type ?? 'application/octet-stream';
  const totalBytes = file.size;
  const report = (phase: UploadProgress['phase'], loadedBytes: number) =>
    options.onProgress?.({
      loadedBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0,
      phase,
    });

  report('initiating', 0);
  const init = await jsonOrThrow<InitiateResponse>(
    await fetch('/app/files/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, mimeType, sizeBytes: totalBytes, target: options.target }),
      signal: options.signal,
    }),
    'No se pudo iniciar la subida'
  );

  const abort = async () => {
    await fetch(`/app/files/api/uploads/${encodeURIComponent(init.uploadId)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  };

  try {
    report('uploading', 0);
    const completed: Array<{ partNumber: number; etag: string }> = [];
    const loadedByPart = new Map<number, number>();
    const totalLoaded = () => [...loadedByPart.values()].reduce((a, b) => a + b, 0);
    const maxAttempts = options.maxPartAttempts ?? 4;

    let pending = Array.from({ length: init.partCount }, (_, i) => i + 1);
    let signed = new Map<number, SignedPart>(init.parts.map((p) => [p.partNumber, p]));

    while (pending.length > 0) {
      if (options.signal?.aborted) throw new UploadError('Subida cancelada', 'aborted');
      const batch = pending.slice(0, PART_BATCH);
      const missing = batch.filter((n) => {
        const s = signed.get(n);
        return !s || new Date(s.expiresAt).getTime() - Date.now() < 30_000;
      });
      if (missing.length > 0) {
        const res = await jsonOrThrow<{ parts: SignedPart[] }>(
          await fetch(`/app/files/api/uploads/${encodeURIComponent(init.uploadId)}/parts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partNumbers: missing }),
            signal: options.signal,
          }),
          'No se pudo autorizar la subida'
        );
        signed = new Map([...signed, ...res.parts.map((p) => [p.partNumber, p] as const)]);
      }

      await Promise.all(
        batch.map(async (partNumber) => {
          const start = (partNumber - 1) * init.partSize;
          const end = Math.min(totalBytes, start + init.partSize);
          const blob = file.slice(start, end);
          let attempt = 0;
          for (;;) {
            attempt++;
            const part = signed.get(partNumber);
            if (!part) throw new UploadError('Parte sin autorización', 'server');
            try {
              const etag = await putPart(
                part,
                blob,
                (loaded) => {
                  loadedByPart.set(partNumber, loaded);
                  report('uploading', totalLoaded());
                },
                options.signal
              );
              loadedByPart.set(partNumber, blob.size);
              report('uploading', totalLoaded());
              completed.push({ partNumber, etag });
              return;
            } catch (err) {
              if (err instanceof UploadError && err.code === 'aborted') throw err;
              if (attempt >= maxAttempts) throw err;
              // Re-sign this part on retry (the URL may have expired) after a backoff.
              await sleep(500 * 2 ** (attempt - 1), options.signal);
              const res = await jsonOrThrow<{ parts: SignedPart[] }>(
                await fetch(`/app/files/api/uploads/${encodeURIComponent(init.uploadId)}/parts`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ partNumbers: [partNumber] }),
                  signal: options.signal,
                }),
                'No se pudo autorizar la subida'
              );
              for (const p of res.parts) signed.set(p.partNumber, p);
            }
          }
        })
      );
      pending = pending.slice(batch.length);
    }

    report('completing', totalBytes);
    const complete = await jsonOrThrow<{
      objectId: string;
      status: string;
      rejectionReason: string | null;
    }>(
      await fetch(`/app/files/api/uploads/${encodeURIComponent(init.uploadId)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: completed }),
        signal: options.signal,
      }),
      'No se pudo completar la subida'
    );

    let status = complete.status;
    let rejectionReason = complete.rejectionReason;
    const deadline = Date.now() + (options.validationTimeoutMs ?? 120_000);
    report('validating', totalBytes);
    while (
      status !== 'ready' &&
      status !== 'rejected' &&
      status !== 'aborted' &&
      status !== 'missing'
    ) {
      if (Date.now() > deadline)
        throw new UploadError('La validación del archivo tardó demasiado', 'timeout');
      await sleep(1000, options.signal);
      const res = await fetch(`/app/files/api/objects/${encodeURIComponent(init.objectId)}`, {
        signal: options.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { status: string; rejectionReason: string | null };
        status = data.status;
        rejectionReason = data.rejectionReason;
      }
    }

    if (status !== 'ready') {
      report('rejected', totalBytes);
      throw new UploadError(rejectionReason ?? 'El archivo fue rechazado', 'rejected');
    }
    report('ready', totalBytes);
    return {
      uploadId: init.uploadId,
      objectId: init.objectId,
      referenceId: init.referenceId,
      status: 'ready',
      rejectionReason: null,
      fileName,
      mimeType,
      sizeBytes: totalBytes,
    };
  } catch (err) {
    if (err instanceof UploadError && err.code === 'aborted') {
      report('aborted', 0);
      await abort();
    } else if (!(err instanceof UploadError && err.code === 'rejected')) {
      report('error', 0);
      await abort();
    }
    throw err;
  }
}

/** Resolves a short-lived download authorization for an object the user may access. */
export async function getFileAccessUrl(
  objectId: string,
  disposition: 'inline' | 'attachment' = 'inline'
): Promise<{
  url: string;
  mode: 'signed' | 'stream';
  expiresAt?: string;
  fileName: string;
  mimeType: string;
}> {
  const res = await fetch(
    `/app/files/api/objects/${encodeURIComponent(objectId)}/access?disposition=${disposition}`
  );
  return jsonOrThrow(res, 'No se pudo autorizar la descarga');
}
