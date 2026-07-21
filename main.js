const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');

let mainWindow;

// Load config from config.json
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const defaults = {
    aiCommand: 'hermes',
    aiSendArgs: ['send', '--to'],
    aiChatId: null,
    aiTagPrefix: '@Hermes',
    reviewSaveDir: '~/.hermes/profiles/wt/diff-reviews/pending',
    prFilter: { reviewRequested: true, titleContains: '' },
    repoOwner: '',
    repoName: ''
  };
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

const appConfig = loadConfig();

// Parse --chat-id and --pr-number from command line args
let aiChatId = appConfig.aiChatId;
let cliPrNumber = null;
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--chat-id' && rawArgs[i + 1]) {
    aiChatId = rawArgs[++i];
  } else if (rawArgs[i] === '--pr-number' && rawArgs[i + 1]) {
    cliPrNumber = rawArgs[++i];
  }
}

const positionalArgs = rawArgs.filter((_, i) => {
  const prev = rawArgs[i - 1];
  return rawArgs[i] !== '--chat-id' && rawArgs[i] !== '--pr-number'
    && prev !== '--chat-id' && prev !== '--pr-number';
});

// Send a message to the AI agent via CLI
function sendAiMessage(message) {
  if (!aiChatId) {
    console.error('[ai] No chat-id configured, cannot send message');
    return;
  }
  const args = [...appConfig.aiSendArgs, aiChatId, message];
  execFile(appConfig.aiCommand, args, (err) => {
    if (err) console.error(`[${appConfig.aiCommand}] send failed:`, err.message);
    else console.log(`[${appConfig.aiCommand}] message sent`);
  });
}

function expandPath(p) {
  if (p && p.startsWith('~')) {
    return path.join(app.getPath('home'), p.slice(1));
  }
  return p;
}

// Draft management
function getDraftPath(diffFilePath) {
  const draftDir = expandPath(path.join(appConfig.reviewSaveDir, '..', 'drafts'));
  fs.mkdirSync(draftDir, { recursive: true });
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(diffFilePath || 'unsaved').digest('hex').slice(0, 12);
  return path.join(draftDir, `draft-${hash}.json`);
}

function saveDraft(diffFilePath, draft) {
  try {
    const draftPath = getDraftPath(diffFilePath);
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
    return draftPath;
  } catch (err) {
    console.error('[draft] save failed:', err.message);
    return null;
  }
}

