// ── COA Templates — single source of truth for HK Chart of Accounts ──────
// Base: HK 5-digit, 4-level bilingual template (133 accounts)
// Industry additions: 11 HK industries with specialized sub-accounts
// Manual skeleton: 7 root class accounts only

export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface CoaTemplateAccount {
  account_code: string;
  account_name: string;   // bilingual "中文 English"
  account_type: CoaAccountType;
  parent_code: string | null;
}

export const INDUSTRIES = [
  'professional', 'finance', 'trading', 'tourism', 'it',
  'fintech', 'medical', 'education', 'construction', 'ict', 'manufacturing',
] as const;
export type Industry = (typeof INDUSTRIES)[number];
export type CoaMode = 'industry' | 'manual';

// ── Base HK 5-Digit COA (133 accounts) ─────────────────────────────────────

export const BASE_HK_COA: CoaTemplateAccount[] = [
  // ── Assets (10000) ──
  { account_code: '10000', account_name: '資產 Assets', account_type: 'asset', parent_code: null },
  { account_code: '11000', account_name: '流動資產 Current Assets', account_type: 'asset', parent_code: '10000' },
  { account_code: '12000', account_name: '固定資產 Fixed Assets', account_type: 'asset', parent_code: '10000' },
  { account_code: '11100', account_name: '現金及銀行存款 Cash & Bank', account_type: 'asset', parent_code: '11000' },
  { account_code: '11200', account_name: '應收賬款及票據 AR & Notes', account_type: 'asset', parent_code: '11000' },
  { account_code: '11300', account_name: '其他應收款 Other Receivables', account_type: 'asset', parent_code: '11000' },
  { account_code: '11400', account_name: '預付及按金 Prepayments & Deposits', account_type: 'asset', parent_code: '11000' },
  { account_code: '12100', account_name: '物業房產 Property', account_type: 'asset', parent_code: '12000' },
  { account_code: '12200', account_name: '設備及器材 Equipment', account_type: 'asset', parent_code: '12000' },
  { account_code: '12300', account_name: '累計折舊 Accumulated Depreciation', account_type: 'asset', parent_code: '12000' },
  { account_code: '11101', account_name: '庫存現金 Cash on Hand', account_type: 'asset', parent_code: '11100' },
  { account_code: '11102', account_name: '匯豐銀行 HSBC', account_type: 'asset', parent_code: '11100' },
  { account_code: '11103', account_name: '其他銀行 Other Bank', account_type: 'asset', parent_code: '11100' },
  { account_code: '11201', account_name: '應收賬款 Trade Debtors', account_type: 'asset', parent_code: '11200' },
  { account_code: '11301', account_name: '應收董事款項 Director Loan to Co', account_type: 'asset', parent_code: '11300' },
  { account_code: '11302', account_name: '暫付款 Sundry Debtors', account_type: 'asset', parent_code: '11300' },
  { account_code: '11401', account_name: '預付費用 Prepayments', account_type: 'asset', parent_code: '11400' },
  { account_code: '11402', account_name: '租金按金 Rental Deposit', account_type: 'asset', parent_code: '11400' },
  { account_code: '11403', account_name: '其他按金 Other Deposits', account_type: 'asset', parent_code: '11400' },
  { account_code: '12201', account_name: '辦公設備 Office Equipment', account_type: 'asset', parent_code: '12200' },
  { account_code: '12202', account_name: '電腦設備 Computer Equipment', account_type: 'asset', parent_code: '12200' },
  { account_code: '12203', account_name: '汽車 Vehicles', account_type: 'asset', parent_code: '12200' },
  { account_code: '12301', account_name: '累計折舊-設備 Accumulated Depn-Equip', account_type: 'asset', parent_code: '12300' },
  { account_code: '12302', account_name: '累計折舊-電腦 Accumulated Depn-Computer', account_type: 'asset', parent_code: '12300' },
  // ── Liabilities (20000) ──
  { account_code: '20000', account_name: '負債 Liabilities', account_type: 'liability', parent_code: null },
  { account_code: '21000', account_name: '流動負債 Current Liabilities', account_type: 'liability', parent_code: '20000' },
  { account_code: '22000', account_name: '長期負債 Long-term Liabilities', account_type: 'liability', parent_code: '20000' },
  { account_code: '21100', account_name: '應付賬款及票據 AP & Notes', account_type: 'liability', parent_code: '21000' },
  { account_code: '21200', account_name: '其他應付款 Other Payables', account_type: 'liability', parent_code: '21000' },
  { account_code: '21300', account_name: '應付稅項 Tax Payable', account_type: 'liability', parent_code: '21000' },
  { account_code: '21400', account_name: '預收及應計 Accruals & Deferred', account_type: 'liability', parent_code: '21000' },
  { account_code: '21101', account_name: '應付賬款 Trade Creditors', account_type: 'liability', parent_code: '21100' },
  { account_code: '21201', account_name: '應付董事款項 Director Loan from Dir', account_type: 'liability', parent_code: '21200' },
  { account_code: '21202', account_name: '暫收款 Sundry Creditors', account_type: 'liability', parent_code: '21200' },
  { account_code: '21203', account_name: '應付薪金 Salary Payable', account_type: 'liability', parent_code: '21200' },
  { account_code: '21204', account_name: '應付強積金 MPF Payable', account_type: 'liability', parent_code: '21200' },
  { account_code: '21301', account_name: '應付利得稅 Profits Tax Payable', account_type: 'liability', parent_code: '21300' },
  { account_code: '21401', account_name: '預收收入 Deferred Revenue', account_type: 'liability', parent_code: '21400' },
  { account_code: '21402', account_name: '應計費用 Accrued Expenses', account_type: 'liability', parent_code: '21400' },
  // ── Equity (30000) ──
  { account_code: '30000', account_name: '資本及儲備 Equity & Reserves', account_type: 'equity', parent_code: null },
  { account_code: '31000', account_name: '股本及往來 Share Capital & Current', account_type: 'equity', parent_code: '30000' },
  { account_code: '32000', account_name: '儲備及損益 Reserves & P&L', account_type: 'equity', parent_code: '30000' },
  { account_code: '31100', account_name: '股本 Share Capital', account_type: 'equity', parent_code: '31000' },
  { account_code: '31200', account_name: '董事往來 Director Current Account', account_type: 'equity', parent_code: '31000' },
  { account_code: '32100', account_name: '留存盈利 Retained Earnings', account_type: 'equity', parent_code: '32000' },
  { account_code: '32200', account_name: '本年損益 Current Year P&L', account_type: 'equity', parent_code: '32000' },
  { account_code: '31101', account_name: '普通股本 Ordinary Shares', account_type: 'equity', parent_code: '31100' },
  { account_code: '31201', account_name: '董事往來-往來帳 Director Current A/C', account_type: 'equity', parent_code: '31200' },
  { account_code: '31202', account_name: '董事酬金 Director Remuneration', account_type: 'equity', parent_code: '31200' },
  { account_code: '32101', account_name: '上年度保留盈利 Retained Earnings b/f', account_type: 'equity', parent_code: '32100' },
  // ── Revenue (40000) ──
  { account_code: '40000', account_name: '收入 Revenue', account_type: 'revenue', parent_code: null },
  { account_code: '41000', account_name: '營業收入 Operating Revenue', account_type: 'revenue', parent_code: '40000' },
  { account_code: '42000', account_name: '其他收益 Other Income', account_type: 'revenue', parent_code: '40000' },
  { account_code: '41100', account_name: '服務收入 Service Income', account_type: 'revenue', parent_code: '41000' },
  { account_code: '41200', account_name: '銷售收入 Sales Revenue', account_type: 'revenue', parent_code: '41000' },
  { account_code: '41300', account_name: '顧問收入 Consulting Income', account_type: 'revenue', parent_code: '41000' },
  { account_code: '42100', account_name: '利息及投資收入 Interest & Investment', account_type: 'revenue', parent_code: '42000' },
  { account_code: '42200', account_name: '非經常性收入 Non-recurring Income', account_type: 'revenue', parent_code: '42000' },
  { account_code: '41101', account_name: '專業服務收入 Professional Services', account_type: 'revenue', parent_code: '41100' },
  { account_code: '41102', account_name: '技術服務收入 Technical Services', account_type: 'revenue', parent_code: '41100' },
  { account_code: '42101', account_name: '銀行利息收入 Bank Interest', account_type: 'revenue', parent_code: '42100' },
  { account_code: '42201', account_name: '政府補貼 Government Subsidy', account_type: 'revenue', parent_code: '42200' },
  { account_code: '42202', account_name: '匯兌收益 Exchange Gain', account_type: 'revenue', parent_code: '42200' },
  // ── Direct Costs (50000) ──
  { account_code: '50000', account_name: '直接成本 Direct Costs', account_type: 'expense', parent_code: null },
  { account_code: '51000', account_name: '服務成本 Cost of Services', account_type: 'expense', parent_code: '50000' },
  { account_code: '52000', account_name: '銷售成本 Cost of Sales', account_type: 'expense', parent_code: '50000' },
  { account_code: '51100', account_name: '外判及顧問費 Subcontractor & Consultant', account_type: 'expense', parent_code: '51000' },
  { account_code: '51200', account_name: '直接人工 Direct Labour', account_type: 'expense', parent_code: '51000' },
  { account_code: '51101', account_name: '外判工作費用 Subcontractor Fees', account_type: 'expense', parent_code: '51100' },
  { account_code: '51102', account_name: '專業顧問費 Professional Consultant', account_type: 'expense', parent_code: '51100' },
  { account_code: '51201', account_name: '項目人員薪酬 Project Staff Salary', account_type: 'expense', parent_code: '51200' },
  // ── Operating Expenses (60000) ──
  { account_code: '60000', account_name: '營運支出 Operating Expenses', account_type: 'expense', parent_code: null },
  { account_code: '61000', account_name: '員工支出 Staff Costs', account_type: 'expense', parent_code: '60000' },
  { account_code: '62000', account_name: '辦公室支出 Office Costs', account_type: 'expense', parent_code: '60000' },
  { account_code: '63000', account_name: '專業及合規 Professional & Compliance', account_type: 'expense', parent_code: '60000' },
  { account_code: '64000', account_name: '銷售及推廣 Sales & Marketing', account_type: 'expense', parent_code: '60000' },
  { account_code: '65000', account_name: '財務及銀行 Finance & Banking', account_type: 'expense', parent_code: '60000' },
  { account_code: '66000', account_name: '其他營運支出 Other Operating', account_type: 'expense', parent_code: '60000' },
  { account_code: '61100', account_name: '董事及管理層 Director & Management', account_type: 'expense', parent_code: '61000' },
  { account_code: '61101', account_name: '董事袍金 Director Fee', account_type: 'expense', parent_code: '61100' },
  { account_code: '61102', account_name: '管理層薪金 Management Salary', account_type: 'expense', parent_code: '61100' },
  { account_code: '61200', account_name: '員工薪酬 Staff Remuneration', account_type: 'expense', parent_code: '61000' },
  { account_code: '61201', account_name: '員工薪金 Staff Salaries', account_type: 'expense', parent_code: '61200' },
  { account_code: '61202', account_name: '強積金僱主供款 MPF Employer Contribution', account_type: 'expense', parent_code: '61200' },
  { account_code: '61203', account_name: '員工福利 Staff Benefits', account_type: 'expense', parent_code: '61200' },
  { account_code: '62100', account_name: '租金 Rent', account_type: 'expense', parent_code: '62000' },
  { account_code: '62101', account_name: '辦公室租金 Office Rent', account_type: 'expense', parent_code: '62100' },
  { account_code: '62102', account_name: '差餉及管理費 Rates & Management', account_type: 'expense', parent_code: '62100' },
  { account_code: '62200', account_name: '水電煤 Utilities', account_type: 'expense', parent_code: '62000' },
  { account_code: '62201', account_name: '電費 Electricity', account_type: 'expense', parent_code: '62200' },
  { account_code: '62202', account_name: '水費 Water', account_type: 'expense', parent_code: '62200' },
  { account_code: '62300', account_name: '電訊及科技 Telecom & IT', account_type: 'expense', parent_code: '62000' },
  { account_code: '62301', account_name: '電話及上網 Phone & Internet', account_type: 'expense', parent_code: '62300' },
  { account_code: '62302', account_name: '網站寄存及域名 Web Hosting & Domain', account_type: 'expense', parent_code: '62300' },
  { account_code: '62303', account_name: '軟件訂閱費 Software Subscriptions', account_type: 'expense', parent_code: '62300' },
  { account_code: '62400', account_name: '辦公雜項 Office Miscellaneous', account_type: 'expense', parent_code: '62000' },
  { account_code: '62401', account_name: '文具及印刷 Stationery & Printing', account_type: 'expense', parent_code: '62400' },
  { account_code: '62402', account_name: '茶水及清潔 Pantry & Cleaning', account_type: 'expense', parent_code: '62400' },
  { account_code: '63100', account_name: '專業服務 Professional Services', account_type: 'expense', parent_code: '63000' },
  { account_code: '63101', account_name: '審計費用 Audit Fee', account_type: 'expense', parent_code: '63100' },
  { account_code: '63102', account_name: '公司秘書費 Company Secretary Fee', account_type: 'expense', parent_code: '63100' },
  { account_code: '63103', account_name: '法律顧問費 Legal Fee', account_type: 'expense', parent_code: '63100' },
  { account_code: '63200', account_name: '政府規費 Government Fees', account_type: 'expense', parent_code: '63000' },
  { account_code: '63201', account_name: '商業登記費 BR Renewal Fee', account_type: 'expense', parent_code: '63200' },
  { account_code: '63202', account_name: '公司周年申報費 Annual Return Fee', account_type: 'expense', parent_code: '63200' },
  { account_code: '63300', account_name: '保險 Insurance', account_type: 'expense', parent_code: '63000' },
  { account_code: '63301', account_name: '勞工保險 EC Insurance', account_type: 'expense', parent_code: '63300' },
  { account_code: '63302', account_name: '專業責任保險 Professional Indemnity', account_type: 'expense', parent_code: '63300' },
  { account_code: '64100', account_name: '市場推廣 Marketing', account_type: 'expense', parent_code: '64000' },
  { account_code: '64101', account_name: '廣告費用 Advertising', account_type: 'expense', parent_code: '64100' },
  { account_code: '64102', account_name: '網站推廣 Website Promotion', account_type: 'expense', parent_code: '64100' },
  { account_code: '64200', account_name: '業務拓展 Business Development', account_type: 'expense', parent_code: '64000' },
  { account_code: '64201', account_name: '佣金支出 Commission Expense', account_type: 'expense', parent_code: '64200' },
  { account_code: '64202', account_name: '交際應酬費 Entertainment', account_type: 'expense', parent_code: '64200' },
  { account_code: '64300', account_name: '差旅交通 Travel & Transport', account_type: 'expense', parent_code: '64000' },
  { account_code: '64301', account_name: '本地交通 Local Transport', account_type: 'expense', parent_code: '64300' },
  { account_code: '64302', account_name: '海外差旅 Overseas Travel', account_type: 'expense', parent_code: '64300' },
  { account_code: '65100', account_name: '銀行費用 Bank Charges', account_type: 'expense', parent_code: '65000' },
  { account_code: '65101', account_name: '銀行手續費 Bank Service Fee', account_type: 'expense', parent_code: '65100' },
  { account_code: '65102', account_name: '貸款利息 Loan Interest', account_type: 'expense', parent_code: '65100' },
  { account_code: '65200', account_name: '匯兌差額 Exchange Difference', account_type: 'expense', parent_code: '65000' },
  { account_code: '65201', account_name: '匯兌損失 Exchange Loss', account_type: 'expense', parent_code: '65200' },
  { account_code: '66100', account_name: '折舊 Depreciation', account_type: 'expense', parent_code: '66000' },
  { account_code: '66101', account_name: '折舊-設備 Depreciation-Equipment', account_type: 'expense', parent_code: '66100' },
  { account_code: '66102', account_name: '折舊-電腦 Depreciation-Computer', account_type: 'expense', parent_code: '66100' },
  { account_code: '66200', account_name: '雜項支出 Sundry Expenses', account_type: 'expense', parent_code: '66000' },
  { account_code: '66201', account_name: '罰款及附加費 Penalties & Surcharges', account_type: 'expense', parent_code: '66200' },
  { account_code: '66202', account_name: '捐款 Donations', account_type: 'expense', parent_code: '66200' },
  { account_code: '66203', account_name: '其他雜項 Miscellaneous', account_type: 'expense', parent_code: '66200' },
  // ── Petty Cash (67000) ──
  { account_code: '67000', account_name: '零用金 Petty Cash', account_type: 'expense', parent_code: '60000' },
  { account_code: '67001', account_name: '零用金支出 Petty Cash Expenses', account_type: 'expense', parent_code: '67000' },
  // ── Profits Tax (80000) ──
  { account_code: '80000', account_name: '利得稅 Profits Tax', account_type: 'expense', parent_code: null },
  { account_code: '81100', account_name: '香港利得稅 HK Profits Tax', account_type: 'expense', parent_code: '80000' },
  { account_code: '81101', account_name: '本年度利得稅 Current Year Profits Tax', account_type: 'expense', parent_code: '81100' },
  { account_code: '81102', account_name: '遞延稅項 Deferred Tax', account_type: 'expense', parent_code: '81100' },
];

