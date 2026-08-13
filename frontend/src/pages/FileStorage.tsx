import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import EncryptedPdfModal from '../components/EncryptedPdfModal';
import { useToast } from '../components/Toast';
import { Upload, Download, Trash2, Search, Pencil, X, Check, File, FileText, FileSpreadsheet, Image, FolderOpen, Folder, ChevronRight, ChevronDown, Zap, Sparkles, CheckCircle2, Eye } from 'lucide-react';
import SupervisorPasswordModal from '../components/SupervisorPasswordModal';
import { useAuth } from '../contexts/AuthContext';
import { tr } from '../lib/i18nHelpers';
import i18n from '../i18n';
import { relativeTimeBucket, parseCreatedAt } from '../lib/time';

// Build query string for review page flags from API response
function reviewPageFlags(result: any): string {
  const params = new URLSearchParams();
  if (result?.needs_direction_review) params.set('review_direction', '1');
  if (result?.company_not_detected) params.set('company_not_detected', '1');
  if (result?.is_duplicate) params.set('is_duplicate', '1');
  if (result?.duplicate_status) params.set('dup_status', result.duplicate_status);
  if (result?.auto_linked_invoice_id) params.set('auto_linked', result.auto_linked_invoice_id);
  if (result?.direction) params.set('direction', result.direction);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileIcon(type: string) {
  if (type.includes('pdf')) return <FileText className="h-5 w-5 text-red-500" />;
  if (type.includes('sheet') || type.includes('excel') || type.includes('xls') || type.includes('csv')) return <FileSpreadsheet className="h-5 w-5 text-green-600" />;
  if (type.includes('image') || type.includes('png') || type.includes('jpg')) return <Image className="h-5 w-5 text-blue-500" />;
  return <File className="h-5 w-5 text-gray-500" />;
}

function autoFolder(filename: string, fileType: string): string {
  // Backend classifyFile handles specific types (Bank Statements, Card Statements, Invoices, Receipts).
  // Frontend fallback: everything else goes to Others.
  return 'Others';
}

async function downloadFile(id: string, filename: string) {
  const token = localStorage.getItem('token');
  const res = await fetch(`/api/file-storage/${id}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface FileItem {
  id: string;
  filename: string;
  original_name?: string;
  file_type: string;
  file_size: number;
  folder: string;
  description?: string;
  category?: string;
  direction?: string;
  payment_status?: string;
  amount?: number;
  created_at: string;
  // Linked records (from API JOIN)
  invoice_id?: string;
  invoice_number?: string;
  invoice_status?: string;
  invoice_needs_review?: string;
  vendor_name?: string;
  customer_name?: string;
  invoice_direction?: string;
  statement_id?: string;
  stmt_bank_name?: string;
  stmt_status?: string;
  card_statement_id?: string;
  card_issuer?: string;
  card_status?: string;
  ocr_status?: string;
}

interface TreeNode {
  name: string;
  path: string;
  files: FileItem[];
  children: TreeNode[];
}

function buildTree(files: FileItem[]): TreeNode {
  const root: TreeNode = { name: 'All Files', path: '', files: [], children: [] };
  for (const f of files) {
    const parts = (f.folder || 'Other').split('/');
    let node = root;
    for (const part of parts) {
      let child = node.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: [...(node.path ? [node.path] : []), part].join('/'), files: [], children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  // Sort: folders first, then files; folders alphabetically
  const sortNode = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

const RELATIVE_LOCALE: Record<string, string> = { en: 'en', 'zh-Hant': 'zh-HK', 'zh-Hans': 'zh-CN' };

function FileTimeLabel({ createdAt }: { createdAt: string }) {
  const parsed = parseCreatedAt(createdAt);
  if (!parsed) return <span>{createdAt}</span>;

  const bucket = relativeTimeBucket(createdAt);
  const locale = RELATIVE_LOCALE[i18n.language] || 'en';
  const text = bucket.kind === 'date'
    ? bucket.date
    : bucket.kind === 'relative'
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-bucket.value, bucket.unit)
      : bucket.raw;
  const full = parsed.toLocaleString('en-HK', { hour12: false });

  return <span title={full}>{text}</span>;
}

function FolderTree({ node, depth, expanded, toggle, onFileAction, onSetDirection, onDelete, onUnlockEncrypted }: {
  node: TreeNode; depth: number; expanded: Set<string>; toggle: (p: string) => void;
  onFileAction: (action: string, f: FileItem) => void;
  onSetDirection: (id: string, direction: string) => void;
  onDelete: (f: FileItem) => void;
  onUnlockEncrypted: (f: FileItem) => void;
}) {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const isExpanded = expanded.has(node.path) || depth === 0;
  const hasContent = node.children.length > 0 || node.files.length > 0;

  return (
    <div>
      {depth > 0 && hasContent && (
        <button onClick={() => toggle(node.path)}
          className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded-md px-2 py-1.5"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}>
          {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          {isExpanded ? <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" /> : <Folder className="h-4 w-4 text-amber-500 shrink-0" />}
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground">({node.files.length})</span>
        </button>
      )}
      {isExpanded && (
        <>
          {node.children.map(child => (
            <FolderTree key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} onFileAction={onFileAction} onSetDirection={onSetDirection} onDelete={onDelete} onUnlockEncrypted={onUnlockEncrypted} />
          ))}
          {node.files.map(f => (
            <div key={f.id} className="flex items-center justify-between hover:bg-muted/30 rounded-md px-2 py-1.5"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {fileIcon(f.file_type)}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{f.filename || f.original_name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatSize(f.file_size || 0)}</span>
                    {f.created_at && <FileTimeLabel createdAt={f.created_at} />}
                    {f.category === 'invoice' && f.direction && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        f.direction === 'outgoing' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
                      }`}>{f.direction === 'outgoing' ? tr('Sales', '銷售', '销售') : tr('Purchase', '採購', '采购')}</span>
                    )}
                    {f.category === 'invoice' && f.payment_status && f.payment_status !== 'unmatched' && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        f.payment_status === 'received' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : f.payment_status === 'paid' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                        : 'bg-gray-100 text-gray-700'
                      }`}>{f.payment_status === 'received' ? tr('Received', '已收', '已收') : f.payment_status === 'paid' ? tr('Paid', '已付', '已付') : f.payment_status}</span>
                    )}
                    {f.category === 'invoice' && f.amount != null && (
                      <span className="font-mono">${f.amount.toLocaleString()}</span>
                    )}
                    {f.category === 'invoice' && (f.vendor_name || f.customer_name) && (
                      ((f.direction || f.invoice_direction) === 'outgoing')
                        ? <span className="text-[10px] text-muted-foreground block truncate" title={`${authUser?.company_name || 'You'} → ${f.customer_name || ''}`}>{authUser?.company_name || 'You'} → {f.customer_name}</span>
                        : <span className="text-[10px] text-muted-foreground block truncate" title={`${f.vendor_name || ''} → ${authUser?.company_name || 'You'}`}>{f.vendor_name} → {authUser?.company_name || 'You'}</span>
                    )}
                    {f.ocr_status === 'encrypted' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onUnlockEncrypted(f); }}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 hover:bg-amber-200 cursor-pointer"
                        title={tr('Click to unlock with password', '點擊以輸入密碼解鎖', '点击以输入密码解锁')}
                      >
                        🔒 {tr('Encrypted', '已加密', '已加密')}
                      </button>
                    )}
                    {f.description && <span className="truncate max-w-[200px]">— {f.description}</span>}
                  </div>
                </div>
              </div>
              <div className="flex gap-1 ml-2 shrink-0">
                {/* Review button — link to the processed document's review page */}
                {(() => {
                  if (f.invoice_id) {
                    return (
                      <a href={`/invoices/review/${f.invoice_id}`}
                        className="p-1 hover:bg-blue-100 rounded text-blue-600 inline-flex" title={tr('Review invoice', '審核發票', '审核发票')}>
                        <Eye className="h-3.5 w-3.5" />
                      </a>
                    );
                  }
                  if (f.statement_id) {
                    return (
                      <a href={`/bank-statements/review/${f.statement_id}`}
                        className="p-1 hover:bg-blue-100 rounded text-blue-600 inline-flex" title={tr('Review bank statement', '審核銀行月結單', '审核银行月结单')}>
                        <Eye className="h-3.5 w-3.5" />
                      </a>
                    );
                  }
                  if (f.card_statement_id) {
                    return (
                      <a href={`/card-statements/review/${f.card_statement_id}`}
                        className="p-1 hover:bg-blue-100 rounded text-blue-600 inline-flex" title={tr('Review card statement', '審核信用卡月結單', '审核信用卡月结单')}>
                        <Eye className="h-3.5 w-3.5" />
                      </a>
                    );
                  }
                  return null;
                })()}
                {/* Amended flag */}
                {f.invoice_needs_review && (
                  <span className="px-1 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-medium" title={tr('Manually amended in review', '已在審核中手動修改', '已在审核中手动修改')}>
                    {tr('Edited', '已編輯', '已编辑')}
                  </span>
                )}
                {f.category === 'invoice' && (
                  <button onClick={() => onSetDirection(f.id, f.direction === 'outgoing' ? 'incoming' : 'outgoing')}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                      f.direction === 'outgoing' ? 'border-blue-300 text-blue-600 hover:bg-blue-50' :
                      f.direction === 'incoming' ? 'border-orange-300 text-orange-600 hover:bg-orange-50' :
                      'border-gray-300 text-gray-500 hover:bg-gray-50'
                    }`} title={tr('Toggle Sales/Purchase', '切換銷售/採購', '切换销售/采购')}>
                    {!f.direction ? '?' : f.direction === 'outgoing' ? tr('S', '銷', '销') : tr('P', '採', '采')}
                  </button>
                )}
                <button onClick={() => downloadFile(f.id, f.filename || 'file')} className="p-1 hover:bg-muted rounded"><Download className="h-3.5 w-3.5" /></button>
                <button onClick={() => onFileAction('edit', f)} className="p-1 hover:bg-muted rounded"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => onDelete(f)} className="p-1 hover:bg-muted rounded text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function FileStorage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff' || user?.role === 'viewer';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [processingMsg, setProcessingMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const batchRef = useRef({ total: 0, done: 0, errors: 0, bank: 0, invoice: 0, receipt: 0, card: 0, navigated: false, queue: [] as {docType:string, reviewId:string, filename:string, flags:string}[] });
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [filterFolder, setFilterFolder] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editFolder, setEditFolder] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [supModal, setSupModal] = useState<{ show: boolean; onConfirm: () => void } | null>(null);
  const [encryptedPdf, setEncryptedPdf] = useState<{ fileId: string; fileName: string } | null>(null);
  // Issue 17: type-choice modal shown when AI can't confidently decide document type
  const [typeChoice, setTypeChoice] = useState<{
    show: boolean;
    fileId: string;
    filename: string;
    bankScore: number;
    invoiceScore: number;
  } | null>(null);
  // Duplicate bank statement popup
  const [dupWarning, setDupWarning] = useState<{
    show: boolean;
    fileId: string;
    bankName: string | null;
    period: string | null;
    existingFileName: string | null;
    statementId: string | null;
    invoiceId: string | null;       // for invoice/receipt duplicates
    dupType: 'bank_statement' | 'invoice' | 'receipt' | 'file' | null;
    dupNumber: string | null;       // e.g. "2025001" or folder name
    dupVendor: string | null;       // or upload date
    pendingFile?: File | null;
  } | null>(null);

  const { data: files, isLoading } = useQuery({
    queryKey: ['file-storage', filterFolder, searchQ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterFolder) params.set('folder', filterFolder);
      if (searchQ) params.set('q', searchQ);
      const qs = params.toString();
      return api(`/file-storage${qs ? `?${qs}` : ''}`);
    },
  });

  const { data: folders } = useQuery({
    queryKey: ['file-storage-folders'],
    queryFn: () => api('/file-storage/folders'),
  });

  const uploadMut = useMutation({
    mutationFn: (body: unknown) => api('/file-storage/upload', { method: 'POST', body, baseUrl: WORKER_API_BASE }),
    onSuccess: async (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage-folders'] });
      setDescription('');
      // Auto-import as bank statement → redirect to review page
      const fileId = data?.id;
      if (!fileId) {
        setUploading(false);
        return;
      }
      try {
        setProcessingMsg('Running OCR and detecting document type… (this may take 20–40 seconds)');

        // Use raw fetch so we can handle 409 (duplicate) without the api() helper throwing
        const token = localStorage.getItem('token') || '';
        const activeClient = localStorage.getItem('activeClient');
        const importHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        };
        if (activeClient) {
          try { const c = JSON.parse(activeClient); if (c?.id) importHeaders['X-Active-Client'] = c.id; } catch {}
        }
        const importResp = await fetch(
          `https://opcc-crm-api.ruhan-farhan.workers.dev/api/file-storage/${fileId}/import-document`,
          { method: 'POST', headers: importHeaders }
        );
        const result: any = await importResp.json();
        if (result?.ocr_text) console.log(`[OCR-RAW|${result.ocr_source || 'unknown'}]`, result.ocr_text);
        if (result?.deepseek_raw) console.log(`[DeepSeek|${result.ocr_source || 'unknown'}]`, JSON.parse(result.deepseek_raw));

        setProcessingMsg(null);
        setUploading(false);
        const docType = result?.type;
        const bankScore = result?.scores?.bankScore ?? 0;
        const invoiceScore = result?.scores?.invoiceScore ?? 0;
        const scoreDiff = Math.abs(bankScore - invoiceScore);

        // Duplicate bank statement detected (409)
        if ((importResp.status === 409 && (result?.type === 'bank_statement' || result?.error === 'Statement already imported')) || result?.error === 'Statement already imported') {
          setDupWarning({
            show: true,
            fileId,
            bankName: result.duplicate_info?.bank_name || null,
            period: result.duplicate_info?.period || null,
            existingFileName: result.duplicate_info?.file_name || null,
            statementId: result.statement_id || null,
            invoiceId: null,
            dupType: 'bank_statement',
            dupNumber: null,
            dupVendor: null,
          });
          return;
        }

        // Duplicate invoice or receipt detected (409)
        if (importResp.status === 409 && result?.type !== 'bank_statement') {
          setDupWarning({
            show: true,
            fileId,
            bankName: null,
            period: null,
            existingFileName: null,
            statementId: null,
            invoiceId: result.invoice_id || null,
            dupType: result.duplicate_info?.type || (result?.error?.toLowerCase().includes('receipt') ? 'receipt' : 'invoice'),
            dupNumber: result.duplicate_info?.number || null,
            dupVendor: result.duplicate_info?.vendor || null,
          });
          return;
        }

        // Only show type-choice popup if BOTH scores are non-zero and genuinely tied.
        // Filename pre-scoring on the backend means score 0/0 never happens for known formats.
        if (bankScore > 0 && invoiceScore > 0 && scoreDiff < 2) {
          setTypeChoice({
            show: true,
            fileId,
            filename: data?.filename || data?.original_name || 'this file',
            bankScore,
            invoiceScore,
          });
          return;
        }

        const isBatch = batchRef.current.total > 1;

        // Build review queue entry
        const filename = data?.filename || data?.original_name || '';
        let reviewId = '', docTypeStr = docType as string, flags = '';
        if (docType === 'bank_statement') reviewId = result?.statement_id;
        else if (docType === 'card_statement') reviewId = result?.statement_id;
        else if (docType === 'invoice') { reviewId = result?.invoice_id; flags = reviewPageFlags(result); }

        console.log('[BATCH] onSuccess: docType=', docType, 'reviewId=', reviewId, 'isBatch=', isBatch, 'batchTotal=', batchRef.current.total);
        if (isBatch && reviewId) {
          console.log('[BATCH] queuing file, queue length was', (JSON.parse(sessionStorage.getItem('reviewQueue')||'[]')).length);
          // User clicks "Review pending" toast to start the review flow
          const stored = sessionStorage.getItem('reviewQueue');
          let queue: {docType:string, reviewId:string, filename:string, flags:string}[] = [];
          try { if (stored) queue = JSON.parse(stored); } catch {}
          queue.push({ docType: docTypeStr, reviewId, filename, flags });
          sessionStorage.setItem('reviewQueue', JSON.stringify(queue));
          sessionStorage.setItem('reviewQueueTotal', String(batchRef.current.total));

          batchRef.current.done++;
          if (docType === 'bank_statement') batchRef.current.bank++;
          else if (docType === 'invoice') batchRef.current.invoice++;
          else if (docType === 'receipt') batchRef.current.receipt++;
          else if (docType === 'card_statement') batchRef.current.card++;

          if (batchRef.current.done >= batchRef.current.total) {
            const b = batchRef.current;
            const parts: string[] = [];
            if (b.bank > 0) parts.push(`${b.bank} bank`);
            if (b.card > 0) parts.push(`${b.card} card`);
            if (b.invoice > 0) parts.push(`${b.invoice} invoice`);
            if (b.receipt > 0) parts.push(`${b.receipt} receipt`);
            const total = queue.length;
            const label = parts.join(', ');
            // Show clickable toast that starts the review flow
            toast.info(
              `📋 Batch complete: ${label} (${total} total). Go to the respective page to review them.`
            );
            queryClient.invalidateQueries({ queryKey: ['invoices'] });
            queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
            queryClient.invalidateQueries({ queryKey: ['card-statements'] });
            queryClient.invalidateQueries({ queryKey: ['file-storage'] });
            batchRef.current = { total: 0, done: 0, errors: 0, bank: 0, invoice: 0, receipt: 0, card: 0, navigated: false, queue: [] };
          }
          return;
        }

        // Single file: navigate directly to review
        // Only navigate if user is still on File Storage page (prevents redirecting
        // away from wherever the user navigated to while OCR was processing)
        const onFileStorage = window.location.pathname.includes('/file-storage');
        if (docType === 'bank_statement' && result?.statement_id) {
          if (result?.ocr_failed) toast.warning('Could not auto-read. Please enter details manually.');
          if (onFileStorage) navigate(`/bank-statements/review/${result.statement_id}`);
          else toast.info(`Bank statement imported: ${data?.filename || 'file'}`);
        } else if (docType === 'invoice' && result?.invoice_id) {
          if (result?.ocr_failed) toast.warning('Could not auto-read. Please enter details manually.');
          if (onFileStorage) navigate(`/invoices/review/${result.invoice_id}${flags}`);
          else toast.info(`Invoice imported: ${data?.filename || 'file'}`);
        } else if (docType === 'card_statement' && result?.statement_id) {
          if (onFileStorage) navigate(`/card-statements/review/${result.statement_id}`);
          else toast.info(`Card statement imported: ${data?.filename || 'file'}`);
        } else if (result?.error) {
          toast.error(`Could not auto-process: ${result.error}`);
        }
      } catch (err: any) {
        setProcessingMsg(null);
        setUploading(false);
        if (batchRef.current.total > 1) batchRef.current.errors++;
        toast.error(`Could not process file: ${err?.message || 'Unknown error'}`);
      }
    },
    onError: (err: any) => {
      setProcessingMsg(null);
      if (batchRef.current.total > 1) batchRef.current.errors++;
      toast.error(`Upload failed: ${err?.message || err?.error || 'Unknown error'}`);
      setUploading(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/file-storage/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage-folders'] });
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/file-storage/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage-folders'] });
      setEditingId(null);
    },
  });

  const [matchResults, setMatchResults] = useState<any[] | null>(null);

  const autoMatchMut = useMutation({
    mutationFn: () => api('/file-storage/auto-match-invoices', { method: 'POST' }),
    onSuccess: (data: any) => {
      if (data.matched?.length > 0) {
        setMatchResults(data.matched);
      } else {
        toast.info(tr('No matches found.', '沒有找到配對。', '没有找到配对。'));
      }
    },
  });

  const confirmFileMatchMut = useMutation({
    mutationFn: (body: { transaction_id: string; file_id: string; invoice_id?: string }) =>
      api('/file-storage/confirm-match', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage-folders'] });
    },
  });

  const importStmtMut = useMutation({
    mutationFn: (id: string) => api(`/file-storage/${id}/import-statement`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage-folders'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      toast.success(tr(`Bank statement imported!\nTransactions: ${data.transactions_count || 0}\nBank: ${data.bank_name || 'Unknown'}`, `已匯入銀行月結單！\n交易筆數：${data.transactions_count || 0}\n銀行：${data.bank_name || '未知'}`, `已汇入银行月结单！\n交易笔数：${data.transactions_count || 0}\n银行：${data.bank_name || '未知'}`));
    },
    onError: (err: any) => {
      toast.error(tr(`Import failed: ${err?.message || err?.error || 'Unknown error'}`, `匯入失敗：${err?.message || err?.error || '未知錯誤'}`, `汇入失败：${err?.message || err?.error || '未知错误'}`));
    },
  });

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;

    // Batch mode: track counts so we can suppress navigation and show summary
    const isBatch = arr.length > 1;
    console.log('[BATCH] uploadFiles called with', arr.length, 'files. isBatch:', isBatch);
    if (isBatch) {
      batchRef.current = { total: arr.length, done: 0, errors: 0, bank: 0, invoice: 0, receipt: 0, card: 0, navigated: false, queue: [] };
      console.log('[BATCH] initialized batchRef, total:', arr.length);
    }

    for (const file of arr) {
      // ── General duplicate check: same filename already in system ──────
      // Skip for PDFs, images, and Excel files — they go through auto-processing
      // which has its own better duplicate detection (by invoice number, bank period, etc.)
      const lowerName = file.name.toLowerCase();
      const isAutoProcessable = /\.(pdf|jpg|jpeg|png|gif|webp|bmp|xlsx|xls|csv)$/i.test(lowerName);

      if (!isAutoProcessable) {
        try {
          const dupCheck: any = await api(`/file-storage/check-duplicate?filename=${encodeURIComponent(file.name)}`);
          if (dupCheck?.exists && dupCheck?.existing_file) {
            const ef = dupCheck.existing_file;
            setDupWarning({
              show: true,
              fileId: '',
              bankName: null,
              period: null,
              existingFileName: ef.filename || ef.original_name,
              statementId: null,
              invoiceId: null,
              dupType: 'file',
              dupNumber: ef.folder || 'Uploads',
              dupVendor: ef.created_at?.slice(0, 10) || '',
              pendingFile: file,
            });
            return; // modal handles the rest via handleDupChoice
          }
        } catch { /* if check fails, proceed with upload */ }
      }

      // ── Pre-upload duplicate check for bank statements ──────────────
      const isBankStatement =
        /hsbc|hang.?seng|bank.?of.?china|boc|standard.?chartered|citibank|dbs|statement/i.test(lowerName) &&
        /\.(pdf|jpg|jpeg|png)$/i.test(lowerName);

      if (isBankStatement) {
        // Extract bank name and period from filename
        const bankMatch = /hsbc|hang.?seng|boc|standard.?chartered|citibank|dbs/i.exec(lowerName);
        const periodMatch = /(20\d{2})[_\-]?(0[1-9]|1[0-2])/i.exec(file.name);

        if (periodMatch) {
          const year = parseInt(periodMatch[1]);
          const month = parseInt(periodMatch[2]);
          // Fetch existing statements and check for same period + bank
          try {
            const token = localStorage.getItem('token') || '';
            const activeClient = localStorage.getItem('activeClient');
            const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` };
            if (activeClient) {
              try { const cl = JSON.parse(activeClient); if (cl?.id) headers['X-Active-Client'] = cl.id; } catch {}
            }
            const resp = await fetch(
              `https://opcc-crm-api.ruhan-farhan.workers.dev/api/bank-statements?show_drafts=1`,
              { headers }
            );
            if (resp.ok) {
              const data: any = await resp.json();
              const existing = (data.data || []).find((s: any) =>
                s.statement_year === year &&
                s.statement_month === month &&
                (!bankMatch || (s.bank_name || '').toUpperCase().includes(bankMatch[0].toUpperCase()))
              );
              if (existing) {
                // Show duplicate popup — don't upload yet
                setDupWarning({
                  show: true,
                  fileId: '',           // empty — file not uploaded yet
                  bankName: existing.bank_name,
                  period: `${year}-${String(month).padStart(2, '0')}`,
                  existingFileName: existing.file_name,
                  statementId: existing.id,
                  invoiceId: null,
                  dupType: 'bank_statement',
                  dupNumber: null,
                  dupVendor: null,
                  pendingFile: file,    // keep the file to upload if user says Yes
                });
                return; // stop — wait for user choice
              }
            }
          } catch { /* if check fails, proceed with upload normally */ }
        }
      }
      // ── No duplicate found — proceed with upload ─────────────────────
      await doUpload(file);
    }
  }, [folder, description, uploadMut]);

  // Extracted upload logic — reads file as base64 and calls uploadMut
  const doUpload = useCallback((file: File) => {
    return new Promise<void>((resolve) => {
      // Check file size — iOS Safari struggles with files > 20MB
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 20MB.`);
        setUploading(false);
        resolve();
        return;
      }
      setUploading(true);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target?.result as string;
        if (!base64) {
          toast.error('Could not read file. Please ensure the file is fully downloaded before uploading.');
          setUploading(false);
          resolve();
          return;
        }
        const autoFolderName = folder || autoFolder(file.name, file.type);
        uploadMut.mutate({
          filename: file.name,
          original_name: file.name,
          file_type: file.type || 'application/octet-stream',
          file_size: file.size,
          file_data: base64,
          folder: autoFolderName,
          description,
        });
        resolve();
      };
      reader.onerror = () => {
        toast.error('Upload failed: Could not read the file. Make sure it is fully downloaded locally.');
        setUploading(false);
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }, [folder, description, uploadMut]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files);
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files); };

  const toggleFolder = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handleFileAction = (action: string, f: FileItem) => {
    if (action === 'edit') {
      setEditingId(f.id);
      setEditName(f.filename || '');
      setEditFolder(f.folder || '');
      setEditDesc(f.description || '');
    } else if (action === 'delete') {
      deleteMut.mutate(f.id);
    } else if (action === 'import-statement') {
      if (confirm(tr(`Import "${f.filename}" as a bank statement? The system will auto-OCR and parse transactions.`, `確定要將「${f.filename}」匯入為銀行月結單嗎？系統會自動 OCR 辨識並解析交易紀錄。`, `确定要将「${f.filename}」汇入为银行月结单吗？系统会自动 OCR 辨识并解析交易纪录。`))) {
        importStmtMut.mutate(f.id);
      }
    } else if (action === 'unlock-encrypted') {
      setEncryptedPdf({ fileId: f.id, fileName: f.original_name || f.filename || '' });
    }
  };

  const directionMut = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: string }) =>
      api(`/file-storage/${id}/direction`, { method: 'PATCH', body: { direction } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['file-storage'] }),
  });

  const handleSetDirection = (id: string, direction: string) => {
    directionMut.mutate({ id, direction });
  };

  // Handle duplicate warning response
  const handleDupChoice = async (reupload: boolean) => {
    if (!dupWarning) return;
    const { fileId, statementId, invoiceId, dupType, pendingFile } = dupWarning;
    setDupWarning(null);

    if (!reupload) {
      // User said No — navigate to the existing record to view it
      if (dupType === 'bank_statement' && statementId) {
        navigate(`/bank-statements/review/${statementId}`);
      } else if (dupType === 'file') {
        // Just close — user decided not to re-upload
        return;
      } else if (invoiceId) {
        navigate(`/invoices/review/${invoiceId}`);
      }
      return;
    }

    // User said Yes — re-upload/re-import
    if (pendingFile) {
      // Pre-upload duplicate — just proceed with the upload normally
      await doUpload(pendingFile);
      return;
    }

    // Post-upload duplicate — re-import with force=true (no duplicate check, clean slate)
    setProcessingMsg('Re-importing file…');
    try {
      const token = localStorage.getItem('token') || '';
      const activeClient = localStorage.getItem('activeClient');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };
      if (activeClient) {
        try { const c = JSON.parse(activeClient); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
      }
      const resp = await fetch(
        `https://opcc-crm-api.ruhan-farhan.workers.dev/api/file-storage/${fileId}/import-document?force=true`,
        { method: 'POST', headers }
      );
      const result: any = await resp.json();
      setProcessingMsg(null);
      if (result?.statement_id) {
        navigate(`/bank-statements/review/${result.statement_id}`);
      } else if (result?.invoice_id) {
        navigate(`/invoices/review/${result.invoice_id}${reviewPageFlags(result)}`);
      } else {
        toast.error(`Re-import failed: ${result?.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setProcessingMsg(null);
      toast.error(`Re-import failed: ${err?.message || 'Unknown error'}`);
    }
  };

  const fileList = (files?.data || []) as FileItem[];
  const folderList = (folders?.data || []) as string[];
  const tree = useMemo(() => buildTree(fileList), [fileList]);

  // Issue 17: handle user's manual type selection
  const handleTypeChoice = async (choice: 'bank_statement' | 'invoice' | 'store') => {
    if (!typeChoice) return;
    const { fileId, filename } = typeChoice;
    setTypeChoice(null);

    if (choice === 'store') {
      // Just keep in file storage, no processing
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      return;
    }

    setProcessingMsg(choice === 'bank_statement'
      ? 'Processing as bank statement… (20–40 seconds)'
      : 'Processing as invoice… (20–40 seconds)');

    try {
      const endpoint = choice === 'bank_statement'
        ? `/file-storage/${fileId}/import-statement`
        : `/file-storage/${fileId}/import-invoice`;
      const result: any = await api(endpoint, { method: 'POST' });
      setProcessingMsg(null);

      if (choice === 'bank_statement' && result?.statement_id) {
        navigate(`/bank-statements/review/${result.statement_id}`);
      } else if (choice === 'invoice' && result?.invoice_id) {
        if (result?.ocr_failed) {
          toast.warning('Could not automatically read this invoice. You will be taken to the review page to enter details manually.');
        }
        navigate(`/invoices/review/${result.invoice_id}${reviewPageFlags(result)}`);
      } else if (result?.error) {
        toast.error(`Processing failed: ${result.error}`);
      }
    } catch (err: any) {
      setProcessingMsg(null);
      toast.error(`Processing failed: ${err?.message || 'Unknown error'}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Processing overlay */}
      {processingMsg && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-card rounded-lg p-8 max-w-md mx-4 text-center shadow-2xl">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent mb-4"></div>
            <h3 className="font-bold text-lg mb-2">Processing your file…</h3>
            <p className="text-sm text-muted-foreground">{processingMsg}</p>
            <p className="text-xs text-muted-foreground mt-4">You'll be taken to the review page when it's ready.</p>
          </div>
        </div>
      )}

      {/* ── Review Queue Banner ── */}
      {(() => {
        try {
          const q = JSON.parse(sessionStorage.getItem('reviewQueue') || '[]');
          if (q.length > 0) {
            const first = q[0];
            const startReview = () => {
              if (first.docType === 'bank_statement') navigate(`/bank-statements/review/${first.reviewId}`);
              else if (first.docType === 'card_statement') navigate(`/card-statements/review/${first.reviewId}`);
              else navigate(`/invoices/review/${first.reviewId}${first.flags || ''}`);
            };
            return (
              <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-amber-800">📋 {q.length} file(s) queued for review</p>
                  <p className="text-xs text-amber-600 mt-0.5">Next: {first.filename}. Save each to advance to the next.</p>
                </div>
                <button onClick={startReview} className="px-4 py-2 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700">
                  Review Now
                </button>
              </div>
            );
          }
        } catch {}
        return null;
      })()}

      {/* Supervisor password modal for staff delete */}
      {supModal?.show && (
        <SupervisorPasswordModal
          action="delete this file"
          onConfirm={supModal.onConfirm}
          onCancel={() => setSupModal(null)}
        />
      )}

      {/* Encrypted PDF password prompt */}
      {encryptedPdf && (
        <EncryptedPdfModal
          fileId={encryptedPdf.fileId}
          fileName={encryptedPdf.fileName}
          onClose={() => setEncryptedPdf(null)}
          onSuccess={() => setEncryptedPdf(null)}
        />
      )}

      {/* Duplicate document warning popup — handles bank statements, invoices, and receipts */}
      {dupWarning?.show && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-card rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
            <div className="text-center mb-4">
              <div className="text-3xl mb-2">⚠️</div>
              {dupWarning.dupType === 'bank_statement' ? (
                <>
                  <h3 className="font-bold text-lg">Bank Statement Already Exists</h3>
                  <p className="text-sm text-muted-foreground mt-2">
                    {dupWarning.bankName && dupWarning.period
                      ? <>A <strong>{dupWarning.bankName}</strong> statement for <strong>{dupWarning.period}</strong> has already been uploaded and processed.</>
                      : <>This bank statement has already been uploaded and processed.</>
                    }
                  </p>
                  {dupWarning.existingFileName && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Existing file: <span className="font-mono">{dupWarning.existingFileName}</span>
                    </p>
                  )}
                </>
              ) : dupWarning.dupType === 'receipt' ? (
                <>
                  <h3 className="font-bold text-lg">Receipt Already Exists 收據已存在</h3>
                  <p className="text-sm text-muted-foreground mt-2">
                    Receipt <strong>#{dupWarning.dupNumber}</strong>
                    {dupWarning.dupVendor ? <> from <strong>{dupWarning.dupVendor}</strong></> : ''} has already been imported.
                  </p>
                </>
              ) : dupWarning.dupType === 'file' ? (
                <>
                  <h3 className="font-bold text-lg">{tr('File Already Exists', '檔案已存在', '文件已存在')}</h3>
                  <p className="text-sm text-muted-foreground mt-2">
                    {tr('A file named', '名為', '名为')} <strong>{dupWarning.existingFileName}</strong> {tr('already exists in folder', '已存在於資料夾', '已存在于文件夹')} <strong>{dupWarning.dupNumber}</strong>.
                  </p>
                  {dupWarning.dupVendor && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {tr('Uploaded on', '上傳日期', '上传日期')}: {dupWarning.dupVendor}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3 className="font-bold text-lg">Invoice Already Exists 發票已存在</h3>
                  <p className="text-sm text-muted-foreground mt-2">
                    Invoice <strong>#{dupWarning.dupNumber}</strong>
                    {dupWarning.dupVendor ? <> for <strong>{dupWarning.dupVendor}</strong></> : ''} has already been imported.
                  </p>
                </>
              )}
              <p className="text-sm font-medium mt-3">Do you want to upload it again?</p>
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => handleDupChoice(true)}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90"
              >
                Yes, upload again
              </button>
              <button
                onClick={() => handleDupChoice(false)}
                className="px-6 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted"
              >
                {dupWarning.dupType === 'file' ? tr('Cancel', '取消', '取消') : 'No, view existing'}
              </button>
            </div>
          </div>
        </div>
      )}
      {typeChoice?.show && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-card rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
            <div className="text-center mb-4">
              <div className="text-3xl mb-2">🤔</div>
              <h3 className="font-bold text-lg">What type of document is this?</h3>
              <p className="text-sm text-muted-foreground mt-1">
                The system couldn't automatically determine the type of <strong>{typeChoice.filename}</strong>. Please choose:
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => handleTypeChoice('bank_statement')}
                className="w-full flex items-center gap-3 px-4 py-3 border-2 border-blue-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-left transition-colors"
              >
                <span className="text-2xl">🏦</span>
                <div>
                  <div className="font-medium text-sm">Bank Statement</div>
                  <div className="text-xs text-muted-foreground">Extract transactions and reconcile</div>
                </div>
              </button>
              <button
                onClick={() => handleTypeChoice('invoice')}
                className="w-full flex items-center gap-3 px-4 py-3 border-2 border-green-200 rounded-lg hover:border-green-500 hover:bg-green-50 dark:hover:bg-green-950/30 text-left transition-colors"
              >
                <span className="text-2xl">🧾</span>
                <div>
                  <div className="font-medium text-sm">Invoice / Receipt</div>
                  <div className="text-xs text-muted-foreground">Extract invoice details and match to payments</div>
                </div>
              </button>
              <button
                onClick={() => handleTypeChoice('store')}
                className="w-full flex items-center gap-3 px-4 py-3 border-2 border-gray-200 rounded-lg hover:border-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900/30 text-left transition-colors"
              >
                <span className="text-2xl">📁</span>
                <div>
                  <div className="font-medium text-sm">Just store it</div>
                  <div className="text-xs text-muted-foreground">Keep in File Storage without processing</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-2xl font-bold">{t('fileStorage.title')}</h2>
        <p className="text-muted-foreground mt-1">{t('fileStorage.desc')}</p>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={t('fileStorage.search')}
            className="pl-9 pr-3 py-2 border rounded-md bg-background text-sm w-full" />
        </div>
        <select value={filterFolder} onChange={e => setFilterFolder(e.target.value)}
          className="px-3 py-2 border rounded-md bg-background text-sm min-w-[160px]">
          <option value="">{t('fileStorage.allFolders')}</option>
          {folderList.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">
          {tr(`${fileList.length} file${fileList.length === 1 ? '' : 's'}`, `${fileList.length} 個檔案`, `${fileList.length} 个档案`)}
        </span>
        <button onClick={() => autoMatchMut.mutate()} disabled={autoMatchMut.isPending}
          className="flex items-center gap-1 px-3 py-2 bg-primary text-primary-foreground rounded-md text-xs hover:opacity-90 disabled:opacity-40">
          <Zap className="h-3 w-3" /> {tr('Match Invoices', '配對發票', '配对发票')}
        </button>
      </div>

      {/* File Match Review Modal */}
      {matchResults && (
        <FileMatchReviewModal
          matches={matchResults}
          onConfirm={(txId, fileId, invoiceId) => confirmFileMatchMut.mutate({ transaction_id: txId, file_id: fileId, invoice_id: invoiceId || undefined })}
          onClose={() => { setMatchResults(null); queryClient.invalidateQueries({ queryKey: ['file-storage'] }); }}
        />
      )}

      {/* Folder Tree View */}
      {editingId ? (
        <div className="bg-card border rounded-xl p-6">
          <div className="space-y-3">
            <input value={editName} onChange={e => setEditName(e.target.value)} className="px-3 py-2 border rounded-md text-sm w-full"
              placeholder={tr('Filename', '檔案名稱', '档案名称')} />
            <div className="flex gap-3">
              <input value={editFolder} onChange={e => setEditFolder(e.target.value)} className="px-3 py-2 border rounded-md text-sm flex-1"
                placeholder={tr('Folder (use / for subfolders)', '資料夾（可用 / 分隔層級）', '资料夹（可用 / 分隔層級）')} />
              <input value={editDesc} onChange={e => setEditDesc(e.target.value)} className="px-3 py-2 border rounded-md text-sm flex-1"
                placeholder={tr('Description', '描述', '描述')} />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditingId(null)} className="px-3 py-1.5 border rounded-md text-sm">
                {tr('Cancel', '取消', '取消')}
              </button>
              <button onClick={() => updateMut.mutate({ id: editingId, body: { filename: editName, folder: editFolder, description: editDesc } })}
                className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm">
                {tr('Save', '儲存', '储存')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="bg-card border rounded-xl p-4">
        {isLoading ? (
          <div className="flex justify-center py-8"><div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : fileList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">{t('fileStorage.noData')}</p>
        ) : (
          <FolderTree node={tree} depth={0} expanded={expanded} toggle={toggleFolder} onFileAction={handleFileAction} onSetDirection={handleSetDirection} onUnlockEncrypted={(f) => setEncryptedPdf({ fileId: f.id, fileName: f.original_name || f.filename || '' })} onDelete={(f) => {
            if (isStaff) {
              setSupModal({ show: true, onConfirm: () => handleFileAction('delete', f) });
            } else {
              if (confirm(t('common.confirmDelete'))) handleFileAction('delete', f);
            }
          }} />
        )}
      </div>
    </div>
  );
}

// ── File Match Review Modal ──
function FileMatchReviewModal({ matches, onConfirm, onClose }: {
  matches: any[];
  onConfirm: (txId: string, fileId: string, invoiceId?: string) => void;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const pending = matches.filter(m => !confirmed.has(m.transaction_id) && !rejected.has(m.transaction_id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 space-y-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            File Match Suggestions ({confirmed.size + rejected.size}/{matches.length})
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {pending.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('Review each match. Confirm to link the bank transaction to its invoice.', '審核每個配對。確認後將銀行交易連結至發票。', '审核每个配对。确认后将银行交易连结至发票。')}
              </span>
              <button
                onClick={() => {
                  pending.forEach(m => {
                    onConfirm(m.transaction_id, m.file_id, m.invoice_id);
                    setConfirmed(prev => new Set(prev).add(m.transaction_id));
                  });
                }}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => (
                <div key={`${m.file_id}-${m.transaction_id}`} className="border rounded-lg p-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                        {m.is_deposit ? 'DEPOSIT' : 'WITHDRAWAL'}
                      </span>
                      <span className="text-sm font-medium truncate">{m.filename}</span>
                      {m.invoice_number && (
                        <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono">{m.invoice_number}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      HKD {m.amount?.toLocaleString()} → {m.transaction_date} · {m.transaction_desc || 'Bank transaction'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => {
                      onConfirm(m.transaction_id, m.file_id, m.invoice_id);
                      setConfirmed(prev => new Set(prev).add(m.transaction_id));
                    }}
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700">
                      ✓ Confirm
                    </button>
                    <button onClick={() => setRejected(prev => new Set(prev).add(m.transaction_id))}
                      className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50">
                      ✗ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
