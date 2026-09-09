'use client';

import React from 'react';

export interface ChatAdminStatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'success' | 'danger' | 'warning';
}

export function ChatAdminStatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: ChatAdminStatCardProps) {
  return (
    <div className={`chat-admin-stat-card chat-admin-stat-${tone}`}>
      <div className="chat-admin-stat-icon">{icon}</div>
      <div className="chat-admin-stat-content">
        <div className="chat-admin-stat-label">{label}</div>
        <div className="chat-admin-stat-value">{value}</div>
        {hint && <div className="chat-admin-stat-hint">{hint}</div>}
      </div>
    </div>
  );
}
