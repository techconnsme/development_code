import React, { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tr } from '../lib/i18nHelpers';
import { useToast } from './Toast';
import DocumentPickerModal, { type PickedFile } from './DocumentPickerModal';
import { uploadAttachment, ATTACHMENT_ACCEPT } from '../lib/attachment-upload';
import { Paperclip, Upload, X } from 'lucide-react';

const MAX_FILES = 10;

// Attachments block shared by the Expenses page tabs (Petty Cash / Others):
// removable chips + "attach documents" picker (strict unlinked-only) +
// "upload file" for direct from-the-user's-computer documents (stored
// non-OCR via skip_ocr, lands in the tab's folder).
export default function ExpenseAttachments({ files, onChange, uploadFolder }: {
  files: PickedFile[];
  onChange: (files: PickedFile[]) => void;
  /** File Storage folder for direct uploads: 'Petty Cash' | 'Others' */
  uploadFolder: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const atCap = files.length >= MAX_FILES;

  function addFiles(picked: PickedFile[]) {
    onChange([...files, ...picked.filter(p => !files.some(x => x.id === p.id))].slice(0, MAX_FILES));
  }

  async function handleFiles(selected: FileList | null) {
    if (!selected) return;
    let current = files;
    for (const file of Array.from(selected)) {
      if (current.length >= MAX_FILES) break;
      setUploading(n => n + 1);
      try {
        const picked = await uploadAttachment(file, uploadFolder);
        current = [...current, picked];
        onChange([...current]);
        // Keep the picker's file list fresh so the new upload is visible there
        queryClient.invalidateQueries({ queryKey: ['file-storage-list'] });
      } catch (err: any) {
        toast.error(err?.message || tr('Upload failed', '上傳失敗', '上传失败'));
      } finally {
        setUploading(n => n - 1);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground">{tr('Supporting documents', '證明文件', '证明文件')}</span>
        {files.map(f => (
          <span key={f.id} className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-1">
            <Paperclip className="h-3 w-3" />{f.filename}
            <button type="button" onClick={() => onChange(files.filter(x => x.id !== f.id))}
              className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
          </span>
        ))}
        <button type="button" onClick={() => setShowPicker(true)} disabled={atCap}
          className="text-xs text-primary hover:underline disabled:opacity-50">
          {tr('+ attach documents', '+ 附加文件', '+ 附加文件')}
        </button>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={atCap || uploading > 0}
          className="text-xs text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1">
          <Upload className="h-3 w-3" />
          {uploading > 0
            ? tr('Uploading…', '上傳中…', '上传中…')
            : tr('⬆ upload file', '⬆ 上傳文件', '⬆ 上传文件')}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="attachment-upload-input hidden"
          onChange={(e) => { handleFiles(e.target.files); }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {tr('Uploaded files are stored without AI analysis.', '上傳的文件不會經 AI 分析。', '上传的文件不会经 AI 分析。')}
      </p>

      {showPicker && (
        <DocumentPickerModal
          alreadyPicked={files.map(f => f.id)}
          unlinkedOnly
          onPick={addFiles}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
