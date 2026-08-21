import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { useToast } from '../components/Toast';
import { Eye, Trash2, Landmark, ChevronDown, ChevronRight, FileText, Link2, Check, X, Zap, Search, Tag, Download, Upload, FilePlus, Pencil, CreditCard, AlertTriangle, Ban, Sparkles, CheckCircle2 } from 'lucide-react';
import ContinuityChain from '../components/ContinuityChain';
import { useDateFilter } from '../contexts/DateFilterContext';
import { useAuth } from '../contexts/AuthContext';
import SupervisorPasswordModal from '../components/SupervisorPasswordModal';
import AutoMatchReviewModal from '../components/AutoMatchReviewModal';
import { tr } from '../lib/i18nHelpers';

interface Transaction {
  id: string;
  transaction_date: string;
  description: string;
  deposit_amount: number;
  withdrawal_amount: number;
  balance: number;
  account_type: string;
  account_code?: string | null;
  reference: string | null;
  sort_order: number;
  invoice_id?: string | null;
  match_confidence?: string | null;
  match_status?: string;
  invoice_number?: string | null;
  invoice_total?: number | null;
  invoice_status?: string | null;
  card_statement_id?: string | null;
  card_issuer?: string | null;
  cs_statement_year?: number | null;
  cs_statement_month?: number | null;
  cs_closing_balance?: number | null;
}

