// Depreciation calculation helpers.
// Extracted from fixed-assets.ts for testability.

export interface Asset {
  id: string;
  cost: number;
  salvage_value: number;
  useful_life_years: number;
  monthly_depreciation: number;
  accumulated_depreciation: number;
  net_book_value: number;
  depn_account_code: string;
  acc_depn_account_code: string;
  asset_name: string;
  is_active?: number | boolean;
}

export interface CustomScheduleLine {
  period: number;
  rate: number | null;
  amount: number | null;
}

export interface CustomSchedule {
  period_type: 'monthly' | 'yearly';
  lines: CustomScheduleLine[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCustomSchedule(
  schedule: CustomSchedule,
  depreciableAmount: number,
): ValidationResult {
  const errors: string[] = [];

  if (!schedule.lines || schedule.lines.length === 0) {
    errors.push('Schedule must have at least one line');
    return { valid: false, errors };
  }

  let totalAmount = 0;
  for (const line of schedule.lines) {
    if (line.rate !== null && line.amount !== null) {
      errors.push(`Period ${line.period}: cannot set both rate and amount`);
    } else if (line.rate === null && line.amount === null) {
      errors.push(`Period ${line.period}: must set either rate or amount`);
    } else if (line.rate !== null) {
      if (line.rate <= 0 || line.rate > 100) {
        errors.push(`Period ${line.period}: rate must be between 0 and 100`);
      }
      totalAmount += depreciableAmount * line.rate / 100;
    } else if (line.amount !== null) {
      if (line.amount <= 0) {
        errors.push(`Period ${line.period}: amount must be positive`);
      }
      totalAmount += line.amount;
    }
  }

  if (totalAmount > depreciableAmount * 1.001) {
    errors.push(`Total depreciation (${totalAmount}) exceeds depreciable amount (${depreciableAmount})`);
  }

  return { valid: errors.length === 0, errors };
}

export function calculateCustomPeriodDepreciation(
  schedule: CustomSchedule,
  periodNumber: number,
  cost: number,
): number | null {
  const line = schedule.lines.find(l => l.period === periodNumber);
  if (!line) return null;

  if (line.amount !== null) return line.amount;
  if (line.rate !== null) return Math.round(cost * line.rate / 100 * 100) / 100;
  return null;
}

export interface DepreciationLine {
  asset_id: string;
  asset_name: string;
  account_code: string;
  account_name: string;
  description: string;
  debit: number;
  credit: number;
  type: 'dr' | 'cr';
}

/**
 * Calculate monthly depreciation for an asset using straight-line method.
 * Formula: (cost - salvage_value) / (useful_life_years * 12)
 */
export function calculateMonthlyDepreciation(
  cost: number,
  salvageValue: number,
  usefulLifeYears: number,
): number {
  if (usefulLifeYears <= 0 || cost <= 0) return 0;
  const depreciableAmount = cost - salvageValue;
  if (depreciableAmount <= 0) return 0;
  return Math.round((depreciableAmount / (usefulLifeYears * 12)) * 100) / 100;
}

/**
 * Calculate actual depreciation for a single asset for one period.
 * Returns the amount to depreciate, capped at remaining depreciable amount.
 */
export function calculatePeriodDepreciation(asset: Asset): number {
  const monthlyDepn = asset.monthly_depreciation;
  const remainingBook = asset.net_book_value - (asset.salvage_value || 0);
  const actualDepn = Math.min(monthlyDepn, Math.max(remainingBook, 0));
  return Math.round(actualDepn * 100) / 100;
}

/**
 * Build journal entry lines for a set of asset depreciations.
 * Returns Dr Depreciation Expense / Cr Accumulated Depreciation line pairs.
 */
export function buildDepreciationLines(
  depreciations: Array<{ asset: Asset; amount: number }>,
): DepreciationLine[] {
  const lines: DepreciationLine[] = [];
  for (const { asset, amount } of depreciations) {
    if (amount <= 0) continue;
    const depnAccount = asset.depn_account_code || '66101';
    const accDepnAccount = asset.acc_depn_account_code || '12301';
    // Dr Depreciation Expense
    lines.push({
      asset_id: asset.id,
      asset_name: asset.asset_name,
      account_code: depnAccount,
      account_name: asset.asset_name,
      description: `Depreciation: ${asset.asset_name}`,
      debit: amount,
      credit: 0,
      type: 'dr',
    });
    // Cr Accumulated Depreciation
    lines.push({
      asset_id: asset.id,
      asset_name: asset.asset_name,
      account_code: accDepnAccount,
      account_name: asset.asset_name,
      description: `Accum depn: ${asset.asset_name}`,
      debit: 0,
      credit: amount,
      type: 'cr',
    });
  }
  return lines;
}

/**
 * Generate journal entry number for depreciation.
 * Format: JE-DEPN-YYYY-MM
 */
export function generateDepreciationEntryNumber(periodEndDate: string): string {
  return `JE-DEPN-${periodEndDate.slice(0, 7)}`;
}

/**
 * Check if an asset is eligible for depreciation.
 */
export function isEligibleForDepreciation(asset: Asset): boolean {
  // Check if asset is active (is_active is 1 or true, or undefined for backward compatibility)
  const isActive = asset.is_active === undefined || asset.is_active === 1 || asset.is_active === true;
  if (!isActive) return false;

  return (
    asset.monthly_depreciation > 0 &&
    asset.net_book_value > (asset.salvage_value || 0)
  );
}
