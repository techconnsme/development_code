import React from 'react';
import { tr } from '../../lib/i18nHelpers';

export const fmt = (n: number) => `HKD ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export const num = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2 });

export interface JeBlockLineInput {
  dr: boolean;
  code: string;
  name: string;
  nameZh?: string;
  nameCn?: string;
  amount: number;
}

export interface JeBlockInput {
  id: string;
  title: string;
  titleZh: string;
  titleCn: string;
  lines: JeBlockLineInput[];
  total: number;
}

export function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}

/** Bilingual Dr/Cr journal-entry block (visual format shared by demo + real payroll views). */
export function JeBlockView({ block }: { block: JeBlockInput }) {
  return (
    <div className="rounded-lg border" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="px-3 py-1.5 border-b text-xs font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
        {tr(block.title, block.titleZh, block.titleCn)}
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {block.lines
          .filter((l) => l.amount !== 0)
          .map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-7 shrink-0 font-semibold">{l.dr ? 'Dr' : 'Cr'}</span>
              <span className="font-mono text-muted-foreground shrink-0">{l.code}</span>
              <span className="flex-1 min-w-0 truncate">{tr(l.name, l.nameZh || l.name, l.nameCn || l.name)}</span>
              <span className="font-mono shrink-0">{num(l.amount)}</span>
            </div>
          ))}
        <div className="flex items-center gap-2 text-xs font-semibold border-t pt-1.5" style={{ borderColor: 'hsl(var(--border))' }}>
          <span className="w-7" />
          <span className="flex-1 text-muted-foreground">{tr('Total (Dr = Cr)', '合計（借 = 貸）', '合计（借 = 贷）')}</span>
          <span className="font-mono">{num(block.total)}</span>
        </div>
      </div>
    </div>
  );
}
