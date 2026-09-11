'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, User, Loader2, AlertCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/shadcn/dialog';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { cn } from '@/lib/utils';
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
  const callStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const calleeUserIdRef = useRef<string | null>(null);
  const callerUserIdRef = useRef<string | null>(null);
  const remoteDescriptionSetRef = useRef(false);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const cleanup = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (signalPollRef.current) {
      clearInterval(signalPollRef.current);
      signalPollRef.current = null;
    }
    if (callStatusPollRef.current) {
      clearInterval(callStatusPollRef.current);
      callStatusPollRef.current = null;
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

              // Process any buffered ICE candidates
              for (const candidate of pendingIceCandidatesRef.current) {
                try {
                  await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                } catch {
                  // ignore duplicate/invalid candidates
                }
              }
              pendingIceCandidatesRef.current = [];

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

              // Process any buffered ICE candidates
              for (const candidate of pendingIceCandidatesRef.current) {
                try {
                  await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                } catch {
                  // ignore duplicate/invalid candidates
                }
              }
              pendingIceCandidatesRef.current = [];
            }
          } else if (sig.signalType === 'ice' && signalData) {
            // Both sides receive ICE candidates
            if (remoteDescriptionSetRef.current) {
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(signalData));
              } catch {
                // ignore duplicate/invalid candidates
              }
            } else {
              // Buffer ICE candidates until remote description is set
              pendingIceCandidatesRef.current.push(signalData);
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
  // Poll call status (detect when the other party hangs up)
  // =====================================================

  const pollCallStatus = useCallback(async (callId: string) => {
    try {
      const res = await fetch(`/app/chat/api/calls/${callId}/status`);
      if (!res.ok) return;
      const data = await res.json();
      const call: ChatCallDTO | undefined = data.data;

      if (!call) return;

      // If the call has ended/missed/declined, close the dialog
      if (call.status === 'ended' || call.status === 'missed' || call.status === 'declined') {
        cleanup();
        setCallState((prev) => ({
          ...prev,
          status: call.status === 'declined' ? 'declined' : 'ended',
        }));
        setTimeout(onClose, 800);
      }
    } catch {
      // silent
    }
  }, [cleanup, onClose]);

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

      // Use existing call data if the call was already created by the parent
      // (ChatConversation.startCall already called the API). Only create a
      // new call if we don't have one yet.
      let callId: string;
      if (callData?.id) {
        callId = callData.id;
      } else {
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
        callId = data.data.id;
      }

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
      signalPollRef.current = setInterval(() => pollSignals(callId), 300);

      // Start polling for call status (detect when callee accepts/declines/ends)
      callStatusPollRef.current = setInterval(() => pollCallStatus(callId), 1000);
    } catch (err) {
      setCallState((prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error desconocido',
      }));
    }
  }, [channelId, type, participants, callData, createPeerConnection, sendSignal, pollSignals, pollCallStatus]);

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
      signalPollRef.current = setInterval(() => pollSignals(callId), 300);

      // Start polling for call status (detect when caller hangs up)
      callStatusPollRef.current = setInterval(() => pollCallStatus(callId), 1000);
    } catch (err) {
      setCallState((prev) => ({
        ...prev,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Error desconocido',
      }));
    }
  }, [callData, createPeerConnection, pollSignals, pollCallStatus]);

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

  const statusColor = {
    initiating: 'bg-muted-foreground',
    ringing: 'bg-info animate-pulse',
    connecting: 'bg-warning animate-pulse',
    active: 'bg-success',
    ended: 'bg-muted-foreground',
    declined: 'bg-destructive',
    failed: 'bg-destructive',
  }[callState.status];

  return (
    <Dialog open onOpenChange={(v) => !v && handleHangUp()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 overflow-hidden gap-0 bg-background"
      >
        <DialogTitle className="sr-only">
          {callType === 'video' ? 'Videollamada' : 'Llamada de voz'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Estado: {statusText}
        </DialogDescription>

        {/* Header with status */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className={cn('size-2.5 rounded-full', statusColor)} />
            <span className="text-sm font-medium text-foreground">{statusText}</span>
          </div>
          {callState.status === 'failed' && callState.error && (
            <div className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle size={14} /> {callState.error}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="relative flex-1 min-h-[280px] bg-black/5 dark:bg-black/30">
          {callType === 'video' ? (
            <div className="grid grid-cols-2 gap-1 p-2 h-full">
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
                <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                {!isActive && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <User size={32} className="text-white/70" />
                  </div>
                )}
                <span className="absolute bottom-1 left-1 text-[10px] text-white bg-black/50 px-1.5 py-0.5 rounded">
                  Tú
                </span>
              </div>
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
                <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                {!isActive && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50">
                    {callState.status === 'ringing' || callState.status === 'connecting' ? (
                      <Loader2 size={32} className="text-white/70 animate-spin" />
                    ) : (
                      <User size={32} className="text-white/70" />
                    )}
                    <span className="text-xs text-white/70">Esperando respuesta...</span>
                  </div>
                )}
                <span className="absolute bottom-1 left-1 text-[10px] text-white bg-black/50 px-1.5 py-0.5 rounded">
                  {remoteName ?? 'Usuario'}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-8 h-full">
              <Avatar className="size-20">
                <AvatarFallback className="text-2xl font-semibold bg-primary text-primary-foreground">
                  {remoteName ? remoteName.slice(0, 2).toUpperCase() : <Phone size={32} />}
                </AvatarFallback>
              </Avatar>
              <div className="text-lg font-semibold text-foreground">{remoteName ?? 'Usuario'}</div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {(callState.status === 'ringing' || callState.status === 'connecting') && (
                  <Loader2 size={14} className="animate-spin" />
                )}
                {statusText}
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-3 p-4 border-t border-border">
          <Button
            variant={muted ? 'secondary' : 'outline'}
            size="icon"
            className="size-12 rounded-full"
            onClick={toggleMute}
            aria-label={muted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-pressed={muted}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </Button>
          {callType === 'video' && (
            <Button
              variant={videoOff ? 'secondary' : 'outline'}
              size="icon"
              className="size-12 rounded-full"
              onClick={toggleVideo}
              aria-label={videoOff ? 'Activar cámara' : 'Apagar cámara'}
              aria-pressed={videoOff}
            >
              {videoOff ? <VideoOff size={22} /> : <Video size={22} />}
            </Button>
          )}
          <Button
            variant="destructive"
            size="icon"
            className="size-12 rounded-full"
            onClick={handleHangUp}
            aria-label="Colgar"
          >
            <PhoneOff size={22} />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
