import { tr } from '../lib/i18nHelpers';

interface PnlData {
  revenue: number;
  cost: number;
  gross_profit: number;
  expenses: number;
  net_income: number;
}

interface PnlFormulaBannerProps {
  data: PnlData;
}

function Term({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-3 rounded-lg bg-background border">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-lg font-mono font-semibold ${value < 0 ? 'text-red-600' : color}`}>
        {(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
    </div>
  );
}

function FormulaRow({ left, op, right, resultLabel, resultValue, color }: {
  left: { label: string; value: number };
  op: string;
  right: { label: string; value: number };
  resultLabel: string;
  resultValue: number;
  color: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Term label={left.label} value={left.value} color={color} />
      <span className="text-2xl font-bold text-muted-foreground">{op}</span>
      <Term label={right.label} value={right.value} color={color} />
      <span className="text-2xl font-bold text-muted-foreground">=</span>
      <div className="flex flex-col items-center px-4 py-3 rounded-lg bg-background border border-primary/30">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{resultLabel}</span>
        <span className={`text-lg font-mono font-bold ${resultValue < 0 ? 'text-red-600' : color}`}>
          {(resultValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      </div>
    </div>
  );
}

export default function PnlFormulaBanner({ data }: PnlFormulaBannerProps) {
  return (
    <div className="space-y-3 p-4 bg-card border rounded-xl">
      <p className="text-sm font-medium text-muted-foreground">
        {tr('Formula', '公式', '公式')}
      </p>
      <FormulaRow
        left={{ label: tr('Revenue', '收入', '收入'), value: data.revenue }}
        op="-"
        right={{ label: tr('Cost', '直接成本', '直接成本'), value: data.cost }}
        resultLabel={tr('Gross Profit', '毛利', '毛利')}
        resultValue={data.gross_profit}
        color="text-orange-600"
      />
      <FormulaRow
        left={{ label: tr('Gross Profit', '毛利', '毛利'), value: data.gross_profit }}
        op="-"
        right={{ label: tr('Expenses', '支出', '支出'), value: data.expenses }}
        resultLabel={tr('Net Profit', '淨利', '淨利')}
        resultValue={data.net_income}
        color="text-green-600"
      />
    </div>
  );
}