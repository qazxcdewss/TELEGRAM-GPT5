// lib/gpt5.ts
import { canonicalize } from './canonicalize';
import { stripMarkdownFences } from './botjs-validate';
import { sanitizeBotJs } from './botjs-sanitize';

/** Нормализация строки JS (BOM, переводы строк, управляющие) */
function normalizeJs(s: string): string {
  let out = (s ?? '').toString();
  if (out.charCodeAt(0) === 0xFEFF) out = out.slice(1);          // BOM
  out = out.replace(/\r\n/g, '\n');                               // CRLF → LF
  // убрать управляющие, кроме \n\t
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return out.trim();
}

/** Авто-ремонт типовых нарушений от модели (тело функции) */
function autoRepairBotJsBody(body: string): string {
  let out = body;

  // return "text" → await ctx.sendMessage("text"); return;
  out = out.replace(
    /return\s+([`'"])([\s\S]*?)\1\s*;?/g,
    (_m, q, text) => `await ctx.sendMessage(${q}${text}${q}); return;`,
  );

  // return { type:'text', text:'...' } → await ctx.sendMessage('...'); return;
  out = out.replace(
    /return\s+\{\s*type\s*:\s*(['"])text\1\s*,\s*text\s*:\s*(['"])([\s\S]*?)\2\s*\}\s*;?/g,
    (_m, _q1, q2, text) => `await ctx.sendMessage(${q2}${text}${q2}); return;`,
  );

  // if (...) await ctx.sendMessage(...); return; → со скобками
  out = out.replace(
    /if\s*\(([^)]*)\)\s*await\s+ctx\.sendMessage\(([\s\S]*?)\)\s*;\s*return\s*;?/g,
    (_m, cond, args) => `if (${cond}) { await ctx.sendMessage(${args}); return; }`,
  );

  return out;
}

/** Обёртка: если модель вернула ТОЛЬКО тело — обернём в шаблон; если прислала модуль — извлечём тело и завернём. */
function wrapIntoHandleUpdate(cleaned: string): string {
  const code = normalizeJs(cleaned);
  const matchFull =
    code.match(/module\.exports\.handleUpdate\s*=\s*async\s*function\s*\(\s*ctx\s*\)\s*\{([\s\S]*?)\}\s*;?\s*$/);
  const body = matchFull ? matchFull[1] : code;
  const safeBody = autoRepairBotJsBody(normalizeJs(body));
  return 'module.exports.handleUpdate = async function (ctx) {\n' + safeBody + '\n};\n';
}

/** SYSTEM PROMPT: жёсткий Telegram-контекст + правила генерации */
const SYSTEM_PROMPT = `
Ты пишешь код для Telegram-бота.

Правила (обязательны):

- Верни ТОЛЬКО ТЕЛО функции handleUpdate (без module.exports и без комментариев).
- Обработчик вызывается на каждый апдейт Telegram API.
  В ctx.update могут быть:
    • message.text
    • callback_query.data
    • другие поля Telegram Update.
- Ответы пользователю ТОЛЬКО через: await ctx.sendMessage(text, options?).
- НИКОГДА не возвращай строку или объект — допускается только "return;" без значения.
- Команда считается совпавшей и для вида "/cmd@ИмяБота" (нужно мачить и "/cmd", и "/cmd@...").
- Для состояния используй ctx.getState() / ctx.setState().
- Реализуй шаги из JSON-спеки: sendMessage | goto | http.
- Запрещены: eval, Function/new Function, require, fs, child_process, process.env, dynamic import(), vm, Worker, WebAssembly.
- Запрещены любые import/export (ESM).
- Никаких markdown-заборов и текста вокруг — только JavaScript-операторы тела handleUpdate.
`.trim();

type Gpt5Options = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number; // игнорируем для gpt-5
};

export async function generateBotJsWithGpt5(spec: unknown, opts: Gpt5Options = {}): Promise<string> {
  const apiKey = opts.apiKey || process.env.GPT5_API_KEY!;
  const baseUrl = (opts.baseUrl || process.env.GPT5_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model  = opts.model || process.env.GPT5_MODEL || 'gpt-5';
  if (!apiKey) throw new Error('GPT5_API_KEY_MISSING');

  // policy: gpt-5 не поддерживает кастомный temperature
  const includeTemperature = !model.startsWith('gpt-5');
  const temperature = includeTemperature
    ? (typeof opts.temperature === 'number' ? opts.temperature : 0.7)
    : undefined;

  const canonicalJson = canonicalize(spec);
  const url = `${baseUrl}/chat/completions`;

  // устойчивость сети/сервера
  const MAX_RETRIES = Number(process.env.GPT5_RETRIES || 2);
  const TIMEOUT_MS  = Number(process.env.GPT5_HTTP_TIMEOUT_MS || 120000);
  const MAX_COMP_TOKENS_BASE = Number(process.env.GPT5_MAX_COMPLETION_TOKENS || 3000);
  const BACKOFFS_MS = [800, 1600];

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Вот canonical JSON спеки. Верни ТОЛЬКО ТЕЛО функции handleUpdate (JS-операторы), без module.exports и без комментариев.\n\n' +
        canonicalJson,
    },
  ];

  // Stream отключен (нет доступа/верификации). Всегда используем обычный запрос.
  let useStream = false;
  const payload: any = { model, messages };
  if (model.startsWith('gpt-5')) {
    payload.max_completion_tokens = MAX_COMP_TOKENS_BASE;
  } else {
    payload.max_tokens = 1200;
  }
  if (includeTemperature) payload.temperature = temperature;

  async function once(): Promise<any> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      } as any);
      clearTimeout(t);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        // 429/5xx считаем временными
        const status = res.status;
        const err = new Error(`GPT5_HTTP_${status}_${txt.slice(0, 180)}`);
        (err as any).status = status;
        throw err;
      }
      const j: any = await res.json();
      // тело могло вернуть ошибку даже при 200 OK
      if (j && j.error) {
        const em = String(j.error?.message || JSON.stringify(j.error)).slice(0, 300);
        throw new Error(`GPT5_HTTP_200_BODY_ERROR_${em}`);
      }
      if (!Array.isArray((j as any)?.choices) || !(j as any).choices.length) {
        try { console.error('[gpt5] bad body: no choices, got =', JSON.stringify(j).slice(0, 500)); } catch {}
        throw new Error('GPT5_BAD_BODY_NO_CHOICES');
      }
      const msg = (j as any).choices[0]?.message;
      const raw = (msg as any)?.content?.trim?.();
      if (!raw) {
        try { console.error('[gpt5] empty content; finish_reason=', (j as any).choices[0]?.finish_reason, 'message=', JSON.stringify(msg).slice(0, 300)); } catch {}
        // возвратим НУЛЕВОЙ каркас, чтобы генерация не падала: минимальный handler
        return {
          choices: [{ message: { content: '/*EMPTY*/' } }]
        } as any
      }
      return j;
    } catch (e: any) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('GPT5_TIMEOUT');
      throw e;
    }
  }

  async function streamOnce(): Promise<string> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'connection': 'keep-alive' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      } as any);
      clearTimeout(t);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const status = res.status;
        const err = new Error(`GPT5_HTTP_${status}_${txt.slice(0, 180)}`);
        (err as any).status = status;
        throw err;
      }
      if (!res.body) throw new Error('GPT5_EMPTY_STREAM');
      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let content = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') return content.trim();
            try {
              const j = JSON.parse(data);
              const delta = j?.choices?.[0]?.delta?.content ?? '';
              if (delta) content += delta;
            } catch {}
          }
        }
      }
      return content.trim();
    } catch (e:any) {
      clearTimeout(t);
      if (e?.name === 'AbortError') throw new Error('GPT5_TIMEOUT');
      throw e;
    }
  }

  let lastErr: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let raw: string;
      if (useStream) {
        raw = await streamOnce();
        if (!raw) throw new Error('GPT5_EMPTY');
      } else {
        const j = await once();
        raw = j?.choices?.[0]?.message?.content?.trim?.() || '/*EMPTY*/';
      }

      // Модель должна вернуть только ТЕЛО — подчистим и завернём в модуль:
      const bodyOnly  = stripMarkdownFences(raw) || raw;
      const fullMod   = wrapIntoHandleUpdate(bodyOnly);
      const cleaned   = sanitizeBotJs(fullMod);
      return cleaned;
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? 0;
      const retriableHttp = status === 429 || status >= 500;
      const retriableNet  = ['GPT5_TIMEOUT', 'TypeError'].includes(e?.message) || e?.name === 'TypeError';
      if (status === 400 && useStream) {
        try { console.warn('[gpt5] stream not allowed (400), disabling stream and retrying non-stream'); } catch {}
        useStream = false;
        const backoff = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)];
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      if ((retriableHttp || retriableNet) && attempt < MAX_RETRIES) {
        const backoff = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)];
        console.warn(`[gpt5] retry ${attempt + 1} in ${backoff}ms →`, e?.message || String(e));
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      // финальный фэйл
      if (String(e?.message || '').startsWith('GPT5_HTTP_')) {
        throw e; // пробрасываем с кодом/телом
      }
      console.error('[gpt5] fetch failed:', e?.name || 'Error', e?.message || String(e), e?.cause?.code || '');
      throw new Error('GPT5_FETCH_FAILED');
    }
  }
  throw lastErr || new Error('GPT5_FETCH_FAILED');
}
