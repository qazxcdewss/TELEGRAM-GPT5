import { useEffect, useRef, useState } from 'react'

const API = import.meta.env.VITE_API_BASE as string
const BOT_ID = import.meta.env.VITE_BOT_ID as string
const BOT_SECRET = import.meta.env.VITE_BOT_SECRET as string

type Revision = { revHash: string; createdAt: string }

export default function App() {
  const [spec, setSpec] = useState<string>(
    `{\n  "meta": { "botId": "${BOT_ID}" }\n}`
  )
  const [revs, setRevs] = useState<Revision[]>([])
  const [activeRev, setActiveRev] = useState<string | null>(null)
  const [selectedRev, setSelectedRev] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const esRef = useRef<EventSource | null>(null)

  const append = (line: string) =>
    setLog((l) => [new Date().toLocaleTimeString() + ' ' + line, ...l].slice(0, 200))

  async function refresh() {
    const r1 = await fetch(`${API}/revisions?botId=${encodeURIComponent(BOT_ID)}`).then((r) => r.json())
    setRevs(
      (r1?.items ?? []).map((x: any) => ({
        revHash: x.rev_hash || x.revHash,
        createdAt: x.created_at || x.createdAt,
      }))
    )
    const r2 = await fetch(`${API}/bots/${BOT_ID}`).then((r) => r.json())
    setActiveRev(r2?.activeRevHash ?? null)
  }

  useEffect(() => {
    const url = `${API}/events`;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    es.onopen = () => append('[sse] open');
    es.onerror = (e) => append('[sse] error ' + (e ? '(see console)' : ''));
    es.onmessage = (e) => append('[sse] message ' + (e as MessageEvent).data);

    es.addEventListener('GenerateStarted',   (e) => append('[gen] started ' + (e as MessageEvent).data));
    es.addEventListener('GenerateSucceeded', (e) => append('[gen] ok ' + (e as MessageEvent).data));
    es.addEventListener('DeployStarted',     (e) => append('[deploy] started ' + (e as MessageEvent).data));
    es.addEventListener('DeployFlipped',     (e) => append('[deploy] flipped ' + (e as MessageEvent).data));

    es.addEventListener('MessageProcessed', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      append(`[msg] bot=${data.botId} chat=${data.chatId} ` + (data.error ? 'ERROR ' + data.error : JSON.stringify(data.response)));
    });

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function uploadSpec() {
    try {
      const body = JSON.parse(spec)
      const r = await fetch(`${API}/spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      append('Spec uploaded')
      refresh()
    } catch (e: any) {
      append('Spec ERROR: ' + e.message)
    }
  }

  async function generate() {
    // find latest spec version first
    const last = await fetch(`${API}/spec/latest?botId=${encodeURIComponent(BOT_ID)}`).then((r) =>
      r.ok ? r.json() : null
    )
    const specVersion = last?.version
    if (!specVersion) { append('Generate ERROR: no spec version'); return }

    const r = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID, specVersion }),
    })
    if (!r.ok) { append('Generate ERROR: ' + (await r.text())); return }
    const { taskId } = await r.json()
    append(`Generate started task=${taskId} v=${specVersion}`)
  }

  async function deploy() {
    if (!selectedRev) { append('Select a revision'); return }
    const r = await fetch(`${API}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: BOT_ID, revHash: selectedRev }),
    })
    if (!r.ok) { append('Deploy ERROR: ' + (await r.text())); return }
    const { taskId } = await r.json()
    append(`Deploy started task=${taskId} rev=${selectedRev}`)
  }

  async function testWebhook() {
    const sampleUpdate = {
      update_id: Math.floor(Math.random() * 1e9),
      message: { chat: { id: 12345, type: 'private' }, text: '/start' }
    }
    const r = await fetch(`${API}/wh/${BOT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body: JSON.stringify(sampleUpdate),
    })
    const t = await r.text()
    append(`/wh echo: ${t.slice(0, 200)}`)
  }

  async function fetchMetrics() {
    const r = await fetch(`${API}/metrics`).then(r=>r.json())
    append('[metrics] ' + JSON.stringify(r))
  }
  async function fetchDLQ() {
    const r = await fetch(`${API}/dlq/${BOT_ID}`).then(r=>r.json())
    append('[dlq] ' + JSON.stringify(r))
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 20 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Bot Console (MVP)</h1>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>1) Upload Spec</h2>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            style={{ width: '100%', height: 220, fontFamily: 'ui-monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={uploadSpec}>Upload /spec</button>
            <button onClick={generate}>Generate</button>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>2) Revisions & Deploy</h2>
          <div>Active: <b>{activeRev ?? '—'}</b></div>
          <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid #f1f1f1', borderRadius: 8 }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead><tr><th>revHash</th><th>created</th><th></th></tr></thead>
              <tbody>
                {revs.map((r) => (
                  <tr key={r.revHash} style={{ background: selectedRev === r.revHash ? '#f6faff' : undefined }}>
                    <td style={{ fontFamily: 'ui-monospace' }}>{r.revHash}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td><button onClick={() => setSelectedRev(r.revHash)}>select</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8 }}>
            <button onClick={deploy} disabled={!selectedRev}>Deploy selected</button>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>3) Webhook test → echo</h2>
          <button onClick={testWebhook}>Send test /wh</button>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>SSE / Logs</h2>
          <div style={{ fontFamily: 'ui-monospace', fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.35, maxHeight: 300, overflow: 'auto' }}>
            {log.map((x, i) => <div key={i}>{x}</div>)}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:8 }}>
            <button onClick={fetchMetrics}>Load metrics</button>
            <button onClick={fetchDLQ}>Load DLQ</button>
          </div>
        </div>
      </section>
    </div>
  )
}
