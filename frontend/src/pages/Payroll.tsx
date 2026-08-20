import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import { STAFF, type SampleStaff } from '../data/samplePayroll';

const fmt = (n: number) => `HKD ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const GENDER_LABEL: Record<SampleStaff['gender'], [string, string, string]> = {
  M: ['Male', '男', '男'],
  F: ['Female', '女', '女'],
};
const MARITAL_LABEL: Record<SampleStaff['maritalStatus'], [string, string, string]> = {
  single: ['Single', '單身', '单身'],
  married: ['Married', '已婚', '已婚'],
};

// Minimal detail content for this task — Task 4 replaces this with the full DetailPanel.
function DetailStub({ staff, onClose }: { staff: SampleStaff; onClose: () => void }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="min-w-0">
          <div className="font-semibold">{tr(staff.name, staff.nameZh, staff.nameCn)}</div>
          <div className="text-xs text-muted-foreground">{tr(staff.title, staff.titleZh, staff.titleCn)} · {staff.id}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-muted text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function Payroll() {
  useTranslation(); // keeps tr() reactive on language change
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = STAFF.find((s) => s.id === selectedId) || null;

  return (
    <div className="space-y-6">
      <style>{`@keyframes payroll-slide-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }`}</style>

      {/* Page header */}
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold">{tr('Payroll', '薪資', '薪资')}</h2>
          <p className="text-muted-foreground mt-1">{tr('Sample payroll for demonstration.', '薪資演示樣本。', '薪资演示样本。')}</p>
        </div>
        <span className="ml-auto text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          {tr('Demo data', '演示數據', '演示数据')}
        </span>
      </div>

      {/* One continuous card: staff list + extending detail region */}
      <div className="relative flex items-stretch bg-card border rounded-xl overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="flex-1 min-w-0">
          {/* Column header */}
          <div className="grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 px-5 py-2.5 border-b text-[11px] uppercase tracking-wide text-muted-foreground font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
            <span>{tr('Staff', '員工', '员工')}</span>
            <span>{tr('Staff No.', '員工編號', '员工编号')}</span>
            <span>{tr('Gender', '性別', '性别')}</span>
            <span>{tr('Marital', '婚姻', '婚姻')}</span>
            <span className="text-right">{tr('Salary', '薪金', '薪金')}</span>
          </div>
          {/* Rows */}
          <div className="max-h-[560px] overflow-y-auto">
            {STAFF.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId((prev) => (prev === s.id ? null : s.id))}
                className={cn(
                  'w-full grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 items-center px-5 py-3 text-left transition-colors border-b last:border-b-0',
                  'hover:bg-primary/5',
                  selectedId === s.id && 'bg-primary/5'
                )}
                style={{ borderColor: 'hsl(var(--border))' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'hsl(var(--primary)/0.1)', color: 'hsl(var(--primary))' }}>
                    {s.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{tr(s.name, s.nameZh, s.nameCn)}</div>
                    <div className="text-xs text-muted-foreground truncate">{tr(s.title, s.titleZh, s.titleCn)}</div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono">{s.id}</span>
                <span className="text-xs text-muted-foreground">{tr(...GENDER_LABEL[s.gender])}</span>
                <span className="text-xs text-muted-foreground">{tr(...MARITAL_LABEL[s.maritalStatus])}</span>
                <span className="text-sm font-semibold font-mono text-right">{fmt(s.monthlySalary)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Divider — fades in only when the detail is open (desktop) */}
        <div
          className={cn('hidden md:block w-px self-stretch transition-opacity duration-300', selected ? 'opacity-100' : 'opacity-0')}
          style={{ backgroundColor: 'hsl(var(--border))' }}
        />

        {/* Detail region — mobile: full-width overlay; md+: width extension */}
        <div
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-full overflow-hidden transition-all duration-300 ease-out bg-card shadow-2xl',
            'md:static md:w-0 md:translate-x-0 md:z-auto md:shadow-none',
            selected ? 'translate-x-0 md:w-[480px]' : 'translate-x-full'
          )}
        >
          {selected && <DetailStub key={selected.id} staff={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>
    </div>
  );
}
