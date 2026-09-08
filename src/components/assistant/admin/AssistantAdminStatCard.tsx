'use client';

import React from 'react';

export interface AssistantAdminStatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'success' | 'danger' | 'warning';
}

export function AssistantAdminStatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: AssistantAdminStatCardProps) {
  return (
    <div className={`assistant-admin-stat-card assistant-admin-stat-${tone}`}>
      <div className="assistant-admin-stat-icon">{icon}</div>
      <div className="assistant-admin-stat-content">
        <div className="assistant-admin-stat-label">{label}</div>
        <div className="assistant-admin-stat-value">{value}</div>
        {hint && <div className="assistant-admin-stat-hint">{hint}</div>}
      </div>
    </div>
  );
}
