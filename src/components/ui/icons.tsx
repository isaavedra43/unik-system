'use client';

import React from 'react';

export interface IconProps {
  size?: number;
  className?: string;
}

const defaultAttrs = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 20 20',
};

function wrap(children: React.ReactNode, size = 20, className?: string) {
  return (
    <svg width={size} height={size} className={className} {...defaultAttrs}>
      {children}
    </svg>
  );
}

export const Home = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M3.5 8.5l6.5-5.5 6.5 5.5" />
      <path d="M5 8.5v7h4.5v-4h1v4h4.5v-7" />
    </>,
    size,
    className
  );

export const Users = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="9" cy="6" r="2.5" />
      <path d="M13 14h-8c0-2.5 1.5-4.5 4-4.5s4 2 4 4.5z" />
      <circle cx="15" cy="6.5" r="2" />
      <path d="M17 14h-1c0-2-1-3.5-2.5-4" />
    </>,
    size,
    className
  );

export const Shield = ({ size, className }: IconProps) =>
  wrap(<path d="M10 2.5l6 2.5v5c0 4.5-3.5 7.5-6 8.5-2.5-1-6-4-6-8.5v-5l6-2.5z" />, size, className);

export const Settings = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="10" cy="10" r="3" />
      <path d="M17 10h1M2 10h1M14.5 14.5l.8.8M4.7 4.7l.8.8M14.5 5.5l.8-.8M4.7 15.3l.8-.8" />
    </>,
    size,
    className
  );

export const Menu = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    </>,
    size,
    className
  );

export const X = ({ size, className }: IconProps) =>
  wrap(<path d="M5 15l10-10M15 15L5 5" />, size, className);

export const ChevronDown = ({ size, className }: IconProps) =>
  wrap(<path d="M4.5 7.5l5.5 5.5 5.5-5.5" />, size, className);

export const ChevronRight = ({ size, className }: IconProps) =>
  wrap(<path d="M7.5 4.5l5.5 5.5-5.5 5.5" />, size, className);

export const User = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="10" cy="6" r="3" />
      <path d="M3 16.5c0-3.5 3-5 7-5s7 1.5 7 5" />
    </>,
    size,
    className
  );

export const Key = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="6" cy="14" r="3" />
      <path d="M8.5 11.5l5-5" />
      <circle cx="15" cy="5.5" r="1.5" />
      <path d="M15 7v2M15.5 9.5h2" />
    </>,
    size,
    className
  );

export const Lock = ({ size, className }: IconProps) =>
  wrap(
    <>
      <rect x="4" y="9" width="12" height="9" rx="2" />
      <path d="M6.5 9V7a3.5 3.5 0 017 0v2" />
    </>,
    size,
    className
  );

export const Search = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="M15 15l-3.5-3.5" />
    </>,
    size,
    className
  );

export const MoreVertical = ({ size, className }: IconProps) =>
  wrap(
    <>
      <circle cx="10" cy="5" r="1.2" />
      <circle cx="10" cy="10" r="1.2" />
      <circle cx="10" cy="15" r="1.2" />
    </>,
    size,
    className
  );

export const Plus = ({ size, className }: IconProps) =>
  wrap(<path d="M10 4v12M4 10h12" />, size, className);

export const Check = ({ size, className }: IconProps) =>
  wrap(<path d="M4 10l4 4 8-8" />, size, className);

export const RefreshCw = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M17.5 10.5c0 3.5-2.5 6.5-6 6.5-3 0-5.5-2-6-5" />
      <path d="M2.5 9.5c0-3.5 2.5-6.5 6-6.5 3 0 5.5 2 6 5" />
      <path d="M15.5 6l2 3.5-3.5.5M4.5 14l-2-3.5 3.5-.5" />
    </>,
    size,
    className
  );

export const Trash = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M4 5h12M7 5V3.5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0113 3.5V5M16 5v10.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 016 15.5V5" />
    </>,
    size,
    className
  );

export const AlertTriangle = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M10 2.5L2.5 15.5h15L10 2.5z" />
      <path d="M10 7v4.5M10 13.5v.5" />
    </>,
    size,
    className
  );

export const LogOut = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M8 4.5H4v11h4M15.5 10H8M12.5 6.5L15.5 10l-3 3.5" />
    </>,
    size,
    className
  );

export const Building = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M4.5 17.5V6.5L10 3.5l5.5 3v11" />
      <path d="M7.5 17.5V13h5v4.5" />
      <path d="M3.5 17.5h13" />
    </>,
    size,
    className
  );

export const Package = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M10 1.5l-6 3v11l6 3 6-3v-11l-6-3z" />
      <path d="M4 6.5l6 3 6-3M10 9.5v10" />
    </>,
    size,
    className
  );

export const FileText = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M4.5 3.5h7.5L15.5 7v10H4.5V3.5z" />
      <path d="M7 8h6M7 11.5h6M7 15h3" />
    </>,
    size,
    className
  );

export const Layers = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M10 3l7 3.5-7 3.5-7-3.5 7-3.5z" />
      <path d="M3 10.5l7 3.5 7-3.5M3 14l7 3.5 7-3.5" />
    </>,
    size,
    className
  );

export const Eye = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M2 10s2.5-5 8-5 8 5 8 5-2.5 5-8 5-8-5-8-5z" />
      <circle cx="10" cy="10" r="2.5" />
    </>,
    size,
    className
  );

export const EyeOff = ({ size, className }: IconProps) =>
  wrap(
    <>
      <path d="M3.5 4l13 13M10 6c2.5 0 4.5 1.5 5.5 4M4.5 10c1-2.5 3-4 5.5-4" />
      <path d="M2 10s2.5-5 8-5 8 5 8 5" />
    </>,
    size,
    className
  );

export type IconName =
  | 'home'
  | 'users'
  | 'shield'
  | 'settings'
  | 'menu'
  | 'x'
  | 'chevronDown'
  | 'chevronRight'
  | 'user'
  | 'key'
  | 'lock'
  | 'search'
  | 'moreVertical'
  | 'plus'
  | 'check'
  | 'refreshCw'
  | 'trash'
  | 'alertTriangle'
  | 'logOut'
  | 'building'
  | 'package'
  | 'fileText'
  | 'layers'
  | 'eye'
  | 'eyeOff';

const icons: Record<IconName, (props: IconProps) => React.ReactElement> = {
  home: Home,
  users: Users,
  shield: Shield,
  settings: Settings,
  menu: Menu,
  x: X,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  user: User,
  key: Key,
  lock: Lock,
  search: Search,
  moreVertical: MoreVertical,
  plus: Plus,
  check: Check,
  refreshCw: RefreshCw,
  trash: Trash,
  alertTriangle: AlertTriangle,
  logOut: LogOut,
  building: Building,
  package: Package,
  fileText: FileText,
  layers: Layers,
  eye: Eye,
  eyeOff: EyeOff,
};

export function Icon({ name, size = 20, className }: { name: IconName } & IconProps) {
  const Component = icons[name];
  return <Component size={size} className={className} />;
}
