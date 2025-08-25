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

export function stripMarkdownFences(code: string): string {
  // вырезаем ```js ... ```
  const fence = code.match(/```[\s\S]*?```/);
  if (!fence) return code.trim();
  const inner = fence[0].replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '');
  return inner.trim();
}

export function postValidateBotJs(js: string, maxKB = 64) {
  if (!js || typeof js !== 'string') throw new Error('BOT_JS_EMPTY');

  const sizeKB = Buffer.byteLength(js, 'utf8') / 1024;
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