function loadDraft(diffFilePath) {
  try {
    const draftPath = getDraftPath(diffFilePath);
    if (fs.existsSync(draftPath)) {
      const raw = fs.readFileSync(draftPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[draft] load failed:', err.message);
  }
  return null;
}

function deleteDraft(diffFilePath) {
  try {
    const draftPath = getDraftPath(diffFilePath);
    if (fs.existsSync(draftPath)) {
      fs.unlinkSync(draftPath);
    }
  } catch (err) {
    console.error('[draft] delete failed:', err.message);
  }
}

// Generate diff for a PR
function generateDiff(prNumber) {
  return new Promise((resolve, reject) => {
    const repoPath = path.join(app.getPath('home'), 'Website-Toolbox');
    const owner = appConfig.repoOwner || 'webtoolbox';
    const repo = appConfig.repoName || 'Website-Toolbox';

    // Get the PR's base and head SHAs
    exec(`gh api repos/${owner}/${repo}/pulls/${prNumber} --jq '.base.sha, .head.sha'`, { cwd: repoPath }, (err, stdout) => {
      if (err) return reject(new Error(`Failed to get PR info: ${err.message}`));
      const [baseSha, headSha] = stdout.trim().split('\n');
      if (!baseSha || !headSha) return reject(new Error('Could not parse PR SHAs'));

      // Generate diff between base and head, filter for code files
      const cmd = `git diff ${baseSha}..${headSha} -- '*.pm' '*.cgi' '*.js' '*.tpl' '*.css' '*.less' '*.json'`;
      exec(cmd, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }, (err2, diffOut) => {
        if (err2) return reject(new Error(`Failed to generate diff: ${err2.message}`));
        const tmpPath = path.join(app.getPath('temp'), `pr-${prNumber}-clean.diff`);
        fs.writeFileSync(tmpPath, diffOut);
        resolve({ diffPath: tmpPath, baseSha, headSha });
      });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Diff Reviewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  if (positionalArgs[0] && fs.existsSync(positionalArgs[0])) {
    mainWindow.webContents.on('did-finish-load', () => {
      const diffContent = fs.readFileSync(positionalArgs[0], 'utf8');
      const fileName = path.basename(positionalArgs[0]);
      const filePath = path.resolve(positionalArgs[0]);
      mainWindow.webContents.send('load-diff', { content: diffContent, fileName, filePath });
    });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// File open dialog
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Diff Files', extensions: ['diff', 'patch'] }]
  });
  if (!result.canceled && result.filePaths[0]) {
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    const fileName = path.basename(result.filePaths[0]);
    const filePath = path.resolve(result.filePaths[0]);
    return { content, fileName, filePath };
  }
  return null;
});

// Draft IPC
ipcMain.handle('save-draft', async (event, { filePath, draft }) => saveDraft(filePath, draft));
ipcMain.handle('load-draft', async (event, filePath) => loadDraft(filePath));
ipcMain.handle('delete-draft', async (event, filePath) => { deleteDraft(filePath); return true; });

// Image save
ipcMain.handle('save-image', async (event, { reviewDir, imageDataUrl, fileName }) => {
  try {
    const dir = expandPath(reviewDir || appConfig.reviewSaveDir);
    const imagesDir = path.join(dir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const filePath = path.join(imagesDir, fileName);
    fs.writeFileSync(filePath, buffer);
    return `images/${fileName}`;
  } catch (err) {
    console.error('[image] save failed:', err.message);
    return null;
  }
});

// Generate diff for a PR number
ipcMain.handle('load-pr', async (event, prNumber) => {
  try {
    const { diffPath } = await generateDiff(prNumber);
    const content = fs.readFileSync(diffPath, 'utf8');
    const fileName = `pr-${prNumber}-clean.diff`;
    return { content, fileName, filePath: diffPath, prNumber };
  } catch (err) {
    console.error('[pr] load failed:', err.message);
    return { error: err.message };
  }
});

// List open PRs with filtering
ipcMain.handle('list-prs', async () => {
  const owner = appConfig.repoOwner || 'webtoolbox';
  const repo = appConfig.repoName || 'Website-Toolbox';
  const filter = appConfig.prFilter || {};

  return new Promise((resolve) => {
    // Fetch open PRs
    let cmd = `gh api 'repos/${owner}/${repo}/pulls?state=open&per_page=50' --jq '[.[] | {number, title, author: .user.login, created: .created_at, reviewers: [.requested_reviewers[].login], draft}]'`;
    exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error('[list-prs] failed:', err.message);
        resolve({ prs: [], error: err.message });
        return;
      }

      let prs = [];
      try {
        prs = JSON.parse(stdout);
      } catch (e) {
        resolve({ prs: [], error: 'Failed to parse PR list' });
        return;
      }

      // Filter: review requested
      if (filter.reviewRequested) {
        prs = prs.filter(pr => pr.reviewers && pr.reviewers.includes('webtoolbox'));
      }

      // Filter: title contains
      if (filter.titleContains) {
        const needle = filter.titleContains.toLowerCase();
        prs = prs.filter(pr => pr.title.toLowerCase().includes(needle));
      }

      // Sort by created desc
      prs.sort((a, b) => new Date(b.created) - new Date(a.created));

      resolve({ prs });
    });
  });
});

// Final review submit
ipcMain.handle('save-review', async (event, review) => {
  const aiTag = (appConfig.aiTagPrefix || '@Hermes').toLowerCase();
  const aiComments = [];
  const prComments = [];
  for (const c of review.comments || []) {
    if (c.text.toLowerCase().startsWith(aiTag)) {
      aiComments.push(c);
    } else {
      prComments.push(c);
    }
  }

  for (const c of aiComments) {
    const level = c.level || 'line';
    let msg = '';
    if (level === 'file') {
      msg = `[File comment: ${c.file}]\n${c.text.replace(aiTag, '').trim()}`;
    } else {
      const side = c.side || 'RIGHT';
      const codeContext = c.codeContext || '';
      msg = `[${c.file} line ${c.line} (${side})]${codeContext ? '\n```' + codeContext + '```' : ''}\n${c.text.replace(aiTag, '').trim()}`;
    }
    sendAiMessage(msg);
  }

  const reviewToSave = { ...review, comments: prComments };
  const reviewDir = expandPath(appConfig.reviewSaveDir);
  fs.mkdirSync(reviewDir, { recursive: true });
  const filename = `review-${Date.now()}.json`;
  const outputPath = path.join(reviewDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(reviewToSave, null, 2));

  if (review.filePath) deleteDraft(review.filePath);

  const prNum = review.prNumber || cliPrNumber;
  const prCount = prComments.length;
  const aiCount = aiComments.length;
  let summary = `Review submitted for PR #${prNum || '?'}: ${review.type}`;
  if (prCount > 0) summary += ` with ${prCount} line comment${prCount !== 1 ? 's' : ''}`;
  if (aiCount > 0) summary += ` (${aiCount} sent to AI)`;
  sendAiMessage(summary);

  return outputPath;
});

// Export markdown
ipcMain.handle('export-markdown', async (event, { markdown, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Review as Markdown',
    defaultPath: defaultName || 'review.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, markdown);
    return result.filePath;
  }
  return null;
});

// Config
ipcMain.handle('get-config', async () => ({
  chatId: aiChatId,
  prNumber: cliPrNumber,
  aiTagPrefix: appConfig.aiTagPrefix || '@Hermes',
  aiCommand: appConfig.aiCommand,
  prFilter: appConfig.prFilter || {},
  repoOwner: appConfig.repoOwner || '',
  repoName: appConfig.repoName || ''
}));
