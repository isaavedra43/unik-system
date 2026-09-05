'use client';

import React, { ReactNode, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CurrentUser } from '@/modules/auth/authorization';
import { logoutAction } from '@/app/app/actions';
import { Avatar } from '@/components/ui/primitives';
import { DropdownMenu } from '@/components/ui/composite';
import { ChevronDown, Home, LogOut, Menu, Shield, Users } from '@/components/ui/icons';
import { Bell, ShoppingCart, Plug } from 'lucide-react';

interface AppShellProps {
  user: CurrentUser;
  children: ReactNode;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  visible?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

function Sidebar({
  sections,
  open,
  onClose,
}: {
  sections: NavSection[];
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
        </div>
        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div key={section.title} className="sidebar-section">
              <div className="sidebar-section-title">{section.title}</div>
              <div className="sidebar-children">
                {section.items
                  .filter((item) => item.visible !== false)
                  .map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`sidebar-link ${isActive(item.href) ? 'active' : ''}`}
                      onClick={onClose}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  ))}
              </div>
            </div>
          ))}
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
            label: 'Cerrar sesión',
            icon: <LogOut size={16} />,
            onClick: () => {
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
  const [unread, setUnread] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const [recent, setRecent] = useState<
    { id: string; title: string; body: string | null; readAt: string | null; createdAt: string }[]
  >([]);

  React.useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch('/app/notifications/api/unread-count');
        if (res.ok) {
          const json = await res.json();
          if (active) setUnread(json.count);
        }
      } catch {
        // silent
      }
    }
    load();
    const interval = setInterval(load, 90_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
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
                      href="/app/notifications"
                      className={`so-notification-item ${n.readAt === null ? 'unread' : ''}`}
                      onClick={() => setBellOpen(false)}
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

function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
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

function buildBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  if (pathname === '/app') return [];
  if (pathname.startsWith('/app/admin/access')) {
    return [
      { label: 'Administración', href: '/app/admin/access' },
      { label: 'Usuarios y permisos' },
    ];
  }
  if (pathname.startsWith('/app/admin/integrations')) {
    return [
      { label: 'Administración', href: '/app/admin/integrations' },
      { label: 'Integraciones' },
    ];
  }
  if (pathname.startsWith('/app/account/security')) {
    return [{ label: 'Cuenta' }, { label: 'Seguridad' }];
  }
  if (pathname === '/app/sales/orders') {
    return [{ label: 'Ventas' }, { label: 'Órdenes de venta' }];
  }
  if (pathname.startsWith('/app/sales/orders/')) {
    return [
      { label: 'Ventas' },
      { label: 'Órdenes de venta', href: '/app/sales/orders' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/notifications') {
    return [{ label: 'Notificaciones' }];
  }
  return [];
}

export default function AppShell({ user, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const sections: NavSection[] = [
    {
      title: 'General',
      items: [{ href: '/app', label: 'Inicio', icon: <Home size={18} />, visible: true }],
    },
    {
      title: 'Ventas',
      items: [
        {
          href: '/app/sales/orders',
          label: 'Órdenes de venta',
          icon: <ShoppingCart size={18} />,
          visible: user.permissionKeys.includes('sales_orders.view') || user.isSuperAdmin,
        },
      ],
    },
    {
      title: 'Administración',
      items: [
        {
          href: '/app/admin/access',
          label: 'Usuarios y permisos',
          icon: <Users size={18} />,
          visible:
            user.permissionKeys.includes('users.view') ||
            user.permissionKeys.includes('roles.view') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/admin/integrations',
          label: 'Integraciones',
          icon: <Plug size={18} />,
          visible:
            user.permissionKeys.includes('integrations.view') || user.isSuperAdmin,
        },
      ],
    },
    {
      title: 'Cuenta',
      items: [
        {
          href: '/app/account/security',
          label: 'Seguridad',
          icon: <Shield size={18} />,
          visible: true,
        },
        {
          href: '/app/notifications',
          label: 'Notificaciones',
          icon: <Bell size={18} />,
          visible: true,
        },
      ],
    },
  ];

  const pathname = usePathname();
  const isWorkspace = pathname.startsWith('/app/sales/orders') && !pathname.includes('/api');

  return (
    <div className="app-shell">
      <Sidebar sections={sections} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="app-main">
        <Topbar user={user} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <main className={isWorkspace ? 'app-content app-content-flush' : 'app-content'}>
          {children}
        </main>
      </div>
    </div>
  );
}
