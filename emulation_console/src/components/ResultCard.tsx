import JsonView from './JsonView'

export default function ResultCard(
  { kind, data, onApplyPatch, onUseDraft }:
  { kind:'patch'|'full-spec'|'draft'; data:any; onApplyPatch?:()=>void; onUseDraft?:(v:any)=>void }
){
  const title = kind==='patch' ? 'Patch (RFC6902)' : kind==='full-spec' ? 'Сгенерированная спека' : 'Черновик (422)'
  return (
    <div style={{ border:'1px solid #1e293b', borderRadius:12, padding:12, background:'#0b1220' }}>
      <div style={{ fontWeight:600, marginBottom:8 }}>{title}</div>
      <JsonView value={data} />
      <div style={{ display:'flex', gap:8, marginTop:8 }}>
        {kind==='patch' && <button className="ai-btn" onClick={onApplyPatch}>Apply patch locally</button>}
        {kind!=='patch' && <button className="ai-btn" onClick={()=>onUseDraft?.(data)}>Use as draft</button>}
      </div>
    </div>
  )
}


