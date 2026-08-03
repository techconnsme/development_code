import React, { useState, useEffect, useMemo } from 'react';
import { tr } from '../lib/i18nHelpers';
import {
  Search, Plus, ChevronDown, ChevronRight, BookOpen,
  RefreshCw, GripVertical, EyeOff,
} from 'lucide-react';

// ── Constants (mirrors ChartOfAccounts.tsx) ──

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

const TYPE_LABELS: Record<string, string> = {
  asset: tr('Assets', '資產', '资产'),
  liability: tr('Liabilities', '負債', '负债'),
  equity: tr('Equity', '權益', '权益'),
  revenue: tr('Revenue', '收入', '收入'),
  expense: tr('Expenses', '支出', '支出'),
};

const TYPE_COLORS: Record<string, string> = {
  asset: 'bg-blue-50 text-black font-bold dark:bg-blue-900/30 dark:text-white',
  liability: 'bg-red-50 text-black font-bold dark:bg-red-900/30 dark:text-white',
  equity: 'bg-purple-50 text-black font-bold dark:bg-purple-900/30 dark:text-white',
  revenue: 'bg-green-50 text-black font-bold dark:bg-green-900/30 dark:text-white',
  expense: 'bg-amber-50 text-black font-bold dark:bg-amber-900/30 dark:text-white',
};

// ── Utilities ──

function isParentCode(code: string): boolean {
  return /00$/.test(code || '');
}

function formatBalance(v: number | null | undefined, forceZero = false): string {
  if (v == null) return '—';
  if (v === 0 && !forceZero) return '—';
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${formatted})` : formatted;
}

interface FiscalYearOption {
  label: string;
  startDate: string;
  endDate: string;
}

function buildFiscalYearOptions(fiscalStartMD: string, fiscalEndMD: string): FiscalYearOption[] {
  const [sm, sd] = fiscalStartMD.split('-').map(Number);
  const [em, ed] = fiscalEndMD.split('-').map(Number);
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  let baseYear = now.getFullYear();
  if (currentMonth < sm) baseYear--;

  const opts: FiscalYearOption[] = [];
  for (let i = 5; i >= -1; i--) {
    const sy = baseYear - i;
    const ey = em <= sm ? sy + 1 : sy;
    const sD = `${sy}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
    const eD = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
    opts.push({
      label: `${sy}-${sy + 1} (Apr ${sy} - Mar ${sy + 1})`,
      startDate: sD,
      endDate: eD,
    });
  }
  return opts;
}

// ── Account interface ──

interface CoaAccount {
  account_code: string;
  account_name: string;
  account_type: string;
  parent_code: string | null;
  opening_balance: number;
  is_active: number;
}

// ── Static HK 5-digit COA Template (from coa-hk.sql) ──

