import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'UNIK System',
    short_name: 'UNIK',
    description: 'Sistema interno UNIK — Gestión de ventas, inventario y asistente IA',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0e1a',
    theme_color: '#2563eb',
    categories: ['business', 'productivity', 'utilities'],
    lang: 'es-MX',
    dir: 'ltr',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-256.png',
        sizes: '256x256',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Asistente IA',
        short_name: 'Asistente',
        description: 'Conversa con el asistente IA',
        url: '/app/assistant',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Órdenes de Venta',
        short_name: 'Órdenes',
        description: 'Gestión de órdenes de venta',
        url: '/app/sales/orders',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }],
      },
    ],
  };
}
