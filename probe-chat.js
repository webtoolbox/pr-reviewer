const { app, BrowserWindow, ipcMain } = require('electron');
const p = require('path');
const fs = require('fs');

const reg = (h, fn) => { try { ipcMain.handle(h, fn); } catch (e) {} };
['open-file', 'save-review', 'save-draft', 'load-draft', 'delete-draft', 'load-pr',
 'open-pr-new-window', 'save-image', 'open-file-in-editor', 'save-preferences',
 'export-markdown', 'get-collaborators', 'list-repos', 'save-repos', 'list-all-prs',
 'list-prs', 'get-review-comments', 'get-pr-commits', 'get-file-blame',
 'expand-diff-context', 'submit-github-review', 'get-agent-rules', 'propose-rules',
 'save-agent-rules', 'delete-agent-rules', 'delete-pr-files', 'get-next-pr',
 'download-github-images', 'auto-fix-with-ai', 'check-update', 'apply-update',
 'set-auto-update', 'close-pr', 'check-binaries', 'auto-detect-agent', 'ai-chat',
 'ask-ai-question', 'send-ai-message', 'get-log', 'open-external'].forEach(h => reg(h, async () => null));
reg('get-config', async () => ({ aiTagPrefix: '@Hermes', repoOwner: 'webtoolbox', repoName: 'Website-Toolbox',
  editorCommand: 'code', contextLines: 5, diff: { excludeMerges: true, viewMode: 'unified' },
  imageUpload: { enabled: false }, cleanup: { enabled: true, retentionDays: 180 },
  rules: { enabled: false }, autoFix: { enabled: false }, hermesProfile: 'wt' }));

const SAMPLE = [
  'Here is a helper in Perl:',
  '',
  '```perl',
  'sub cache_key {',
  '    my ($self, $id) = @_;',
  '    my $prefix = $self->{prefix} || "sub";',
  '    return "$prefix:$id";',
  '}',
  '```',
  '',
  'Use it inline with `cache_key($id)`, and for HTML:',
  '',
  '```html',
  '<div class="cache">',
  '  <span id="key">value</span>',
  '</div>',
  '```',
  '',
  'No language tag either:',
  '',
  '```',
  'plain block',
  'line 2',
  '```'
].join('\n');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1200, height: 900, show: false,
    webPreferences: { preload: p.join(__dirname, 'preload.js'), contextIsolation: true } });
  w.loadFile('index.html');
  w.webContents.on('did-finish-load', async () => {
    try {
      const html = await w.webContents.executeJavaScript('renderMarkdownHtml(' + JSON.stringify(SAMPLE) + ')');
      console.log('=== RENDERED HTML ===');
      console.log(html);
      const info = await w.webContents.executeJavaScript(`
        (() => {
          const out = {};
          out.markedVersion = (typeof marked !== 'undefined' && marked.defaults) ? JSON.stringify(marked.defaults) : 'n/a';
          out.hljs = typeof window.hljs !== 'undefined';
          out.hljsLanguages = (window.hljs && window.hljs.listLanguages) ? window.hljs.listLanguages() : [];
          // Render into the real chat bubble and measure
          document.getElementById('ai-chat-panel').classList.add('open');
          const el = appendAiChatMsg('assistant', ${JSON.stringify(SAMPLE)});
          const pres = el.querySelectorAll('pre');
          out.preCount = pres.length;
          out.preHasHljs = Array.from(pres).map(pr => {
            const c = pr.querySelector('code');
            return { cls: c ? c.className : '', text: c ? c.textContent.slice(0, 40) : '' };
          });
          const firstPre = pres[0];
          if (firstPre) {
            const cs = getComputedStyle(firstPre);
            out.preStyle = { bg: cs.backgroundColor, border: cs.borderColor, font: cs.fontFamily, overflow: cs.overflowX, whiteSpace: cs.whiteSpace };
            const r = firstPre.getBoundingClientRect();
            out.preBox = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          }
          out.bubbleTextStart = el.textContent.slice(0, 60);
          out.hasBacktickFence = el.textContent.includes('\`\`\`');
          return out;
        })()
      `);
      console.log('=== DOM INFO ===');
      console.log(JSON.stringify(info, null, 2));
      await new Promise(r => setTimeout(r, 300));
      const img = await w.capturePage();
      fs.writeFileSync('/tmp/chat-probe.png', img.toPNG());
      console.log('shot written');
    } catch (e) {
      console.error('PROBE ERROR:', e && e.message);
    }
    app.exit(0);
  });
});
app.on('window-all-closed', () => app.quit());
