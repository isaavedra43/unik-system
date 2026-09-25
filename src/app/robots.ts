import type { MetadataRoute } from 'next';

/**
 * Crawl policy. `X-Robots-Tag: noindex` on every response is the real barrier
 * (set in next.config); this file only tells crawlers to skip paths that
 * would just waste auth redirects anyway. /login stays crawlable so its
 * noindex header is actually seen.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: ['/app/', '/api/'],
      },
    ],
  };
}
