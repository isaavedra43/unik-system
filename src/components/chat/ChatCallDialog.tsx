'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Phone, PhoneOff, Video, VideoOff, Mic, MicOff,
  Loader2, AlertCircle, Monitor, MonitorOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatCallDTO } from '@/modules/chat/chat-events';

export interface ChatCallDialogProps {
  channelId: string;
  type: 'audio' | 'video';
  participants: { userId: string; name: string }[];
  currentUserId: string;
  onClose: () => void;
  role?: 'caller' | 'callee';
  callData?: ChatCallDTO | null;
}

interface CallState {
  status: 'initiating' | 'ringing' | 'connecting' | 'active' | 'ended' | 'declined' | 'failed';
  callId: string | null;
  error: string | null;
}

interface RemoteParticipant {
  userId: string;
  name: string;
  stream: MediaStream | null;
  connected: boolean;
  screenSharing: boolean;
}

// =====================================================
// ICE servers — STUN + TURN for reliable NAT traversal
// =====================================================
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
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

const CONNECTION_TIMEOUT_MS = 30_000;

export function ChatCallDialog({
  channelId,
  type,
  participants,
  currentUserId,
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
  const [screenSharing, setScreenSharing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [remoteParticipants, setRemoteParticipants] = useState<Map<string, RemoteParticipant>>(new Map());

  // Refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const videoRefsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRefsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callIdRef = useRef<string | null>(null);
  const roleRef = useRef(role);
  const participantsRef = useRef(participants);
  const localStreamReadyRef = useRef(false);
  const pendingOffersRef = useRef<Map<string, RTCSessionDescriptionInit>>(new Map());
  const remoteDescSetRef = useRef<Set<string>>(new Set());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const senderVideoTrackRef = useRef<RTCRtpSender | null>(null);

  const log = useCallback((...args: unknown[]) => {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).DEV_CALL_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[ChatCall]', ...args);
    }
  }, []);

  // =====================================================
  // Cleanup
  // =====================================================
  const cleanup = useCallback(() => {
    if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
    if (signalPollRef.current) { clearInterval(signalPollRef.current); signalPollRef.current = null; }
    if (callStatusPollRef.current) { clearInterval(callStatusPollRef.current); callStatusPollRef.current = null; }
    if (connectionTimeoutRef.current) { clearTimeout(connectionTimeoutRef.current); connectionTimeoutRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach((t) => t.stop()); localStreamRef.current = null; }
    if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach((t) => t.stop()); screenStreamRef.current = null; }
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    remoteStreamsRef.current.clear();
    remoteDescSetRef.current.clear();
    pendingIceRef.current.clear();
    pendingOffersRef.current.clear();
    localStreamReadyRef.current = false;
  }, []);

  useEffect(() => { return () => cleanup(); }, [cleanup]);

  // =====================================================
  // Signal helpers
  // =====================================================
  const sendSignal = useCallback(async (callId: string, toUserId: string, signalType: string, signal: unknown) => {
    try {
      await fetch(`/app/chat/api/calls/${callId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId, signalType, signal: JSON.stringify(signal) }),
      });
    } catch (err) { log('sendSignal error:', err); }
  }, [log]);

  // =====================================================
  // Create a peer connection for a specific participant
  // =====================================================
  const createPeerConnection = useCallback((callId: string, remoteUserId: string, localStream: MediaStream) => {
    log('creating PC for', remoteUserId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcsRef.current.set(remoteUserId, pc);

    // Add local tracks
    localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video') {
        senderVideoTrackRef.current = sender;
      }
    });

    // Remote stream
    const remoteStream = new MediaStream();
    remoteStreamsRef.current.set(remoteUserId, remoteStream);

    // Attach to audio element
    const audioEl = remoteAudioRefsRef.current.get(remoteUserId);
    if (audioEl) {
      audioEl.srcObject = remoteStream;
    }

    pc.ontrack = (event) => {
      log('ontrack from', remoteUserId, 'kind:', event.track.kind);
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      if (event.streams[0] === undefined) remoteStream.addTrack(event.track);

      // Attach to video element
      const videoEl = videoRefsRef.current.get(remoteUserId);
      if (videoEl) videoEl.srcObject = remoteStream;
      const audioEl2 = remoteAudioRefsRef.current.get(remoteUserId);
      if (audioEl2) {
        audioEl2.srcObject = remoteStream;
        audioEl2.play().catch(() => {});
      }

      setRemoteParticipants((prev) => {
        const next = new Map(prev);
        const existing = next.get(remoteUserId) ?? { userId: remoteUserId, name: participantsRef.current.find((p) => p.userId === remoteUserId)?.name ?? 'Usuario', stream: null, connected: false, screenSharing: false };
        next.set(remoteUserId, { ...existing, stream: remoteStream, connected: true });
        return next;
      });
    };

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await sendSignal(callId, remoteUserId, 'ice', event.candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      log('ICE state for', remoteUserId, ':', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (connectionTimeoutRef.current) { clearTimeout(connectionTimeoutRef.current); connectionTimeoutRef.current = null; }
        setCallState((prev) => ({ ...prev, status: 'active' }));
        if (!durationTimerRef.current) {
          durationTimerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
        }
      } else if (pc.iceConnectionState === 'failed') {
        if (roleRef.current === 'caller') {
          log('ICE failed for', remoteUserId, '— attempting restart');
          pc.restartIce();
          pc.createOffer({ iceRestart: true })
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => sendSignal(callIdRef.current!, remoteUserId, 'offer', pc.localDescription))
            .catch((err) => log('ICE restart failed:', err));
        }
      }
    };

    pc.onconnectionstatechange = () => {
      log('PC state for', remoteUserId, ':', pc.connectionState);
      if (pc.connectionState === 'failed') {
        setCallState((prev) => ({ ...prev, status: 'failed', error: 'Conexión WebRTC fallida.' }));
      }
    };

    return pc;
  }, [sendSignal, log]);

  // =====================================================
  // Process incoming signals
  // =====================================================
  const processSignal = useCallback(async (
    callId: string,
    sig: { signalType: string; signal: string; fromUserId: string }
  ) => {
    const remoteUserId = sig.fromUserId;
    let pc = pcsRef.current.get(remoteUserId);

    try {
      const signalData = JSON.parse(sig.signal);

      if (sig.signalType === 'offer') {
        // Create PC if it doesn't exist (callee receiving offer from caller)
        if (!pc && localStreamRef.current) {
          pc = createPeerConnection(callId, remoteUserId, localStreamRef.current);
        }
        if (!pc) {
          // Buffer offer until local stream is ready
          pendingOffersRef.current.set(remoteUserId, signalData);
          return;
        }
        if (pc.signalingState === 'stable') {
          log('setting remote offer from', remoteUserId);
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          remoteDescSetRef.current.add(remoteUserId);

          // Process pending ICE
          const pending = pendingIceRef.current.get(remoteUserId) ?? [];
          for (const c of pending) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
          pendingIceRef.current.delete(remoteUserId);

          // Create and send answer
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal(callId, remoteUserId, 'answer', answer);
        }
      } else if (sig.signalType === 'answer') {
        if (pc && pc.signalingState === 'have-local-offer') {
          log('setting remote answer from', remoteUserId);
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          remoteDescSetRef.current.add(remoteUserId);

          const pending = pendingIceRef.current.get(remoteUserId) ?? [];
          for (const c of pending) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
          pendingIceRef.current.delete(remoteUserId);
        }
      } else if (sig.signalType === 'ice') {
        if (pc && remoteDescSetRef.current.has(remoteUserId)) {
          try { await pc.addIceCandidate(new RTCIceCandidate(signalData)); } catch {}
        } else {
          // Buffer
          const arr = pendingIceRef.current.get(remoteUserId) ?? [];
          arr.push(signalData);
          pendingIceRef.current.set(remoteUserId, arr);
        }
      }
    } catch (err) {
      log('processSignal error:', err);
    }
  }, [createPeerConnection, sendSignal, log]);

  // =====================================================
  // Poll signals
  // =====================================================
  const pollSignals = useCallback(async (callId: string) => {
    try {
      const res = await fetch(`/app/chat/api/calls/${callId}/signal`);
      if (!res.ok) return;
      const data = await res.json();
      const signals: Array<{ signalType: string; signal: string; fromUserId: string }> = data.data ?? [];
      for (const sig of signals) {
        await processSignal(callId, sig);
      }
    } catch (err) { log('pollSignals error:', err); }
  }, [processSignal, log]);

  // =====================================================
  // Poll call status
  // =====================================================
  const pollCallStatus = useCallback(async (callId: string) => {
    try {
      const res = await fetch(`/app/chat/api/calls/${callId}/status`);
      if (!res.ok) return;
      const data = await res.json();
      const call: ChatCallDTO | undefined = data.data;
      if (!call) return;
      if (call.status === 'ended' || call.status === 'missed' || call.status === 'declined') {
        log('call status:', call.status);
        cleanup();
        setCallState((prev) => ({ ...prev, status: call.status === 'declined' ? 'declined' : 'ended' }));
        setTimeout(onClose, 800);
      }
    } catch {}
  }, [cleanup, onClose, log]);

  const startConnectionTimeout = useCallback(() => {
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = setTimeout(() => {
      const allConnected = pcsRef.current.size > 0 && Array.from(pcsRef.current.values()).every((pc) => pc.connectionState === 'connected');
      if (!allConnected) {
        setCallState((prev) => ({ ...prev, status: 'failed', error: 'Tiempo de conexión agotado. Verifica tu red.' }));
      }
    }, CONNECTION_TIMEOUT_MS);
  }, []);

  // =====================================================
  // Get local media
  // =====================================================
  const getLocalMedia = useCallback(async (callType: 'audio' | 'video') => {
    const constraints: MediaStreamConstraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: callType === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    localStreamReadyRef.current = true;
    if (localVideoRef.current && callType === 'video') {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }, []);

  // =====================================================
  // CALLER: start call — create offers for ALL participants
  // =====================================================
  const startCallAsCaller = useCallback(async () => {
    try {
      log('caller: starting');
      const localStream = await getLocalMedia(type);

      let callId: string;
      if (callData?.id) {
        callId = callData.id;
      } else {
        const res = await fetch('/app/chat/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId, type, participantIds: participants.map((p) => p.userId) }),
        });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Error al iniciar'); }
        const data = await res.json();
        callId = data.data.id;
      }
      callIdRef.current = callId;
      setCallState({ status: 'ringing', callId, error: null });

      // Create a peer connection + offer for EACH participant
      for (const p of participants) {
        if (p.userId === currentUserId) continue;
        const pc = createPeerConnection(callId, p.userId, localStream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(callId, p.userId, 'offer', offer);
      }

      signalPollRef.current = setInterval(() => pollSignals(callId), 300);
      callStatusPollRef.current = setInterval(() => pollCallStatus(callId), 1000);
      startConnectionTimeout();
    } catch (err) {
      log('caller error:', err);
      const msg = err instanceof Error ? err.message : 'Error';
      setCallState((prev) => ({
        ...prev, status: 'failed',
        error: msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Permiso de micrófono/cámara denegado.'
          : msg.includes('NotFound') ? 'No se encontró micrófono/cámara.' : msg,
      }));
    }
  }, [channelId, type, participants, callData, currentUserId, createPeerConnection, sendSignal, pollSignals, pollCallStatus, startConnectionTimeout, getLocalMedia, log]);

  // =====================================================
  // CALLEE: join call — create PCs and wait for offers
  // =====================================================
  const joinCallAsCallee = useCallback(async () => {
    if (!callData) return;
    const callId = callData.id;
    callIdRef.current = callId;
    log('callee: joining', callId);

    try {
      await fetch(`/app/chat/api/calls/${callId}/accept`, { method: 'POST' }).catch(() => {});
      const localStream = await getLocalMedia(callData.type);
      setCallState({ status: 'connecting', callId, error: null });

      // Process any buffered offers
      for (const [remoteUserId, offer] of pendingOffersRef.current) {
        const pc = createPeerConnection(callId, remoteUserId, localStream);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        remoteDescSetRef.current.add(remoteUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(callId, remoteUserId, 'answer', answer);
      }
      pendingOffersRef.current.clear();

      signalPollRef.current = setInterval(() => pollSignals(callId), 300);
      callStatusPollRef.current = setInterval(() => pollCallStatus(callId), 1000);
      startConnectionTimeout();
    } catch (err) {
      log('callee error:', err);
      const msg = err instanceof Error ? err.message : 'Error';
      setCallState((prev) => ({
        ...prev, status: 'failed',
        error: msg.includes('Permission') || msg.includes('NotAllowed')
          ? 'Permiso de micrófono/cámara denegado.'
          : msg.includes('NotFound') ? 'No se encontró micrófono/cámara.' : msg,
      }));
    }
  }, [callData, createPeerConnection, sendSignal, pollSignals, pollCallStatus, startConnectionTimeout, getLocalMedia, log]);

  useEffect(() => {
    if (role === 'caller') startCallAsCaller();
    else joinCallAsCallee();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =====================================================
  // Controls
  // =====================================================
  const handleHangUp = useCallback(async () => {
    const callId = callIdRef.current;
    if (callId) await fetch(`/app/chat/api/calls/${callId}/end`, { method: 'POST' }).catch(() => {});
    cleanup();
    setCallState((prev) => ({ ...prev, status: 'ended' }));
    setTimeout(onClose, 500);
  }, [cleanup, onClose]);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = muted; });
      setMuted(!muted);
    }
  }, [muted]);

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = videoOff; });
      setVideoOff(!videoOff);
    }
  }, [videoOff]);

  // =====================================================
  // Screen sharing
  // =====================================================
  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      // Stop screen share, restore camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      // Replace screen track with camera track in all PCs
      if (localStreamRef.current) {
        const cameraTrack = localStreamRef.current.getVideoTracks()[0];
        if (cameraTrack) {
          pcsRef.current.forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(cameraTrack);
          });
          if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
        }
      }
      setScreenSharing(false);
    } else {
      // Start screen share
      try {
        // Desktop: getDisplayMedia. Mobile: fallback to back camera
        let screenStream: MediaStream;
        if (navigator.mediaDevices.getDisplayMedia) {
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        } else {
          // Mobile fallback: switch to back camera
          screenStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
          });
        }
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace camera track with screen track in all PCs
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });

        // Show screen in local preview
        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;

        // Auto-stop when user stops sharing via browser UI
        screenTrack.onended = () => {
          if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach((t) => t.stop());
            screenStreamRef.current = null;
          }
          if (localStreamRef.current) {
            const cameraTrack = localStreamRef.current.getVideoTracks()[0];
            if (cameraTrack) {
              pcsRef.current.forEach((pc) => {
                const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(cameraTrack);
              });
              if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
            }
          }
          setScreenSharing(false);
        };

        setScreenSharing(true);
      } catch (err) {
        log('screen share error:', err);
      }
    }
  }, [screenSharing, log]);

  // =====================================================
  // Render helpers
  // =====================================================
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
  const isConnecting = callState.status === 'ringing' || callState.status === 'connecting';
  const callType = role === 'callee' ? callData?.type ?? type : type;
  const remoteList = Array.from(remoteParticipants.values());
  const remoteCount = remoteList.length;
  const isMultiParty = remoteCount > 1;

  const statusDotClass = {
    initiating: 'ringing',
    ringing: 'ringing',
    connecting: 'connecting',
    active: 'active',
    ended: 'ended',
    declined: 'declined',
    failed: 'failed',
  }[callState.status];

  return (
    <>
      {/* Hidden audio elements for each remote participant */}
      {participants.filter((p) => p.userId !== currentUserId).map((p) => (
        <audio key={`audio-${p.userId}`} ref={(el) => { if (el) remoteAudioRefsRef.current.set(p.userId, el); }} autoPlay playsInline className="hidden" />
      ))}

      <div className="chat-call-overlay" role="dialog" aria-modal="true" aria-label={callType === 'video' ? 'Videollamada' : 'Llamada de voz'}>
        {/* Top bar */}
        <div className="chat-call-topbar">
          <div className="chat-call-info">
            <div>
              <div className="chat-call-info-name">
                {isMultiParty ? `${remoteCount + 1} participantes` : (remoteList[0]?.name ?? participants[0]?.name ?? 'Usuario')}
              </div>
              <div className="chat-call-info-status">
                <span className={cn('chat-call-status-dot', statusDotClass)} />
                {statusText}
              </div>
            </div>
          </div>
          {callState.status === 'failed' && callState.error && (
            <div className="flex items-center gap-1 text-xs text-red-400">
              <AlertCircle size={14} /> {callState.error}
            </div>
          )}
        </div>

        {/* Screen share banner */}
        {screenSharing && (
          <div className="chat-call-screen-share-banner">
            <Monitor size={16} /> Compartiendo pantalla
          </div>
        )}

        {/* Stage */}
        <div className="chat-call-stage">
          {callType === 'video' && remoteCount > 0 ? (
            isMultiParty ? (
              /* Multi-participant grid */
              <div className="chat-call-grid" data-count={String(remoteCount + 1)}>
                {/* Remote participants */}
                {remoteList.map((rp) => (
                  <div key={rp.userId} className={cn('chat-call-tile', rp.screenSharing && 'chat-call-tile-screen-share')}>
                    <video
                      ref={(el) => { if (el) videoRefsRef.current.set(rp.userId, el); }}
                      autoPlay playsInline
                      className={rp.connected ? '' : 'opacity-0'}
                    />
                    {!rp.connected && (
                      <div className="chat-call-tile-placeholder">
                        <div className="chat-call-tile-placeholder-avatar">
                          {rp.name.slice(0, 2).toUpperCase()}
                        </div>
                        <span>{rp.name}</span>
                      </div>
                    )}
                    <div className="chat-call-tile-label">
                      {rp.name}
                    </div>
                  </div>
                ))}
                {/* Local tile in grid */}
                <div className="chat-call-tile">
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <div className="chat-call-tile-label">Tú</div>
                </div>
              </div>
            ) : (
              /* 1-on-1: main remote video + PiP local */
              <>
                <video
                  ref={(el) => { if (el && remoteList[0]) videoRefsRef.current.set(remoteList[0].userId, el); }}
                  autoPlay playsInline
                  className="chat-call-main-video"
                />
                {!isActive && (
                  <div className="chat-call-connecting">
                    <div className="chat-call-connecting-spinner" />
                    <div className="chat-call-connecting-text">{statusText}</div>
                  </div>
                )}
                {/* PiP local */}
                {callType === 'video' && (
                  <div className="chat-call-pip">
                    <video ref={localVideoRef} autoPlay muted playsInline />
                    <div className="chat-call-pip-label">Tú</div>
                  </div>
                )}
              </>
            )
          ) : (
            /* Audio-only view */
            <div className="chat-call-audio-view">
              <div className="chat-call-audio-avatar">
                {remoteList[0]?.name ? remoteList[0].name.slice(0, 2).toUpperCase() : <Phone size={48} />}
              </div>
              <div className="chat-call-audio-name">{remoteList[0]?.name ?? participants[0]?.name ?? 'Usuario'}</div>
              <div className="chat-call-audio-status">
                {isConnecting && <Loader2 size={16} className="animate-spin" />}
                {statusText}
              </div>
            </div>
          )}

          {/* Error overlay */}
          {callState.status === 'failed' && (
            <div className="chat-call-error">
              <div className="chat-call-error-icon">
                <AlertCircle size={32} />
              </div>
              <div className="chat-call-error-msg">{callState.error}</div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="chat-call-controls">
          <button className={cn('chat-call-ctrl', muted && 'active')} onClick={toggleMute} aria-label={muted ? 'Activar micrófono' : 'Silenciar'}>
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          {callType === 'video' && (
            <>
              <button className={cn('chat-call-ctrl', videoOff && 'active')} onClick={toggleVideo} aria-label={videoOff ? 'Activar cámara' : 'Apagar cámara'}>
                {videoOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
              <button className={cn('chat-call-ctrl chat-call-ctrl-screen', screenSharing && 'active')} onClick={toggleScreenShare} aria-label={screenSharing ? 'Dejar de compartir' : 'Compartir pantalla'}>
                {screenSharing ? <MonitorOff size={22} /> : <Monitor size={22} />}
              </button>
            </>
          )}
          <button className="chat-call-ctrl chat-call-ctrl-hangup" onClick={handleHangUp} aria-label="Colgar">
            <PhoneOff size={24} />
          </button>
        </div>
      </div>
    </>
  );
}
