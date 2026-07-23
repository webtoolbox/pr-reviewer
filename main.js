const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec, execSync } = require('child_process');

// Track all open windows
const windows = new Map();
let windowCounter = 0;

// Fix PATH for Electron (launched from dock doesn't inherit shell PATH)
const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
const currentPath = process.env.PATH || '';
const missingPaths = extraPaths.filter(p => !currentPath.includes(p));
if (missingPaths.length) {
  process.env.PATH = missingPaths.join(':') + ':' + currentPath;
}

function execGh(args, opts = {}) {
  const cmd = `gh ${args}`;
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: opts.timeout || 30000, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// Load config: private (~/.config/pr-reviewer/config.json) overrides public (./config.json)
function loadConfig() {
  const publicConfigPath = path.join(__dirname, 'config.json');
  const privateConfigPath = path.join(app.getPath('home'), '.config', 'pr-reviewer', 'config.json');

  const defaults = {
    aiCommand: 'hermes',
    aiSendArgs: ['send', '--to'],
    aiChatId: null,
    aiTagPrefix: '@Hermes',
    reviewSaveDir: '',  // Will default to app userData/reviews
    prFilter: { reviewRequested: true, titleContains: '' },
    repoOwner: '',
    repoName: '',
    repoPath: '',
    editorCommand: 'code',
    contextLines: 5,
    imageUpload: {
      enabled: false,
      provider: 's3',
      s3Bucket: '',
      s3Prefix: '',
      s3Acl: 'public-read',
      awsProfile: 'default',
      awsRegion: 'us-east-1'
    },
    autoFix: {
      enabled: true
    }
  };

  let config = { ...defaults };

  try {
    const raw = fs.readFileSync(publicConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...config, ...parsed };
    if (parsed.imageUpload) config.imageUpload = { ...config.imageUpload, ...parsed.imageUpload };
    if (parsed.prFilter) config.prFilter = { ...config.prFilter, ...parsed.prFilter };
    if (parsed.autoFix) config.autoFix = { ...config.autoFix, ...parsed.autoFix };
  } catch {}

  try {
    const raw = fs.readFileSync(privateConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...config, ...parsed };
    if (parsed.imageUpload) config.imageUpload = { ...config.imageUpload, ...parsed.imageUpload };
    if (parsed.prFilter) config.prFilter = { ...config.prFilter, ...parsed.prFilter };
    if (parsed.autoFix) config.autoFix = { ...config.autoFix, ...parsed.autoFix };
  } catch {}

  return config;
}

const appConfig = loadConfig();

// Parse CLI args
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

function sendAiMessage(message, prNumber) {
  if (!aiChatId) {
    const prefix = prNumber ? `[PR #${prNumber}] ` : '';
    console.log('[ai] No chat-id configured, sending to new session');
    const args = [appConfig.aiSendArgs[0], prefix + message];
    execFile(appConfig.aiCommand, args, (err) => {
      if (err) console.error(`[${appConfig.aiCommand}] send failed:`, err.message);
      else console.log(`[${appConfig.aiCommand}] message sent to new session`);
    });
    return;
  }
  const args = [...appConfig.aiSendArgs, aiChatId, message];
  execFile(appConfig.aiCommand, args, (err) => {
    if (err) console.error(`[${appConfig.aiCommand}] send failed:`, err.message);
    else console.log(`[${appConfig.aiCommand}] message sent`);
  });
}

// Ask AI and wait for response
function askAiQuestion(question, prNumber) {
  return new Promise((resolve) => {
    const prefix = prNumber ? `[PR #${prNumber}] ` : '';
    const args = ['chat', '-q', prefix + question];
    execFile(appConfig.aiCommand, args, { timeout: 120000 }, (err, stdout) => {
      if (err) {
        console.error(`[${appConfig.aiCommand}] ask failed:`, err.message);
        resolve({ error: err.message });
      } else {
        resolve({ response: stdout.trim() });
      }
    });
  });
}

function expandPath(p) {
  if (p && p.startsWith('~')) {
    return path.join(app.getPath('home'), p.slice(1));
  }
  return p;
}

// Get the app's data directory for reviews, drafts, images, etc.
function getAppDataDir() {
  return app.getPath('userData');
}

function getReviewDir() {
  const configured = appConfig.reviewSaveDir;
  if (configured) {
    return expandPath(configured);
  }
  // Default to app's userData/reviews
  const dir = path.join(getAppDataDir(), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDraftsDir() {
  const dir = path.join(getAppDataDir(), 'drafts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getGeneratedDir() {
  const dir = path.join(getAppDataDir(), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Cleanup old files based on retention policy
function cleanupOldFiles() {
  const cleanup = appConfig.cleanup || {};
  if (!cleanup.enabled) {
    console.log('[cleanup] Disabled');
    return;
  }

  const retentionDays = cleanup.retentionDays || 180;
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let deletedCount = 0;

  const dirsToClean = [
    { dir: getReviewDir(), label: 'reviews' },
    { dir: getDraftsDir(), label: 'drafts' },
    { dir: getGeneratedDir(), label: 'generated' },
    { dir: path.join(getReviewDir(), 'images'), label: 'images' }
  ];

  for (const { dir, label } of dirsToClean) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      } catch (err) {
        console.error(`[cleanup] Error processing ${filePath}:`, err.message);
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`[cleanup] Deleted ${deletedCount} files older than ${retentionDays} days`);
  } else {
    console.log(`[cleanup] No files older than ${retentionDays} days to delete`);
  }
}

// Draft management
function getDraftPath(diffFilePath) {
  const draftDir = getDraftsDir();
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

// S3 upload
function uploadImageToS3(imageDataUrl, fileName) {
  return new Promise((resolve, reject) => {
    const upload = appConfig.imageUpload || {};
    if (!upload.enabled || !upload.s3Bucket) {
      return reject(new Error('S3 image upload not configured'));
    }

    const tmpPath = path.join(getGeneratedDir(), fileName);
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));

    const bucket = upload.s3Bucket;
    const prefix = upload.s3Prefix || '';
    const acl = upload.s3Acl || 'public-read';
    const profile = upload.awsProfile || 'default';
    const region = upload.awsRegion || 'us-east-1';
    const s3Key = prefix ? `${prefix}/${fileName}` : fileName;

    const cmd = `aws --profile ${profile} --region ${region} s3 cp "${tmpPath}" "s3://${bucket}/${s3Key}" --acl ${acl}`;

    exec(cmd, { timeout: 30000 }, (err) => {
      try { fs.unlinkSync(tmpPath); } catch {}

      if (err) {
        console.error('[s3] upload failed:', err.message);
        return reject(new Error(`S3 upload failed: ${err.message}`));
      }

      const url = `https://${bucket}.s3.amazonaws.com/${encodeURIComponent(fileName)}`;
      console.log('[s3] uploaded:', url);
      resolve(url);
    });
  });
}

// Generate diff for a PR
// Helper: exec with promise
function execPromise(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr || ''}`));
      else resolve(stdout.trim());
    });
  });
}

// Helper: paginate through all reviews for a PR
async function getAllReviews(owner, repo, prNumber) {
  let page = 1;
  let allReviews = [];

  while (true) {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}"`
    );
    const pageReviews = JSON.parse(stdout || '[]');
    if (pageReviews.length === 0) break;
    allReviews = allReviews.concat(pageReviews);
    if (pageReviews.length < 100) break;
    page++;
  }

  return allReviews;
}

