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
          whitespace-normal max-w-xs text-sm leading-snug px-3 py-2 rounded-xl shadow-md border
          bg-muted text-primary border-border
          ${side === 'top' ? 'bottom-full left-1/2 -translate-x-1/2 mb-2' : 'top-full left-1/2 -translate-x-1/2 mt-2'}
        `}
      >
        {content}
      </span>
    </span>
  );
}
