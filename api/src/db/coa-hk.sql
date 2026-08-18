-- Hong Kong 5-Digit Chart of Accounts — 4 Levels
-- Level 1: Class (X0000), Level 2: Group (XX000), Level 3: Category (XXX00), Level 4: Account (XXXXX)

-- ═══════ 10000 資產 ASSETS ═══════
INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
-- Level 1
('coa-hk-10000', 'u-hayson', '10000', '資產 Assets', 'asset', NULL),
-- Level 2
('coa-hk-11000', 'u-hayson', '11000', '流動資產 Current Assets', 'asset', '10000'),
('coa-hk-12000', 'u-hayson', '12000', '固定資產 Fixed Assets', 'asset', '10000'),
-- Level 3
('coa-hk-11100', 'u-hayson', '11100', '現金及銀行存款 Cash & Bank', 'asset', '11000'),
('coa-hk-11200', 'u-hayson', '11200', '應收賬款及票據 AR & Notes', 'asset', '11000'),
('coa-hk-11300', 'u-hayson', '11300', '其他應收款 Other Receivables', 'asset', '11000'),
('coa-hk-11400', 'u-hayson', '11400', '預付及按金 Prepayments & Deposits', 'asset', '11000'),
('coa-hk-12100', 'u-hayson', '12100', '物業房產 Property', 'asset', '12000'),
('coa-hk-12200', 'u-hayson', '12200', '設備及器材 Equipment', 'asset', '12000'),
('coa-hk-12300', 'u-hayson', '12300', '累計折舊 Accumulated Depreciation', 'asset', '12000'),
-- Level 4
('coa-hk-11101', 'u-hayson', '11101', '庫存現金 Cash on Hand', 'asset', '11100'),
('coa-hk-11102', 'u-hayson', '11102', '匯豐銀行 HSBC', 'asset', '11100'),
('coa-hk-11103', 'u-hayson', '11103', '其他銀行 Other Bank', 'asset', '11100'),
('coa-hk-11201', 'u-hayson', '11201', '應收賬款 Trade Debtors', 'asset', '11200'),
('coa-hk-11301', 'u-hayson', '11301', '應收董事款項 Director Loan to Co', 'asset', '11300'),
('coa-hk-11302', 'u-hayson', '11302', '暫付款 Sundry Debtors', 'asset', '11300'),
('coa-hk-11401', 'u-hayson', '11401', '預付費用 Prepayments', 'asset', '11400'),
('coa-hk-11402', 'u-hayson', '11402', '租金按金 Rental Deposit', 'asset', '11400'),
('coa-hk-11403', 'u-hayson', '11403', '其他按金 Other Deposits', 'asset', '11400'),
('coa-hk-12201', 'u-hayson', '12201', '辦公設備 Office Equipment', 'asset', '12200'),
('coa-hk-12202', 'u-hayson', '12202', '電腦設備 Computer Equipment', 'asset', '12200'),
('coa-hk-12203', 'u-hayson', '12203', '汽車 Vehicles', 'asset', '12200'),
('coa-hk-12301', 'u-hayson', '12301', '累計折舊-設備 Accumulated Depn-Equip', 'asset', '12300'),
('coa-hk-12302', 'u-hayson', '12302', '累計折舊-電腦 Accumulated Depn-Computer', 'asset', '12300'),

-- ═══════ 20000 負債 LIABILITIES ═══════
-- Level 1
('coa-hk-20000', 'u-hayson', '20000', '負債 Liabilities', 'liability', NULL),
-- Level 2
('coa-hk-21000', 'u-hayson', '21000', '流動負債 Current Liabilities', 'liability', '20000'),
('coa-hk-22000', 'u-hayson', '22000', '長期負債 Long-term Liabilities', 'liability', '20000'),
-- Level 3
('coa-hk-21100', 'u-hayson', '21100', '應付賬款及票據 AP & Notes', 'liability', '21000'),
('coa-hk-21200', 'u-hayson', '21200', '其他應付款 Other Payables', 'liability', '21000'),
('coa-hk-21300', 'u-hayson', '21300', '應付稅項 Tax Payable', 'liability', '21000'),
('coa-hk-21400', 'u-hayson', '21400', '預收及應計 Accruals & Deferred', 'liability', '21000'),
-- Level 4
('coa-hk-21101', 'u-hayson', '21101', '應付賬款 Trade Creditors', 'liability', '21100'),
('coa-hk-21201', 'u-hayson', '21201', '應付董事款項 Director Loan from Dir', 'liability', '21200'),
('coa-hk-21202', 'u-hayson', '21202', '暫收款 Sundry Creditors', 'liability', '21200'),
('coa-hk-21203', 'u-hayson', '21203', '應付薪金 Salary Payable', 'liability', '21200'),
('coa-hk-21204', 'u-hayson', '21204', '應付強積金 MPF Payable', 'liability', '21200'),
('coa-hk-21301', 'u-hayson', '21301', '應付利得稅 Profits Tax Payable', 'liability', '21300'),
('coa-hk-21401', 'u-hayson', '21401', '預收收入 Deferred Revenue', 'liability', '21400'),
('coa-hk-21402', 'u-hayson', '21402', '應計費用 Accrued Expenses', 'liability', '21400'),

