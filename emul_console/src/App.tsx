import { useMemo, useState } from "react";
import { nlChat, simRun, type ChatMsg } from "./api";
import { Bot, Send, Paperclip, Mic } from "lucide-react";
import clsx from "classnames";

type SpecJson = any;

export default function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [assistantTyping, setAssistantTyping] = useState(false);
  const [mode, setMode] = useState<"patch"|"full">("patch");
  const [specText, setSpecText] = useState<string>(`{ "meta": { "botId": "my-bot-1" } }`);
  const [sessionId] = useState(() => "emul-" + Math.random().toString(36).slice(2));

  const parsedSpec: SpecJson|null = useMemo(() => {
    try { return JSON.parse(specText) } catch { return null }
  }, [specText]);

  return (
    <div className="min-h-screen bg-[#0B1118] text-white">
      <div className="max-w-[1500px] mx-auto px-4 py-5">
        <header className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Emul Console</h1>
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <span className="hidden md:inline">Mode:</span>
            <button className={clsx("px-3 py-1 rounded",
              mode==="patch" ? "bg-sky-600" : "bg-slate-700 hover:bg-slate-600")}
              onClick={()=>setMode("patch")}>Patch</button>
            <button className={clsx("px-3 py-1 rounded",
              mode==="full" ? "bg-sky-600" : "bg-slate-700 hover:bg-slate-600")}
              onClick={()=>setMode("full")}>Full</button>
          </div>
        </header>

        {/* 2 колонки всегда: 420px слева, справа растягивается */}
        <div className="grid grid-cols-[420px_minmax(0,1fr)] gap-6">
          {/* LEFT: Assistant Chat */}
          <AssistantPane
            messages={messages}
            setMessages={setMessages}
            assistantTyping={assistantTyping}
            setAssistantTyping={setAssistantTyping}
            specText={specText}
            setSpecText={setSpecText}
            mode={mode}
            parsedSpec={parsedSpec}
          />

          {/* RIGHT: Telegram Emulator */}
          <TelegramPreview
            spec={parsedSpec}
            sessionId={sessionId}
          />
        </div>
      </div>
    </div>
  );
}

