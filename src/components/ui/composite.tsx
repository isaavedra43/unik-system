'use client';

import React, { ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon, IconName, X } from './icons';

/* ----------------------------------------------------
   Modal
   ---------------------------------------------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h3 id="modal-title" className="modal-title">
            {title}
          </h3>
          <IconButton onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </>
  );
}

/* ----------------------------------------------------
   Drawer
   ---------------------------------------------------- */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        style={size === 'lg' ? { width: 'min(100vw, 640px)' } : undefined}
      >
        <div className="drawer-header">
          <div>
            <h3 id="drawer-title" className="drawer-title">
              {title}
            </h3>
            {subtitle ? <p className="drawer-subtitle">{subtitle}</p> : null}
          </div>
          <IconButton onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </IconButton>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </div>
    </>
  );
}

/* ----------------------------------------------------
   IconButton helper
   ---------------------------------------------------- */
function IconButton({
  children,
  onClick,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  'aria-label': string;
}) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

/* ----------------------------------------------------
   DropdownMenu
   ---------------------------------------------------- */
export function DropdownMenu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: ReactNode;
  items: { label: string; icon?: ReactNode; onClick?: () => void; href?: string }[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', onClick);
    }
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="account-trigger"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className="dropdown-menu"
          style={align === 'left' ? { left: 0, right: 'auto' } : undefined}
          role="menu"
        >
          {items.map((item, idx) =>
            item.href ? (
              <Link
                key={idx}
                href={item.href}
                className="dropdown-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                {item.label}
              </Link>
            ) : (
              <button
                key={idx}
                type="button"
                className="dropdown-item"
                role="menuitem"
                onClick={() => {
                  item.onClick?.();
                  setOpen(false);
                }}
              >
                {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                {item.label}
              </button>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------
   Tabs (URL based)
   ---------------------------------------------------- */
export function TabNav({
  tabs,
  activeId,
}: {
  tabs: { id: string; label: string; href: string; disabled?: boolean }[];
  activeId: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label="Secciones">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.disabled ? '#' : tab.href}
          className={`tab ${tab.id === activeId ? 'tab-active' : ''} ${tab.disabled ? 'tab-disabled' : ''}`}
          role="tab"
          aria-selected={tab.id === activeId}
          aria-disabled={tab.disabled}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

/* ----------------------------------------------------
   PageHeader
   ---------------------------------------------------- */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}) {
  return (
    <div className="page-header">
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <h1 className="page-title">{title}</h1>
          {description ? <p className="page-description">{description}</p> : null}
        </div>
        {actions ? <div className="row-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------
   Breadcrumbs
   ---------------------------------------------------- */
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="topbar-breadcrumbs" style={{ marginBottom: '0.35rem' }}>
      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? <span aria-hidden="true">/</span> : null}
          {item.href ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------
   EmptyState
   ---------------------------------------------------- */
export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon name={icon} size={48} />
      </div>
      <h3 className="empty-state-title">{title}</h3>
      <p>{message}</p>
      {action ? <div style={{ marginTop: '1rem' }}>{action}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------
   Toast
   ---------------------------------------------------- */
export function Toast({
  visible,
  message,
  variant = 'success',
  onClose,
  duration = 3000,
}: {
  visible: boolean;
  message: string;
  variant?: 'success' | 'error' | 'info';
  onClose: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [visible, onClose, duration]);

  if (!visible) return null;

  const colors = {
    success: { bg: 'var(--unik-success-bg)', color: 'var(--unik-success)' },
    error: { bg: 'var(--unik-danger-bg)', color: 'var(--unik-danger)' },
    info: { bg: 'var(--unik-info-bg)', color: 'var(--unik-info)' },
  }[variant];

  return (
    <div
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        zIndex: 200,
        background: colors.bg,
        color: colors.color,
        padding: '0.75rem 1rem',
        borderRadius: '8px',
        boxShadow: 'var(--unik-shadow-md)',
        fontSize: '0.875rem',
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        minWidth: '240px',
      }}
      role="status"
    >
      {message}
      <button
        type="button"
        onClick={onClose}
        className="icon-btn"
        style={{ color: 'inherit' }}
        aria-label="Cerrar notificación"
      >
        <X size={16} />
      </button>
    </div>
  );
}
