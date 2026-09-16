'use client';

import React, { ReactNode, useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CurrentUser } from '@/modules/auth/authorization';
import { logoutAction } from '@/app/app/actions';
import { Avatar } from '@/components/ui/primitives';
import { DropdownMenu } from '@/components/ui/composite';
import { ChevronDown, LogOut, Menu, Shield } from '@/components/ui/icons';
import { Bell, X, ChevronRight } from 'lucide-react';
import { AssistantWidget } from '@/components/assistant/AssistantWidget';
import { CallDockProvider } from '@/components/calls/CallDockProvider';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import {
  buildBreadcrumbs,
  buildNavSections,
  can,
  isFlushRoute,
  visibleNavItems as visibleItems,
  type Breadcrumb,
  type NavEntry,
  type NavGroup,
  type NavSection,
} from '@/components/layout/nav-config';
import { useNotificationStream } from '@/components/notifications/useNotificationStream';
import { SeedDemoDataButton } from '@/components/dev/SeedDemoDataButton';

interface AppShellProps {
  user: CurrentUser;
  children: ReactNode;
}

function SidebarSection({
  section,
  isActive,
  onClose,
}: {
  section: NavSection;
  isActive: (href: string) => boolean;
  onClose: () => void;
}) {
  const items = visibleItems(section);
  if (items.length === 0) return null;
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">{section.title}</div>
      <div className="sidebar-children">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-link ${isActive(item.href) ? 'active' : ''}`}
            onClick={onClose}
          >
            <item.icon size={18} />
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function SidebarGroup({
  group,
  isActive,
  onClose,
}: {
  group: NavGroup;
  isActive: (href: string) => boolean;
  onClose: () => void;
}) {
  const sections = group.sections.filter((s) => visibleItems(s).length > 0);
  const hasActive = sections.some((s) => visibleItems(s).some((i) => isActive(i.href)));
  const storageKey = `unik.sidebar.group.${group.key}`;
  const [open, setOpen] = useState(hasActive);

  // Remember the user's choice; a group always opens when one of its pages is active.
  React.useEffect(() => {
    if (hasActive) {
      setOpen(true);
      return;
    }
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== null) setOpen(stored === '1');
    } catch {
      // storage unavailable
    }
  }, [hasActive, storageKey]);

  if (sections.length === 0) return null;

  const toggle = () =>
    setOpen((v) => {
      try {
        window.localStorage.setItem(storageKey, v ? '0' : '1');
      } catch {
        // storage unavailable
      }
      return !v;
    });

  const bodyId = `sidebar-group-${group.key}`;
  return (
    <div className={`sidebar-group ${open ? 'open' : ''} ${hasActive ? 'has-active' : ''}`}>
      <button
        type="button"
        className="sidebar-group-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="sidebar-group-icon">
          <group.icon size={18} />
        </span>
        <span className="sidebar-group-label">{group.title}</span>
        <ChevronRight size={16} className="sidebar-group-chevron" aria-hidden="true" />
      </button>
      <div className="sidebar-group-body" id={bodyId} inert={!open}>
        <div className="sidebar-group-inner">
          {sections.map((section) => (
            <SidebarSection
              key={section.title}
              section={section}
              isActive={isActive}
              onClose={onClose}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  entries,
  open,
  onClose,
}: {
  entries: NavEntry[];
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/app') return pathname === href;
    return pathname.startsWith(href);
  };

  return (
    <>
      {open ? <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" /> : null}
      <aside className={`app-sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <Link href="/app" style={{ color: 'inherit' }}>
            UNIK
          </Link>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={onClose}
            aria-label="Cerrar menú"
          >
            <X size={20} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {entries.map((entry) =>
            entry.kind === 'group' ? (
              <SidebarGroup key={entry.key} group={entry} isActive={isActive} onClose={onClose} />
            ) : (
              <SidebarSection
                key={entry.title}
                section={entry}
                isActive={isActive}
                onClose={onClose}
              />
            )
          )}
        </nav>
      </aside>
    </>
  );
}

function AccountMenu({ user }: { user: CurrentUser }) {
  return (
    <form action={logoutAction} id="logout-form">
      <DropdownMenu
        trigger={
          <>
            <Avatar name={user.name} size="sm" />
            <span className="account-name">{user.name}</span>
            <ChevronDown size={16} />
          </>
        }
        items={[
          {
            label: 'Mi seguridad',
            href: '/app/account/security',
            icon: <Shield size={16} />,
          },
          {
            label: 'Mis notificaciones',
            href: '/app/account/notifications',
            icon: <Bell size={16} />,
          },
          {
            label: 'Cerrar sesión',
            icon: <LogOut size={16} />,
            onClick: () => {
              // El Service Worker guarda el HTML de las páginas visitadas: en un
              // teléfono compartido el siguiente turno no debe recibir del caché
              // las paradas ni los expedientes de quien cierra sesión.
              navigator.serviceWorker?.controller?.postMessage('clear-private-cache');
              const submit = document.getElementById('logout-submit') as HTMLButtonElement | null;
              submit?.click();
            },
          },
        ]}
      />
      <button type="submit" id="logout-submit" className="sr-only" aria-label="Cerrar sesión">
        Cerrar sesión
      </button>
    </form>
  );
}

