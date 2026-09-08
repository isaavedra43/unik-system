'use client';

import { motion, AnimatePresence } from 'framer-motion';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceOrbProps {
  state: VoiceState;
  size?: number;
}

/**
 * VoiceOrb — Animated orb that visualizes the AI voice state.
 *
 * States:
 * - idle: gentle breathing pulse
 * - listening: expanding ripples, mic-like waves
 * - thinking: rotating gradient ring
 * - speaking: audio-reactive bars / waveform
 *
 * Uses framer-motion for smooth animations.
 * Colors use --unik-brand for consistency.
 */
export function VoiceOrb({ state, size = 120 }: VoiceOrbProps) {
  const colors = {
    idle: 'var(--unik-brand)',
    listening: '#3b82f6',
    thinking: '#8b5cf6',
    speaking: '#10b981',
  };

  const color = colors[state];

  return (
    <div
      className="voice-orb-container"
      style={{ width: size, height: size, position: 'relative' }}
      role="img"
      aria-label={`Asistente ${state === 'listening' ? 'escuchando' : state === 'speaking' ? 'hablando' : state === 'thinking' ? 'pensando' : 'inactivo'}`}
    >
      {/* Outer ripples — visible when listening */}
      <AnimatePresence>
        {state === 'listening' && (
          <>
            {[0, 1, 2].map((i) => (
              <motion.div
                key={`ripple-${i}`}
                className="voice-orb-ripple"
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  border: `2px solid ${color}`,
                }}
                initial={{ scale: 0.8, opacity: 0.6 }}
                animate={{ scale: 1.6, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  delay: i * 0.6,
                  ease: 'easeOut',
                }}
              />
            ))}
          </>
        )}
      </AnimatePresence>

      {/* Rotating gradient ring — visible when thinking */}
      {state === 'thinking' && (
        <motion.div
          className="voice-orb-ring"
          style={{
            position: 'absolute',
            inset: -6,
            borderRadius: '50%',
            background: `conic-gradient(from 0deg, transparent, ${color}, transparent)`,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
        />
      )}

      {/* Main orb body */}
      <motion.div
        className="voice-orb-body"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: `radial-gradient(circle at 35% 35%, ${color}ee, ${color}88, ${color}44)`,
          boxShadow: `0 0 40px ${color}44, inset 0 0 20px ${color}33`,
        }}
        animate={{
          scale: state === 'idle' ? [1, 1.05, 1] : state === 'listening' ? [1, 1.08, 1] : state === 'speaking' ? [1, 1.12, 0.95, 1.08, 1] : 1,
        }}
        transition={{
          duration: state === 'idle' ? 3 : state === 'speaking' ? 0.4 : 1.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        {/* Inner glow */}
        <div
          style={{
            position: 'absolute',
            inset: '15%',
            borderRadius: '50%',
            background: `radial-gradient(circle at 30% 30%, ${color}cc, transparent 70%)`,
          }}
        />
      </motion.div>

      {/* Waveform bars — visible when speaking */}
      <AnimatePresence>
        {state === 'speaking' && (
          <div
            className="voice-orb-waveform"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
            }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <motion.div
                key={`bar-${i}`}
                style={{
                  width: 3,
                  borderRadius: 2,
                  background: 'rgba(255,255,255,0.9)',
                }}
                animate={{
                  height: [8, 24, 12, 28, 10, 20, 8],
                }}
                transition={{
                  duration: 0.6,
                  repeat: Infinity,
                  delay: i * 0.08,
                  ease: 'easeInOut',
                }}
              />
            ))}
          </div>
        )}
      </AnimatePresence>

      {/* Mic icon — visible when listening */}
      <AnimatePresence>
        {state === 'listening' && (
          <motion.div
            className="voice-orb-icon"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sparkle icon — visible when thinking */}
      <AnimatePresence>
        {state === 'thinking' && (
          <motion.div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="white"
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
            >
              <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" />
            </motion.svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
