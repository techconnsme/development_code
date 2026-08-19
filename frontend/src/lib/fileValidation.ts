/**
 * Single source of truth for what the OCR upload pipeline accepts.
 *
 * Keep in sync with the allow-list in api/src/routes/file-storage.ts (`/upload`).
 *
 * This page deliberately accepts a SUBSET of what the server will store: the
 * server also permits xlsx/xls/csv, but the OCR chain (pdf.js text layer ->
 * Cloudflare toMarkdown -> GLM-OCR) cannot read a spreadsheet. Offering them
 * here would produce a silent empty draft rather than a useful result, so they
 * are excluded. Spreadsheet ingestion belongs on the Import Data page.
 */

export interface AcceptedFormat {
  ext: string;
  mime: string;
}

export const ACCEPTED_FORMATS: AcceptedFormat[] = [
  { ext: '.pdf', mime: 'application/pdf' },
  { ext: '.png', mime: 'image/png' },
  { ext: '.jpg', mime: 'image/jpeg' },
  { ext: '.jpeg', mime: 'image/jpeg' },
  { ext: '.webp', mime: 'image/webp' },
  { ext: '.gif', mime: 'image/gif' },
];

/**
 * Value for the input's `accept` attribute.
 *
 * Lists BOTH MIME types and extensions. WebKit/Safari honours the MIME form
 * more reliably than bare extensions; Chrome and Firefox accept either. Note
 * that `accept` only filters the OS file picker — it is not validation, and
 * drag-drop bypasses it entirely, which is why validateFiles() below is applied
 * to every entry path.
 */
export const ACCEPT_ATTR = [
  ...Array.from(new Set(ACCEPTED_FORMATS.map(f => f.mime))),
  ...ACCEPTED_FORMATS.map(f => f.ext),
].join(',');

/**
 * The server rejects file_data longer than 14,000,000 base64 characters.
 * 10 MiB of binary encodes to ~13.98M chars plus the data-URL prefix, so this
 * sits just under the server limit and fails fast, before base64 encoding.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Apple's default camera format. Not decodable anywhere in our pipeline. */
const APPLE_IMAGE_EXTS = ['.heic', '.heif'];

export type RejectReason =
  | { kind: 'apple_image'; ext: string }
  | { kind: 'unsupported'; ext: string }
  | { kind: 'too_large'; bytes: number };

export interface RejectedFile {
  file: File;
  reason: RejectReason;
}

export interface FileSelection {
  accepted: File[];
  rejected: RejectedFile[];
}

/** Lower-cased extension including the leading dot, or '' when there is none. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/**
 * Partition a selection into files we can actually process and files we cannot.
 *
 * Matching is done on the filename extension, never on `file.type`. The browser
 * derives `file.type` from an OS-level extension map, so it is inconsistent
 * across platforms — notably, a .heic file reports `image/heic` on macOS but an
 * empty string on Windows, which is exactly the kind of divergence that makes a
 * bug look platform-specific when it is not.
 */
export function validateFiles(files: File[]): FileSelection {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of files) {
    const ext = extensionOf(file.name);

    if (APPLE_IMAGE_EXTS.includes(ext)) {
      rejected.push({ file, reason: { kind: 'apple_image', ext } });
    } else if (!ACCEPTED_FORMATS.some(f => f.ext === ext)) {
      rejected.push({ file, reason: { kind: 'unsupported', ext } });
    } else if (file.size > MAX_FILE_BYTES) {
      rejected.push({ file, reason: { kind: 'too_large', bytes: file.size } });
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejected };
}
