import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, ChevronDown } from 'lucide-react';
import { tr } from '../../lib/i18nHelpers';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import SlidePanel from '../../components/SlidePanel';
import { fmt, num, SummaryCard, JeBlockView, type JeBlockInput } from './shared';

// ── Types (mirror /api/payroll responses) ────────────────────────────────────
interface PayrollEmployee {
  id: string; employee_number: string; name: string; title: string | null;
  gender: 'M' | 'F'; marital_status: 'single' | 'married'; monthly_salary: number;
  expense_account_code: string; hire_date: string; termination_date: string | null;
  is_active: number;
}
interface RunItemRow {
  employee_id: string; employee_number?: string; employee_name?: string;
  gross: number; ee_mpf: number; er_mpf: number; net: number; expense_account_code: string;
}
interface LinkedEntry { id: string; entry_number: string; entry_date: string; description: string; status: string }
type RunStatus = 'draft' | 'accrued' | 'paid' | 'settled' | 'cancelled';
interface PayrollRun {
  id: string; period_month: string; status: RunStatus;
  total_gross: number; total_ee_mpf: number; total_er_mpf: number; total_net: number;
  bank_account_code: string | null;
  accrual_entry_id: string | null; payment_entry_id: string | null; mpf_entry_id: string | null;
  items?: RunItemRow[]; linked_entries?: LinkedEntry[];
}
interface Totals { total_gross: number; total_ee_mpf: number; total_er_mpf: number; total_net: number }

// ── Constants ────────────────────────────────────────────────────────────────
const REAL_COA: Record<string, { code: string; name: string; nameZh: string; nameCn: string }> = {
  '11102': { code: '11102', name: 'HSBC', nameZh: '滙豐銀行', nameCn: '汇丰银行' },
  '21203': { code: '21203', name: 'Salary Payable', nameZh: '薪酬應付', nameCn: '薪酬应付' },
  '21204': { code: '21204', name: 'MPF Payable', nameZh: '應付強積金', nameCn: '应付强积金' },
  '51201': { code: '51201', name: 'Project Staff Salary', nameZh: '項目人員薪酬', nameCn: '项目人员薪酬' },
  '61102': { code: '61102', name: 'Management Salary', nameZh: '管理層薪酬', nameCn: '管理层薪酬' },
  '61201': { code: '61201', name: 'Staff Salaries', nameZh: '員工薪酬', nameCn: '员工薪酬' },
  '61202': { code: '61202', name: 'MPF Employer Contribution', nameZh: '強積金僱主供款', nameCn: '强积金雇主供款' },
};
const FALLBACK_ACC = (code: string) => ({ code, name: code, nameZh: code, nameCn: code });
const SALARY_ACCOUNTS = ['51201', '61102', '61201'];

const GENDER_LABEL: Record<'M' | 'F', [string, string, string]> = { M: ['Male', '男', '男'], F: ['Female', '女', '女'] };
const MARITAL_LABEL: Record<'single' | 'married', [string, string, string]> = {
  single: ['Single', '單身', '单身'], married: ['Married', '已婚', '已婚'],
};

