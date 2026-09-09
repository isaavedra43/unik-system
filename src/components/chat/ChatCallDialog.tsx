'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, X, User } from 'lucide-react';
import type { ChatCallDTO } from '@/modules/chat/chat-events';

export interface ChatCallDialogProps {
  channelId: string;
  type: 'audio' | 'video';
  participants: { userId: string; name: string }[];
  currentUserId: string;
  onClose: () => void;
  /** 'caller' inicia la llamada, 'callee' la recibe */
  role?: 'caller' | 'callee';
  /** Datos de la llamada existente (modo callee) */
  callData?: ChatCallDTO | null;
}

interface CallState {
  status: 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended' | 'declined' | 'failed';
  callId: string | null;
  error: string | null;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export function ChatCallDialog({
  channelId,
  type,
  participants,
  onClose,
  role = 'caller',
  callData = null,
}: ChatCallDialogProps) {
  const [callState, setCallState] = useState<CallState>({
    status: role === 'callee' ? 'connecting' : 'initiating',
    callId: callData?.id ?? null,
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
  const calleeUserIdRef = useRef<string | null>(null);
  const callerUserIdRef = useRef<string | null>(null);
  const remoteDescriptionSetRef = useRef(false);

  const cleanup = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (signalPollRef.current) {
      clearInterval(signalPollRef.current);
      signalPollRef.current = null;
    }
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

  // =====================================================
  // Signal helpers
  // =====================================================

  const sendSignal = useCallback(
    async (callId: string, toUserId: string, signalType: string, signal: unknown) => {
      try {
        await fetch(`/app/chat/api/calls/${callId}/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toUserId,
            signalType,
            signal: JSON.stringify(signal),
          }),
        });
      } catch {
        // silent
      }
    },
    []
  );

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

          if (sig.signalType === 'offer' && role === 'callee') {
            // Callee receives offer
            if (!remoteDescriptionSetRef.current && pcRef.current.signalingState === 'stable') {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(signalData));
              remoteDescriptionSetRef.current = true;

              // Create and send answer
              const answer = await pcRef.current.createAnswer();
              await pcRef.current.setLocalDescription(answer);

              const callerId = callerUserIdRef.current;
              if (callerId) {
                await sendSignal(callId, callerId, 'answer', answer);
              }
            }
          } else if (sig.signalType === 'answer' && role === 'caller') {
            // Caller receives answer
            if (!remoteDescriptionSetRef.current && pcRef.current.signalingState === 'have-local-offer') {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(signalData));
              remoteDescriptionSetRef.current = true;
            }
          } else if (sig.signalType === 'ice' && signalData) {
            // Both sides receive ICE candidates
            if (remoteDescriptionSetRef.current) {
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(signalData));
              } catch {
                // ignore duplicate/invalid candidates
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      // silent
    }
  }, [role, sendSignal]);

  // =====================================================
  // Create RTCPeerConnection and setup handlers
  // =====================================================

  const createPeerConnection = useCallback(
    (callId: string, localStream: MediaStream) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
        event.streams[0]?.getTracks().forEach((track) => {
          remoteStream.addTrack(track);
        });
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
        }
        setCallState((prev) => ({
          ...prev,
          status: prev.status === 'active' ? 'active' : 'connecting',
        }));
      };

      // Send ICE candidates to the other party
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          const targetId = role === 'caller' ? calleeUserIdRef.current : callerUserIdRef.current;
          if (targetId) {
            await sendSignal(callId, targetId, 'ice', event.candidate);
          }
        }
      };

      // Connection state changes
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setCallState((prev) => ({ ...prev, status: 'active' }));
          if (!durationTimerRef.current) {
            durationTimerRef.current = setInterval(() => {
              setDuration((d) => d + 1);
            }, 1000);
          }
        } else if (pc.connectionState === 'disconnected') {
          setCallState((prev) => ({ ...prev, status: 'connecting' }));
        } else if (pc.connectionState === 'failed') {
          setCallState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'Conexión WebRTC fallida',
          }));
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected') {
          setCallState((prev) => ({ ...prev, status: 'active' }));
          if (!durationTimerRef.current) {
            durationTimerRef.current = setInterval(() => {
              setDuration((d) => d + 1);
            }, 1000);
          }
        }
      };

      return pc;
    },
    [role, sendSignal]
  );

  // =====================================================
  // CALLER: start call
  // =====================================================

  const startCallAsCaller = useCallback(async () => {
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
      const calleeUserId = participants[0]?.userId;
      calleeUserIdRef.current = calleeUserId ?? null;

      setCallState({ status: 'ringing', callId, error: null });

      // Create RTCPeerConnection
      const pc = createPeerConnection(callId, localStream);

      // Create offer
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video',
      });
      await pc.setLocalDescription(offer);

      // Send offer to callee
      if (calleeUserId) {
        await sendSignal(callId, calleeUserId, 'offer', offer);
      }

      // Start polling for signals (answer + ice from callee)
      signalPollRef.current = setInterval(() => pollSignals(callId), 500);
    } catch (err) {
      setCallState((prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error desconocido',
      }));
    }
  }, [channelId, type, participants, createPeerConnection, sendSignal, pollSignals]);

  // =====================================================
  // CALLEE: join existing call
  // =====================================================

  const joinCallAsCallee = useCallback(async () => {
    if (!callData) return;

    const callId = callData.id;
    const callerId = callData.callerId;
    callerUserIdRef.current = callerId;

    try {
      // Accept call via API
      await fetch(`/app/chat/api/calls/${callId}/accept`, {
        method: 'POST',
      }).catch(() => {});

      // Get local media
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: callData.type === 'video',
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = localStream;
      if (localVideoRef.current && callData.type === 'video') {
        localVideoRef.current.srcObject = localStream;
      }

      setCallState({ status: 'connecting', callId, error: null });

      // Create RTCPeerConnection
      createPeerConnection(callId, localStream);

      // Start polling for signals (offer + ice from caller)
      // The offer should arrive shortly from the caller
      signalPollRef.current = setInterval(() => pollSignals(callId), 500);
    } catch (err) {
      setCallState((prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error desconocido',
      }));
    }
  }, [callData, createPeerConnection, pollSignals]);

  // =====================================================
  // Start call on mount
  // =====================================================

  useEffect(() => {
    if (role === 'caller') {
      startCallAsCaller();
    } else {
      joinCallAsCallee();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHangUp = useCallback(async () => {
    if (callState.callId) {
      await fetch(`/app/chat/api/calls/${callState.callId}/end`, {
        method: 'POST',
      }).catch(() => {});
    }
    cleanup();
    setCallState((prev) => ({ ...prev, status: 'ended' }));
    setTimeout(onClose, 800);
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
  const callType = role === 'callee' ? callData?.type ?? type : type;
  const remoteName = role === 'callee' ? callData?.callerName : participants[0]?.name;

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
          {callType === 'video' ? (
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
              <div className="chat-call-audio-name">{remoteName ?? 'Usuario'}</div>
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
          {callType === 'video' && (
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
