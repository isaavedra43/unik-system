'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface ChatMentionMember {
  userId: string;
  name: string;
  username: string;
}

export interface ChatMentionPickerProps {
  members: ChatMentionMember[];
  onSelect: (username: string) => void;
  query: string;
  position?: { top: number; left: number } | null;
  /** Externally controlled active index. If omitted, navigation is managed internally. */
  activeIndex?: number;
}

const MAX_RESULTS = 8;

export function ChatMentionPicker({
  members,
  onSelect,
  query,
  position,
  activeIndex,
}: ChatMentionPickerProps) {
  const isControlled = activeIndex !== undefined && activeIndex !== null;
  const [internalIndex, setInternalIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return members.slice(0, MAX_RESULTS);
    return members
      .filter((m) => m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [members, query]);

  const currentActive = isControlled ? (activeIndex as number) : internalIndex;

  // Reset internal index when results change
  useEffect(() => {
    if (!isControlled) setInternalIndex(0);
  }, [filtered, isControlled]);

  const selectItem = useCallback(
    (index: number) => {
      const member = filtered[index];
      if (member) onSelect(member.username);
    },
    [filtered, onSelect]
  );

  // Only handle keyboard internally when not externally controlled
  useEffect(() => {
    if (isControlled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setInternalIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setInternalIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectItem(internalIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onSelect('');
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, internalIndex, selectItem, onSelect, isControlled]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.children[currentActive] as HTMLElement | undefined;
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [currentActive]);

  if (filtered.length === 0) return null;

  const style = position ? { top: position.top, left: position.left } : undefined;

  return (
    <div
      className={`chat-mention-picker ${position ? 'positioned' : 'inline'}`}
      style={style}
      ref={listRef}
      role="listbox"
    >
      {filtered.map((member, index) => (
        <button
          key={member.userId}
          type="button"
          role="option"
          aria-selected={index === currentActive}
          className={`chat-mention-item ${index === currentActive ? 'chat-mention-item-active' : ''}`}
          onClick={() => selectItem(index)}
          onMouseEnter={() => {
            if (!isControlled) setInternalIndex(index);
          }}
        >
          <span className="chat-mention-name">{member.name}</span>
          <span className="chat-mention-username">@{member.username}</span>
        </button>
      ))}
    </div>
  );
}
