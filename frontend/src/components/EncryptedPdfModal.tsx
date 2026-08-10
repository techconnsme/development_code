import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { tr } from '../lib/i18nHelpers';
import { Lock, Loader2 } from 'lucide-react';

interface Props {
  fileId: string;
  fileName: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function EncryptedPdfModal({ fileId, fileName, onClose, onSuccess }: Props) {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'prompt' | 'trying' | 'wrong' | 'success'>('prompt');

  const decryptMut = useMutation({
    mutationFn: (pw: string) =>
      api(`/file-storage/${fileId}/try-decrypt`, { method: 'POST', body: { password: pw } }),
    onSuccess: (data: any) => {
      if (data.success) {
        setStatus('success');
        queryClient.invalidateQueries({ queryKey: ['file-storage'] });
        queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
        queryClient.invalidateQueries({ queryKey: ['invoices'] });
        toast.success(tr(
          'PDF decrypted and processed!',
          'PDF 已解密並處理！',
          'PDF 已解密并处理！'
        ));
        setTimeout(() => {
          onClose();
          onSuccess?.();
        }, 1500);
      } else {
        setStatus('wrong');
        toast.info(tr(
          data.message || 'Wrong password. Please try again.',
          data.message || '密碼錯誤，請重試。',
          data.message || '密码错误，请重试。'
        ));
      }
    },
    onError: (err: any) => {
      setStatus('wrong');
      toast.info(tr(
        err?.message || 'Decryption failed. Please try again.',
        '解密失敗，請重試。',
        '解密失败，请重试。'
      ));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('trying');
    decryptMut.mutate(password.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <Lock className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h3 className="font-semibold text-lg">
              {tr('Encrypted PDF', '加密的 PDF', '加密的 PDF')}
            </h3>
            <p className="text-xs text-muted-foreground truncate max-w-[280px]">{fileName}</p>
          </div>
        </div>

        {status === 'success' ? (
          <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-green-700 dark:text-green-300 font-medium text-sm">
              {tr('✓ Successfully decrypted! Processing...', '✓ 解密成功！正在處理...', '✓ 解密成功！正在处理...')}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {tr(
                'This PDF is encrypted. Enter the password (leave blank to try with no password).',
                '此 PDF 已加密。請輸入密碼（留空則嘗試無密碼解密）。',
                '此 PDF 已加密。请输入密码（留空则尝试无密码解密）。'
              )}
            </p>
            {status === 'wrong' && (
              <p className="text-sm text-red-600 font-medium">
                {tr('Wrong password — please try again.', '密碼錯誤 — 請重試。', '密码错误 — 请重试。')}
              </p>
            )}
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); if (status === 'wrong') setStatus('prompt'); }}
                placeholder={tr('Enter PDF password...', '輸入 PDF 密碼...', '输入 PDF 密码...')}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                autoFocus
                disabled={decryptMut.isPending}
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 border rounded-md text-sm hover:bg-muted"
                  disabled={decryptMut.isPending}
                >
                  {tr('Cancel', '取消', '取消')}
                </button>
                <button
                  type="submit"
                  disabled={decryptMut.isPending}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                >
                  {decryptMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {decryptMut.isPending
                    ? tr('Decrypting…', '解密中…', '解密中…')
                    : tr('Unlock & Scan', '解鎖並掃描', '解锁并扫描')}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
