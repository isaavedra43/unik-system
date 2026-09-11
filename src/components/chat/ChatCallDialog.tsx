'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Phone, PhoneOff, Video, VideoOff, Mic, MicOff,
  Loader2, AlertCircle, Monitor, MonitorOff,
  Maximize2, Minimize2, SwitchCamera, Signal,
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
  connected: boolean;
  hasVideo: boolean;
  screenSharing: boolean;
}

// =====================================================
// ICE servers — STUN + TURN for NAT traversal
// =====================================================
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
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
  const [fullscreen, setFullscreen] = useState(false);
  const [remoteParticipants, setRemoteParticipants] = useState<RemoteParticipant[]>([]);
  const [networkQuality, setNetworkQuality] = useState<'good' | 'medium' | 'poor' | 'unknown'>('unknown');
  const [tick, setTick] = useState(0); // force re-render to attach streams

  // Refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const videoRefsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRefsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const overlayRef = useRef<HTMLDivElement>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callIdRef = useRef<string | null>(null);
  const roleRef = useRef(role);
  const pendingOffersRef = useRef<Map<string, RTCSessionDescriptionInit>>(new Map());
  const remoteDescSetRef = useRef<Set<string>>(new Set());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const facingModeRef = useRef<'user' | 'environment'>('user');

  const log = useCallback((...args: unknown[]) => {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).DEV_CALL_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[ChatCall]', ...args);
    }
  }, []);

  // All remote user IDs (everyone except me)
  const remoteUserIds = participants.filter((p) => p.userId !== currentUserId).map((p) => p.userId);
  const remoteNamesRef = useRef(new Map(participants.map((p) => [p.userId, p.name])));

  // =====================================================
  // Cleanup
  // =====================================================
  const cleanup = useCallback(() => {
    if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
    if (signalPollRef.current) { clearInterval(signalPollRef.current); signalPollRef.current = null; }
    if (callStatusPollRef.current) { clearInterval(callStatusPollRef.current); callStatusPollRef.current = null; }
    if (connectionTimeoutRef.current) { clearTimeout(connectionTimeoutRef.current); connectionTimeoutRef.current = null; }
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach((t) => t.stop()); localStreamRef.current = null; }
    if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach((t) => t.stop()); screenStreamRef.current = null; }
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    remoteStreamsRef.current.clear();
    remoteDescSetRef.current.clear();
    pendingIceRef.current.clear();
    pendingOffersRef.current.clear();
  }, []);

  useEffect(() => { return () => cleanup(); }, [cleanup]);

  // =====================================================
  // Attach remote streams to video elements
  // This runs on every render + tick to ensure streams
  // are always attached even if elements mount late.
  // =====================================================
  useEffect(() => {
    remoteUserIds.forEach((uid) => {
      const stream = remoteStreamsRef.current.get(uid);
      const videoEl = videoRefsRef.current.get(uid);
      const audioEl = remoteAudioRefsRef.current.get(uid);
      if (stream && videoEl && videoEl.srcObject !== stream) {
        log('attaching stream to video for', uid);
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {});
      }
      if (stream && audioEl && audioEl.srcObject !== stream) {
        log('attaching stream to audio for', uid);
        audioEl.srcObject = stream;
        audioEl.play().catch(() => {});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, remoteParticipants]);

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
  // Update remote participant state
  // =====================================================
  const updateRemoteParticipant = useCallback((userId: string, updates: Partial<RemoteParticipant>) => {
    setRemoteParticipants((prev) => {
      const existing = prev.find((p) => p.userId === userId);
      if (existing) {
        return prev.map((p) => p.userId === userId ? { ...p, ...updates } : p);
      }
      return [...prev, {
        userId,
        name: remoteNamesRef.current.get(userId) ?? 'Usuario',
        connected: false,
        hasVideo: false,
        screenSharing: false,
        ...updates,
      }];
    });
    setTick((t) => t + 1);
  }, []);

  // =====================================================
  // Create a peer connection for a specific participant
  // =====================================================
  const createPeerConnection = useCallback((callId: string, remoteUserId: string, localStream: MediaStream) => {
    log('creating PC for', remoteUserId);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcsRef.current.set(remoteUserId, pc);

    // Add local tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // Remote stream
    const remoteStream = new MediaStream();
    remoteStreamsRef.current.set(remoteUserId, remoteStream);

    pc.ontrack = (event) => {
      log('ontrack from', remoteUserId, 'kind:', event.track.kind);
      // Add track to remote stream
      event.streams[0]?.getTracks().forEach((track) => {
        if (!remoteStream.getTracks().includes(track)) {
          remoteStream.addTrack(track);
        }
      });
      if (event.streams[0] === undefined) {
        remoteStream.addTrack(event.track);
      }

      // Update state to trigger re-render + stream attachment
      updateRemoteParticipant(remoteUserId, {
        connected: true,
        hasVideo: remoteStream.getVideoTracks().length > 0,
      });

      // Force immediate attachment
      setTick((t) => t + 1);
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
      } else if (pc.iceConnectionState === 'disconnected') {
        setCallState((prev) => ({ ...prev, status: 'connecting' }));
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
    };

    return pc;
  }, [sendSignal, log, updateRemoteParticipant]);

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
        if (!pc && localStreamRef.current) {
          pc = createPeerConnection(callId, remoteUserId, localStreamRef.current);
        }
        if (!pc) {
          pendingOffersRef.current.set(remoteUserId, signalData);
          return;
        }
        if (pc.signalingState === 'stable') {
          log('setting remote offer from', remoteUserId);
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          remoteDescSetRef.current.add(remoteUserId);

          const pending = pendingIceRef.current.get(remoteUserId) ?? [];
          for (const c of pending) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
          pendingIceRef.current.delete(remoteUserId);

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
        cleanup();
        setCallState((prev) => ({ ...prev, status: call.status === 'declined' ? 'declined' : 'ended' }));
        setTimeout(onClose, 800);
      }
    } catch {}
  }, [cleanup, onClose]);

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
  // Network quality monitoring
  // =====================================================
  const startNetworkMonitoring = useCallback(() => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(async () => {
      for (const [, pc] of pcsRef.current) {
        try {
          const stats = await pc.getStats();
          let rtt = 0;
          let packetsLost = 0;
          let packetsSent = 0;
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
              rtt = report.currentRoundTripTime ?? 0;
            }
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              packetsSent = report.packetsSent ?? 0;
              packetsLost = report.packetsLost ?? 0;
            }
          });
          const lossRate = packetsSent > 0 ? packetsLost / packetsSent : 0;
          if (rtt > 0.3 || lossRate > 0.1) {
            setNetworkQuality('poor');
          } else if (rtt > 0.15 || lossRate > 0.05) {
            setNetworkQuality('medium');
          } else {
            setNetworkQuality('good');
          }
        } catch {}
      }
    }, 3000);
  }, []);

  // =====================================================
  // Get local media
  // =====================================================
  const getLocalMedia = useCallback(async (callType: 'audio' | 'video', facingMode: 'user' | 'environment' = 'user') => {
    const constraints: MediaStreamConstraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: callType === 'video'
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode }
        : false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    if (localVideoRef.current && callType === 'video') {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }, []);

  // =====================================================
  // CALLER: start call
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
      startNetworkMonitoring();
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
  }, [channelId, type, participants, callData, currentUserId, createPeerConnection, sendSignal, pollSignals, pollCallStatus, startConnectionTimeout, startNetworkMonitoring, getLocalMedia, log]);

  // =====================================================
  // CALLEE: join call
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
      startNetworkMonitoring();
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
  }, [callData, createPeerConnection, sendSignal, pollSignals, pollCallStatus, startConnectionTimeout, startNetworkMonitoring, getLocalMedia, log]);

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
  // Screen sharing — with renegotiation
  // =====================================================
  const toggleScreenShare = useCallback(async () => {
    if (screenSharing) {
      // Stop screen share, restore camera
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      if (localStreamRef.current) {
        const cameraTrack = localStreamRef.current.getVideoTracks()[0];
        if (cameraTrack) {
          pcsRef.current.forEach((pc) => {
            const senders = pc.getSenders();
            const videoSender = senders.find((s) => s.track?.kind === 'video');
            if (videoSender) {
              videoSender.replaceTrack(cameraTrack).catch((e) => log('replaceTrack error:', e));
            }
          });
          if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
        }
      }
      setScreenSharing(false);
    } else {
      try {
        let screenStream: MediaStream;
        if (navigator.mediaDevices.getDisplayMedia) {
          screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        } else {
          screenStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
          });
        }
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace camera track with screen track in ALL peer connections
        pcsRef.current.forEach((pc) => {
          const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(screenTrack).catch((e) => log('replaceTrack error:', e));
          }
        });

        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;

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
                if (sender) sender.replaceTrack(cameraTrack).catch(() => {});
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
  // Camera switch (front/back) — for mobile
  // =====================================================
  const switchCamera = useCallback(async () => {
    if (!localStreamRef.current || type !== 'video') return;
    const newFacing = facingModeRef.current === 'user' ? 'environment' : 'user';
    facingModeRef.current = newFacing;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];

      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
      if (oldVideoTrack) oldVideoTrack.stop();

      localStreamRef.current.removeTrack(oldVideoTrack);
      localStreamRef.current.addTrack(newVideoTrack);

      pcsRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack).catch(() => {});
      });

      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    } catch {
      // camera switch failed — keep current camera
    }
  }, [type]);

  // =====================================================
  // Fullscreen toggle
  // =====================================================
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!fullscreen) {
        if (overlayRef.current?.requestFullscreen) {
          await overlayRef.current.requestFullscreen();
          setFullscreen(true);
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
          setFullscreen(false);
        }
      }
    } catch {
      // fullscreen not supported
    }
  }, [fullscreen]);

  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

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
  const remoteCount = remoteParticipants.length;
  const isMultiParty = remoteCount > 1;

  const statusDotClass = {
    initiating: 'ringing', ringing: 'ringing', connecting: 'connecting',
    active: 'active', ended: 'ended', declined: 'declined', failed: 'failed',
  }[callState.status];

  const networkIcon = {
    good: { color: '#22c55e', label: 'Buena' },
    medium: { color: '#f59e0b', label: 'Regular' },
    poor: { color: '#ef4444', label: 'Mala' },
    unknown: { color: '#64748b', label: '' },
  }[networkQuality];

  return (
    <>
      {/* Hidden audio elements — ALWAYS rendered for every remote participant */}
      {remoteUserIds.map((uid) => (
        <audio
          key={`audio-${uid}`}
          ref={(el) => { if (el) remoteAudioRefsRef.current.set(uid, el); }}
          autoPlay playsInline
          className="hidden"
        />
      ))}

      <div className="chat-call-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label={callType === 'video' ? 'Videollamada' : 'Llamada de voz'}>
        {/* Top bar */}
        <div className="chat-call-topbar">
          <div className="chat-call-info">
            <div>
              <div className="chat-call-info-name">
                {isMultiParty ? `${remoteCount + 1} participantes` : (remoteParticipants[0]?.name ?? participants.find((p) => p.userId !== currentUserId)?.name ?? 'Usuario')}
              </div>
              <div className="chat-call-info-status">
                <span className={cn('chat-call-status-dot', statusDotClass)} />
                {statusText}
                {networkQuality !== 'unknown' && isActive && (
                  <span className="flex items-center gap-1 ml-2" title={`Calidad: ${networkIcon.label}`}>
                    <Signal size={14} style={{ color: networkIcon.color }} />
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {callType === 'video' && (
              <button className="chat-call-ctrl" onClick={toggleFullscreen} aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'} style={{ width: 40, height: 40 }}>
                {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            )}
            {callState.status === 'failed' && callState.error && (
              <div className="flex items-center gap-1 text-xs text-red-400">
                <AlertCircle size={14} /> {callState.error}
              </div>
            )}
          </div>
        </div>

        {/* Screen share banner */}
        {screenSharing && (
          <div className="chat-call-screen-share-banner">
            <Monitor size={16} /> Compartiendo pantalla
          </div>
        )}

        {/* Stage */}
        <div className="chat-call-stage">
          {callType === 'video' ? (
            isMultiParty ? (
              /* Multi-participant grid — always render video elements */
              <div className="chat-call-grid" data-count={String(Math.min(remoteCount + 1, 8))}>
                {remoteParticipants.map((rp) => (
                  <div key={rp.userId} className={cn('chat-call-tile', rp.screenSharing && 'chat-call-tile-screen-share')}>
                    {/* Always render video element so ontrack can attach to it */}
                    <video
                      ref={(el) => { if (el) videoRefsRef.current.set(rp.userId, el); }}
                      autoPlay playsInline
                      style={{ opacity: rp.connected ? 1 : 0 }}
                    />
                    {!rp.connected && (
                      <div className="chat-call-tile-placeholder">
                        <div className="chat-call-tile-placeholder-avatar">
                          {rp.name.slice(0, 2).toUpperCase()}
                        </div>
                        <span>{rp.name}</span>
                      </div>
                    )}
                    <div className="chat-call-tile-label">{rp.name}</div>
                  </div>
                ))}
                <div className="chat-call-tile">
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <div className="chat-call-tile-label">Tú</div>
                </div>
              </div>
            ) : (
              /* 1-on-1: always render BOTH video elements */
              <>
                {/* Remote video — always rendered, even before connection */}
                <video
                  ref={(el) => {
                    if (el && remoteUserIds[0]) videoRefsRef.current.set(remoteUserIds[0], el);
                  }}
                  autoPlay playsInline
                  className="chat-call-main-video"
                  style={{ opacity: isActive ? 1 : 0 }}
                />
                {/* Connecting overlay */}
                {isConnecting && (
                  <div className="chat-call-connecting">
                    <div className="chat-call-connecting-spinner" />
                    <div className="chat-call-connecting-text">{statusText}</div>
                  </div>
                )}
                {/* Local PiP — always rendered */}
                <div className="chat-call-pip">
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <div className="chat-call-pip-label">Tú</div>
                </div>
              </>
            )
          ) : (
            /* Audio-only view */
            <div className="chat-call-audio-view">
              <div className="chat-call-audio-avatar">
                {remoteParticipants[0]?.name ? remoteParticipants[0].name.slice(0, 2).toUpperCase() : <Phone size={48} />}
              </div>
              <div className="chat-call-audio-name">
                {remoteParticipants[0]?.name ?? participants.find((p) => p.userId !== currentUserId)?.name ?? 'Usuario'}
              </div>
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
              {/* Camera switch — visible on all devices, useful on mobile */}
              <button className="chat-call-ctrl" onClick={switchCamera} aria-label="Cambiar cámara">
                <SwitchCamera size={22} />
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
