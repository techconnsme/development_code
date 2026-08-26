import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { Search, X } from 'lucide-react';

export interface PickedFile { id: string; filename: string }

const MAX_ATTACHMENTS = 10;

export default function DocumentPickerModal({ alreadyPicked, onPick, onClose }: {
  alreadyPicked: string[];
  onPick: (picked: PickedFile[]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<PickedFile[]>([]);
  const [preview, setPreview] = useState<PickedFile | null>(null);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', '200');
  const { data } = useQuery({
    queryKey: ['file-storage-list', q],
    queryFn: () => api(`/file-storage?${qs.toString()}`),
  });
  const files: any[] = data?.data || [];
  const visible = files.filter(f => !cat || (f.category || 'general') === cat);
  const atCap = sel.length >= MAX_ATTACHMENTS;
  const CATEGORIES = [
    ['', tr('All types', '所有類型', '所有类型')],
    ['bank_statement', tr('Bank statements', '銀行月結單', '银行月结单')],
    ['card_statement', tr('Card statements', '信用卡月結單', '信用卡月结单')],
    ['invoice', tr('Invoices', '發票', '发票')],
    ['receipt', tr('Receipts', '收據', '收据')],
    ['general', tr('Other', '其他', '其他')],
  ];

  function toggle(f: any) {
    const picked = { id: f.id, filename: f.original_name || f.filename };
    setSel(prev => {
      if (prev.some(p => p.id === f.id)) return prev.filter(p => p.id !== f.id);
      if (prev.length >= MAX_ATTACHMENTS) return prev;
      return [...prev, picked];
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl w-full max-w-5xl h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-bold">{tr('Attach Documents', '附加文件', '附加文件')}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <div className="px-4 py-2 border-b">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Search files…', '搜尋檔案…', '搜索文件…')}
              className="w-full pl-9 pr-3 py-2 border rounded-md bg-background text-sm" />
          </div>
          <select value={cat} onChange={(e) => setCat(e.target.value)}
            className="mt-2 px-3 py-1.5 border rounded-md bg-background text-xs">
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-1/2 border-r overflow-y-auto">
            {visible.map((f: any) => {
              const attached = alreadyPicked.includes(f.id);
              const checked = attached || sel.some(p => p.id === f.id);
              return (
                <label key={f.id} className={`flex items-center gap-2 px-4 py-2 border-b border-muted/30 text-sm ${attached ? 'opacity-50' : 'hover:bg-muted/30 cursor-pointer'}`}>
                  <input type="checkbox" disabled={attached || (atCap && !checked)} checked={checked} onChange={() => toggle(f)} />
                  <button type="button" className="flex-1 text-left truncate" onClick={(e) => { e.preventDefault(); setPreview({ id: f.id, filename: f.original_name || f.filename }); }}>
                    {f.original_name || f.filename}
                  </button>
                  <span className="text-xs text-muted-foreground shrink-0">{f.category || f.folder}</span>
                  {attached && <span className="text-xs text-amber-600 shrink-0">{tr('attached', '已附加', '已附加')}</span>}
                </label>
              );
            })}
            {visible.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">{tr('No files found.', '找不到檔案。', '找不到文件。')}</div>
            )}
          </div>
          <div className="w-1/2 flex items-center justify-center bg-muted/10">
            {preview ? (
              <iframe title={preview.filename} className="w-full h-full"
                src={`${WORKER_API_BASE}/file-storage/${preview.id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`} />
            ) : (
              <span className="text-sm text-muted-foreground">{tr('Select a file to preview', '選擇檔案以預覽', '选择文件以预览')}</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t">
          <span className="text-xs text-muted-foreground">
            {sel.length > 0 && `${sel.length}/${MAX_ATTACHMENTS}`}
            {atCap && ` · ${tr('Max 10', '最多10個', '最多10个')}`}
          </span>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
            <button onClick={() => { onPick(sel); onClose(); }} disabled={sel.length === 0}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-50">
              {tr(`Attach${sel.length ? ` (${sel.length})` : ''}`, `附加${sel.length ? `（${sel.length}）` : ''}`, `附加${sel.length ? `（${sel.length}）` : ''}`)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
