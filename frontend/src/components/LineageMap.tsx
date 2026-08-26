import { tr } from '../lib/i18nHelpers';

interface JeLine { account_code: string; account_name: string; debit: number; credit: number; account_type?: string | null }
interface JournalEntry {
  id: string; entry_number: string; entry_date: string; description: string | null;
  reference_type: string; status: string; entry_source: string; lines: JeLine[];
}
interface LinkedTx {
  id: string; transaction_date: string; description: string;
  amount: number; allocated_amount: number | null; link_type: 'direct' | 'group';
  payment_voucher_no: string | null;
}
interface Props {
  invoiceNumber: string; total: number; currency: string;
  invoiceJe: JournalEntry | null;
  paymentEntries: { je: JournalEntry; tx?: LinkedTx }[];
}

const isHolding = (l: JeLine) => l.account_type === 'asset' || l.account_type === 'liability';

function JeCard({ title, je, tx }: { title: string; je: JournalEntry; tx?: LinkedTx }) {
  return (
    <div className="border rounded px-2 py-1.5 bg-background" data-testid="lineage-je-card">
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-[10px] uppercase text-muted-foreground">{title}</span>
        <span className="font-mono font-medium ml-auto">{je.entry_number}</span>
      </div>
      {tx && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-0.5">
          <span className="font-mono">{tx.transaction_date}</span>
          <span className="truncate max-w-[14rem]">{tx.description}</span>
          <span className="font-mono ml-auto">{(tx.allocated_amount ?? tx.amount)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
      )}
      <div className="space-y-0.5">
        {je.lines.map((l, i) => (
          <div key={i} className={`flex items-center gap-2 text-xs rounded px-1 ${isHolding(l) ? 'ring-1 ring-blue-300' : ''}`}>
            <span className={`font-mono font-bold ${l.debit > 0 ? 'text-red-600' : 'text-green-600'}`}>{l.debit > 0 ? 'Dr' : 'Cr'}</span>
            <span className="font-mono">{l.account_code}</span>
            <span className="text-muted-foreground truncate flex-1">{l.account_name}</span>
            <span className="font-mono font-medium">
              {(l.debit > 0 ? l.debit : l.credit)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Entry 1 → pivot → Entry 2 flow for one invoice (pure display). */
export default function LineageMap({ invoiceNumber, total, currency, invoiceJe, paymentEntries }: Props) {
  const holdingLine = invoiceJe?.lines.find(isHolding) || null;
  return (
    <div className="rounded border border-dashed p-2 space-y-2 bg-muted/10" data-testid="lineage-map">
      {/* Entry 1 */}
      <JeCard
        title={tr('Entry 1 · recorded', '分錄一 · 入賬', '分录一 · 入账')}
        je={invoiceJe || {
          id: 'none', entry_number: '', entry_date: '', description: null,
          reference_type: 'invoice', status: '', entry_source: '', lines: [],
        }}
      />
      {!invoiceJe && (
        <p className="text-xs text-muted-foreground -mt-1">
          {tr('Not yet posted to GL', '尚未過賬至總賬', '尚未过账至总账')}
        </p>
      )}
      {/* Pivot */}
      {holdingLine && (
        <div className="flex justify-center" data-testid="lineage-pivot">
          <span className="inline-flex items-center gap-2 font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 text-xs">
            {tr('Holding', '過渡', '过渡')}: {holdingLine.account_code} · {holdingLine.account_name}
            <span className="font-normal text-muted-foreground">{currency} {total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </span>
        </div>
      )}
      {/* Entry 2 cards */}
      {paymentEntries.map(({ je, tx }) => (
        <div key={je.id} className={tx?.link_type === 'group' ? 'border-l-2 border-blue-200 pl-2' : ''}>
          <div className="text-[10px] uppercase text-muted-foreground mb-0.5">
            {tr('Settled by', '結算自', '结算自')} {tx?.link_type === 'group' ? `(${tr('group slice', '合併付款份額', '合并付款份额')})` : ''}
          </div>
          <JeCard title={tr('Entry 2 · bank payment', '分錄二 · 銀行收付', '分录二 · 银行收付')} je={je} tx={tx} />
        </div>
      ))}
    </div>
  );
}