function Topbar({ user, onToggleSidebar }: { user: CurrentUser; onToggleSidebar: () => void }) {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname);
  const { unread, setUnread } = useNotificationStream(user.id);
  const [bellOpen, setBellOpen] = useState(false);
  const [recent, setRecent] = useState<
    {
      id: string;
      title: string;
      body: string | null;
      url: string | null;
      readAt: string | null;
      createdAt: string;
    }[]
  >([]);

  function openNotification(n: { id: string; readAt: string | null }) {
    setBellOpen(false);
    if (n.readAt) return;
    setUnread((u) => Math.max(0, u - 1));
    void fetch('/app/notifications/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: n.id }),
    }).catch(() => undefined);
  }

  async function openBell() {
    if (bellOpen) {
      setBellOpen(false);
      return;
    }
    try {
      const res = await fetch('/app/notifications/api?page_size=10');
      if (res.ok) {
        const json = await res.json();
        setRecent(json.data);
      }
    } catch {
      // silent
    }
    setBellOpen(true);
  }

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label="Abrir o cerrar menú"
        >
          <Menu size={18} />
        </button>
        <Breadcrumbs items={crumbs} />
      </div>
      <div className="topbar-right">
        {process.env.NEXT_PUBLIC_ALLOW_DEMO_SEED === 'true' && user.isSuperAdmin ? (
          <SeedDemoDataButton />
        ) : null}
        <ThemeToggle />
        <div style={{ position: 'relative' }}>
          <button
            className="so-notification-bell"
            onClick={openBell}
            aria-label={`Notificaciones${unread > 0 ? ` (${unread} sin leer)` : ''}`}
          >
            <Bell size={18} />
            {unread > 0 ? (
              <span className="so-notification-badge">{unread > 99 ? '99+' : unread}</span>
            ) : null}
          </button>
          {bellOpen ? (
            <>
              <div
                className="overlay"
                style={{ zIndex: 49 }}
                onClick={() => setBellOpen(false)}
                aria-hidden="true"
              />
              <div className="so-notification-popover">
                {recent.length === 0 ? (
                  <div
                    style={{
                      padding: '1.5rem',
                      textAlign: 'center',
                      color: 'var(--unik-text-muted)',
                    }}
                  >
                    Sin notificaciones
                  </div>
                ) : (
                  recent.map((n) => (
                    <Link
                      key={n.id}
                      href={n.url ?? '/app/notifications'}
                      className={`so-notification-item ${n.readAt === null ? 'unread' : ''}`}
                      onClick={() => openNotification(n)}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div className="so-notification-title">{n.title}</div>
                      {n.body ? <div className="so-notification-body">{n.body}</div> : null}
                      <div className="so-notification-time">
                        {new Date(n.createdAt).toLocaleString('es-MX', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </div>
                    </Link>
                  ))
                )}
                <div className="so-notification-footer">
                  <Link
                    href="/app/notifications"
                    onClick={() => setBellOpen(false)}
                    style={{ fontSize: '0.875rem' }}
                  >
                    Ver todas
                  </Link>
                </div>
              </div>
            </>
          ) : null}
        </div>
        <AccountMenu user={user} />
      </div>
    </header>
  );
}

function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="topbar-breadcrumbs">
      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? <span aria-hidden="true">/</span> : null}
          {item.href ? (
            <Link href={item.href} style={{ color: 'inherit' }}>
              {item.label}
            </Link>
          ) : (
            <span aria-current="page" style={{ color: 'var(--unik-text)' }}>
              {item.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

export default function AppShell({ user, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile to choose between overlay (mobile) vs push (desktop) sidebar
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Persist collapsed state for desktop
  useEffect(() => {
    const stored = localStorage.getItem('unik.sidebar.collapsed');
    if (stored === 'true') setSidebarCollapsed(true);
  }, []);

  useEffect(() => {
    localStorage.setItem('unik.sidebar.collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const toggleSidebar = () => {
    if (isMobile) {
      setSidebarOpen(!sidebarOpen);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  };

  const sections: NavEntry[] = useMemo(() => buildNavSections(user), [user]);

  const pathname = usePathname();
  const isAssistantPage = pathname.startsWith('/app/assistant');
  const isFlush = isFlushRoute(pathname);
  const canUseAssistant = can(user, 'assistant.use');
  const showWidget = canUseAssistant && !isAssistantPage;

  return (
    <CallDockProvider user={user}>
      <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar entries={sections} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="app-main">
          <Topbar user={user} onToggleSidebar={toggleSidebar} />
          <main className={isFlush ? 'app-content app-content-flush' : 'app-content'}>
            {children}
          </main>
        </div>
        {showWidget && <AssistantWidget user={user} context={{ page: pathname }} />}
      </div>
    </CallDockProvider>
  );
}
