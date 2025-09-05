import * as acorn from 'acorn'
import * as walk from 'acorn-walk'

export function validateBotJs(code: string) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as any

  let hasExportHandleUpdate = false
  let exportIsAsync = false
  let hasTopLevelEffects = false
  let hasEsmSyntax = false
  let hasSendMessageAwait = false
  let hasForbidden = false
  let returnsObjectResponse = false
  let returnsStringResponse = false
  let usesProcessEnv = false
  let usesDynamicImport = false
  let handleFn: any = null   // AST-узел функции handleUpdate

  const forbidden = new Set(['eval', 'Function', 'require', 'fs', 'child_process', 'vm', 'Worker', 'process']);

  // Подготовим parent-ссылки для узлов (надёжно для любых версий acorn-walk)
  (function attachParents(node: any, parent: any) {
    try { Object.defineProperty(node, 'parent', { value: parent, enumerable: false }) } catch {}
    for (const key in node) {
      const val = (node as any)[key]
      if (!val) continue
      if (Array.isArray(val)) {
        for (const child of val) if (child && typeof child.type === 'string') attachParents(child, node)
      } else if (val && typeof val.type === 'string') {
        attachParents(val, node)
      }
    }
  })(ast, null)

  // Обход дерева; используем simple, родителя читаем из node.parent
  ;(walk as any).simple(ast, {
    AssignmentExpression(node: any) {
      if (
        node.left?.type === 'MemberExpression' &&
        node.left?.object?.type === 'MemberExpression' &&
        node.left?.object?.object?.name === 'module' &&
        node.left?.object?.property?.name === 'exports' &&
        node.left?.property?.name === 'handleUpdate'
      ) {
        hasExportHandleUpdate = true
        // Проверим, что справа именно async function (FunctionExpression или ArrowFunctionExpression)
        const r = (node as any).right
        if (r?.type === 'FunctionExpression' || r?.type === 'ArrowFunctionExpression') {
          if (r.async === true) exportIsAsync = true
          handleFn = r
        }
      }
    },
    ImportDeclaration(_n:any){ hasEsmSyntax = true },
    ExportNamedDeclaration(_n:any){ hasEsmSyntax = true },
    ExportDefaultDeclaration(_n:any){ hasEsmSyntax = true },
    CallExpression(node: any) {
      if (node.callee?.type === 'MemberExpression' &&
          node.callee.object?.name === 'ctx' &&
          node.callee.property?.name === 'sendMessage') {
        let p: any = (node as any).parent
        while (p) {
          if (p.type === 'AwaitExpression' && p.argument === node) { hasSendMessageAwait = true; break }
          // остановимся, если выходим за пределы текущего выражения
          if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'Program') break
          p = p.parent
        }
      }
      if (node.callee?.type === 'Identifier' && forbidden.has(node.callee.name)) {
        hasForbidden = true
      }
      // Запрет топ-левел эффектов: любой CallExpression на верхнем уровне Program
      const parent = (node as any).parent
      if (parent?.type === 'Program') hasTopLevelEffects = true
    },
    Identifier(node: any) {
      if (forbidden.has(node.name)) hasForbidden = true
    },
    MemberExpression(node: any) {
      // process.env.* или любое обращение к process
      if (node.object?.type === 'MemberExpression' &&
          node.object?.object?.name === 'process' &&
          node.object?.property?.name === 'env') {
        usesProcessEnv = true
      }
      if (node.object?.name === 'process') usesProcessEnv = true
    },
    ImportExpression(_node: any) {
      usesDynamicImport = true
    },
    ReturnStatement(node: any) {
      // Проверяем только возвраты ВНУТРИ handleUpdate
      function isInsideHandle(n: any): boolean {
        let p = n as any
        while (p) {
          if (p === handleFn) return true
          p = p.parent
        }
        return false
      }
      if (handleFn && isInsideHandle(node)) {
        if (node.argument?.type === 'ObjectExpression') {
          const keys = new Set(node.argument.properties?.map((p:any)=>p.key?.name || p.key?.value))
          if (keys.has('type') && keys.has('text')) returnsObjectResponse = true
        }
        if (node.argument?.type === 'Literal' && typeof node.argument.value === 'string') {
          returnsStringResponse = true
        }
      }
    }
  } as any)

  const errors: string[] = []
  if (!hasExportHandleUpdate) errors.push('module.exports.handleUpdate is required')
  if (hasExportHandleUpdate && !exportIsAsync) errors.push('handleUpdate must be async function')
  if (hasForbidden) errors.push('Forbidden API used (eval/Function/require/fs/child_process/vm/Worker/process)')
  if (!hasSendMessageAwait) errors.push('At least one await ctx.sendMessage(...) call is required')
  if (returnsObjectResponse) errors.push('Returning object response is not allowed; send via ctx.sendMessage')
  if (returnsStringResponse) errors.push('Returning string is not allowed; send via ctx.sendMessage')
  if (usesProcessEnv) errors.push('process/env is not allowed inside bot code')
  if (usesDynamicImport) errors.push('dynamic import() is not allowed')
  if (hasEsmSyntax) errors.push('ESM import/export is not allowed')
  if (hasTopLevelEffects) errors.push('Top-level side effects are not allowed')

  if (errors.length) {
    const err = new Error('AST validation failed: ' + errors.join('; ')) as any
    err.details = errors
    throw err
  }
}


