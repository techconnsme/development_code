import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import DemoPayroll from './payroll/DemoPayroll';
import RealPayroll from './payroll/RealPayroll';

type PayrollMode = 'demo' | 'real';
const MODE_KEY = 'payroll.mode';

export default function Payroll() {
  useTranslation(); // keeps tr() reactive on language change
  const [mode, setMode] = useState<PayrollMode>(() =>
    localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo');
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">{tr('Payroll', '薪資', '薪资')}</h2>
          <p className="text-muted-foreground mt-1">
            {mode === 'demo'
              ? tr('Sample payroll for demonstration.', '薪資演示樣本。', '薪资演示样本。')
              : tr('Manage employees and monthly payroll runs.', '管理員工與每月薪酬運行。', '管理员工与每月薪酬运行。')}
          </p>
        </div>
        {mode === 'demo' && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            {tr('Demo data', '演示數據', '演示数据')}
          </span>
        )}
        <div className="ml-auto flex rounded-full border p-0.5 text-xs font-medium" style={{ borderColor: 'hsl(var(--border))' }}>
          {([['demo', 'Demo data', '演示數據', '演示数据'], ['real', 'Real data', '實際資料', '实际资料']] as const).map(([m, en, zhHant, zhHans]) => (
            <button key={m} onClick={() => setMode(m)}
              aria-label={`${en} mode`}
              className={cn('px-3 py-1 rounded-full transition-colors',
                mode === m ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {tr(en, zhHant, zhHans)}
            </button>
          ))}
        </div>
      </div>

      {mode === 'demo' ? <DemoPayroll /> : <RealPayroll />}
    </div>
  );
}
