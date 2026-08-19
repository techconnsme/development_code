import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { tr } from '../lib/i18nHelpers';

const STORAGE_KEY = 'aiTokenUsage';

export function readTokenUsage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeTokenUsage(usage: { prompt: number; completion: number; total: number }) {
  const existing = readTokenUsage() || { prompt: 0, completion: 0, total: 0 };
  const updated = {
    prompt: existing.prompt + usage.prompt,
    completion: existing.completion + usage.completion,
    total: existing.total + usage.total,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

export function clearTokenUsage() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export default function TokenPopup() {
  const { i18n } = useTranslation();
  const [usage, setUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check on mount
    const data = readTokenUsage();
    if (data?.total > 0) setUsage(data);

    // Poll sessionStorage for changes (other pages write to it)
    const interval = setInterval(() => {
      const data = readTokenUsage();
      if (data?.total > 0) {
        setUsage(data);
        setDismissed(false); // show again if new data arrives
      }
    }, 500);

    return () => clearInterval(interval);
  }, []);

  if (!usage || usage.total === 0 || dismissed) return null;

  const label = i18n.language === 'zh-Hant' ? 'AI 令牌用量'
    : i18n.language === 'zh-Hans' ? 'AI 令牌用量'
    : 'AI Token Usage';
  const subtitle = i18n.language === 'zh-Hant' ? 'Qwen AI 已使用的總令牌數'
    : i18n.language === 'zh-Hans' ? 'Qwen AI 已使用的总令牌数'
    : 'Total tokens used by Qwen AI';

  return (
    <div className="fixed bottom-4 right-4 bg-card border shadow-lg rounded-lg p-4 z-50 max-w-xs">
      <div className="flex items-start justify-between mb-2">
        <h4 className="text-sm font-semibold flex items-center gap-1">
          <span>⚡</span> {label}
        </h4>
        <button
          onClick={() => { setDismissed(true); clearTokenUsage(); }}
          className="text-muted-foreground hover:text-foreground -mt-1 -mr-1 p-1"
        >
          ✕
        </button>
      </div>
      <p className="text-2xl font-bold">{usage.total.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
    </div>
  );
}
