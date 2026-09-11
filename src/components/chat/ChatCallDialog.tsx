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

// =====================================================
// ICE servers — STUN + TURN for reliable NAT traversal
// STUN servers discover public IP addresses.
// TURN servers relay traffic when direct P2P fails
// (symmetric NAT, restrictive firewalls, etc.).
// Without TURN, WebRTC connections fail in many
// real-world network configurations.
// =====================================================
const ICE_SERVERS: RTCIceServer[] = [
  // Google STUN servers (fast, reliable for discovery)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // OpenRelay free TURN servers (relay fallback for NAT)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
};

// Connection timeout: if WebRTC doesn't connect within 30s, show error
const CONNECTION_TIMEOUT_MS = 30_000;

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
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calleeUserIdRef = useRef<string | null>(null);
  const callerUserIdRef = useRef<string | null>(null);
  const remoteDescriptionSetRef = useRef(false);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callIdRef = useRef<string | null>(null);
  const roleRef = useRef(role);
  const restartAttemptedRef = useRef(false);

  const log = useCallback((...args: unknown[]) => {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).DEV_CALL_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[ChatCall]', ...args);
    }
  }, []);

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
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteDescriptionSetRef.current = false;
    pendingIceCandidatesRef.current = [];
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
      } catch (err) {
        log('sendSignal error:', err);
      }
    },
    [log]
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

          if (sig.signalType === 'offer' && roleRef.current === 'callee') {
            // Callee receives offer (initial or ICE restart)
            // For initial offer: signalingState is 'stable' and remoteDescription not set
            // For ICE restart offer: signalingState is 'stable' (after renegotiation)
            // but remoteDescription was already set — we allow override
            if (pcRef.current.signalingState === 'stable') {
              log('callee: setting remote description from offer (initial or restart)');
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
              log('callee: sending answer');

              const callerId = callerUserIdRef.current;
              if (callerId) {
                await sendSignal(callId, callerId, 'answer', answer);
              }
            }
          } else if (sig.signalType === 'answer' && roleRef.current === 'caller') {
            // Caller receives answer (initial or after ICE restart)
            if (pcRef.current.signalingState === 'have-local-offer') {
              log('caller: setting remote description from answer');
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
        } catch (err) {
          log('pollSignals: error processing signal:', err);
        }
      }
    } catch (err) {
      log('pollSignals fetch error:', err);
    }
  }, [sendSignal, log]);

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
        log('call status changed to', call.status);
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
  }, [cleanup, onClose, log]);

  // =====================================================
  // Start connection timeout
  // =====================================================

  const startConnectionTimeout = useCallback(() => {
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = setTimeout(() => {
      if (pcRef.current && pcRef.current.connectionState !== 'connected') {
        log('connection timeout reached, state:', pcRef.current.connectionState);
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Tiempo de conexión agotado. Verifica tu red o firewall.',
        }));
      }
    }, CONNECTION_TIMEOUT_MS);
  }, [log]);

  // =====================================================
  // Create RTCPeerConnection and setup handlers
  // =====================================================

  const createPeerConnection = useCallback(
    (callId: string, localStream: MediaStream) => {
      log('creating RTCPeerConnection with ICE servers');
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      // Add local tracks
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });

      // Handle remote tracks
      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;
      // Attach to video element (for video calls)
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      // Attach to audio element (for audio-only calls — this is critical:
      // without an audio element playing the stream, remote audio is silent)
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
      pc.ontrack = (event) => {
        log('ontrack received, kind:', event.track.kind);
        event.streams[0]?.getTracks().forEach((track) => {
          remoteStream.addTrack(track);
        });
        // Also handle single track case (some browsers)
        if (event.streams[0] === undefined) {
          remoteStream.addTrack(event.track);
        }
        // Ensure both elements have the stream
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
        }
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          // Force play — browsers block autoplay unless explicitly triggered
          remoteAudioRef.current.play().catch(() => {
            log('audio autoplay blocked — will retry on user interaction');
          });
        }
        setCallState((prev) => ({
          ...prev,
          status: prev.status === 'active' ? 'active' : 'connecting',
        }));
      };

      // Send ICE candidates to the other party
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          const targetId = roleRef.current === 'caller' ? calleeUserIdRef.current : callerUserIdRef.current;
          if (targetId) {
            await sendSignal(callId, targetId, 'ice', event.candidate);
          } else {
            log('onicecandidate: no target user ID set!');
          }
        } else {
          log('ICE gathering complete');
        }
      };

      // ICE gathering state changes
      pc.onicegatheringstatechange = () => {
        log('ICE gathering state:', pc.iceGatheringState);
      };

      // ICE connection state changes
      pc.oniceconnectionstatechange = () => {
        log('ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          setCallState((prev) => ({ ...prev, status: 'active' }));
          if (!durationTimerRef.current) {
            durationTimerRef.current = setInterval(() => {
              setDuration((d) => d + 1);
            }, 1000);
          }
        } else if (pc.iceConnectionState === 'disconnected') {
          setCallState((prev) => ({ ...prev, status: 'connecting' }));
        } else if (pc.iceConnectionState === 'failed') {
          // Attempt ICE restart once before giving up
          if (!restartAttemptedRef.current && roleRef.current === 'caller') {
            restartAttemptedRef.current = true;
            log('ICE failed — attempting restart with new offer');
            try {
              pc.restartIce();
              // restartIce() alone doesn't create a new offer — we must
              // create one with iceRestart and send it to the callee
              pc.createOffer({ iceRestart: true })
                .then((restartOffer) => pc.setLocalDescription(restartOffer))
                .then(() => {
                  const targetId = calleeUserIdRef.current;
                  const cId = callIdRef.current;
                  if (targetId && cId) {
                    return sendSignal(cId, targetId, 'offer', pc.localDescription);
                  }
                })
                .catch((err) => log('ICE restart offer failed:', err));
            } catch {
              // restartIce not supported, will fall through to failed state
            }
          } else {
            setCallState((prev) => ({
              ...prev,
              status: 'failed',
              error: 'Conexión fallida. Posible firewall o NAT restrictivo.',
            }));
          }
        }
      };

      // Peer connection state changes
      pc.onconnectionstatechange = () => {
        log('PC connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          setCallState((prev) => ({ ...prev, status: 'active' }));
          if (!durationTimerRef.current) {
            durationTimerRef.current = setInterval(() => {
              setDuration((d) => d + 1);
            }, 1000);
          }
        } else if (pc.connectionState === 'disconnected') {
          setCallState((prev) => ({ ...prev, status: 'connecting' }));
        } else if (pc.connectionState === 'failed') {
          if (!restartAttemptedRef.current && roleRef.current === 'caller') {
            restartAttemptedRef.current = true;
            log('PC failed — attempting ICE restart with new offer');
            try {
              pc.restartIce();
              pc.createOffer({ iceRestart: true })
                .then((restartOffer) => pc.setLocalDescription(restartOffer))
                .then(() => {
                  const targetId = calleeUserIdRef.current;
                  const cId = callIdRef.current;
                  if (targetId && cId) {
                    return sendSignal(cId, targetId, 'offer', pc.localDescription);
                  }
                })
                .catch((err) => log('ICE restart offer failed:', err));
            } catch {
              // fall through
            }
          } else {
            setCallState((prev) => ({
              ...prev,
              status: 'failed',
              error: 'Conexión WebRTC fallida. Verifica red y permisos.',
            }));
          }
        }
      };

      // Signaling state changes
      pc.onsignalingstatechange = () => {
        log('signaling state:', pc.signalingState);
      };

      return pc;
    },
    [sendSignal, log]
  );

  // =====================================================
  // CALLER: start call
  // =====================================================

  const startCallAsCaller = useCallback(async () => {
    try {
      log('caller: starting call');
      // Get local media
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      };
      const localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = localStream;
      if (localVideoRef.current && type === 'video') {
        localVideoRef.current.srcObject = localStream;
      }

      // Use existing call data if the call was already created by the parent
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

      callIdRef.current = callId;
      const calleeUserId = participants[0]?.userId;
      calleeUserIdRef.current = calleeUserId ?? null;

      if (!calleeUserId) {
        throw new Error('No se encontró el usuario destino');
      }

      setCallState({ status: 'ringing', callId, error: null });

      // Create RTCPeerConnection
      const pc = createPeerConnection(callId, localStream);

      // Create offer — modern WebRTC: tracks are already added,
      // no need for deprecated offerToReceiveAudio/Video options
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log('caller: offer created and set as local description');

      // Send offer to callee
      await sendSignal(callId, calleeUserId, 'offer', offer);

      // Start polling for signals (answer + ice from callee)
      signalPollRef.current = setInterval(() => pollSignals(callId), 300);

      // Start polling for call status (detect when callee accepts/declines/ends)
      callStatusPollRef.current = setInterval(() => pollCallStatus(callId), 1000);

      // Start connection timeout
      startConnectionTimeout();
    } catch (err) {
      log('caller: error starting call:', err);
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      // Provide more helpful messages for common errors
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Permiso de micrófono/cámara denegado. Autoriza el acceso en el navegador.',
        }));
      } else if (msg.includes('NotFound') || msg.includes('DevicesNotFound')) {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'No se encontró micrófono o cámara en el dispositivo.',
        }));
      } else {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: msg,
        }));
      }
    }
  }, [channelId, type, participants, callData, createPeerConnection, sendSignal, pollSignals, pollCallStatus, startConnectionTimeout, log]);

  // =====================================================
  // CALLEE: join existing call
  // =====================================================

  const joinCallAsCallee = useCallback(async () => {
    if (!callData) return;

    const callId = callData.id;
    const callerId = callData.callerId;
    callIdRef.current = callId;
    callerUserIdRef.current = callerId;
    log('callee: joining call', callId, 'caller:', callerId);

    try {
      // Accept call via API
      await fetch(`/app/chat/api/calls/${callId}/accept`, {
        method: 'POST',
      }).catch(() => {});

      // Get local media with professional constraints
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: callData.type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
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

      // Start connection timeout
      startConnectionTimeout();
    } catch (err) {
      log('callee: error joining call:', err);
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Permiso de micrófono/cámara denegado. Autoriza el acceso en el navegador.',
        }));
      } else if (msg.includes('NotFound') || msg.includes('DevicesNotFound')) {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'No se encontró micrófono o cámara en el dispositivo.',
        }));
      } else {
        setCallState((prev) => ({
          ...prev,
          status: 'failed',
          error: msg,
        }));
      }
    }
  }, [callData, createPeerConnection, pollSignals, pollCallStatus, startConnectionTimeout, log]);

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
    const callId = callIdRef.current;
    if (callId) {
      await fetch(`/app/chat/api/calls/${callId}/end`, {
        method: 'POST',
      }).catch(() => {});
    }
    cleanup();
    setCallState((prev) => ({ ...prev, status: 'ended' }));
    setTimeout(onClose, 800);
  }, [cleanup, onClose]);

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
        {/* Hidden audio element — ALWAYS rendered so remote audio plays
            even in audio-only calls. Without this, the remote MediaStream
            has no element to play through and audio is silent. */}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

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