// Helper: find last commit before a date
async function findLastCommitBefore(owner, repo, prNumber, targetDate) {
  let page = 1;

  while (true) {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}"`
    );
    const commits = JSON.parse(stdout || '[]');
    if (commits.length === 0) break;

    // Find last commit with date <= targetDate
    let lastBefore = null;
    for (const commit of commits) {
      if (commit.commit.committer.date <= targetDate) {
        lastBefore = commit.sha;
      }
    }

    // If all commits are after target date, we've gone too far
    if (commits[0].commit.committer.date > targetDate) {
      break;
    }

    // If the last commit in this page is after target date, we found our boundary
    if (commits[commits.length - 1].commit.committer.date > targetDate && lastBefore) {
      return lastBefore;
    }

    if (commits.length < 100) break;
    page++;
  }

  return null;
}

// Generate diff for a PR — supports full diff or since-last-review
async function generateDiff(prNumber, repoKey) {
  const repoPath = path.join(app.getPath('home'), 'Website-Toolbox');
  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner || 'webtoolbox';
    repo = appConfig.repoName || 'Website-Toolbox';
  }
  const diffMode = (appConfig.diff || {}).mode || 'since-review';

  // Get HEAD SHA
  const headSha = await execPromise(
    `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefOid --jq '.headRefOid'`
  );

  if (!headSha) {
    throw new Error('Could not get PR HEAD SHA');
  }

  let baseSha = null;
  let reviewInfo = null;

  if (diffMode === 'since-review') {
    // Find the most recent non-COMMENTED review
    const allReviews = await getAllReviews(owner, repo, prNumber);
    const reviews = allReviews
      .filter(r => r.user.login === owner && r.submitted_at && r.state !== 'COMMENTED')
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

    if (reviews.length > 0) {
      const review = reviews[0];

      if (review.state === 'DISMISSED') {
        // For dismissed reviews, use commit_id directly
        baseSha = review.commit_id;
        reviewInfo = { date: review.submitted_at, state: review.state };
      } else {
        // For non-dismissed reviews, verify commit_id is not mutated
        const commitDate = await execPromise(
          `gh api "repos/${owner}/${repo}/commits/${review.commit_id}" --jq '.commit.committer.date'`
        );

        if (commitDate > review.submitted_at) {
          // Commit date is after review date — commit_id was mutated
          const actualCommit = await findLastCommitBefore(owner, repo, prNumber, review.submitted_at);
          if (actualCommit) {
            baseSha = actualCommit;
            reviewInfo = { date: review.submitted_at, state: review.state, commitMutated: true };
          } else {
            baseSha = review.commit_id;
            reviewInfo = { date: review.submitted_at, state: review.state };
          }
        } else {
          baseSha = review.commit_id;
          reviewInfo = { date: review.submitted_at, state: review.state };
        }
      }
    }
  }

  // If no review found or mode is 'full', use base..head diff
  if (!baseSha) {
    const baseShaFromApi = await execPromise(
      `gh api repos/${owner}/${repo}/pulls/${prNumber} --jq '.base.sha'`
    );
    baseSha = baseShaFromApi;
    reviewInfo = null;
  }

  if (baseSha === headSha) {
    throw new Error('No new commits since last review');
  }

  // Get files changed by non-merge commits since the review
  let files = '';
  try {
    files = await execPromise(
      `git log pr-${prNumber} --no-merges --diff-filter=ACMRT --name-only --pretty=format:"" ${baseSha}..${headSha}`,
      { cwd: repoPath }
    );
  } catch {
    // Fallback: try without pr- branch name
    files = await execPromise(
      `git log --no-merges --diff-filter=ACMRT --name-only --pretty=format:"" ${baseSha}..${headSha}`,
      { cwd: repoPath }
    );
  }

  // Filter to code files only
  const codeFiles = files
    .split('\n')
    .map(f => f.trim())
    .filter(f => f && /\.(pm|cgi|js|tpl|css|less|json)$/.test(f))
    .filter((f, i, arr) => arr.indexOf(f) === i); // unique

  if (codeFiles.length === 0) {
    throw new Error('No code files changed since last review');
  }

  // Fetch origin/master for three-dot diff
  try {
    await execPromise('git fetch origin master', { cwd: repoPath });
  } catch {
    // Ignore fetch errors (might already be up to date)
  }

  // Use three-dot diff against master to exclude merge noise
  const contextLines = appConfig.contextLines || 5;
  const diffOut = await execPromise(
    `git diff origin/master...${headSha} --unified=${contextLines} -- ${codeFiles.map(f => `"${f}"`).join(' ')}`,
    { cwd: repoPath }
  );

  const tmpPath = path.join(getGeneratedDir(), `pr-${prNumber}-clean.diff`);
  fs.writeFileSync(tmpPath, diffOut);

  return { diffPath: tmpPath, baseSha, headSha, reviewInfo, filesChanged: codeFiles.length };
}

