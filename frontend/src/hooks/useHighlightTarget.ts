// frontend/src/hooks/useHighlightTarget.ts
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function useHighlightTarget(durationMs = 3000): string | null {
  const location = useLocation();
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    const state = location.state as any;
    if (state?.highlight) {
      setHighlightId(state.highlight);
      const timer = setTimeout(() => setHighlightId(null), durationMs);
      return () => clearTimeout(timer);
    }
  }, [location.state, durationMs]);

  return highlightId;
}
