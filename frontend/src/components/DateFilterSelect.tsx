import { Calendar } from 'lucide-react';
import { useDateFilter } from '../contexts/DateFilterContext';

export default function DateFilterSelect() {
  const { selectedFY, fyOptions, setSelectedFY } = useDateFilter();

  const currentOption = fyOptions.find(o => o.value === selectedFY);
  const displayLabel = currentOption?.label || 'Select FY';

  if (fyOptions.length === 0) return null;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Calendar className="h-3.5 w-3.5" />
        <span>Fiscal Year</span>
      </div>
      <select
        value={selectedFY || ''}
        onChange={e => setSelectedFY(e.target.value)}
        className="w-full px-2 py-1.5 text-xs border rounded-md bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {fyOptions.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
