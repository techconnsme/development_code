import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, AlertTriangle, Plus, Check, Loader2, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { tr } from '../lib/i18nHelpers';

interface MissingTx {
  source: 'bank_transaction' | 'journal_line';
  id: string;
  date: string;
  description: string;
  deposit_amount?: number;
  withdrawal_amount?: number;
  debit?: number;
  credit?: number;
  entry_id?: string;
  entry_number?: string;
}

interface MissingCode {
  code: string;
  name: string | null;
  type: string;
  transactions: MissingTx[];
}

interface DetailsResponse {
  missing: MissingCode[];
  total_existing: number;
  total_expected: number;
}

const TYPE_COLORS: Record<string, string> = {
  asset: 'bg-blue-100 text-blue-700',
  liability: 'bg-yellow-100 text-yellow-700',
  equity: 'bg-purple-100 text-purple-700',
  revenue: 'bg-green-100 text-green-700',
  cost: 'bg-orange-100 text-orange-700',
  expense: 'bg-red-100 text-red-700',
};

export default function MissingCodesModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState<Record<string, string>>({});
  const [createdCodes, setCreatedCodes] = useState<Set<string>>(new Set());
  const [reassignedTxs, setReassignedTxs] = useState<Set<string>>(new Set());
  const [postedTxs, setPostedTxs] = useState<Set<string>>(new Set());

  const { data: details, isLoading } = useQuery<DetailsResponse>({
    queryKey: ['missing-codes-details'],
    queryFn: () => api('/bookkeeping/accounts/missing-codes/details'),
  });

  const { data: accountsData } = useQuery<any>({
    queryKey: ['accounts-list-for-missing'],
    queryFn: () => api('/bookkeeping/accounts'),
  });
  const existingAccounts: any[] = accountsData?.data || accountsData?.results || [];

  const ensureMut = useMutation({
    mutationFn: (code: string) => api('/bookkeeping/accounts/ensure', { method: 'POST', body: { code } }),
    onSuccess: (data: any) => {
      const created = data.created || [];
      setCreatedCodes(prev => { const next = new Set(prev); created.forEach((c: string) => next.add(c)); return next; });
      toast.success(tr(
        `Account${created.length > 1 ? 's' : ''} created: ${created.join(', ')}`,
        `已建立帳戶：${created.join(', ')}`,
        `已建立账户：${created.join(', ')}`
      ));
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes-details'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to create account'),
  });

  const reassignTxMut = useMutation({
    mutationFn: ({ txId, source, accountCode }: { txId: string; source: string; accountCode: string }) => {
      if (source === 'bank_transaction') {
        return api(`/bank-statements/transactions/${txId}`, { method: 'PATCH', body: { account_code: accountCode } });
      }
      // journal_lines don't have a direct PATCH, skip for now
      return Promise.resolve();
    },
    onSuccess: (_: any, vars: any) => {
      setReassignedTxs(prev => new Set(prev).add(vars.txId));
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes-details'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to reassign'),
  });

  const postTxMut = useMutation({
    mutationFn: (txId: string) => api(`/bookkeeping/post-transaction/${txId}`, { method: 'POST' }),
    onSuccess: (data: any) => {
      setPostedTxs(prev => new Set(prev).add(data.transaction_id));
      toast.success(tr(
        `Posted to GL: ${data.entry_number}`,
        `已過賬至總賬：${data.entry_number}`,
        `已过账至总账：${data.entry_number}`
      ));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes-details'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to post'),
  });

  const missing = details?.missing || [];
  const activeMissing = missing.filter(m => !createdCodes.has(m.code));

  // Count transactions still needing attention per code
  const pendingTxCount = (m: MissingCode) =>
    m.transactions.filter(tx => !reassignedTxs.has(tx.id) && tx.source === 'bank_transaction').length;

  const allResolved = activeMissing.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <h2 className="text-lg font-bold">
              {tr('Missing COA Codes', '缺少的會計科目', '缺少的会计科目')}
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin mb-3" />
              <p className="text-sm">{tr('Loading…', '載入中…', '载入中…')}</p>
            </div>
          ) : allResolved ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Check className="h-12 w-12 text-green-500 mb-3" />
              <p className="text-sm font-medium">
                {tr('All transaction codes are in your Chart of Accounts!', '所有交易代碼已在會計科目表中！', '所有交易代码已在会计科目表中！')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {activeMissing.map(m => {
                const isExpanded = expandedCode === m.code;
                const pendingTxs = m.transactions.filter(tx => !reassignedTxs.has(tx.id));
                return (
                  <div key={m.code} className="border rounded-lg overflow-hidden">
                    {/* Code header */}
                    <div
                      className="flex items-center justify-between px-4 py-3 bg-muted/30 cursor-pointer hover:bg-muted/50"
                      onClick={() => setExpandedCode(isExpanded ? null : m.code)}
                    >
                      <div className="flex items-center gap-3">
                        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                        <span className="font-mono font-bold text-sm">{m.code}</span>
                        <span className="text-sm text-muted-foreground">{m.name || `(${m.type})`}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TYPE_COLORS[m.type] || 'bg-gray-100'}`}>
                          {m.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {pendingTxs.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {pendingTxs.length} {tr('txns', '筆', '笔')}
                          </span>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); ensureMut.mutate(m.code); }}
                          disabled={ensureMut.isPending}
                          className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {tr('Create Account', '建立帳戶', '建立账户')}
                        </button>
                      </div>
                    </div>

                    {/* Expanded transactions */}
                    {isExpanded && (
                      <div className="border-t">
                        {m.transactions.length === 0 ? (
                          <div className="p-4 text-center text-xs text-muted-foreground">
                            {tr('No transactions reference this code directly (added as hierarchy parent or essential account).', '沒有交易直接引用此代碼（作為層級父項或必要帳戶添加）。', '没有交易直接引用此代码（作为层级父项或必要账户添加）。')}
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b bg-muted/20 text-left">
                                  <th className="py-2 px-3 font-medium">{tr('Date', '日期', '日期')}</th>
                                  <th className="py-2 px-3 font-medium">{tr('Description', '描述', '描述')}</th>
                                  <th className="py-2 px-3 font-medium text-right">{tr('Amount', '金額', '金额')}</th>
                                  <th className="py-2 px-3 font-medium">{tr('Source', '來源', '来源')}</th>
                                  <th className="py-2 px-3 font-medium">{tr('Action', '操作', '操作')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {m.transactions.map(tx => {
                                  const amount = tx.deposit_amount || tx.withdrawal_amount || tx.debit || tx.credit || 0;
                                  const isDeposit = (tx.deposit_amount || tx.debit || 0) > 0;
                                  const isReassigned = reassignedTxs.has(tx.id);
                                  const isPosted = postedTxs.has(tx.id);
                                  const isDone = isReassigned || isPosted;
                                  return (
                                    <tr key={tx.id} className={`border-b ${isDone ? 'bg-green-50 dark:bg-green-950/20' : ''}`}>
                                      <td className="py-1.5 px-3 font-mono whitespace-nowrap">{tx.date?.slice(0, 10) || '—'}</td>
                                      <td className="py-1.5 px-3 max-w-[200px] truncate" title={tx.description}>
                                        {tx.description || '—'}
                                        {tx.entry_number && <span className="text-muted-foreground ml-1">({tx.entry_number})</span>}
                                      </td>
                                      <td className={`py-1.5 px-3 text-right font-mono whitespace-nowrap ${isDeposit ? 'text-green-600' : 'text-red-600'}`}>
                                        {isDeposit ? '+' : '-'}{tr('HKD', '港幣', '港币')} {amount.toLocaleString()}
                                      </td>
                                      <td className="py-1.5 px-3">
                                        <span className="text-xs px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800">
                                          {tx.source === 'bank_transaction' ? tr('Bank', '銀行', '银行') : tr('Journal', '分錄', '分录')}
                                        </span>
                                      </td>
                                      <td className="py-1.5 px-3">
                                        <div className="flex items-center gap-1.5">
                                        {isReassigned ? (
                                          <span className="text-green-600 text-xs flex items-center gap-1">
                                            <Check className="h-3 w-3" /> {tr('Reassigned', '已重配', '已重配')}
                                          </span>
                                        ) : isPosted ? (
                                          <span className="text-green-600 text-xs flex items-center gap-1">
                                            <Check className="h-3 w-3" /> {tr('Posted to GL', '已過賬', '已过账')}
                                          </span>
                                        ) : tx.source === 'bank_transaction' ? (
                                          <>
                                            <select
                                              value={reassigning[tx.id] || ''}
                                              onChange={e => {
                                                const val = e.target.value;
                                                setReassigning(prev => ({ ...prev, [tx.id]: val }));
                                                if (val) {
                                                  reassignTxMut.mutate({ txId: tx.id, source: tx.source, accountCode: val });
                                                }
                                              }}
                                              className="text-xs border rounded px-1.5 py-0.5 bg-background max-w-[100px]"
                                            >
                                              <option value="">{tr('Reassign…', '重配…', '重配…')}</option>
                                              {existingAccounts.map((a: any) => (
                                                <option key={a.account_code} value={a.account_code}>
                                                  {a.account_code}
                                                </option>
                                              ))}
                                            </select>
                                            <button
                                              onClick={() => postTxMut.mutate(tx.id)}
                                              disabled={postTxMut.isPending}
                                              className="text-xs px-1.5 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                                            >
                                              {tr('Post to GL', '過賬', '过账')}
                                            </button>
                                          </>
                                        ) : (
                                          <span className="text-xs text-muted-foreground">
                                            {tr('Edit in GJE', '在GJE編輯', '在GJE编辑')}
                                          </span>
                                        )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 shrink-0 flex justify-between items-center">
          <span className="text-xs text-muted-foreground">
            {activeMissing.length > 0
              ? `${activeMissing.length} ${tr('codes missing', '個代碼缺少', '个代码缺少')}`
              : tr('All clear!', '全部完成！', '全部完成！')}
          </span>
          <button
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['accounts'] });
              queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
              queryClient.invalidateQueries({ queryKey: ['missing-codes-details'] });
              onClose();
            }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium"
          >
            {tr('Done', '完成', '完成')}
          </button>
        </div>
      </div>
    </div>
  );
}
