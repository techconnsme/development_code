import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { UserPlus, ArrowLeft, Copy, Check, AlertCircle, ExternalLink } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import CoaPreview, { type CoaMode, type CoaAccount } from '../components/CoaPreview';

export default function NewClient() {
  const nav = useNavigate();
  const { switchClient, refreshClients } = useAuth();
  const [form, setForm] = useState({
    company_name: '',
    contact_email: '',
    contact_name: '',
    initial_password: '',
    industry: '',
    fy_start: '04',
    fy_end: '03',
  });
  const [result, setResult] = useState<{ user_id: string; email: string; password: string; clientId: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [coaMode, setCoaMode] = useState<CoaMode>('manual');
  const [customAccounts, setCustomAccounts] = useState<CoaAccount[]>([]);
  const [removedCodes, setRemovedCodes] = useState<Set<string>>(new Set());

  // Default COA mode: Industry when an industry classification is selected, Manual otherwise
  useEffect(() => {
    if (form.industry) {
      setCoaMode('industry');
    } else {
      setCoaMode('manual');
    }
  }, [form.industry]);

  const createMut = useMutation({
    mutationFn: () => api('/firms/my/clients', {
      method: 'POST',
      body: {
        company_name: form.company_name,
        email: form.contact_email,
        contact_name: form.contact_name || undefined,
        initial_password: form.initial_password || undefined,
        industry: form.industry || undefined,
        fy_start: form.fy_start || undefined,
        fy_end: form.fy_end || undefined,
        coa_mode: coaMode,
        coa_industry: form.industry || 'professional',
        custom_accounts: customAccounts,
        removed_codes: [...removedCodes],
      },
    }) as Promise<{ user_id: string; client_user_id?: string; id: string; password?: string; success: boolean }>,
    onSuccess: (res: any) => {
      setResult({
        user_id: res.user_id || res.client_user_id,
        email: form.contact_email,
        password: res.password || form.initial_password,
        clientId: res.id,
      });
      refreshClients(); // Refresh dropdown immediately
    },
    onError: (err: any) => {
      alert(`Could not create client: ${err?.error || err?.message || 'unknown error'}`);
    },
  });

  const generatePassword = () => {
    const words = ['sunny', 'happy', 'lucky', 'smart', 'quick', 'bright', 'clear', 'gentle'];
    const w = words[Math.floor(Math.random() * words.length)];
    const digits = Math.floor(1000 + Math.random() * 9000);
    setForm(f => ({ ...f, initial_password: `${w}-${digits}` }));
  };

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const canSubmit = form.company_name.trim() && form.contact_email.trim() &&
                    form.initial_password.length >= 6 && !createMut.isPending;

  if (result) {
    return (
      <div className="p-6 w-[95%] mx-auto space-y-4">
        <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-950 p-6">
          <h1 className="text-lg font-bold text-green-900 dark:text-green-100 mb-3 flex items-center gap-2">
            ✓ {tr('Client created successfully', '客戶建立成功', '客户建立成功')}
          </h1>
          <p className="text-sm text-green-800 dark:text-green-200 mb-4">
            {tr("Share these credentials with your client. The chart of accounts (HK) has been seeded.", "將這些憑證分享給您的客戶。會計科目表(HK)已建立。", "将这些凭证分享给您的客户。会计科目表(HK)已建立。")}
          </p>
          <div className="bg-white dark:bg-green-950/40 rounded border border-green-200 p-3 space-y-2 font-mono text-sm">
            <CredentialRow label={tr('Company', '公司', '公司')} value={form.company_name} copied={copied === 'Company'} onCopy={() => copy('Company', form.company_name)} />
            <CredentialRow label={tr('Login Email', '登入電郵', '登入电邮')} value={result.email} copied={copied === 'Login Email'} onCopy={() => copy('Login Email', result.email)} />
            <CredentialRow label={tr('Password', '密碼', '密码')} value={result.password} copied={copied === 'Password'} onCopy={() => copy('Password', result.password)} />
            <CredentialRow label={tr('Industry', '行業', '行业')} value={form.industry || 'general'} copied={false} onCopy={() => {}} />
            <CredentialRow label={tr('Financial Year', '會計年度', '会计年度')} value={`${new Date(2024, parseInt(form.fy_start)-1).toLocaleString('default', { month: 'long' })} → ${new Date(2024, parseInt(form.fy_end)-1).toLocaleString('default', { month: 'long' })}`} copied={false} onCopy={() => {}} />
          </div>
          <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{tr('Store this password safely. Advise the client to change it after first login.', '請安全保存此密碼。建議客戶在首次登入後更改。', '请安全保存此密码。建议客户在首次登入后更改。')}</span>
          </div>
          <div className="mt-4 flex gap-2 flex-wrap">
            <button onClick={() => { switchClient(result.clientId); nav('/'); }}
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium flex items-center gap-1">
              <ExternalLink className="h-4 w-4" />
              {tr('View Client Dashboard', '查看客戶儀表板', '查看客户仪表板')}
            </button>
            <button onClick={() => { setResult(null); setForm({ company_name: '', contact_email: '', contact_name: '', initial_password: '', industry: '', fy_start: '04', fy_end: '03' }); }}
              className="px-4 py-2 border rounded text-sm">
              {tr('Add another client', '新增其他客戶', '新增其他客户')}
            </button>
            <button onClick={() => nav('/')} className="px-4 py-2 border rounded text-sm">
              {tr('Back to Dashboard', '返回儀表板', '返回仪表板')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 w-[95%] mx-auto space-y-4">
      <Link to="/" className="text-sm text-muted-foreground hover:underline flex items-center gap-1">
        <ArrowLeft className="h-4 w-4" /> {tr('Back to Dashboard', '返回儀表板', '返回仪表板')}
      </Link>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <UserPlus className="h-6 w-6" /> {tr('New Client Company', '新增客戶公司', '新增客户公司')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tr("Create a new client tenant with industry-specific COA and financial year setup.", "建立新客戶租戶，配置行業特定會計科目表及會計年度。", "建立新客户租户，配置行业特定会计科目表及会计年度。")}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        {/* Company name */}
        <div>
          <label className="text-xs font-medium text-muted-foreground">{tr('Company name', '公司名稱', '公司名称')} *</label>
          <input value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))}
            placeholder={tr('e.g. Acme Trading Limited', '例如：Acme Trading Limited', '例如：Acme Trading Limited')}
            className="mt-1 block w-full px-3 py-2 border rounded" />
        </div>

        {/* Contact + Email grid */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">{tr('Contact name', '聯絡人', '联络人')}</label>
            <input value={form.contact_name} onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))}
              placeholder={tr('e.g. John Chan', '例如：陳先生', '例如：陈先生')}
              className="mt-1 block w-full px-3 py-2 border rounded" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{tr('Login email', '登入電郵', '登入电邮')} *</label>
            <input type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))}
              placeholder="acme@example.com" className="mt-1 block w-full px-3 py-2 border rounded" />
          </div>
        </div>

        {/* Password + Generate */}
        <div>
          <label className="text-xs font-medium text-muted-foreground">{tr('Initial password', '初始密碼', '初始密码')} * ({tr('at least 6 characters', '至少6個字符', '至少6个字符')})</label>
          <div className="flex gap-2 mt-1">
            <input type="text" value={form.initial_password} onChange={e => setForm(f => ({ ...f, initial_password: e.target.value }))}
              placeholder={tr('Type or generate', '輸入或生成', '输入或生成')}
              className="flex-1 px-3 py-2 border rounded" />
            <button type="button" onClick={generatePassword} className="px-3 py-2 border rounded text-sm">
              {tr('Generate', '生成', '生成')}
            </button>
          </div>
        </div>

        {/* Industry */}
        <div>
          <label className="text-xs font-medium text-muted-foreground">{tr('Industry Classification', '行業分類', '行业分类')}</label>
          <select value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}
            className="mt-1 block w-full px-3 py-2 border rounded bg-background text-sm">
            <option value="">{tr('— Select industry —', '— 選擇行業 —', '— 选择行业 —')}</option>
            <option value="professional">{tr('Professional & Business Services', '專業及商業服務', '专业及商业服务')}</option>
            <option value="finance">{tr('Financial Services', '金融服務', '金融服务')}</option>
            <option value="trading">{tr('Trading & Logistics', '貿易及物流', '贸易及物流')}</option>
            <option value="tourism">{tr('Tourism', '旅遊', '旅游')}</option>
            <option value="it">{tr('Innovation & Technology', '創新及科技', '创新及科技')}</option>
            <option value="fintech">{tr('Fintech', '金融科技', '金融科技')}</option>
            <option value="medical">{tr('Medical & Healthcare', '醫療及保健', '医疗及保健')}</option>
            <option value="education">{tr('Education', '教育', '教育')}</option>
            <option value="construction">{tr('Construction & Real Estate', '建築及地產', '建筑及地产')}</option>
            <option value="ict">{tr('ICT & Telecommunications', '資訊及通訊科技', '资讯及通讯科技')}</option>
            <option value="manufacturing">{tr('Manufacturing', '製造業', '制造业')}</option>
          </select>
        </div>

        {/* FY month-only — the fiscal cycle repeats every year */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">{tr('FY Start Month', '會計年度起始月', '会计年度起始月')}</label>
            <select value={form.fy_start} onChange={e => setForm(f => ({ ...f, fy_start: e.target.value }))}
              className="mt-1 block w-full px-3 py-2 border rounded text-sm bg-background">
              {['01','02','03','04','05','06','07','08','09','10','11','12'].map(m => (
                <option key={m} value={m}>{new Date(2024, parseInt(m)-1).toLocaleString('default', { month: 'long' })}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">{tr('FY End Month', '會計年度結束月', '会计年度结束月')}</label>
            <select value={form.fy_end} onChange={e => setForm(f => ({ ...f, fy_end: e.target.value }))}
              className="mt-1 block w-full px-3 py-2 border rounded text-sm bg-background">
              {['01','02','03','04','05','06','07','08','09','10','11','12'].map(m => (
                <option key={m} value={m}>{new Date(2024, parseInt(m)-1).toLocaleString('default', { month: 'long' })}</option>
              ))}
            </select>
          </div>
        </div>

        {/* COA Review */}
        <CoaPreview
          industry={form.industry}
          mode={coaMode}
          onModeChange={setCoaMode}
          customAccounts={customAccounts}
          onCustomAccountsChange={setCustomAccounts}
          removedCodes={removedCodes}
          onRemovedCodesChange={setRemovedCodes}
        />

        <div className="pt-2 flex justify-end gap-2">
          <button onClick={() => nav('/')} className="px-4 py-2 border rounded text-sm">
            {tr('Cancel', '取消', '取消')}
          </button>
          <button onClick={() => createMut.mutate()} disabled={!canSubmit}
            className="px-6 py-2 bg-primary text-primary-foreground rounded font-medium hover:bg-primary/90 disabled:opacity-50">
            {createMut.isPending ? tr('Creating…', '建立中…', '建立中…') : tr('Create Client', '建立客戶', '建立客户')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialRow({ label, value, copied, onCopy }: {
  label: string; value: string; copied: boolean; onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{label}:</div>
      <div className="flex items-center gap-2">
        <div className="font-mono">{value}</div>
        <button onClick={onCopy} className="text-xs px-2 py-1 border rounded hover:bg-muted flex items-center gap-1" title="Copy">
          {copied ? <><Check className="h-3 w-3 text-green-600" /> {tr('Copied', '已複製', '已复制')}</> : <><Copy className="h-3 w-3" /> {tr('Copy', '複製', '复制')}</>}
        </button>
      </div>
    </div>
  );
}
