const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function log(msg) { console.log(`[TEST] ${msg}`); }

const mockPRs = [
  { number: 6690, title: 'Client-Selectable Icon for Review', author: 'amulya-wt', created: '2026-07-15T10:00:00Z', reviewers: ['webtoolbox'], draft: false },
  { number: 6503, title: 'Edit poll from dialog for Review', author: 'laeeqwtb', created: '2026-07-10T10:00:00Z', reviewers: ['webtoolbox'], draft: false },
  { number: 7215, title: 'SSO options for Review', author: 'sandeep', created: '2026-07-20T10:00:00Z', reviewers: ['webtoolbox'], draft: true }
];

app.whenReady().then(async () => {
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
  ipcMain.handle('get-config', async () => ({
    aiTagPrefix: '@Hermes', chatId: null, prNumber: null,
    prFilter: { reviewRequested: true, titleContains: 'for review' },
    repoOwner: 'webtoolbox', repoName: 'Website-Toolbox',
    diff: { mode: 'since-review', excludeMerges: true, codeFileExtensions: ['.pm', '.cgi', '.js', '.tpl', '.css', '.less', '.json'] }
  }));

  // Open window with NO diff (simulates opening from dock)
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  win.loadFile('index.html');

  await new Promise(resolve => {
    win.webContents.on('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 1500));

        // TEST 1: Empty state is visible
        const emptyVisible = await win.webContents.executeJavaScript(`
          document.getElementById('empty-state').style.display !== 'none'
        `);
        log(`${emptyVisible ? '✓' : '✗'} Empty state visible when no diff loaded`);

        // TEST 2: Diff container hidden
        const diffHidden = await win.webContents.executeJavaScript(`
          document.getElementById('diff-container').style.display === 'none'
        `);
        log(`${diffHidden ? '✓' : '✗'} Diff container hidden when no diff loaded`);

        // TEST 3: Review buttons hidden
        const approveHidden = await win.webContents.executeJavaScript(`
          document.getElementById('btn-approve').style.display === 'none'
        `);
        log(`${approveHidden ? '✓' : '✗'} Approve button hidden when no diff loaded`);

        // TEST 4: PR wrapper still visible
        const prVisible = await win.webContents.executeJavaScript(`
          document.getElementById('pr-number-wrapper').style.display !== 'none'
        `);
        log(`${prVisible ? '✓' : '✗'} PR number wrapper visible in empty state`);

        // TEST 5: Can open PR dropdown
        await win.webContents.executeJavaScript(`
          document.getElementById('btn-pr-list').click();
        `);
        await new Promise(r => setTimeout(r, 1000));
        const prOpen = await win.webContents.executeJavaScript(`
          document.getElementById('pr-dropdown').classList.contains('open')
        `);
        log(`${prOpen ? '✓' : '✗'} PR dropdown opens in empty state`);

        // TEST 6: PRs listed
        const prCount = await win.webContents.executeJavaScript(`
          document.querySelectorAll('.pr-item').length
        `);
        log(`${prCount === 3 ? '✓' : '✗'} PRs listed in empty state: ${prCount} PRs`);

        // TEST 7: PR info says "No diff loaded"
        const prInfo = await win.webContents.executeJavaScript(`
          document.getElementById('pr-info').textContent
        `);
        log(`${prInfo.includes('No diff') ? '✓' : '✗'} PR info says "No diff loaded": "${prInfo}"`);

        // TEST 8: Can open file filter dropdown
        await win.webContents.executeJavaScript(`document.body.click()`);
        await new Promise(r => setTimeout(r, 300));
        await win.webContents.executeJavaScript(`
          document.getElementById('btn-file-filter').click();
        `);
        await new Promise(r => setTimeout(r, 500));
        const filterOpen = await win.webContents.executeJavaScript(`
          document.getElementById('file-filter-dropdown').classList.contains('open')
        `);
        log(`${filterOpen ? '✓' : '✗'} File filter dropdown opens in empty state`);

        // TEST 9: File filter shows empty (no extensions in diff)
        const filterCount = await win.webContents.executeJavaScript(`
          document.querySelectorAll('#file-filter-dropdown .filter-item').length
        `);
        log(`${filterCount === 0 ? '✓' : '✗'} File filter shows no extensions when no diff loaded: ${filterCount} items`);

        log('\nAll empty-state tests complete.');
      } catch (err) {
        log(`Test error: ${err.message}`);
      }
      resolve();
    });
  });
  app.exit(0);
});
app.on('window-all-closed', () => app.quit());
