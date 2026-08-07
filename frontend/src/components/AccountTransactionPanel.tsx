import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { FileText } from 'lucide-react';

interface DocLink {
  type: string;
  id: string;
  label: string;
}

interface JournalEntryItem {
  type: 'journal';
  line_id: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  amount: number;
  direction: 'credit' | 'debit';
  reference_type: string | null;
  reference_id: string | null;
  invoice_number?: string;
  invoice_total?: number;
  bank_statement_id?: string;
  bank_statement_period?: string;
  linked_documents: DocLink[];
}

interface UnpostedBankTx {
  type: 'bank';
  transaction_id: string;
  transaction_date: string;
  description: string;
  amount: number;
  direction: string;
  account_code: string;
  bank_statement_id: string;
  bank_statement_period: string;
  has_voucher: boolean;
  linked_documents: DocLink[];
}

interface TransactionData {
  account_code: string;
  account_name: string;
  total: number;
  journal_entries: JournalEntryItem[];
  unposted_bank_transactions: UnpostedBankTx[];
  period: { start: string; end: string };
}

interface Props {
  accountCode: string;
  accountName: string;
  startDate: string;
  endDate: string;
  onClose: () => void;
  onPostClick: (bankStatementId: string, transactionId: string) => void;
}

function formatHKD(n: number): string {
  return 'HKD ' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
}

function docLink(doc: DocLink, key: string) {
  const icon = doc.type === 'invoice' ? '📎' : '📄';
  const href = doc.type === 'invoice'
    ? `/invoices?highlight=${doc.id}`
    : `/bank-statements?statement=${doc.id}`;
  return (
    <a
      key={key}
      href={href}
      className="text-blue-600 hover:text-blue-800 text-[10px] font-medium whitespace-nowrap"
      title={doc.label}
      onClick={e => e.stopPropagation()}
    >
      {icon} {doc.label}
    </a>
  );
}

export default function AccountTransactionPanel({
  accountCode, accountName, startDate, endDate, onClose, onPostClick,
}: Props) {
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['account-transactions', accountCode, startDate, endDate],
    queryFn: () =>
      api(`/bookkeeping/income-statement/${encodeURIComponent(accountCode)}/transactions?start_date=${startDate}&end_date=${endDate}`),
    enabled: !!accountCode && !!startDate,
  });

  const txData = data as TransactionData | undefined;

  // Error state
  React.useEffect(() => {
    if (error) {
      toast.error(tr(
        `Failed to load transactions for account ${accountCode}`,
        `載入科目 ${accountCode} 的交易失敗`,
        `载入科目 ${accountCode} 的交易失败`
      ));
      onClose();
    }
  }, [error, accountCode, onClose, toast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {tr('Loading...', '載入中...', '载入中...')}
      </div>
    );
  }

  if (!txData) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {tr('No data available', '沒有數據', '没有数据')}
      </div>
    );
  }

  const hasJournal = txData.journal_entries.length > 0;
  const hasUnposted = txData.unposted_bank_transactions.length > 0;
  const isEmpty = !hasJournal && !hasUnposted;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-sm font-semibold">{txData.account_code}</span>
            <span className="text-sm ml-2">{txData.account_name}</span>
          </div>
          <span className="font-bold text-emerald-700">
            {formatHKD(txData.total)}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          {txData.period.start} – {txData.period.end}
          {' · '}
          {hasJournal && `${txData.journal_entries.length} ${tr('journal entries', '日記帳分錄', '日记账分录')}`}
          {hasJournal && hasUnposted && ' + '}
          {hasUnposted && `${txData.unposted_bank_transactions.length} ${tr('unposted bank tx', '未過賬銀行交易', '未过账银行交易')}`}
        </div>
      </div>

      {isEmpty ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
          <FileText className="h-4 w-4" />
          {tr(
            'No transactions found for this account in the selected period',
            '所選期間內此科目沒有交易',
            '所选期间内此科目没有交易'
          )}
        </div>
      ) : (
        <>
          {/* ── Journal Entries Section ── */}
          {hasJournal && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase">
                  {tr('Journal Entries', '日記帳分錄', '日记账分录')} ({txData.journal_entries.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {txData.journal_entries.map((je) => (
                  <div
                    key={je.line_id}
                    className="border border-border rounded-md overflow-hidden bg-background"
                  >
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/20">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] font-semibold shrink-0">
                          {je.entry_number}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {je.entry_date}
                        </span>
                      </div>
                      <span className={`font-mono text-xs font-semibold shrink-0 ml-2 ${
                        je.direction === 'credit' ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatHKD(je.amount)}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate min-w-0">
                        {je.description}
                      </span>
                      {je.linked_documents.length > 0 && (
                        <span className="flex items-center gap-1.5 shrink-0">
                          {je.linked_documents.map((doc, i) =>
                            docLink(doc, `je-${je.line_id}-doc-${i}`)
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Divider ── */}
          {hasJournal && hasUnposted && (
            <div className="relative border-t-2 border-dashed border-amber-300 my-4">
              <span className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-amber-50 text-amber-800 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap border border-amber-300">
                ⚠ {tr('UNPOSTED BANK TRANSACTIONS', '未過賬銀行交易', '未过账银行交易')} ({txData.unposted_bank_transactions.length})
              </span>
            </div>
          )}

          {/* ── Unposted Bank Transactions Section ── */}
          {hasUnposted && (
            <div>
              <div className="space-y-1.5">
                {txData.unposted_bank_transactions.map((bt) => (
                  <div
                    key={bt.transaction_id}
                    className="border border-red-200 rounded-md overflow-hidden bg-red-50/30"
                  >
                    <div className="flex items-center justify-between px-3 py-2 bg-red-50/50">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {bt.transaction_date}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium shrink-0">
                          {tr('bank', '銀行', '银行')}
                        </span>
                      </div>
                      <span className={`font-mono text-xs font-semibold shrink-0 ml-2 ${
                        bt.direction === 'credit' ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatHKD(bt.amount)}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate min-w-0">
                        {bt.description}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {bt.linked_documents.map((doc, i) =>
                          docLink(doc, `bt-${bt.transaction_id}-doc-${i}`)
                        )}
                        <button
                          onClick={() => onPostClick(bt.bank_statement_id, bt.transaction_id)}
                          className="px-2 py-0.5 text-[10px] font-semibold text-white bg-pink-500 hover:bg-pink-600 rounded transition-colors whitespace-nowrap"
                        >
                          {tr('Post', '過賬', '过账')} →
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