const COA_TEMPLATE: CoaAccount[] = [
  // ═══ 10000 資產 ASSETS ═══
  { account_code: '10000', account_name: '資產 Assets', account_type: 'asset', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '11000', account_name: '流動資產 Current Assets', account_type: 'asset', parent_code: '10000', opening_balance: 0, is_active: 1 },
  { account_code: '11100', account_name: '現金及銀行存款 Cash & Bank', account_type: 'asset', parent_code: '11000', opening_balance: 0, is_active: 1 },
  { account_code: '11101', account_name: '庫存現金 Cash on Hand', account_type: 'asset', parent_code: '11100', opening_balance: 0, is_active: 1 },
  { account_code: '11102', account_name: '匯豐銀行 HSBC', account_type: 'asset', parent_code: '11100', opening_balance: 0, is_active: 1 },
  { account_code: '11103', account_name: '其他銀行 Other Bank', account_type: 'asset', parent_code: '11100', opening_balance: 0, is_active: 1 },
  { account_code: '11200', account_name: '應收賬款及票據 AR & Notes', account_type: 'asset', parent_code: '11000', opening_balance: 0, is_active: 1 },
  { account_code: '11201', account_name: '應收賬款 Trade Debtors', account_type: 'asset', parent_code: '11200', opening_balance: 0, is_active: 1 },
  { account_code: '11300', account_name: '其他應收款 Other Receivables', account_type: 'asset', parent_code: '11000', opening_balance: 0, is_active: 1 },
  { account_code: '11301', account_name: '應收董事款項 Director Loan to Co', account_type: 'asset', parent_code: '11300', opening_balance: 0, is_active: 1 },
  { account_code: '11302', account_name: '暫付款 Sundry Debtors', account_type: 'asset', parent_code: '11300', opening_balance: 0, is_active: 1 },
  { account_code: '11400', account_name: '預付及按金 Prepayments & Deposits', account_type: 'asset', parent_code: '11000', opening_balance: 0, is_active: 1 },
  { account_code: '11401', account_name: '預付費用 Prepayments', account_type: 'asset', parent_code: '11400', opening_balance: 0, is_active: 1 },
  { account_code: '11402', account_name: '租金按金 Rental Deposit', account_type: 'asset', parent_code: '11400', opening_balance: 0, is_active: 1 },
  { account_code: '11403', account_name: '其他按金 Other Deposits', account_type: 'asset', parent_code: '11400', opening_balance: 0, is_active: 1 },
  { account_code: '12000', account_name: '固定資產 Fixed Assets', account_type: 'asset', parent_code: '10000', opening_balance: 0, is_active: 1 },
  { account_code: '12100', account_name: '物業房產 Property', account_type: 'asset', parent_code: '12000', opening_balance: 0, is_active: 1 },
  { account_code: '12200', account_name: '設備及器材 Equipment', account_type: 'asset', parent_code: '12000', opening_balance: 0, is_active: 1 },
  { account_code: '12201', account_name: '辦公設備 Office Equipment', account_type: 'asset', parent_code: '12200', opening_balance: 0, is_active: 1 },
  { account_code: '12202', account_name: '電腦設備 Computer Equipment', account_type: 'asset', parent_code: '12200', opening_balance: 0, is_active: 1 },
  { account_code: '12203', account_name: '汽車 Vehicles', account_type: 'asset', parent_code: '12200', opening_balance: 0, is_active: 1 },
  { account_code: '12300', account_name: '累計折舊 Accumulated Depreciation', account_type: 'asset', parent_code: '12000', opening_balance: 0, is_active: 1 },
  { account_code: '12301', account_name: '累計折舊-設備 Accumulated Depn-Equip', account_type: 'asset', parent_code: '12300', opening_balance: 0, is_active: 1 },
  { account_code: '12302', account_name: '累計折舊-電腦 Accumulated Depn-Computer', account_type: 'asset', parent_code: '12300', opening_balance: 0, is_active: 1 },

  // ═══ 20000 負債 LIABILITIES ═══
  { account_code: '20000', account_name: '負債 Liabilities', account_type: 'liability', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '21000', account_name: '流動負債 Current Liabilities', account_type: 'liability', parent_code: '20000', opening_balance: 0, is_active: 1 },
  { account_code: '21100', account_name: '應付賬款及票據 AP & Notes', account_type: 'liability', parent_code: '21000', opening_balance: 0, is_active: 1 },
  { account_code: '21101', account_name: '應付賬款 Trade Creditors', account_type: 'liability', parent_code: '21100', opening_balance: 0, is_active: 1 },
  { account_code: '21200', account_name: '其他應付款 Other Payables', account_type: 'liability', parent_code: '21000', opening_balance: 0, is_active: 1 },
  { account_code: '21201', account_name: '應付董事款項 Director Loan from Dir', account_type: 'liability', parent_code: '21200', opening_balance: 0, is_active: 1 },
  { account_code: '21202', account_name: '暫收款 Sundry Creditors', account_type: 'liability', parent_code: '21200', opening_balance: 0, is_active: 1 },
  { account_code: '21203', account_name: '應付薪金 Salary Payable', account_type: 'liability', parent_code: '21200', opening_balance: 0, is_active: 1 },
  { account_code: '21204', account_name: '應付強積金 MPF Payable', account_type: 'liability', parent_code: '21200', opening_balance: 0, is_active: 1 },
  { account_code: '21300', account_name: '應付稅項 Tax Payable', account_type: 'liability', parent_code: '21000', opening_balance: 0, is_active: 1 },
  { account_code: '21301', account_name: '應付利得稅 Profits Tax Payable', account_type: 'liability', parent_code: '21300', opening_balance: 0, is_active: 1 },
  { account_code: '21400', account_name: '預收及應計 Accruals & Deferred', account_type: 'liability', parent_code: '21000', opening_balance: 0, is_active: 1 },
  { account_code: '21401', account_name: '預收收入 Deferred Revenue', account_type: 'liability', parent_code: '21400', opening_balance: 0, is_active: 1 },
  { account_code: '21402', account_name: '應計費用 Accrued Expenses', account_type: 'liability', parent_code: '21400', opening_balance: 0, is_active: 1 },
  { account_code: '22000', account_name: '長期負債 Long-term Liabilities', account_type: 'liability', parent_code: '20000', opening_balance: 0, is_active: 1 },

  // ═══ 30000 資本 EQUITY ═══
  { account_code: '30000', account_name: '資本及儲備 Equity & Reserves', account_type: 'equity', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '31000', account_name: '股本及往來 Share Capital & Current', account_type: 'equity', parent_code: '30000', opening_balance: 0, is_active: 1 },
  { account_code: '31100', account_name: '股本 Share Capital', account_type: 'equity', parent_code: '31000', opening_balance: 0, is_active: 1 },
  { account_code: '31101', account_name: '普通股本 Ordinary Shares', account_type: 'equity', parent_code: '31100', opening_balance: 0, is_active: 1 },
  { account_code: '31200', account_name: '董事往來 Director Current Account', account_type: 'equity', parent_code: '31000', opening_balance: 0, is_active: 1 },
  { account_code: '31201', account_name: '董事往來-往來帳 Director Current A/C', account_type: 'equity', parent_code: '31200', opening_balance: 0, is_active: 1 },
  { account_code: '31202', account_name: '董事酬金 Director Remuneration', account_type: 'equity', parent_code: '31200', opening_balance: 0, is_active: 1 },
  { account_code: '32000', account_name: '儲備及損益 Reserves & P&L', account_type: 'equity', parent_code: '30000', opening_balance: 0, is_active: 1 },
  { account_code: '32100', account_name: '留存盈利 Retained Earnings', account_type: 'equity', parent_code: '32000', opening_balance: 0, is_active: 1 },
  { account_code: '32101', account_name: '上年度保留盈利 Retained Earnings b/f', account_type: 'equity', parent_code: '32100', opening_balance: 0, is_active: 1 },
  { account_code: '32200', account_name: '本年損益 Current Year P&L', account_type: 'equity', parent_code: '32000', opening_balance: 0, is_active: 1 },

  // ═══ 40000 收入 REVENUE ═══
  { account_code: '40000', account_name: '收入 Revenue', account_type: 'revenue', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '41000', account_name: '營業收入 Operating Revenue', account_type: 'revenue', parent_code: '40000', opening_balance: 0, is_active: 1 },
  { account_code: '41100', account_name: '服務收入 Service Income', account_type: 'revenue', parent_code: '41000', opening_balance: 0, is_active: 1 },
  { account_code: '41101', account_name: '專業服務收入 Professional Services', account_type: 'revenue', parent_code: '41100', opening_balance: 0, is_active: 1 },
  { account_code: '41102', account_name: '技術服務收入 Technical Services', account_type: 'revenue', parent_code: '41100', opening_balance: 0, is_active: 1 },
  { account_code: '41200', account_name: '銷售收入 Sales Revenue', account_type: 'revenue', parent_code: '41000', opening_balance: 0, is_active: 1 },
  { account_code: '41300', account_name: '顧問收入 Consulting Income', account_type: 'revenue', parent_code: '41000', opening_balance: 0, is_active: 1 },
  { account_code: '42000', account_name: '其他收益 Other Income', account_type: 'revenue', parent_code: '40000', opening_balance: 0, is_active: 1 },
  { account_code: '42100', account_name: '利息及投資收入 Interest & Investment', account_type: 'revenue', parent_code: '42000', opening_balance: 0, is_active: 1 },
  { account_code: '42101', account_name: '銀行利息收入 Bank Interest', account_type: 'revenue', parent_code: '42100', opening_balance: 0, is_active: 1 },
  { account_code: '42200', account_name: '非經常性收入 Non-recurring Income', account_type: 'revenue', parent_code: '42000', opening_balance: 0, is_active: 1 },
  { account_code: '42201', account_name: '政府補貼 Government Subsidy', account_type: 'revenue', parent_code: '42200', opening_balance: 0, is_active: 1 },
  { account_code: '42202', account_name: '匯兌收益 Exchange Gain', account_type: 'revenue', parent_code: '42200', opening_balance: 0, is_active: 1 },

  // ═══ 50000-59999 直接成本 DIRECT COSTS ═══
  { account_code: '50000', account_name: '直接成本 Direct Costs', account_type: 'expense', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '51000', account_name: '服務成本 Cost of Services', account_type: 'expense', parent_code: '50000', opening_balance: 0, is_active: 1 },
  { account_code: '51100', account_name: '外判及顧問費 Subcontractor & Consultant', account_type: 'expense', parent_code: '51000', opening_balance: 0, is_active: 1 },
  { account_code: '51101', account_name: '外判工作費用 Subcontractor Fees', account_type: 'expense', parent_code: '51100', opening_balance: 0, is_active: 1 },
  { account_code: '51102', account_name: '專業顧問費 Professional Consultant', account_type: 'expense', parent_code: '51100', opening_balance: 0, is_active: 1 },
  { account_code: '51200', account_name: '直接人工 Direct Labour', account_type: 'expense', parent_code: '51000', opening_balance: 0, is_active: 1 },
  { account_code: '51201', account_name: '項目人員薪酬 Project Staff Salary', account_type: 'expense', parent_code: '51200', opening_balance: 0, is_active: 1 },
  { account_code: '52000', account_name: '銷售成本 Cost of Sales', account_type: 'expense', parent_code: '50000', opening_balance: 0, is_active: 1 },

  // ═══ 60000-69999 營運支出 OPERATING EXPENSES ═══
  { account_code: '60000', account_name: '營運支出 Operating Expenses', account_type: 'expense', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '61000', account_name: '員工支出 Staff Costs', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '61100', account_name: '董事及管理層 Director & Management', account_type: 'expense', parent_code: '61000', opening_balance: 0, is_active: 1 },
  { account_code: '61101', account_name: '董事袍金 Director Fee', account_type: 'expense', parent_code: '61100', opening_balance: 0, is_active: 1 },
  { account_code: '61102', account_name: '管理層薪金 Management Salary', account_type: 'expense', parent_code: '61100', opening_balance: 0, is_active: 1 },
  { account_code: '61200', account_name: '員工薪酬 Staff Remuneration', account_type: 'expense', parent_code: '61000', opening_balance: 0, is_active: 1 },
  { account_code: '61201', account_name: '員工薪金 Staff Salaries', account_type: 'expense', parent_code: '61200', opening_balance: 0, is_active: 1 },
  { account_code: '61202', account_name: '強積金僱主供款 MPF Employer Contribution', account_type: 'expense', parent_code: '61200', opening_balance: 0, is_active: 1 },
  { account_code: '61203', account_name: '員工福利 Staff Benefits', account_type: 'expense', parent_code: '61200', opening_balance: 0, is_active: 1 },
  { account_code: '62000', account_name: '辦公室支出 Office Costs', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '62100', account_name: '租金 Rent', account_type: 'expense', parent_code: '62000', opening_balance: 0, is_active: 1 },
  { account_code: '62101', account_name: '辦公室租金 Office Rent', account_type: 'expense', parent_code: '62100', opening_balance: 0, is_active: 1 },
  { account_code: '62102', account_name: '差餉及管理費 Rates & Management', account_type: 'expense', parent_code: '62100', opening_balance: 0, is_active: 1 },
  { account_code: '62200', account_name: '水電煤 Utilities', account_type: 'expense', parent_code: '62000', opening_balance: 0, is_active: 1 },
  { account_code: '62201', account_name: '電費 Electricity', account_type: 'expense', parent_code: '62200', opening_balance: 0, is_active: 1 },
  { account_code: '62202', account_name: '水費 Water', account_type: 'expense', parent_code: '62200', opening_balance: 0, is_active: 1 },
  { account_code: '62300', account_name: '電訊及科技 Telecom & IT', account_type: 'expense', parent_code: '62000', opening_balance: 0, is_active: 1 },
  { account_code: '62301', account_name: '電話及上網 Phone & Internet', account_type: 'expense', parent_code: '62300', opening_balance: 0, is_active: 1 },
  { account_code: '62302', account_name: '網站寄存及域名 Web Hosting & Domain', account_type: 'expense', parent_code: '62300', opening_balance: 0, is_active: 1 },
  { account_code: '62303', account_name: '軟件訂閱費 Software Subscriptions', account_type: 'expense', parent_code: '62300', opening_balance: 0, is_active: 1 },
  { account_code: '62400', account_name: '辦公雜項 Office Miscellaneous', account_type: 'expense', parent_code: '62000', opening_balance: 0, is_active: 1 },
  { account_code: '62401', account_name: '文具及印刷 Stationery & Printing', account_type: 'expense', parent_code: '62400', opening_balance: 0, is_active: 1 },
  { account_code: '62402', account_name: '茶水及清潔 Pantry & Cleaning', account_type: 'expense', parent_code: '62400', opening_balance: 0, is_active: 1 },
  { account_code: '63000', account_name: '專業及合規 Professional & Compliance', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '63100', account_name: '專業服務 Professional Services', account_type: 'expense', parent_code: '63000', opening_balance: 0, is_active: 1 },
  { account_code: '63101', account_name: '審計費用 Audit Fee', account_type: 'expense', parent_code: '63100', opening_balance: 0, is_active: 1 },
  { account_code: '63102', account_name: '公司秘書費 Company Secretary Fee', account_type: 'expense', parent_code: '63100', opening_balance: 0, is_active: 1 },
  { account_code: '63103', account_name: '法律顧問費 Legal Fee', account_type: 'expense', parent_code: '63100', opening_balance: 0, is_active: 1 },
  { account_code: '63200', account_name: '政府規費 Government Fees', account_type: 'expense', parent_code: '63000', opening_balance: 0, is_active: 1 },
  { account_code: '63201', account_name: '商業登記費 BR Renewal Fee', account_type: 'expense', parent_code: '63200', opening_balance: 0, is_active: 1 },
  { account_code: '63202', account_name: '公司周年申報費 Annual Return Fee', account_type: 'expense', parent_code: '63200', opening_balance: 0, is_active: 1 },
  { account_code: '63300', account_name: '保險 Insurance', account_type: 'expense', parent_code: '63000', opening_balance: 0, is_active: 1 },
  { account_code: '63301', account_name: '勞工保險 EC Insurance', account_type: 'expense', parent_code: '63300', opening_balance: 0, is_active: 1 },
  { account_code: '63302', account_name: '專業責任保險 Professional Indemnity', account_type: 'expense', parent_code: '63300', opening_balance: 0, is_active: 1 },
  { account_code: '64000', account_name: '銷售及推廣 Sales & Marketing', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '64100', account_name: '市場推廣 Marketing', account_type: 'expense', parent_code: '64000', opening_balance: 0, is_active: 1 },
  { account_code: '64101', account_name: '廣告費用 Advertising', account_type: 'expense', parent_code: '64100', opening_balance: 0, is_active: 1 },
  { account_code: '64102', account_name: '網站推廣 Website Promotion', account_type: 'expense', parent_code: '64100', opening_balance: 0, is_active: 1 },
  { account_code: '64200', account_name: '業務拓展 Business Development', account_type: 'expense', parent_code: '64000', opening_balance: 0, is_active: 1 },
  { account_code: '64201', account_name: '佣金支出 Commission Expense', account_type: 'expense', parent_code: '64200', opening_balance: 0, is_active: 1 },
  { account_code: '64202', account_name: '交際應酬費 Entertainment', account_type: 'expense', parent_code: '64200', opening_balance: 0, is_active: 1 },
  { account_code: '64300', account_name: '差旅交通 Travel & Transport', account_type: 'expense', parent_code: '64000', opening_balance: 0, is_active: 1 },
  { account_code: '64301', account_name: '本地交通 Local Transport', account_type: 'expense', parent_code: '64300', opening_balance: 0, is_active: 1 },
  { account_code: '64302', account_name: '海外差旅 Overseas Travel', account_type: 'expense', parent_code: '64300', opening_balance: 0, is_active: 1 },
  { account_code: '65000', account_name: '財務及銀行 Finance & Banking', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '65100', account_name: '銀行費用 Bank Charges', account_type: 'expense', parent_code: '65000', opening_balance: 0, is_active: 1 },
  { account_code: '65101', account_name: '銀行手續費 Bank Service Fee', account_type: 'expense', parent_code: '65100', opening_balance: 0, is_active: 1 },
  { account_code: '65102', account_name: '貸款利息 Loan Interest', account_type: 'expense', parent_code: '65100', opening_balance: 0, is_active: 1 },
  { account_code: '65200', account_name: '匯兌差額 Exchange Difference', account_type: 'expense', parent_code: '65000', opening_balance: 0, is_active: 1 },
  { account_code: '65201', account_name: '匯兌損失 Exchange Loss', account_type: 'expense', parent_code: '65200', opening_balance: 0, is_active: 1 },
  { account_code: '66000', account_name: '其他營運支出 Other Operating', account_type: 'expense', parent_code: '60000', opening_balance: 0, is_active: 1 },
  { account_code: '66100', account_name: '折舊 Depreciation', account_type: 'expense', parent_code: '66000', opening_balance: 0, is_active: 1 },
  { account_code: '66101', account_name: '折舊-設備 Depreciation-Equipment', account_type: 'expense', parent_code: '66100', opening_balance: 0, is_active: 1 },
  { account_code: '66102', account_name: '折舊-電腦 Depreciation-Computer', account_type: 'expense', parent_code: '66100', opening_balance: 0, is_active: 1 },
  { account_code: '66200', account_name: '雜項支出 Sundry Expenses', account_type: 'expense', parent_code: '66000', opening_balance: 0, is_active: 1 },
  { account_code: '66201', account_name: '罰款及附加費 Penalties & Surcharges', account_type: 'expense', parent_code: '66200', opening_balance: 0, is_active: 1 },
  { account_code: '66202', account_name: '捐款 Donations', account_type: 'expense', parent_code: '66200', opening_balance: 0, is_active: 1 },
  { account_code: '66203', account_name: '其他雜項 Miscellaneous', account_type: 'expense', parent_code: '66200', opening_balance: 0, is_active: 1 },

  // ═══ 80000 利得稅 PROFITS TAX ═══
  { account_code: '80000', account_name: '利得稅 Profits Tax', account_type: 'expense', parent_code: null, opening_balance: 0, is_active: 1 },
  { account_code: '81100', account_name: '香港利得稅 HK Profits Tax', account_type: 'expense', parent_code: '80000', opening_balance: 0, is_active: 1 },
  { account_code: '81101', account_name: '本年度利得稅 Current Year Profits Tax', account_type: 'expense', parent_code: '81100', opening_balance: 0, is_active: 1 },
  { account_code: '81102', account_name: '遞延稅項 Deferred Tax', account_type: 'expense', parent_code: '81100', opening_balance: 0, is_active: 1 },
];

