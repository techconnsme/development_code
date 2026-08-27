import { Fragment, useState, useEffect, useRef, ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { useToast } from '../components/Toast';
import DocumentPickerModal, { type PickedFile } from '../components/DocumentPickerModal';
import { tr } from '../lib/i18nHelpers';
import { Eye, Trash2, AlertTriangle, CheckCircle, ChevronDown, Pencil, FileText, CreditCard, Building2, Download, FilePlus } from 'lucide-react';
import ContinuityChain from '../components/ContinuityChain';
import TxPostingPanel, { PostingLine } from '../components/TxPostingPanel';
import SlideOpen from '../components/SlideOpen';
import { buildCoaTree, isTemporaryAccount } from '../lib/coa-hierarchy';

/** Fetch an authenticated file as a blob URL (Authorization header, never query-string tokens). */
async function authedBlobUrl(path: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const client = JSON.parse(localStorage.getItem('activeClient') || 'null');
    if (client?.id) headers['X-Active-Client'] = client.id;
  } catch { /* no active client */ }
  const resp = await fetch(`${WORKER_API_BASE}${path}`, { headers, credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return URL.createObjectURL(await resp.blob());
}

async function openAuthed(path: string): Promise<void> {
  try {
    const url = await authedBlobUrl(path);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    alert(tr('Could not open the file.', '無法開啟文件。', '无法打开文件。'));
  }
}

async function downloadAuthed(path: string, filename: string): Promise<void> {
  try {
    const url = await authedBlobUrl(path);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    alert(tr('Could not download the file.', '無法下載文件。', '无法下载文件。'));
  }
}

interface CardTransaction {
  id: string;
  transaction_date: string;
  posting_date: string | null;
  description: string;
  amount: number;
  transaction_type: string | null;
  foreign_currency: string | null;
  foreign_amount: number | null;
  category: string | null;
  reference: string | null;
  sort_order: number;
  expense_account_code: string | null;
  match_status: string;
  is_edited?: number;
}

interface CardStatement {
  id: string;
  file_name: string | null;
  card_issuer: string | null;
  card_network: string | null;
  card_number_last4: string | null;
  cardholder_name: string | null;
  currency: string;
  statement_year: number | null;
  statement_month: number | null;
  period_start: string | null;
  period_end: string | null;
  credit_limit: number | null;
  opening_balance: number | null;
  closing_balance: number | null;
  minimum_payment: number | null;
  payment_due_date: string | null;
  status: string;
  balance_status?: string;
  balance_check?: string;
  created_at: string;
  transactions?: CardTransaction[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(year: number | null, month: number | null): string {
  if (!year || !month) return '—';
  return `${MONTHS[month - 1]} ${year}`;
}

interface CardTxRow {
  transaction_date: string;
  description: string;
  amount: number;
  transaction_type: string;
  reference: string;
}

function ManualCardStatementEditor({ onSave, onCancel }: { onSave: (data: any) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [cardIssuer, setCardIssuer] = useState('');
  const [cardNetwork, setCardNetwork] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [cardholderName, setCardholderName] = useState('');
  const [currency, setCurrency] = useState('HKD');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [creditLimit, setCreditLimit] = useState<number | ''>('');
  const [openingBalance, setOpeningBalance] = useState<number | ''>('');
  const [closingBalance, setClosingBalance] = useState<number | ''>('');
  const [txRows, setTxRows] = useState<CardTxRow[]>([
    { transaction_date: '', description: '', amount: 0, transaction_type: 'purchase', reference: '' },
  ]);
  const [sourceFileId, setSourceFileId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);

  const addRow = () => setTxRows([...txRows, { transaction_date: '', description: '', amount: 0, transaction_type: 'purchase', reference: '' }]);
  const removeRow = (idx: number) => setTxRows(txRows.filter((_, i) => i !== idx));
  const updateRow = (idx: number, field: keyof CardTxRow, value: any) => {
    const rows = [...txRows];
    (rows[idx] as any)[field] = value;
    setTxRows(rows);
  };

  const canSave = cardIssuer.trim() && txRows.length > 0 && txRows.every(tx => tx.transaction_date && tx.description);

  return (
    <div className="border rounded-lg p-4 bg-muted/30 space-y-4">
      <h3 className="font-semibold text-sm">{tr('Manual Card Statement Entry', '手動信用卡月結單輸入', '手动信用卡月结单输入')}</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="text-xs font-medium">{tr('Card Issuer', '發卡機構', '发卡机构')} *</label>
          <input value={cardIssuer} onChange={e => setCardIssuer(e.target.value)} className="w-full border rounded px-2 py-1 text-sm" placeholder="HSBC" />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Card Network', '卡組織', '卡组织')}</label>
          <select value={cardNetwork} onChange={e => setCardNetwork(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
            <option value="">—</option><option value="Visa">Visa</option><option value="MasterCard">MasterCard</option><option value="Amex">Amex</option><option value="UnionPay">UnionPay</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Last 4 Digits', '末四碼', '末四码')}</label>
          <input value={cardLast4} onChange={e => setCardLast4(e.target.value)} className="w-full border rounded px-2 py-1 text-sm" maxLength={4} />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Cardholder Name', '持卡人姓名', '持卡人姓名')}</label>
          <input value={cardholderName} onChange={e => setCardholderName(e.target.value)} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Currency', '貨幣', '货币')}</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)} className="w-full border rounded px-2 py-1 text-sm">
            <option value="HKD">HKD</option><option value="USD">USD</option><option value="CNY">CNY</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Year', '年份', '年份')}</label>
          <input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Month', '月份', '月份')}</label>
          <select value={month} onChange={e => setMonth(Number(e.target.value))} className="w-full border rounded px-2 py-1 text-sm">
            {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Opening Balance', '期初餘額', '期初余额')}</label>
          <input type="number" step="0.01" value={openingBalance} onChange={e => setOpeningBalance(e.target.value ? Number(e.target.value) : '')} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Closing Balance', '期末餘額', '期末余额')}</label>
          <input type="number" step="0.01" value={closingBalance} onChange={e => setClosingBalance(e.target.value ? Number(e.target.value) : '')} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">{tr('Attach File (optional)', '附加文件（可選）', '附加文件（可选）')}</label>
          {pickedFileName ? (
            <div className="flex items-center gap-1 text-sm bg-background border rounded px-2 py-1">
              <span className="truncate">{pickedFileName}</span>
              <button type="button" onClick={() => { setSourceFileId(null); setPickedFileName(null); }} className="text-destructive text-xs ml-1">✕</button>
            </div>
          ) : (
            <button type="button" onClick={() => setShowPicker(true)} className="w-full text-left border rounded px-2 py-1 text-sm text-muted-foreground hover:bg-background">
              + {tr('Choose file', '選擇文件', '选择文件')}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 px-1 w-28">{tr('Date', '日期', '日期')} *</th>
              <th className="py-1 px-1">{tr('Description', '描述', '描述')} *</th>
              <th className="py-1 px-1 w-28 text-right">{tr('Amount', '金額', '金额')}</th>
              <th className="py-1 px-1 w-28">{tr('Type', '類型', '类型')}</th>
              <th className="py-1 px-1 w-24">{tr('Ref', '參考', '参考')}</th>
              <th className="py-1 px-1 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {txRows.map((tx, idx) => (
              <tr key={idx} className="border-b">
                <td className="py-1 px-1"><input type="date" value={tx.transaction_date} onChange={e => updateRow(idx, 'transaction_date', e.target.value)} className="w-full border rounded px-1 py-0.5 text-xs" /></td>
                <td className="py-1 px-1"><input value={tx.description} onChange={e => updateRow(idx, 'description', e.target.value)} className="w-full border rounded px-1 py-0.5 text-xs" /></td>
                <td className="py-1 px-1"><input type="number" step="0.01" value={tx.amount || ''} onChange={e => updateRow(idx, 'amount', Number(e.target.value) || 0)} className="w-full border rounded px-1 py-0.5 text-xs text-right" /></td>
                <td className="py-1 px-1">
                  <select value={tx.transaction_type} onChange={e => updateRow(idx, 'transaction_type', e.target.value)} className="w-full border rounded px-1 py-0.5 text-xs">
                    <option value="purchase">{tr('Purchase', '消費', '消费')}</option><option value="payment">{tr('Payment', '還款', '还款')}</option><option value="refund">{tr('Refund', '退款', '退款')}</option><option value="fee">{tr('Fee', '費用', '费用')}</option><option value="interest">{tr('Interest', '利息', '利息')}</option>
                  </select>
                </td>
                <td className="py-1 px-1"><input value={tx.reference} onChange={e => updateRow(idx, 'reference', e.target.value)} className="w-full border rounded px-1 py-0.5 text-xs" /></td>
                <td className="py-1 px-1">{txRows.length > 1 && <button onClick={() => removeRow(idx)} className="text-destructive text-xs">✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} className="text-xs text-primary hover:underline">+ {tr('Add Row', '新增列', '新增列')}</button>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 border rounded-md text-sm hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
        <button onClick={() => {
          onSave({
            card_issuer: cardIssuer, card_network: cardNetwork, card_number_last4: cardLast4,
            cardholder_name: cardholderName, currency, statement_year: year, statement_month: month,
            credit_limit: creditLimit || null, opening_balance: openingBalance || null, closing_balance: closingBalance || null,
            source_file_id: sourceFileId,
            transactions: txRows.map((tx, i) => ({ ...tx, sort_order: i })),
          });
        }} disabled={!canSave}
          className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50">
          {tr('Save & Review', '儲存並審核', '储存并审核')}
        </button>
      </div>

      {showPicker && (
        <DocumentPickerModal
          alreadyPicked={[]}
          onPick={(picked: PickedFile[]) => {
            if (picked[0]) {
              setSourceFileId(picked[0].id);
              setPickedFileName(picked[0].filename);
            }
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

export default function CardStatements() {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);

  const { data: stmtsResp, isLoading } = useQuery({
    queryKey: ['card-statements'],
    queryFn: () => api('/card-statements'),
  });
  const statements: CardStatement[] = stmtsResp?.data || [];

  const [searchParams] = useSearchParams();
  const highlightStmtId = searchParams.get('highlight') || null;

  const highlightFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightStmtId || highlightFiredRef.current === highlightStmtId) return;
    setExpandedId(highlightStmtId);
    const tryScroll = (retries: number) => {
      const card = document.getElementById(`card-row-${highlightStmtId}`);
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

  const { data: draftResp } = useQuery({
    queryKey: ['card-statements-drafts'],
    queryFn: () => api('/card-statements?only_drafts=1'),
    refetchInterval: 5000,
  });
  const drafts: CardStatement[] = draftResp?.data || [];

  const { data: stmtDetail } = useQuery({
    queryKey: ['card-statement', expandedId],
    queryFn: () => api(`/card-statements/${expandedId}`),
    enabled: !!expandedId,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/card-statements/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['card-statements'] });
      queryClient.invalidateQueries({ queryKey: ['card-statements-drafts'] });
    },
  });

  const autoCatMut = useMutation({
    mutationFn: (id: string) => api(`/card-statements/${id}/auto-categorize`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['card-statement', expandedId] });
      queryClient.invalidateQueries({ queryKey: ['card-statements'] });
    },
  });

  const updateTxMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api(`/card-statements/transactions/${id}`, { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['card-statement', expandedId] }),
  });

  // Multi-account posting panel state + data
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  // Frozen JSX per statement: while a statement slides shut, the shared detail
  // query may already describe the newly opened statement — replay the last
  // open render instead so the closing content stays stable.
  const stmtContentRef = useRef<Map<string, ReactNode>>(new Map());
  const { data: accountsResp } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
  });
  const cardAccounts: any[] = accountsResp?.data || [];
  const cardCoaTree = buildCoaTree(cardAccounts);
  const saveCardPosting = async (txId: string, movement: number, lines?: PostingLine[], reset?: boolean) => {
    await api(`/card-statements/transactions/${txId}/posting`, {
      method: 'PUT',
      body: reset ? { reset_to_auto: true } : { lines, movement_amount: movement },
    });
    queryClient.invalidateQueries({ queryKey: ['card-statement', expandedId] });
  };

  const years = new Set<number>();
  statements.forEach(s => { if (s.statement_year) years.add(s.statement_year); });

  const cardLabel = (s: CardStatement) => {
    const parts = [s.card_issuer, s.card_network, s.card_number_last4 ? `••••${s.card_number_last4}` : null].filter(Boolean);
    return parts.join(' ') || tr('Unknown Card', '未知信用卡', '未知信用卡');
  };

  const fmt = (v: number | null | undefined) => v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '—';

  if (isLoading) return <div className="p-6 text-muted-foreground">{tr('Loading…', '載入中…', '载入中…')}</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6" /> {tr('Card Statements', '信用卡月結單', '信用卡月结单')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tr('Upload credit card statements, review transactions, categorize expenses.', '上傳信用卡月結單、檢視交易、分類支出。', '上传信用卡月结单、检视交易、分类支出。')}
          </p>
          <button onClick={() => setShowManualEntry(!showManualEntry)}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
            <FilePlus className="h-4 w-4" />
            {tr('Manual Entry', '手動輸入', '手动输入')}
          </button>
        </div>
      </div>

      {showManualEntry && (
        <ManualCardStatementEditor
          onSave={async (data) => {
            try {
              const res = await api('/card-statements/manual', { method: 'POST', body: data }) as any;
              toast.success(tr('Manual card statement created — review to confirm', '手動信用卡月結單已建立——請審核後確認', '手动信用卡月结单已建立——请审核后确认'));
              setShowManualEntry(false);
              nav(`/card-statements/review/${res.id}`);
            } catch (e: any) {
              toast.error(e?.message || 'Failed to create manual card statement');
            }
          }}
          onCancel={() => setShowManualEntry(false)}
        />
      )}

      {/* Drafts banner */}
      {drafts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950 p-4">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 font-medium mb-2">
            <AlertTriangle className="h-4 w-4" />
            {tr('Statements awaiting review', '月結單待審核', '月结单待审核')} ({drafts.length})
          </div>
          <div className="space-y-1">
            {drafts.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-sm">
                <span className="text-amber-700 dark:text-amber-300">{cardLabel(d)} — {monthLabel(d.statement_year, d.statement_month)}</span>
                <button onClick={() => nav(`/card-statements/review/${d.id}`)}
                  className="text-primary hover:underline text-xs font-medium">
                  {tr('Review →', '審核 →', '审核 →')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Continuity chain */}
      <ContinuityChain endpoint="/card-statements/continuity" queryKey="card-continuity" type="card" />

      {/* Statement list */}
      {statements.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p>{tr('No card statements yet.', '尚無信用卡月結單。', '尚无信用卡月结单。')}</p>
          <p className="text-xs mt-1">{tr('Upload a credit card statement from File Upload.', '從文件上傳頁面上傳信用卡月結單。', '从文件上传页面上传信用卡月结单。')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {statements.map((s) => {
            const isExpanded = expandedId === s.id;
            const detail = isExpanded ? stmtDetail : null;
            const txs: CardTransaction[] = detail?.transactions || [];

            return (
              <div key={s.id} id={`card-row-${s.id}`} className="rounded-lg border bg-card overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : s.id)}
                >
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{cardLabel(s)}</div>
                    <div className="text-xs text-muted-foreground">
                      {monthLabel(s.statement_year, s.statement_month)}
                      {s.period_start && ` · ${s.period_start} → ${s.period_end || '…'}`}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    {s.closing_balance != null && (
                      <div className="font-mono font-medium">${fmt(s.closing_balance)}</div>
                    )}
                    {s.status === 'draft' && (
                      <span className="text-xs text-amber-600 font-medium">Draft</span>
                    )}
                  </div>
                  <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                    {s.balance_status === 'mismatch' && (
                      <span className="text-xs text-red-600 font-medium" title={s.balance_check ? (() => { try { const c = JSON.parse(s.balance_check); return `Expected: $${c.expected?.toLocaleString?.()}, Actual: $${c.actual?.toLocaleString?.()}`; } catch { return ''; } })() : ''}>⚠</span>
                    )}
                    {s.balance_status === 'corrected' && (
                      <span className="text-xs text-blue-600 font-medium" title={tr('Manually corrected', '已手動修正', '已手动修正')}>✏</span>
                    )}
                    {s.file_name && (
                      <button onClick={(e) => { e.stopPropagation(); openAuthed(`/card-statements/${s.id}/file`); }}
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground" title={tr('View original', '查看原文件', '查看原文件')}>
                        <Eye className="h-4 w-4" />
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); nav(`/card-statements/review/${s.id}`); }}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground" title={tr('Edit statement', '編輯月結單', '编辑月结单')}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => { if (confirm(tr('Delete this statement?', '刪除此月結單？', '删除此月结单？'))) deleteMut.mutate(s.id); }}
                      className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Expanded transactions — slides; content frozen from last open render */}
                <SlideOpen open={isExpanded}>
                {(() => {
                  if (isExpanded) {
                    stmtContentRef.current.set(s.id, (
                    <div className="border-t bg-muted/20 px-4 py-2">
                    {/* Summary bar */}
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mb-2">
                      {s.cardholder_name && <span><Building2 className="h-3 w-3 inline mr-1" />{s.cardholder_name}</span>}
                      {s.opening_balance != null && <span>Op: ${fmt(s.opening_balance)}</span>}
                      {s.closing_balance != null && <span>Cl: ${fmt(s.closing_balance)}</span>}
                      {s.credit_limit != null && <span>Limit: ${fmt(s.credit_limit)}</span>}
                      {s.minimum_payment != null && <span>Min Pay: ${fmt(s.minimum_payment)}</span>}
                      {s.payment_due_date && <span>Due: {s.payment_due_date}</span>}
                      <button onClick={() => downloadAuthed(`/card-statements/${s.id}/export-csv`, `card-statement-${s.statement_year ?? ''}${String(s.statement_month ?? '').padStart(2, '0')}.csv`)}
                        className="text-primary hover:underline">
                        <Download className="h-3 w-3 inline mr-0.5" />CSV
                      </button>
                      <button onClick={() => autoCatMut.mutate(s.id)}
                        className="text-primary hover:underline">
                        {tr('Auto-Categorize', '自動分類', '自动分类')}
                      </button>
                      {s.status === 'draft' && (
                        <button onClick={() => nav(`/card-statements/review/${s.id}`)}
                          className="text-amber-600 hover:underline font-medium">
                          {tr('Review →', '審核 →', '审核 →')}
                        </button>
                      )}
                    </div>

                    {/* Transactions table */}
                    {txs.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">{tr('No transactions', '無交易記錄', '无交易记录')}</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-muted-foreground border-b">
                              <th className="py-1 pr-2">Date</th>
                              <th className="py-1 pr-2">Description</th>
                              <th className="py-1 pr-2 text-right">Amount</th>
                              <th className="py-1 pr-2">Type</th>
                              <th className="py-1 pr-2">Category</th>
                              <th className="py-1 pr-2">Account</th>
                              <th className="py-1 pr-1 w-6" aria-label="Expand"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {txs.map((tx) => {
                              const movement = Math.abs(tx.amount || 0);
                              const posting = (tx as any).posting as { entry_id: string; entry_number: string; entry_source: string; lines: { id: string; account_code: string; account_name: string; debit: number; credit: number }[] } | null;
                              const stmtActive = (detail as any)?.status === 'active';
                              return (
                              <Fragment key={tx.id}>
                              <tr onClick={() => setExpandedTxId(expandedTxId === tx.id ? null : tx.id)}
                                className={`cursor-pointer border-b border-muted/30 ${tx.match_status === 'categorized' ? 'bg-green-50 dark:bg-green-950/20' : ''} ${tx.is_edited ? 'bg-blue-50 dark:bg-blue-950/20' : ''}`}>
                                <td className="py-1 pr-2 whitespace-nowrap">{tx.transaction_date}</td>
                                <td className="py-1 pr-2 max-w-[200px] truncate">{tx.description}</td>
                                <td className="py-1 pr-2 text-right font-mono relative">${fmt(tx.amount)}{tx.is_edited ? <span className="text-blue-500 ml-1" title={tr('Manually edited', '已手動修改', '已手动修改')}>✏</span> : ''}</td>
                                <td className="py-1 pr-2">
                                  {tx.transaction_type && (
                                    <span className="px-1 py-0.5 rounded text-[10px] bg-muted">{tx.transaction_type}</span>
                                  )}
                                </td>
                                <td className="py-1 pr-2 text-muted-foreground">{tx.category || '—'}</td>
                                <td className="py-1 pr-2">
                                  {posting && posting.lines.length > 0 ? (
                                    <div className="flex flex-col items-start gap-0.5">
                                      {posting.lines.map((l, i) => {
                                        const side = l.debit > 0 ? 'Dr' : 'Cr';
                                        const accName = cardAccounts.find((a: any) => a.account_code === l.account_code)?.account_name || l.account_name || '';
                                        return (
                                          <span key={l.id || `${l.account_code}-${i}`} className={`inline-flex items-center gap-1 max-w-[220px] font-mono text-[10px] px-1 py-px rounded ${
                                            isTemporaryAccount(accName)
                                              ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                                              : 'bg-primary/10 text-primary'
                                          }`}>
                                            <span className={`text-[9px] font-semibold ${side === 'Dr' ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>{side}</span>
                                            <span className="truncate" title={`${side} ${l.account_code} · ${accName} · ${(l.debit > 0 ? l.debit : l.credit).toFixed(2)}`}>
                                              {l.account_code}<span className="text-muted-foreground ml-1">{accName}</span>
                                            </span>
                                          </span>
                                        );
                                      })}
                                      {posting.lines.length > 2 && <span className="text-[9px] text-muted-foreground">{tr('split', '拆分', '拆分')}</span>}
                                    </div>
                                  ) : tx.expense_account_code ? (
                                    <span className="text-green-700 dark:text-green-400 font-mono text-[10px]">{tx.expense_account_code}</span>
                                  ) : (
                                    <span className="text-muted-foreground/50">—</span>
                                  )}
                                </td>
                                <td className="py-1 pr-1 w-6 text-muted-foreground">
                                  <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-300 ${expandedTxId === tx.id ? 'rotate-180' : ''}`} />
                                </td>
                              </tr>
                              <tr>
                                <td colSpan={7} className="p-0">
                                  <SlideOpen open={expandedTxId === tx.id}>
                                    <TxPostingPanel
                                      key={(tx as any).posting?.entry_id || 'auto'}
                                      kind="card"
                                      movementAmount={movement}
                                      contraSide="Dr"
                                      fixedCode="11101"
                                      fixedName={cardAccounts.find((a: any) => a.account_code === '11101')?.account_name || 'Cash on Hand'}
                                      posting={posting}
                                      currentCode={tx.expense_account_code}
                                      accounts={cardAccounts}
                                      tree={cardCoaTree}
                                      disabled={!stmtActive}
                                      lockedReason={tr('Confirm the statement before editing postings', '請先確認月結單再修改分錄', '请先确认月结单再修改分录')}
                                      onSave={(lines) => saveCardPosting(tx.id, movement, lines)}
                                      onResetAuto={() => saveCardPosting(tx.id, movement, undefined, true)}
                                    />
                                  </SlideOpen>
                                </td>
                              </tr>
                              </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                    ));
                  }
                  return stmtContentRef.current.get(s.id) ?? null;
                })()}
                </SlideOpen>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
