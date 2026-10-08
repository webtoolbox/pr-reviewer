// Open the All Comments panel with a pending PR comment and screenshot the
// footer (Close Pull Request + Submit Comment). Cleans up afterwards.
const WebSocket = require('/Users/sandeep/Repos/pr-reviewer/node_modules/ws');
const http = require('http');
const fs = require('fs');

const OUT = process.argv[2] || '/tmp/comments-footer.png';
// Optional: a long demo comment, so wrapping can be checked visually.
const TEXT = process.argv[3] ||
  'Verified the footer: Close Pull Request sits beside Submit Comment.';

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
  const page = (await getTargets()).find((t) => t.type === 'page');
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

  const setup = await ev(`(() => {
    const open = () => { const b = document.getElementById('btn-comments'); if (b) b.click(); };
    const panel = document.getElementById('comments-panel');
    if (!panel.classList.contains('open')) open();
    const add = panel.querySelector('.c-add-pr');
    if (!add) return 'no add button';
    add.click();
    const ta = document.getElementById('review-body');
    ta.value = ${JSON.stringify(TEXT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const addBtn = document.getElementById('pr-comment-add');
    if (addBtn.disabled) return 'add still disabled';
    addBtn.click();
    return 'ok';
  })()`);
  console.log('setup: ' + setup);
  await sleep(400);

  const state = await ev(`(() => {
    const panel = document.getElementById('comments-panel');
    const foot = panel.querySelector('.comments-panel-footer');
    const t = panel.querySelector('.comment-list-item .c-text');
    const cs = t ? getComputedStyle(t) : null;
    return {
      open: panel.classList.contains('open'),
      btnMoreGone: !document.getElementById('btn-more') && !document.getElementById('more-menu'),
      whiteSpace: cs ? cs.whiteSpace : null,
      clipped: t ? t.scrollHeight > t.clientHeight + 1 : null,
      textHeight: t ? Math.round(t.getBoundingClientRect().height) : null,
      firstText: t ? t.textContent.slice(0, 70) : null,
      buttons: foot ? [...foot.querySelectorAll('button')].map(b => ({ cls: b.className, text: b.textContent.trim() })) : null,
      rows: panel.querySelectorAll('.comment-list-item').length,
      footerHtml: foot ? foot.outerHTML.replace(/\\s+/g, ' ').slice(0, 400) : null
    };
  })()`);
  console.log('state: ' + JSON.stringify(state, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('saved: ' + OUT);

  // Leave the app clean: drop the demo pending comment.
  const cleanup = await ev(`(() => {
    const ta = document.getElementById('review-body');
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    renderCommentsList();
    return document.querySelectorAll('.c-submit-review').length;
  })()`);
  console.log('after cleanup, submit buttons: ' + cleanup);
  ws.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
