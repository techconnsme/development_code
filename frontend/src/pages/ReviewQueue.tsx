import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useDateFilter } from '../contexts/DateFilterContext';
import { Landmark, CreditCard, FileText, Calculator, CheckCircle2, ArrowRight, AlertTriangle, Info, Copy, AlertCircle } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

interface QueueItem {
  type: 'bank_statement' | 'card_statement' | 'invoice' | 'receipt' | 'journal_entry';
  id: string;
  title: string;
  subtitle?: string;
  date: string;
  reason: string;
  reviewUrl: string;
  flags?: string;
}

interface QueueData {
  total: number;
  counts: {
    bank_statements: number;
    card_statements: number;
    invoices: number;
    journal_entries: number;
  };
  items: QueueItem[];
}

const TYPE_CONFIG: Record<string, { icon: React.FC<{ className?: string }>; color: string; label: string; labelZh: string; labelCn: string }> = {
  bank_statement: { icon: Landmark, color: 'text-blue-600', label: 'Bank Statements', labelZh: '銀行月結單', labelCn: '银行月结单' },
  card_statement: { icon: CreditCard, color: 'text-purple-600', label: 'Card Statements', labelZh: '信用卡月結單', labelCn: '信用卡月结单' },
  invoice: { icon: FileText, color: 'text-green-600', label: 'Invoices', labelZh: '發票', labelCn: '发票' },
  receipt: { icon: FileText, color: 'text-teal-600', label: 'Receipts', labelZh: '收據', labelCn: '收据' },
  journal_entry: { icon: Calculator, color: 'text-amber-600', label: 'Journal Entries', labelZh: '日記帳分錄', labelCn: '日记账分录' },
};

function ReasonBadge({ reason }: { reason: string }) {
  const reasons = reason.split(',').filter(Boolean);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {reasons.map(r => {
        switch (r.trim()) {
          case 'draft': return <span key="draft" className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-medium">Draft</span>;
          case 'balance_mismatch': return <span key="bm" className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><AlertTriangle className="h-2.5 w-2.5" />Balance</span>;
          case 'direction': return <span key="dir" className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><AlertTriangle className="h-2.5 w-2.5" />Direction</span>;
          case 'company_not_detected': return <span key="cnd" className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><Info className="h-2.5 w-2.5" />Company</span>;
          case 'duplicate': return <span key="dup" className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><Copy className="h-2.5 w-2.5" />Duplicate</span>;
          case 'total': return <span key="tot" className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">Total mismatch</span>;
          case 'pending_review': return <span key="pr" className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full font-medium">Needs review</span>;
          case 'stale': return <span key="stale" className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1"><AlertCircle className="h-2.5 w-2.5" />Stale</span>;
          default: return <span key={r} className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full font-medium">{r}</span>;
        }
      })}
    </span>
  );
}

export default function ReviewQueue() {
  const { i18n } = useTranslation();

  const { startDate, endDate } = useDateFilter();

  const { data, isLoading } = useQuery<QueueData>({
    queryKey: ['review-queue', startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      return api(`/review-queue?${params.toString()}`) as Promise<QueueData>;
    },
    refetchInterval: 5000,
  });

  const items = data?.items || [];
  const counts = data?.counts || { bank_statements: 0, card_statements: 0, invoices: 0, journal_entries: 0 };

  // Group items by type
  const grouped = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr('Pending Review', '待審核', '待审核')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {tr(
              'Items that need your attention before they are finalized.',
              '需要您處理的項目，確認後才會正式記錄。',
              '需要您处理的项目，确认后才会正式记录。'
            )}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{tr('Auto-refreshes every 5s', '每5秒自動更新', '每5秒自动更新')}</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-card border rounded-xl p-12 text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto" />
          <p className="text-lg font-semibold">{tr('All caught up!', '全部已完成！', '全部已完成！')}</p>
          <p className="text-sm text-muted-foreground">{tr('No items pending review.', '沒有待審核的項目。', '没有待审核的项目。')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary counts */}
          <div className="flex flex-wrap gap-3">
            {Object.entries(counts).map(([key, count]) => {
              if (count === 0) return null;
              const cfg = TYPE_CONFIG[key] || TYPE_CONFIG.journal_entry;
              const Icon = cfg.icon;
              return (
                <div key={key} className="flex items-center gap-2 bg-card border rounded-lg px-3 py-2 text-sm">
                  <Icon className={`h-4 w-4 ${cfg.color}`} />
                  <span className="font-medium">{count}</span>
                  <span className="text-muted-foreground">{tr(cfg.label, cfg.labelZh, cfg.labelCn)}</span>
                </div>
              );
            })}
          </div>

          {/* Grouped items */}
          {Array.from(grouped.entries()).map(([type, typeItems]) => {
            const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.journal_entry;
            const Icon = cfg.icon;
            return (
              <div key={type} className="bg-card border rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-muted/50 border-b flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${cfg.color}`} />
                  <span className="font-semibold text-sm">{tr(cfg.label, cfg.labelZh, cfg.labelCn)}</span>
                  <span className="text-xs text-muted-foreground">({typeItems.length})</span>
                </div>
                <div className="divide-y">
                  {typeItems.map(item => (
                    <a
                      key={item.id}
                      href={item.reviewUrl}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors group"
                    >
                      <div className="space-y-0.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{item.title}</span>
                          <ReasonBadge reason={item.reason} />
                        </div>
                        {item.subtitle && (
                          <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                        )}
                        <p className="text-[11px] text-muted-foreground">{item.date}</p>
                      </div>
                      <span className="text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-3">
                        <ArrowRight className="h-4 w-4" />
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
