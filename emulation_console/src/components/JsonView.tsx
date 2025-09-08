export default function JsonView({value, maxHeight=220}:{value:any; maxHeight?:number}) {
  return (
    <pre style={{
      fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize:12, background:'#0a0f1a', color:'#cbd5e1', border:'1px solid #1e293b',
      borderRadius:12, padding:10, overflow:'auto', maxHeight
    }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}


