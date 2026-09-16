'use client';

import '@/styles/operations/area-mobile.css';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Camera, CameraOff, Search } from 'lucide-react';
import { Alert, Button, FormField, Input } from '@/components/ui/primitives';
import type { ScanLookup } from '@/modules/operations/scan-resolver';

/**
 * Reads a label, a location code or a SKU (plan 7.10). The camera is used when
 * the browser has `BarcodeDetector` (Android Chrome and recent WebViews); the
 * manual field is ALWAYS visible, so a barcode gun, an iPhone without the API
 * or a broken camera never block the person.
 *
 * It resolves nothing by itself: `GET /app/operations/api/scan` answers with
 * what the inventory module knows, after checking the person's permissions.
 */

export interface ScanInputProps {
  /** Resolver injected by tests and stories; defaults to the scan API. */
  resolve?: (code: string) => Promise<ScanLookup>;
  /** Restricts container codes and location codes to one warehouse. */
  warehouseId?: string | null;
  autoFocus?: boolean;
  onResolved?: (lookup: ScanLookup) => void;
  /** Extra actions under a successful result (e.g. "Usar en el conteo"). */
  footer?: (lookup: ScanLookup) => ReactNode;
}

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** Formats of the plan: QR of the labels, Code 128 of the guns, EAN-13 of the products. */
const SCAN_FORMATS = ['qr_code', 'code_128', 'ean_13'];
const DETECT_INTERVAL_MS = 500;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

async function fetchScan(code: string, warehouseId: string | null): Promise<ScanLookup> {
  const params = new URLSearchParams({ code });
  if (warehouseId) params.set('warehouseId', warehouseId);
  const response = await fetch(`/app/operations/api/scan?${params.toString()}`);
  const json = (await response.json().catch(() => ({}))) as {
    result?: ScanLookup;
    error?: string;
  };
  if (!response.ok || !json.result) {
    throw new Error(json.error ?? 'No pudimos leer el código');
  }
  return json.result;
}

export function ScanInput({
  resolve,
  warehouseId = null,
  autoFocus = false,
  onResolved,
  footer,
}: ScanInputProps) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [lookup, setLookup] = useState<ScanLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraSupported, setCameraSupported] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolveRef = useRef(resolve);
  const onResolvedRef = useRef(onResolved);

  useEffect(() => {
    resolveRef.current = resolve;
    onResolvedRef.current = onResolved;
  }, [resolve, onResolved]);

  useEffect(() => {
    setCameraSupported(barcodeDetectorCtor() !== null);
  }, []);

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const run = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setError('Escanea una etiqueta o escribe el código');
        setStatus('error');
        return;
      }
      setStatus('loading');
      setError(null);
      try {
        const resolver = resolveRef.current ?? ((input: string) => fetchScan(input, warehouseId));
        const result = await resolver(trimmed);
        setLookup(result);
        setStatus('done');
        onResolvedRef.current?.(result);
      } catch (err) {
        setLookup(null);
        setError(err instanceof Error ? err.message : 'No pudimos leer el código');
        setStatus('error');
      }
    },
    [warehouseId]
  );

  // The stream is attached once the <video> exists, and the detection loop runs while it plays.
  useEffect(() => {
    if (!cameraOn) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    const Detector = barcodeDetectorCtor();
    if (!video || !stream || !Detector) return;

    video.srcObject = stream;
    void video.play().catch(() => {
      setCameraError('No pudimos iniciar la vista de la cámara. Captura el código a mano.');
    });

    const detector = new Detector({ formats: SCAN_FORMATS });
    let busy = false;
    timerRef.current = setInterval(() => {
      if (busy || video.readyState < 2) return;
      busy = true;
      void detector
        .detect(video)
        .then((codes) => {
          const found = codes.find((entry) => entry.rawValue.trim().length > 0);
          if (!found) return;
          stopCamera();
          setCode(found.rawValue.trim());
          void run(found.rawValue.trim());
        })
        .catch(() => {
          /* A frame that cannot be decoded is normal: the next one is tried. */
        })
        .finally(() => {
          busy = false;
        });
    }, DETECT_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [cameraOn, run, stopCamera]);

  async function startCamera() {
    setCameraError(null);
    if (!barcodeDetectorCtor()) {
      setCameraError('Este navegador no puede leer códigos con la cámara. Escribe el código.');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraError('Este dispositivo no permite abrir la cámara desde el navegador.');
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      setCameraOn(true);
    } catch {
      setCameraError(
        'No pudimos abrir la cámara. Revisa el permiso del navegador o escribe el código.'
      );
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void run(code);
  }

  return (
    <div className="area-scan">
      <form className="area-scan-form" onSubmit={onSubmit}>
        <FormField
          label="Código"
          htmlFor="area-scan-code"
          help="Etiqueta de contenedor, código de ubicación o SKU."
        >
          <div className="area-scan-row">
            <Input
              id="area-scan-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="RL-000123, A-01-02, SKU…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              autoFocus={autoFocus}
              maxLength={200}
            />
            <Button type="submit" size="sm" isLoading={status === 'loading'}>
              <Search size={14} aria-hidden="true" />
              Buscar
            </Button>
          </div>
        </FormField>

        {cameraSupported ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => (cameraOn ? stopCamera() : void startCamera())}
            >
              {cameraOn ? (
                <CameraOff size={14} aria-hidden="true" />
              ) : (
                <Camera size={14} aria-hidden="true" />
              )}
              {cameraOn ? 'Detener la cámara' : 'Usar la cámara'}
            </Button>
          </div>
        ) : (
          <p className="area-scan-hint">
            Este navegador no puede leer códigos con la cámara: escribe el código o usa una pistola
            lectora.
          </p>
        )}
      </form>

      {cameraOn ? (
        <div className="area-scan-camera">
          <video ref={videoRef} className="area-scan-video" playsInline muted />
          <span className="area-scan-frame" aria-hidden="true" />
        </div>
      ) : null}

      {cameraError ? <Alert variant="warning">{cameraError}</Alert> : null}
      {status === 'error' && error ? <Alert variant="error">{error}</Alert> : null}

      <div aria-live="polite">
        {status === 'done' && lookup ? (
          lookup.kind === 'unknown' ? (
            <Alert variant="info">{lookup.message ?? lookup.subtitle}</Alert>
          ) : (
            <div className="area-scan-result">
              <p className="area-scan-title">{lookup.title}</p>
              <p className="area-scan-subtitle">{lookup.subtitle}</p>
              {lookup.items.length > 0 ? (
                <ul className="area-scan-items">
                  {lookup.items.map((item) => (
                    <li key={item.id} className="area-scan-item">
                      <span className="area-scan-item-main">
                        <span>{item.title}</span>
                        <span className="area-scan-item-sub">
                          {[item.subtitle, item.confidenceLabel].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="area-scan-item-qty">
                        {item.quantity}
                        {item.unit ? ` ${item.unit}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="area-scan-hint">Sin existencias registradas aquí.</p>
              )}
              {lookup.moreItems > 0 ? (
                <p className="area-scan-hint">y {lookup.moreItems} registros más.</p>
              ) : null}
              {footer ? footer(lookup) : null}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
