export type Op = { op:'add'|'replace'|'remove'; path:string; value?:any }

function ref(doc:any, path:string) {
  const segs = path.split('/').slice(1).map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))
  let parent = doc; for (let i=0;i<segs.length-1;i++) parent = parent[segs[i]]
  const key = segs[segs.length-1]; return { parent, key }
}

export function applyPatch(doc:any, ops:Op[]) {
  const next = JSON.parse(JSON.stringify(doc ?? {}))
  for (const op of ops) {
    const { parent, key } = ref(next, op.path)
    if (op.op === 'remove') { Array.isArray(parent) ? parent.splice(Number(key),1) : delete parent[key] }
    else if (op.op === 'add' || op.op === 'replace') {
      if (Array.isArray(parent) && key === '-') parent.push(op.value)
      else (parent as any)[key] = op.value
    }
  }
  return next
}


