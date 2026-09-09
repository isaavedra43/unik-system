'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, X, User } from 'lucide-react';

export interface ChatCallDialogProps {
  channelId: string;
  type: 'audio' | 'video';
  participants: { userId: string; name: string }[];
  currentUserId: string;
  onClose: () => void;
}

interface CallState {
  status: 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended' | 'declined' | 'failed';
  callId: string | null;
  error: string | null;
}

export function ChatCallDialog({
  channelId,
  type,
  participants,
  currentUserId,
  onClose,
}: ChatCallDialogProps) {
  const [callState, setCallState] = useState<CallState>({
    status: 'initiating',
    callId: null,
    error: null,
  });
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [duration, setDuration] = useState(0);

  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    if (signalPollRef.current) clearInterval(signalPollRef.current);
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const pollSignals = useCallback(async (callId: string) => {
    try {
      const res = await fetch(`/app/chat/api/calls/${callId}/signal`);
      if (!res.ok) return;
      const data = await res.json();
      const signals: Array<{ signalType: string; signal: string; fromUserId: string }> =
        data.data ?? [];

      for (const sig of signals) {
        if (!pcRef.current) continue;
        try {
          const signalData = JSON.parse(sig.signal);
          if (sig.signalType === 'answer') {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signalData));
          } else if (sig.signalType === 'ice' && signalData) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(signalData));
          }
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      // silent
    }
  }, []);

  const startCall = useCallback(async () => {
    try {
      // Get local media
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: type === 'video',
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = localStream;
      if (localVideoRef.current && type === 'video') {
        localVideoRef.current.srcObject = localStream;
      }

      // Initiate call via API
      const res = await fetch('/app/chat/api/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId,
          type,
          participantIds: participants.map((p) => p.userId),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al iniciar la llamada');
      }

      const data = await res.json();
      const callId: string = data.data.id;
      setCallState({ status: 'ringing', callId, error: null });

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      // Add local tracks
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      // Handle remote tracks
      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      pc.ontrack = (event) => {
        event.streams[0].getTracks().forEach((track) => {
          remoteStream.addTrack(track);
        });
        setCallState((prev) => ({ ...prev, status: 'active' }));
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer to first participant
      const targetUserId = participants[0]?.userId;
      if (targetUserId) {
        await fetch(`/app/chat/api/calls/${callId}/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toUserId: targetUserId,
            signalType: 'offer',
            signal: JSON.stringify(offer),
          }),
        });
      }

      // Send ICE candidates
      pc.onicecandidate = async (event) => {
        if (event.candidate && targetUserId) {
          await fetch(`/app/chat/api/calls/${callId}/signal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              toUserId: targetUserId,
              signalType: 'ice',
              signal: JSON.stringify(event.candidate),
            }),
          }).catch(() => {});
        }
      };

      // Start polling for signals
      signalPollRef.current = setInterval(() => pollSignals(callId), 500);

      // Start duration timer when active
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setCallState((prev) => ({ ...prev, status: 'active' }));
          if (!durationTimerRef.current) {
            durationTimerRef.current = setInterval(() => {
              setDuration((d) => d + 1);
            }, 1000);
          }
        }
      };
    } catch (err) {
      setCallState((prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error desconocido',
      }));
    }
  }, [channelId, type, participants, pollSignals]);

  useEffect(() => {
    startCall();
  }, [startCall]);

  const handleHangUp = useCallback(async () => {
    if (callState.callId) {
      await fetch(`/app/chat/api/calls/${callState.callId}/end`, {
        method: 'POST',
      }).catch(() => {});
    }
    cleanup();
    setCallState((prev) => ({ ...prev, status: 'ended' }));
    setTimeout(onClose, 1000);
  }, [callState.callId, cleanup, onClose]);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = muted;
      });
      setMuted(!muted);
    }
  }, [muted]);

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = videoOff;
      });
      setVideoOff(!videoOff);
    }
  }, [videoOff]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const statusText = {
    initiating: 'Iniciando...',
    ringing: 'Llamando...',
    connecting: 'Conectando...',
    active: formatDuration(duration),
    ended: 'Llamada finalizada',
    declined: 'Llamada rechazada',
    failed: callState.error || 'Error en la llamada',
  }[callState.status];

  const isActive = callState.status === 'active';

  return (
    <div className="chat-call-dialog-overlay">
      <div className="chat-call-dialog">
        <div className="chat-call-header">
          <div className="chat-call-status">
            <span className={`chat-call-status-dot ${callState.status}`} />
            <span>{statusText}</span>
          </div>
          <button
            type="button"
            className="chat-call-close"
            onClick={handleHangUp}
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </div>

        <div className="chat-call-body">
          {type === 'video' ? (
            <div className="chat-call-video-grid">
              <div className="chat-call-video-local">
                <video ref={localVideoRef} autoPlay muted playsInline />
                {!isActive && (
                  <div className="chat-call-video-placeholder">
                    <User size={48} />
                  </div>
                )}
              </div>
              <div className="chat-call-video-remote">
                <video ref={remoteVideoRef} autoPlay playsInline />
                {!isActive && (
                  <div className="chat-call-video-placeholder">
                    <User size={48} />
                    <span>Esperando respuesta...</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="chat-call-audio-view">
              <div className="chat-call-audio-avatar">
                <Phone size={56} />
              </div>
              <div className="chat-call-audio-name">{participants[0]?.name ?? 'Usuario'}</div>
              <div className="chat-call-audio-status">{statusText}</div>
            </div>
          )}
        </div>

        <div className="chat-call-controls">
          <button
            type="button"
            className={`chat-call-control-btn ${muted ? 'active' : ''}`}
            onClick={toggleMute}
            aria-label={muted ? 'Activar micrófono' : 'Silenciar micrófono'}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          {type === 'video' && (
            <button
              type="button"
              className={`chat-call-control-btn ${videoOff ? 'active' : ''}`}
              onClick={toggleVideo}
              aria-label={videoOff ? 'Activar cámara' : 'Apagar cámara'}
            >
              {videoOff ? <VideoOff size={22} /> : <Video size={22} />}
            </button>
          )}
          <button
            type="button"
            className="chat-call-control-btn hangup"
            onClick={handleHangUp}
            aria-label="Colgar"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}
