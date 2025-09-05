// lib/botjs-validate.ts
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const BANNED_SUBSTRINGS = [
  'eval',
  'Function(',
  "require('fs')",
  'child_process',
  'import(',
  'process.env',
  'vm.',
  'Worker(',
];

function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const codeUnit = str.charCodeAt(i);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // surrogate pair => 4 bytes in UTF-8
      bytes += 4;
      i++; // skip the next code unit of the pair
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function stripMarkdownFences(code: string): string {
  const s = (code ?? '').toString();
  // 1) Если есть несколько блоков ```...```, берём самый длинный (скорее всего — основной код)
  const fences = [...s.matchAll(/```([\s\S]*?)```/g)].map(m => m[1] || '');
  let picked = fences.sort((a, b) => b.length - a.length)[0];
  if (!picked) {
    // 2) Если явных заборов нет, уберём одиночные тройные бэктики и префиксы языка
    picked = s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  }
  return picked.trim();
}

export function postValidateBotJs(js: string, maxKB = 64) {
  if (!js || typeof js !== 'string') throw new Error('BOT_JS_EMPTY');

  const sizeKB = utf8ByteLength(js) / 1024;
  if (sizeKB > maxKB) throw new Error(`BOT_JS_TOO_LARGE_${Math.ceil(sizeKB)}KB`);

  for (const bad of BANNED_SUBSTRINGS) {
    if (js.includes(bad)) throw new Error(`BANNED_TOKEN_${bad}`);
  }

  let ast: any;
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }) as any;
  } catch (e: any) {
    const m = e?.message || 'SyntaxError';
    throw new Error(`BOT_JS_SYNTAX_${m.replace(/\s+/g, '_').slice(0, 120)}`);
  }

  let hasExport = false;
  walk.simple(ast as any, {
    AssignmentExpression(n: any) {
      const left = (n as any).left;
      if (
        left?.type === 'MemberExpression' &&
        left.object?.type === 'MemberExpression' &&
        left.object.object?.type === 'Identifier' &&
        left.object.object.name === 'module' &&
        ((left.object.property?.type === 'Identifier' && left.object.property.name === 'exports') ||
          (left.object.property?.type === 'Literal' && left.object.property.value === 'exports')) &&
        ((left.property?.type === 'Identifier' && left.property.name === 'handleUpdate') ||
          (left.property?.type === 'Literal' && left.property.value === 'handleUpdate'))
      ) {
        hasExport = true;
      }
    },
  } as any);

  if (!hasExport) throw new Error('MISSING_EXPORT_handleUpdate');
}


