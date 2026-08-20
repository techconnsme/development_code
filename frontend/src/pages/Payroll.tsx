import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronDown } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import { STAFF, MONTHS, STATUSES, COA_ACCOUNTS, buildMonthlyJe, type SampleStaff, type MonthStatus } from '../data/samplePayroll';
import { computeMpf } from '../lib/mpf';

const fmt = (n: number) => `HKD ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const GENDER_LABEL: Record<SampleStaff['gender'], [string, string, string]> = {
  M: ['Male', '男', '男'],
  F: ['Female', '女', '女'],
};
const MARITAL_LABEL: Record<SampleStaff['maritalStatus'], [string, string, string]> = {
  single: ['Single', '單身', '单身'],
  married: ['Married', '已婚', '已婚'],
};

const num = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2 });

const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_META: Record<MonthStatus, { cls: string; en: string; zh: string; cn: string }> = {
  paid: { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'Paid', zh: '已支付', cn: '已支付' },
  pending: { cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', en: 'Pending', zh: '待支付', cn: '待支付' },
  scheduled: { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400', en: 'Scheduled', zh: '已排程', cn: '已排程' },
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}

function JeBlocks({ je }: { je: ReturnType<typeof buildMonthlyJe> }) {
  return (
    <div className="space-y-2">
      {[je.salary, je.mpf].map((b) => (
        <div key={b.id} className="rounded-lg border" style={{ borderColor: 'hsl(var(--border))' }}>
          <div className="px-3 py-1.5 border-b text-xs font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
            {tr(b.title, b.titleZh, b.titleCn)}
          </div>
          <div className="px-3 py-2 space-y-1.5">
            {b.lines
              .filter((l) => l.amount !== 0)
              .map((l, i) => {
                const acc = COA_ACCOUNTS[l.code];
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-7 shrink-0 font-semibold">{l.dr ? 'Dr' : 'Cr'}</span>
                    <span className="font-mono text-muted-foreground shrink-0">{acc.code}</span>
                    <span className="flex-1 min-w-0 truncate">{tr(acc.name, acc.nameZh, acc.nameCn)}</span>
                    <span className="font-mono shrink-0">{num(l.amount)}</span>
                  </div>
                );
              })}
            <div className="flex items-center gap-2 text-xs font-semibold border-t pt-1.5" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="w-7" />
              <span className="flex-1 text-muted-foreground">{tr('Total (Dr = Cr)', '合計（借 = 貸）', '合计（借 = 贷）')}</span>
              <span className="font-mono">{num(b.total)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MonthRow({ month, staff, open, onToggle }: { month: string; staff: SampleStaff; open: boolean; onToggle: () => void }) {
  const idx = MONTHS.indexOf(month);
  const status: MonthStatus = STATUSES[staff.id]?.[month] ?? 'scheduled';
  const meta = STATUS_META[status];
  const { employee, employer, net } = computeMpf(staff.monthlySalary);
  const je = buildMonthlyJe(staff);

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'hsl(var(--border))' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-3 py-2 hover:bg-primary/5 transition-colors text-left"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
        <span className="text-xs font-medium w-14 shrink-0">{tr(`${MONTH_LABELS_EN[idx]} 2026`, `2026年${idx + 1}月`, `2026年${idx + 1}月`)}</span>
        <span className={cn('text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0', meta.cls)}>{tr(meta.en, meta.zh, meta.cn)}</span>
        <span className="flex-1" />
        <span className="w-16 text-right font-mono text-[11px]">{num(staff.monthlySalary)}</span>
        <span className="w-16 text-right font-mono text-[11px]">{num(employee)}</span>
        <span className="w-16 text-right font-mono text-[11px]">{num(employer)}</span>
        <span className="w-16 text-right font-mono text-[11px] font-medium">{num(net)}</span>
      </button>
      {/* Accordion — reveals the COA entries */}
      <div className={cn('overflow-hidden transition-all duration-300 ease-out', open ? 'max-h-[420px] opacity-100' : 'max-h-0 opacity-0')}>
        <div className="px-3 pb-3 pt-1">
          <JeBlocks je={je} />
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ staff, onClose }: { staff: SampleStaff; onClose: () => void }) {
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const { employee, employer, net } = computeMpf(staff.monthlySalary);

  return (
    <div className="h-full flex flex-col animate-[payroll-slide-in_300ms_ease-out]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="min-w-0">
          <div className="font-semibold">{tr(staff.name, staff.nameZh, staff.nameCn)}</div>
          <div className="text-xs text-muted-foreground">{tr(staff.title, staff.titleZh, staff.titleCn)} · {staff.id}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-muted text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Meta */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{tr('Gender', '性別', '性别')}: {tr(...GENDER_LABEL[staff.gender])}</span>
          <span>{tr('Marital Status', '婚姻狀況', '婚姻状况')}: {tr(...MARITAL_LABEL[staff.maritalStatus])}</span>
          <span>
            {tr('Monthly Salary', '月薪', '月薪')}:{' '}
            <span className="text-foreground font-semibold font-mono">{fmt(staff.monthlySalary)}</span>
          </span>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-2">
          <SummaryCard label={tr('Gross Salary', '總薪金', '总薪金')} value={fmt(staff.monthlySalary)} />
          <SummaryCard label={tr('Employee MPF', '僱員強積金', '雇员强积金')} value={fmt(employee)} />
          <SummaryCard label={tr('Employer MPF', '僱主強積金', '雇主强积金')} value={fmt(employer)} />
          <SummaryCard label={tr('Net Pay', '實發薪金', '实发薪金')} value={fmt(net)} />
        </div>

        {/* Monthly table */}
        <div>
          <div className="text-sm font-semibold mb-2">{tr('Monthly Payment Status', '每月支付狀態', '每月支付状态')}</div>
          <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
            <div className="flex items-center gap-1 px-3 py-1.5 border-b text-[9px] uppercase tracking-wide text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="pl-[18px] w-14 shrink-0">{tr('Month', '月份', '月份')}</span>
              <span className="w-14 shrink-0">{tr('Status', '狀態', '状态')}</span>
              <span className="flex-1" />
              <span className="w-16 text-right">{tr('Gross', '總額', '总额')}</span>
              <span className="w-16 text-right">{tr('EE MPF', '僱員MPF', '雇员MPF')}</span>
              <span className="w-16 text-right">{tr('ER MPF', '僱主MPF', '雇主MPF')}</span>
              <span className="w-16 text-right">{tr('Net', '實發', '实发')}</span>
            </div>
            {MONTHS.map((m) => (
              <MonthRow
                key={m}
                month={m}
                staff={staff}
                open={openMonth === m}
                onToggle={() => setOpenMonth((prev) => (prev === m ? null : m))}
              />
            ))}
          </div>
        </div>
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
                  selectedId === s.id && 'bg-primary/10'
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
          {selected && <DetailPanel key={selected.id} staff={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>
    </div>
  );
}
