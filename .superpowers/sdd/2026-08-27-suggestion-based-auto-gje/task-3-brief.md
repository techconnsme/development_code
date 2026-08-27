# Task 3: Frontend — Create AutoGenerateSuggestionPanel component

**Files:**
- Create: `frontend/src/components/AutoGenerateSuggestionPanel.tsx`

**Interfaces:**
- Consumes: `api('/bookkeeping/auto-generate-entries?dry_run=true')`, `api('/bookkeeping/confirm-suggestion')`
- Produces: Component that renders suggestion list with confirm/reject/edit UI

## Steps

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/AutoGenerateSuggestionPanel.tsx`:

```typescript
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { tr } from '../lib/tr';
import { toast } from 'sonner';
import { RefreshCw, Check, X, CheckCircle, AlertTriangle } from 'lucide-react';

interface Suggestion {
  transaction_id: string;
  description: string;
  amount: number;
  direction: 'deposit' | 'withdrawal';
  transaction_date: string;
  bank_account_code: string;
  bank_account_name: string;
  contra_account_code: string;
  contra_account_name: string;
  confidence: 'confirmed' | 'needs_review';
  reason: string;
}

interface Props {
  onDone: () => void;
}

export default function AutoGenerateSuggestionPanel({ onDone }: Props) {
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch suggestions on mount
  const fetchSuggestions = useMutation({
    mutationFn: () => api('/bookkeeping/auto-generate-entries?dry_run=true', { method: 'POST' }),
    onSuccess: (data: any) => {
      setSuggestions(data.suggestions || []);
      setLoading(false);
      if ((data.suggestions || []).length === 0) {
        toast.info(tr(
          'All transactions already have journal entries.',
          '所有交易已有日誌分錄。',
          '所有交易已有日志分录。',
        ));
        onDone();
      }
    },
    onError: (err: any) => {
      setError(err?.message || err?.error || 'Failed to fetch suggestions');
      setLoading(false);
    },
  });

  // Confirm single suggestion
  const confirmMut = useMutation({
    mutationFn: (params: { transaction_id: string; contra_account_code?: string }) =>
      api('/bookkeeping/confirm-suggestion', { method: 'POST', body: JSON.stringify(params) }),
    onSuccess: (_data: any, params) => {
      setSuggestions(prev => prev.filter(s => s.transaction_id !== params.transaction_id));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
    onError: (err: any) => {
      toast.error(tr('Confirm failed: ', '確認失敗：', '确认失败：') + (err?.message || err?.error));
    },
  });

  // Confirm all confirmed-confidence items
  const confirmAllMut = useMutation({
    mutationFn: async () => {
      const confirmed = suggestions.filter(s => s.confidence === 'confirmed');
      for (const s of confirmed) {
        await api('/bookkeeping/confirm-suggestion', {
          method: 'POST',
          body: JSON.stringify({ transaction_id: s.transaction_id, contra_account_code: s.contra_account_code }),
        });
      }
      return { count: confirmed.length };
    },
    onSuccess: (data) => {
      setSuggestions(prev => prev.filter(s => s.confidence !== 'confirmed'));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      toast.info(tr(
        `${data.count} journal entries created.`,
        `已建立 ${data.count} 筆日誌分錄。`,
        `已建立 ${data.count} 笔日志分录。`,
      ));
    },
    onError: (err: any) => {
      toast.error(tr('Confirm all failed: ', '全部確認失敗：', '全部确认失败：') + (err?.message || err?.error));
    },
  });

  // Reject (remove from local state)
  const handleReject = (txId: string) => {
    setSuggestions(prev => prev.filter(s => s.transaction_id !== txId));
  };

  // Reject all
  const handleRejectAll = () => {
    setSuggestions([]);
  };

  // Update contra account for a suggestion
  const handleContraChange = (txId: string, newCode: string) => {
    setSuggestions(prev => prev.map(s =>
      s.transaction_id === txId ? { ...s, contra_account_code: newCode } : s
    ));
  };

  // Fetch on mount
  useState(() => { fetchSuggestions.mutate(); });

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {tr('Analyzing transactions...', '分析交易中...', '分析交易中...')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        {error}
        <button onClick={onDone} className="ml-2 underline">{tr('Close', '關閉', '关闭')}</button>
      </div>
    );
  }

  return (
    <div className="border rounded-xl bg-card p-4 space-y-3" data-testid="auto-generate-suggestions">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {tr(
            `${suggestions.length} transaction(s) ready for review`,
            `${suggestions.length} 筆交易待審核`,
            `${suggestions.length} 笔交易待审核`,
          )}
        </h3>
        <div className="flex gap-2">
          {suggestions.some(s => s.confidence === 'confirmed') && (
            <button
              onClick={() => confirmAllMut.mutate()}
              disabled={confirmAllMut.isPending}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              data-testid="confirm-all-btn"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              {tr('Confirm All Confirmed', '確認全部已確認', '确认全部已确认')}
            </button>
          )}
          <button
            onClick={handleRejectAll}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
            data-testid="reject-all-btn"
          >
            <X className="h-3.5 w-3.5" />
            {tr('Reject All', '拒絕全部', '拒绝全部')}
          </button>
        </div>
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {suggestions.map(s => (
          <div
            key={s.transaction_id}
            className={`flex flex-wrap items-center gap-2 p-2 rounded-lg border text-xs ${
              s.confidence === 'confirmed' ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
            }`}
            data-testid="suggestion-row"
          >
            {/* Confidence badge */}
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              s.confidence === 'confirmed'
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
              {s.confidence === 'confirmed' ? 'CONFIRMED' : 'NEEDS REVIEW'}
            </span>

            {/* Transaction info */}
            <span className="font-mono truncate max-w-[200px]" title={s.description}>{s.description}</span>
            <span className="text-muted-foreground">{s.transaction_date}</span>
            <span className="font-mono font-medium">
              {s.direction === 'deposit' ? '+' : '-'}${s.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>

            {/* Dr/Cr line */}
            <span className="text-muted-foreground">
              {s.direction === 'deposit' ? 'Dr' : 'Cr'} {s.bank_account_name}
              {' → '}
              {s.direction === 'deposit' ? 'Cr' : 'Dr'} {s.contra_account_name}
            </span>

            {/* Reason */}
            <span className="text-muted-foreground truncate max-w-[150px]" title={s.reason}>{s.reason}</span>

            {/* Editable contra account (simplified — in production use a dropdown with COA search) */}
            <input
              type="text"
              value={s.contra_account_code}
              onChange={(e) => handleContraChange(s.transaction_id, e.target.value)}
              className="w-20 px-1.5 py-0.5 border rounded text-xs font-mono"
              title={tr('Contra account code', '對方科目代碼', '对方科目代码')}
              data-testid="contra-input"
            />

            {/* Confirm button */}
            <button
              onClick={() => confirmMut.mutate({
                transaction_id: s.transaction_id,
                contra_account_code: s.contra_account_code,
              })}
              disabled={confirmMut.isPending}
              className="p-0.5 hover:bg-green-100 rounded text-green-600 disabled:opacity-40"
              title={tr('Confirm', '確認', '确认')}
              data-testid="confirm-btn"
            >
              <Check className="h-4 w-4" />
            </button>

            {/* Reject button */}
            <button
              onClick={() => handleReject(s.transaction_id)}
              disabled={confirmMut.isPending}
              className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40"
              title={tr('Reject', '拒絕', '拒绝')}
              data-testid="reject-btn"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {suggestions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-4">
          {tr('All done! Panel will close.', '全部完成！面板將關閉。', '全部完成！面板将关闭。')}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AutoGenerateSuggestionPanel.tsx
git commit -m "feat(frontend): add AutoGenerateSuggestionPanel component

Co-Authored-By: Claude <noreply@anthropic.com>"
```
