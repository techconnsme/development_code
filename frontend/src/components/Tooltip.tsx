import React from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom';
}

export default function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  if (!content) return children;
  return (
    <span className="relative group/tooltip inline-flex">
      {children}
      <span
        className={`absolute z-50 pointer-events-none opacity-0 group-hover/tooltip:opacity-100 transition-opacity duration-150
          whitespace-normal max-w-xs text-xs leading-snug px-2.5 py-1.5 rounded-md shadow-lg
          bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
          ${side === 'top' ? 'bottom-full left-1/2 -translate-x-1/2 mb-1.5' : 'top-full left-1/2 -translate-x-1/2 mt-1.5'}
        `}
      >
        {content}
      </span>
    </span>
  );
}
