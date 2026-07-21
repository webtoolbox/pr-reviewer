const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let testResults = [];
let testDiffPath = process.argv[2] || '/tmp/test-screenshot.diff';

function log(msg) { console.log(`[TEST] ${msg}`); }
function record(name, pass, detail) {
  testResults.push({ name, pass, detail: detail || '' });
  log(`${pass ? '✓' : '✗'} ${name}${detail ? ': ' + detail : ''}`);
}

const mockPRs = [
  { number: 6690, title: 'Client-Selectable Icon for Review', author: 'amulya-wt', created: '2026-07-15T10:00:00Z', reviewers: ['webtoolbox'], draft: false },
  { number: 6503, title: 'Edit poll from dialog for Review', author: 'laeeqwtb', created: '2026-07-10T10:00:00Z', reviewers: ['webtoolbox'], draft: false },
  { number: 7215, title: 'SSO options for Review', author: 'sandeep', created: '2026-07-20T10:00:00Z', reviewers: ['webtoolbox'], draft: true }
];

const mockConfig = {
  aiTagPrefix: '@Hermes', chatId: 'test-session', prNumber: '6690',
  prFilter: { reviewRequested: true, titleContains: 'for review' },
  repoOwner: 'webtoolbox', repoName: 'Website-Toolbox', imageUploadEnabled: true,
  diff: { mode: 'since-review', excludeMerges: true, codeFileExtensions: ['.pm', '.cgi', '.js', '.tpl', '.css', '.less', '.json'] }
};