const RUN_STATUS_META: Record<RunStatus, { cls: string; en: string; zhHant: string; zhHans: string }> = {
  draft:     { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400', en: 'Draft', zhHant: '草稿', zhHans: '草稿' },
  accrued:   { cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', en: 'Accrued', zhHant: '已計提', zhHans: '已计提' },
  paid:      { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'Paid', zhHant: '已支付', zhHans: '已支付' },
  settled:   { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'MPF Settled', zhHant: '強積金已繳', zhHans: '强积金已缴' },
  cancelled: { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400 line-through', en: 'Cancelled', zhHant: '已取消', zhHans: '已取消' },
};

// ── Client-side JE block composition (mirrors api/src/lib/payroll-core.ts) ──
function accrualBlock(items: RunItemRow[], totals: Totals): JeBlockInput {
  const byAccount = new Map<string, number>();
  for (const it of items) byAccount.set(it.expense_account_code, (byAccount.get(it.expense_account_code) || 0) + it.gross);
  const lines = [
    ...[...byAccount.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, amount]) => ({ dr: true, ...(REAL_COA[code] || FALLBACK_ACC(code)), amount })),
    { dr: true, ...(REAL_COA['61202'] || FALLBACK_ACC('61202')), amount: totals.total_er_mpf },
    { dr: false, ...(REAL_COA['21204'] || FALLBACK_ACC('21204')), amount: totals.total_ee_mpf + totals.total_er_mpf },
    { dr: false, ...(REAL_COA['21203'] || FALLBACK_ACC('21203')), amount: totals.total_net },
  ];
  return {
    id: 'accrual', title: 'Payroll Accrual', titleZh: '薪酬應計', titleCn: '薪酬应计',
    lines: lines.filter((l) => l.amount !== 0),
    total: totals.total_gross + totals.total_er_mpf,
  };
}

function paymentBlock(totals: Totals, bankCode: string): JeBlockInput {
  const bank = REAL_COA[bankCode] || FALLBACK_ACC(bankCode);
  return {
    id: 'payment', title: 'Salary Payment', titleZh: '薪金支付', titleCn: '薪金支付',
    lines: [
      { dr: true, ...(REAL_COA['21203'] || FALLBACK_ACC('21203')), amount: totals.total_net },
      { dr: false, ...bank, amount: totals.total_net },
    ].filter((l) => l.amount !== 0),
    total: totals.total_net,
  };
}

function settlementBlock(totals: Totals, bankCode: string): JeBlockInput {
  const bank = REAL_COA[bankCode] || FALLBACK_ACC(bankCode);
  const mpfTotal = totals.total_ee_mpf + totals.total_er_mpf;
  return {
    id: 'mpf', title: 'MPF Remittance', titleZh: '強積金供款', titleCn: '强积金供款',
    lines: [
      { dr: true, ...(REAL_COA['21204'] || FALLBACK_ACC('21204')), amount: mpfTotal },
      { dr: false, ...bank, amount: mpfTotal },
    ].filter((l) => l.amount !== 0),
    total: mpfTotal,
  };
}

// ── Employee form (slide panel) ──────────────────────────────────────────────
interface FormState {
  employee_number: string; name: string; title: string;
  gender: 'M' | 'F'; marital_status: 'single' | 'married'; monthly_salary: string;
  expense_account_code: string; hire_date: string; termination_date: string; is_active: boolean;
}

const EMPTY_FORM: FormState = {
  employee_number: '', name: '', title: '', gender: 'M', marital_status: 'single',
  monthly_salary: '', expense_account_code: '61201', hire_date: '', termination_date: '', is_active: true,
};

function EmployeeFormPanel({ open, initial, onClose }: {
  open: boolean;
  initial: PayrollEmployee | null; // null → create
  onClose: () => void;
}) {
  useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initial ? ({
    employee_number: initial.employee_number, name: initial.name, title: initial.title || '',
    gender: initial.gender, marital_status: initial.marital_status,
    monthly_salary: String(initial.monthly_salary), expense_account_code: initial.expense_account_code,
    hire_date: initial.hire_date, termination_date: initial.termination_date || '',
    is_active: !!initial.is_active,
  }) : EMPTY_FORM);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload: any = {
        employee_number: form.employee_number.trim(),
        name: form.name.trim(),
        title: form.title.trim() || undefined,
        gender: form.gender,
        marital_status: form.marital_status,
        monthly_salary: Number(form.monthly_salary),
        expense_account_code: form.expense_account_code,
        hire_date: form.hire_date,
        termination_date: form.termination_date || null,
        is_active: form.is_active,
      };
      if (!payload.name) throw new Error(tr('Name is required.', '請填寫姓名。', '请填写姓名。'));
      if (!payload.hire_date) throw new Error(tr('Hire date is required.', '請填寫入職日期。', '请填写入职日期。'));
      if (!payload.employee_number) throw new Error(tr('Staff No. is required.', '請填寫員工編號。', '请填写员工编号。'));
      if (!(payload.monthly_salary >= 0)) throw new Error(tr('Valid salary required.', '請填寫有效薪金。', '请填写有效薪金。'));
      return api(initial ? `/payroll/employees/${initial.id}` : '/payroll/employees',
        { method: initial ? 'PATCH' : 'POST', body: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-employees'] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const inputCls = 'w-full border rounded-md px-2.5 py-1.5 text-sm bg-background';
  const field = (labelEn: string, labelZh: string, node: React.ReactNode) => (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{tr(labelEn, labelZh, labelZh)}</span>
      <div className="mt-1">{node}</div>
    </label>
  );

  return (
    <SlidePanel open={open} onClose={onClose} width={420}
      title={tr(initial ? 'Edit employee' : 'Add employee', initial ? '編輯員工' : '新增员工', initial ? '编辑员工' : '新增员工')}>
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {field('Staff No.', '員工編號',
            <input className={inputCls} value={form.employee_number} onChange={(e) => setForm({ ...form, employee_number: e.target.value })} />)}
          {field('Name', '姓名',
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />)}
          {field('Job Title', '職位',
            <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="—" />)}
          <div className="grid grid-cols-2 gap-3">
            {field('Gender', '性別',
              <select className={inputCls} value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as 'M' | 'F' })}>
                <option value="M">{tr(...GENDER_LABEL.M)}</option>
                <option value="F">{tr(...GENDER_LABEL.F)}</option>
              </select>)}
            {field('Marital Status', '婚姻狀況',
              <select className={inputCls} value={form.marital_status} onChange={(e) => setForm({ ...form, marital_status: e.target.value as FormState['marital_status'] })}>
                <option value="single">{tr(...MARITAL_LABEL.single)}</option>
                <option value="married">{tr(...MARITAL_LABEL.married)}</option>
              </select>)}
          </div>
          {field('Monthly Salary (HKD)', '月薪 (HKD)',
            <input type="number" min="0" step="100" className={inputCls} value={form.monthly_salary} onChange={(e) => setForm({ ...form, monthly_salary: e.target.value })} />)}
          {field('Salary Expense Account', '薪金支出科目',
            <select className={inputCls} value={form.expense_account_code} onChange={(e) => setForm({ ...form, expense_account_code: e.target.value })}>
              {SALARY_ACCOUNTS.map((c) => {
                const a = REAL_COA[c];
                return <option key={c} value={c}>{c} · {tr(a.name, a.nameZh, a.nameCn)}</option>;
              })}
            </select>)}
          <div className="grid grid-cols-2 gap-3">
            {field('Hire Date', '入職日期',
              <input type="date" className={inputCls} value={form.hire_date} onChange={(e) => setForm({ ...form, hire_date: e.target.value })} />)}
            {field('Termination Date', '離職日期',
              <input type="date" className={inputCls} value={form.termination_date} onChange={(e) => setForm({ ...form, termination_date: e.target.value })} />)}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            {tr('Active', '在職', '在职')}
          </label>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="border-t p-4 flex justify-end gap-2" style={{ borderColor: 'hsl(var(--border))' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted" style={{ borderColor: 'hsl(var(--border))' }}>
            {tr('Cancel', '取消', '取消')}
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
            {tr('Save', '儲存', '保存')}
          </button>
        </div>
      </div>
    </SlidePanel>
  );
}

// ── Main real view ───────────────────────────────────────────────────────────
export default function RealPayroll() {
  useTranslation();
  const qc = useQueryClient();
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<PayrollEmployee | null>(null);
  const [empErr, setEmpErr] = useState<string | null>(null);
  const [selMonth, setSelMonth] = useState('');
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [payBank, setPayBank] = useState('11102');
  const [actionErr, setActionErr] = useState<string | null>(null);

  const employees = useQuery<PayrollEmployee[]>({ queryKey: ['payroll-employees'], queryFn: () => api('/payroll/employees') });
  const banks = useQuery<{ account_code: string; account_name: string }[]>({ queryKey: ['payroll-banks'], queryFn: () => api('/payroll/bank-accounts') });
  const runs = useQuery<PayrollRun[]>({ queryKey: ['payroll-runs'], queryFn: () => api('/payroll/runs') });
  const enabledPreview = /^\d{4}-\d{2}$/.test(selMonth);
  const preview = useQuery<{ items: RunItemRow[]; totals: Totals }>({
    queryKey: ['payroll-preview', selMonth],
    queryFn: () => api(`/payroll/runs/preview?period=${selMonth}`),
    enabled: enabledPreview,
  });
  const runDetail = useQuery<PayrollRun>({
    queryKey: ['payroll-run', openRunId],
    queryFn: () => api(`/payroll/runs/${openRunId}`),
    enabled: !!openRunId,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['payroll-runs'] });
    qc.invalidateQueries({ queryKey: ['payroll-run'] });
  };

  const createRun = useMutation({
    mutationFn: () => api('/payroll/runs', { method: 'POST', body: { period_month: selMonth } }),
    onSuccess: (r: any) => { invalidateAll(); setOpenRunId(r.id); },
    onError: (e: Error) => setActionErr(e.message),
  });

  // One hook per lifecycle action (stable order across renders)
  const postAccrual = useMutation({
    mutationFn: () => api(`/payroll/runs/${openRunId}/post-accrual`, { method: 'POST' }),
    onSuccess: () => { setActionErr(null); invalidateAll(); },
    onError: (e: Error) => setActionErr(e.message),
  });
  const markPaid = useMutation({
    mutationFn: () => api(`/payroll/runs/${openRunId}/mark-paid`, { method: 'POST', body: { bank_account_code: payBank } }),
    onSuccess: () => { setActionErr(null); invalidateAll(); },
    onError: (e: Error) => setActionErr(e.message),
  });
  const markSettled = useMutation({
    mutationFn: () => api(`/payroll/runs/${openRunId}/mark-mpf-settled`, { method: 'POST' }),
    onSuccess: () => { setActionErr(null); invalidateAll(); },
    onError: (e: Error) => setActionErr(e.message),
  });
  const voidRun = useMutation({
    mutationFn: () => api(`/payroll/runs/${openRunId}/void`, { method: 'POST' }),
    onSuccess: () => { setActionErr(null); invalidateAll(); },
    onError: (e: Error) => setActionErr(e.message),
  });

  const delEmp = useMutation({
    mutationFn: (id: string) => api(`/payroll/employees/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setEmpErr(null); qc.invalidateQueries({ queryKey: ['payroll-employees'] }); },
    onError: (e: Error) => setEmpErr(e.message),
  });
  void delEmp; // delete exposed later via edit panel; PATCH deactivation is the primary path

  const list = employees.data || [];
  const runList = runs.data || [];
  const detail = runDetail.data;

  return (
    <div className="space-y-6">
      {/* ── Employees card ── */}
      <div className="bg-card border rounded-xl overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="flex items-center px-5 py-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
          <h3 className="text-sm font-semibold">{tr('Employees', '員工', '员工')}</h3>
          <span className="text-xs text-muted-foreground ml-2">{list.length}</span>
          <button
            onClick={() => { setEditing(null); setPanelOpen(true); }}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            {tr('Add employee', '新增員工', '新增员工')}
          </button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 px-5 py-2 border-b text-[11px] uppercase tracking-wide text-muted-foreground font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
          <span>{tr('Staff', '員工', '员工')}</span>
          <span>{tr('Staff No.', '員工編號', '员工编号')}</span>
          <span>{tr('Gender', '性別', '性别')}</span>
          <span>{tr('Marital', '婚姻', '婚姻')}</span>
          <span className="text-right">{tr('Salary', '薪金', '薪金')}</span>
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {list.length === 0 && !employees.isLoading && (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {tr('No employees yet. Add your first one above.', '尚未有員工，請先新增。', '尚未有员工，请先新增。')}
            </div>
          )}
          {list.map((s) => {
            const acc = REAL_COA[s.expense_account_code] || FALLBACK_ACC(s.expense_account_code);
            return (
              <div key={s.id} className={cn('group grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 items-center px-5 py-2.5 border-b last:border-b-0', !s.is_active && 'opacity-50')} style={{ borderColor: 'hsl(var(--border))' }}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'hsl(var(--primary)/0.1)', color: 'hsl(var(--primary))' }}>
                    {s.name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {s.name}{!s.is_active && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded-full bg-gray-400/10 text-gray-500 align-middle">{tr('Inactive', '已停用', '已停用')}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{s.title || '—'} · {tr(acc.name, acc.nameZh, acc.nameCn)}</div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono">{s.employee_number}</span>
                <span className="text-xs text-muted-foreground">{tr(...GENDER_LABEL[s.gender])}</span>
                <span className="text-xs text-muted-foreground">{tr(...MARITAL_LABEL[s.marital_status])}</span>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-sm font-semibold font-mono text-right">{fmt(s.monthly_salary)}</span>
                  <button aria-label={`Edit ${s.employee_number}`} onClick={() => { setEditing(s); setPanelOpen(true); }}
                    className="p-1 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {empErr && <p className="px-5 pb-2 pt-1.5 text-xs text-red-500">{empErr}</p>}
      </div>

      {/* ── Runs card ── */}
      <div className="bg-card border rounded-xl overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="flex items-center gap-2 flex-wrap px-5 py-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
          <h3 className="text-sm font-semibold">{tr('Monthly Runs', '每月運行', '每月运行')}</h3>
          <div className="ml-auto flex items-center gap-2">
            <input type="month" value={selMonth} onChange={(e) => { setSelMonth(e.target.value); setActionErr(null); }}
              className="border rounded-md px-2 py-1 text-xs bg-background" style={{ borderColor: 'hsl(var(--border))' }} />
          </div>
        </div>

        {/* Preview strip */}
        {enabledPreview && (
          <div className="px-5 py-3 border-b space-y-3" style={{ borderColor: 'hsl(var(--border))' }}>
            {preview.isLoading ? (
              <p className="text-xs text-muted-foreground">…</p>
            ) : preview.data && preview.data.items.length > 0 ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <SummaryCard label={tr('Gross Salary', '總薪金', '总薪金')} value={fmt(preview.data.totals.total_gross)} />
                  <SummaryCard label={tr('Employee MPF', '僱員強積金', '雇员强积金')} value={fmt(preview.data.totals.total_ee_mpf)} />
                  <SummaryCard label={tr('Employer MPF', '僱主強積金', '雇主强积金')} value={fmt(preview.data.totals.total_er_mpf)} />
                  <SummaryCard label={tr('Net Pay', '實發薪金', '实发薪金')} value={fmt(preview.data.totals.total_net)} />
                </div>
                <JeBlockView block={accrualBlock(preview.data.items, preview.data.totals)} />
                <button onClick={() => createRun.mutate()} disabled={createRun.isPending}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                  {tr(`Create run ${selMonth}`, `建立 ${selMonth} 運行`, `建立 ${selMonth} 运行`)}
                </button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {tr('No active employees are in-tenure for this period.', '此月份無符合資格的在職員工。', '此月份无符合资格的在职员工。')}
              </p>
            )}
          </div>
        )}

        {/* Runs list */}
        {runList.map((r) => {
          const meta = RUN_STATUS_META[r.status];
          const open = openRunId === r.id;
          return (
            <div key={r.id} className="border-b last:border-b-0" style={{ borderColor: 'hsl(var(--border))' }}>
              <button onClick={() => { setOpenRunId(open ? null : r.id); setActionErr(null); }}
                className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-primary/5 transition-colors text-left">
                <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
                <span className="text-sm font-mono font-medium">{r.period_month}</span>
                <span className={cn('text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0', meta.cls)}>{tr(meta.en, meta.zhHant, meta.zhHans)}</span>
                <span className="flex-1" />
                <span className="text-xs font-mono text-right">{num(r.total_gross)}</span>
                <span className="w-24 text-right text-xs font-mono text-muted-foreground hidden md:inline">{num(r.total_net)}</span>
              </button>

              {open && (
                <div className="px-5 pb-4 space-y-4">
                  {!detail || runDetail.isLoading ? (
                    <p className="text-xs text-muted-foreground">…</p>
                  ) : detail && detail.items && detail.items.length > 0 ? (
                    <>
                      {/* Per-employee items */}
                      <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
                        <div className="flex items-center gap-2 px-3 py-1.5 border-b text-[9px] uppercase tracking-wide text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
                          <span className="flex-1">{tr('Employee', '員工', '员工')}</span>
                          <span className="w-20 text-right">{tr('Gross', '總額', '总额')}</span>
                          <span className="w-16 text-right">{tr('EE MPF', '僱員MPF', '雇员MPF')}</span>
                          <span className="w-16 text-right">{tr('ER MPF', '僱主MPF', '雇主MPF')}</span>
                          <span className="w-20 text-right">{tr('Net', '實發', '实发')}</span>
                        </div>
                        {detail.items.map((it) => (
                          <div key={it.employee_id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b last:border-b-0" style={{ borderColor: 'hsl(var(--border))' }}>
                            <span className="flex-1 min-w-0 truncate">
                              {it.employee_name || it.employee_id}
                              <span className="ml-1.5 text-muted-foreground font-mono">{it.employee_number}</span>
                            </span>
                            <span className="w-20 text-right font-mono">{num(it.gross)}</span>
                            <span className="w-16 text-right font-mono">{num(it.ee_mpf)}</span>
                            <span className="w-16 text-right font-mono">{num(it.er_mpf)}</span>
                            <span className="w-20 text-right font-mono font-medium">{num(it.net)}</span>
                          </div>
                        ))}
                        <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold" style={{ borderTopColor: 'hsl(var(--border))', borderTopWidth: 1 }}>
                          <span className="flex-1 text-muted-foreground">{tr('Totals', '合計', '合计')}</span>
                          <span className="w-20 text-right font-mono">{num(detail.total_gross)}</span>
                          <span className="w-16 text-right font-mono">{num(detail.total_ee_mpf)}</span>
                          <span className="w-16 text-right font-mono">{num(detail.total_er_mpf)}</span>
                          <span className="w-20 text-right font-mono">{num(detail.total_net)}</span>
                        </div>
                      </div>

                      {/* Staged journal entries — future stages greyed out until reached */}
                      <div className="space-y-2">
                        {(() => {
                          const s = detail.status;
                          const totals: Totals = {
                            total_gross: detail.total_gross, total_ee_mpf: detail.total_ee_mpf,
                            total_er_mpf: detail.total_er_mpf, total_net: detail.total_net,
                          };
                          const stages = [
                            { key: 'accrual', block: accrualBlock(detail.items!, totals), doneId: detail.accrual_entry_id, posted: s !== 'draft' },
                            { key: 'payment', block: paymentBlock(totals, detail.bank_account_code || '11102'), doneId: detail.payment_entry_id, posted: s === 'paid' || s === 'settled' },
                            { key: 'mpf', block: settlementBlock(totals, detail.bank_account_code || '11102'), doneId: detail.mpf_entry_id, posted: s === 'settled' },
                          ];
                          return stages.map(({ key, block, doneId, posted }) => (
                            <div key={key} className={cn(!posted && 'opacity-40 pointer-events-none select-none')}>
                              {doneId && (() => {
                                const le = detail.linked_entries?.find((e) => e.id === doneId);
                                return le ? (
                                  <p className="text-[10px] text-muted-foreground mb-1 font-mono">{le.entry_number} · {le.entry_date} · {le.status}</p>
                                ) : null;
                              })()}
                              <JeBlockView block={block} />
                            </div>
                          ));
                        })()}
                      </div>

                      {/* Action bar per stage */}
                      {detail.status !== 'cancelled' && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {detail.status === 'draft' && (
                            <button onClick={() => postAccrual.mutate()} disabled={postAccrual.isPending}
                              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                              {tr('Confirm & post accrual', '確認並過賬計提', '确认并过账计提')}
                            </button>
                          )}
                          {detail.status === 'accrued' && (
                            <>
                              <select value={payBank} onChange={(e) => setPayBank(e.target.value)}
                                className="border rounded-md px-2 py-1.5 text-xs bg-background" style={{ borderColor: 'hsl(var(--border))' }}>
                                {(banks.data?.length ? banks.data : [{ account_code: '11102', account_name: 'HSBC' }]).map((b) => (
                                  <option key={b.account_code} value={b.account_code}>{b.account_code} · {b.account_name}</option>
                                ))}
                              </select>
                              <button onClick={() => markPaid.mutate()} disabled={markPaid.isPending}
                                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                                {tr('Mark paid', '標記已支付', '标记已支付')}
                              </button>
                            </>
                          )}
                          {detail.status === 'paid' && (
                            <button onClick={() => markSettled.mutate()} disabled={markSettled.isPending}
                              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                              {tr('Mark MPF settled', '標記強積金已繳', '标记强积金已缴')}
                            </button>
                          )}
                          {(detail.status === 'draft' || detail.status === 'accrued') && (
                            <button
                              onClick={() => { if (window.confirm(tr('Void this run and reverse its postings?', '作廢此運行並反過賬？', '作废此运行并反过账？'))) voidRun.mutate(); }}
                              disabled={voidRun.isPending}
                              className="px-3 py-1.5 rounded-md border text-sm text-red-500 hover:bg-red-500/5 disabled:opacity-50"
                              style={{ borderColor: 'hsl(var(--border))' }}>
                              {tr('Void', '作廢', '作废')}
                            </button>
                          )}
                          {actionErr && <p className="text-xs text-red-500">{actionErr}</p>}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">{tr('No items in this run.', '此運行無項目。', '此运行无项目。')}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {runList.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            {tr('No runs yet. Pick a month above to preview and create one.', '尚未有運行。選擇月份以預覽並建立。', '尚无运行。选择月份以预览并创建。')}
          </div>
        )}
      </div>

      <EmployeeFormPanel open={panelOpen} initial={editing} onClose={() => { setPanelOpen(false); setEmpErr(null); }} />
    </div>
  );
}