// ── Component ──

interface CoaPreviewProps {
  fyStart: string;
  fyEnd: string;
}

export default function CoaPreview({ fyStart, fyEnd }: CoaPreviewProps) {
  const [expanded, setExpanded] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>({
    asset: true, liability: true, equity: true, revenue: true, expense: true,
  });
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [selectedFY, setSelectedFY] = useState('');
  const [fyOptions, setFyOptions] = useState<FiscalYearOption[]>([]);
  const [hideZeroBalance, setHideZeroBalance] = useState(false);

  // Build FY options from props
  const fyStartMD = useMemo(() => {
    const parts = (fyStart || '2026-04-01').split('-');
    return `${parts[1]}-${parts[2]}`;
  }, [fyStart]);

  const fyEndMD = useMemo(() => {
    const parts = (fyEnd || '2027-03-31').split('-');
    return `${parts[1]}-${parts[2]}`;
  }, [fyEnd]);

  useEffect(() => {
    const opts = buildFiscalYearOptions(fyStartMD, fyEndMD);
    setFyOptions(opts);
    const now = new Date();
    const [sm] = fyStartMD.split('-').map(Number);
    const baseYear = now.getFullYear() - (now.getMonth() + 1 < sm ? 1 : 0);
    const defaultOpt = opts.find(o => o.label.startsWith(String(baseYear)));
    if (defaultOpt) {
      setSelectedFY(defaultOpt.label);
    }
  }, [fyStartMD, fyEndMD]);

  const toggleType = (t: string) => setExpandedTypes(prev => ({ ...prev, [t]: !prev[t] }));
  const toggleAccount = (code: string) => setExpandedAccounts(prev => ({ ...prev, [code]: !prev[code] }));

  // Filter + group
  const filtered = useMemo(() => {
    return COA_TEMPLATE.filter((a) => {
      if (typeFilter && a.account_type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (a.account_code || '').toLowerCase().includes(q) || (a.account_name || '').toLowerCase().includes(q);
      }
      if (hideZeroBalance) {
        // In preview all balances are zero, so hideZeroBalance hides everything
        return false;
      }
      return true;
    });
  }, [typeFilter, search, hideZeroBalance]);

  const grouped: Record<string, CoaAccount[]> = useMemo(() => {
    const g: Record<string, CoaAccount[]> = {};
    for (const t of TYPE_ORDER) g[t] = [];
    for (const a of filtered) {
      const t = a.account_type || 'expense';
      if (!g[t]) g[t] = [];
      g[t].push(a);
    }
    for (const t of Object.keys(g)) {
      g[t].sort((a, b) => (a.account_code || '').localeCompare(b.account_code || ''));
    }
    return g;
  }, [filtered]);

  const totalAccounts = COA_TEMPLATE.length;
  const visibleAccounts = filtered.length;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <span className="text-sm font-semibold">
            {tr('Chart of Accounts Preview', '會計科目表預覽', '会计科目表预览')}
          </span>
          <span className="text-xs text-muted-foreground ml-2">
            {tr(
              `${totalAccounts} accounts will be seeded`,
              `將建立 ${totalAccounts} 個科目`,
              `将建立 ${totalAccounts} 个科目`,
            )}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {tr('HK 5-digit bilingual template', '香港五位數雙語模板', '香港五位数双语模板')}
        </span>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3 space-y-3">
          {/* Info banner */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            {tr(
              'This is a preview of the Chart of Accounts that will be automatically created for the new client. All balances start at zero.',
              '此為新客戶將自動建立的會計科目表預覽。所有餘額從零開始。',
              '此为新客户将自动建立的会计科目表预览。所有余额从零开始。',
            )}
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* FY period selector */}
            {fyOptions.length > 0 && (
              <select
                value={selectedFY}
                onChange={e => setSelectedFY(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-xs bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {fyOptions.map(o => (
                  <option key={o.label} value={o.label}>{o.label}</option>
                ))}
              </select>
            )}

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={tr('Search code or name...', '搜尋代碼或名稱...', '搜索代码或名称...')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 border rounded-lg text-xs w-48 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Type filter */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-xs bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{tr('All Types', '所有類型', '所有类型')}</option>
              {TYPE_ORDER.map(t => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>

            <div className="flex-1" />

            {/* Action buttons — disabled for preview */}
            <button
              disabled
              title={tr('Available after client creation', '客戶建立後可用', '客户建立后可用')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium opacity-50 cursor-not-allowed"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {tr('Generate from Bank', '從銀行產生', '从银行产生')}
            </button>

            <button
              disabled
              title={tr('Available after client creation', '客戶建立後可用', '客户建立后可用')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium opacity-50 cursor-not-allowed"
            >
              <Plus className="h-3.5 w-3.5" />
              {tr('Add Account', '新增科目', '新增科目')}
            </button>

            {/* Drag/reorder control — visual placeholder */}
            <button
              disabled
              title={tr('Available after client creation', '客戶建立後可用', '客户建立后可用')}
              className="inline-flex items-center gap-1 px-2 py-1.5 border rounded-lg text-xs opacity-40 cursor-not-allowed"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>

            {/* Hide Zero Balance toggle */}
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideZeroBalance}
                onChange={e => setHideZeroBalance(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              <EyeOff className="h-3 w-3" />
              {tr('Hide Zero Balance', '隱藏零餘額', '隐藏零余额')}
            </label>
          </div>

          {/* Hide-zero info */}
          {hideZeroBalance && (
            <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs text-muted-foreground text-center">
              {tr(
                'All accounts have zero balance in the template. Toggle off to view the full COA structure.',
                '模板中所有科目餘額為零。關閉此選項以查看完整科目表結構。',
                '模板中所有科目余额为零。关闭此选项以查看完整科目表结构。',
              )}
            </div>
          )}

          {/* Summary counts */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {TYPE_ORDER.map(t => {
              const count = grouped[t]?.length || 0;
              if (count === 0) return null;
              return (
                <span key={t} className="inline-flex items-center gap-1">
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${TYPE_COLORS[t]}`}>
                    {TYPE_LABELS[t]}
                  </span>
                  <span>{count}</span>
                </span>
              );
            })}
            <span className="text-muted-foreground/50">|</span>
            <span>{tr(`${visibleAccounts} of ${totalAccounts} accounts`, `${visibleAccounts} / ${totalAccounts} 個科目`, `${visibleAccounts} / ${totalAccounts} 个科目`)}</span>
          </div>

          {/* No results */}
          {filtered.length === 0 && !hideZeroBalance && (
            <div className="py-8 text-center">
              <p className="text-xs text-muted-foreground">{tr('No accounts match your filters.', '沒有符合篩選條件的科目。', '没有符合筛选条件的科目。')}</p>
            </div>
          )}

          {/* Account table by type group */}
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {TYPE_ORDER.filter(t => grouped[t]?.length > 0).map(type => (
              <div key={type} className="border rounded-lg overflow-hidden">
                {/* Type group header */}
                <button
                  onClick={() => toggleType(type)}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
                >
                  {expandedTypes[type] ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${TYPE_COLORS[type]}`}>
                    {TYPE_LABELS[type]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {grouped[type].length} {tr('accounts', '個科目', '个科目')}
                  </span>
                </button>

                {expandedTypes[type] && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/10 text-[10px]">
                        <th className="px-3 py-1.5 font-medium text-left text-muted-foreground">{tr('Code', '代碼', '代码')}</th>
                        <th className="px-3 py-1.5 font-medium text-left text-muted-foreground">{tr('Account Name', '科目名稱', '科目名称')}</th>
                        <th className="px-3 py-1.5 font-medium text-right text-muted-foreground">{tr('Opening', '期初', '期初')}</th>
                        <th className="px-3 py-1.5 font-medium text-right text-muted-foreground">{tr('Balance', '結餘', '结余')}</th>
                        <th className="px-3 py-1.5 font-medium text-left text-muted-foreground">{tr('Status', '狀態', '状态')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped[type].map((a, i) => {
                        const isParent = isParentCode(a.account_code);
                        const isExpanded = !!expandedAccounts[a.account_code];
                        const children = COA_TEMPLATE.filter(c => c.parent_code === a.account_code);
                        const hasChildren = children.length > 0;

                        return (
                          <React.Fragment key={a.account_code}>
                            <tr
                              onClick={() => hasChildren && toggleAccount(a.account_code)}
                              className={`${i % 2 ? 'bg-muted/5' : ''} hover:bg-muted/30 transition-colors ${hasChildren ? 'cursor-pointer' : ''}`}
                            >
                              <td className={`px-3 py-1.5 font-mono text-[11px] ${isParent ? 'font-bold' : ''}`}>
                                <span className="inline-flex items-center gap-1">
                                  {hasChildren ? (
                                    isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                                  ) : (
                                    <span className="w-3" />
                                  )}
                                  {a.account_code || ''}
                                </span>
                              </td>
                              <td className={`px-3 py-1.5 ${isParent ? 'font-bold' : ''}`}>
                                {a.account_name || ''}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                                {formatBalance(a.opening_balance)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-[11px] font-semibold">
                                {formatBalance(0, true)}
                              </td>
                              <td className="px-3 py-1.5">
                                <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                  {a.is_active !== 0 ? tr('Active', '啟用', '启用') : tr('Inactive', '停用', '停用')}
                                </span>
                              </td>
                            </tr>
                            {/* Expanded children */}
                            {isExpanded && hasChildren && children.map((child, ci) => (
                              <tr
                                key={child.account_code}
                                className={`${(i + ci) % 2 ? 'bg-muted/5' : ''} bg-muted/10`}
                              >
                                <td className="px-3 py-1.5 font-mono text-[11px]">
                                  <span className="ml-5">{child.account_code}</span>
                                </td>
                                <td className="px-3 py-1.5 pl-8 text-muted-foreground">
                                  {child.account_name || ''}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11px]">
                                  {formatBalance(child.opening_balance)}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11px] font-semibold">
                                  {formatBalance(0, true)}
                                </td>
                                <td className="px-3 py-1.5">
                                  <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                    {child.is_active !== 0 ? tr('Active', '啟用', '启用') : tr('Inactive', '停用', '停用')}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