-- ═══════ 30000 資本 EQUITY ═══════
-- Level 1
('coa-hk-30000', 'u-hayson', '30000', '資本及儲備 Equity & Reserves', 'equity', NULL),
-- Level 2
('coa-hk-31000', 'u-hayson', '31000', '股本及往來 Share Capital & Current', 'equity', '30000'),
('coa-hk-32000', 'u-hayson', '32000', '儲備及損益 Reserves & P&L', 'equity', '30000'),
-- Level 3
('coa-hk-31100', 'u-hayson', '31100', '股本 Share Capital', 'equity', '31000'),
('coa-hk-31200', 'u-hayson', '31200', '董事往來 Director Current Account', 'equity', '31000'),
('coa-hk-32100', 'u-hayson', '32100', '留存盈利 Retained Earnings', 'equity', '32000'),
('coa-hk-32200', 'u-hayson', '32200', '本年損益 Current Year P&L', 'equity', '32000'),
-- Level 4
('coa-hk-31101', 'u-hayson', '31101', '普通股本 Ordinary Shares', 'equity', '31100'),
('coa-hk-31201', 'u-hayson', '31201', '董事往來-往來帳 Director Current A/C', 'equity', '31200'),
('coa-hk-31202', 'u-hayson', '31202', '董事酬金 Director Remuneration', 'equity', '31200'),
('coa-hk-32101', 'u-hayson', '32101', '上年度保留盈利 Retained Earnings b/f', 'equity', '32100'),

-- ═══════ 40000 收入 REVENUE ═══════
-- Level 1
('coa-hk-40000', 'u-hayson', '40000', '收入 Revenue', 'revenue', NULL),
-- Level 2
('coa-hk-41000', 'u-hayson', '41000', '營業收入 Operating Revenue', 'revenue', '40000'),
('coa-hk-42000', 'u-hayson', '42000', '其他收益 Other Income', 'revenue', '40000'),
-- Level 3
('coa-hk-41100', 'u-hayson', '41100', '服務收入 Service Income', 'revenue', '41000'),
('coa-hk-41200', 'u-hayson', '41200', '銷售收入 Sales Revenue', 'revenue', '41000'),
('coa-hk-41300', 'u-hayson', '41300', '顧問收入 Consulting Income', 'revenue', '41000'),
('coa-hk-42100', 'u-hayson', '42100', '利息及投資收入 Interest & Investment', 'revenue', '42000'),
('coa-hk-42200', 'u-hayson', '42200', '非經常性收入 Non-recurring Income', 'revenue', '42000'),
-- Level 4
('coa-hk-41101', 'u-hayson', '41101', '專業服務收入 Professional Services', 'revenue', '41100'),
('coa-hk-41102', 'u-hayson', '41102', '技術服務收入 Technical Services', 'revenue', '41100'),
('coa-hk-42101', 'u-hayson', '42101', '銀行利息收入 Bank Interest', 'revenue', '42100'),
('coa-hk-42201', 'u-hayson', '42201', '政府補貼 Government Subsidy', 'revenue', '42200'),
('coa-hk-42202', 'u-hayson', '42202', '匯兌收益 Exchange Gain', 'revenue', '42200'),

