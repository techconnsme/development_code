import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { filterLeafAccounts } from '../lib/coa-hierarchy';

// Money formatter — always 2 decimals with thousand separators
const money = (v: number | null | undefined): string => {
  if (v == null || v === undefined || isNaN(Number(v))) return '';
  return Number(v).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Parse user-typed money back to a number (strip commas + non-numeric)
const parseMoney = (s: string): number | null => {
  if (s == null || String(s).trim() === '') return null;
  const cleaned = String(s).replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
};

// Money input that DISPLAYS commas + 2 decimals when not focused,
// and shows the raw editable number while focused.
// Fixes Lily issues #3 and #11 (decimals/commas hidden until you click).
function MoneyInput({
  value, onChange, className = '', placeholder,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  className?: string;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const shown = focused
    ? draft
    : (value == null || value === undefined || isNaN(Number(value)) ? '' : money(value));
  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      onFocus={() => {
        setFocused(true);
        setDraft(value == null || isNaN(Number(value)) ? '' : String(value));
      }}
      onChange={e => {
        setDraft(e.target.value);
        onChange(parseMoney(e.target.value));
      }}
      onBlur={() => setFocused(false)}
      className={className}
    />
  );
}

interface Transaction {
  id: string;
  transaction_date: string;
  description: string;
  deposit_amount: number;
  withdrawal_amount: number;
  balance: number | null;
  reference?: string | null;
  account_type?: string | null;
  account_code?: string | null;
  match_status?: string | null;
}

interface StatementWithTx {
  id: string;
  file_name?: string;
  bank_name?: string;
  account_number?: string;
  branch?: string;
  currency?: string;
  account_type?: string;
  statement_year?: number;
  statement_month?: number;
  period_start?: string;
  period_end?: string;
  opening_balance?: number;
  closing_balance?: number;
  status?: string;
  ocr_source?: string;
  transactions?: Transaction[];
}

export default function BankStatementReview() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const isDuplicate = searchParams.get('is_duplicate') === '1';
  const dupStatus = searchParams.get('dup_status');
  const dupBlocked = searchParams.get('dup_blocked') === '1';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: stmt, isLoading } = useQuery<StatementWithTx>({
    queryKey: ['bank-statement', id],
    queryFn: () => api(`/bank-statements/${id}`),
    enabled: !!id,
  });

  // COA options for per-transaction account assignment/override
  interface CoaOption { account_code: string; account_name: string }
  const { data: coaResp } = useQuery<{ data: CoaOption[] }>({
    queryKey: ['coa-options'],
    queryFn: () => api('/bookkeeping/accounts'),
  });
  const coaOptions = useMemo(() => {
    const all = (coaResp?.data || []);
    // Parents with children are not postable — hide them (shared zero-stripped-
    // stem rule, same as the bank statements list pickers + backend PATCH guard).
    return filterLeafAccounts(all)
      .slice()
      .sort((x: any, y: any) => x.account_code.localeCompare(y.account_code));
  }, [coaResp]);

  // Local edit state
  const [headerEdits, setHeaderEdits] = useState<Partial<StatementWithTx>>({});
  const [txEdits, setTxEdits] = useState<Record<string, Partial<Transaction>>>({});
  const [deletedTxIds, setDeletedTxIds] = useState<Set<string>>(new Set());
  // Track whether the user has manually typed a closing balance.
  // While false, the closing balance auto-follows the computed running total
  // (Lily #4: accountants edit line items first, the total should follow).
  const [closingManuallyEdited, setClosingManuallyEdited] = useState(false);
  // Rows added manually via "Add Row" (used when OCR failed to read the file).
  const [localRows, setLocalRows] = useState<Transaction[]>([]);
  // Guard against double-submission — true for the ENTIRE save-and-confirm pipeline
  const [isSaving, setIsSaving] = useState(false);
  // Reset ALL local state when navigating to a different review (React Router reuses component)
  // This fixes the same class of bug as the previous isSaving-only fix:
  // stale pdfUrl/pdfError/edits leaking across queue items causes blank PDF panes and dead "Loading…" states.
  useEffect(() => {
    setIsSaving(false);
    setPdfUrl(null);
    setPdfError(null);
    setHeaderEdits({});
    setTxEdits({});
    setDeletedTxIds(new Set());
    setLocalRows([]);
    setClosingManuallyEdited(false);
  }, [id]);

  // PDF blob URL (loaded with auth)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Load PDF as blob (so we can pass through auth header)
  useEffect(() => {
    if (!id) return;
    let revokeUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        // Forward active client header so the backend scopes correctly
        const activeClientJson = localStorage.getItem('activeClient');
        if (activeClientJson) {
          try {
            const client = JSON.parse(activeClientJson);
            if (client?.id) headers['X-Active-Client'] = client.id;
          } catch {}
        }
        const resp = await fetch(`${WORKER_API_BASE}/bank-statements/${id}/file`, {
          headers,
          credentials: 'include',
        });
        if (!resp.ok) {
          setPdfError(`Could not load PDF (HTTP ${resp.status})`);
          return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        revokeUrl = url;
        if (!cancelled) setPdfUrl(url);
      } catch (e: any) {
        setPdfError(e?.message || 'Failed to load PDF');
      }
    })();
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [id]);

  // Mutations
  const saveHeaderMut = useMutation({
    mutationFn: (body: Partial<StatementWithTx>) =>
      api(`/bank-statements/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', id] });
      setHeaderEdits({});
    },
  });

  const saveTxMut = useMutation({
    mutationFn: ({ txId, body }: { txId: string; body: Partial<Transaction> }) =>
      api(`/bank-statements/transactions/${txId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', id] });
    },
  });

  const deleteTxMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', id] });
    },
  });

  // Create a brand-new transaction row (used by the "Add Row" button)
  const createTxMut = useMutation({
    mutationFn: (body: Partial<Transaction>) =>
      api(`/bank-statements/${id}/transactions`, { method: 'POST', body }),
  });

  // ── Review queue: after save/discard, load next queued item ──
  // Shift current item (position 0), then navigate to the NEXT one.
  function goNextInQueue() {
    const raw = sessionStorage.getItem('reviewQueue');
    if (!raw) return null;
    try {
      const queue: {docType:string, reviewId:string, filename:string, flags:string}[] = JSON.parse(raw);
      // Remove current item
      if (queue.length > 0) queue.shift();
      // Navigate to next item if any
      if (queue.length > 0) {
        const next = queue[0];
        sessionStorage.setItem('reviewQueue', JSON.stringify(queue));
        if (next.docType === 'bank_statement') navigate(`/bank-statements/review/${next.reviewId}`);
        else if (next.docType === 'card_statement') navigate(`/card-statements/review/${next.reviewId}`);
        else navigate(`/invoices/review/${next.reviewId}${next.flags || ''}`);
        return true;
      }
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    } catch {}
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
    return null;
  }

  const confirmMut = useMutation({
    mutationFn: (body?: any) => {
      return api(`/bank-statements/${id}/confirm`, { method: 'POST', body });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['bank-continuity'] });
      toast.success(tr('Saved to database! This statement is now confirmed.', '已儲存至數據庫！此月結單已確認。', '已储存至数据库！此月结单已确认。'));
      setIsSaving(false);
      const next = goNextInQueue();
      if (!next) {
        navigate('/bank-statements');
      }
    },
    onError: (err: any) => {
      toast.error(`Failed to save: ${err?.message || err?.error || 'Unknown error'}`);
      setIsSaving(false);
    },
  });

  const discardMut = useMutation({
    mutationFn: () => {
      return api(`/bank-statements/${id}`, { method: 'DELETE' });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['bank-continuity'] });
      setIsSaving(false);
      const next = goNextInQueue();
      if (!next) {
        toast.success(tr('Statement discarded.', '月結單已放棄。', '月结单已放弃。'));
        navigate('/bank-statements');
      }
    },
    onError: (err: any) => {
      toast.error(`Failed to discard: ${err?.message || err?.error || 'Unknown error'}`);
      setIsSaving(false);
    },
  });

  const transactions = useMemo(
    () => [
      ...(stmt?.transactions || []).filter(t => !deletedTxIds.has(t.id)),
      ...localRows,
    ],
    [stmt, deletedTxIds, localRows]
  );

  const totals = useMemo(() => {
    const rowChecks: Record<string, { expected: number; actual: number | null; mismatch: boolean }> = {};
    const opening = Number(headerEdits.opening_balance ?? stmt?.opening_balance ?? 0);

    // Resolve each transaction's edited values once, preserving original (statement) order.
    const resolved = transactions.map(tx => {
      const e = txEdits[tx.id] || {};
      const date = e.transaction_date ?? tx.transaction_date ?? '';
      const description = e.description ?? tx.description ?? '';
      const deposit = Number(e.deposit_amount ?? tx.deposit_amount) || 0;
      const withdrawal = Number(e.withdrawal_amount ?? tx.withdrawal_amount) || 0;
      const shown = e.balance ?? tx.balance;
      const balance = shown != null ? Number(shown) : null;
      const accountType = (e.account_type ?? tx.account_type) || null;
      return { id: tx.id, date, description, deposit, withdrawal, balance, accountType };
    });

    const dep = resolved.reduce((s, t) => s + t.deposit, 0);
    const wit = resolved.reduce((s, t) => s + t.withdrawal, 0);

    // A statement can contain multiple sub-ledgers in one document (e.g. HSBC
    // "HKD Current" + "HKD Savings" sections), each with its own running balance.
    // Figure out how to split "resolved" into per-ledger segments:
    const distinctTypes = new Set(resolved.map(t => t.accountType).filter(Boolean));
    let segments: (typeof resolved)[];

    if (distinctTypes.size >= 2) {
      // Preferred: the parser reliably tagged account_type on multiple ledgers — group by it.
      const byType = new Map<string, typeof resolved>();
      for (const t of resolved) {
        const key = t.accountType || '__untagged__';
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(t);
      }
      segments = Array.from(byType.values());
    } else {
      // Fallback: account_type wasn't reliably tagged (the AI parse doesn't always
      // set it consistently). Detect ledger boundaries deterministically instead,
      // using "B/F BALANCE" (bring-forward) marker rows — these mark the start of
      // a new sub-account section in the ORIGINAL statement order. This does NOT
      // depend on the AI's tagging and works even when account_type is entirely absent.
      const isBfBalance = (desc: string) => /B\/?F\s*BAL/i.test(desc || '');
      segments = [];
      let current: typeof resolved = [];
      for (const t of resolved) {
        if (isBfBalance(t.description) && current.length > 0) {
          segments.push(current);
          current = [];
        }
        current.push(t);
      }
      if (current.length > 0) segments.push(current);
    }

    let computedClosing = 0;
    if (segments.length <= 1) {
      // Single-ledger statement — one continuous running balance from the header opening balance.
      const ordered = [...resolved].sort((a, b) => a.date.localeCompare(b.date));
      let running = opening;
      for (const t of ordered) {
        running = running + t.deposit - t.withdrawal;
        const mismatch = t.balance !== null && Math.abs(t.balance - running) > 0.01;
        rowChecks[t.id] = { expected: running, actual: t.balance, mismatch };
      }
      computedClosing = running;
    } else {
      // Multi sub-ledger statement — validate each ledger independently, anchored
      // on its own first row's stated balance (typically its "B/F BALANCE" row).
      // Sort WITHIN each segment only — segments themselves are never merged,
      // so dates that happen to coincide across different ledgers can't cross-contaminate.
      for (const segTxs of segments) {
        const ordered = [...segTxs].sort((a, b) => a.date.localeCompare(b.date));
        const first = ordered[0];
        const anchor = first.balance !== null
          ? first.balance - (first.deposit - first.withdrawal)
          : opening;
        let running = anchor;
        for (const t of ordered) {
          running = running + t.deposit - t.withdrawal;
          const mismatch = t.balance !== null && Math.abs(t.balance - running) > 0.01;
          rowChecks[t.id] = { expected: running, actual: t.balance, mismatch };
        }
        computedClosing += running;
      }
    }

    const declaredClosing = Number(headerEdits.closing_balance ?? stmt?.closing_balance ?? 0);
    const closingMismatch = Math.abs(computedClosing - declaredClosing) > 0.01;
    return {
      dep, wit, net: dep - wit,
      opening, computedClosing, declaredClosing, closingMismatch,
      rowChecks,
      mismatchCount: Object.values(rowChecks).filter(c => c.mismatch).length,
    };
  }, [transactions, txEdits, headerEdits, stmt]);

  // Fix Issue 4: when the user edits ANY transaction row, clear the
  // "closing manually edited" flag so the closing balance follows automatically.
  // The only time we keep the flag is when the user has typed directly into
  // the Closing Balance field AND has not subsequently edited any row.
  useEffect(() => {
    setClosingManuallyEdited(false);
  }, [txEdits]);

  // Auto-sync closing balance to the computed running total UNLESS the user has
  // manually typed a closing balance. This means when an accountant edits the
  // line items, the closing balance at the top follows automatically (Lily #4).
  useEffect(() => {
    if (closingManuallyEdited) return;
    if (!stmt) return;
    const current = headerEdits.closing_balance ?? stmt.closing_balance;
    // Only push an update if it actually differs, to avoid render loops
    if (current == null || Math.abs(Number(current) - totals.computedClosing) > 0.01) {
      setHeaderEdits(prev => ({ ...prev, closing_balance: totals.computedClosing }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totals.computedClosing, closingManuallyEdited]);

  if (isLoading) {
    return <div className="p-6 text-center text-muted-foreground">Loading extracted data…</div>;
  }
  if (!stmt) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-600">Statement not found.</p>
        <Link to="/bank-statements" className="text-primary underline">← Back to Bank Statements</Link>
      </div>
    );
  }

  const isDraft = stmt.status === 'draft';
  const merged = { ...stmt, ...headerEdits };
  const headerHasChanges = Object.keys(headerEdits).length > 0;
  const txDirtyCount = Object.keys(txEdits).length;

  const upd = (k: keyof StatementWithTx, v: any) =>
    setHeaderEdits(prev => ({ ...prev, [k]: v }));

  const saveHeader = () => {
    if (!headerHasChanges) return;
    saveHeaderMut.mutate(headerEdits);
  };

  const saveAllTxEdits = async () => {
    for (const [txId, rowBody] of Object.entries(txEdits)) {
      const body = rowBody as Partial<Transaction>;
      // Local rows (added manually) are created, not patched
      if (txId.startsWith('local-')) {
        const row = localRows.find(r => r.id === txId);
        if (row) {
          const combined = { ...row, ...body };
          await createTxMut.mutateAsync({
            transaction_date: combined.transaction_date,
            description: combined.description,
            deposit_amount: combined.deposit_amount,
            withdrawal_amount: combined.withdrawal_amount,
            balance: combined.balance,
          });
        }
      } else {
        await saveTxMut.mutateAsync({ txId, body });
      }
    }
    // Create any local rows the user added but did not further edit
    for (const row of localRows) {
      if (!txEdits[row.id]) {
        await createTxMut.mutateAsync({
          transaction_date: row.transaction_date,
          description: row.description,
          deposit_amount: row.deposit_amount,
          withdrawal_amount: row.withdrawal_amount,
          balance: row.balance,
        });
      }
    }
    setTxEdits({});
    setLocalRows([]);
  };

  const addRow = () => {
    const newId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const lastDate = transactions.length > 0
      ? (transactions[transactions.length - 1].transaction_date || merged.period_start || '')
      : (merged.period_start || '');
    setLocalRows(prev => [...prev, {
      id: newId,
      transaction_date: lastDate,
      description: '',
      deposit_amount: 0,
      withdrawal_amount: 0,
      balance: null,
    }]);
  };

  const saveAndConfirm = async () => {
    setIsSaving(true);
    try {
      if (headerHasChanges) {
        await saveHeaderMut.mutateAsync(headerEdits);
      }
      if (txDirtyCount > 0 || localRows.length > 0) {
        await saveAllTxEdits();
      }
    } catch (e: any) {
      toast.error(`Failed to save edits: ${e?.message || e?.error || 'Unknown error'}`);
      setIsSaving(false);
      return;
    }
    const status = totals.closingMismatch ? 'mismatch' : 'ok';
    const check = totals.closingMismatch ? {
      expected: totals.computedClosing,
      actual: totals.declaredClosing,
      diff: totals.declaredClosing - totals.computedClosing,
      corrected_by_user: closingManuallyEdited,
    } : null;
    confirmMut.mutate({ balance_status: status, balance_check: check });
  };

  return (
    <div className="p-4 space-y-4 max-w-[1800px] mx-auto" key={id}>
      {/* Duplicate notice — import refused to create a second copy of this file */}
      {isDuplicate && (
        <div className="rounded-lg border-2 border-orange-400 bg-orange-50 dark:bg-orange-950/40 p-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🔁</div>
            <div>
              <h2 className="font-bold text-orange-800 dark:text-orange-200">
                {dupBlocked
                  ? tr('Already imported — showing the existing copy', '已導入過——正在顯示現有記錄', '已导入过——正在显示现有记录')
                  : tr('This statement has already been imported', '此月結單已導入過', '此月结单已导入过')}
              </h2>
              <p className="text-sm text-orange-700 dark:text-orange-300 mt-0.5">
                {dupBlocked
                  ? tr('This exact file was imported before, so nothing new was created. Review the existing records below, or discard the duplicate from the Bank Statements list.', '系統偵測到此文件之前已導入，未建立任何新數據。請在下方審核現有記錄，或於銀行月結單列表放棄重複項。', '系统侦测到此文件之前已导入，未创建任何新数据。请在下方审核现有记录，或于银行月结单列表放弃重复项。')
                  : dupStatus === 'deleted'
                  ? tr('This file was previously imported and later deleted. Saving will create a new record — journal entries will not be duplicated.', '此文件曾導入後被刪除。儲存將建立新記錄——不會重複記賬。', '此文件曾导入后被删除。储存将创建新记录——不会重复记账。')
                  : tr('A duplicate was detected. Please review before saving.', '檢測到重複。儲存前請先審核。', '检测到重复。储存前请先审核。')}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Banner */}
      {isDraft ? (
        <div className="rounded-lg border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-950 p-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl">⚠️</div>
            <div className="flex-1">
              <h2 className="font-bold text-yellow-900 dark:text-yellow-100">
                {tr('Review extracted data before saving to database', '儲存至數據庫前請先審核提取的數據', '储存至数据库前請先审核提取的數據')}
              </h2>
              <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                {i18n.language === 'en'
                  ? <>Compare the AI-extracted data on the right with the original PDF on the left. Edit any field that's wrong. When everything matches, click <strong>Save to Database</strong>.</>
                  : i18n.language === 'zh-Hans'
                  ? <>将右侧 AI 提取的数据与左侧原始 PDF 进行对比。修正任何错误，确认后点击<strong>储存至数据库</strong>。</>
                  : <>將右側 AI 提取的數據與左側原始 PDF 進行對比。修正任何錯誤，確認後點擊<strong>儲存至數據庫</strong>。</>}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-green-400 bg-green-50 dark:bg-green-950 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">✅</span>
            <p className="text-sm text-green-900 dark:text-green-100">
              {i18n.language === 'en'
                ? <><strong>Confirmed.</strong> This statement is saved. Any edits below save instantly.</>
                : i18n.language === 'zh-Hans'
                ? <><strong>已确认。</strong>此月结单已储存。以下的编辑将即时保存。</>
                : <><strong>已確認。</strong>此月結單已儲存。以下的編輯將即時保存。</>}
            </p>
          </div>
        </div>
      )}

      {/* Split-screen: PDF left, data right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ minHeight: '70vh' }}>
        {/* Left: PDF viewer */}
        <div className="rounded-lg border bg-card flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
            <h3 className="font-bold text-sm">{tr('📄 Original Document', '📄 原始文件', '📄 原始文件')}</h3>
            <span className="text-xs text-muted-foreground truncate ml-2">{stmt.file_name || 'PDF'}</span>
          </div>
          <div className="flex-1 bg-muted/10 relative" style={{ minHeight: '70vh' }}>
            {pdfError ? (
              <div className="p-4 text-sm text-red-600 text-center">
                {pdfError}
                <br/><span className="text-muted-foreground">You can still review and edit the extracted data on the right.</span>
              </div>
            ) : !pdfUrl ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Loading PDF…</div>
            ) : (
              <iframe
                src={pdfUrl}
                title="Bank statement PDF"
                className="w-full h-full border-0"
                style={{ minHeight: '70vh' }}
              />
            )}
          </div>
        </div>

        {/* Right: Extracted data */}
        <div className="space-y-4 overflow-y-auto" style={{ maxHeight: '85vh' }}>
          {/* Header info */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
              {tr('📋 Extracted Statement Details', '📋 提取的月結單資料', '📋 提取的月结单资料')}
              {merged.ocr_source && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  merged.ocr_source === 'glm-ocr'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                }`}>
                  OCR: {merged.ocr_source === 'glm-ocr' ? 'GLM-OCR' : 'toMarkdown'}
                </span>
              )}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={tr('Bank Name', 'Bank Name 銀行名稱', 'Bank Name 银行名称')} value={merged.bank_name || ''} onChange={v => upd('bank_name', v)} />
              <Field label={tr('Account Number', 'Account Number 帳號', 'Account Number 账号')} value={merged.account_number || ''} onChange={v => upd('account_number', v)} />
              <Field label={tr('Branch', 'Branch 分行', 'Branch 分行')} value={merged.branch || ''} onChange={v => upd('branch', v)} />
              <Field label={tr('Currency', 'Currency 貨幣', 'Currency 货币')} value={merged.currency || ''} onChange={v => upd('currency', v)} />
              <Field label={tr('Period Start', 'Period Start 開始日期', 'Period Start 開始日期')} value={merged.period_start || ''} onChange={v => upd('period_start', v)} placeholder="YYYY-MM-DD" />
              <Field label={tr('Period End', 'Period End 結束日期', 'Period End 結束日期')} value={merged.period_end || ''} onChange={v => upd('period_end', v)} placeholder="YYYY-MM-DD" />
              <label className="block">
                <span className="text-xs text-muted-foreground">{tr('Opening Balance', 'Opening Balance 期初餘額', 'Opening Balance 期初余额')}</span>
                <MoneyInput
                  value={merged.opening_balance ?? null}
                  onChange={v => upd('opening_balance', v ?? 0)}
                  className="mt-1 block w-full px-2 py-1.5 bg-background border border-input rounded text-sm text-right"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground flex items-center justify-between">
                  <span>{tr('Closing Balance', 'Closing Balance 期末餘額', 'Closing Balance 期末余额')}</span>
                  <button
                    type="button"
                    onClick={() => { setClosingManuallyEdited(false); upd('closing_balance', totals.computedClosing); }}
                    className={`text-xs underline ${totals.closingMismatch ? 'text-blue-600 font-medium' : 'text-muted-foreground hover:text-blue-600'}`}
                    title={tr('Set to computed value (opening + deposits − withdrawals)', '設定為計算值（期初 + 存入 - 支出）', '设定为计算值（期初 + 存入 - 支出）')}
                  >
                    {totals.computedClosing !== 0 ? `= ${money(totals.computedClosing)}` : tr('auto-fill', '自動填寫', '自动填写')}
                  </button>
                </span>
                <MoneyInput
                  value={merged.closing_balance ?? null}
                  onChange={v => { setClosingManuallyEdited(true); upd('closing_balance', v ?? 0); }}
                  className="mt-1 block w-full px-2 py-1.5 bg-background border border-input rounded text-sm text-right"
                />
              </label>
            </div>
            {headerHasChanges && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={saveHeader}
                  disabled={saveHeaderMut.isPending}
                  className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs"
                >
                  {saveHeaderMut.isPending ? (tr('Saving…', '儲存中…', '储存中…')) : (tr('💾 Save header changes', '💾 儲存標題修改', '💾 储存標題修改'))}
                </button>
                <button
                  onClick={() => setHeaderEdits({})}
                  className="px-3 py-1.5 border rounded text-xs hover:bg-muted"
                >
                  {tr('Discard', '放棄', '放弃')}
                </button>
              </div>
            )}
          </div>

          {/* Balance verification banner */}
          {(totals.closingMismatch || totals.mismatchCount > 0) && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-xs">
              <div className="font-bold text-red-800 dark:text-red-200 mb-1">⚠️ Balance discrepancy detected</div>
              {totals.closingMismatch && (
                <div className="text-red-700 dark:text-red-300">
                  Closing balance should be <span className="font-mono font-bold">{money(totals.computedClosing)}</span> based on
                  opening ({money(totals.opening)}) + deposits ({money(totals.dep)}) − withdrawals ({money(totals.wit)}),
                  but the statement shows <span className="font-mono font-bold">{money(totals.declaredClosing)}</span>.
                  Difference: <span className="font-mono font-bold">{money(totals.declaredClosing - totals.computedClosing)}</span>.
                  <button
                    type="button"
                    onClick={() => { setClosingManuallyEdited(false); upd('closing_balance', totals.computedClosing); }}
                    className="ml-2 bg-red-100 hover:bg-red-200 text-red-800 px-2 py-0.5 rounded border border-red-300"
                  >
                    Fix: use computed value
                  </button>
                </div>
              )}
              {totals.mismatchCount > 0 && (
                <div className="text-red-700 dark:text-red-300 mt-1">
                  {totals.mismatchCount} row{totals.mismatchCount === 1 ? '' : 's'} have a per-row balance that doesn't match the running total (highlighted below).
                </div>
              )}
            </div>
          )}
          {!totals.closingMismatch && totals.mismatchCount === 0 && transactions.length > 0 && (
            <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/30 p-2 text-xs text-green-700 dark:text-green-300">
              ✓ Balance verified: opening + deposits − withdrawals = closing, and every row's balance matches the running total.
            </div>
          )}

          {/* Transactions */}
          <div className="rounded-lg border bg-card p-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold text-sm">💳 Transactions ({transactions.length})</h3>
              <div className="text-xs text-muted-foreground">
                <span className="text-green-600 font-mono">+{money(totals.dep)}</span>
                <span className="mx-1">·</span>
                <span className="text-red-600 font-mono">-{money(totals.wit)}</span>
                <span className="mx-1">·</span>
                <span className="font-mono font-bold">Net {money(totals.net)}</span>
              </div>
            </div>

            {transactions.length === 0 ? (
              <div className="py-6 text-center border-2 border-dashed rounded">
                <div className="text-3xl mb-2">📝</div>
                <div className="font-medium text-sm">No transactions were extracted</div>
                <div className="text-xs text-muted-foreground mt-1 mb-3">
                  The system could not read this file automatically. Enter the transactions manually below.
                </div>
                <button
                  onClick={addRow}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90"
                >
                  + Add first row
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-1 pr-1 font-medium w-20">{tr('Date', '日期', '日期')}</th>
                      <th className="py-1 pr-1 font-medium">{tr('Description', '描述', '描述')}</th>
                      <th className="py-1 pr-1 font-medium text-right w-20">{tr('Deposit', '存入', '存入')}</th>
                      <th className="py-1 pr-1 font-medium text-right w-20">{tr('Withdrawal', '提取', '提取')}</th>
                      <th className="py-1 pr-1 font-medium text-right w-20">{tr('Balance', '餘額', '余额')}</th>
                      <th className="py-1 pr-1 font-medium w-36">{tr('COA Account', '會計科目', '会计科目')}</th>
                      <th className="py-1 font-medium w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(tx => {
                      const e = txEdits[tx.id] || {};
                      const date = e.transaction_date ?? tx.transaction_date;
                      const desc = e.description ?? tx.description;
                      const dep = e.deposit_amount ?? tx.deposit_amount;
                      const wit = e.withdrawal_amount ?? tx.withdrawal_amount;
                      const bal = e.balance ?? tx.balance;
                      const dirty = !!txEdits[tx.id];
                      const check = totals.rowChecks[tx.id];
                      const mismatch = check?.mismatch;
                      const selectedCoa = (e.account_code ?? tx.account_code) || '';
                      const upTx = (field: keyof Transaction, value: any) =>
                        setTxEdits(prev => ({ ...prev, [tx.id]: { ...prev[tx.id], [field]: value } }));
                      const isLocal = tx.id.startsWith('local-');
                      const rowBg =
                        mismatch ? 'bg-red-50 dark:bg-red-950/30' :
                        isLocal ? 'bg-blue-50 dark:bg-blue-950/20' :
                        dirty ? 'bg-yellow-50 dark:bg-yellow-900/20' : '';
                      return (
                        <tr key={tx.id} className={`border-b ${rowBg}`}
                            title={mismatch ? `Balance mismatch: expected ${money(check.expected)} but shows ${money(check.actual)}` : ''}>
                          <td className="py-1 pr-1">
                            <input
                              value={date || ''}
                              onChange={ev => upTx('transaction_date', ev.target.value)}
                              className="w-full px-1 py-0.5 bg-transparent border border-input rounded text-xs"
                            />
                          </td>
                          <td className="py-1 pr-1">
                            <input
                              value={desc || ''}
                              onChange={ev => upTx('description', ev.target.value)}
                              className="w-full px-1 py-0.5 bg-transparent border border-input rounded text-xs"
                            />
                            {tx.match_status === 'not_required' && (
                              <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                                <span className="px-1 py-px rounded bg-muted border border-border font-medium">N/A</span>
                                {tr('Opening balance — no link or posting required', '期初結餘——無需連結或過賬', '期初结余——无需连结或过账')}
                              </div>
                            )}
                            {!tx.match_status && (dep > 0 || wit > 0) && (
                              <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                {dep > 0
                                  ? <>Dr {(stmt as any)?.account_code || '11103'} {money(dep)} · Cr {selectedCoa || '—'} {money(dep)}</>
                                  : <>Dr {selectedCoa || '—'} {money(wit)} · Cr {(stmt as any)?.account_code || '11103'} {money(wit)}</>}
                                <span className="ml-1 opacity-70">
                                  {tr('(posts on confirm — splits available after)', '(確認後過賬——其後可拆分)', '(确认后过账——其后可拆分)')}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="py-1 pr-1">
                            <MoneyInput
                              value={dep ?? 0}
                              onChange={v => upTx('deposit_amount', v ?? 0)}
                              className="w-full px-1 py-0.5 bg-transparent border border-input rounded text-xs text-right text-green-700"
                            />
                          </td>
                          <td className="py-1 pr-1">
                            <MoneyInput
                              value={wit ?? 0}
                              onChange={v => upTx('withdrawal_amount', v ?? 0)}
                              className="w-full px-1 py-0.5 bg-transparent border border-input rounded text-xs text-right text-red-700"
                            />
                          </td>
                          <td className="py-1 pr-1">
                            <MoneyInput
                              value={bal ?? null}
                              onChange={v => upTx('balance', v)}
                              className={`w-full px-1 py-0.5 bg-transparent border rounded text-xs text-right ${mismatch ? 'border-red-500 text-red-700' : 'border-input'}`}
                            />
                            {mismatch && (
                              <div className="text-[10px] text-red-600 text-right mt-0.5">
                                should be {money(check.expected)}
                              </div>
                            )}
                          </td>
                          <td className="py-1 pr-1">
                            {(() => {
                              const selected = (e.account_code ?? tx.account_code) || '';
                              const selAcct = coaOptions.find(o => o.account_code === selected);
                              const isTemp = !!selAcct && /temporary/i.test(selAcct.account_name);
                              const isNA = tx.match_status === 'not_required';
                              return (
                                <select
                                  value={selected}
                                  onChange={ev => upTx('account_code', ev.target.value || null)}
                                  title={
                                    isNA
                                      ? tr('Opening balance — no invoice link or COA posting required', '期初結餘——無需發票連結或會計分錄', '期初结余——无需发票连结或会计分录')
                                      : isTemp
                                      ? tr('Temporary account — reclassify to a specific COA account later', '暫記科目——稍後重新分類至具體會計科目', '暂记科目——稍后重新分类至具体会计科目')
                                      : tr('Chart of Accounts account for auto-posting', '自動過賬的會計科目', '自动过账的会计科目')
                                  }
                                  className={`w-full px-1 py-0.5 bg-transparent border rounded text-xs ${
                                    isTemp ? 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'border-input'
                                  }`}
                                >
                                  <option value="">{isNA ? tr('N/A · opening balance', 'N/A · 期初結餘', 'N/A · 期初结余') : tr('N/A 不適用', 'N/A 不適用', 'N/A 不适用')}</option>
                                  {coaOptions.map(a => (
                                    <option key={a.account_code} value={a.account_code}>
                                      {a.account_code} {a.account_name.length > 18 ? a.account_name.slice(0, 18) + '…' : a.account_name}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </td>
                          <td className="py-1 text-center">
                            <button
                              onClick={() => {
                                if (tx.id.startsWith('local-')) {
                                  // Local row — just remove from local state
                                  setLocalRows(prev => prev.filter(r => r.id !== tx.id));
                                  setTxEdits(prev => { const n = { ...prev }; delete n[tx.id]; return n; });
                                } else if (confirm('Delete this transaction?')) {
                                  setDeletedTxIds(prev => new Set(prev).add(tx.id));
                                  deleteTxMut.mutate(tx.id);
                                }
                              }}
                              className="text-red-600 hover:text-red-800 text-xs"
                              title="Delete transaction"
                            >
                              🗑
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t-2 border-gray-300 bg-muted/30">
                    <tr>
                      <td colSpan={2} className="py-2 pr-1 font-bold text-xs">
                        {transactions.length} transaction{transactions.length === 1 ? '' : 's'}
                      </td>
                      <td className="py-2 pr-1 text-right font-mono font-bold text-green-700">{money(totals.dep)}</td>
                      <td className="py-2 pr-1 text-right font-mono font-bold text-red-700">{money(totals.wit)}</td>
                      <td className="py-2 pr-1 text-right font-mono font-bold text-xs">
                        <div>Opening: {money(totals.opening)}</div>
                        <div>Closing: {money(totals.computedClosing)}</div>
                      </td>
                      <td className="py-2"></td>
                      <td className="py-2"></td>
                    </tr>
                  </tfoot>
                </table>
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={addRow}
                    className="text-xs px-3 py-1.5 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 font-medium"
                    title="Add a row that OCR may have missed"
                  >
                    + Add Row
                  </button>
                </div>
              </div>
            )}

            {txDirtyCount > 0 && (
              <div className="mt-3 flex gap-2 items-center">
                <button
                  onClick={saveAllTxEdits}
                  className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs"
                >
                  💾 {tr(`Save ${txDirtyCount} transaction edit${txDirtyCount === 1 ? '' : 's'}`, `儲存 ${txDirtyCount} 筆交易修改`, `储存 ${txDirtyCount} 笔交易修改`)}
                </button>
                <button
                  onClick={() => setTxEdits({})}
                  className="px-3 py-1.5 border rounded text-xs hover:bg-muted"
                >
                  {tr('Discard changes', '放棄修改', '放弃修改')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer actions — in normal document flow at the bottom of the page */}
      <div className="rounded-lg border-2 border-primary bg-primary/5 p-4 mt-2">
        {isDraft ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="font-bold text-sm">{tr('Ready to save?', '準備儲存？', '準備储存？')}</h3>
              <p className="text-xs text-muted-foreground">
                {i18n.language === 'en'
                  ? <>Click <strong>Save to Database</strong> to confirm this statement. You can still edit it later.</>
                  : i18n.language === 'zh-Hans'
                  ? <>点击<strong>储存至数据库</strong>确认此月结单。之后仍可编辑。</>
                  : <>點擊<strong>儲存至數據庫</strong>確認此月結單。之後仍可編輯。</>}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (confirm(tr('Discard this statement? It will be moved to the Recycle Bin where it can be restored within 30 days.', '放棄此月結單？將移至回收站，可在30天內還原。', '放弃此月结单？將移至回收站，可在30天內还原。'))) {
                    discardMut.mutate();
                  }
                }}
                disabled={discardMut.isPending}
                className="px-4 py-2 border border-red-300 text-red-600 rounded text-sm hover:bg-red-50 dark:hover:bg-red-950"
              >
                {discardMut.isPending
                  ? (tr('Discarding…', '放棄中…', '放弃中…'))
                  : (tr('🗑 Discard', '🗑 放棄', '🗑 放弃'))}
              </button>
              <button
                onClick={saveAndConfirm}
                disabled={isSaving || confirmMut.isPending || saveHeaderMut.isPending || createTxMut.isPending || transactions.length === 0}
                className="px-6 py-2 bg-green-600 text-white rounded font-bold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={transactions.length === 0 ? (tr('Add at least one transaction before saving', '儲存前請先新增至少一筆交易', '储存前請先新增至少一笔交易')) : ''}
              >
                {isSaving || confirmMut.isPending
                  ? (tr('Saving…', '儲存中…', '储存中…'))
                  : (tr('✅ Save to Database', '✅ 儲存至數據庫', '✅ 储存至数据库'))}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {tr('This statement is already saved. Edits save instantly.', '此月結單已儲存。編輯將即時保存。', '此月结单已储存。編輯將即時保存。')}
            </p>
            <Link to="/bank-statements"
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm"
            >
              {tr('← Back to Bank Statements', '← 返回銀行月結單', '← 返回银行月结单')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="mt-0.5 block w-full px-2 py-1.5 bg-background border border-input rounded text-xs"
      />
    </label>
  );
}
