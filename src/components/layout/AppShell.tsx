'use client';

import React, { ReactNode, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CurrentUser } from '@/modules/auth/authorization';
import { logoutAction } from '@/app/app/actions';
import { Avatar } from '@/components/ui/primitives';
import { DropdownMenu } from '@/components/ui/composite';
import { ChevronDown, Home, LogOut, Menu, Shield, Users } from '@/components/ui/icons';

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
      <div>
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
  if (pathname.startsWith('/app/account/security')) {
    return [{ label: 'Cuenta' }, { label: 'Seguridad' }];
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
      ],
    },
  ];

  return (
    <div className="app-shell">
      <Sidebar sections={sections} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="app-main">
        <Topbar user={user} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
