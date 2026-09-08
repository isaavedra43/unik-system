import { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import '@/styles/shadcn.css';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'UNIK System',
  description: 'Sistema interno UNIK — Gestión de ventas, inventario y asistente IA',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'UNIK',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-256.png', sizes: '256x256', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-title': 'UNIK',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
    'application-name': 'UNIK',
    'msapplication-TileColor': '#2563eb',
    'msapplication-tap-highlight': 'no',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0e1a' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})})}`,
          }}
        />
      </body>
    </html>
  );
}
