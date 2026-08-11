import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { buildFiscalYearOptions, type FiscalYearOption } from '../lib/fiscalYear';

interface DateFilterState {
  selectedFY: string;            // e.g. "2025-2026"
  fyOptions: FiscalYearOption[];
  startDate: string;             // e.g. "2025-04-01"
  endDate: string;               // e.g. "2026-03-31"
  setSelectedFY: (fy: string) => void;
  /** The raw fiscal year number(s), e.g. 2025 or [2025,2026] — useful for statement_year filters */
  fyStartYear: number;
  fyEndYear: number;
}

const DateFilterContext = createContext<DateFilterState | null>(null);

export function DateFilterProvider({ children }: { children: React.ReactNode }) {
  const { data: fiscalData } = useQuery({
    queryKey: ['fiscal-period'],
    queryFn: () => api('/bookkeeping/fiscal-period') as Promise<{
      fiscal_year_start?: string;
      fiscal_year_end?: string;
      start?: string;
      end?: string;
    }>,
  });

  const fyStartMD = fiscalData?.fiscal_year_start || fiscalData?.start || '04-01';
  const fyEndMD = fiscalData?.fiscal_year_end || fiscalData?.end || '03-31';

  const fyOptions = useMemo(
    () => buildFiscalYearOptions(fyStartMD, fyEndMD),
    [fyStartMD, fyEndMD],
  );

  // Default: most recent COMPLETED fiscal year (endDate <= today), falling back to current
  const today = new Date().toISOString().split('T')[0];
  const completedFYs = fyOptions.filter(o => o.endDate <= today);
  const defaultFY = completedFYs.length > 0
    ? completedFYs[completedFYs.length - 1].value   // most recent completed FY
    : fyOptions.length > 0 ? fyOptions[fyOptions.length - 1].value : '';

  const [selectedFY, setSelectedFY] = useState<string>(() => {
    const stored = localStorage.getItem('globalFiscalYear');
    // Validate stored value still exists in options
    if (stored && fyOptions.some(o => o.value === stored)) return stored;
    return defaultFY;
  });

  // Update if default changes and nothing is stored
  useEffect(() => {
    const stored = localStorage.getItem('globalFiscalYear');
    if (!stored && defaultFY) setSelectedFY(defaultFY);
  }, [defaultFY]);

  // Persist to localStorage on change
  useEffect(() => {
    if (selectedFY) localStorage.setItem('globalFiscalYear', selectedFY);
  }, [selectedFY]);

  const activeOption = fyOptions.find(o => o.value === selectedFY) || fyOptions[fyOptions.length - 1] || null;

  const startDate = activeOption?.startDate || '';
  const endDate = activeOption?.endDate || '';
  // Parse years from startDate/endDate (format: YYYY-MM-DD)
  const fyStartYear = startDate ? parseInt(startDate.slice(0, 4), 10) : new Date().getFullYear();
  const fyEndYear = endDate ? parseInt(endDate.slice(0, 4), 10) : new Date().getFullYear();

  return (
    <DateFilterContext.Provider value={{
      selectedFY, fyOptions, startDate, endDate, setSelectedFY, fyStartYear, fyEndYear,
    }}>
      {children}
    </DateFilterContext.Provider>
  );
}

export function useDateFilter(): DateFilterState {
  const ctx = useContext(DateFilterContext);
  if (!ctx) throw new Error('useDateFilter must be used within DateFilterProvider');
  return ctx;
}
