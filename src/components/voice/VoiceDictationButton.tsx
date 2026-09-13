'use client';

import React, { useCallback, useRef } from 'react';
import { Mic } from 'lucide-react';
import { useVoiceDictation } from '@/lib/hooks/use-voice-dictation';

export interface VoiceDictationButtonProps {
  /**
   * Called whenever a final transcript chunk is received.
   * The caller should insert this text at the cursor position.
   */
  onFinalTranscript: (text: string) => void;
  /** Called when dictation starts (for visual feedback, e.g. focus textarea). */
  onStart?: () => void;
  /** Called when dictation stops. */
  onEnd?: () => void;
  /** Disable the button (e.g. while sending a message). */
  disabled?: boolean;
  /** BCP-47 language tag. Default: 'es-MX'. */
  lang?: string;
  /** CSS class for the button. */
  className?: string;
  /** Size of the mic icon. */
  iconSize?: number;
  /** Aria label for the button. */
  ariaLabel?: string;
  /** Title/tooltip for the button. */
  title?: string;
}

/**
 * Reusable voice dictation button powered by the Web Speech API.
 *
 * - Drop into any chat input / message composer.
 * - Shows a pulsing red mic while listening.
 * - Shows interim transcript as a subtle overlay (caller handles insertion).
 * - Gracefully hides on unsupported browsers (Firefox, older Safari).
 * - No external dependencies, no API costs.
 *
 * Usage:
 * ```tsx
 * <VoiceDictationButton
 *   onFinalTranscript={(text) => insertAtCursor(text)}
 *   disabled={isSending}
 * />
 * ```
 */
export function VoiceDictationButton({
  onFinalTranscript,
  onStart,
  onEnd,
  disabled = false,
  lang = 'es-MX',
  className = '',
  iconSize = 20,
  ariaLabel = 'Dictar por voz',
  title = 'Dictar por voz',
}: VoiceDictationButtonProps) {
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  const { isListening, isSupported, toggle } = useVoiceDictation({
    lang,
    onTranscript: useCallback((text: string, isFinal: boolean) => {
      if (isFinal && text) {
        onFinalRef.current(text);
      }
    }, []),
    onStart,
    onEnd,
  });

  // Hide entirely on unsupported browsers — no broken button.
  if (!isSupported) return null;

  return (
    <button
      type="button"
      className={`voice-dictation-btn ${isListening ? 'voice-dictation-active' : ''} ${className}`}
      onClick={toggle}
      disabled={disabled}
      aria-label={isListening ? 'Detener dictado' : ariaLabel}
      aria-pressed={isListening}
      title={isListening ? 'Detener dictado' : title}
    >
      {isListening ? (
        <span className="voice-dictation-pulse" aria-hidden="true">
          <Mic size={iconSize} />
        </span>
      ) : (
        <Mic size={iconSize} />
      )}
    </button>
  );
}
