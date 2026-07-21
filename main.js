const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');

// Track all open windows
const windows = new Map();
let windowCounter = 0;

// Load config: private (~/.config/diff-reviewer/config.json) overrides public (./config.json)
function loadConfig() {
  const publicConfigPath = path.join(__dirname, 'config.json');
  const privateConfigPath = path.join(app.getPath('home'), '.config', 'diff-reviewer', 'config.json');

  const defaults = {
    aiCommand: 'hermes',
    aiSendArgs: ['send', '--to'],
    aiChatId: null,
    aiTagPrefix: '@Hermes',
    reviewSaveDir: '',  // Will default to app userData/reviews
    prFilter: { reviewRequested: true, titleContains: '' },
    repoOwner: '',
    repoName: '',
    imageUpload: {
      enabled: false,
      provider: 's3',
      s3Bucket: '',
      s3Prefix: '',
      s3Acl: 'public-read',
      awsProfile: 'default',
      awsRegion: 'us-east-1'
    }
  };

  let config = { ...defaults };

  try {
    const raw = fs.readFileSync(publicConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...config, ...parsed };
    if (parsed.imageUpload) config.imageUpload = { ...config.imageUpload, ...parsed.imageUpload };
    if (parsed.prFilter) config.prFilter = { ...config.prFilter, ...parsed.prFilter };
  } catch {}

  try {
    const raw = fs.readFileSync(privateConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...config, ...parsed };
    if (parsed.imageUpload) config.imageUpload = { ...config.imageUpload, ...parsed.imageUpload };
    if (parsed.prFilter) config.prFilter = { ...config.prFilter, ...parsed.prFilter };
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
    // No chat-id specified — prepend PR context so agent understands the message
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
async function generateDiff(prNumber) {
  const repoPath = path.join(app.getPath('home'), 'Website-Toolbox');
  const owner = appConfig.repoOwner || 'webtoolbox';
  const repo = appConfig.repoName || 'Website-Toolbox';
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
  const diffOut = await execPromise(
    `git diff origin/master...${headSha} -- ${codeFiles.map(f => `"${f}"`).join(' ')}`,
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
    title: 'Diff Reviewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  windows.set(windowId, win);

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

ipcMain.handle('load-pr', async (event, prNumber) => {
  try {
    const result = await generateDiff(prNumber);
    const content = fs.readFileSync(result.diffPath, 'utf8');
    const fileName = `pr-${prNumber}-clean.diff`;

    // Fetch PR title, author, and assignees
    const owner = appConfig.repoOwner || 'webtoolbox';
    const repo = appConfig.repoName || 'Website-Toolbox';
    let prTitle = '', prAuthor = '', prAssignees = [], prBody = '';
    try {
      const prJson = await execPromise(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json title,author,assignees,body`
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

      if (filter.reviewRequested) {
        prs = prs.filter(pr => pr.reviewers && pr.reviewers.includes(owner));
      }

      if (filter.titleContains) {
        const needle = filter.titleContains.toLowerCase();
        prs = prs.filter(pr => pr.title.toLowerCase().includes(needle));
      }

      prs.sort((a, b) => new Date(b.created) - new Date(a.created));
      resolve({ prs });
    });
  });
});

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
    sendAiMessage(msg, review.prNumber || cliPrNumber);
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
  let summary = `Review submitted for PR #${prNum || '?'}: ${review.type}`;
  if (prCount > 0) summary += ` with ${prCount} line comment${prCount !== 1 ? 's' : ''}`;
  if (aiCount > 0) summary += ` (${aiCount} sent to AI)`;
  sendAiMessage(summary, prNum);

  return outputPath;
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

ipcMain.handle('get-config', async () => ({
  chatId: aiChatId,
  prNumber: cliPrNumber,
  aiTagPrefix: appConfig.aiTagPrefix || '@Hermes',
  aiCommand: appConfig.aiCommand,
  prFilter: appConfig.prFilter || {},
  repoOwner: appConfig.repoOwner || '',
  repoName: appConfig.repoName || '',
  imageUploadEnabled: (appConfig.imageUpload || {}).enabled || false,
  rules: appConfig.rules || { enabled: false }
}));

// ===================== AGENT RULES PROPOSAL =====================

// Get agent rules files from the repo
ipcMain.handle('get-agent-rules', async () => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) return { error: 'No repo configured' };
  
  try {
    // Fetch AGENTS.md
    let agentsMd = '';
    try {
      agentsMd = await execPromise(
        `gh api repos/${owner}/${repo}/contents/AGENTS.md --jq .content | base64 -d`
      );
    } catch {}
    
    // Fetch referenced instruction files
    const instructionFiles = {};
    const instrDir = '.github/instructions';
    try {
      const files = await execPromise(
        `gh api repos/${owner}/${repo}/contents/${instrDir} --jq '.[].name'`
      );
      for (const file of files.split('\n').filter(f => f.endsWith('.md'))) {
        try {
          const content = await execPromise(
            `gh api repos/${owner}/${repo}/contents/${instrDir}/${file} --jq .content | base64 -d`
          );
          instructionFiles[`${instrDir}/${file}`] = content;
        } catch {}
      }
    } catch {}
    
    return { agentsMd, instructionFiles };
  } catch (err) {
    return { error: err.message };
  }
});

// Analyze review feedback against existing rules and propose new ones
ipcMain.handle('propose-rules', async (event, { feedback, agentsMd, instructionFiles }) => {
  const rulesConfig = appConfig.rules || {};
  if (!rulesConfig.enabled) return { proposals: [], disabled: true };
  
  const aiCmd = rulesConfig.aiCommand || appConfig.aiCommand || 'hermes';
  
  // Build context of all existing rules
  let existingRules = `# AGENTS.md\n${agentsMd}\n\n`;
  for (const [file, content] of Object.entries(instructionFiles || {})) {
    existingRules += `# ${file}\n${content}\n\n`;
  }
  
  // Build feedback summary
  const feedbackText = feedback.map(f => `- [${f.file}${f.line ? ` line ${f.line}` : ''}] ${f.text}`).join('\n');
  
  const prompt = `You are analyzing code review feedback to propose new agent rules.

EXISTING RULES:
${existingRules}

REVIEW FEEDBACK:
${feedbackText}

Analyze the feedback. For each piece of feedback that is NOT already covered by an existing rule:
1. Propose a brief, generalized rule that would prevent similar issues
2. Indicate which file it should go in (AGENTS.md for general rules, or the appropriate instruction file for language-specific rules)

Reply with ONLY a JSON array. Each item: {"rule": "...", "file": "path/to/file.md", "reason": "brief reason"}
If all feedback is already covered, return an empty array: []
Do not include rules that are already covered by existing rules.
Rules should be generalized, not specific to this one PR.
Keep rules concise — one sentence each when possible.`;

  return new Promise((resolve) => {
    const args = ['send', prompt];
    let output = '';
    const proc = require('child_process').execFile(aiCmd, args, { timeout: 120000 }, (err, stdout) => {
      if (err) { resolve({ proposals: [], error: err.message }); return; }
      try {
        // Extract JSON from response
        const match = stdout.match(/\[[\s\S]*\]/);
        const proposals = match ? JSON.parse(match[0]) : [];
        resolve({ proposals });
      } catch (e) {
        resolve({ proposals: [], error: 'Failed to parse AI response', raw: stdout });
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
