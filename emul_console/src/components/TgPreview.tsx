import React, { useEffect, useMemo, useRef, useState } from 'react';

type Msg = { role: 'user' | 'bot'; text: string; ts: number };

export default function TgPreview({ specJson }: { specJson: string }) {
  const [sessionId] = useState(() => 'preview-' + Math.random().toString(36).slice(2));
  const [input, setInput] = useState('/start');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  const parsedSpec = useMemo(() => {
    try { return JSON.parse(specJson || '{}'); } catch { return null; }
  }, [specJson]);

  const API_BASE =
    (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000';

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setMsgs((m) => [...m, { role: 'user', text, ts: Date.now() }]);
    setInput('');
    try {
      const body = { spec: parsedSpec, message: text, sessionId };
      const r = await fetch(`${API_BASE}/sim/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.code || `HTTP_${r.status}`);

      const replies: string[] = Array.isArray(j?.replies) ? j.replies : [];
      setMsgs((m) => [
        ...m,
        ...replies.map((t) => ({ role: 'bot', text: String(t), ts: Date.now() })),
      ]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'bot', text: 'Ошибка симуляции: ' + (e?.message || e), ts: Date.now() }]);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1c93e3] text-xs font-bold text-white">B</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">{(parsedSpec as any)?.meta?.botId || 'Bot Preview'}</div>
          <div className="text-xs text-slate-500">симуляция без деплоя</div>
        </div>
      </div>

      {/* messages */}
      <div
        ref={boxRef}
        className="flex-1 overflow-auto bg-[#e7edf3] [background-image:url('https://telegram.org/img/t_chat-bg.png')] [background-size:400px_auto]"
      >
        <div className="flex flex-col gap-2 p-3">
          {msgs.length === 0 && (
            <div className="flex">
              <div className="max-w-[78%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm shadow">
                Напишите /start — бот ответит по текущей спеки
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
              <div
                className={[
                  'max-w-[78%] px-3 py-2 text-sm shadow',
                  'rounded-2xl',
                  m.role === 'user'
                    ? 'rounded-br-md bg-[#d1edff]'
                    : 'rounded-bl-md bg-white',
                ].join(' ')}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* input */}
      <div className="flex items-center gap-2 border-t border-slate-100 p-2">
        <input
          className="tg-input flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#1c93e3]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="/start"
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button
          onClick={send}
          className="rounded-xl bg-[#1c93e3] px-3 py-2 text-sm font-medium text-white hover:brightness-105"
        >
          Send
        </button>
      </div>
    </div>
  );
}


