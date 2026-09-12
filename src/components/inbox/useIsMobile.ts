'use client';

import { useEffect, useState } from 'react';

/** True below 768px (one column at a time). SSR renders desktop. */
export function useIsMobile(maxWidth = 768): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [maxWidth]);
  return mobile;
}
