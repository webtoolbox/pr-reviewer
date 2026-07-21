const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Register minimal IPC handlers
ipcMain.handle('get-config', async () => ({ rules: { enabled: true } }));
ipcMain.handle('save-draft', async () => null);
ipcMain.handle('load-draft', async () => null);
ipcMain.handle('open-file', async () => null);
ipcMain.handle('export-markdown', async () => null);
ipcMain.handle('save-image', async () => null);
ipcMain.handle('list-prs', async () => ({ prs: [] }));
ipcMain.handle('load-pr', async () => ({ error: 'not available' }));
ipcMain.handle('get-pr-commits', async () => ({ commits: [] }));
ipcMain.handle('get-file-blame', async () => ({}));
ipcMain.handle('open-pr-new-window', async () => ({ error: 'not available' }));
ipcMain.handle('get-agent-rules', async () => ({
  agentsMd: '# AGENTS.md\n\n## Code Style\n- Use consistent indentation\n- Follow existing patterns\n',
  instructionFiles: {
    '.github/instructions/perl.md': '# Perl Guidelines\n- Use strict and warnings\n',
    '.github/instructions/javascript.md': '# JavaScript Guidelines\n- Use const/let\n'
  }
}));
ipcMain.handle('propose-rules', async () => ({
  proposals: [
    {
      rule: 'When using database queries, always use parameterized queries to prevent SQL injection',
      file: 'AGENTS.md',
      reason: 'Found raw SQL string concatenation in editPage.tpl line 45'
    },
    {
      rule: 'Template files must escape all user-supplied HTML entities using html_escape()',
      file: '.github/instructions/perl.md',
      reason: 'Unescaped user input rendered in template at line 78'
    },
    {
      rule: 'All form submissions must include CSRF token validation',
      file: 'AGENTS.md',
      reason: 'Missing CSRF check in form handler at line 112'
    }
  ]
}));
ipcMain.handle('save-agent-rules', async () => ({ results: [{ file: 'AGENTS.md', success: true, count: 2 }] }));
ipcMain.handle('delete-pr-files', async () => ({ deleted: 0 }));
ipcMain.handle('get-next-pr', async () => ({ pr: null }));
ipcMain.handle('submit-github-review', async () => ({ success: true }));

async function main() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
  await new Promise(resolve => win.webContents.on('did-finish-load', resolve));
  await new Promise(r => setTimeout(r, 1500));

  // Load a test diff
  const diffPath = process.argv[2] || '/tmp/test-screenshot.diff';
  if (fs.existsSync(diffPath)) {
    const content = fs.readFileSync(diffPath, 'utf8');
    try {
      await win.webContents.executeJavaScript(
        `loadDiff(${JSON.stringify(content)}); 'ok'`
      );
      console.log('Diff loaded');
    } catch(e) {
      console.error('loadDiff error:', e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Open the rules dialog using getElementById directly (avoid re-declaring const)
  try {
    await win.webContents.executeJavaScript(`
      (function() {
        var overlay = document.getElementById('rules-overlay');
        var body = document.getElementById('rules-body');
        var saveBtn = document.getElementById('btn-rules-save');
        
        overlay.style.display = 'flex';
        saveBtn.disabled = false;
        
        var mockProposals = [
          {
            rule: 'When using database queries, always use parameterized queries to prevent SQL injection',
            file: 'AGENTS.md',
            reason: 'Found raw SQL string concatenation in editPage.tpl line 45'
          },
          {
            rule: 'Template files must escape all user-supplied HTML entities using html_escape()',
            file: '.github/instructions/perl.md',
            reason: 'Unescaped user input rendered in template at line 78'
          },
          {
            rule: 'All form submissions must include CSRF token validation',
            file: 'AGENTS.md',
            reason: 'Missing CSRF check in form handler at line 112'
          }
        ];
        
        var availableFiles = ['AGENTS.md', '.github/instructions/perl.md', '.github/instructions/javascript.md'];
        
        var html = '';
        mockProposals.forEach(function(proposal, i) {
          html += '<div class="rule-item" data-index="' + i + '">' +
            '<div class="rule-item-header">' +
              '<input type="checkbox" id="rule-check-' + i + '" checked>' +
              '<span class="rule-reason">' + proposal.reason + '</span>' +
              '<select id="rule-file-' + i + '">' +
                availableFiles.map(function(f) { return '<option value="' + f + '"' + (f === proposal.file ? ' selected' : '') + '>' + f + '</option>'; }).join('') +
              '</select>' +
            '</div>' +
            '<textarea id="rule-text-' + i + '">' + proposal.rule + '</textarea>' +
          '</div>';
        });
        body.innerHTML = html;
      })();
      'done'
    `);
    console.log('Rules dialog opened');
  } catch(e) {
    console.error('Dialog injection error:', e.message);
  }

  await new Promise(r => setTimeout(r, 500));

  const image = await win.capturePage();
  const pngData = image.toPNG();
  const outPath = '/tmp/rules-dialog-screenshot.png';
  fs.writeFileSync(outPath, pngData);
  console.log('Screenshot saved to:', outPath);

  win.close();
  app.quit();
}

app.whenReady().then(main);
app.on('window-all-closed', () => app.quit());