// Create application menu with "New Window" option
function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) focused.webContents.send('open-preferences');
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'Open Diff...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) focused.webContents.send('trigger-open-file');
          }
        },
        { type: 'separator' },
        {
          label: 'Export Review',
          submenu: [
            {
              label: 'As Markdown',
              accelerator: 'CmdOrCtrl+Shift+E',
              click: () => {
                const focused = BrowserWindow.getFocusedWindow();
                if (focused) focused.webContents.send('export-markdown');
              }
            },
            {
              label: 'As JSON',
              accelerator: 'CmdOrCtrl+Shift+J',
              click: () => {
                const focused = BrowserWindow.getFocusedWindow();
                if (focused) focused.webContents.send('export-json');
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Create a new window
function createWindow(options = {}) {
  const windowId = ++windowCounter;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'PR Reviewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  windows.set(windowId, win);

  // Set proper headers for GitHub image requests
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('github.com/user-attachments/') || details.url.includes('github.com/')) {
      details.requestHeaders['Referer'] = 'https://github.com/';
      details.requestHeaders['Accept'] = 'image/webp,image/apng,image/*,*/*;q=0.8';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  win.loadFile('index.html');

  win.webContents.on('did-finish-load', () => {
    // Load file from options or CLI args
    if (options.filePath && fs.existsSync(options.filePath)) {
      const diffContent = fs.readFileSync(options.filePath, 'utf8');
      const fileName = path.basename(options.filePath);
      win.webContents.send('load-diff', { content: diffContent, fileName, filePath: path.resolve(options.filePath) });
    } else if (options.diffContent) {
      win.webContents.send('load-diff', { content: options.diffContent, fileName: options.fileName || '', filePath: options.filePath || '' });
    }
  });

  win.on('closed', () => {
    windows.delete(windowId);
  });

  return win;
}

// App lifecycle
app.whenReady().then(() => {
  createMenu();

  // Run cleanup on startup if configured
  const cleanup = appConfig.cleanup || {};
  if (cleanup.runOnStartup !== false) {
    cleanupOldFiles();
  }

  // Create initial window with CLI args
  const firstWindowOptions = {};
  if (positionalArgs[0] && fs.existsSync(positionalArgs[0])) {
    firstWindowOptions.filePath = positionalArgs[0];
  }
  createWindow(firstWindowOptions);
});

// macOS: handle file open via double-click or drag onto app icon
let pendingOpenFile = null;

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (windows.size > 0) {
    const win = Array.from(windows.values())[0];
    const content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath);
    win.webContents.send('load-diff', { content, fileName, filePath: path.resolve(filePath) });
  } else {
    pendingOpenFile = filePath;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// IPC handlers

ipcMain.handle('open-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
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

ipcMain.handle('save-draft', async (event, { filePath, draft }) => saveDraft(filePath, draft));
ipcMain.handle('load-draft', async (event, filePath) => loadDraft(filePath));
ipcMain.handle('delete-draft', async (event, filePath) => { deleteDraft(filePath); return true; });

ipcMain.handle('save-image', async (event, { reviewDir, imageDataUrl, fileName }) => {
  try {
    const dir = reviewDir || getReviewDir();
    const imagesDir = path.join(dir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const filePath = path.join(imagesDir, fileName);
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.error('[image] local save failed:', err.message);
  }

  const upload = appConfig.imageUpload || {};
  if (upload.enabled && upload.s3Bucket) {
    try {
      const url = await uploadImageToS3(imageDataUrl, fileName);
      return { localPath: `images/${fileName}`, url };
    } catch (err) {
      console.error('[image] S3 upload failed:', err.message);
      return { localPath: `images/${fileName}`, url: null };
    }
  }

  return { localPath: `images/${fileName}`, url: null };
});

// Open PR in a new window
ipcMain.handle('open-pr-new-window', async (event, prNumber) => {
  try {
    const result = await generateDiff(prNumber);
    const content = fs.readFileSync(result.diffPath, 'utf8');
    const fileName = `pr-${prNumber}-clean.diff`;
    createWindow({ diffContent: content, fileName, filePath: result.diffPath, prNumber });
    return { success: true };
  } catch (err) {
    console.error('[pr-new-window] failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('load-pr', async (event, { prNumber, repo } = {}) => {
  try {
    const result = await generateDiff(prNumber, repo);
    const content = fs.readFileSync(result.diffPath, 'utf8');
    const fileName = `pr-${prNumber}-clean.diff`;

    // Fetch PR title, author, and assignees
    let owner, repoName;
    if (repo && repo.includes('/')) {
      [owner, repoName] = repo.split('/');
    } else {
      owner = appConfig.repoOwner || 'webtoolbox';
      repoName = appConfig.repoName || 'Website-Toolbox';
    }
    let prTitle = '', prAuthor = '', prAssignees = [], prBody = '';
    try {
      const prJson = await execPromise(
        `gh pr view ${prNumber} --repo ${owner}/${repoName} --json title,author,assignees,body`
      );
      const prData = JSON.parse(prJson);
      prTitle = prData.title || '';
      prAuthor = prData.author?.login || '';
      prAssignees = (prData.assignees || []).map(a => a.login).filter(a => a !== prAuthor);
      prBody = prData.body || '';
    } catch {}

    return {
      content,
      fileName,
      filePath: result.diffPath,
      prNumber,
      prTitle,
      prAuthor,
      prAssignees,
      prBody,
      reviewInfo: result.reviewInfo,
      filesChanged: result.filesChanged
    };
  } catch (err) {
    console.error('[pr] load failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('list-prs', async () => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) {
    return { prs: [], error: 'Set repoOwner and repoName in config' };
  }

  const filter = appConfig.prFilter || {};

  return new Promise((resolve) => {
    const fetchPage = (page) => {
      const args = `api 'repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}' --jq '[.[] | {number, title, author: .user.login, created: .created_at, reviewers: [.requested_reviewers[].login], draft}]'`;
      return execGh(args, { timeout: 30000 });
    };

    const fetchAll = async () => {
      let allPrs = [];
      let page = 1;
      while (true) {
        const stdout = await fetchPage(page);
        let batch = [];
        try { batch = JSON.parse(stdout); } catch { break; }
        allPrs = allPrs.concat(batch);
        if (batch.length < 100) break;
        page++;
      }
      return allPrs;
    };

    fetchAll()
      .then(prs => {
        if (filter.reviewRequested) {
          prs = prs.filter(pr => pr.reviewers && pr.reviewers.includes(owner));
        }
        if (filter.titleContains) {
          const needle = filter.titleContains.toLowerCase();
          prs = prs.filter(pr => pr.title.toLowerCase().includes(needle));
        }

        prs.sort((a, b) => new Date(b.created) - new Date(a.created));
        resolve({ prs });
      })
      .catch(err => {
        console.error('[list-prs] failed:', err.message);
        resolve({ prs: [], error: err.message });
      });
  });
});

// ===================== MULTI-REPO HANDLERS =====================

function loadReposConfig() {
  // Load checked state from private config
  const privateConfigPath = path.join(app.getPath('home'), '.config', 'pr-reviewer', 'config.json');
  let checkedState = {};
  try {
    const raw = fs.readFileSync(privateConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const r of (parsed.repos || [])) {
      checkedState[`${r.owner}/${r.name}`] = r.checked;
    }
  } catch {}

  // Load default owner from config
  const defaultOwner = appConfig.repoOwner || 'webtoolbox';

  // Fetch all repos from gh for the default owner
  let ghRepos = [];
  try {
    const stdout = require('child_process').execSync(
      `gh repo list ${defaultOwner} --limit 100 --json name,isPrivate --jq '[.[] | {owner: "${defaultOwner}", name: .name}]'`,
      { encoding: 'utf8', timeout: 15000 }
    );
    ghRepos = JSON.parse(stdout || '[]');
  } catch (err) {
    console.error('[repos] gh repo list failed:', err.message);
  }

  // Merge: apply checked state from config
  const repos = ghRepos.map(r => ({
    ...r,
    checked: checkedState[`${r.owner}/${r.name}`] === true
  }));

  // Sort: checked first, then alphabetical by owner/name
  repos.sort((a, b) => {
    if (a.checked && !b.checked) return -1;
    if (!a.checked && b.checked) return 1;
    return `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
  });

  return repos;
}

ipcMain.handle('list-repos', async () => {
  return { repos: loadReposConfig() };
});

ipcMain.handle('save-repos', async (event, repos) => {
  try {
    const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
    const privateConfigPath = path.join(privateDir, 'config.json');
    fs.mkdirSync(privateDir, { recursive: true });

    // Read existing private config
    let existing = {};
    try {
      const raw = fs.readFileSync(privateConfigPath, 'utf8');
      existing = JSON.parse(raw);
    } catch {}

    // Update repos
    existing.repos = repos;
    fs.writeFileSync(privateConfigPath, JSON.stringify(existing, null, 2));

    // Update in-memory appConfig too
    appConfig.repos = repos;

    return { success: true };
  } catch (err) {
    console.error('[save-repos] failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('list-all-prs', async (event, { repos, filter }) => {
  const filterConfig = filter || appConfig.prFilter || {};
  const errors = [];
  const allPrs = [];

  for (const repo of repos) {
    const { owner, name } = repo;
    if (!owner || !name) continue;

    try {
      let page = 1;
      let repoPrs = [];
      while (true) {
        const stdout = await execGh(
          `api 'repos/${owner}/${name}/pulls?state=open&per_page=100&page=${page}' --jq '[.[] | {number, title, author: .user.login, created: .created_at, reviewers: [.requested_reviewers[].login], assignees: [.assignees[].login], draft}]'`,
          { timeout: 30000 }
        );
        let batch = [];
        try { batch = JSON.parse(stdout); } catch { break; }
        repoPrs = repoPrs.concat(batch);
        if (batch.length < 100) break;
        page++;
      }

      // Apply filters
      if (filterConfig.reviewRequested) {
        // For multi-repo, filter by reviewer login from the repo owner
        repoPrs = repoPrs.filter(pr => pr.reviewers && pr.reviewers.includes(owner));
      }
      if (filterConfig.titleContains) {
        const needle = filterConfig.titleContains.toLowerCase();
        repoPrs = repoPrs.filter(pr => pr.title.toLowerCase().includes(needle));
      }

      // Add repo field to each PR
      for (const pr of repoPrs) {
        pr.repo = `${owner}/${name}`;
      }

      allPrs.push(...repoPrs);
    } catch (err) {
      console.error(`[list-all-prs] failed for ${owner}/${name}:`, err.message);
      errors.push({ repo: `${owner}/${name}`, error: err.message });
    }
  }

  // Sort all PRs by created date descending
  allPrs.sort((a, b) => new Date(b.created) - new Date(a.created));

  return { prs: allPrs, errors };
});

ipcMain.handle('save-review', async (event, review) => {
  const aiTag = (appConfig.aiTagPrefix || '@Hermes').toLowerCase();
  const askTag = '@ask';
  const aiComments = [];
  const askComments = [];
  const prComments = [];
  for (const c of review.comments || []) {
    const textLower = c.text.toLowerCase();
    if (textLower.startsWith(askTag)) {
      askComments.push(c);
    } else if (textLower.startsWith(aiTag)) {
      aiComments.push(c);
    } else {
      prComments.push(c);
    }
  }

  // Fire-and-forget to Hermes
  for (const c of aiComments) {
    const level = c.level || 'line';
    let msg = '';
    if (level === 'file') {
      msg = `[File comment: ${c.file}]\n${c.text.slice(aiTag.length).trim()}`;
    } else {
      const side = c.side || 'RIGHT';
      const codeContext = c.codeContext || '';
      msg = `[${c.file} line ${c.line} (${side})]${codeContext ? '\n```' + codeContext + '```' : ''}\n${c.text.slice(aiTag.length).trim()}`;
    }
    sendAiMessage(msg, review.prNumber || cliPrNumber);
  }

  // @ask: wait for response
  const askResponses = [];
  for (const c of askComments) {
    const level = c.level || 'line';
    let msg = '';
    if (level === 'file') {
      msg = `[File comment: ${c.file}]\n${c.text.slice(askTag.length).trim()}`;
    } else {
      const side = c.side || 'RIGHT';
      const codeContext = c.codeContext || '';
      msg = `[${c.file} line ${c.line} (${side})]${codeContext ? '\n```' + codeContext + '```' : ''}\n${c.text.slice(askTag.length).trim()}`;
    }
    const result = await askAiQuestion(msg, review.prNumber || cliPrNumber);
    askResponses.push({ file: c.file, line: c.line, question: c.text.slice(askTag.length).trim(), ...result });
  }

  const reviewToSave = { ...review, comments: prComments };
  const reviewDir = getReviewDir();
  fs.mkdirSync(reviewDir, { recursive: true });
  const filename = `review-${Date.now()}.json`;
  const outputPath = path.join(reviewDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(reviewToSave, null, 2));

  if (review.filePath) deleteDraft(review.filePath);

  const prNum = review.prNumber || cliPrNumber;
  const prCount = prComments.length;
  const aiCount = aiComments.length;
  const askCount = askComments.length;
  let summary = `Review submitted for PR #${prNum || '?'}: ${review.type}`;
  if (prCount > 0) summary += ` with ${prCount} line comment${prCount !== 1 ? 's' : ''}`;
  if (aiCount > 0) summary += ` (${aiCount} sent to AI)`;
  if (askCount > 0) summary += ` (${askCount} AI responses received)`;
  sendAiMessage(summary, prNum);

  return { outputPath, askResponses };
});

// Submit review directly to GitHub via gh CLI
ipcMain.handle('submit-github-review', async (event, { prNumber, body, eventType, comments }) => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) {
    return { error: 'repoOwner and repoName must be configured in config.json' };
  }
  if (!prNumber) {
    return { error: 'PR number is required' };
  }

  // Map event types to GitHub API values
  const eventMap = {
    'approve': 'APPROVE',
    'request_changes': 'REQUEST_CHANGES',
    'comment': 'COMMENT'
  };
  const ghEvent = eventMap[eventType] || 'COMMENT';

  // Build inline comments array (only those with valid diff positions)
  const ghComments = (comments || [])
    .filter(c => c.position && c.file && c.text)
    .map(c => ({
      path: c.file,
      position: c.position,
      body: c.text
    }));

  const payload = { body: body || '', event: ghEvent };
  if (ghComments.length > 0) {
    payload.comments = ghComments;
  }

  // Write payload to temp file for gh api --input
  const tmpPath = path.join(getGeneratedDir(), `review-payload-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));

  try {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/reviews" --method POST --input "${tmpPath}"`
    );
    const result = JSON.parse(stdout || '{}');
    console.log('[github-review] submitted successfully:', result.id);
    return { success: true, reviewId: result.id, htmlUrl: result.html_url };
  } catch (err) {
    console.error('[github-review] submission failed:', err.message);
    return { error: err.message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});

// Auto-fix with AI: send review comments to Hermes agent to create a fix PR
let currentUserLogin = null; // Cache for the session

ipcMain.handle('auto-fix-with-ai', async (event, { prNumber, comments, reviewBody }) => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) {
    return { error: 'repoOwner and repoName must be configured in config.json' };
  }
  if (!prNumber) {
    return { error: 'PR number is required' };
  }

  try {
    // Get PR details
    const prJson = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}"`
    );
    const pr = JSON.parse(prJson);
    const prAuthor = pr.user.login;
    const headBranch = pr.head.ref;
    const baseBranch = pr.base.ref;
    const assignees = (pr.assignees || []).map(a => a.login);
    const requestedReviewers = (pr.requested_reviewers || []).map(r => r.login);

    // Get current user (the reviewer) to exclude from notifications
    if (!currentUserLogin) {
      currentUserLogin = await execPromise('gh api user --jq .login');
    }

    // Collect all participants except the current user
    const allParticipants = new Set([prAuthor, ...assignees, ...requestedReviewers]);
    allParticipants.delete(currentUserLogin);
    const participants = [...allParticipants];

    // Build comment summary for the prompt
    const commentLines = (comments || [])
      .filter(c => c.text && c.file)
      .map((c, i) => `${i + 1}. **${c.file}${c.line ? ':' + c.line : ''}**: ${c.text}`);
    const commentSummary = commentLines.length > 0
      ? commentLines.join('\n')
      : '(No inline comments)';

    const bodySummary = reviewBody ? `\n\nReview body:\n${reviewBody}` : '';

    // Build the prompt for Hermes
    const prompt = `You are an AI code reviewer and fixer. A code review was submitted for PR #${prNumber} in ${owner}/${repo} requesting changes. Your job is to create a PR with fixes.

**Repository**: ${owner}/${repo}
**Original PR**: #${prNumber}
**PR Author**: ${prAuthor}
**Head Branch**: ${headBranch}
**Base Branch**: ${baseBranch}

**Review Comments**:
${commentSummary}${bodySummary}

**Instructions**:
1. Clone or pull the repository: \`gh repo clone ${owner}/${repo}\` or \`cd <repo-path> && git fetch\`
2. Create a new branch from the PR's head branch: \`git checkout -b auto-fix/pr-${prNumber} origin/${headBranch}\`
3. Read each file mentioned in the review comments and make the necessary code changes to address each comment
4. If an AGENTS.md file exists in the repo, follow its guidelines for code changes
5. Commit your changes with a clear message like "fix: address review comments for PR #${prNumber}"
6. Push the branch: \`git push origin auto-fix/pr-${prNumber}\`
7. Create a PR targeting the original branch: \`gh pr create --base ${headBranch} --title "Auto-fix: Review comments for PR #${prNumber}" --body "Addresses review comments from PR #${prNumber}.\\n\\nReview comments addressed:\\n${commentSummary.replace(/"/g, '\\"')}"\`
8. Add reviewers and assignees: \`gh pr edit --add-reviewer ${participants.join(',')} --add-assignee ${participants.join(',')}\`
9. After creating the PR, add a comment on the original PR #${prNumber} mentioning the fix PR: \`gh pr comment ${prNumber} --body "🤖 I've created an auto-fix PR addressing the review comments: <link to new PR>"\`

IMPORTANT: Return ONLY the new PR URL as the last line of your output, in the format: PR_URL: https://github.com/${owner}/${repo}/pull/<number>`;

    console.log('[auto-fix] Sending prompt to Hermes agent...');

    // Run hermes chat with the prompt
    const stdout = await execPromise(
      `hermes chat -p wt ${JSON.stringify(prompt)} --model anthropic/claude-sonnet-4`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 600000 }
    );

    console.log('[auto-fix] Hermes response:', stdout.substring(0, 200));

    // Extract PR URL from response
    const prUrlMatch = stdout.match(/PR_URL:\s*(https:\/\/[^\s]+)/i);
    const prUrl = prUrlMatch ? prUrlMatch[1] : null;

    // Try to extract PR number from URL
    const prNumMatch = prUrl ? prUrl.match(/\/pull\/(\d+)/) : null;
    const newPrNumber = prNumMatch ? prNumMatch[1] : null;

    if (prUrl) {
      return { success: true, prUrl, prNumber: newPrNumber };
    }

    // If no PR_URL found, try to find any GitHub PR URL in output
    const anyPrUrl = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (anyPrUrl) {
      const num = anyPrUrl[0].match(/\/pull\/(\d+)/);
      return { success: true, prUrl: anyPrUrl[0], prNumber: num ? num[1] : null };
    }

    return { success: false, error: 'Agent did not return a PR URL. Output: ' + stdout.substring(0, 500) };
  } catch (err) {
    console.error('[auto-fix] Failed:', err.message);
    return { error: err.message };
  }
});

// ===================== VOICE COMMAND HANDLER =====================

// Find Hermes venv Python
function findHermesPython() {
  const hermesHome = path.join(app.getPath('home'), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
  if (fs.existsSync(hermesHome)) return hermesHome;
  // Fallback: system python3
  return 'python3';
}

const sttScriptPath = path.join(__dirname, 'stt-transcribe.py');

ipcMain.handle('process-voice-command', async (event, { audioBase64, context }) => {
  const { prNumber, files, comments, reviewBody } = context || {};

  let audioPath = null;
  try {
    // Step 1: Save audio to temp file
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const ext = '.webm';
    audioPath = path.join(app.getPath('temp'), `voice-recording-${Date.now()}${ext}`);
    fs.writeFileSync(audioPath, audioBuffer);
    console.log('[voice] Audio saved:', audioPath, `(${audioBuffer.length} bytes)`);

    // Step 2: Transcribe using Hermes venv's faster-whisper
    const pythonBin = findHermesPython();
    console.log('[voice] Using Python:', pythonBin);

    const transcript = await execPromise(
      `${pythonBin} ${sttScriptPath} ${audioPath}`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );

    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript) {
      return { error: 'No speech detected in audio' };
    }
    console.log('[voice] Transcript:', trimmedTranscript);

    // Step 3: Send transcription to Hermes for interpretation
    const fileList = (files || []).map(f => `  - ${f.name} (${f.lines || '?'} lines)`).join('\n');
    const commentList = (comments || []).map((c, i) =>
      `  ${i + 1}. [${c.level || 'line'}] ${c.file}${c.line ? ':' + c.line : ''} — "${c.text}"`
    ).join('\n');

    const prompt = `You are a voice-controlled code review assistant. The user is reviewing a pull request and speaking commands naturally. Interpret their spoken instruction and return JSON actions.

**Current Context:**
- PR Number: ${prNumber || 'none loaded'}
- Files in diff:
${fileList || '  (no files loaded)'}
- Existing comments:
${commentList || '  (no comments yet)'}
- Review body so far: "${reviewBody || ''}"

**User said:** "${trimmedTranscript}"

**Available actions (return ONE or MORE as a JSON array):**

1. Add a line-level comment:
   {"action":"line_comment","file":"path/to/file","line":42,"side":"RIGHT","text":"comment text"}

2. Add a file-level comment:
   {"action":"file_comment","file":"path/to/file","text":"comment text"}

3. Add/update the PR-level review body:
   {"action":"review_body","text":"review summary text"}

4. Approve the PR:
   {"action":"approve"}

5. Request changes:
   {"action":"request_changes"}

6. Submit review as comment only:
   {"action":"submit_comment"}

7. Ask the developer a question (tagged @ask):
   {"action":"ask","file":"path/to/file","line":42,"text":"question about the code"}

8. Just a message to show the user (no UI action):
   {"action":"message","text":"your response message"}

**Rules:**
- The user may give MULTIPLE commands in one sentence. Return ALL actions as a JSON array.
- Example: "approve this PR and add a comment on line 10 of main.js saying looks good" should return TWO actions.
- If the user mentions a specific file, use the closest matching filename from the file list.
- If the user mentions a line number, use that exact line number.
- If the user says "approve" or "looks good", use {"action":"approve"}.
- If the user says "request changes" or "needs changes", use {"action":"request_changes"}.
- If the user asks "why" or "how" about code, use the "ask" action.
- If the user dictates a comment, use "line_comment" or "file_comment".
- If the user says "set review body to..." or "my review is...", use "review_body".
- If the user says "submit" or "submit as comment", use "submit_comment".
- For anything else, use "message" to respond.

Return a JSON array of actions. If only one action, still return it as an array: [{"action":"approve"}].
Do not wrap in markdown code fences. Return ONLY the JSON.`;

    console.log('[voice] Sending to Hermes for interpretation...');
    const stdout = await execPromise(
      `hermes chat -p wt ${JSON.stringify(prompt)} --model anthropic/claude-sonnet-4 -Q`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
    );

    const response = stdout.trim();
    console.log('[voice] Response:', response.substring(0, 300));

    // Step 4: Parse JSON response — expect array of actions
    try {
      const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      // Normalize: if single object, wrap in array
      const actions = Array.isArray(parsed) ? parsed : [parsed];
      return { success: true, actions };
    } catch (parseErr) {
      // Not JSON — treat as a message
      return { success: true, actions: [{ action: 'message', text: response }] };
    }
  } catch (err) {
    console.error('[voice] Failed:', err.message);
    return { error: err.message };
  } finally {
    // Always clean up temp audio file
    if (audioPath) {
      try { fs.unlinkSync(audioPath); } catch {}
    }
  }
});

ipcMain.handle('export-markdown', async (event, { markdown, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
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

ipcMain.handle('export-json', async (event, { json, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export Review as JSON',
    defaultPath: defaultName || 'review.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, json);
    return result.filePath;
  }
  return null;
});

// Download GitHub-attached images to local temp files (for authenticated access)
ipcMain.handle('download-github-images', async (event, { prBody }) => {
  if (!prBody) return { prBody: '' };
  
  // Find all github.com/user-attachments/assets URLs
  const urlRegex = /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/g;
  const urls = [...new Set(prBody.match(urlRegex) || [])];
  
  if (urls.length === 0) return { prBody };
  
  let modifiedBody = prBody;
  
  for (const url of urls) {
    try {
      const ext = '.png';
      const localPath = path.join(app.getPath('temp'), `pr-img-${Date.now()}${ext}`);
      
      // Download using gh api with authentication
      const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
      const response = await fetch(url, {
        headers: { 'Authorization': `token ${token}` }
      });
      
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);
        // Replace URL with local file path
        modifiedBody = modifiedBody.split(url).join(`file://${localPath}`);
      }
    } catch (err) {
      console.error('[image-download] Failed:', url, err.message);
    }
  }
  
  return { prBody: modifiedBody };
});

// Get commits for a PR
ipcMain.handle('get-pr-commits', async (event, prNumber) => {
  const owner = appConfig.repoOwner || 'webtoolbox';
  const repo = appConfig.repoName || 'Website-Toolbox';
  try {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100"`
    );
    const commits = JSON.parse(stdout || '[]');
    return {
      commits: commits.map(c => ({
        sha: c.sha.substring(0, 7),
        fullSha: c.sha,
        message: c.commit.message.split('\n')[0],
        fullMessage: c.commit.message,
        author: c.commit.author.name,
        date: c.commit.author.date,
        url: c.html_url
      })),
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`
    };
  } catch (err) {
    console.error('[commits] failed:', err.message);
    return { commits: [], error: err.message };
  }
});

// Get blame/annotation for a file to map lines to commits
ipcMain.handle('get-file-blame', async (event, { prNumber, filePath }) => {
  const repoPath = path.join(app.getPath('home'), 'Website-Toolbox');
  try {
    const headSha = await execPromise(
      `gh pr view ${prNumber} --repo ${appConfig.repoOwner || 'webtoolbox'}/${appConfig.repoName || 'Website-Toolbox'} --json headRefOid --jq '.headRefOid'`
    );
    const stdout = await execPromise(
      `git blame --porcelain ${headSha} -- "${filePath}"`,
      { cwd: repoPath }
    );
    // Parse porcelain blame output
    const blameMap = {};
    const lines = stdout.split('\n');
    let currentSha = null;
    let lineNum = 0;
    for (const line of lines) {
      if (/^[0-9a-f]{40}/.test(line)) {
        currentSha = line.substring(0, 7);
      }
      if (line.startsWith('\t')) {
        lineNum++;
        blameMap[lineNum] = currentSha;
      }
    }
    return blameMap;
  } catch (err) {
    console.error('[blame] failed:', err.message);
    return {};
  }
});

// Collaborators cache (session-level, per-repo)
let collaboratorsCache = {};

ipcMain.handle('get-collaborators', async (event, repoKey) => {
  const cacheKey = repoKey || 'default';
  if (collaboratorsCache[cacheKey]) return collaboratorsCache[cacheKey];

  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner;
    repo = appConfig.repoName;
  }
  if (!owner || !repo) return [];

  try {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/collaborators?per_page=100"`
    );
    const collabs = JSON.parse(stdout || '[]');
    collaboratorsCache[cacheKey] = collabs.map(c => ({
      login: c.login,
      avatar_url: c.avatar_url
    }));
    return collaboratorsCache[cacheKey];
  } catch (err) {
    console.error('[collaborators] fetch failed:', err.message);
    return [];
  }
});

ipcMain.handle('get-config', async () => ({
  chatId: aiChatId,
  prNumber: cliPrNumber,
  aiTagPrefix: appConfig.aiTagPrefix || '@Hermes',
  aiCommand: appConfig.aiCommand,
  prFilter: appConfig.prFilter || {},
  repos: loadReposConfig(),
  repoOwner: appConfig.repoOwner || '',
  repoName: appConfig.repoName || '',
  repoPath: appConfig.repoPath || '',
  editorCommand: appConfig.editorCommand || 'code',
  contextLines: appConfig.contextLines || 5,
  imageUploadEnabled: (appConfig.imageUpload || {}).enabled || false,
  imageUpload: appConfig.imageUpload || {},
  diff: appConfig.diff || {},
  cleanup: appConfig.cleanup || {},
  rules: appConfig.rules || { enabled: false },
  autoFix: appConfig.autoFix || { enabled: true }
}));

ipcMain.handle('save-preferences', async (event, prefs) => {
  try {
    // Deep merge into appConfig
    if (prefs.repoOwner !== undefined) appConfig.repoOwner = prefs.repoOwner;
    if (prefs.repoName !== undefined) appConfig.repoName = prefs.repoName;
    if (prefs.repoPath !== undefined) appConfig.repoPath = prefs.repoPath;
    if (prefs.aiCommand !== undefined) appConfig.aiCommand = prefs.aiCommand;
    if (prefs.aiTagPrefix !== undefined) appConfig.aiTagPrefix = prefs.aiTagPrefix;
    if (prefs.editorCommand !== undefined) appConfig.editorCommand = prefs.editorCommand;
    if (prefs.contextLines !== undefined) appConfig.contextLines = prefs.contextLines;
    if (prefs.diff !== undefined) appConfig.diff = { ...(appConfig.diff || {}), ...prefs.diff };
    if (prefs.imageUpload !== undefined) appConfig.imageUpload = { ...(appConfig.imageUpload || {}), ...prefs.imageUpload };
    if (prefs.cleanup !== undefined) appConfig.cleanup = { ...(appConfig.cleanup || {}), ...prefs.cleanup };
    if (prefs.rules !== undefined) appConfig.rules = { ...(appConfig.rules || {}), ...prefs.rules };

    // Save to private config file
    const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
    const privateConfigPath = path.join(privateDir, 'config.json');
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(privateConfigPath, JSON.stringify(appConfig, null, 2));
    return { success: true };
  } catch (err) {
    console.error('[preferences] save failed:', err.message);
    return { error: err.message };
  }
});

// ===================== BINARY CHECKS =====================

// Check if a command is available on PATH
function checkCommand(cmd) {
  return new Promise((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    exec(`${which} ${cmd}`, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

// Check gh and AI agent availability
ipcMain.handle('check-binaries', async () => {
  const ghAvailable = await checkCommand('gh');

  // Popular AI agents to check
  const aiAgents = [
    { id: 'hermes', name: 'Hermes', command: 'hermes', tagPrefix: '@Hermes' },
    { id: 'claude', name: 'Claude Code', command: 'claude', tagPrefix: '@Claude' },
    { id: 'cursor', name: 'Cursor', command: 'cursor', tagPrefix: '@Cursor' },
    { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', tagPrefix: '@Copilot' },
    { id: 'aider', name: 'Aider', command: 'aider', tagPrefix: '@Aider' },
    { id: 'codex', name: 'Codex CLI', command: 'codex', tagPrefix: '@Codex' },
  ];

  const availableAgents = [];
  for (const agent of aiAgents) {
    const available = await checkCommand(agent.command);
    if (available) {
      availableAgents.push({ ...agent, available: true });
    }
  }

  return { ghAvailable, availableAgents };
});

// Auto-detect and set AI agent if not configured yet
ipcMain.handle('auto-detect-agent', async () => {
  // If agent is already configured, skip
  if (appConfig.aiCommand && appConfig.aiCommand.trim()) {
    return { detected: false, agent: appConfig.aiCommand };
  }

  const aiAgents = [
    { command: 'hermes', tagPrefix: '@Hermes' },
    { command: 'claude', tagPrefix: '@Claude' },
    { command: 'cursor', tagPrefix: '@Cursor' },
    { command: 'copilot', tagPrefix: '@Copilot' },
    { command: 'aider', tagPrefix: '@Aider' },
    { command: 'codex', tagPrefix: '@Codex' },
  ];

  for (const agent of aiAgents) {
    const available = await checkCommand(agent.command);
    if (available) {
      appConfig.aiCommand = agent.command;
      if (!appConfig.aiTagPrefix || appConfig.aiTagPrefix === '@Hermes') {
        appConfig.aiTagPrefix = agent.tagPrefix;
      }
      // Save config
      try {
        const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
        const privateConfigPath = path.join(privateDir, 'config.json');
        fs.mkdirSync(privateDir, { recursive: true });
        fs.writeFileSync(privateConfigPath, JSON.stringify(appConfig, null, 2));
      } catch {}
      return { detected: true, agent: agent.command };
    }
  }

  return { detected: false, agent: null };
});

// Open file in editor at specific line
ipcMain.handle('open-file-in-editor', async (event, { filePath, line }) => {
  const editor = appConfig.editorCommand || 'code';
  const repoPath = appConfig.repoPath || '';
  const fullPath = repoPath ? path.join(repoPath, filePath) : filePath;
  
  try {
    // VS Code: code -g file:line
    // Sublime: subl file:line
    // Most editors support file:line format
    const args = line ? ['-g', `${fullPath}:${line}`] : [fullPath];
    require('child_process').execFile(editor, args, (err) => {
      if (err) console.error('Failed to open editor:', err.message);
    });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ===================== AGENT RULES PROPOSAL =====================

// Get AGENTS.md from the repo
ipcMain.handle('get-agent-rules', async () => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) return { error: 'No repo configured' };
  
  try {
    let agentsMd = '';
    try {
      agentsMd = await execPromise(
        `gh api repos/${owner}/${repo}/contents/AGENTS.md --jq .content | base64 -d`
      );
    } catch {}
    return { agentsMd };
  } catch (err) {
    return { error: err.message };
  }
});

// Analyze review feedback against existing rules and propose new ones
ipcMain.handle('propose-rules', async (event, { feedback, agentsMd }) => {
  const rulesConfig = appConfig.rules || {};
  if (!rulesConfig.enabled) return { proposals: [], disabled: true };
  
  const aiCmd = rulesConfig.aiCommand || appConfig.aiCommand || 'hermes';
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  
  const feedbackText = feedback.map(f => `- [${f.file}${f.line ? ` line ${f.line}` : ''}] ${f.text}`).join('\n');
  
  const prompt = `You are analyzing code review feedback to propose new agent rules for the ${owner}/${repo} repository.

AGENTS.md content:
${agentsMd}

AGENTS.md references other rules files (e.g. .github/instructions/*.md). Read those files as needed to understand the full set of existing rules.

REVIEW FEEDBACK:
${feedbackText}

Analyze the feedback. For each piece of feedback that is NOT already covered by an existing rule:
1. Propose a brief, generalized rule that would prevent similar issues
2. Recommend which file it belongs in (AGENTS.md for general rules, or the appropriate referenced file for language-specific rules)

Reply with ONLY a JSON object:
{
  "proposedRules": [
    {"rule": "...", "file": "path/to/file.md", "reason": "brief reason"}
  ],
  "availableFiles": ["AGENTS.md", ".github/instructions/perl.instructions.md", ...]
}

If all feedback is already covered, return: {"proposedRules": [], "availableFiles": [...]}
Rules should be generalized, not specific to this one PR.
Keep rules concise — one sentence each when possible.`;

  return new Promise((resolve) => {
    const args = ['send', prompt];
    const proc = require('child_process').execFile(aiCmd, args, { timeout: 120000 }, (err, stdout) => {
      if (err) { resolve({ proposals: [], availableFiles: ['AGENTS.md'], error: err.message }); return; }
      try {
        const match = stdout.match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : {};
        resolve({ proposals: parsed.proposedRules || [], availableFiles: parsed.availableFiles || ['AGENTS.md'] });
      } catch (e) {
        resolve({ proposals: [], availableFiles: ['AGENTS.md'], error: 'Failed to parse AI response', raw: stdout });
      }
    });
  });
});

// Save proposed rules to files
ipcMain.handle('save-agent-rules', async (event, { rules }) => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) return { error: 'No repo configured' };
  
  const results = [];
  // Group rules by file
  const byFile = {};
  for (const r of rules) {
    if (!byFile[r.file]) byFile[r.file] = [];
    byFile[r.file].push(r.rule);
  }
  
  for (const [file, newRules] of Object.entries(byFile)) {
    try {
      // Fetch current content
      let current = '';
      try {
        current = await execPromise(
          `gh api repos/${owner}/${repo}/contents/${file} --jq .content | base64 -d`
        );
      } catch {}
      
      // Append new rules
      const additions = newRules.map(r => `- ${r}`).join('\n');
      const updated = current.trim() + '\n\n## Added by Code Review\n' + additions + '\n';
      
      // Get SHA for update
      let sha = '';
      try {
        sha = await execPromise(
          `gh api repos/${owner}/${repo}/contents/${file} --jq .sha`
        );
      } catch {}
      
      const payload = JSON.stringify({
        message: `Add review-derived rules to ${file}`,
        content: Buffer.from(updated).toString('base64'),
        ...(sha ? { sha } : {})
      });
      
      await execPromise(
        `echo '${payload.replace(/'/g, "'\\''")}' | gh api repos/${owner}/${repo}/contents/${file} --method PUT --input -`
      );
      
      results.push({ file, success: true, count: newRules.length });
    } catch (err) {
      results.push({ file, success: false, error: err.message });
    }
  }
  
  return { results };
});

// Delete PR temp files
ipcMain.handle('delete-pr-files', async (event, prNumber) => {
  const generatedDir = getGeneratedDir();
  let deleted = 0;
  try {
    const files = fs.readdirSync(generatedDir);
    for (const f of files) {
      if (f.includes(`-${prNumber}-`) || f.includes(`pr-${prNumber}`)) {
        fs.unlinkSync(path.join(generatedDir, f));
        deleted++;
      }
    }
  } catch {}
  
  // Also delete drafts for this PR
  const draftsDir = getDraftsDir();
  try {
    const files = fs.readdirSync(draftsDir);
    for (const f of files) {
      try {
        const draft = JSON.parse(fs.readFileSync(path.join(draftsDir, f), 'utf8'));
        if (draft.prNumber == prNumber) {
          fs.unlinkSync(path.join(draftsDir, f));
          deleted++;
        }
      } catch {}
    }
  } catch {}
  
  return { deleted };
});

// Get next PR to review from the list
ipcMain.handle('get-next-pr', async (event, currentPrNumber) => {
  try {
    const owner = appConfig.repoOwner;
    const repo = appConfig.repoName;
    const filter = appConfig.prFilter || {};
    
    let cmd = `gh pr list --repo ${owner}/${repo} --state open --json number,title,author,createdAt,headRefName,isDraft`;
    
    const output = await execPromise(cmd);
    let prs = JSON.parse(output);
    
    if (filter.reviewRequested) {
      const viewer = await execPromise('gh api user --jq .login');
      prs = prs.filter(pr => {
        // PRs where the viewer is requested as reviewer
        return true; // gh pr list with --json doesn't include review requests, filter client-side
      });
    }
    
    if (filter.titleContains) {
      const needle = filter.titleContains.toLowerCase();
      prs = prs.filter(pr => (pr.title || '').toLowerCase().includes(needle));
    }
    
    // Find next PR after current
    const currentIdx = prs.findIndex(pr => pr.number === currentPrNumber);
    if (currentIdx >= 0 && currentIdx < prs.length - 1) {
      return { pr: prs[currentIdx + 1] };
    } else if (prs.length > 0 && prs[0].number !== currentPrNumber) {
      return { pr: prs[0] };
    }
    
    return { pr: null };
  } catch (err) {
    return { error: err.message };
  }
});
