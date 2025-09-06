// lib/botjs-sanitize.ts
// Приводим LLM-ответ к строгому CommonJS bot.js, совместимому с нашим AST-валидатором.

function stripMarkdownFences(s: string): string {
  if (!s) return '';
  const m = s.match(/```[\s\S]*?```/m);
  return m ? m[0].replace(/^```[a-zA-Z-]*\s*/, '').replace(/```$/, '').trim() : s.trim();
}

function removeBOM(s: string): string { return s?.replace(/^\uFEFF/, '') ?? ''; }

function normalizeNewlinesAndCtrls(s: string): string {
  let out = s.replace(/\r\n/g, '\n');
  // убрать управляющие, кроме \n\t
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return out;
}

function hardFailOnEsmOrRequire(s: string) {
  if (/\bimport\s+.*\bfrom\b|^\s*import\s+['"][^'"]+['"]/m.test(s) || /\bexport\s+/.test(s)) {
    throw new Error('ESM_NOT_ALLOWED');
  }
  if (/\brequire\s*\(/.test(s)) throw new Error('REQUIRE_NOT_ALLOWED');
}

// 1) Ровно один экспорт и точно async
function ensureSingleExportAndAsync(s: string): string {
  s = s.replace(/module\.exports\s*=\s*{[^}]*handleUpdate[^}]*}\s*;?/g, '');
  s = s.replace(
    /module\.exports\.handleUpdate\s*=\s*async\s*\(\s*ctx\s*\)\s*=>\s*\{/g,
    'module.exports.handleUpdate = async function (ctx) {'
  );
  if (!/module\.exports\.handleUpdate\s*=/.test(s) && /\basync\s+function\s+handleUpdate\s*\(/.test(s)) {
    s += '\n;module.exports.handleUpdate = handleUpdate;';
  }
  s = s.replace(/module\.exports\.handleUpdate\s*=\s*function\s*\(/, 'module.exports.handleUpdate = async function (');
  return s;
}

// 2) Любая функция, внутри которой есть await, должна быть async (declaration + arrow)
function asyncifyFunctionsWithAwait(s: string): string {
  s = s.replace(/(^|\n)\s*function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/g,
    (all, pfx, name, args, body) => {
      if (/\bawait\b/.test(body) && !/^\s*async\s+function/.test(all)) {
        return `${pfx}async function ${name}(${args}){${body}}`;
      }
      return all;
    }
  );

  s = s.replace(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\}/g,
    (all, name, asyncKW, args, body) => {
      if (/\bawait\b/.test(body) && !asyncKW) {
        return `const ${name} = async (${args}) => {${body}}`;
      }
      return all;
    }
  );

  return s;
}

// 3) Нормализуем «запрещённые» возвраты в сообщения
function rewriteIllegalReturns(s: string): string {
  s = s.replace(/return\s+([`'"])([\s\S]*?)\1\s*;?/g, (_m, q, text) => `await ctx.sendMessage(${q}${text}${q}); return;`);
  s = s.replace(/return\s+\{\s*type\s*:\s*(['"])text\1\s*,\s*text\s*:\s*(['"])([\s\S]*?)\2[^}]*\}\s*;?/g,
    (_m, _q1, q2, text) => `await ctx.sendMessage(${q2}${text}${q2}); return;`);
  return s;
}

// 4) Перед ctx.sendMessage должен стоять await
function ensureAwaitBeforeSend(s: string): string {
  return s.replace(/(?<!await\s)ctx\.sendMessage\s*\(/g, 'await ctx.sendMessage(');
}

// 6) Гарантируем хотя бы один вызов ctx.sendMessage внутри handleUpdate
function ensureAtLeastOneSend(s: string): string {
  if (/\bctx\.sendMessage\s*\(/.test(s)) return s;
  // Попробуем вставить перед закрывающей скобкой handleUpdate
  const re = /module\.exports\.handleUpdate\s*=\s*async\s*function\s*\(\s*ctx\s*\)\s*\{([\s\S]*?)\}\s*;?/;
  if (re.test(s)) {
    return s.replace(re, (_m, body) => {
      const patchedBody = String(body || '') + "\nawait ctx.sendMessage({ type: 'text', text: 'OK' });\n";
      return "module.exports.handleUpdate = async function (ctx) {" + patchedBody + "}";
    });
  }
  // Фолбэк: если почему-то нет экспорта, добавим минимальный обработчик
  return (
    "module.exports.handleUpdate = async function (ctx) {\n" +
    "  await ctx.sendMessage({ type: 'text', text: 'OK' });\n" +
    "};\n"
  );
}

// 5) Убрать markdown-заборы и финальная зачистка
function finalTrim(s: string): string {
  return (s.replace(/```/g, '').trim() + '\n');
}

export function sanitizeBotJs(raw: string): string {
  let s = removeBOM(String(raw || ''));
  s = stripMarkdownFences(s);
  s = normalizeNewlinesAndCtrls(s);

  hardFailOnEsmOrRequire(s);
  s = ensureSingleExportAndAsync(s);
  s = asyncifyFunctionsWithAwait(s);
  s = rewriteIllegalReturns(s);
  s = ensureAwaitBeforeSend(s);
  s = ensureAtLeastOneSend(s);

  return finalTrim(s);
}

export { stripMarkdownFences };