function AssistantPane(props: {
  messages: ChatMsg[];
  setMessages: (fn: (m:ChatMsg[])=>ChatMsg[]) => void;
  assistantTyping: boolean;
  setAssistantTyping: (b:boolean)=>void;
  specText: string;
  setSpecText: (s:string)=>void;
  mode: "patch"|"full";
  parsedSpec: any|null;
}) {
  const { messages, setMessages, assistantTyping, setAssistantTyping, specText, setSpecText, mode, parsedSpec } = props;
  const [input, setInput] = useState("");

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const next: ChatMsg[] = [...messages, { role: "user" as const, text }];
    setMessages(()=>next);
    setAssistantTyping(true);
    try {
      const res = await nlChat(next, parsedSpec, mode);
      if (res.assistant) {
        setMessages(m => [...m, { role: "assistant" as const, text: res.assistant! }]);
      }
      if (res.targetSpec) {
        // полный объект — сразу показываем
        setSpecText(JSON.stringify(res.targetSpec, null, 2));
      } else if (Array.isArray(res.patch) && parsedSpec) {
        // применить patch локально (без внешней либы — tiny_apply)
        const patched = applyPatchShallow(parsedSpec, res.patch);
        setSpecText(JSON.stringify(patched, null, 2));
      }
    } catch (e:any) {
      setMessages(m => [...m, { role:"assistant", text:`[Ошибка] ${e?.message || e}` }]);
    } finally {
      setAssistantTyping(false);
    }
  }

  return (
    <div className="bg-[#0F1720] rounded-2xl p-4 shadow-soft border border-slate-800 h-[calc(100vh-140px)] flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-full bg-sky-500/20 flex items-center justify-center">
          <Bot className="w-5 h-5 text-sky-400" />
        </div>
        <div>
          <div className="font-medium">Spec Assistant</div>
          <div className="text-xs text-slate-400">Опиши — я соберу или подправлю спеку</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg bg-[#0A1218] border border-slate-800 p-3 space-y-3">
        {messages.length===0 && (
          <div className="text-sm text-slate-400">
            Пример: «Сделай /start c приветствием и /status, который делает http GET на /status»
          </div>
        )}
        {messages.map((m,i)=>(
          <div key={i} className={m.role==="user"?"text-right":""}>
            <div className={clsx(
              "inline-block px-3 py-2 rounded-2xl max-w-[85%]",
              m.role==="user" ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-100"
            )}>
              {m.text}
            </div>
          </div>
        ))}
        {assistantTyping && (
          <div className="inline-flex items-center gap-1 bg-slate-800 text-slate-300 px-3 py-2 rounded-2xl">
            <span className="typing-dot">●</span><span className="typing-dot">●</span><span className="typing-dot">●</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter" && send()}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-sky-600"
          placeholder="Опишите изменения…"
        />
        <button onClick={send}
          className="bg-sky-600 hover:bg-sky-500 rounded-xl px-3.5 py-2 flex items-center gap-1">
          <Send className="w-4 h-4"/> Send
        </button>
      </div>

      <div className="mt-4">
        <div className="text-xs text-slate-400 mb-1">Спека (read-only, авто-обновление)</div>
        <textarea
          className="w-full h-44 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg p-3 text-slate-200"
          value={specText}
          onChange={(e)=>setSpecText(e.target.value)}
        />
      </div>
    </div>
  );
}

// очень простой применитель Patch (add/replace/remove на первый уровень и массивы). Для демо-превью хватает.
function applyPatchShallow(doc:any, patch:any[]) {
  const out = JSON.parse(JSON.stringify(doc));
  for (const op of patch) {
    const path = String(op.path || "").split("/").slice(1);
    if (!path.length) continue;
    let cur:any = out;
    for (let i=0; i<path.length-1; i++) cur = cur[path[i]];
    const key = path[path.length-1];
    if (op.op==="add" || op.op==="replace") {
      cur[key] = op.value;
    } else if (op.op==="remove") {
      if (Array.isArray(cur)) cur.splice(Number(key),1); else delete cur[key];
    }
  }
  return out;
}

function TelegramPreview({ spec, sessionId }:{spec:any|null, sessionId:string}) {
  const [input, setInput] = useState("/start");
  type Row = { role:"me"|"bot"|"date"; text:string; ts:number; buttons?: string[][] }
  const [feed, setFeed] = useState<Row[]>([
    { role:"date", text:"Сегодня", ts: Date.now() }
  ]);

  async function send() {
    if (!spec) { alert("Спека невалидна или пуста"); return }
    const msg = input.trim();
    if (!msg) return;
    setFeed(f=>[...f, {role:"me" as const, text:msg, ts:Date.now()}]);
    setInput("");
    try {
      const r = await simRun(spec, msg, sessionId);
      const replies = r.replies?.length ? r.replies : ["(бот не ответил)"];
      setFeed(f=>[
        ...f,
        ...replies.map((t:string)=>({
          role:"bot" as const,
          text:t,
          ts: Date.now(),
          buttons: t.includes("Add to Chat") ? [["Add to Chat"],["Bot Updates Channel"],["Show FAQs"]] : undefined
        }))
      ]);
    } catch (e:any) {
      setFeed(f=>[...f, {role:"bot" as const, text:"Ошибка симуляции: "+(e?.message||e), ts:Date.now()}])
    }
  }

  return (
    <div className="bg-tg-bg rounded-2xl p-0 border border-[#1f2e40] h-[calc(100vh-140px)] flex flex-col shadow-soft">
      {/* Header как в Telegram */}
      <div className="bg-tg-header rounded-t-2xl px-4 py-3 flex items-center gap-3 border-b border-[#253447]">
        <div className="w-9 h-9 rounded-full bg-sky-500/30 ring-1 ring-sky-700/40" />
        <div className="flex-1">
          <div className="text-tg.text font-medium">Preview Bot</div>
          <div className="text-xs text-tg.sub">online</div>
        </div>
        <Paperclip className="w-4 h-4 text-tg.sub"/>
        <Mic className="w-4 h-4 text-tg.sub"/>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto bg-[url('https://telegram.org/img/tl_bg.jpg')] bg-cover bg-center px-3 py-4 space-y-2">
        {feed.map((m,i)=>{
          if (m.role === "date") {
            return (
              <div key={i} className="flex justify-center my-2">
                <span className="text-[11px] px-2 py-1 rounded-full bg-[#1e2b3a] text-tg.text/80">
                  {m.text}
                </span>
              </div>
            )
          }
          const mine = m.role==="me"
          return (
            <div key={i} className={mine ? "flex justify-end" : "flex justify-start"}>
              <div className={clsx(
                "max-w-[80%] px-3 py-2 rounded-2xl text-[15px] leading-snug shadow",
                mine ? "bg-tg-bubbleOut text-white rounded-br-md" : "bg-tg-bubbleIn text-tg.text rounded-bl-md"
              )}>
                <div>{m.text}</div>
                {!mine && m.buttons?.length ? (
                  <div className="mt-2 space-y-2">
                    {m.buttons.map((row,ri)=>(
                      <div key={ri} className="flex gap-2">
                        {row.map((b,bi)=>(
                          <button key={bi}
                            className="flex-1 bg-[#223446] hover:bg-[#27425b] text-[13px] text-tg.text px-3 py-2 rounded-lg border border-[#2f4357]">
                            {b}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="text-[10px] mt-1 text-tg.sub flex justify-end gap-1">
                  <span>{new Date(m.ts).toLocaleTimeString().slice(0,5)}</span>
                  <span>✓✓</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Input */}
      <div className="bg-tg-header rounded-b-2xl px-3 py-2 flex items-center gap-2 border-t border-[#223244]">
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter" && send()}
          className="flex-1 bg-[#0F1A24] text-tg.text placeholder:text-tg.sub text-sm rounded-xl px-3 py-2 outline-none border border-[#213244] focus:border-tg.accent"
          placeholder="Message"
        />
        <button onClick={send} className="bg-tg.accent hover:brightness-110 text-[#0A1218] px-3 py-2 rounded-xl flex items-center gap-1">
          <Send className="w-4 h-4"/> Send
        </button>
      </div>
    </div>
  );
}
