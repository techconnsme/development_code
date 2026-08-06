import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Save, RefreshCw, BookOpen } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

const FILE_KEYS = ['soul', 'tech', 'ledger', 'plan', 'prompt'] as const;

function fileLabel(key: string): string {
  const labels: Record<string, [string, string, string]> = {
    soul:   ['Soul', '靈魂', '灵魂'],
    tech:   ['Tech Memory', '技術記憶', '技术记忆'],
    ledger: ['Ledger Context', '賬本脈絡', '账本脉络'],
    plan:   ['Task Plan', '任務計劃', '任务计划'],
    prompt: ['System Prompt', '系統提示', '系统提示'],
  };
  const l = labels[key];
  return l ? tr(l[0], l[1], l[2]) : key;
}

export default function AiMemory() {
  const [tab, setTab] = useState('soul');
  const [contents, setContents] = useState<Record<string, string>>({});
  const [sha, setSha] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async (key: string) => {
    setLoading(true);
    setMsg('');
    try {
      if (key === 'prompt') {
        const data = await api('/chat/system-prompt');
        setContents(prev => ({ ...prev, prompt: data.content || '' }));
      } else {
        const data = await api(`/ai-memory/${key}`);
        setContents(prev => ({ ...prev, [key]: data.content || '' }));
        if (data.sha) setSha(prev => ({ ...prev, [key]: data.sha }));
      }
    } catch (e: any) {
      setMsg(tr('Read failed: ', '讀取失敗: ', '读取失败: ') + (e.message || 'error'));
    }
    setLoading(false);
  };

  const save = async (key: string) => {
    if (key === 'prompt') {
      setMsg(tr(
        '⚠ System prompt must be updated by modifying chat.ts',
        '⚠ 系統提示需透過修改 chat.ts 來更新',
        '⚠ 系统提示需透过修改 chat.ts 来更新',
      ));
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    setSaving(true);
    setMsg('');
    try {
      await api('/chat', {
        method: 'POST',
        body: {
          message: `請用write_code寫入 ${fileLabel(key)}.md，commit message: update ${fileLabel(key)}.md\n\n以下是完整檔案內容：\n\`\`\`\n${contents[key]}\n\`\`\``,
          history: [], stream: false,
        },
      });
      setMsg(tr(
        `✅ ${fileLabel(key)} saved`,
        `✅ ${fileLabel(key)} 已儲存`,
        `✅ ${fileLabel(key)} 已储存`,
      ));
    } catch (e: any) {
      setMsg(tr('Save failed: ', '儲存失敗: ', '储存失败: ') + (e.message || 'error'));
    }
    setSaving(false);
    setTimeout(() => setMsg(''), 3000);
  };

  useEffect(() => { load(tab); }, [tab]);

  const isReadOnly = tab === 'prompt';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6" /> {tr('AI Memory', 'AI 記憶', 'AI 记忆')}
          </h2>
          <p className="text-muted-foreground mt-1">
            {tr("AI assistant's core memory and system prompt", 'AI 助理的核心記憶與系統提示', 'AI 助理的核心记忆与系统提示')}
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {FILE_KEYS.map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === k ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {fileLabel(k)}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">
            {isReadOnly ? 'read-only' : (sha[tab] ? sha[tab].slice(0, 7) : '...')}
          </span>
          <button onClick={() => load(tab)} disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-muted">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> {tr('Reload', '重新讀取', '重新读取')}
          </button>
          {!isReadOnly && (
            <button onClick={() => save(tab)} disabled={saving || !contents[tab]}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40">
              <Save className="h-3 w-3" /> {tr('Save to GitHub', '儲存到 GitHub', '储存到 GitHub')}
            </button>
          )}
          {msg && <span className={`text-xs ${msg.startsWith('✅') ? 'text-green-600' : msg.startsWith('⚠') ? 'text-yellow-600' : 'text-red-600'}`}>{msg}</span>}
        </div>
        <textarea
          value={contents[tab] || ''}
          onChange={e => setContents(prev => ({ ...prev, [tab]: e.target.value }))}
          readOnly={isReadOnly}
          className={`w-full h-[70vh] p-4 border rounded-md text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary ${isReadOnly ? 'bg-muted/50' : 'bg-background'}`}
          placeholder={tr('Loading...', '載入中...', '载入中...')}
        />
      </div>
    </div>
  );
}
