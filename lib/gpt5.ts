// lib/gpt5.ts
import { canonicalize } from './canonicalize';
import { stripMarkdownFences } from './botjs-validate';

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
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;

  if (!apiKey) throw new Error('GPT5_API_KEY_MISSING');

  const canonicalJson = canonicalize(spec);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: 'system',
          content:
            'Ты — генератор JS для Telegram-бота. Верни ТОЛЬКО CommonJS код без комментариев и текста вокруг. ' +
            'Обязателен экспорт: module.exports.handleUpdate = async function(ctx) { /* ... */ }. ' +
            'ОТВЕТЫ пользователю — ТОЛЬКО через await ctx.sendMessage({ type:"text", text: ... }); возвращай undefined. ' +
            'НИКОГДА не возвращай объект ответа или строку из handleUpdate. ' +
            'Разрешены: ctx.sendMessage, ctx.http, ctx.goto, ctx.getState, ctx.setState. ' +
            'Запрещены: eval, Function, require, fs, child_process, process/env, dynamic import, vm, Worker. ' +
            'Никаких ESM import/export. Никаких внешних зависимостей.',
        },
        {
          role: 'user',
          content:
            'Вот canonical JSON спеки. Сгенерируй bot.js, который реализует шаги sendMessage|goto|http и хранит state в ctx.state.\n\n' +
            canonicalJson,
        },
      ],
    }),
  });

  if (!res.ok) {
    const tx = await res.text().catch(() => '');
    throw new Error(`GPT5_HTTP_${res.status}_${tx.substring(0, 180)}`);
  }
  const j = (await res.json()) as any;
  const raw = j?.choices?.[0]?.message?.content?.trim?.();
  if (!raw) throw new Error('GPT5_EMPTY');

  return stripMarkdownFences(raw);
}