// ── Manual Skeleton (7 root accounts) ──────────────────────────────────────

export const MANUAL_SKELETON: CoaTemplateAccount[] = [
  { account_code: '10000', account_name: '資產 Assets', account_type: 'asset', parent_code: null },
  { account_code: '20000', account_name: '負債 Liabilities', account_type: 'liability', parent_code: null },
  { account_code: '30000', account_name: '資本及儲備 Equity & Reserves', account_type: 'equity', parent_code: null },
  { account_code: '40000', account_name: '收入 Revenue', account_type: 'revenue', parent_code: null },
  { account_code: '50000', account_name: '直接成本 Direct Costs', account_type: 'expense', parent_code: null },
  { account_code: '60000', account_name: '營運支出 Operating Expenses', account_type: 'expense', parent_code: null },
  { account_code: '80000', account_name: '利得稅 Profits Tax', account_type: 'expense', parent_code: null },
];

// ── Industry-Specific Additions ─────────────────────────────────────────────

export const INDUSTRY_ADDITIONS: Record<Industry, CoaTemplateAccount[]> = {
  // ── 1. Professional & Business Services ──
  professional: [
    { account_code: '41103', account_name: '管理顧問 Management Consulting', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '會計及稅務服務 Accounting & Tax Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: '法律顧問 Legal Advisory', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '人力資源顧問 HR Consulting', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: '市場推廣服務 Marketing Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41108', account_name: '公司秘書服務 Company Secretarial Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41301', account_name: '商業顧問 Business Advisory', account_type: 'revenue', parent_code: '41300' },
    { account_code: '62102', account_name: '專業會籍 Professional Subscriptions', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '參考資料及數據庫 Reference Materials & Databases', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '專業彌償保險 Professional Indemnity Insurance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '持續進修 CPD Training', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '業務拓展 Business Development', account_type: 'expense', parent_code: '64100' },
    { account_code: '64103', account_name: '客戶應酬 Client Entertainment', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 2. Financial Services ──
  finance: [
    { account_code: '41301', account_name: '財務顧問費 Financial Advisory Fees', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41302', account_name: '資產管理費 Asset Management Fees', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41303', account_name: '保險佣金 Insurance Commission', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41304', account_name: '基金管理費 Fund Management Fees', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41305', account_name: '證券經紀佣金 Securities Brokerage Commission', account_type: 'revenue', parent_code: '41300' },
    { account_code: '42102', account_name: '投資收益 Investment Income', account_type: 'revenue', parent_code: '42100' },
    { account_code: '11600', account_name: '客戶資金 Client Funds', account_type: 'asset', parent_code: '11000' },
    { account_code: '11601', account_name: '客戶信託賬戶 Client Trust Accounts', account_type: 'asset', parent_code: '11600' },
    { account_code: '11602', account_name: '持作交易投資 Investments Held for Trading', account_type: 'asset', parent_code: '11600' },
    { account_code: '21500', account_name: '客戶存款 Client Deposits', account_type: 'liability', parent_code: '21000' },
    { account_code: '21501', account_name: '客戶代管款項 Client Monies Held', account_type: 'liability', parent_code: '21500' },
    { account_code: '21502', account_name: '應付交易對手 Counterparty Payable', account_type: 'liability', parent_code: '21500' },
    { account_code: '63104', account_name: 'SFC牌照費 SFC Licensing Fee', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '合規培訓 Compliance Training', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '專業彌償保險 Professional Indemnity Insurance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '反洗錢合規 AML Compliance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63108', account_name: '監管申報 Regulatory Filing', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '投資者關係 Investor Relations', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 3. Trading & Logistics ──
  trading: [
    { account_code: '41201', account_name: '產品銷售-本地 Product Sales - Domestic', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41202', account_name: '產品銷售-出口 Product Sales - Export', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41203', account_name: '佣金收入 Commission Income', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41204', account_name: '轉口貿易 Re-export Trading', account_type: 'revenue', parent_code: '41200' },
    { account_code: '42203', account_name: '出口補貼 Export Subsidy', account_type: 'revenue', parent_code: '42200' },
    { account_code: '42204', account_name: '運費回收 Freight Recovery', account_type: 'revenue', parent_code: '42200' },
    { account_code: '11500', account_name: '存貨 Inventory', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '貿易存貨 Trading Inventory', account_type: 'asset', parent_code: '11500' },
    { account_code: '11502', account_name: '在途貨品 Goods in Transit', account_type: 'asset', parent_code: '11500' },
    { account_code: '11503', account_name: '寄售存貨 Consignment Stock', account_type: 'asset', parent_code: '11500' },
    { account_code: '52100', account_name: '購貨成本 Cost of Goods', account_type: 'expense', parent_code: '52000' },
    { account_code: '52101', account_name: '銷貨成本 Cost of Goods Sold', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '運費及運輸 Freight & Shipping', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '關稅 Customs Duties', account_type: 'expense', parent_code: '52100' },
    { account_code: '52104', account_name: '倉儲費 Warehousing', account_type: 'expense', parent_code: '52100' },
    { account_code: '52105', account_name: '港口及碼頭費 Port & Terminal Charges', account_type: 'expense', parent_code: '52100' },
    { account_code: '52106', account_name: '貨物保險 Cargo Insurance', account_type: 'expense', parent_code: '52100' },
    { account_code: '62201', account_name: '物流及速遞 Logistics & Courier', account_type: 'expense', parent_code: '62200' },
    { account_code: '62202', account_name: '檢驗及認證 Inspection & Certification', account_type: 'expense', parent_code: '62200' },
    { account_code: '62203', account_name: '貿易文件 Trade Documentation', account_type: 'expense', parent_code: '62200' },
    { account_code: '64102', account_name: '貿易展覽 Trade Exhibition', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 4. Tourism ──
  tourism: [
    { account_code: '41201', account_name: '食品銷售 Food Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41202', account_name: '飲品銷售 Beverage Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41203', account_name: '餐飲服務 Catering Services', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41204', account_name: '宴會及活動 Banquet & Events', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41301', account_name: '旅遊套餐 Tour Packages', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41302', account_name: '酒店佣金 Hotel Commission', account_type: 'revenue', parent_code: '41300' },
    { account_code: '11500', account_name: '存貨 Inventory', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '存貨-食品 Inventory - Food', account_type: 'asset', parent_code: '11500' },
    { account_code: '11502', account_name: '存貨-飲品 Inventory - Beverages', account_type: 'asset', parent_code: '11500' },
    { account_code: '11503', account_name: '存貨-紀念品 Inventory - Souvenirs', account_type: 'asset', parent_code: '11500' },
    { account_code: '52100', account_name: '購貨成本 Cost of Goods', account_type: 'expense', parent_code: '52000' },
    { account_code: '52101', account_name: '食材 Food Ingredients', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '飲品供應 Beverage Supplies', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '廚房用品 Kitchen Supplies', account_type: 'expense', parent_code: '52100' },
    { account_code: '52104', account_name: '包裝物料 Packaging Materials', account_type: 'expense', parent_code: '52100' },
    { account_code: '52105', account_name: '布草及洗滌 Linen & Laundry', account_type: 'expense', parent_code: '52100' },
    { account_code: '62201', account_name: '廚房設備維修 Kitchen Equipment Maintenance', account_type: 'expense', parent_code: '62200' },
    { account_code: '62202', account_name: '牌照及許可證 Licenses & Permits', account_type: 'expense', parent_code: '62200' },
    { account_code: '62203', account_name: '蟲鼠防治 Pest Control', account_type: 'expense', parent_code: '62200' },
    { account_code: '62204', account_name: '衛生及安全檢查 Health & Safety Inspection', account_type: 'expense', parent_code: '62200' },
    { account_code: '64102', account_name: '旅遊展及推廣 Travel Trade Show & Promotion', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 5. Innovation & Technology ──
  it: [
    { account_code: '41103', account_name: '軟件開發 Software Development', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '網頁及程式設計 Web & App Design', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: 'IT顧問服務 IT Consulting', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '維護合約 Maintenance Contracts', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: 'SaaS訂閱收入 SaaS Subscriptions', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41108', account_name: '數據分析服務 Data Analytics Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '11500', account_name: '在製品 Work in Progress', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '研發項目 R&D Projects', account_type: 'asset', parent_code: '11500' },
    { account_code: '62102', account_name: '軟件授權費 Software Licenses', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '雲端服務 Cloud Services', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '域名及寄存 Domain & Hosting', account_type: 'expense', parent_code: '62100' },
    { account_code: '62105', account_name: 'API及第三方服務 API & Third-Party Services', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '知識產權註冊 IP Registration & Patent', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '創科基金申請 ITC Grant Application', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '線上廣告 Online Advertising', account_type: 'expense', parent_code: '64100' },
    { account_code: '64103', account_name: '科技會議及展覽 Tech Conference & Events', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 6. Fintech ──
  fintech: [
    { account_code: '41301', account_name: '支付處理費 Payment Processing Fees', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41302', account_name: '平台訂閱收入 Platform Subscription', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41303', account_name: 'API接口費 API Access Fees', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41304', account_name: '數據分析服務 Data Analytics Services', account_type: 'revenue', parent_code: '41300' },
    { account_code: '41305', account_name: '監管科技服務 RegTech Services', account_type: 'revenue', parent_code: '41300' },
    { account_code: '11600', account_name: '數碼資產 Digital Assets', account_type: 'asset', parent_code: '11000' },
    { account_code: '11601', account_name: '客戶電子錢包資金 Client e-Wallet Funds', account_type: 'asset', parent_code: '11600' },
    { account_code: '11602', account_name: '結算賬戶 Settlement Accounts', account_type: 'asset', parent_code: '11600' },
    { account_code: '21500', account_name: '客戶電子錢包結餘 Client e-Wallet Balances', account_type: 'liability', parent_code: '21000' },
    { account_code: '21501', account_name: '商戶結算應付 Merchant Settlement Payable', account_type: 'liability', parent_code: '21500' },
    { account_code: '62102', account_name: '雲端基礎設施 Cloud Infrastructure', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '網絡安全服務 Cybersecurity Services', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: 'API網關及第三方 API Gateway & Third-Party', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '金管局/證監會牌照 HKMA/SFC Licensing', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '反洗錢及認識客戶 AML/KYC Compliance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '數據私隱合規 Data Privacy Compliance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '滲透測試及審計 Penetration Testing & Audit', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '數碼營銷 Digital Marketing', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 7. Medical & Healthcare ──
  medical: [
    { account_code: '41103', account_name: '普通科診症 Consultation - GP', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '專科診症 Consultation - Specialist', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: '外科手術 Surgical Procedures', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '診斷服務 Diagnostic Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: '化驗服務 Laboratory Tests', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41108', account_name: '身體檢查套餐 Health Check Packages', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41109', account_name: '疫苗接種 Vaccination Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41201', account_name: '醫療用品銷售 Medical Supplies Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '11500', account_name: '醫療存貨 Medical Inventory', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '藥物 Pharmaceuticals', account_type: 'asset', parent_code: '11500' },
    { account_code: '11502', account_name: '醫療耗材 Medical Consumables', account_type: 'asset', parent_code: '11500' },
    { account_code: '11503', account_name: '疫苗及冷鏈 Vaccines & Cold Chain', account_type: 'asset', parent_code: '11500' },
    { account_code: '12203', account_name: '醫療設備 Medical Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '52101', account_name: '藥物成本 Pharmaceuticals COGS', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '醫療耗材成本 Medical Consumables COGS', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '化驗消耗品 Laboratory Consumables', account_type: 'expense', parent_code: '52100' },
    { account_code: '62102', account_name: '醫療設備維修 Medical Equipment Maintenance', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '消毒及感染控制 Sterilization & Infection Control', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '醫療廢物處理 Medical Waste Disposal', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '醫療責任保險 Medical Indemnity Insurance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '醫務委員會註冊 Medical Council Registration', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '持續醫學進修 CME & CPD Training', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '診所牌照 Clinic Licensing', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '醫療推廣 Healthcare Marketing', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 8. Education ──
  education: [
    { account_code: '41103', account_name: '學費收入 Tuition Fees', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '課程費用 Course Fees', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: '工作坊及研討會 Workshop & Seminar', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '網上課程收入 Online Course Revenue', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: '考試費 Examination Fees', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41108', account_name: '諮詢及評估 Consultation & Assessment', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41109', account_name: '夏令/冬令營 Summer/Winter Camp', account_type: 'revenue', parent_code: '41100' },
    { account_code: '42102', account_name: '政府津貼 Government Grant', account_type: 'revenue', parent_code: '42100' },
    { account_code: '11500', account_name: '教材及圖書 Teaching Materials & Books', account_type: 'asset', parent_code: '11000' },
    { account_code: '12203', account_name: '教學設備 Teaching Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '62102', account_name: '教材及教科書 Teaching Materials & Textbooks', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '課室用品 Classroom Supplies', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '教育軟件及LMS Educational Software & LMS', account_type: 'expense', parent_code: '62100' },
    { account_code: '62105', account_name: '圖書館資源 Library Resources', account_type: 'expense', parent_code: '62100' },
    { account_code: '62106', account_name: '實驗室用品 Laboratory Supplies', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '教育局註冊 EDB Registration/Licensing', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '教師培訓 Teacher Training & CPD', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '課程認證 Accreditation Fees', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '學生保險 Student Insurance', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '教育展及推廣 Education Fair & Promotion', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 9. Construction & Real Estate ──
  construction: [
    { account_code: '41103', account_name: '工程合約收入 Construction Contract Revenue', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '裝修及翻新 Renovation & Fit-out', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: '項目管理費 Project Management Fees', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '設計及顧問 Design & Consultancy', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: '維修保養合約 Maintenance Contracts', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41201', account_name: '物業銷售 Property Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '42101', account_name: '租金收入 Rental Income', account_type: 'revenue', parent_code: '42100' },
    { account_code: '42102', account_name: '物業管理費 Property Management Fees', account_type: 'revenue', parent_code: '42100' },
    { account_code: '42203', account_name: '工程變更索償 Variation Claims', account_type: 'revenue', parent_code: '42200' },
    { account_code: '11500', account_name: '建築材料 Construction Materials', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '在建工程 Work in Progress', account_type: 'asset', parent_code: '11500' },
    { account_code: '11502', account_name: '發展中物業 Development Properties', account_type: 'asset', parent_code: '11500' },
    { account_code: '12100', account_name: '投資物業 Investment Properties', account_type: 'asset', parent_code: '12000' },
    { account_code: '12101', account_name: '土地及樓宇 Land & Buildings', account_type: 'asset', parent_code: '12100' },
    { account_code: '52101', account_name: '建築材料 Construction Materials', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '分包商成本 Subcontractor Costs', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '直接人工 Direct Labour', account_type: 'expense', parent_code: '52100' },
    { account_code: '52104', account_name: '機械租賃 Plant & Machinery Hire', account_type: 'expense', parent_code: '52100' },
    { account_code: '52105', account_name: '地盤費用 Site Costs', account_type: 'expense', parent_code: '52100' },
    { account_code: '52106', account_name: '安全設備 Safety Equipment', account_type: 'expense', parent_code: '52100' },
    { account_code: '62102', account_name: '地盤寫字樓租金 Site Office Rent', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '工程保險 Construction Insurance', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '安全培訓 Safety Training', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '建築商註冊 BD Registration/Renewal', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: '建造業議會徵費 CIC Levy', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '履約保證金 Performance Bond', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '承包商全險 Contractor\'s All Risk Insurance', account_type: 'expense', parent_code: '63100' },
  ],

  // ── 10. ICT & Telecommunications ──
  ict: [
    { account_code: '41103', account_name: '網絡服務 Network Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41104', account_name: '電訊服務 Telecommunications', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41105', account_name: '數據中心及雲端 Data Centre & Cloud', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41106', account_name: '系統整合 System Integration', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41107', account_name: '網絡安全服務 Cybersecurity Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41108', account_name: '託管服務 Managed Services', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41109', account_name: '物聯網方案 IoT Solutions', account_type: 'revenue', parent_code: '41100' },
    { account_code: '41201', account_name: '硬件銷售 Hardware Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41202', account_name: '軟件授權銷售 Software License Sales', account_type: 'revenue', parent_code: '41200' },
    { account_code: '11500', account_name: '存貨-硬件 Inventory - Hardware', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '存貨-備件 Inventory - Spare Parts', account_type: 'asset', parent_code: '11500' },
    { account_code: '12203', account_name: '網絡設備 Network Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '12204', account_name: '數據中心設備 Data Centre Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '12205', account_name: '傳輸設備 Transmission Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '52101', account_name: '硬件成本 Hardware COGS', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '軟件授權成本 Software License COGS', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '頻寬及互聯 Bandwidth & Peering', account_type: 'expense', parent_code: '52100' },
    { account_code: '52104', account_name: '電訊商互連 Carrier & Interconnection', account_type: 'expense', parent_code: '52100' },
    { account_code: '52105', account_name: '主機託管 Colocation Costs', account_type: 'expense', parent_code: '52100' },
    { account_code: '62102', account_name: '頻譜及通訊局牌照 Spectrum & OFCA License', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '網絡維修保養 Network Maintenance', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '基站及機房租賃 Tower & Site Rental', account_type: 'expense', parent_code: '62100' },
    { account_code: '62105', account_name: '數據中心電費 Electricity - Data Centre', account_type: 'expense', parent_code: '62100' },
    { account_code: '62106', account_name: '技術支援合約 Technical Support Contracts', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '電訊條例合規 Telecommunications Compliance', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '行業展覽 Industry Exhibition', account_type: 'expense', parent_code: '64100' },
  ],

  // ── 11. Manufacturing ──
  manufacturing: [
    { account_code: '41201', account_name: '產品銷售-本地 Product Sales - Domestic', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41202', account_name: '產品銷售-出口 Product Sales - Export', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41203', account_name: 'OEM/ODM收入 OEM/ODM Revenue', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41204', account_name: '合約製造 Contract Manufacturing', account_type: 'revenue', parent_code: '41200' },
    { account_code: '41205', account_name: '原型及模具收入 Prototype & Tooling Revenue', account_type: 'revenue', parent_code: '41200' },
    { account_code: '11500', account_name: '原材料 Raw Materials', account_type: 'asset', parent_code: '11000' },
    { account_code: '11501', account_name: '在製品 Work in Progress', account_type: 'asset', parent_code: '11500' },
    { account_code: '11502', account_name: '製成品 Finished Goods', account_type: 'asset', parent_code: '11500' },
    { account_code: '11503', account_name: '包裝物料 Packaging Materials', account_type: 'asset', parent_code: '11500' },
    { account_code: '11504', account_name: '備件 Spare Parts', account_type: 'asset', parent_code: '11500' },
    { account_code: '12203', account_name: '廠房及機器 Plant & Machinery', account_type: 'asset', parent_code: '12200' },
    { account_code: '12204', account_name: '模具及工具 Moulds & Tooling', account_type: 'asset', parent_code: '12200' },
    { account_code: '12205', account_name: '工廠設備 Factory Equipment', account_type: 'asset', parent_code: '12200' },
    { account_code: '52101', account_name: '原材料 Raw Materials', account_type: 'expense', parent_code: '52100' },
    { account_code: '52102', account_name: '直接人工 Direct Labour', account_type: 'expense', parent_code: '52100' },
    { account_code: '52103', account_name: '工廠間接費用 Factory Overhead', account_type: 'expense', parent_code: '52100' },
    { account_code: '52104', account_name: '工廠水電煤 Utilities - Factory', account_type: 'expense', parent_code: '52100' },
    { account_code: '52105', account_name: '包裝 Packaging', account_type: 'expense', parent_code: '52100' },
    { account_code: '52106', account_name: '品質控制及測試 Quality Control & Testing', account_type: 'expense', parent_code: '52100' },
    { account_code: '52107', account_name: '模具維修 Tooling & Mould Maintenance', account_type: 'expense', parent_code: '52100' },
    { account_code: '52108', account_name: '運輸及物流 Freight & Logistics', account_type: 'expense', parent_code: '52100' },
    { account_code: '62102', account_name: '工廠租金 Factory Rent', account_type: 'expense', parent_code: '62100' },
    { account_code: '62103', account_name: '機器維修保養 Machinery Maintenance', account_type: 'expense', parent_code: '62100' },
    { account_code: '62104', account_name: '安全設備及培訓 Safety Equipment & Training', account_type: 'expense', parent_code: '62100' },
    { account_code: '62105', account_name: '環保合規 Environmental Compliance', account_type: 'expense', parent_code: '62100' },
    { account_code: '62106', account_name: '廢物處理 Waste Management', account_type: 'expense', parent_code: '62100' },
    { account_code: '63104', account_name: '產品認證 Product Certification (CE/FCC/UL)', account_type: 'expense', parent_code: '63100' },
    { account_code: '63105', account_name: 'ISO審計及認證 ISO Audit & Certification', account_type: 'expense', parent_code: '63100' },
    { account_code: '63106', account_name: '產品責任保險 Product Liability Insurance', account_type: 'expense', parent_code: '63100' },
    { account_code: '63107', account_name: '工廠牌照及註冊 Factory License & Registration', account_type: 'expense', parent_code: '63100' },
    { account_code: '64102', account_name: '貿易展覽 Trade Fair & Exhibition', account_type: 'expense', parent_code: '64100' },
  ],
};

// ── Helper Functions ────────────────────────────────────────────────────────

/** Get the merged COA template for a given industry and mode */
export function getCoaTemplate(industry: string, mode: CoaMode): CoaTemplateAccount[] {
  if (mode === 'manual') {
    return [...MANUAL_SKELETON];
  }

  const base = BASE_HK_COA;
  const additions = INDUSTRY_ADDITIONS[industry as Industry] || [];
  if (additions.length === 0) return [...base];

  // Merge: base first, industry additions overwrite by code
  const map = new Map<string, CoaTemplateAccount>();
  for (const a of base) map.set(a.account_code, { ...a });
  for (const a of additions) map.set(a.account_code, { ...a });

  // Ensure parent accounts from additions exist in the merged set
  for (const a of additions) {
    if (a.parent_code && !map.has(a.parent_code)) {
      // Look up parent from base
      const parent = base.find(b => b.account_code === a.parent_code);
      if (parent) map.set(parent.account_code, { ...parent });
    }
  }

  return [...map.values()].sort((a, b) => a.account_code.localeCompare(b.account_code));
}

/** Merge custom accounts on top of base template (custom wins on code conflict) */
export function mergeCustomAccounts(
  base: CoaTemplateAccount[],
  custom: CoaTemplateAccount[],
): CoaTemplateAccount[] {
  if (!custom || custom.length === 0) return base;
  const map = new Map<string, CoaTemplateAccount>();
  for (const a of base) map.set(a.account_code, { ...a });
  for (const a of custom) map.set(a.account_code, { ...a });
  return [...map.values()].sort((a, b) => a.account_code.localeCompare(b.account_code));
}

/** Build a lookup map from the base template (for HK_COA_NAMES) */
export function buildAccountNameMap(accounts: CoaTemplateAccount[]): Record<string, { name: string; type: CoaAccountType; parent: string | null }> {
  const map: Record<string, { name: string; type: CoaAccountType; parent: string | null }> = {};
  for (const a of accounts) {
    map[a.account_code] = { name: a.account_name, type: a.account_type, parent: a.parent_code };
  }
  return map;
}