-- ═══════ 50000-59999 直接成本 DIRECT COSTS ═══════
-- Level 1
('coa-hk-50000', 'u-hayson', '50000', '直接成本 Direct Costs', 'cost', NULL),
-- Level 2
('coa-hk-51000', 'u-hayson', '51000', '服務成本 Cost of Services', 'cost', '50000'),
('coa-hk-52000', 'u-hayson', '52000', '銷售成本 Cost of Sales', 'cost', '50000'),
-- Level 3
('coa-hk-51100', 'u-hayson', '51100', '外判及顧問費 Subcontractor & Consultant', 'cost', '51000'),
('coa-hk-51200', 'u-hayson', '51200', '直接人工 Direct Labour', 'cost', '51000'),
-- Level 4
('coa-hk-51101', 'u-hayson', '51101', '外判工作費用 Subcontractor Fees', 'cost', '51100'),
('coa-hk-51102', 'u-hayson', '51102', '專業顧問費 Professional Consultant', 'cost', '51100'),
('coa-hk-51201', 'u-hayson', '51201', '項目人員薪酬 Project Staff Salary', 'cost', '51200'),

-- ═══════ 60000-69999 營運支出 OPERATING EXPENSES ═══════
-- Level 1
('coa-hk-60000', 'u-hayson', '60000', '營運支出 Operating Expenses', 'expense', NULL),
-- Level 2
('coa-hk-61000', 'u-hayson', '61000', '員工支出 Staff Costs', 'expense', '60000'),
('coa-hk-62000', 'u-hayson', '62000', '辦公室支出 Office Costs', 'expense', '60000'),
('coa-hk-63000', 'u-hayson', '63000', '專業及合規 Professional & Compliance', 'expense', '60000'),
('coa-hk-64000', 'u-hayson', '64000', '銷售及推廣 Sales & Marketing', 'expense', '60000'),
('coa-hk-65000', 'u-hayson', '65000', '財務及銀行 Finance & Banking', 'expense', '60000'),
('coa-hk-66000', 'u-hayson', '66000', '其他營運支出 Other Operating', 'expense', '60000'),
-- Level 3 / Level 4
('coa-hk-61100', 'u-hayson', '61100', '董事及管理層 Director & Management', 'expense', '61000'),
('coa-hk-61101', 'u-hayson', '61101', '董事袍金 Director Fee', 'expense', '61100'),
('coa-hk-61102', 'u-hayson', '61102', '管理層薪金 Management Salary', 'expense', '61100'),
('coa-hk-61200', 'u-hayson', '61200', '員工薪酬 Staff Remuneration', 'expense', '61000'),
('coa-hk-61201', 'u-hayson', '61201', '員工薪金 Staff Salaries', 'expense', '61200'),
('coa-hk-61202', 'u-hayson', '61202', '強積金僱主供款 MPF Employer Contribution', 'expense', '61200'),
('coa-hk-61203', 'u-hayson', '61203', '員工福利 Staff Benefits', 'expense', '61200'),
('coa-hk-62100', 'u-hayson', '62100', '租金 Rent', 'expense', '62000'),
('coa-hk-62101', 'u-hayson', '62101', '辦公室租金 Office Rent', 'expense', '62100'),
('coa-hk-62102', 'u-hayson', '62102', '差餉及管理費 Rates & Management', 'expense', '62100'),
('coa-hk-62200', 'u-hayson', '62200', '水電煤 Utilities', 'expense', '62000'),
('coa-hk-62201', 'u-hayson', '62201', '電費 Electricity', 'expense', '62200'),
('coa-hk-62202', 'u-hayson', '62202', '水費 Water', 'expense', '62200'),
('coa-hk-62300', 'u-hayson', '62300', '電訊及科技 Telecom & IT', 'expense', '62000'),
('coa-hk-62301', 'u-hayson', '62301', '電話及上網 Phone & Internet', 'expense', '62300'),
('coa-hk-62302', 'u-hayson', '62302', '網站寄存及域名 Web Hosting & Domain', 'expense', '62300'),
('coa-hk-62303', 'u-hayson', '62303', '軟件訂閱費 Software Subscriptions', 'expense', '62300'),
('coa-hk-62400', 'u-hayson', '62400', '辦公雜項 Office Miscellaneous', 'expense', '62000'),
('coa-hk-62401', 'u-hayson', '62401', '文具及印刷 Stationery & Printing', 'expense', '62400'),
('coa-hk-62402', 'u-hayson', '62402', '茶水及清潔 Pantry & Cleaning', 'expense', '62400'),
('coa-hk-63100', 'u-hayson', '63100', '專業服務 Professional Services', 'expense', '63000'),
('coa-hk-63101', 'u-hayson', '63101', '審計費用 Audit Fee', 'expense', '63100'),
('coa-hk-63102', 'u-hayson', '63102', '公司秘書費 Company Secretary Fee', 'expense', '63100'),
('coa-hk-63103', 'u-hayson', '63103', '法律顧問費 Legal Fee', 'expense', '63100'),
('coa-hk-63200', 'u-hayson', '63200', '政府規費 Government Fees', 'expense', '63000'),
('coa-hk-63201', 'u-hayson', '63201', '商業登記費 BR Renewal Fee', 'expense', '63200'),
('coa-hk-63202', 'u-hayson', '63202', '公司周年申報費 Annual Return Fee', 'expense', '63200'),
('coa-hk-63300', 'u-hayson', '63300', '保險 Insurance', 'expense', '63000'),
('coa-hk-63301', 'u-hayson', '63301', '勞工保險 EC Insurance', 'expense', '63300'),
('coa-hk-63302', 'u-hayson', '63302', '專業責任保險 Professional Indemnity', 'expense', '63300'),
('coa-hk-64100', 'u-hayson', '64100', '市場推廣 Marketing', 'expense', '64000'),
('coa-hk-64101', 'u-hayson', '64101', '廣告費用 Advertising', 'expense', '64100'),
('coa-hk-64102', 'u-hayson', '64102', '網站推廣 Website Promotion', 'expense', '64100'),
('coa-hk-64200', 'u-hayson', '64200', '業務拓展 Business Development', 'expense', '64000'),
('coa-hk-64201', 'u-hayson', '64201', '佣金支出 Commission Expense', 'expense', '64200'),
('coa-hk-64202', 'u-hayson', '64202', '交際應酬費 Entertainment', 'expense', '64200'),
('coa-hk-64300', 'u-hayson', '64300', '差旅交通 Travel & Transport', 'expense', '64000'),
('coa-hk-64301', 'u-hayson', '64301', '本地交通 Local Transport', 'expense', '64300'),
('coa-hk-64302', 'u-hayson', '64302', '海外差旅 Overseas Travel', 'expense', '64300'),
('coa-hk-65100', 'u-hayson', '65100', '銀行費用 Bank Charges', 'expense', '65000'),
('coa-hk-65101', 'u-hayson', '65101', '銀行手續費 Bank Service Fee', 'expense', '65100'),
('coa-hk-65102', 'u-hayson', '65102', '貸款利息 Loan Interest', 'expense', '65100'),
('coa-hk-65200', 'u-hayson', '65200', '匯兌差額 Exchange Difference', 'expense', '65000'),
('coa-hk-65201', 'u-hayson', '65201', '匯兌損失 Exchange Loss', 'expense', '65200'),
('coa-hk-66100', 'u-hayson', '66100', '折舊 Depreciation', 'expense', '66000'),
('coa-hk-66101', 'u-hayson', '66101', '折舊-設備 Depreciation-Equipment', 'expense', '66100'),
('coa-hk-66102', 'u-hayson', '66102', '折舊-電腦 Depreciation-Computer', 'expense', '66100'),
('coa-hk-66200', 'u-hayson', '66200', '雜項支出 Sundry Expenses', 'expense', '66000'),
('coa-hk-66201', 'u-hayson', '66201', '罰款及附加費 Penalties & Surcharges', 'expense', '66200'),
('coa-hk-66202', 'u-hayson', '66202', '捐款 Donations', 'expense', '66200'),
('coa-hk-66203', 'u-hayson', '66203', '其他雜項 Miscellaneous', 'expense', '66200'),

-- ═══════ 80000 利得稅 PROFITS TAX ═══════
-- Level 1
('coa-hk-80000', 'u-hayson', '80000', '利得稅 Profits Tax', 'expense', NULL),
-- Level 3
('coa-hk-81100', 'u-hayson', '81100', '香港利得稅 HK Profits Tax', 'expense', '80000'),
-- Level 4
('coa-hk-81101', 'u-hayson', '81101', '本年度利得稅 Current Year Profits Tax', 'expense', '81100'),
('coa-hk-81102', 'u-hayson', '81102', '遞延稅項 Deferred Tax', 'expense', '81100');
