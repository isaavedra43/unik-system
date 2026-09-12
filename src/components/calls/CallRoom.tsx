'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { CallRoomPlaceholder } from './CallRoomPlaceholder';

/**
 * Browser audio for a call: connects to the LiveKit room with the issued
 * token (`livekit-client`), publishes the microphone when the token allows
 * it and plays every remote audio track. Supervisors in "listen" mode never
 * publish. Falls back to the placeholder in mock mode or without a token.
 */

type RoomState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export function CallRoom({ token }: { token: IssuedToken | null }) {
  const [state, setState] = useState<RoomState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [remoteCount, setRemoteCount] = useState(0);
  const roomRef = useRef<import('livekit-client').Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token || token.mock || !token.url) return;
    let cancelled = false;
    let room: import('livekit-client').Room | null = null;

    (async () => {
      setState('connecting');
      setError(null);
      try {
        const lk = await import('livekit-client');
        room = new lk.Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        const attach = (track: import('livekit-client').RemoteTrack) => {
          if (track.kind !== lk.Track.Kind.Audio || !audioContainerRef.current) return;
          const el = track.attach();
          el.dataset.trackSid = track.sid;
          audioContainerRef.current.appendChild(el);
        };
        const detach = (track: import('livekit-client').RemoteTrack) => {
          for (const el of track.detach()) el.remove();
        };

        room
          .on(lk.RoomEvent.TrackSubscribed, attach)
          .on(lk.RoomEvent.TrackUnsubscribed, detach)
          .on(lk.RoomEvent.ParticipantConnected, () =>
            setRemoteCount(room?.remoteParticipants.size ?? 0)
          )
          .on(lk.RoomEvent.ParticipantDisconnected, () =>
            setRemoteCount(room?.remoteParticipants.size ?? 0)
          )
          .on(lk.RoomEvent.Disconnected, () => {
            if (!cancelled) setState('disconnected');
          });

        await room.connect(token.url as string, token.token);
        if (cancelled) {
          await room.disconnect();
          return;
        }
        setRemoteCount(room.remoteParticipants.size);
        // Only roles that may publish (participants, whisper/barge supervisors) open the mic.
        if (token.grants.canPublish) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
            setMicOn(true);
          } catch {
            setMicOn(false);
            setError('No se pudo activar el micrófono (revisa permisos del navegador).');
          }
        }
        setState('connected');
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setError(err instanceof Error ? err.message : 'No se pudo conectar a la sala');
        }
      }
    })();

    return () => {
      cancelled = true;
      const current = roomRef.current;
      roomRef.current = null;
      if (current) void current.disconnect();
    };
  }, [token]);

  if (!token || token.mock || !token.url) {
    return <CallRoomPlaceholder token={token} />;
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room || !token?.grants.canPublish) return;
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
    } catch {
      setError('No se pudo cambiar el micrófono');
    }
  }

  async function leave() {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    setState('disconnected');
    setMicOn(false);
  }

  const stateLabel: Record<RoomState, string> = {
    idle: 'Sin conectar',
    connecting: 'Conectando…',
    connected: 'En la sala',
    error: 'Error',
    disconnected: 'Desconectado',
  };

  return (
    <div className="card card-compact" aria-live="polite">
      <div className="card-header">
        <h3 className="card-title">
          <Headphones size={16} aria-hidden="true" /> Sala de audio
        </h3>
        <span
          className={`badge ${
            state === 'connected'
              ? 'badge-success'
              : state === 'error'
                ? 'badge-danger'
                : 'badge-info'
          }`}
        >
          {stateLabel[state]}
        </span>
      </div>
      <p className="text-muted" style={{ margin: '0 0 0.5rem' }}>
        {token.role === 'listen'
          ? 'Solo escucha: tu micrófono no se publica.'
          : `Identidad ${token.identity} · ${remoteCount} participante(s) remoto(s)`}
      </p>
      {error && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '0.5rem' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {token.grants.canPublish && (
          <button
            type="button"
            className={`btn btn-sm ${micOn ? 'btn-secondary' : 'btn-primary'}`}
            onClick={toggleMic}
            disabled={state !== 'connected'}
            aria-label={micOn ? 'Silenciar micrófono' : 'Activar micrófono'}
          >
            {micOn ? <MicOff size={14} /> : <Mic size={14} />} {micOn ? 'Silenciar' : 'Micrófono'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={leave}
          disabled={state !== 'connected' && state !== 'connecting'}
          aria-label="Salir de la sala"
        >
          <PhoneOff size={14} /> Salir
        </button>
        <span
          className="text-muted"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
        >
          <Volume2 size={14} aria-hidden="true" /> audio remoto automático
        </span>
      </div>
      <div ref={audioContainerRef} aria-hidden="true" />
    </div>
  );
}
