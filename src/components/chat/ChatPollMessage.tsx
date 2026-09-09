'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Check, BarChart3 } from 'lucide-react';

export interface ChatPollOption {
  id: string;
  text: string;
  voteCount: number;
  hasVoted: boolean;
}

export interface ChatPollMessageProps {
  poll: {
    id: string;
    question: string;
    isMulti: boolean;
    isAnonymous: boolean;
    closesAt: string | null;
    totalVotes: number;
    options: ChatPollOption[];
    userVotedOptionIds: string[];
  };
  onVote: (optionIds: string[]) => void;
}

export function ChatPollMessage({ poll, onVote }: ChatPollMessageProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(poll.userVotedOptionIds);

  // Sync local selection when external voted ids change
  useEffect(() => {
    setSelectedIds(poll.userVotedOptionIds);
  }, [poll.userVotedOptionIds]);

  const isClosed = useMemo(() => {
    if (!poll.closesAt) return false;
    return new Date(poll.closesAt).getTime() < Date.now();
  }, [poll.closesAt]);

  const hasVoted = poll.userVotedOptionIds.length > 0;

  const toggleOption = useCallback(
    (optionId: string) => {
      if (isClosed) return;
      if (poll.isMulti) {
        setSelectedIds((prev) =>
          prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId]
        );
      } else {
        setSelectedIds((prev) => (prev[0] === optionId ? [] : [optionId]));
      }
    },
    [isClosed, poll.isMulti]
  );

  const handleVote = useCallback(() => {
    if (selectedIds.length === 0 || isClosed) return;
    onVote(selectedIds);
  }, [selectedIds, isClosed, onVote]);

  return (
    <div className="chat-poll-message">
      <div className="chat-poll-question">
        <BarChart3 size={16} />
        <span>{poll.question}</span>
        {isClosed && <span className="chat-poll-closed">Cerrada</span>}
      </div>

      <div className="chat-poll-options">
        {poll.options.map((option) => {
          const percentage =
            poll.totalVotes > 0 ? Math.round((option.voteCount / poll.totalVotes) * 100) : 0;
          const isSelected = selectedIds.includes(option.id);
          const hasVotedThis = poll.userVotedOptionIds.includes(option.id);

          return (
            <button
              key={option.id}
              type="button"
              className={`chat-poll-option ${isSelected || hasVotedThis ? 'selected' : ''}`}
              onClick={() => toggleOption(option.id)}
              disabled={isClosed}
            >
              <div className="chat-poll-option-bar" style={{ width: `${percentage}%` }} />
              <div className="chat-poll-option-content">
                <span className="chat-poll-option-text">
                  {poll.isMulti && (
                    <span className="chat-poll-checkbox">
                      {isSelected || hasVotedThis ? <Check size={14} /> : null}
                    </span>
                  )}
                  {!poll.isMulti && (isSelected || hasVotedThis) && (
                    <Check size={14} className="chat-poll-radio-check" />
                  )}
                  {option.text}
                </span>
                <span className="chat-poll-option-votes">
                  {option.voteCount} ({percentage}%)
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="chat-poll-total">
        {poll.totalVotes} {poll.totalVotes === 1 ? 'voto' : 'votos'}
        {poll.isAnonymous && <span className="chat-poll-anonymous">· Anónima</span>}
      </div>

      {!isClosed && !hasVoted && selectedIds.length > 0 && (
        <button type="button" className="chat-poll-vote-btn" onClick={handleVote}>
          {poll.isMulti ? 'Enviar votos' : 'Votar'}
        </button>
      )}
    </div>
  );
}
