// Demo-only sample payroll data for the /payroll page.
// See spec: docs/superpowers/specs/2026-08-20-payroll-demo-design.md
import { computeMpf } from '../lib/mpf';

export type MonthStatus = 'paid' | 'pending' | 'scheduled';

export interface SampleStaff {
  id: string;
  name: string;
  nameZh: string;
  nameCn: string;
  title: string;
  titleZh: string;
  titleCn: string;
  gender: 'M' | 'F';
  maritalStatus: 'single' | 'married';
  monthlySalary: number; // HKD gross
  salaryAccount: string; // COA debit code for the salary
}

export const STAFF: SampleStaff[] = [
  { id: 'EMP-0001', name: 'Chan Tai Man', nameZh: '陳大文', nameCn: '陈大文', title: 'Senior Developer', titleZh: '高級開發工程師', titleCn: '高级开发工程师', gender: 'M', maritalStatus: 'married', monthlySalary: 45000, salaryAccount: '61201' },
  { id: 'EMP-0002', name: 'Lee Siu Ming', nameZh: '李小明', nameCn: '李小明', title: 'Accountant', titleZh: '會計師', titleCn: '会计师', gender: 'F', maritalStatus: 'single', monthlySalary: 28000, salaryAccount: '61201' },
  { id: 'EMP-0003', name: 'Wong Ka Yan', nameZh: '黃家欣', nameCn: '黄家欣', title: 'Marketing Executive', titleZh: '市場推廣主任', titleCn: '市场推广主任', gender: 'F', maritalStatus: 'married', monthlySalary: 22500, salaryAccount: '61201' },
  { id: 'EMP-0004', name: 'Ng Man Wai', nameZh: '吳文偉', nameCn: '吴文伟', title: 'Office Assistant', titleZh: '辦公室助理', titleCn: '办公室助理', gender: 'M', maritalStatus: 'single', monthlySalary: 9500, salaryAccount: '61201' },
  { id: 'EMP-0005', name: 'Cheung Mei Ling', nameZh: '張美玲', nameCn: '张美玲', title: 'Part-time Clerk', titleZh: '兼職文員', titleCn: '兼职文员', gender: 'F', maritalStatus: 'married', monthlySalary: 6000, salaryAccount: '61201' },
  { id: 'EMP-0006', name: 'Ho Chi Wai', nameZh: '何志偉', nameCn: '何志伟', title: 'Director', titleZh: '董事', titleCn: '董事', gender: 'M', maritalStatus: 'married', monthlySalary: 60000, salaryAccount: '61102' },
  { id: 'EMP-0007', name: 'Tam Siu Fung', nameZh: '譚兆豐', nameCn: '谭兆丰', title: 'Project Consultant', titleZh: '項目顧問', titleCn: '项目顾问', gender: 'M', maritalStatus: 'single', monthlySalary: 35000, salaryAccount: '51201' },
];

export const MONTHS: string[] = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

// Jan–Jul paid, Aug pending, Sep–Dec scheduled
export const STATUSES: Record<string, Record<string, MonthStatus>> = {};
for (const s of STAFF) {
  STATUSES[s.id] = {};
  MONTHS.forEach((m, i) => {
    STATUSES[s.id][m] = i <= 6 ? 'paid' : i === 7 ? 'pending' : 'scheduled';
  });
}

// Bilingual account names from api/src/db/coa-hk.sql (en / zh-Hant / zh-Hans)
export const COA_ACCOUNTS: Record<string, { code: string; name: string; nameZh: string; nameCn: string }> = {
  '11102': { code: '11102', name: 'HSBC', nameZh: '匯豐銀行', nameCn: '汇丰银行' },
  '21204': { code: '21204', name: 'MPF Payable', nameZh: '應付強積金', nameCn: '应付强积金' },
  '51201': { code: '51201', name: 'Project Staff Salary', nameZh: '項目人員薪酬', nameCn: '项目人员薪酬' },
  '61102': { code: '61102', name: 'Management Salary', nameZh: '管理層薪金', nameCn: '管理层薪金' },
  '61201': { code: '61201', name: 'Staff Salaries', nameZh: '員工薪金', nameCn: '员工薪金' },
  '61202': { code: '61202', name: 'MPF Employer Contribution', nameZh: '強積金僱主供款', nameCn: '强积金雇主供款' },
};

export interface JeLine {
  dr: boolean;
  code: string;
  amount: number;
}

export interface JeBlock {
  id: string;
  title: string;
  titleZh: string;
  titleCn: string;
  lines: JeLine[];
  total: number; // Dr total = Cr total
}

// Two balanced entry blocks for one month (spec §COA debit/credit display):
// Salary payment: Dr {salaryAccount} gross / Cr 11102 net / Cr 21204 employee MPF
// MPF remittance: Dr 61202 employer / Dr 21204 employee / Cr 11102 total
export function buildMonthlyJe(staff: SampleStaff): { salary: JeBlock; mpf: JeBlock } {
  const { employee, employer, net } = computeMpf(staff.monthlySalary);
  return {
    salary: {
      id: 'salary',
      title: 'Salary Payment',
      titleZh: '薪金支付',
      titleCn: '薪金支付',
      lines: [
        { dr: true, code: staff.salaryAccount, amount: staff.monthlySalary },
        { dr: false, code: '11102', amount: net },
        { dr: false, code: '21204', amount: employee },
      ],
      total: staff.monthlySalary,
    },
    mpf: {
      id: 'mpf',
      title: 'MPF Remittance',
      titleZh: '強積金供款',
      titleCn: '强积金供款',
      lines: [
        { dr: true, code: '61202', amount: employer },
        { dr: true, code: '21204', amount: employee },
        { dr: false, code: '11102', amount: employee + employer },
      ],
      total: employee + employer,
    },
  };
}
