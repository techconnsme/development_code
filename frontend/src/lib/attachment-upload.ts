// Direct (non-OCR) attachment upload for the expense forms.
// Stores the file via POST /file-storage/upload with skip_ocr: true — saved to
// R2 + file_records as ocr_status='skipped', never queued for analysis (the
// bulk /reprocess sweep is disabled, and the per-file "Analyze" action is the
// only explicit way to analyze it later).
import { api } from './api';
import type { PickedFile } from '../components/DocumentPickerModal';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.xlsx,.xls';

export async function uploadAttachment(file: File, folder: string): Promise<PickedFile> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File too large (max 10MB): ${file.name}`);
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
  const res = await api('/file-storage/upload', {
    method: 'POST',
    body: {
      filename: file.name,
      original_name: file.name,
      file_type: file.type || '',
      file_size: file.size,
      folder,
      skip_ocr: true,
      file_data: base64,
    },
  });
  return { id: res.id, filename: res.original_name || res.filename || file.name };
}
