const { app, BrowserWindow, ipcMain } = require('electron');
const p = require('path');
const fs = require('fs');

const diff = fs.readFileSync('/tmp/test-screenshot.diff', 'utf8');
const SHOTS = p.join(__dirname, 'screenshots');

// capturePage returns device pixels; getBoundingClientRect returns CSS px.
function cropTo(img, rect) {
  const scale = img.getSize().width / 1280;
  const x = Math.round(Math.max(0, rect.x * scale));
  const y = Math.round(Math.max(0, rect.y * scale));
  const width = Math.min(img.getSize().width - x, Math.round(rect.width * scale));
  const height = Math.min(img.getSize().height - y, Math.round(rect.height * scale));
  return img.crop({ x, y, width, height });
}

['open-file', 'save-review', 'save-draft', 'load-draft', 'delete-draft', 'load-pr',
 'open-pr-new-window', 'save-image', 'open-file-in-editor', 'save-preferences',
 'export-markdown', 'get-collaborators', 'list-repos', 'save-repos', 'list-all-prs',
 'expand-diff-context', 'submit-github-review', 'get-agent-rules', 'propose-rules',
 'save-agent-rules', 'delete-agent-rules', 'delete-pr-files', 'get-next-pr',
 'download-github-images', 'auto-fix-with-ai', 'check-update', 'apply-update',
 'set-auto-update', 'close-pr', 'ai-chat',
 'ask-ai-question', 'send-ai-message', 'get-log', 'open-external'].forEach(h => {
  try { ipcMain.handle(h, async () => null); } catch (e) { /* already registered */ }
});

const reg = (h, fn) => { try { ipcMain.handle(h, fn); } catch (e) {} };
reg('list-prs', async () => ({ prs: [] }));
reg('get-pr-commits', async () => ({ commits: [], prUrl: '#' }));
reg('get-file-blame', async () => ({}));
reg('get-config', async () => ({
  aiTagPrefix: '@Hermes', repoOwner: 'webtoolbox', repoName: 'Website-Toolbox',
  editorCommand: 'code', contextLines: 5, diff: { excludeMerges: true, viewMode: 'unified' },
  imageUpload: { enabled: false }, cleanup: { enabled: true, retentionDays: 180 },
  rules: { enabled: false }, autoFix: { enabled: false }, hermesProfile: 'wt'
}));
reg('get-review-comments', async () => ({
  comments: [
    { id: 11, path: 'lib/Cache/Sub.pl', line: 20, side: 'RIGHT', author: 'rashi-wt',
      authorAvatar: '', body: 'Should the prefix be configurable per instance?', resolved: false, createdAt: new Date().toISOString() },
    { id: 12, path: 'lib/Members/Profile.pm', line: 47, side: 'RIGHT', author: 'alok-wt',
      authorAvatar: '', body: 'Nice, this removes a query per page load.', resolved: true, createdAt: new Date().toISOString() }
  ]
}));
reg('check-binaries', async () => ({ ghAvailable: true, availableAgents: [{ id: 'hermes', name: 'Hermes', command: 'hermes', tagPrefix: '@Hermes' }] }));
reg('auto-detect-agent', async () => ({ detected: false, agent: null }));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { preload: p.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  console.log('loading file');
  w.loadFile('index.html');
  w.webContents.on('console-message', (e, lvl, msg) => console.log('[renderer]', msg));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  w.webContents.on('did-finish-load', async () => {
    try {
      console.log('loadDiff...');
      await w.webContents.executeJavaScript('loadDiff(' + JSON.stringify(diff) + ')');
      await sleep(2500);

      // A pending line comment + a comment on the entire PR, panel open
      await w.webContents.executeJavaScript(`
        comments = [
          { _uid: 501, file: 'lib/Cache/Sub.pl', line: 20, side: 'RIGHT', text: 'Add a unit test for cache_key()', isAiTagged: false, level: 'line' }
        ];
        inlineReviewComments = ${JSON.stringify([
          { id: 11, path: 'lib/Cache/Sub.pl', line: 20, side: 'RIGHT', author: 'rashi-wt', body: 'Should the prefix be configurable per instance?', resolved: false },
          { id: 12, path: 'lib/Members/Profile.pm', line: 47, side: 'RIGHT', author: 'alok-wt', body: 'Nice, this removes a query per page load.', resolved: true }
        ])};
        document.getElementById('review-body').value = 'Looks good overall — please add a test for the new cache key helper before merge.';
        document.getElementById('btn-comments').style.display = 'flex';
        openCommentsPanel();
      `);
      await sleep(400);

      console.log('panel shot setup done');
      const panelRect = await w.webContents.executeJavaScript(`
        (() => { const r = document.getElementById('comments-panel').getBoundingClientRect();
                 return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 }; })()
      `);
      let img = await w.capturePage();
      fs.writeFileSync(p.join(SHOTS, 'prcomment-panel-full.png'), img.toPNG());
      img = cropTo(img, panelRect);
      fs.writeFileSync(p.join(SHOTS, 'prcomment-panel.png'), img.toPNG());

      // Open the Add PR Comment dialog from the "+"
      console.log('clicking +');
      await w.webContents.executeJavaScript(`document.querySelector('.c-add-pr').click();`);
      await sleep(300);
      // Type so the box is not empty and Add is enabled
      await w.webContents.executeJavaScript(`
        const ta = document.getElementById('review-body');
        ta.value = 'Looks good overall — please add a test for the new cache key helper before merge.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await sleep(300);
      const dialogRect = await w.webContents.executeJavaScript(`
        (() => { const r = document.getElementById('pr-comment-panel').getBoundingClientRect();
                 return { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 60), width: r.width + 80, height: r.height + 120 }; })()
      `);
      img = await w.capturePage();
      fs.writeFileSync(p.join(SHOTS, 'prcomment-dialog-full.png'), img.toPNG());
      img = cropTo(img, dialogRect);
      fs.writeFileSync(p.join(SHOTS, 'prcomment-dialog.png'), img.toPNG());

      fs.writeFileSync(p.join(SHOTS, 'rects.json'), JSON.stringify({ panelRect, dialogRect }));
      console.log('done', JSON.stringify({ panelRect, dialogRect }));
    } catch (err) {
      console.error('SHOT ERROR:', err && err.message);
    }
    app.exit(0);
  });
});

app.on('window-all-closed', () => app.quit());
