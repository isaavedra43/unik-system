'use client';

import React, { InputHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  icon?: ReactNode;
  full?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  isLoading,
  icon,
  full,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant === 'primary' ? 'btn-primary' : `btn-${variant}`,
    `btn-${size}`,
    full ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled || isLoading} {...rest}>
      {isLoading ? <span className="spinner" aria-hidden="true" /> : icon ? icon : null}
      {children}
    </button>
  );
}

export function IconButton({
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className={`icon-btn ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}

export function FormField({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label htmlFor={htmlFor} className="form-label">
        {label}
      </label>
      {children}
      {help ? <p className="form-help">{help}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string | null;
  leftIcon?: ReactNode;
}

export function Input({ className = '', error, leftIcon, ...rest }: InputProps) {
  const inputClass = `input ${className}`.trim();
  const attrs = { ...rest, 'aria-invalid': Boolean(error) };
  return leftIcon ? (
    <div className="input-with-icon">
      <span className="input-icon" aria-hidden="true">
        {leftIcon}
      </span>
      <input className={inputClass} {...attrs} />
    </div>
  ) : (
    <input className={inputClass} {...attrs} />
  );
}

export function Select({
  children,
  className = '',
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({
  className = '',
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input ${className}`.trim()} {...rest} />;
}

export function Checkbox({
  label,
  description,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label className="checkbox-row">
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {description ? (
          <span className="text-muted" style={{ display: 'block', fontSize: '0.75rem' }}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export type BadgeVariant = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak';

export function Badge({
  children,
  variant = 'default',
  dot,
  className = '',
  style,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  dot?: 'success' | 'danger' | 'warning' | 'info';
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className={`badge badge-${variant} ${className}`.trim()} style={style}>
      {dot ? <span className={`status-dot status-dot-${dot}`} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

export function Alert({
  variant,
  children,
  title,
}: {
  variant: 'error' | 'success' | 'warning' | 'info';
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className={`alert alert-${variant}`} role={variant === 'error' ? 'alert' : undefined}>
      {title ? (
        <strong style={{ display: 'block', marginBottom: '0.25rem' }}>{title}</strong>
      ) : null}
      {children}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size, display: 'inline-block' }}
      aria-hidden="true"
    />
  );
}
