import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Plus, Trash2, Calculator } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

export default function FixedAssets() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    asset_name: '', asset_code: '', category: 'office_equipment', purchase_date: '', cost: '',
    useful_life_years: '5', salvage_value: '0',
    account_code: '12201', depn_account_code: '66101', acc_depn_account_code: '12301', notes: '',
    depreciation_method: 'straight_line',
    custom_schedule: { period_type: 'yearly' as 'monthly' | 'yearly', lines: [] as Array<{period: number, rate: number | null, amount: number | null}> },
  });

  const { data, isLoading } = useQuery({
    queryKey: ['fixed-assets'],
    queryFn: () => api('/fixed-assets'),
  });
  const assets: any[] = data?.data || [];

  const createMut = useMutation({
    mutationFn: (body: any) => api('/fixed-assets', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['fixed-assets'] }); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/fixed-assets/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fixed-assets'] }),
  });

  const depnMut = useMutation({
    mutationFn: (period_end_date: string) => api('/fixed-assets/run-depreciation', { method: 'POST', body: { period_end_date } }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['fixed-assets'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      toast.info(`折舊完成！\n資產：${data.assets_depreciated} 項\n總折舊：HKD ${data.total_depreciation?.toLocaleString()}`);
    },
  });

  const totalCost = assets.reduce((s: number, a: any) => s + (a.cost || 0), 0);
  const totalAccDepn = assets.reduce((s: number, a: any) => s + (a.accumulated_depreciation || 0), 0);
  const totalNBV = assets.reduce((s: number, a: any) => s + (a.net_book_value || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr('Fixed Assets', '固定資產 Fixed Assets', '固定资产 Fixed Assets')}</h2>
          <p className="text-muted-foreground mt-1">{tr('Fixed Asset Register & Depreciation Management', '固定資產登記冊及折舊管理', '固定资产登记册及折旧管理')}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => {
            const date = prompt('折舊計算至 (YYYY-MM-DD)：', new Date().toISOString().split('T')[0]);
            if (!date) return;
            depnMut.mutate(date);
          }} disabled={depnMut.isPending}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-40">
            <Calculator className="h-4 w-4" /> {tr('Run Depreciation', '計算折舊 Run Depreciation', '计算折旧 Run Depreciation')}
          </button>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
            <Plus className="h-4 w-4" /> {tr('Add Asset', '新增資產', '新增资产')}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border rounded-xl p-4">
          <span className="text-xs text-muted-foreground">{tr('Total Cost', '資產原值 Total Cost', '资产原值 Total Cost')}</span>
          <p className="text-xl font-bold mt-1">HKD {totalCost.toLocaleString()}</p>
        </div>
        <div className="bg-card border rounded-xl p-4">
          <span className="text-xs text-muted-foreground">{tr('Accum. Depreciation', '累計折舊 Accum. Depreciation', '累计折旧 Accum. Depreciation')}</span>
          <p className="text-xl font-bold mt-1 text-red-600">HKD {totalAccDepn.toLocaleString()}</p>
        </div>
        <div className="bg-card border rounded-xl p-4">
          <span className="text-xs text-muted-foreground">{tr('Net Book Value', '賬面淨值 Net Book Value', '账面净值 Net Book Value')}</span>
          <p className="text-xl font-bold mt-1 text-green-600">HKD {totalNBV.toLocaleString()}</p>
        </div>
      </div>

      {/* Asset list */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3">{tr('Asset Name', '資產名稱', '资产名称')}</th>
              <th className="text-left p-3">{tr('Category', '類別', '类别')}</th>
              <th className="text-left p-3">{tr('Purchase Date', '購買日', '购买日')}</th>
              <th className="text-right p-3">{tr('Cost', '成本', '成本')}</th>
              <th className="text-right p-3">{tr('Life (yrs)', '年限', '年限')}</th>
              <th className="text-right p-3">{tr('Monthly Depn', '月折舊', '月折旧')}</th>
              <th className="text-right p-3">{tr('Accum. Depn', '累計折舊', '累计折旧')}</th>
              <th className="text-right p-3">{tr('NBV', '淨值 NBV', '净值 NBV')}</th>
              <th className="text-center p-3 w-[60px]">{tr('Actions', '操作', '操作')}</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a: any) => (
              <tr key={a.id} className={`border-b hover:bg-muted/30 ${!a.is_active ? 'opacity-50 line-through' : ''}`}>
                <td className="p-3 font-medium">{a.asset_name}</td>
                <td className="p-3 text-xs">{a.category}</td>
                <td className="p-3 text-muted-foreground">{a.purchase_date}</td>
                <td className="p-3 text-right font-mono">{a.cost?.toLocaleString()}</td>
                <td className="p-3 text-center">{a.useful_life_years} {tr('yr', '年', '年')}</td>
                <td className="p-3 text-right font-mono">{a.monthly_depreciation?.toLocaleString()}</td>
                <td className="p-3 text-right font-mono text-red-600">{a.accumulated_depreciation?.toLocaleString()}</td>
                <td className="p-3 text-right font-mono font-medium">{a.net_book_value?.toLocaleString()}</td>
                <td className="p-3 text-center">
                  <button onClick={() => { if (confirm(tr('Delete this asset?', '刪除此資產？', '删除此资产？'))) deleteMut.mutate(a.id); }}
                    className="text-destructive hover:underline text-xs"><Trash2 className="h-3 w-3" /></button>
                </td>
              </tr>
            ))}
            {assets.length === 0 && (
              <tr><td colSpan={9} className="text-center p-6 text-muted-foreground">{tr('No fixed asset records', '未有固定資產記錄', '未有固定资产记录')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add asset form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-4">{tr('Add Fixed Asset', '新增固定資產', '新增固定资产')}</h3>
            <form onSubmit={e => { e.preventDefault(); createMut.mutate(form); }} className="space-y-4">
              {/* Basic Information */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-muted-foreground border-b pb-1">
                  {tr('Basic Information', '基本資料', '基本资料')}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1">
                      {tr('Asset Name', '資產名稱', '资产名称')} <span className="text-destructive">*</span>
                    </label>
                    <input required value={form.asset_name} onChange={e => setForm({...form, asset_name: e.target.value})}
                      placeholder={tr('e.g. MacBook Pro 16"', '例如 MacBook Pro 16"', '例如 MacBook Pro 16"')}
                      className="w-full px-3 py-2 border rounded-md text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tr('Asset Code', '資產編號', '资产编号')}
                    </label>
                    <input value={form.asset_code} onChange={e => setForm({...form, asset_code: e.target.value})}
                      placeholder={tr('Optional code', '可選編號', '可选编号')}
                      className="w-full px-3 py-2 border rounded-md text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tr('Category', '類別', '类别')}
                    </label>
                    <select value={form.category} onChange={e => setForm({...form, category: e.target.value})}
                      className="w-full px-3 py-2 border rounded-md text-sm bg-background">
                      <option value="office_equipment">{tr('Office Equipment', '辦公設備', '办公设备')}</option>
                      <option value="computer">{tr('Computer', '電腦設備', '电脑设备')}</option>
                      <option value="vehicle">{tr('Vehicle', '汽車', '汽车')}</option>
                      <option value="furniture">{tr('Furniture', '家具', '家具')}</option>
                      <option value="leasehold">{tr('Leasehold Improvement', '裝修', '装修')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tr('Purchase Date', '購買日期', '购买日期')} <span className="text-destructive">*</span>
                    </label>
                    <input type="date" required value={form.purchase_date} onChange={e => setForm({...form, purchase_date: e.target.value})}
                      className="w-full px-3 py-2 border rounded-md text-sm" />
                  </div>
                </div>
              </div>

              {/* Depreciation Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-muted-foreground border-b pb-1">
                  {tr('Depreciation Details', '折舊詳情', '折旧详情')}
                </h4>

                {/* Tabs */}
                <div className="flex gap-1 border rounded-lg p-1 bg-muted">
                  <button
                    type="button"
                    onClick={() => setForm({...form, depreciation_method: 'straight_line'})}
                    className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      form.depreciation_method === 'straight_line'
                        ? 'bg-background shadow-sm font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tr('Constant', '平率折舊', '平率折旧')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({...form, depreciation_method: 'custom'})}
                    className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      form.depreciation_method === 'custom'
                        ? 'bg-background shadow-sm font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {tr('Custom', '自訂折舊', '自订折旧')}
                  </button>
                </div>

                {/* Constant tab content */}
                {form.depreciation_method === 'straight_line' && (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {tr('Cost (HKD)', '成本 (HKD)', '成本 (HKD)')} <span className="text-destructive">*</span>
                      </label>
                      <input type="number" step="0.01" required value={form.cost} onChange={e => setForm({...form, cost: e.target.value})}
                        placeholder="0.00"
                        className="w-full px-3 py-2 border rounded-md text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {tr('Useful Life (years)', '使用年限 (年)', '使用年限 (年)')}
                      </label>
                      <input type="number" step="0.1" value={form.useful_life_years} onChange={e => setForm({...form, useful_life_years: e.target.value})}
                        className="w-full px-3 py-2 border rounded-md text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        {tr('Salvage Value', '殘值', '残值')}
                      </label>
                      <input type="number" step="0.01" value={form.salvage_value} onChange={e => setForm({...form, salvage_value: e.target.value})}
                        placeholder="0.00"
                        className="w-full px-3 py-2 border rounded-md text-sm" />
                    </div>
                  </div>
                )}

                {/* Custom tab content */}
                {form.depreciation_method === 'custom' && (
                  <CustomScheduleEditor
                    schedule={form.custom_schedule}
                    cost={Number(form.cost) || 0}
                    onChange={(schedule) => setForm({...form, custom_schedule: schedule})}
                  />
                )}

                {/* Formula explanation (only for constant) */}
                {form.depreciation_method === 'straight_line' && (
                  <p className="text-xs text-muted-foreground">
                    {tr('Monthly depreciation will be calculated as (Cost - Salvage Value) ÷ (Useful Life × 12)', 
                        '月折舊將按 (成本 - 殘值) ÷ (使用年限 × 12) 計算',
                        '月折旧将按 (成本 - 残值) ÷ (使用年限 × 12) 计算')}
                  </p>
                )}
              </div>

              {/* Notes */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium text-muted-foreground border-b pb-1">
                  {tr('Notes', '備註', '备注')}
                </h4>
                <textarea value={form.notes} onChange={e => setForm({...form, notes: e.target.value})}
                  placeholder={tr('Additional notes (optional)', '額外備註 (可選)', '额外备注 (可选)')}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-md text-sm resize-none" />
              </div>

              <div className="flex gap-3 justify-end pt-2 border-t">
                <button type="button" onClick={() => setShowForm(false)} 
                  className="px-4 py-2 border rounded-md text-sm hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
                <button type="submit" disabled={createMut.isPending}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-40">
                  {tr('Create', '建立', '建立')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

type CustomSchedule = { period_type: 'monthly' | 'yearly'; lines: Array<{period: number, rate: number | null, amount: number | null}> };

function CustomScheduleEditor({
  schedule,
  cost,
  onChange,
}: {
  schedule: CustomSchedule;
  cost: number;
  onChange: (schedule: CustomSchedule) => void;
}) {
  const addLine = () => {
    const nextPeriod = schedule.lines.length + 1;
    onChange({
      ...schedule,
      lines: [...schedule.lines, { period: nextPeriod, rate: null, amount: null }],
    });
  };

  const removeLine = (period: number) => {
    const newLines = schedule.lines
      .filter(l => l.period !== period)
      .map((l, i) => ({ ...l, period: i + 1 }));
    onChange({ ...schedule, lines: newLines });
  };

  const updateLine = (period: number, field: 'rate' | 'amount', value: number | null) => {
    const newLines = schedule.lines.map(l => {
      if (l.period !== period) return l;
      if (field === 'rate') {
        const amount = value !== null ? Math.round(cost * value / 100 * 100) / 100 : null;
        return { ...l, rate: value, amount: l.amount !== null ? amount : null };
      } else {
        const rate = value !== null && cost > 0 ? Math.round(value / cost * 100 * 100) / 100 : null;
        return { ...l, amount: value, rate: l.rate !== null ? rate : null };
      }
    });
    onChange({ ...schedule, lines: newLines });
  };

  return (
    <div className="space-y-3">
      {/* Period type selector */}
      <div className="flex gap-2 items-center">
        <label className="text-sm font-medium">{tr('Period:', '期間:', '期间:')}</label>
        <select
          value={schedule.period_type}
          onChange={e => onChange({...schedule, period_type: e.target.value as 'monthly' | 'yearly'})}
          className="px-2 py-1 border rounded text-sm bg-background"
        >
          <option value="yearly">{tr('Yearly', '每年', '每年')}</option>
          <option value="monthly">{tr('Monthly', '每月', '每月')}</option>
        </select>
      </div>

      {/* Schedule table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="px-3 py-2 text-left">{tr('Period', '期間', '期间')}</th>
              <th className="px-3 py-2 text-left">{tr('Rate (%)', '比率 (%)', '比率 (%)')}</th>
              <th className="px-3 py-2 text-left">{tr('Amount (HKD)', '金額 (HKD)', '金额 (HKD)')}</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {schedule.lines.map((line) => (
              <tr key={line.period} className="border-t">
                <td className="px-3 py-2">
                  {schedule.period_type === 'yearly'
                    ? tr(`Year ${line.period}`, `第 ${line.period} 年`, `第 ${line.period} 年`)
                    : tr(`Month ${line.period}`, `第 ${line.period} 月`, `第 ${line.period} 月`)}
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={line.rate ?? ''}
                    onChange={e => updateLine(line.period, 'rate', e.target.value ? Number(e.target.value) : null)}
                    placeholder="0.00"
                    className="w-20 px-2 py-1 border rounded text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.amount ?? ''}
                    onChange={e => updateLine(line.period, 'amount', e.target.value ? Number(e.target.value) : null)}
                    placeholder="0.00"
                    className="w-24 px-2 py-1 border rounded text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeLine(line.period)}
                    className="text-destructive hover:text-destructive/80 p-1"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addLine}
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <Plus className="h-3 w-3" />
        {tr('Add Period', '新增期間', '新增期间')}
      </button>

      {cost > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr(
            'Enter a rate (%) to auto-calculate amount, or enter a fixed amount (HKD).',
            '輸入比率 (%) 自動計算金額，或輸入固定金額 (HKD)。',
            '输入比率 (%) 自动计算金额，或输入固定金额 (HKD)。'
          )}
        </p>
      )}
    </div>
  );
}
