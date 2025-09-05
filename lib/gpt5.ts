// lib/gpt5.ts
import { canonicalize } from './canonicalize';
import { stripMarkdownFences } from './botjs-validate';

function normalizeJs(s: string): string {
  let out = (s ?? '').toString();
  if (out.charCodeAt(0) === 0xFEFF) out = out.slice(1);
  out = out.replace(/\r\n/g, '\n');
  // убрать управляющие, кроме \n\t
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return out.trim();
}

// Небольшой авто-ремонт типовых нарушений от модели (тело функции)
function autoRepairBotJsBody(body: string): string {
  let out = body;
  // 1) return "text" → await ctx.sendMessage("text"); return;
  out = out.replace(
    /return\s+([`'"])([\s\S]*?)\1\s*;?/g,
    (_m, q, text) => `await ctx.sendMessage(${q}${text}${q}); return;`
  );
  // 2) return { type: 'text', text: '...' } → await ctx.sendMessage('...'); return;
  out = out.replace(
    /return\s+\{\s*type\s*:\s*(['"])text\1\s*,\s*text\s*:\s*(['"])([\s\S]*?)\2\s*\}\s*;?/g,
    (_m, _q1, q2, text) => `await ctx.sendMessage(${q2}${text}${q2}); return;`
  );
  // 3) if (...) await ctx.sendMessage(...); return; → с фигурными скобками
  out = out.replace(
    /if\s*\(([^)]*)\)\s*await\s+ctx\.sendMessage\(([\s\S]*?)\)\s*;\s*return\s*;?/g,
    (_m, cond, args) => `if (${cond}) { await ctx.sendMessage(${args}); return; }`
  );
  return out;
}

// обёртка: если модель вернула ТОЛЬКО тело — обернём в шаблон; если вдруг прислала весь модуль — извлечём тело
function wrapIntoHandleUpdate(cleaned: string): string {
  const code = normalizeJs(cleaned);
  const m = code.match(/module\.exports\.handleUpdate\s*=\s*async\s*function\s*\(\s*ctx\s*\)\s*\{([\s\S]*?)\}\s*;?\s*$/);
  const body = m ? m[1] : code;
  const safeBody = autoRepairBotJsBody(normalizeJs(body));
  return 'module.exports.handleUpdate = async function (ctx) {\n' + safeBody + '\n};\n';
}

const SYSTEM_PROMPT = `
Ты генерируешь ТОЛЬКО ТЕЛО функции handleUpdate (без module.exports...).
Требования:
- Ответы пользователю ТОЛЬКО: await ctx.sendMessage(...).
- НИКОГДА не возвращай строку/объект ответа; допускается только "return;" (без значения).
- Любые вспомогательные функции пиши внутри тела и без await/ctx.* (они чистые).
- Никаких eval/Function/require/fs/child_process/process.env/dynamic import/vm/Worker/WebAssembly.
- Никаких import/export (ESM).
- Не пиши кодовые заборы и комментарии, верни только JavaScript-операторы тела.
Вход: canonical JSON спецификации. Реализуй шаги sendMessage|goto|http и храни state через ctx.getState()/ctx.setState().
`.trim();

type Gpt5Options = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
};

export async function generateBotJsWithGpt5(spec: unknown, opts: Gpt5Options = {}): Promise<string> {
  const apiKey = opts.apiKey || process.env.GPT5_API_KEY!;
  const baseUrl = (opts.baseUrl || process.env.GPT5_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model || process.env.GPT5_MODEL || 'gpt-5';
  // gpt-5: не посылаем кастомный temperature (оставляем дефолт)

  if (!apiKey) throw new Error('GPT5_API_KEY_MISSING');

  const canonicalJson = canonicalize(spec);

  const url = `${baseUrl}/chat/completions`;
  let res: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              'Вот canonical JSON спеки. Верни ТОЛЬКО ТЕЛО функции handleUpdate (JS-операторы), без module.exports и без комментариев.\n\n' +
              canonicalJson,
          },
        ],
      }),
    });
  } catch (e: any) {
    console.error('[gpt5] fetch failed:', e?.message || e, 'url=', url);
    throw new Error('GPT5_FETCH_FAILED');
  }

  if (!res.ok) {
    const tx = await res.text().catch(() => '');
    throw new Error(`GPT5_HTTP_${res.status}_${tx.substring(0, 180)}`);
  }
  const j = (await res.json()) as any;
  const raw = j?.choices?.[0]?.message?.content?.trim?.();
  if (!raw) throw new Error('GPT5_EMPTY');

  const cleaned = stripMarkdownFences(raw);
  const wrapped = wrapIntoHandleUpdate(cleaned);
  return wrapped;
}


