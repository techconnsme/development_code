// frontend/src/hooks/useHighlightTarget.ts
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

interface HighlightState {
  highlight: string | null;
  highlightTx: string | null;
}

export function useHighlightTarget(durationMs = 3000): HighlightState {
  const location = useLocation();
  const [state, setState] = useState<HighlightState>({ highlight: null, highlightTx: null });

  useEffect(() => {
    const locState = location.state as any;
    if (locState?.highlight || locState?.highlightTx) {
      setState({ highlight: locState.highlight || null, highlightTx: locState.highlightTx || null });
      const timer = setTimeout(() => setState({ highlight: null, highlightTx: null }), durationMs);
      return () => clearTimeout(timer);
    }
  }, [location.state, durationMs]);

  return state;
}
