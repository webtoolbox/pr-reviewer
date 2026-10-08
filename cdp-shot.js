// Open the AI chat panel in the running app and screenshot it (no new request).
const WebSocket = require('/Users/sandeep/Repos/pr-reviewer/node_modules/ws');
const http = require('http');
const fs = require('fs');

const OUT = process.argv[2] || '/tmp/ai-chat-panel.png';

function getTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9223/json', (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };

  const state = await ev(`(() => {
    const panel = document.getElementById('ai-chat-panel');
    const btn = document.getElementById('btn-ai-chat');
    if (!panel || !btn) return 'no-panel';
    const visible = () => {
      const r = panel.getBoundingClientRect();
      return getComputedStyle(panel).display !== 'none' && r.width > 0 && r.height > 0;
    };
    if (!visible()) btn.click();
    const msgs = document.getElementById('ai-chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    const last = [...document.querySelectorAll('.ai-chat-msg.assistant')].pop();
    return {
      visible: visible(),
      preCount: last ? last.querySelectorAll('pre code').length : -1,
      highlighted: last ? [...last.querySelectorAll('pre code')].filter((c) => c.dataset.highlighted).length : -1,
      chars: last ? last.textContent.trim().length : -1
    };
  })()`);
  console.log('state: ' + JSON.stringify(state));
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('saved: ' + OUT);
  ws.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
