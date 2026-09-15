'use client';

import { useEffect, useRef, useState } from 'react';
import {
  buildChartTheme,
  getDefaultChartColors,
  readChartColors,
  type ChartTheme,
} from './chart-theme';

/**
 * Chart theme resolved against the live tokens. Starts with the CSS-variable
 * defaults (identical on server and client, so no hydration mismatch) and, once
 * mounted, resolves the palette with `getComputedStyle`. It re-resolves when the
 * theme changes (`class` / `data-theme` on <html>, e.g. next-themes).
 */
export function useChartTheme(): {
  theme: ChartTheme;
  ref: React.RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<ChartTheme>(() => buildChartTheme(getDefaultChartColors()));

  useEffect(() => {
    const update = () => setTheme(buildChartTheme(readChartColors(ref.current)));
    update();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, []);

  return { theme, ref };
}
