import { ReactNode, useEffect, useState } from 'react';

/**
 * Smooth height slide (grid-template-rows 0fr ↔ 1fr) without measuring content.
 *
 * Self-managed mounting: children render only while open or animating, so a
 * closed SlideOpen costs nothing and every open remounts children fresh.
 * - Open:  mounts at 0fr, flips to 1fr after a double rAF so the transition runs.
 * - Close: animates to 0fr, unmounts children after the duration.
 */
export default function SlideOpen({ open, duration = 300, className = '', children }: {
  open: boolean;
  duration?: number;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), duration + 50);
    return () => clearTimeout(t);
  }, [open, duration]);

  if (!mounted) return null;
  return (
    <div
      className={`grid transition-[grid-template-rows] ease-in-out ${className}`}
      style={{ gridTemplateRows: shown ? '1fr' : '0fr', transitionDuration: `${duration}ms` }}
      aria-hidden={!shown}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  );
}
