import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { tr } from '../lib/i18nHelpers';
import { api, streamChat } from '../lib/api';
import { MessageCircle, X, Send, Paperclip, Plus, Trash2, History } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

interface ChatbotPanelProps {
  onClose?: () => void;
  className?: string;
}

export default function Chatbot({ onClose, className }: ChatbotPanelProps) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachedFile, setAttachedFile] = useState<{ name: string; data: string; type: string } | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadSessions = async () => {
    try {
      const data = await api('/chat/sessions');
      setSessions(data.data || []);
    } catch {}
  };

  useEffect(() => { loadSessions(); }, []);

  const loadSession = async (id: string) => {
    try {
      const data = await api(`/chat/sessions/${id}`);
      setSessionId(id);
      setMessages((data.messages || []).map((m: any) => ({ id: m.id, role: m.role, content: m.content })));
      setShowHistory(false);
    } catch {}
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api(`/chat/sessions/${id}`, { method: 'DELETE' });
      if (sessionId === id) {
        setSessionId('');
        setMessages([]);
      }
      loadSessions();
    } catch {}
  };

  const newChat = () => {
    setSessionId('');
    setMessages([]);
    setShowHistory(false);
  };

  const deleteMessage = async (index: number) => {
    const msg = messages[index];
    if (msg?.id && sessionId) {
      try { await api(`/chat/messages/${msg.id}`, { method: 'DELETE' }); } catch {}
    }
    setMessages(prev => prev.filter((_, i) => i !== index));
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setMessages(prev => [...prev, { role: 'assistant', content: tr('File too large. Please upload a file smaller than 5MB.', '檔案太大，請上傳小於 5MB 的檔案。', '档案太大，请上传小于 5MB 的文件。') }]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setAttachedFile({ name: file.name, data: base64, type: file.type });
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attachedFile) || busy) return;

    let content = text || tr('Please analyze the attached file:', '請分析附件檔案:', '请分析附件文件:') + ` ${attachedFile?.name}`;
    const userMsg: Message = { role: 'user', content: attachedFile ? `[${tr('Attachment', '附件', '附件')}: ${attachedFile.name}]\n${content}` : content };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    const file = attachedFile;
    setAttachedFile(null);
    setBusy(true);

    // Add empty assistant message for streaming
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    const body: any = { message: content, history: messages, session_id: sessionId || undefined, lang: i18n.language };
    if (file) body.file = { name: file.name, data: file.data, type: file.type };

    streamChat(
      body,
      // onChunk: append text as it arrives
      (chunk) => {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            last.content += chunk;
          }
          return updated;
        });
      },
      // onDone
      (newSid, provider, model) => {
        if (newSid && !sessionId) setSessionId(newSid);
        // Log which LLM provider/model answered (browser console for debugging)
        if (provider) console.log(`[Chatbot] answered by ${provider}${model ? ` (${model})` : ''}`);
        setBusy(false);
      },
      // onError
      (err) => {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && !last.content) {
            last.content = `❌ ${err}`;
          }
          return updated;
        });
        setBusy(false);
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={`flex flex-col h-full ${className || ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-primary-foreground flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4" />
          <span className="font-medium text-sm">{tr('AI Assistant (Qwen)', 'AI 助理 (Qwen)', 'AI 助理 (Qwen)')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => { loadSessions(); setShowHistory(!showHistory); }}
            className="p-1 rounded hover:bg-primary-foreground/20" title={tr('History', '歷史記錄', '历史记录')}>
            <History className="h-4 w-4" />
          </button>
          <button onClick={newChat}
            className="p-1 rounded hover:bg-primary-foreground/20" title={tr('New chat', '新對話', '新对话')}>
            <Plus className="h-4 w-4" />
          </button>
          {onClose && (
            <button onClick={onClose}
              className="p-1 rounded hover:bg-primary-foreground/20">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {showHistory ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">{tr('Chat History', '歷史對話', '历史对话')}</span>
            <button onClick={newChat} className="text-xs text-primary hover:underline flex items-center gap-1">
              <Plus className="h-3 w-3" /> {tr('New chat', '新對話', '新对话')}
            </button>
          </div>
          {sessions.length === 0 && (
            <p className="text-xs text-muted-foreground text-center mt-4">{tr('No chat history yet', '尚無歷史記錄', '尚无历史记录')}</p>
          )}
          {sessions.map(s => (
            <div key={s.id} onClick={() => loadSession(s.id)}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer hover:bg-muted text-sm ${
                sessionId === s.id ? 'bg-muted font-medium' : ''
              }`}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{s.title || tr('Untitled chat', '未命名對話', '未命名对话')}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.updated_at || s.created_at).toLocaleDateString()}
                </div>
              </div>
              <button onClick={(e) => deleteSession(s.id, e)}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive ml-2 flex-shrink-0">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-sm text-muted-foreground mt-8">
                <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{tr('Hello! I am your AI assistant', '你好！我是 AI 助理', '你好！我是 AI 助理')}</p>
                <p className="text-xs mt-1">{tr('Powered by Qwen · Upload Excel/CSV files for analysis', 'Powered by Qwen · 可以上傳 Excel/CSV 檔案分析', 'Powered by Qwen · 可以上传 Excel/CSV 文件分析')}</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={m.id || i} className={`group relative flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-lg text-sm ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
                    : 'bg-muted text-foreground rounded-bl-sm'
                }`}>
                  {m.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert [&_table]:text-xs [&_table]:w-full [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:bg-muted/50 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : m.content}
                </div>
                <button onClick={() => deleteMessage(i)}
                  className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-card border shadow-sm hover:bg-destructive hover:text-destructive-foreground"
                  title={tr('Delete message', '刪除訊息', '删除消息')}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="bg-muted px-3 py-2 rounded-lg rounded-bl-sm text-sm text-muted-foreground">
                  <span className="animate-pulse">{tr('Processing your request, please wait...', '系統正在查詢中，請稍候...', '系统正在查询中，请稍候...')}</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          {attachedFile && (
            <div className="px-3 pt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Paperclip className="h-3 w-3" />
              <span className="truncate flex-1">{attachedFile.name}</span>
              <button onClick={() => setAttachedFile(null)} className="text-destructive hover:underline">{tr('Remove', '移除', '移除')}</button>
            </div>
          )}
          <div className="border-t p-3 flex gap-2 flex-shrink-0">
            <input type="file" ref={fileInputRef} onChange={handleFile}
              accept=".pdf,.xlsx,.xls,.csv,.txt,.png,.jpg" className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={busy}
              className="p-2 border rounded-md hover:bg-muted disabled:opacity-40" title={tr('Upload file (PDF, Excel, CSV)', '上傳檔案 (PDF, Excel, CSV)', '上传文件 (PDF, Excel, CSV)')}>
              <Paperclip className="h-4 w-4" />
            </button>
            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={tr('Ask anything... (Enter to send, Shift+Enter for new line)', '問任何問題... (Enter 發送, Shift+Enter 換行)', '问任何问题... (Enter 发送, Shift+Enter 换行)')} disabled={busy} rows={1}
              className="flex-1 px-3 py-2 border rounded-md bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none" />
            <button onClick={send} disabled={busy || (!input.trim() && !attachedFile)}
              className="p-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