async function runTests() {
  log('Starting new feature tests...');
  log(`Test diff: ${testDiffPath}`);

  ipcMain.handle('open-file', async () => null);
  ipcMain.handle('save-review', async () => '/dev/null');
  ipcMain.handle('save-draft', async () => null);
  ipcMain.handle('load-draft', async () => null);
  ipcMain.handle('delete-draft', async () => null);
  ipcMain.handle('save-image', async () => ({ localPath: 'test', url: null }));
  ipcMain.handle('export-markdown', async () => null);
  ipcMain.handle('load-pr', async () => ({ error: 'not connected' }));
  ipcMain.handle('open-pr-new-window', async () => ({ error: 'not connected' }));
  ipcMain.handle('list-prs', async () => ({ prs: mockPRs }));
  ipcMain.handle('get-config', async () => mockConfig);

  const diffContent = fs.readFileSync(testDiffPath, 'utf8');

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  win.loadFile('index.html');

  await new Promise(resolve => {
    win.webContents.on('did-finish-load', async () => {
      try {
        // Load diff
        await win.webContents.executeJavaScript(`loadDiff(${JSON.stringify(diffContent)}, '${testDiffPath}')`);
        await new Promise(r => setTimeout(r, 1500));

        // TEST 1: Diff loaded
        const emptyHidden = await win.webContents.executeJavaScript(`document.getElementById('empty-state').style.display`);
        record('Diff loaded (empty state hidden)', emptyHidden === 'none');

        // TEST 2: PR wrapper visible
        const prVis = await win.webContents.executeJavaScript(`document.getElementById('pr-number-wrapper').style.display`);
        record('PR number wrapper visible', prVis !== 'none');

        // TEST 3: Filter button exists
        const filterBtn = await win.webContents.executeJavaScript(`!!document.getElementById('btn-file-filter')`);
        record('File filter button exists', filterBtn);

        // TEST 4: Open PR dropdown
        await win.webContents.executeJavaScript(`document.getElementById('btn-pr-list').click()`);
        await new Promise(r => setTimeout(r, 1000));
        const prOpen = await win.webContents.executeJavaScript(`document.getElementById('pr-dropdown').classList.contains('open')`);
        record('PR dropdown opens on click', prOpen);

        // TEST 5: PRs listed
        const prCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.pr-item').length`);
        record('PR dropdown lists PRs', prCount === 3, `found ${prCount} PRs`);

        // TEST 6: PR item has new window button
        const hasNewWinBtn = await win.webContents.executeJavaScript(`!!document.querySelector('.pr-new-window-btn')`);
        record('PR items have new window button', hasNewWinBtn);

        // TEST 7: PR items do NOT show reviewers
        const hasReviewers = await win.webContents.executeJavaScript(`!!document.querySelector('.pr-reviewers')`);
        record('PR items do NOT show reviewers', !hasReviewers);

        // TEST 8: PR items show draft badge
        const hasDraft = await win.webContents.executeJavaScript(`!!document.querySelector('.pr-draft')`);
        record('PR items show draft badge', hasDraft);

        // TEST 9: PR item has pr-item-content wrapper
        const hasContent = await win.webContents.executeJavaScript(`!!document.querySelector('.pr-item-content')`);
        record('PR item has content wrapper', hasContent);

        // TEST 10: Close PR dropdown
        await win.webContents.executeJavaScript(`document.body.click()`);
        await new Promise(r => setTimeout(r, 300));
        const prClosed = await win.webContents.executeJavaScript(`!document.getElementById('pr-dropdown').classList.contains('open')`);
        record('PR dropdown closes on outside click', prClosed);

        // TEST 11: Open file filter dropdown
        await win.webContents.executeJavaScript(`document.getElementById('btn-file-filter').click()`);
        await new Promise(r => setTimeout(r, 500));
        const filterOpen = await win.webContents.executeJavaScript(`document.getElementById('file-filter-dropdown').classList.contains('open')`);
        record('File filter dropdown opens on click', filterOpen);

        // TEST 12: File filter shows checkboxes
        const filterCount = await win.webContents.executeJavaScript(`document.querySelectorAll('#file-filter-dropdown .filter-item').length`);
        record('File filter shows extension checkboxes', filterCount > 0, `found ${filterCount} extensions`);

        // TEST 13: Checkboxes are checked
        const checkedCount = await win.webContents.executeJavaScript(`document.querySelectorAll('#file-filter-dropdown .filter-item input:checked').length`);
        record('Checkboxes checked based on config', checkedCount > 0, `${checkedCount} checked`);

        // TEST 14: All/None/Apply buttons exist
        const allBtn = await win.webContents.executeJavaScript(`!!document.getElementById('filter-select-all')`);
        const noneBtn = await win.webContents.executeJavaScript(`!!document.getElementById('filter-select-none')`);
        const applyBtn = await win.webContents.executeJavaScript(`!!document.getElementById('filter-apply')`);
        record('All/None/Apply buttons exist', allBtn && noneBtn && applyBtn);

        // TEST 15: None button unchecks all
        await win.webContents.executeJavaScript(`document.getElementById('filter-select-none').click()`);
        const noneChecked = await win.webContents.executeJavaScript(`document.querySelectorAll('#file-filter-dropdown .filter-item input:checked').length`);
        record('None button unchecks all', noneChecked === 0);

        // TEST 16: All button checks all
        await win.webContents.executeJavaScript(`document.getElementById('filter-select-all').click()`);
        const allChecked = await win.webContents.executeJavaScript(`document.querySelectorAll('#file-filter-dropdown .filter-item input:checked').length`);
        record('All button checks all', allChecked === filterCount, `${allChecked} of ${filterCount}`);

        // TEST 17: Close file filter
        await win.webContents.executeJavaScript(`document.body.click()`);
        await new Promise(r => setTimeout(r, 300));
        const filterClosed = await win.webContents.executeJavaScript(`!document.getElementById('file-filter-dropdown').classList.contains('open')`);
        record('File filter dropdown closes on outside click', filterClosed);

        // TEST 18: File comment buttons exist
        const fileBtns = await win.webContents.executeJavaScript(`document.querySelectorAll('.file-comment-btn').length`);
        record('File comment buttons on file headers', fileBtns > 0, `found ${fileBtns}`);

        // TEST 19: Click file comment button opens form
        if (fileBtns > 0) {
          await win.webContents.executeJavaScript(`document.querySelector('.file-comment-btn').click()`);
          await new Promise(r => setTimeout(r, 300));
          const formExists = await win.webContents.executeJavaScript(`!!document.querySelector('.comment-form')`);
          record('File comment button opens form', formExists);
          await win.webContents.executeJavaScript(`const c = document.querySelector('.btn-cancel'); if(c) c.click();`);
          await new Promise(r => setTimeout(r, 200));
        }

        // TEST 20: Review buttons visible
        const approveVis = await win.webContents.executeJavaScript(`document.getElementById('btn-approve').style.display`);
        record('Approve button visible when diff loaded', approveVis !== 'none');

        // TEST 21: PR info bar has content
        const prInfoHtml = await win.webContents.executeJavaScript(`document.getElementById('pr-info').innerHTML`);
        record('PR info bar has content', prInfoHtml.length > 0, `content: "${prInfoHtml.substring(0, 40)}"`);

        // TEST 22: Title bar set
        const title = await win.webContents.executeJavaScript(`document.title`);
        record('Title bar includes app name', title.includes('Diff Reviewer'), `title: "${title}"`);

        // TEST 23: Export button exists
        const exportBtn = await win.webContents.executeJavaScript(`!!document.getElementById('btn-export')`);
        record('Export button exists', exportBtn);

        // TEST 24: PR input exists
        const prInput = await win.webContents.executeJavaScript(`!!document.getElementById('pr-number')`);
        record('PR number input exists', prInput);

        // TEST 25: Config has diff settings
        const cfg = await win.webContents.executeJavaScript(`window.electronAPI.getConfig()`);
        record('Config has repoOwner', !!cfg.repoOwner);
        record('Config has diff.mode', !!cfg.diff.mode);
        record('Config has codeFileExtensions', Array.isArray(cfg.diff.codeFileExtensions) && cfg.diff.codeFileExtensions.length > 0, `${cfg.diff.codeFileExtensions.length} extensions`);

        // Summary
        const passed = testResults.filter(r => r.pass).length;
        const failed = testResults.filter(r => !r.pass).length;
        log(`\nResults: ${passed} passed, ${failed} failed, ${testResults.length} total`);
        if (failed > 0) {
          log('\nFailed tests:');
          testResults.filter(r => !r.pass).forEach(r => log(`  ✗ ${r.name}: ${r.detail}`));
        }
      } catch (err) {
        log(`Test error: ${err.message}\n${err.stack}`);
      }
      resolve();
    });
  });
  app.exit(0);
}

app.whenReady().then(runTests);
app.on('window-all-closed', () => app.quit());
