// End-to-end probe: drives the RUNNING PR Reviewer app over CDP, asks the AI
// chat for code, and verifies the reply renders as real code blocks.
const WebSocket = require('/Users/sandeep/Repos/pr-reviewer/node_modules/ws');
const http = require('http');
const fs = require('fs');

const MSG = process.argv[2] || 'Reply with exactly two fenced code blocks and nothing else: a perl subroutine named read_lines that reads a file into an array ref, and an HTML snippet with a div. Do not explain.';

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
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => t.type)));
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
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };

  console.log('opened panel:', await ev(`(() => { const b = document.getElementById('btn-ai-chat'); if (!b) return 'no-btn'; b.click(); return !!document.getElementById('ai-chat-panel') && document.getElementById('ai-chat-panel').style.display !== 'none'; })()`));
  console.log('send started:', await ev(`(() => {
    if (typeof sendAiChat !== 'function') return 'no-fn';
    const input = document.getElementById('ai-chat-input');
    if (!input) return 'no-input';
    input.value = ${JSON.stringify(MSG)};
    sendAiChat();
    return true;
  })()`));

  // Wait for the request to actually go busy (context lookup is async).
  let wentBusy = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const st = await ev(`(() => ({ busy: !!window.aiChatBusy }))()`);
    if (st.busy) { wentBusy = true; break; }
  }
  if (!wentBusy) console.log('WARN: sendAiChat never went busy (already answered?)');

  let done = false;
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const st = await ev(`(() => {
      const bubbles = [...document.querySelectorAll('.ai-chat-msg.assistant')];
      const last = bubbles[bubbles.length - 1];
      return { busy: !!window.aiChatBusy, msgs: bubbles.length,
               text: last ? last.textContent.trim() : '' };
    })()`);
    process.stdout.write(`  t=${(i + 1) * 3}s busy=${st.busy} msgs=${st.msgs} chars=${st.text.length}\n`);
    if (!st.busy && st.msgs >= 1 && st.text && st.text !== 'Thinking\u2026' && st.text.indexOf('Answer may be incomplete') === -1) { done = true; break; }
    if (!st.busy && st.msgs >= 1 && st.text.indexOf('Answer may be incomplete') !== -1) { console.log('INCOMPLETE: ' + st.text.slice(0, 300)); break; }
  }
  if (!done) throw new Error('timed out waiting for the reply');

  const report = await ev(`(() => {
    const bubbles = [...document.querySelectorAll('.ai-chat-msg.assistant')];
    const last = bubbles[bubbles.length - 1];
    if (!last) return { error: 'no assistant bubble' };
    const pres = last.querySelectorAll('pre');
    const codes = last.querySelectorAll('pre code');
    const langClasses = [...codes].map((c) => c.className);
    const hljsSpans = last.querySelectorAll('pre code .hljs-keyword, pre code .hljs-string, pre code .hljs-comment, pre code .hljs-tag').length;
    const highlighted = [...codes].filter((c) => c.dataset.highlighted).length;
    return {
      text: last.textContent.slice(0, 400),
      preCount: pres.length,
      codeCount: codes.length,
      langClasses,
      hljsSpans,
      highlighted,
      hasFence: last.innerHTML.indexOf('language-') !== -1,
      steps: document.querySelectorAll('.ai-chat-step').length
    };
  })()`);
  console.log('REPORT ' + JSON.stringify(report, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync('/tmp/ai-chat-code.png', Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot saved: /tmp/ai-chat-code.png');
  } else {
    console.log('screenshot failed: ' + JSON.stringify(shot).slice(0, 200));
  }
  ws.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
