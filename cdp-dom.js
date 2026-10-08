const WebSocket = require('/Users/sandeep/Repos/pr-reviewer/node_modules/ws');
const http = require('http');
function getTargets() { return new Promise((res, rej) => { http.get('http://127.0.0.1:9223/json', (r) => { let d=''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); }); }
(async () => {
  const page = (await getTargets()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', m => { const msg = JSON.parse(m.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const r = await send('Runtime.evaluate', { expression: `(() => {
    const bubbles = [...document.querySelectorAll('.ai-chat-msg')];
    return bubbles.map(b => ({ cls: b.className, html: b.outerHTML.slice(0, 700) }));
  })()`, returnByValue: true });
  console.log(JSON.stringify(r.result.result.value, null, 2));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FAILED ' + e.message); process.exit(1); });