export default function BankStatements() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff' || user?.role === 'viewer';
  const { startDate, endDate } = useDateFilter();
  const [supModal, setSupModal] = useState<{ show: boolean; onConfirm: () => void } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const highlightStmtId = searchParams.get('highlight') || null;
  const activeFilter = searchParams.get('filter') || null;
  const [matchTxId, setMatchTxId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [edits, setEdits] = useState<Record<string, Partial<Transaction>>>({});
  const [acctModalTx, setAcctModalTx] = useState<Transaction | null>(null);
  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [reconData, setReconData] = useState<any>(null);
  // Default OFF: balance_status='ok' only means the balance math checked out at
  // import — it does NOT mean the statement is reconciled. Hiding COA controls by
  // default blocked account assignment on every auto-verified statement (2026-08-17).
  const [hideReconciledCoa, setHideReconciledCoa] = useState(false);
  const [autoMatchResults, setAutoMatchResults] = useState<any[] | null>(null);
  const [cardMatchResults, setCardMatchResults] = useState<any[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['bank-statements', startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      return api(`/bank-statements?${params.toString()}`);
    },
  });

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
  });
  const accounts: any[] = accountsData?.data || [];

  const detailQuery = useQuery({
    queryKey: ['bank-statement', expandedId],
    queryFn: () => api(`/bank-statements/${expandedId}`),
    enabled: !!expandedId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/bank-statements/${id}`, { method: 'DELETE' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['bank-continuity'] });
      queryClient.invalidateQueries({ queryKey: ['bank-transactions-flat'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      setExpandedId(null);
      const cascadeMsg = data?.transactions_deleted != null
        ? `\n${data.transactions_deleted} transaction${data.transactions_deleted === 1 ? '' : 's'} also removed.`
        : '';
      const fileMsg = data?.file_deleted ? '\nOriginal PDF also removed from File Storage.' : '';
      const restoreMsg = data?.restorable_until
        ? '\n\nItem moved to Recycle Bin — can be restored within 30 days.'
        : '';
      if (cascadeMsg || fileMsg || restoreMsg) {
        setTimeout(() => toast.info(`Statement deleted.${cascadeMsg}${fileMsg}${restoreMsg}`), 10);
      }
    },
    onError: (err: any) => {
      if (err?.status === 403 || /higher permission/i.test(err?.error || err?.message || '')) {
        toast.info('Delete not allowed for your account. Only account owner or boss-level users can delete records. Please ask your admin.');
      } else {
        toast.info(`Delete failed: ${err?.error || err?.message || 'Unknown error'}`);
      }
    },
  });

  const autoMatchMut = useMutation({
    mutationFn: () => api('/bank-statements/auto-match', { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
      if (data.matched?.length > 0) {
        setAutoMatchResults(data.matched);
      } else {
        toast.info(tr('No matches found. All deposits are either already matched or have no invoice candidates.', '沒有找到配對。所有存款要麼已配對，要麼沒有發票候選。', '没有找到配对。所有存款要么已配对，要么没有发票候选。'));
      }
    },
  });

  const confirmMatchMut = useMutation({
    mutationFn: ({ txId, invoiceId }: { txId: string; invoiceId: string }) =>
      api(`/bank-statements/transactions/${txId}/match`, {
        method: 'PATCH',
        body: { invoice_id: invoiceId, action: 'confirm' },
      }),
    onSuccess: (_data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
      queryClient.invalidateQueries({ queryKey: ['entries'] }); // GL payment posted server-side by the confirm endpoint
    },
    onError: (err: any) => {
      toast.error(err?.error || err?.message || tr('Confirm failed', '確認失敗', '确认失败'));
    },
  });

  const unlinkMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}/match`, {
        method: 'PATCH',
        body: { action: 'unlink' },
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] }); },
  });

  const createInvoiceMut = useMutation({
    mutationFn: (txId: string) => api('/invoices/generate-from-transaction', { method: 'POST', body: { transaction_id: txId } }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/invoices?highlight=${data.id}`);
    },
    onError: (err: any) => {
      toast.info(`Could not create invoice: ${err?.error || err?.message || 'Unknown error'}`);
    },
  });

  const autoCatMut = useMutation({
    mutationFn: () => api(`/bank-statements/${expandedId}/auto-categorize`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
      toast.info(tr(`Auto-categorized: ${data.categorized} rows, skipped ${data.skipped} (total ${data.total})`, `已自動分類：${data.categorized} 筆，跳過 ${data.skipped} 筆（共 ${data.total} 筆）`, `已自动分類：${data.categorized} 笔，跳過 ${data.skipped} 笔（共 ${data.total} 笔）`));
    },
  });

  const updateTxMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) =>
      api(`/bank-statements/transactions/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
    },
  });

  const autoMatchCardsMut = useMutation({
    mutationFn: () => api('/bank-statements/auto-match-cards', { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
      if (data.matched?.length > 0) {
        setCardMatchResults(data.matched);
      } else {
        toast.info(tr('No card matches found.', '沒有找到信用卡配對。', '没有找到信用卡配对。'));
      }
    },
  });

  const cardLinkMut = useMutation({
    mutationFn: ({ txId, csId, action }: { txId: string; csId?: string; action: 'link' | 'unlink' }) =>
      api(`/bank-statements/transactions/${txId}/card-link`, {
        method: 'PATCH',
        body: { card_statement_id: csId, action },
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] }); },
  });

  const skipLinkMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}/skip-link`, { method: 'PATCH' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] }); },
  });

  const statements = (data?.data || []) as any[];

  const highlightFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightStmtId || highlightFiredRef.current === highlightStmtId) return;
    setExpandedId(highlightStmtId);
    const tryScroll = (retries: number) => {
      const card = document.getElementById(`stmt-row-${highlightStmtId}`);
      if (card) {
        highlightFiredRef.current = highlightStmtId;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => card.classList.remove('ring-2', 'ring-blue-400'), 3000);
      } else if (retries > 0) {
        setTimeout(() => tryScroll(retries - 1), 150);
      }
    };
    tryScroll(8);
  }, [highlightStmtId, statements]);

  const filterFiredRef = useRef<boolean>(false);
  useEffect(() => {
    if (activeFilter !== 'unmatched' || filterFiredRef.current || !statements.length) return;
    filterFiredRef.current = true;
    const stmtsWithUnreconciled = statements.filter((s: any) => s.unlinked_count > 0);
    if (stmtsWithUnreconciled.length > 0) {
      setExpandedId(stmtsWithUnreconciled[0].id);
      setTimeout(() => {
        const card = document.getElementById(`stmt-row-${stmtsWithUnreconciled[0].id}`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    }
  }, [activeFilter, statements]);

  const detail = detailQuery.data as any;
  const transactions = detail?.transactions || [];

  const filteredTransactions = activeFilter === 'unmatched'
    ? transactions.filter((tx: Transaction) =>
        !tx.invoice_id && !tx.card_statement_id &&
        tx.match_status !== 'confirmed' && tx.match_status !== 'skipped' &&
        tx.match_status !== 'suggested'
      )
    : transactions;
  const displayTransactions = activeFilter === 'unmatched' ? filteredTransactions : transactions;

  const totalDeposits = displayTransactions.reduce((s: number, tx: Transaction) => s + tx.deposit_amount, 0);
  const totalWithdrawals = displayTransactions.reduce((s: number, tx: Transaction) => s + tx.withdrawal_amount, 0);
  const suggestedCount = displayTransactions.filter((tx: Transaction) => tx.match_status === 'suggested').length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t('bank.title')}</h2>
        <p className="text-muted-foreground mt-1">{t('bank.desc')}</p>
      </div>

      {activeFilter === 'unmatched' && (
        <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            <span>{tr('Showing only unreconciled transactions', '僅顯示未對賬交易', '仅显示未对账交易')}</span>
          </div>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.delete('filter');
              navigate(`/bank-statements${params.toString() ? '?' + params.toString() : ''}`, { replace: true });
            }}
            className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline"
          >
            {tr('Clear filter', '清除篩選', '清除筛选')}
          </button>
        </div>
      )}

      <PendingReviewBanner />

      {/* Continuity Chain */}
      <ContinuityChain endpoint="/bank-statements/continuity" queryKey="bank-continuity" type="bank" />

      {/* Statements list */}
      <div className="bg-card border rounded-xl p-6 space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Landmark className="h-4 w-4" /> {t('bank.list')} ({statements.length})
        </h3>
        {isLoading ? <p className="text-sm text-muted-foreground">{t('common.loading')}</p> :
         statements.length === 0 ? <p className="text-sm text-muted-foreground">{t('bank.noData')}</p> :
         activeFilter === 'unmatched' && statements.every((s: any) => s.unlinked_count === 0) ? (
          <div className="text-center py-8">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {tr('No unreconciled transactions found', '沒有未對賬交易', '没有未对账交易')}
            </p>
            <button
              onClick={() => navigate('/dashboard')}
              className="text-xs text-primary hover:underline mt-2"
            >
              {tr('Back to dashboard', '返回主頁', '返回主页')}
            </button>
          </div>
         ) : (
          <div className="space-y-2">
            {statements.map((s: any) => (
              <div key={s.id} id={`stmt-row-${s.id}`}>
                <div
                  className="flex items-center justify-between border rounded-md px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      {expandedId === s.id
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      }
                      <span className="text-sm font-medium truncate">
                        {s.statement_year}-{String(s.statement_month).padStart(2, '0')} {s.bank_name || 'Statement'}
                      </span>
                      {s.account_type && (
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">{s.account_type}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground ml-6">
                      {s.account_number && <span>{s.account_number}</span>}
                      {s.branch && <span className="text-muted-foreground/60">{s.branch}</span>}
                      {s.currency && <span className="font-mono">{s.currency}</span>}
                      {s.closing_balance != null && (
                        <span className={`font-mono font-medium ${s.closing_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {s.closing_balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      )}
                      {activeFilter === 'unmatched' && s.unlinked_count > 0 && (
                        <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium px-2 py-0.5 rounded-full">
                          {s.unlinked_count} {tr('unreconciled', '未對賬', '未对账')}
                        </span>
                      )}
                      {activeFilter !== 'unmatched' && s.tx_count > 0 && s.unlinked_count > 0 && (
                        <span className="text-xs text-amber-600 font-medium">
                          ⚠ {s.unlinked_count}/{s.tx_count} unlinked ({Math.round(s.unlinked_count / s.tx_count * 100)}%)
                        </span>
                      )}
                      {activeFilter !== 'unmatched' && s.tx_count > 0 && s.unlinked_count === 0 && (
                        <span className="text-xs text-green-600 font-medium">✓ All linked</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0 ml-2 items-center" onClick={e => e.stopPropagation()}>
                    {s.balance_status === 'mismatch' && <span className="text-xs text-red-600 font-medium" title="Balance mismatch — confirmed with unresolved difference">⚠</span>}
                    {s.balance_status === 'corrected' && <span className="text-xs text-blue-600 font-medium" title="AI data corrected manually">✏</span>}
                    <a href={`/api/bank-statements/${s.id}/file?token=${localStorage.getItem('token') || ''}`} target="_blank" className="p-1.5 hover:bg-muted rounded" title="View original file">
                      <Eye className="h-4 w-4" />
                    </a>
                    <button
                      onClick={() => {
                        setExpandedId(s.id);
                        setEditMode(true);
                        setEdits({});
                      }}
                      className="p-1.5 hover:bg-muted rounded"
                      title="Edit transactions"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => {
                      const doDelete = () => deleteMut.mutate(s.id);
                      if (isStaff) {
                        setSupModal({ show: true, onConfirm: doDelete });
                      } else {
                        if (confirm(t('common.confirmDelete'))) doDelete();
                      }
                    }}
                      className="p-1.5 hover:bg-muted rounded text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Expanded: Transaction table */}
                {expandedId === s.id && (
                  <div className="border-x border-b rounded-b-md bg-muted/10 px-4 py-3">
                    {detailQuery.isLoading ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">
                        {tr('Loading transactions...', '載入交易中...', '载入交易中...')}
                      </p>
                    ) : filteredTransactions.length === 0 ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                        <FileText className="h-4 w-4" />
                        {tr('No transactions found', '沒有找到交易', '沒有找到交易')}
                      </div>
                    ) : (
                      <div>
                        {/* Summary bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground mb-3 px-1">
                          <div className="flex flex-wrap items-center gap-3">
                            {detail?.period_start && (
                              <span>Period: {detail.period_start} – {detail.period_end}</span>
                            )}
                            <span>Opening: <span className="font-mono font-medium">{detail?.opening_balance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '-'}</span></span>
                            <span>Closing: <span className="font-mono font-medium text-green-600">{detail?.closing_balance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '-'}</span></span>
                            <div className="flex items-center gap-1">
                              {!isStaff && (
                              <a href={`/api/bank-statements/${detail?.id}/export-csv?token=${localStorage.getItem('token') || ''}`}
                                className="px-2 py-1 text-xs rounded border hover:bg-muted flex items-center gap-1"
                                title="Export CSV">
                                <Download className="h-3 w-3" /> CSV
                              </a>
                              )}
                              <label className="px-2 py-1 text-xs rounded border hover:bg-muted cursor-pointer flex items-center gap-1"
                                title="Import CSV">
                                <Upload className="h-3 w-3" /> CSV
                                <input type="file" accept=".csv" className="hidden"
                                  onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    const text = await file.text();
                                    try {
                                      await api(`/bank-statements/${detail?.id}/import-csv`, {
                                        method: 'POST',
                                        body: { csv: text },
                                      });
                                      queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
                                      toast.success(tr('CSV import complete', 'CSV 匯入完成', 'CSV 汇入完成'));
                                    } catch (err: any) {
                                      toast.error((tr('Import failed: ', '匯入失敗：', '汇入失败：')) + (err.message || 'unknown'));
                                    }
                                    e.target.value = '';
                                  }} />
                              </label>
                              <button onClick={() => { setEditMode(!editMode); setEdits({}); }}
                                className={`px-2 py-1 text-xs rounded border ${editMode ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'}`}>
                                {editMode
                                  ? (tr('Done Editing', '完成編輯', '完成編輯'))
                                  : (tr('✏️ Edit', '✏️ 編輯', '✏️ 編輯'))}
                              </button>
                              {detail?.balance_status === 'ok' && (
                                <button onClick={() => setHideReconciledCoa(!hideReconciledCoa)}
                                  className={`px-2 py-1 text-xs rounded border hover:bg-muted ${hideReconciledCoa ? 'bg-green-50 border-green-300' : ''}`}
                                  title={hideReconciledCoa ? tr('Show COA accounts', '顯示會計科目', '显示会计科目') : tr('Hide reconciled COA', '隱藏已對賬科目', '隐藏已对账科目')}>
                                  {hideReconciledCoa
                                    ? tr('🔒 Reconciled', '🔒 已對賬', '🔒 已对账')
                                    : tr('🔓 Show COA', '🔓 顯示科目', '🔓 显示科目')}
                                </button>
                              )}
                              <button onClick={async () => {
                                if (!detail?.id) return;
                                try {
                                  const res = await api(`/bank-statements/${detail.id}/reconcile`, { method: 'POST' });
                                  setReconData(res);
                                } catch (err: any) {
                                  toast.error((tr('Reconcile failed: ', '對賬失敗：', '对账失败：')) + (err.message || 'unknown'));
                                }
                              }}
                                className="px-2 py-1 text-xs rounded border hover:bg-green-100">
                                {tr('🔍 Reconcile', '🔍 對賬 Reconcile', '🔍 对账 Reconcile')}
                              </button>
                              <button onClick={() => autoMatchMut.mutate()}
                                disabled={autoMatchMut.isPending}
                                className="px-2 py-1 text-xs rounded border hover:bg-blue-100 flex items-center gap-1">
                                <Sparkles className="h-3 w-3" />
                                {autoMatchMut.isPending ? '...' : tr('Auto-Match Invoices', '自動配對發票', '自动配对发票')}
                              </button>
                              <button onClick={() => autoMatchCardsMut.mutate()}
                                disabled={autoMatchCardsMut.isPending}
                                className="px-2 py-1 text-xs rounded border hover:bg-purple-100 flex items-center gap-1">
                                <CreditCard className="h-3 w-3" />
                                {autoMatchCardsMut.isPending ? '...' : tr('Match Cards', '配對信用卡', '配对信用卡')}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-left text-xs text-muted-foreground">
                                <th className="py-2 pr-3 font-medium">Date</th>
                                <th className="py-2 pr-3 font-medium">Description</th>
                                <th className="py-2 pr-3 font-medium max-w-[120px]">{tr('Voucher', '憑證', '凭证')}</th>
                                {detail?.accounts?.length > 1 && <th className="py-2 pr-3 font-medium">Account</th>}
                                <th className="py-2 pr-3 font-medium text-right">Deposit</th>
                                <th className="py-2 pr-3 font-medium text-right">Withdrawal</th>
                                <th className="py-2 pr-3 font-medium text-right">Balance</th>
                                <th className="py-2 pr-3 font-medium min-w-[200px]">Account</th>
                                <th className="py-2 font-medium text-center">{tr('Linked Document', '連結文件', '连结文件')}</th>
                                {editMode && <th className="py-2 font-medium text-center w-16">Save</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {filteredTransactions.map((tx: Transaction) => {
                                const e = edits[tx.id] || {};
                                const date = e.transaction_date !== undefined ? e.transaction_date : tx.transaction_date;
                                const desc = e.description !== undefined ? e.description : tx.description;
                                const dep = e.deposit_amount !== undefined ? e.deposit_amount : tx.deposit_amount;
                                const wit = e.withdrawal_amount !== undefined ? e.withdrawal_amount : tx.withdrawal_amount;
                                const bal = e.balance !== undefined ? e.balance : tx.balance;
                                const dirty = !!edits[tx.id];

                                return (
                                <tr key={tx.id} className={`border-b border-muted/50 hover:bg-muted/20 ${dirty ? 'bg-blue-50 dark:bg-blue-950/20' : ''} ${
                                  tx.match_status === 'suggested' ? 'bg-yellow-50 dark:bg-yellow-950/20' :
                                  tx.match_status === 'confirmed' ? 'bg-green-50 dark:bg-green-950/20' : ''
                                } ${
                                  activeFilter === 'unmatched' && !tx.invoice_id && !tx.card_statement_id &&
                                  tx.match_status !== 'confirmed' && tx.match_status !== 'skipped'
                                    ? 'border-l-4 border-l-amber-400' : ''
                                }`}>
                                  <td className="py-1.5 pr-3 whitespace-nowrap">
                                    {/* Flag: unlinked + not skipped → needs attention */}
                                    {!editMode && !tx.invoice_number && !tx.card_statement_id && tx.match_status !== 'suggested' && tx.match_status !== 'skipped' && (
                                      <span className="inline-flex items-center mr-1 text-amber-500" title="This transaction needs a linked document or to be marked as skipped">
                                        <AlertTriangle className="h-3 w-3" />
                                      </span>
                                    )}
                                    {editMode ? (
                                      <input value={date || ''} onChange={e => setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], transaction_date: e.target.value}}))}
                                        className="w-24 px-1 py-0.5 border rounded text-xs bg-background" />
                                    ) : (
                                      <span className="text-muted-foreground">{tx.transaction_date?.slice(5)}</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 max-w-[300px]">
                                    {editMode ? (
                                      <input value={desc || ''} onChange={e => setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], description: e.target.value}}))}
                                        className="w-full px-1 py-0.5 border rounded text-xs bg-background" />
                                    ) : (
                                      <span className="truncate block" title={tx.description}>{tx.description}</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 max-w-[120px]">
                                    {(tx as any).voucher_number ? (
                                      <span className="text-[10px] font-mono bg-muted/30 px-1 py-0.5 rounded truncate block" title={(tx as any).voucher_number}>
                                        {(tx as any).voucher_number}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground italic">—</span>
                                    )}
                                  </td>
                                  {detail?.accounts?.length > 1 && (
                                    <td className="py-1.5 pr-3">
                                      <span className="text-xs bg-muted px-1 rounded">{tx.account_type}</span>
                                    </td>
                                  )}
                                  <td className="py-1.5 pr-3 text-right font-mono text-green-600">
                                    {editMode ? (
                                      <input type="number" step="0.01" value={dep || 0} onChange={e => setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], deposit_amount: parseFloat(e.target.value) || 0}}))}
                                        className="w-24 px-1 py-0.5 border rounded text-xs text-right bg-background" />
                                    ) : (
                                      dep > 0 ? dep.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right font-mono text-red-600">
                                    {editMode ? (
                                      <input type="number" step="0.01" value={wit || 0} onChange={e => setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], withdrawal_amount: parseFloat(e.target.value) || 0}}))}
                                        className="w-24 px-1 py-0.5 border rounded text-xs text-right bg-background" />
                                    ) : (
                                      wit > 0 ? wit.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right font-mono">
                                    {editMode ? (
                                      <input type="number" step="0.01" value={bal != null ? bal : 0} onChange={e => setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], balance: parseFloat(e.target.value) || 0}}))}
                                        className="w-24 px-1 py-0.5 border rounded text-xs text-right bg-background" />
                                    ) : (
                                      bal > 0 ? bal.toLocaleString(undefined, { minimumFractionDigits: 2 }) :
                                      bal < 0 ? <span className="text-red-600">{bal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span> :
                                      '0.00'
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3" onClick={e => e.stopPropagation()}>
                                    {tx.account_code ? (
                                      (() => {
                                        const acc = accounts.find((a: any) => a.account_code === tx.account_code);
                                        const name = acc?.account_name || '(unknown account)';
                                        const isReconciled = !!detail?.is_reconciled;
                                        return (
                                          <span
                                            className={`text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded inline-block max-w-[260px] truncate ${
                                              isReconciled && hideReconciledCoa ? 'opacity-60 cursor-default' : 'cursor-pointer hover:bg-primary/20'
                                            }`}
                                            title={`${tx.account_code} · ${name}${isReconciled ? tr(' (reconciled)', '（已對賬）', '（已对账）') : ''}`}
                                            onClick={() => { if (!(isReconciled && hideReconciledCoa)) setAcctModalTx(tx); }}>
                                            <span className="font-mono">{tx.account_code}</span>
                                            <span className="text-muted-foreground ml-1">{name}</span>
                                            {isReconciled && <span className="text-[9px] ml-1 text-green-600">✓</span>}
                                          </span>
                                        );
                                      })()
                                    ) : hideReconciledCoa && detail?.is_reconciled ? (
                                      <span className="text-xs text-muted-foreground italic">—</span>
                                    ) : (
                                      <select
                                        className="text-xs border rounded px-1 py-0.5 bg-background max-w-[260px] truncate cursor-pointer"
                                        value={tx.account_code || ''}
                                        onChange={e => {
                                          if (e.target.value) {
                                            updateTxMut.mutate({ id: tx.id, body: { account_code: e.target.value } });
                                          }
                                        }}
                                        onClick={e => e.stopPropagation()}
                                      >
                                        <option value="" className="text-muted-foreground">
                          {tr('-- Select account --', '-- 選科目 --', '-- 選科目 --')}
                        </option>
                                        {accounts.map((a: any) => (
                                          <option key={a.account_code} value={a.account_code}>
                                            {a.account_code} {a.account_name}
                                          </option>
                                        ))}
                                      </select>
                                    )}
                                  </td>
                                  <td className="py-1.5 text-center">
                                    {/* ── Invoice linked ── */}
                                    {tx.invoice_number && (
                                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${tx.match_status === 'suggested' ? 'text-yellow-700 bg-yellow-100 dark:bg-yellow-900/30' : 'text-green-700 bg-green-100 dark:bg-green-900/30'}`}>
                                        {tx.invoice_number}
                                        {tx.match_status === 'suggested' ? (
                                          <>
                                            <button onClick={() => confirmMatchMut.mutate({ txId: tx.id, invoiceId: tx.invoice_id! })}
                                              className="p-0.5 text-green-600 hover:bg-green-100 rounded" title="Confirm">
                                              <Check className="h-3.5 w-3.5" />
                                            </button>
                                            <button onClick={() => unlinkMut.mutate(tx.id)}
                                              className="p-0.5 text-red-500 hover:bg-red-100 rounded" title="Reject">
                                              <X className="h-3.5 w-3.5" />
                                            </button>
                                          </>
                                        ) : (
                                          <button onClick={() => unlinkMut.mutate(tx.id)} className="hover:text-red-600" title="Unlink">
                                            <X className="h-3 w-3" />
                                          </button>
                                        )}
                                      </span>
                                    )}
                                    {/* ── Card statement linked ── */}
                                    {tx.card_statement_id && tx.card_issuer && (
                                      <span className="inline-flex items-center gap-1 text-xs text-purple-700 bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 rounded">
                                        <CreditCard className="h-3 w-3" />
                                        {tx.card_issuer}
                                        {tx.cs_statement_year && ` ${tx.cs_statement_year}-${String(tx.cs_statement_month || 1).padStart(2, '0')}`}
                                        <button onClick={() => cardLinkMut.mutate({ txId: tx.id, action: 'unlink' })} className="hover:text-red-600" title="Unlink card">
                                          <X className="h-3 w-3" />
                                        </button>
                                      </span>
                                    )}
                                    {/* ── Opted out (no link needed) ── */}
                                    {!tx.card_statement_id && !tx.invoice_number && tx.match_status === 'skipped' && (
                                      <button onClick={() => skipLinkMut.mutate(tx.id)}
                                        className="text-gray-400 hover:text-amber-500" title="Undo — mark as needing a link">
                                        <Ban className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    {/* ── Two-icon row: link or opt-out ── */}
                                    {!tx.card_statement_id && !tx.invoice_number && tx.match_status !== 'suggested' && tx.match_status !== 'skipped' && (
                                      <div className="flex items-center gap-1.5 justify-center">
                                        <button onClick={() => setMatchTxId(tx.id)}
                                          className="text-muted-foreground hover:text-primary" title="Link to invoice or card statement">
                                          <Link2 className="h-3.5 w-3.5" />
                                        </button>
                                        <button onClick={() => skipLinkMut.mutate(tx.id)}
                                          className="text-muted-foreground hover:text-gray-500" title="No link needed — opt out">
                                          <Ban className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                  {editMode && (
                                    <td className="py-1.5 text-center">
                                      <div className="flex items-center gap-1 justify-center">
                                        <button onClick={async () => {
                                          if (aiLoading) return;
                                          setAiLoading(tx.id);
                                          try {
                                            const data = await api('/chat', {
                                              method: 'POST',
                                              body: {
                                                message: `Fix this bank transaction if it looks wrong. Common errors: description merged from multiple lines, amounts that don't match the merchant (e.g., NAME-CHEAP is ~$100 not $14,000).

Date: ${tx.transaction_date}
Description: ${tx.description}
Deposit: ${tx.deposit_amount}
Withdrawal: ${tx.withdrawal_amount}
Balance: ${tx.balance}

Return ONLY a JSON object with corrected fields. If nothing needs fixing, return {}. Format: {"description":"...","deposit_amount":N,"withdrawal_amount":N,"note":"explanation"}`,
                                                history: [],
                                              },
                                            });
                                            const reply = data.reply || '';
                                            // Extract JSON from reply (skip DSML tags)
                                            const cleanReply = reply.replace(/<[^>]+>/g, '');
                                            const jsonMatch = cleanReply.match(/\{[\s\S]*\}/);
                                            if (jsonMatch) {
                                              try {
                                                const json = JSON.parse(jsonMatch[0]);
                                                if (json.description || json.deposit_amount !== undefined || json.withdrawal_amount !== undefined) {
                                                  const update: any = {};
                                                  if (json.description) update.description = json.description;
                                                  if (json.deposit_amount !== undefined) update.deposit_amount = json.deposit_amount;
                                                  if (json.withdrawal_amount !== undefined) update.withdrawal_amount = json.withdrawal_amount;
                                                  if (json.balance !== undefined) update.balance = json.balance;
                                                  setEdits(prev => ({...prev, [tx.id]: {...prev[tx.id], ...update}}));
                                                  if (json.note) toast.info('AI: ' + json.note);
                                                } else {
                                                  toast.info(tr('AI determined no changes needed', 'AI 認為此交易無需修改', 'AI 认为此交易无需修改'));
                                                }
                                              } catch { toast.info(tr('AI response could not be parsed: ', 'AI 回應無法解析：', 'AI 回应无法解析：') + cleanReply.slice(0, 200)); }
                                            } else {
                                              toast.info(tr('AI response: ', 'AI 回應：', 'AI 回应：') + reply.slice(0, 300));
                                            }
                                          } catch (e: any) { toast.info('AI 失敗：' + (e.message || 'unknown')); }
                                          setAiLoading(null);
                                        }}
                                          disabled={aiLoading === tx.id}
                                          className={`px-2 py-0.5 text-xs rounded text-white ${
                                            aiLoading === tx.id
                                              ? 'bg-purple-300 animate-pulse'
                                              : 'bg-purple-500 hover:opacity-90'
                                          }`}
                                          title="AI 根據 OCR 原始資料修正">
                                          {aiLoading === tx.id ? '⏳' : '🤖'} AI
                                        </button>
                                        <button onClick={() => {
                                          updateTxMut.mutate({ id: tx.id, body: edits[tx.id] });
                                          setEdits(prev => { const n = {...prev}; delete n[tx.id]; return n; });
                                        }}
                                          disabled={!dirty}
                                          className="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-30">
                                          Save
                                        </button>
                                      </div>
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                            </tbody>
                            <tfoot>
                              <tr className="border-t font-medium text-xs">
                                <td colSpan={detail?.accounts?.length > 1 ? 3 : 2} className="py-2 text-muted-foreground">
                                  {filteredTransactions.length} transactions
                                  {suggestedCount > 0 && <span className="ml-2 text-yellow-600">({suggestedCount} suggested)</span>}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-green-600">
                                  {totalDeposits.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-red-600">
                                  {totalWithdrawals.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </td>
                                <td></td>
                                <td></td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Account categorization modal */}
      {acctModalTx && (
        <AccountModal
          tx={acctModalTx}
          allTx={filteredTransactions}
          accounts={accounts}
          onClose={() => setAcctModalTx(null)}
          onApply={(code, _applySimilar, similarIds) => {
            // Update this transaction
            updateTxMut.mutate({ id: acctModalTx.id, body: { account_code: code } });
            // Update selected similar transactions
            if (similarIds && similarIds.size > 0) {
              similarIds.forEach((tid: string) => {
                updateTxMut.mutate({ id: tid, body: { account_code: code } });
              });
            }
            setAcctModalTx(null);
          }}
        />
      )}

      {/* Unified link document modal */}
      {matchTxId && (
        <LinkedDocModal
          txId={matchTxId}
          onClose={() => setMatchTxId(null)}
          onLinkInvoice={(invoiceId) => {
            confirmMatchMut.mutate({ txId: matchTxId, invoiceId });
            setMatchTxId(null);
          }}
          onLinkCard={(csId) => {
            cardLinkMut.mutate({ txId: matchTxId, csId, action: 'link' });
            setMatchTxId(null);
          }}
        />
      )}

      {/* Auto-Match Review Modal (shared unified component) */}
      {autoMatchResults && (
        <AutoMatchReviewModal
          matches={autoMatchResults}
          onConfirm={(txId, invoiceId) =>
            confirmMatchMut.mutateAsync({ txId, invoiceId })
          }
          onReject={(txId) =>
            unlinkMut.mutateAsync(txId)
          }
          onClose={() => {
            setAutoMatchResults(null);
            queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
          }}
        />
      )}

      {/* Card Match Review Modal */}
      {cardMatchResults && (
        <CardMatchReviewModal
          matches={cardMatchResults}
          onConfirm={(txId, csId) => {
            cardLinkMut.mutate({ txId, csId, action: 'link' });
          }}
          onReject={(txId) => {
            skipLinkMut.mutate(txId);
          }}
          onClose={() => {
            setCardMatchResults(null);
            queryClient.invalidateQueries({ queryKey: ['bank-statement', expandedId] });
          }}
        />
      )}

      {/* Bank Reconciliation Modal */}
      {reconData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setReconData(null)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">{tr('Bank Reconciliation', '銀行對賬 Bank Reconciliation', '银行对账 Bank Reconciliation')}</h3>
              <span className={`text-sm font-bold px-3 py-1 rounded ${Math.abs(reconData.difference || 0) < 0.01 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {Math.abs(reconData.difference || 0) < 0.01
                  ? (tr('✓ Balanced', '✓ 相符', '✓ 相符'))
                  : (tr('⚠ Difference', '⚠ 不符', '⚠ 不符'))}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-muted/50 rounded-lg p-3">
                <span className="text-muted-foreground text-xs">{tr('Statement Balance', '月結單餘額', '月结单余额')}</span>
                <p className="font-bold text-lg">HKD {reconData.statement_balance?.toLocaleString()}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <span className="text-muted-foreground text-xs">{tr('GL Balance', '總賬餘額', '總賬余额')}</span>
                <p className="font-bold text-lg">HKD {reconData.gl_balance?.toLocaleString()}</p>
              </div>
            </div>
            <div className="text-sm flex justify-between border-t pt-3">
              <span>{tr('Difference', '差異 Difference', '差异 Difference')}</span>
              <span className={`font-bold ${Math.abs(reconData.difference || 0) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                HKD {reconData.difference?.toLocaleString()}
              </span>
            </div>
            {(reconData.outstanding_transactions || []).length > 0 && (
              <div>
                <span className="text-sm font-medium">
                  {tr(`Outstanding (${reconData.outstanding_transactions.length})`, `未達交易 Outstanding (${reconData.outstanding_transactions.length})`, `未達交易 Outstanding (${reconData.outstanding_transactions.length})`)}
                </span>
                <div className="max-h-48 overflow-y-auto mt-2 border rounded-lg divide-y">
                  {(reconData.outstanding_transactions || []).map((t: any) => (
                    <div key={t.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/30">
                      <span className="w-20 text-muted-foreground">{t.transaction_date}</span>
                      <span className="flex-1 truncate mx-2">{t.description?.slice(0, 50)}</span>
                      <span className={`font-mono ${t.deposit_amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {t.deposit_amount > 0 ? `+${t.deposit_amount.toLocaleString()}` : t.withdrawal_amount > 0 ? `-${t.withdrawal_amount.toLocaleString()}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setReconData(null)} className="px-4 py-2 border rounded-md text-sm">
                {tr('Close', '關閉', '关闭')}
              </button>
            </div>
          </div>
        </div>
      )}

      {supModal?.show && (
        <SupervisorPasswordModal
          action="delete this bank statement"
          onConfirm={supModal.onConfirm}
          onCancel={() => setSupModal(null)}
        />
      )}
    </div>
  );
}


function AccountModal({ tx, allTx, accounts, onClose, onApply }: {
  tx: Transaction;
  allTx: Transaction[];
  accounts: any[];
  onClose: () => void;
  onApply: (code: string, applySimilar: boolean, similarIds?: Set<string>) => void;
}) {
  const { i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState(tx.account_code || '');
  const [selectedSimilar, setSelectedSimilar] = useState<Set<string>>(new Set());

  const filtered = accounts.filter((a: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.account_code.includes(q) || (a.account_name || '').toLowerCase().includes(q);
  });

  // Find similar transactions
  const desc = tx.description || '';
  const words = desc.split(/\s+/).filter((w: string) => w.length > 2).slice(0, 3);
  const similar = allTx.filter((t: Transaction) =>
    t.id !== tx.id && words.some((w: string) => (t.description || '').includes(w))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-4 w-[80vw] mx-4 space-y-3 max-h-[70vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg flex items-center gap-2"><Tag className="h-5 w-5" /> {tr('Select Account Code', '選擇會計科目', '选择会计科目')}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-5 w-5" /></button>
        </div>

        {/* Transaction info */}
        <div className="bg-muted/30 rounded-lg p-3 text-sm flex items-center gap-3">
          <span className="font-medium flex-shrink-0">{tx.transaction_date}</span>
          <span className="text-muted-foreground truncate flex-1 min-w-0">{desc}</span>
          <span className={`font-mono flex-shrink-0 font-medium ${tx.deposit_amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
            {tx.deposit_amount > 0 ? `+${tx.deposit_amount.toLocaleString()}` :
             tx.withdrawal_amount > 0 ? `-${tx.withdrawal_amount.toLocaleString()}` : ''}
          </span>
          {tx.account_code && (
            <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded flex-shrink-0">
              <span className="font-mono">{tx.account_code}</span>
              <span className="ml-1">{accounts.find((a: any) => a.account_code === tx.account_code)?.account_name?.slice(0, 20) || ''}</span>
            </span>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={tr('Search by code or name...', '輸入科目編號或名稱搜尋...', '輸入科目编号或名称搜索...')}
            className="w-full pl-9 pr-3 py-2 border rounded-md text-sm bg-background" autoFocus />
        </div>

        {/* Account list */}
        <div className="border rounded-lg max-h-36 overflow-y-auto">
          {filtered.slice(0, 50).map((a: any) => (
            <button key={a.account_code}
              onClick={() => setSelectedCode(a.account_code)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between ${
                selectedCode === a.account_code ? 'bg-primary/10 text-primary font-medium' : ''
              }`}>
              <span className="font-mono text-xs">{a.account_code}</span>
              <span className="flex-1 ml-3 truncate">{a.account_name}</span>
              {selectedCode === a.account_code && <Check className="h-4 w-4 text-primary flex-shrink-0" />}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">{tr('No matching accounts', '無匹配科目', '无匹配科目')}</p>
          )}
        </div>

        {/* Apply to similar transactions */}
        {similar.length > 0 && (
          <div className="border rounded-lg">
            <div className="px-3 py-2 bg-muted/30 border-b text-sm font-medium flex items-center gap-2">
              <span>{tr(`Similar transactions (${similar.length})`, `相似交易 (${similar.length})`, `相似交易 (${similar.length})`)}</span>
              <span className="text-xs text-muted-foreground">
                {(() => {
                  const cats = new Map<string, number>();
                  similar.forEach((t: Transaction) => {
                    const k = t.account_code ? `${t.account_code} ${accounts.find((a: any) => a.account_code === t.account_code)?.account_name?.slice(0, 8) || ''}` : '未分類';
                    cats.set(k, (cats.get(k) || 0) + 1);
                  });
                  return Array.from(cats.entries()).map(([k, v]) => `${k}(${v})`).join('  ');
                })()}
              </span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground w-24 text-right">金額</span>
              <span className="text-xs text-muted-foreground text-right" style={{minWidth: '120px'}}>科目</span>
              <button onClick={() => {
                if (selectedSimilar.size === similar.length) setSelectedSimilar(new Set());
                else setSelectedSimilar(new Set(similar.map((t: Transaction) => t.id)));
              }}
                className="text-xs text-primary hover:underline">
                {selectedSimilar.size === similar.length
                  ? (tr('Deselect All', '取消全選', '取消全选'))
                  : (tr('Select All', '全選', '全选'))}
              </button>
            </div>
            <div className="max-h-36 overflow-y-auto">
              {similar.map((t: Transaction) => (
                <label key={t.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 cursor-pointer border-b border-muted/30 last:border-0">
                  <input type="checkbox"
                    checked={selectedSimilar.has(t.id)}
                    onChange={() => {
                      const next = new Set(selectedSimilar);
                      if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                      setSelectedSimilar(next);
                    }}
                    className="flex-shrink-0" />
                  <span className="text-xs text-muted-foreground w-14 flex-shrink-0">{t.transaction_date?.slice(5)}</span>
                  <span className="text-xs truncate flex-1 min-w-0">{t.description?.slice(0, 80)}</span>
                  <span className={`text-xs font-mono flex-shrink-0 w-24 text-right ${t.deposit_amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {t.deposit_amount > 0 ? `+${t.deposit_amount.toLocaleString()}` :
                     t.withdrawal_amount > 0 ? `-${t.withdrawal_amount.toLocaleString()}` : ''}
                  </span>
                  <span className="text-xs flex-shrink-0 text-right min-w-[120px]">
                    {t.account_code ? (
                      <span className="bg-primary/10 text-primary px-1 py-0.5 rounded">
                        <span className="font-mono">{t.account_code}</span>
                        <span className="text-muted-foreground ml-1">
                          {accounts.find((a: any) => a.account_code === t.account_code)?.account_name?.slice(0, 12) || ''}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Apply button */}
        <button onClick={() => {
          if (selectedCode) onApply(selectedCode, false, selectedSimilar);
        }}
          disabled={!selectedCode}
          className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-30">
          {selectedSimilar.size > 0
            ? (tr(`Apply to ${selectedSimilar.size + 1} transactions`, `套用科目（含 ${selectedSimilar.size} 筆相似交易）`, `套用科目（含 ${selectedSimilar.size} 笔相似交易）`))
            : (tr('Apply Account Code', '套用科目', '套用科目'))}
        </button>
      </div>
    </div>
  );
}

// ── Unified Link Document Modal (Invoice + Card Statement) ──
function LinkedDocModal({ txId, onClose, onLinkInvoice, onLinkCard }: {
  txId: string; onClose: () => void; onLinkInvoice: (id: string) => void; onLinkCard: (csId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'invoice' | 'card'>('invoice');
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Fetch transaction details for context
  const { data: txData } = useQuery({
    queryKey: ['bank-transaction', txId],
    queryFn: () => api(`/bank-statements/transactions/${txId}`),
  });
  const tx = txData as any;

  const { data: invData } = useQuery({
    queryKey: ['unpaid-invoices', search],
    queryFn: () => api(`/invoices?status=draft,sent,overdue${search ? `&q=${search}` : ''}`),
    enabled: tab === 'invoice',
  });
  const invoices = (invData?.data || []) as any[];

  const { data: cardData } = useQuery({
    queryKey: ['card-statements-list', search],
    queryFn: () => api(`/card-statements?q=${search}`),
    enabled: tab === 'card',
  });
  const cardStmts = (cardData?.data || []) as any[];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold flex items-center gap-2 mb-3"><Link2 className="h-4 w-4" /> {tr('Link Document', '連結文件', '连结文件')}</h3>

        {/* Transaction context */}
        {tx && (
          <div className="bg-muted/50 rounded-lg p-3 mb-3 text-sm grid grid-cols-3 gap-2">
            <div><span className="text-muted-foreground">{tr('Description', '描述', '描述')}:</span> <span className="font-medium">{tx.description?.slice(0, 60)}</span></div>
            <div><span className="text-muted-foreground">{tr('Date', '日期', '日期')}:</span> {tx.transaction_date}</div>
            <div><span className="text-muted-foreground">{tr('Amount', '金額', '金额')}:</span> <span className="font-mono font-medium">HKD {(tx.deposit_amount || tx.withdrawal_amount || 0)?.toLocaleString()}</span></div>
          </div>
        )}

        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left: search + list */}
          <div className="w-1/2 space-y-3 overflow-y-auto">
            <div className="flex gap-1 border-b">
              <button onClick={() => setTab('invoice')}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${tab === 'invoice' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                <FileText className="h-3.5 w-3.5 inline mr-1" />{tr('Invoices', '發票', '发票')}
              </button>
              <button onClick={() => setTab('card')}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${tab === 'card' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                <CreditCard className="h-3.5 w-3.5 inline mr-1" />{tr('Card Statements', '信用卡月結單', '信用卡月结单')}
              </button>
            </div>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder={tab === 'invoice' ? tr('Search invoices...', '搜尋發票...', '搜寻发票...') : tr('Search card statements...', '搜尋信用卡月結單...', '搜寻信用卡月结单...')}
              className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
            <div className="max-h-96 overflow-y-auto space-y-1">
              {tab === 'invoice' && invoices.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">{tr('No unpaid invoices', '沒有未付款發票', '没有未付款发票')}</p>}
              {tab === 'invoice' && invoices.map((inv: any) => (
                <div key={inv.id} className="flex items-center gap-2">
                  <button onClick={() => onLinkInvoice(inv.id)}
                    className="flex-1 flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted text-sm text-left">
                    <div>
                      <span className="font-medium">{inv.invoice_number || inv.id}</span>
                      <span className="ml-2 text-muted-foreground text-xs">{(inv.customer_name || inv.vendor_name || '').slice(0, 30)}</span>
                      {inv.description && <span className="block text-xs text-muted-foreground">{inv.description?.slice(0, 50)}</span>}
                    </div>
                    <span className="font-mono text-xs">HKD {inv.total?.toLocaleString()}</span>
                  </button>
                  {inv.file_id && (
                    <button onClick={() => setPreviewId(inv.file_id)}
                      className="p-1 text-xs text-primary hover:underline shrink-0">{tr('View', '查看', '查看')}</button>
                  )}
                </div>
              ))}
              {tab === 'card' && cardStmts.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">{tr('No card statements', '沒有信用卡月結單', '没有信用卡月结单')}</p>}
              {tab === 'card' && cardStmts.map((cs: any) => (
                <div key={cs.id} className="flex items-center gap-2">
                  <button onClick={() => onLinkCard(cs.id)}
                    className="flex-1 flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted text-sm text-left">
                    <div>
                      <span className="font-medium">{cs.card_issuer || 'Card'}</span>
                      {cs.card_number_last4 && <span className="ml-2 text-muted-foreground">··{cs.card_number_last4}</span>}
                      <span className="ml-2 text-muted-foreground text-xs">{cs.statement_year}-{String(cs.statement_month || 1).padStart(2, '0')}</span>
                    </div>
                    <span className="font-mono text-xs">HKD {cs.closing_balance?.toLocaleString() || '-'}</span>
                  </button>
                  {cs.file_id && (
                    <button onClick={() => setPreviewId(cs.file_id)}
                      className="p-1 text-xs text-primary hover:underline shrink-0">{tr('View', '查看', '查看')}</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right: PDF preview */}
          <div className="w-1/2 border-l pl-4 flex flex-col min-h-0">
            {previewId ? (
              <iframe src={`${WORKER_API_BASE}/file-storage/${previewId}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`}
                className="w-full flex-1 border rounded" title="Document Preview" />
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                {tr('Select a document and click "View" to preview', '選擇文件並點擊"查看"以預覽', '选择文件并点击"查看"以预览')}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end mt-3">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Auto-Match Review Modal ──
// ── Card Match Review Modal ──
function CardMatchReviewModal({ matches, onConfirm, onReject, onClose }: {
  matches: any[];
  onConfirm: (txId: string, csId: string) => void;
  onReject: (txId: string) => void;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const pending = matches.filter(m => !confirmed.has(m.transaction_id) && !rejected.has(m.transaction_id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 space-y-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-purple-600" />
            Card Match Suggestions ({confirmed.size + rejected.size}/{matches.length})
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {pending.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('Review each match. Confirm to link the bank transaction to a card statement.', '審核每個配對。確認後將銀行交易連結至信用卡月結單。', '审核每个配对。确认后将银行交易连结至信用卡月结单。')}
              </span>
              <button
                onClick={() => {
                  pending.forEach(m => {
                    onConfirm(m.transaction_id, m.card_statement_id);
                    setConfirmed(prev => new Set(prev).add(m.transaction_id));
                  });
                }}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => (
                <div key={m.transaction_id} className="border rounded-lg p-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        m.confidence === 'high' ? 'bg-green-100 text-green-700' :
                        m.confidence === 'medium' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                      }`}>{m.confidence?.toUpperCase() || 'MEDIUM'}</span>
                      <span className="text-sm font-medium truncate">{m.card_issuer}</span>
                      {m.card_last4 && <span className="text-xs text-muted-foreground">*{m.card_last4}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{m.reason}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => {
                      onConfirm(m.transaction_id, m.card_statement_id);
                      setConfirmed(prev => new Set(prev).add(m.transaction_id));
                    }}
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700">
                      ✓ Confirm
                    </button>
                    <button onClick={() => {
                      onReject(m.transaction_id);
                      setRejected(prev => new Set(prev).add(m.transaction_id));
                    }}
                      className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50">
                      ✗ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Pending Review Banner: shows draft statements awaiting confirmation ──
function PendingReviewBanner() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['bank-statements-drafts'],
    queryFn: () => api('/bank-statements?only_drafts=1'),
    refetchInterval: 5000, // poll every 5s so newly uploaded drafts appear quickly
  });
  const drafts: any[] = data?.data || [];
  const dismissMut = useMutation({
    mutationFn: (id: string) => api(`/bank-statements/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
    },
    onError: (err: any) => {
      if (err?.status === 403 || /higher permission/i.test(err?.error || err?.message || '')) {
        toast.info('Only account owner or boss-level users can discard drafts. Please ask your admin.');
      } else {
        toast.info(`Discard failed: ${err?.error || err?.message || 'Unknown error'}`);
      }
    },
  });
  if (drafts.length === 0) return null;
  return (
    <div className="rounded-lg border-2 border-black bg-gray-100 dark:bg-gray-800 p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="text-2xl">⚠️</div>
        <div className="flex-1">
          <h3 className="font-bold text-black dark:text-white">
            {drafts.length} statement{drafts.length === 1 ? '' : 's'} pending review
          </h3>
          <p className="text-sm text-black dark:text-gray-300">
            The system extracted data from your uploaded file{drafts.length === 1 ? '' : 's'}.
            Please review and confirm before saving to the database.
          </p>
        </div>
      </div>
      <div className="space-y-1 pt-2">
        {drafts.map((d: any) => (
          <div
            key={d.id}
            className="flex items-center justify-between rounded border border-black bg-white dark:bg-gray-700 px-3 py-2 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <a
              href={`/bank-statements/review/${d.id}`}
              className="flex-1 text-sm"
            >
              <span className="font-medium">{d.bank_name || 'Statement'}</span>
              {d.account_number && <span className="text-muted-foreground"> · {d.account_number}</span>}
              {d.period_start && <span className="text-muted-foreground"> · {d.period_start} → {d.period_end}</span>}
            </a>
            <div className="flex items-center gap-2">
              <a
                href={`/bank-statements/review/${d.id}`}
                className="text-sm text-black dark:text-white font-medium hover:underline"
              >
                Review →
              </a>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm(tr('Discard this draft? It will be moved to the Recycle Bin (30-day restore) and the PDF will also be removed from File Storage.', '放棄此草稿？將移至回收站（可在30天內還原），PDF 也將從文件存儲中刪除。', '放弃此草稿？將移至回收站（可在30天內还原），PDF 也將從文件存儲中删除。'))) {
                    dismissMut.mutate(d.id);
                  }
                }}
                disabled={dismissMut.isPending}
                className="text-xs px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                title="Discard this draft"
              >
                🗑 Discard
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
