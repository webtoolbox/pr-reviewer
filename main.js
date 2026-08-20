const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile, exec, execSync } = require('child_process');

// ── File-based logger ──────────────────────────────────────────────────────────
const LOG_DIR = app.getPath('userData');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function log(level, ...args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `[${ts}] [${level}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) { console.warn('[log] Failed to write to log file:', err.message); }
  // Also echo to terminal
  if (level === 'ERROR') {
    console.error(...args);
  } else {
    console.log(...args);
  }
}

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

// Validate and coerce a PR number to a safe integer string (prevents shell injection)
function safePrNumber(prNumber) {
  if (prNumber === null || prNumber === undefined) return null;
  const str = String(prNumber).trim();
  if (!/^\d+$/.test(str)) return null;
  const num = parseInt(str, 10);
  if (isNaN(num) || num <= 0) return null;
  return String(num);
}

// Atomic file write: write to tmp file then rename (prevents corruption on concurrent writes)
function atomicWriteFileSync(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
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
    hermesProfile: 'wt',
    reviewSaveDir: '',  // Will default to app userData/reviews
    prFilter: { reviewRequested: true, titleContains: '', excludeTitleStartsWith: [] },
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
      enabled: false
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
  } catch (err) {
    console.error('[loadConfig] Public config not loaded:', err.message);
  }

  try {
    const raw = fs.readFileSync(privateConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...config, ...parsed };
    if (parsed.imageUpload) config.imageUpload = { ...config.imageUpload, ...parsed.imageUpload };
    if (parsed.prFilter) config.prFilter = { ...config.prFilter, ...parsed.prFilter };
    if (parsed.autoFix) config.autoFix = { ...config.autoFix, ...parsed.autoFix };
  } catch (err) {
    console.error('[loadConfig] Private config not loaded:', err.message);
  }

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
    log('INFO', '[ai] No chat-id configured, sending via chat -q');
    // Use hermes chat -q for non-interactive single query (hermes send requires --to)
    const args = ['chat', '-p', appConfig.hermesProfile || 'wt', '-q', prefix + message];
    execFile(appConfig.aiCommand, args, (err, stdout, stderr) => {
      if (err) log('ERROR', `[${appConfig.aiCommand}] send failed:`, err.message, stderr);
      else log('INFO', `[${appConfig.aiCommand}] message sent via chat`);
    });
    return;
  }
  const args = [...appConfig.aiSendArgs, aiChatId, message];
  log('INFO', '[ai] Sending to chat-id:', aiChatId, 'message:', message.substring(0, 100));
  execFile(appConfig.aiCommand, args, (err, stdout, stderr) => {
    if (err) log('ERROR', `[${appConfig.aiCommand}] send failed:`, err.message, stderr);
    else log('INFO', `[${appConfig.aiCommand}] message sent`);
  });
}

// Ask AI and wait for response
function askAiQuestion(question, prNumber) {
  return new Promise((resolve) => {
    const prefix = prNumber ? `[PR #${prNumber}] ` : '';
    const args = ['chat', '-p', appConfig.hermesProfile || 'wt', '-q', prefix + question];
    log('INFO', `[ask] Sending question (first 100): ${(prefix + question).substring(0, 100)}`);
    execFile(appConfig.aiCommand, args, { timeout: 120000 }, (err, stdout) => {
      if (err) {
        log('ERROR', `[${appConfig.aiCommand}] ask failed:`, err.message);
        resolve({ error: err.message });
      } else {
        log('INFO', `[ask] Response received: ${stdout.length} chars`);
        resolve({ response: cleanHermesResponse(stdout) });
      }
    });
  });
}

// Fetch lightweight PR context (title + branches) for the AI chat dropdown
async function getPrChatContext(prNumber, repoKey) {
  if (!prNumber) return '';
  let owner = appConfig.repoOwner || '';
  let repo = appConfig.repoName || '';
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  }
  if (!owner || !repo) return `PR #${prNumber}`;
  try {
    const out = await execPromise(
      `gh pr view ${prNumber} --repo ${owner}/${repo} --json title,headRefName,baseRefName --jq '{title,headRefName,baseRefName}'`,
      { timeout: 15000 }
    );
    const info = JSON.parse(out.trim());
    return `PR #${prNumber} in ${owner}/${repo}${info.title ? ': ' + info.title : ''} (${info.baseRefName || '?'} <- ${info.headRefName || '?'})`;
  } catch (err) {
    log('WARN', '[ai-chat] Failed to fetch PR context:', err.message);
    return `PR #${prNumber} in ${owner}/${repo}`;
  }
}

// Build a conversational prompt embedding prior messages for back-and-forth chat
function buildChatPrompt(context, history, message) {
  const lines = [
    'You are an AI coding assistant helping review a pull request in the PR Reviewer desktop app.',
    "Answer the user's questions about the code, the branch, or the pull request concisely and helpfully."
  ];
  if (context) lines.push('Current pull request context: ' + context);
  lines.push('');
  lines.push('Conversation so far:');
  const hist = Array.isArray(history) ? history : [];
  if (hist.length === 0) lines.push('(none)');
  for (const h of hist) {
    if (h && typeof h.content === 'string') {
      lines.push((h.role === 'user' ? 'User' : 'Assistant') + ': ' + h.content);
    }
  }
  lines.push('');
  lines.push('User: ' + message);
  lines.push('Assistant:');
  return lines.join('\n');
}

// Strip hermes CLI UI chrome from `chat -q` output so the user sees only the
// answer: leading "Warning:" banners, the echoed prompt block, box-drawing UI
// (╭─ Hermes ─╮ ... ╰──╯), and the session footer ("Resume session...", etc.).
function cleanHermesResponse(stdout) {
  if (!stdout) return '';
  let text = stdout;

  // Strip leading warning/banner lines (e.g. "Warning: Unknown toolsets: ...")
  text = text.replace(/^(?:Warning:[^\n]*\n*)+/g, '');

  // If hermes drew a box (the final answer is in the last ╭─...╮ block), extract it.
  const lastBoxStart = text.lastIndexOf('╭');
  if (lastBoxStart !== -1) {
    const boxEnd = text.indexOf('╰', lastBoxStart);
    const nl = text.indexOf('\n', lastBoxStart);
    if (boxEnd !== -1 && nl !== -1 && nl < boxEnd) {
      text = text.substring(nl + 1, boxEnd);
      // Strip the "│ " border pipes hermes puts on each box content line.
      text = text.replace(/^│\s*/gm, '').replace(/\s*│$/gm, '');
    }
  } else {
    // No box UI — drop the echoed prompt block and keep whatever follows it.
    const asstIdx = text.lastIndexOf('Assistant:');
    if (asstIdx !== -1) {
      text = text.substring(asstIdx + 'Assistant:'.length);
    }
  }

  // Strip the session footer
  text = text.replace(/\n\s*Resume (?:this session|session) with:[\s\S]*$/i, '');
  text = text.replace(/\n\s*Session:\s*[\w\d_-]+[\s\S]*$/i, '');
  text = text.replace(/\n\s*(Duration|Messages):\s*[\s\S]*$/i, '');

  return text.trim();
}

// AI chat IPC: send a message with conversation history, stream the reply back
// incrementally so the user sees the agent "thinking" live instead of a static
// "Thinking..." bubble. Uses spawn() (not execFile) so stdout chunks arrive as
// they're produced; each chunk is throttled and pushed to the renderer over the
// 'ai-chat-stream' channel, and a final 'done' event carries the cleaned reply.
ipcMain.handle('ai-chat', async (event, { message, prNumber, repoKey, history }) => {
  const prompt = buildChatPrompt(await getPrChatContext(prNumber, repoKey), history, message || '');
  const args = ['chat', '-p', appConfig.hermesProfile || 'wt', '-q', prompt];
  log('INFO', `[ai-chat] Sending (first 100): ${prompt.substring(0, 100)}`);
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(appConfig.aiCommand, args, { timeout: 120000 });
    const sender = event.sender;
    let stdout = '';
    let lastEmit = 0;

    const emitStream = (force) => {
      // Throttle emits to ~80ms so we don't spam IPC on fast token streams.
      const now = Date.now();
      if (!force && now - lastEmit < 80) return;
      lastEmit = now;
      const partial = cleanHermesStreaming(stdout);
      if (partial) {
        try { sender.send('ai-chat-stream', { text: partial, done: false }); } catch {}
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      emitStream(false);
    });

    child.on('error', (err) => {
      log('ERROR', '[ai-chat] spawn error:', err.message);
      try { sender.send('ai-chat-stream', { text: '', error: err.message, done: true }); } catch {}
      resolve({ error: err.message });
    });

    child.on('close', () => {
      const clean = cleanHermesResponse(stdout);
      log('INFO', `[ai-chat] Response received: ${clean.length} chars`);
      try { sender.send('ai-chat-stream', { text: clean, done: true }); } catch {}
      resolve({ response: clean });
    });
  });
});

// Lightweight chrome-stripper for PARTIAL (in-flight) hermes output. It only
// returns lines INSIDE the final answer box (between the ╭…╮ top border and the
// ╰…╯ bottom border), stripping the │ border pipes. Thinking text, tool-call
// progress, warnings, and the session footer are all outside the box, so they
// never reach the reply bubble. Before the box opens (or after it closes) it
// returns empty — the renderer keeps showing the loading indicator until the
// real answer begins streaming.
function cleanHermesStreaming(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let inBox = false;
  for (const raw of lines) {
    const t = raw;
    if (/^╭/.test(t)) { inBox = true; continue; }
    if (/^╰/.test(t)) { inBox = false; continue; }
    if (inBox) {
      // Strip the left border pipe and trailing whitespace from box content lines.
      const content = t.replace(/^│\s*/, '').replace(/\s*│$/, '').trim();
      if (content) out.push(content);
    }
  }
  return out.join('\n').trim();
}

function expandPath(p) {
  if (p && p.startsWith('~')) {
    return path.join(app.getPath('home'), p.slice(1));
  }
  return p;
}

// Derive local repo path from repoKey (owner/repo) or appConfig
function getLocalRepoPath(repoKey) {
  if (repoKey && repoKey.includes('/')) {
    const repoName = repoKey.split('/')[1];
    // Prefer shallow clone in app data directory (always on master, independent of main repo)
    const dataReposPath = path.join(app.getPath('userData'), 'repos', repoName);
    if (fs.existsSync(dataReposPath)) return dataReposPath;
    // Check ~/Repos/ first (conventional location), then ~/
    const reposPath = path.join(app.getPath('home'), 'Repos', repoName);
    if (fs.existsSync(reposPath)) return reposPath;
    // If this is the default repo and repoPath is configured, use it
    const defaultRepoKey = `${appConfig.repoOwner}/${appConfig.repoName}`;
    if (repoKey === defaultRepoKey && appConfig.repoPath) {
      return expandPath(appConfig.repoPath);
    }
    return path.join(app.getPath('home'), repoName);
  }
  return appConfig.repoPath ? expandPath(appConfig.repoPath) : path.join(app.getPath('home'), appConfig.repoName || 'Website-Toolbox');
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

// PR-specific draft management (persists across app restarts)
function getPrDraftDir() {
  const dir = path.join(app.getPath('home'), '.config', 'pr-reviewer', 'drafts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPrDraftPath(prNumber) {
  const safePr = safePrNumber(prNumber);
  if (!safePr) return null;
  return path.join(getPrDraftDir(), `pr-${safePr}.json`);
}

function savePrDraft(prNumber, data) {
  try {
    const draftPath = getPrDraftPath(prNumber);
    if (!draftPath) return null;
    const payload = {
      comments: data.comments || [],
      prNumber: safePrNumber(prNumber),
      repoKey: data.repoKey || null,
      reviewBody: data.reviewBody || '',
      timestamp: new Date().toISOString()
    };
    atomicWriteFileSync(draftPath, JSON.stringify(payload, null, 2));
    return draftPath;
  } catch (err) {
    log('ERROR', '[pr-draft] save failed:', err.message);
    return null;
  }
}

function loadPrDraft(prNumber) {
  try {
    const draftPath = getPrDraftPath(prNumber);
    if (!draftPath || !fs.existsSync(draftPath)) return null;
    const raw = fs.readFileSync(draftPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log('ERROR', '[pr-draft] load failed:', err.message);
    return null;
  }
}

function deletePrDraft(prNumber) {
  try {
    const draftPath = getPrDraftPath(prNumber);
    if (draftPath && fs.existsSync(draftPath)) {
      fs.unlinkSync(draftPath);
    }
  } catch (err) {
    log('ERROR', '[pr-draft] delete failed:', err.message);
  }
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
    log('INFO', '[cleanup] Disabled');
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
        log('ERROR', `[cleanup] Error processing ${filePath}:`, err.message);
      }
    }
  }

  if (deletedCount > 0) {
    log('INFO', `[cleanup] Deleted ${deletedCount} files older than ${retentionDays} days`);
  } else {
    log('INFO', `[cleanup] No files older than ${retentionDays} days to delete`);
  }
}

// Clean up auto-fix worktrees left behind by hermes or previous runs
function cleanupWorktrees() {
  const worktreesDir = path.join(app.getPath('userData'), 'worktrees');
  if (!fs.existsSync(worktreesDir)) return;

  try {
    const entries = fs.readdirSync(worktreesDir);
    let cleaned = 0;
    for (const entry of entries) {
      const worktreePath = path.join(worktreesDir, entry);
      try {
        // Check if it's a directory (worktree) that's not currently in use
        const stat = fs.statSync(worktreePath);
        if (!stat.isDirectory()) continue;

        // Try to remove the worktree via git, falling back to rm -rf
        const repoPath = getLocalRepoPath(`${appConfig.repoOwner}/${appConfig.repoName}`);
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, timeout: 10000 });
        } catch {
          // git worktree remove failed, try direct delete
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        cleaned++;
        log('INFO', `[cleanup] Removed worktree: ${entry}`);
      } catch (err) {
        log('ERROR', `[cleanup] Failed to remove worktree ${entry}:`, err.message);
      }
    }
    if (cleaned > 0) {
      // Prune any stale worktree references
      const repoPath = getLocalRepoPath(`${appConfig.repoOwner}/${appConfig.repoName}`);
      try { execSync('git worktree prune', { cwd: repoPath, timeout: 5000 }); } catch {}
      log('INFO', `[cleanup] Cleaned up ${cleaned} worktree(s)`);
    }
  } catch (err) {
    log('ERROR', '[cleanup] Error scanning worktrees:', err.message);
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
    atomicWriteFileSync(draftPath, JSON.stringify(draft, null, 2));
    return draftPath;
  } catch (err) {
    log('ERROR', '[draft] save failed:', err.message);
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
    log('ERROR', '[draft] load failed:', err.message);
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
    log('ERROR', '[draft] delete failed:', err.message);
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
      try { fs.unlinkSync(tmpPath); } catch (e) { console.warn('[s3] Failed to clean up temp file:', e.message); }

      if (err) {
        log('ERROR', '[s3] upload failed:', err.message);
        return reject(new Error(`S3 upload failed: ${err.message}`));
      }

      const urlPath = prefix ? `${prefix}/${fileName}` : fileName;
      const url = `https://${bucket}.s3.amazonaws.com/${urlPath.split('/').map(encodeURIComponent).join('/')}`;
      log('INFO', '[s3] uploaded:', url);
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
  let result = null;

  while (true) {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}"`
    );
    const commits = JSON.parse(stdout || '[]');
    if (commits.length === 0) break;

    // Find last commit with date <= targetDate
    for (const commit of commits) {
      if (commit.commit.committer.date <= targetDate) {
        result = commit.sha;
      }
    }

    // If all commits are after target date, we've gone past the boundary
    if (commits[0].commit.committer.date > targetDate) {
      break;
    }

    // If the last commit in this page is after target date, we found our boundary
    if (commits[commits.length - 1].commit.committer.date > targetDate && result) {
      return result;
    }

    if (commits.length < 100) break;
    page++;
  }

  return result;
}

// Resolve the base SHA for a PR (the commit a review's diff is measured against).
// For 'since-review' mode this is the most recent non-COMMENTED review's commit;
// otherwise (or if no review) it's the PR's base branch SHA. Runs independent of
// gh pr view / gh pr diff so it can execute in parallel with them.
async function resolveBaseSha(owner, repo, prNumber, diffMode) {
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

  return { baseSha, reviewInfo };
}

// Run an async function over an array with a bounded concurrency limit.
// Preserves order of results. Used to parallelize independent per-commit
// git operations without spawning unbounded numbers of child processes.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Compute the net diff of ONLY the PR's own commits since the last review,
// applied on top of the review base commit. This is what GitHub shows as
// "changes since your review": intermediate placeholder states cancel out
// (added in one commit, removed in the next), while master's merged-in
// changes are excluded. A plain `git diff base..head` cannot do this because
// the PR branch absorbs master merges into the base..head range.
//
// Implementation: create a detached temp worktree at the review base, replay
// the given (non-merge, after-review) commit SHAs onto it via cherry-pick -n
// (no commit, so no author config needed), resolving any conflict by taking
// the PR commit's version (these are the PR's own changes), then diff the
// worktree against the review base. The rebased state is also written to a
// persistent ref (`sinceReviewRef`) so later per-file operations (context
// expansion) can diff against the exact same base — keeping them consistent
// with what's displayed. The worktree itself is removed in a finally.
async function computeSinceReviewNetDiff(repoPath, baseSha, afterReviewShas) {
  if (!repoPath || !baseSha || !afterReviewShas || afterReviewShas.length === 0) {
    return { diff: '', sinceReviewRef: null };
  }
  const worktreePath = path.join(os.tmpdir(), `pr-reviewer-since-review-${Date.now()}`);
  const wtQ = JSON.stringify(worktreePath); // shell-quote the (space-containing) temp path
  // Deterministic, base-scoped ref so expand/other ops can diff against the
  // same rebased state. Overwriting on repeat loads keeps it fresh.
  const sinceReviewRef = `refs/tmp/pr-reviewer-since-review/${baseSha}`;
  let created = false;
  try {
    // Remove any stale ref for this base before writing the new rebase.
    await execPromise(`git update-ref -d ${sinceReviewRef}`, { cwd: repoPath }).catch(() => {});

    await execPromise(`git worktree add --detach ${wtQ} ${baseSha}`, { cwd: repoPath, timeout: 60000 });
    created = true;

    // Replay the PR's own commits onto the review base.
    for (const sha of afterReviewShas) {
      try {
        await execPromise(`git cherry-pick -n ${sha}`, { cwd: worktreePath, timeout: 30000 });
      } catch (err) {
        // Conflict — resolve by keeping the PR commit's version of each file.
        const conflicted = await execPromise(
          `git diff --name-only --diff-filter=U`,
          { cwd: worktreePath }
        ).catch(() => '');
        const files = conflicted.split('\n').filter(Boolean);
        if (files.length === 0) {
          // No conflicted paths reported but cherry-pick still failed (e.g.
          // a commit that deletes a file we also have). Take the PR side.
          await execPromise(`git checkout --theirs -- .`, { cwd: worktreePath }).catch(() => {});
        } else {
          await execPromise(`git checkout --theirs -- ${files.map(f => JSON.stringify(f)).join(' ')}`, { cwd: worktreePath }).catch(() => {});
        }
        await execPromise(`git add -A`, { cwd: worktreePath }).catch(() => {});
      }
    }

    // Net diff of the worktree (review base + PR commits) vs the review base.
    const netDiff = await execPromise(`git diff ${baseSha}`, { cwd: worktreePath, timeout: 60000 }).catch(() => '');

    // Persist the rebased state as a commit so it survives worktree removal
    // and can be referenced later (context expansion). Write it to the ref
    // from the main repo so the object is shared.
    await execPromise(`git add -A`, { cwd: worktreePath }).catch(() => {});
    const rebasedCommit = await execPromise(
      `git -c user.name="PR Reviewer" -c user.email="pr-reviewer@local" commit -m "tmp since-review rebase"`,
      { cwd: worktreePath }
    ).catch(() => '');
    const commitSha = (rebasedCommit.match(/\[[^\]]*\]\s*(\w{40})/) || [])[1];
    if (commitSha) {
      await execPromise(`git update-ref ${sinceReviewRef} ${commitSha}`, { cwd: repoPath }).catch((e) => log('WARN', '[generateDiff] failed to write since-review ref:', e.message));
    }

    return { diff: netDiff, sinceReviewRef: commitSha ? sinceReviewRef : null };
  } catch (err) {
    log('ERROR', '[generateDiff] since-review net diff failed:', err.message);
    return { diff: '', sinceReviewRef: null };
  } finally {
    if (created) {
      try { await execPromise(`git worktree remove --force ${wtQ}`, { cwd: repoPath, timeout: 30000 }); }
      catch (e) { log('WARN', '[generateDiff] Failed to remove temp worktree:', e.message); }
    }
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  }
}

// Generate diff for a PR — supports full diff or since-last-review
async function generateDiff(prNumber, repoKey) {
  const safePr = safePrNumber(prNumber);
  if (!safePr) throw new Error(`Invalid PR number: ${prNumber}`);
  prNumber = safePr;
  const repoPath = getLocalRepoPath(repoKey);
  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner || 'webtoolbox';
    repo = appConfig.repoName || 'Website-Toolbox';
  }
  const diffMode = (appConfig.diff || {}).mode || 'since-review';

  // Run the three independent API calls in parallel:
  //  - gh pr view   (HEAD SHA + PR metadata)
  //  - gh pr diff   (full unified diff — used for reverted-file filtering + fallback)
  //  - resolveBaseSha (review lookup → base SHA)
  const prViewPromise = execPromise(
    `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefOid,title,author,assignees,body --jq '{headRefOid: .headRefOid, title: .title, author: (.author.login // ""), assignees: [.assignees[].login], body: (.body // "")}'`
  );
  const prDiffPromise = execPromise(
    `gh pr diff ${prNumber} --repo ${owner}/${repo}`,
    { timeout: 60000 }
  ).catch((err) => {
    // gh pr diff uses the GitHub API which caps unified diffs at 20000 lines
    // (HTTP 406 "diff too large"). That's a fallback source only — the primary
    // diff comes from git locally, so log and continue rather than fail the PR.
    log('ERROR', `[generateDiff] gh pr diff failed (may be too large), will use git diff: ${err.message}`);
    return '';
  });
  const basePromise = resolveBaseSha(owner, repo, prNumber, diffMode);

  const results = await Promise.all([prViewPromise, prDiffPromise, basePromise]);
  const prJson = results[0];
  let diffOut = results[1];
  const baseResult = results[2];
  // Set when a since-review net diff is produced; lets per-file operations
  // (context expansion) diff against the same rebased base as the display.
  let sinceReviewRef = null;

  const prData = JSON.parse(prJson || '{}');
  const headSha = prData.headRefOid;

  if (!headSha) {
    throw new Error('Could not get PR HEAD SHA');
  }

  const baseSha = baseResult.baseSha;
  const reviewInfo = baseResult.reviewInfo;

  log('INFO', '[generateDiff] baseSha:', baseSha ? baseSha.substring(0,7) : 'null', 'headSha:', headSha ? headSha.substring(0,7) : 'null', 'reviewInfo:', reviewInfo ? JSON.stringify(reviewInfo) : 'null', 'diffMode:', diffMode);

  if (baseSha === headSha) {
    throw new Error('No new commits since last review');
  }

  // Fetch the PR branch and master in parallel (both independent network calls).
  // On a shallow clone, fetching the PR branch brings in both headSha and baseSha.
  log('INFO', `[generateDiff] Fetching PR ${prNumber} branch + master from origin`);
  const [prFetch, masterFetch] = await Promise.allSettled([
    execPromise(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: repoPath, timeout: 60000 }),
    execPromise('git fetch origin master --depth=1', { cwd: repoPath, timeout: 30000 })
  ]);
  if (prFetch.status === 'fulfilled') log('INFO', '[generateDiff] Fetched PR branch successfully');
  else log('ERROR', '[generateDiff] PR branch fetch failed:', prFetch.reason && prFetch.reason.message);
  if (masterFetch.status === 'rejected') log('ERROR', '[generateDiff] master fetch failed:', masterFetch.reason && masterFetch.reason.message);

  // Check if SHAs are now available; if not, try individual fetch as last resort
  async function shaExists(sha) {
    try { await execPromise(`git cat-file -e ${sha}`, { cwd: repoPath }); return true; } catch { return false; }
  }

  if (!(await shaExists(headSha))) {
    log('INFO', `[generateDiff] Head SHA ${headSha.substring(0,7)} still not available after PR fetch`);
    throw new Error(`Cannot fetch head commit ${headSha.substring(0,7)}`);
  }
  if (!(await shaExists(baseSha))) {
    log('INFO', `[generateDiff] Base SHA ${baseSha.substring(0,7)} not in local repo, fetching individually`);
    try {
      await execPromise(`git fetch origin ${baseSha}`, { cwd: repoPath, timeout: 60000 });
    } catch (fetchErr) {
      throw new Error(`Cannot reach base commit ${baseSha.substring(0,7)}: ${fetchErr.message}`);
    }
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

  // Get all changed files (no extension filter — user controls visibility via sidebar filter)
  const changedFiles = files
    .split('\n')
    .map(f => f.trim())
    .filter(f => f)
    .filter((f, i, arr) => arr.indexOf(f) === i); // unique

  if (changedFiles.length === 0) {
    throw new Error('No files changed since last review');
  }

  // If reviewing since last review, build the net diff from ONLY the PR's own
  // commits after the review (see computeSinceReviewNetDiff). This matches
  // GitHub's "changes since your review" — placeholder states cancel out while
  // master's merged-in changes are excluded.
  if (reviewInfo && baseSha && headSha) {
    try {
      // Get files changed by PR commits after the review (non-merge commits only).
      // Use --paginate so we fetch ALL commits (the endpoint defaults to the first
      // 100, oldest-first — for long PRs the newest commits after the review would
      // otherwise be missed, making afterReview empty and falling back to the full
      // PR diff, e.g. PR #6460 showed 141 files instead of the 1 since-review file).
      const reviewCommits = await execPromise(
        `gh api --paginate "repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100"`,
        { timeout: 60000 }
      );
      const allCommits = JSON.parse(reviewCommits || '[]');
      const reviewDate = reviewInfo.date;
      const afterReview = allCommits.filter(c => c.commit.committer.date > reviewDate && c.parents && c.parents.length < 2);

      if (afterReview.length > 0 && afterReview.length < allCommits.length) {
        const changedSinceReview = new Set();
        // Fetch changed files per commit in parallel (bounded concurrency)
        const fileLists = await mapLimit(afterReview, 4, async (c) => {
          try {
            return await execPromise(
              `git diff-tree --no-commit-id --name-only -r ${c.sha}`,
              { cwd: repoPath }
            );
          } catch { return ''; }
        });
        for (const files of fileLists) {
          files.split('\n').filter(Boolean).forEach(f => changedSinceReview.add(f));
        }

        if (changedSinceReview.size > 0) {
          // Build the net diff of ONLY the PR's own commits since the review,
          // applied on top of the review base. This is what GitHub shows as
          // "changes since your review". A plain `git diff base..head` is wrong
          // here: the PR branch merges master repeatedly, so base..head sweeps
          // in every master merge the branch absorbed (e.g. PR 6845 had 3,328
          // merge commits inflating a 25-file diff to 5.5MB). Replaying just the
          // after-review commits onto the review base cancels intermediate
          // placeholder states (added in one commit, removed in the next) while
          // excluding master's merged-in changes.
          const afterReviewShas = afterReview.map(c => c.sha).filter(Boolean);
          const netResult = await computeSinceReviewNetDiff(repoPath, baseSha, afterReviewShas);
          const netDiff = netResult.diff;
          if (netDiff && netDiff.trim()) {
            diffOut = netDiff;
            sinceReviewRef = netResult.sinceReviewRef;
            log('INFO', `[generateDiff] Using since-review net diff (replayed ${afterReviewShas.length} PR commits) for ${changedSinceReview.size} file(s)`);
          }
        }
      }
    } catch (filterErr) {
      log('ERROR', '[generateDiff] Failed to filter since-review files:', filterErr.message);
      // Fall back to gh pr diff
    }
  }

  if (!diffOut || !diffOut.trim()) {
    throw new Error('Diff is empty — no changes detected between base and head commits');
  }

  const tmpPath = path.join(getGeneratedDir(), `pr-${prNumber}-clean.diff`);
  fs.writeFileSync(tmpPath, diffOut);

  return { diffPath: tmpPath, baseSha, headSha, reviewInfo, filesChanged: changedFiles.length, prData, sinceReviewRef };
}

// Clean up stale since-review temp refs (refs/tmp/pr-reviewer-since-review/*).
// These are written per review-base to keep context expansion consistent with
// the displayed diff. They're only needed while a PR is open for expansion, so
// pruning refs older than a retention window bounds growth regardless of how
// long the app stays running. Runs at startup (retentionMs = Infinity => all)
// and on a periodic interval (retentionMs = 24h).
function cleanupSinceReviewRefs(retentionMs = Infinity) {
  const repoPath = getLocalRepoPath(`${appConfig.repoOwner}/${appConfig.repoName}`);
  try {
    const refs = execSync(
      `git for-each-ref --format='%(refname) %(creatordate:unix)' 'refs/tmp/pr-reviewer-since-review/*'`,
      { cwd: repoPath, encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!refs) return;
    // retentionMs === Infinity means "prune everything" (startup); otherwise
    // prune refs older than the window.
    const pruneAll = !isFinite(retentionMs);
    const cutoffMs = Date.now() - retentionMs;
    let pruned = 0;
    for (const line of refs.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || !parts[0]) continue;
      const ref = parts[0];
      const createdMs = parseInt(parts[1], 10) * 1000;
      // A ref we can't date (parse failed) is kept for the next round unless
      // we're pruning everything.
      if (pruneAll || isNaN(createdMs) || createdMs < cutoffMs) {
        try { execSync(`git update-ref -d ${ref}`, { cwd: repoPath, timeout: 5000 }); pruned++; }
        catch {}
      }
    }
    if (pruned > 0) log('INFO', `[cleanup] Pruned ${pruned} stale since-review ref(s)`);
  } catch {}
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
        {
          label: 'Check for Updates...',
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (!focused) return;
            focused.webContents.send('check-update-menu');
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
        {
          label: 'Review History',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) focused.webContents.send('open-review-history');
          }
        },
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) focused.webContents.send('open-shortcuts');
          }
        }
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
      webSecurity: false  // Required for loading local diff files and temp images via file:// protocol
    }
  });

  windows.set(windowId, win);

  // Allow microphone (and camera) access so voice mode's getUserMedia works.
  // Without this, Electron denies media permission requests by default and
  // getUserMedia fails (e.g. "No microphone found").
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' || permission === 'mediaKeySystem';
  });

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
    // Load file from options, CLI args, or pending open-file (macOS double-click before ready)
    const filePath = options.filePath || pendingOpenFile;
    if (filePath && fs.existsSync(filePath)) {
      const diffContent = fs.readFileSync(filePath, 'utf8');
      const fileName = path.basename(filePath);
      win.webContents.send('load-diff', { content: diffContent, fileName, filePath: path.resolve(filePath) });
      if (pendingOpenFile === filePath) pendingOpenFile = null; // Clear consumed pending file
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
    cleanupWorktrees();
    cleanupSinceReviewRefs();
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

ipcMain.handle('renderer-log', (event, level, ...args) => {
  log(level, '[renderer]', ...args);
});

ipcMain.handle('checkout-master', async (event, { repoKey }) => {
  const repoPath = getLocalRepoPath(repoKey);
  if (!repoPath) return { error: 'No repo path' };
  try {
    // Try master first, then main
    try {
      await execPromise('git checkout master', { cwd: repoPath, timeout: 10000 });
      log('INFO', '[checkout-master] Switched to master branch in', repoKey);
      return { branch: 'master' };
    } catch {
      await execPromise('git checkout main', { cwd: repoPath, timeout: 10000 });
      log('INFO', '[checkout-master] Switched to main branch in', repoKey);
      return { branch: 'main' };
    }
  } catch (err) {
    log('ERROR', '[checkout-master] Failed:', err.message);
    return { error: err.message };
  }
});

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

ipcMain.handle('save-draft', async (event, data) => {
  if (!data || !data.draft) return null;
  return saveDraft(data.filePath, data.draft);
});
ipcMain.handle('load-draft', async (event, filePath) => {
  if (!filePath) return null;
  return loadDraft(filePath);
});
ipcMain.handle('delete-draft', async (event, filePath) => {
  if (!filePath) return false;
  deleteDraft(filePath);
  return true;
});

ipcMain.handle('save-pr-draft', async (event, data) => {
  if (!data || !data.prNumber) return null;
  return savePrDraft(data.prNumber, data);
});
ipcMain.handle('load-pr-draft', async (event, prNumber) => {
  if (!prNumber) return null;
  return loadPrDraft(prNumber);
});
ipcMain.handle('delete-pr-draft', async (event, prNumber) => {
  if (!prNumber) return false;
  deletePrDraft(prNumber);
  return true;
});

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
    log('ERROR', '[image] local save failed:', err.message);
  }

  const upload = appConfig.imageUpload || {};
  if (upload.enabled && upload.s3Bucket) {
    try {
      const url = await uploadImageToS3(imageDataUrl, fileName);
      return { localPath: `images/${fileName}`, url };
    } catch (err) {
      log('ERROR', '[image] S3 upload failed:', err.message);
      return { localPath: `images/${fileName}`, url: null };
    }
  }

  return { localPath: `images/${fileName}`, url: null };
});

// Open PR in system browser
ipcMain.handle('open-pr-new-window', async (event, prNumber) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { error: 'Invalid PR number' };
  try {
    const owner = appConfig.repoOwner || 'webtoolbox';
    const repo = appConfig.repoName || 'Website-Toolbox';
    const url = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    shell.openExternal(url);
    log('INFO', `[pr-open] Opened PR #${prNumber} in browser: ${url}`);
    return { success: true };
  } catch (err) {
    log('ERROR', '[pr-open] failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('load-pr', async (event, { prNumber, repo } = {}) => {
  try {
    const safePr = safePrNumber(prNumber);
    const cacheKey = `${safePr}:${repo || 'default'}`;
    
    // Check prefetch cache first — instant return if already fetched
    const prefetched = prefetchCache[cacheKey];
    if (prefetched && prefetched !== 'in-progress') {
      delete prefetchCache[cacheKey];
      log('INFO', '[pr] Returning prefetched result for PR #' + prNumber);
      return prefetched;
    }
    
    log('INFO', '[pr] Loading PR', prNumber, 'repo:', repo || 'default');
    const result = await generateDiff(prNumber, repo);
    const content = fs.readFileSync(result.diffPath, 'utf8');
    log('INFO', '[pr] Loaded PR', prNumber, ':', content.length, 'chars,', (content.match(/diff --git/g) || []).length, 'files');
    const fileName = `pr-${prNumber}-clean.diff`;

    // Use PR metadata from generateDiff() instead of a second API call
    const prData = result.prData || {};
    const prTitle = prData.title || '';
    const prAuthor = prData.author || '';
    const prAssignees = (prData.assignees || []).filter(a => a !== prAuthor);
    const prBody = prData.body || '';

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
    filesChanged: result.filesChanged,
    repoPath: getLocalRepoPath(repo),
    baseSha: result.baseSha || null,
    headSha: result.headSha || null,
    sinceReviewRef: result.sinceReviewRef || null
    };
  } catch (err) {
    log('ERROR', '[pr] load failed:', err.message);
    return { error: err.message };
  }
});

// Fast PR metadata — title, author, assignees (no diff generation)
// Returns in ~1-2s vs 10-30s for full load-pr
ipcMain.handle('get-pr-info', async (event, { prNumber, repo } = {}) => {
  const safePr = safePrNumber(prNumber);
  if (!safePr) return { error: 'Invalid PR number' };
  // Serve title/author/assignees from the prefetch cache when available so the
  // title appears instantly alongside the diff. Do NOT consume the entry here —
  // load-pr still needs it for the diff content.
  const cacheKey = `${safePr}:${repo || 'default'}`;
  const prefetched = prefetchCache[cacheKey];
  if (prefetched && prefetched !== 'in-progress') {
    log('INFO', '[get-pr-info] Returning cached metadata for PR #' + safePr);
    return {
      prTitle: prefetched.prTitle || '',
      prAuthor: prefetched.prAuthor || '',
      prAssignees: prefetched.prAssignees || [],
      prBody: prefetched.prBody || '',
      state: prefetched.state || '',
      filesChanged: prefetched.filesChanged || 0,
      headSha: prefetched.headSha || '',
      baseSha: prefetched.baseSha || ''
    };
  }
  let owner, repoName;
  if (repo && repo.includes('/')) {
    [owner, repoName] = repo.split('/');
  } else {
    owner = appConfig.repoOwner || 'webtoolbox';
    repoName = appConfig.repoName || 'Website-Toolbox';
  }
  try {
    log('INFO', '[get-pr-info] Fetching metadata for PR #' + safePr);
    const prJson = await execPromise(
      `gh pr view ${safePr} --repo ${owner}/${repoName} --json title,author,assignees,body,state,headRefOid,baseRefOid,changedFiles --jq '{title: .title, author: (.author.login // ""), assignees: [.assignees[].login], body: (.body // ""), state: .state, headRefOid: .headRefOid, baseRefOid: .baseRefOid, changedFiles: .changedFiles}'`,
      { timeout: 15000 }
    );
    const prData = JSON.parse(prJson || '{}');
    log('INFO', '[get-pr-info] Got metadata:', prData.title?.substring(0, 50));
    return {
      prTitle: prData.title || '',
      prAuthor: prData.author || '',
      prAssignees: (prData.assignees || []).filter(a => a !== prData.author),
      prBody: prData.body || '',
      state: prData.state || '',
      filesChanged: prData.changedFiles || 0,
      headSha: prData.headRefOid || '',
      baseSha: prData.baseRefOid || ''
    };
  } catch (err) {
    log('ERROR', '[get-pr-info] Failed:', err.message);
    return { error: err.message };
  }
});

// Prefetch PR diff in background — result cached for next load-pr call
const prefetchCache = {};
ipcMain.handle('prefetch-pr', async (event, { prNumber, repo } = {}) => {
  const safePr = safePrNumber(prNumber);
  if (!safePr) return { error: 'Invalid PR number' };
  const cacheKey = `${safePr}:${repo || 'default'}`;
  // Don't re-prefetch if already in progress or cached
  if (prefetchCache[cacheKey]) {
    log('INFO', '[prefetch-pr] PR #' + safePr + ' already prefetched/in-progress');
    return { status: 'cached' };
  }
  prefetchCache[cacheKey] = 'in-progress';
  log('INFO', '[prefetch-pr] Starting background fetch for PR #' + safePr);
  try {
    const result = await generateDiff(safePr, repo);
    const content = fs.readFileSync(result.diffPath, 'utf8');
    const prData = result.prData || {};
    prefetchCache[cacheKey] = {
      content,
      fileName: `pr-${safePr}-clean.diff`,
      filePath: result.diffPath,
      prNumber: safePr,
      prTitle: prData.title || '',
      prAuthor: prData.author || '',
      prAssignees: (prData.assignees || []).filter(a => a !== prData.author),
      prBody: prData.body || '',
      reviewInfo: result.reviewInfo,
      filesChanged: result.filesChanged,
      repoPath: getLocalRepoPath(repo),
      baseSha: result.baseSha || null,
      headSha: result.headSha || null,
      sinceReviewRef: result.sinceReviewRef || null
    };
    log('INFO', '[prefetch-pr] Cached PR #' + safePr + ':', content.length, 'chars');
    return { status: 'done' };
  } catch (err) {
    log('ERROR', '[prefetch-pr] Failed for PR #' + safePr + ':', err.message);
    delete prefetchCache[cacheKey];
    return { error: err.message };
  }
});

// Get prefetched PR result (consumed by load-pr flow)
ipcMain.handle('get-prefetched-pr', (event, { prNumber, repo } = {}) => {
  const safePr = safePrNumber(prNumber);
  if (!safePr) return null;
  const cacheKey = `${safePr}:${repo || 'default'}`;
  const cached = prefetchCache[cacheKey];
  if (cached && cached !== 'in-progress') {
    delete prefetchCache[cacheKey]; // Consume once
    log('INFO', '[get-prefetched-pr] Returning cached result for PR #' + safePr);
    return cached;
  }
  return null;
});

// Clear stale prefetch entries (older than 5 minutes)
setInterval(() => {
  // Simple cleanup — in-progress entries that never resolved
  for (const key of Object.keys(prefetchCache)) {
    if (prefetchCache[key] === 'in-progress') {
      // Leave in-progress alone — they might still be running
    }
  }
}, 300000);

// Prune stale since-review refs on a schedule so refs don't accumulate while
// the app stays open across many reviewed PRs. 24h retention is far beyond how
// long a PR stays open for expansion, so this bounds growth tightly.
setInterval(() => {
  try { cleanupSinceReviewRefs(24 * 60 * 60 * 1000); } catch {}
}, 3600000);

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
        if (filter.excludeTitleStartsWith && filter.excludeTitleStartsWith.length) {
          const prefixes = filter.excludeTitleStartsWith.map(p => p.toLowerCase());
          prs = prs.filter(pr => {
            const title = (pr.title || '').toLowerCase();
            return !prefixes.some(p => title.startsWith(p));
          });
        }
        if (filter.titleContains) {
          const needle = filter.titleContains.toLowerCase();
          prs = prs.filter(pr => (pr.title || '').toLowerCase().includes(needle));
        }

        prs.sort((a, b) => new Date(b.created) - new Date(a.created));
        resolve({ prs });
      })
      .catch(err => {
        log('ERROR', '[list-prs] failed:', err.message);
        resolve({ prs: [], error: err.message });
      });
  });
});

// ===================== MULTI-REPO HANDLERS =====================

let reposConfigCache = null;
let reposConfigCacheTime = 0;
const REPOS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadReposConfig() {
  // Return cached result if fresh
  if (reposConfigCache && (Date.now() - reposConfigCacheTime) < REPOS_CACHE_TTL) {
    return reposConfigCache;
  }

  // Load checked state from private config
  const privateConfigPath = path.join(app.getPath('home'), '.config', 'pr-reviewer', 'config.json');
  let checkedState = {};
  try {
    const raw = fs.readFileSync(privateConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const r of (parsed.repos || [])) {
      checkedState[`${r.owner}/${r.name}`] = r.checked;
    }
  } catch (err) { console.warn('[loadReposConfig] Could not read private config for checked state:', err.message); }

  // Load default owner from config
  const defaultOwner = appConfig.repoOwner || 'webtoolbox';

  // Fetch all repos from gh for the default owner
  let ghRepos = [];
  try {
    const stdout = await execPromise(
      `gh repo list ${defaultOwner} --limit 100 --json name,isPrivate --jq '[.[] | {owner: "${defaultOwner}", name: .name}]'`,
      { timeout: 15000 }
    );
    ghRepos = JSON.parse(stdout || '[]');
  } catch (err) {
    log('ERROR', '[repos] gh repo list failed:', err.message);
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

  // Cache the result
  reposConfigCache = repos;
  reposConfigCacheTime = Date.now();

  return repos;
}

ipcMain.handle('list-repos', async () => {
  try {
    return { repos: await loadReposConfig() };
  } catch (err) {
    log('ERROR', '[list-repos] failed:', err.message);
    return { repos: [], error: err.message };
  }
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
    } catch (err) { console.warn('[saveReposConfig] Could not read existing private config (may be first save):', err.message); }

    // Update repos
    existing.repos = repos;
    atomicWriteFileSync(privateConfigPath, JSON.stringify(existing, null, 2));

    // Update in-memory appConfig too
    appConfig.repos = repos;

    // Invalidate repos cache so next loadReposConfig() re-fetches
    reposConfigCache = null;
    reposConfigCacheTime = 0;

    return { success: true };
  } catch (err) {
    log('ERROR', '[save-repos] failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('list-all-prs', async (event, { repos, filter }) => {
  log('INFO', `[list-all-prs] Called with ${repos ? repos.length : 0} repos, filter:`, JSON.stringify(filter));
  try {
    const filterConfig = filter || appConfig.prFilter || {};
    const errors = [];
    const allPrs = [];

    if (!repos || !Array.isArray(repos)) {
      log('ERROR', '[list-all-prs] repos is not an array:', repos);
      return { prs: [], errors: [{ repo: '(unknown)', error: 'repos parameter is not an array' }] };
    }

    for (const repo of repos) {
      const { owner, name } = repo;
      if (!owner || !name) {
        log('WARN', '[list-all-prs] Skipping repo with empty owner/name:', JSON.stringify(repo));
        continue;
      }

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

        log('INFO', `[list-all-prs] ${owner}/${name}: fetched ${repoPrs.length} PRs`);

        // Apply filters
        if (filterConfig.reviewRequested) {
          repoPrs = repoPrs.filter(pr => pr.reviewers && pr.reviewers.includes(owner));
        }
        if (filterConfig.excludeTitleStartsWith && filterConfig.excludeTitleStartsWith.length) {
          const prefixes = filterConfig.excludeTitleStartsWith.map(p => p.toLowerCase());
          repoPrs = repoPrs.filter(pr => {
            const title = (pr.title || '').toLowerCase();
            return !prefixes.some(p => title.startsWith(p));
          });
        }
        if (filterConfig.titleContains) {
          const needle = filterConfig.titleContains.toLowerCase();
          repoPrs = repoPrs.filter(pr => (pr.title || '').toLowerCase().includes(needle));
        }

        // Add repo field to each PR
        for (const pr of repoPrs) {
          pr.repo = `${owner}/${name}`;
        }

        allPrs.push(...repoPrs);
      } catch (err) {
        log('ERROR', `[list-all-prs] failed for ${owner}/${name}:`, err.message);
        errors.push({ repo: `${owner}/${name}`, error: err.message });
      }
    }

    // Sort all PRs by created date descending
    allPrs.sort((a, b) => new Date(b.created) - new Date(a.created));

    log('INFO', `[list-all-prs] Returning ${allPrs.length} PRs, ${errors.length} errors`);
    return { prs: allPrs, errors };
  } catch (err) {
    log('ERROR', '[list-all-prs] Top-level error:', err);
    return { prs: [], errors: [{ repo: '(unknown)', error: err.message || String(err) }] };
  }
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

// Close a pull request via gh CLI
ipcMain.handle('close-pr', async (event, { prNumber, comment, repo: repoKey }) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { error: 'Valid PR number is required' };
  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner;
    repo = appConfig.repoName;
  }
  if (!owner || !repo) {
    return { error: 'repoOwner and repoName must be configured in config.json' };
  }

  try {
    // Post comment first if provided
    if (comment && comment.trim()) {
      const tmpPath = path.join(getGeneratedDir(), `close-comment-${Date.now()}.txt`);
      fs.writeFileSync(tmpPath, comment.trim());
      try {
        await execPromise(
          `gh pr comment ${prNumber} --repo ${owner}/${repo} --body-file "${tmpPath}"`
        );
      } finally {
        try { fs.unlinkSync(tmpPath); } catch (e) { console.warn('[close-pr] Failed to clean up temp comment file:', e.message); }
      }
    }

    // Close the PR
    await execPromise(
      `gh pr close ${prNumber} --repo ${owner}/${repo}`
    );

    console.log(`[close-pr] PR #${prNumber} closed on ${owner}/${repo}`);
    return { success: true };
  } catch (err) {
    console.error('[close-pr] failed:', err.message);
    return { error: err.message };
  }
});

// Submit review directly to GitHub via gh CLI
// Compute diff positions from a unified diff (for GitHub review API)
function computePositionsFromDiff(diffContent) {
  const map = {};
  let currentFile = null;
  let position = 0;
  let leftLine = 0;
  let rightLine = 0;
  const lines = diffContent.split('\n');
  let inHeaders = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        currentFile = match[2];
        inHeaders = true;
        position = 0;
        leftLine = 0;
        rightLine = 0;
      }
    } else if (inHeaders && (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index'))) {
      continue;
    } else if (line.startsWith('@@')) {
      inHeaders = false;
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        leftLine = parseInt(match[1], 10);
        rightLine = parseInt(match[3], 10);
      }
    } else if (currentFile && !inHeaders) {
      if (line.startsWith('-')) {
        position++;
        map[`${currentFile}:${leftLine}:LEFT`] = position;
        leftLine++;
      } else if (line.startsWith('+')) {
        position++;
        map[`${currentFile}:${rightLine}:RIGHT`] = position;
        rightLine++;
      } else if (line.startsWith('\\')) {
        position++;
      } else if (line.startsWith(' ')) {
        position++;
        map[`${currentFile}:${leftLine}:LEFT`] = position;
        map[`${currentFile}:${rightLine}:RIGHT`] = position;
        leftLine++;
        rightLine++;
      }
    }
  }
  return map;
}

ipcMain.handle('submit-github-review', async (event, { prNumber, body, eventType, comments, repo: repoKey }) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { error: 'Valid PR number is required' };
  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner;
    repo = appConfig.repoName;
  }
  if (!owner || !repo) {
    return { error: 'repoOwner and repoName must be configured in config.json' };
  }

  // Map event types to GitHub API values
  const eventMap = {
    'approve': 'APPROVE',
    'request_changes': 'REQUEST_CHANGES',
    'comment': 'COMMENT'
  };
  const ghEvent = eventMap[eventType] || 'COMMENT';

  // Build inline comments array — recompute positions from gh pr diff
  // (renderer positions may be from per-commit diffs which don't match GitHub's unified diff)
  let ghComments = [];
  let skippedCommentsInfo = [];
  let fileCommentsPosted = 0;
  if (comments && comments.length > 0) {
    // Separate file-level comments (no line/position needed) from inline comments
    const fileComments = comments.filter(c => c.file && c.text && c.level === 'file');
    const inlineComments = comments.filter(c => c.file && c.text && c.level !== 'file' && c.line);

    // File-level comments: submit via gh pr comment (GitHub review API doesn't support them)
    for (const c of fileComments) {
      try {
        const tmpPath = path.join(getGeneratedDir(), `file-comment-${Date.now()}.txt`);
        fs.writeFileSync(tmpPath, c.text);
        try {
          await execPromise(
            `gh pr comment ${prNumber} --repo ${owner}/${repo} --body-file "${tmpPath}"`,
            { timeout: 15000 }
          );
          fileCommentsPosted++;
          log('INFO', `[github-review] File-level comment posted on ${c.file}`);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } catch (commentErr) {
        log('ERROR', `[github-review] Failed to post file-level comment on ${c.file}:`, commentErr.message);
      }
    }

    // Get the PR's unified diff to compute correct positions for inline comments
    if (inlineComments.length > 0) {
      log('INFO', `[github-review] Mapping ${inlineComments.length} inline comments to positions`);
      log('INFO', `[github-review] Comment files: ${[...new Set(inlineComments.map(c => c.file))].join(', ')}`);

      let prDiff = '';
      try {
        prDiff = await execPromise(`gh pr diff ${prNumber} --repo ${owner}/${repo}`, { timeout: 30000 });
      } catch (diffErr) {
        log('ERROR', '[github-review] Failed to fetch PR diff for position mapping:', diffErr.message);
      }

      if (prDiff) {
        log('INFO', `[github-review] PR diff: ${prDiff.length} chars, ${((prDiff.match(/diff --git/g) || []).length)} files`);
        const positionMap = computePositionsFromDiff(prDiff);
        log('INFO', `[github-review] Position map: ${Object.keys(positionMap).length} entries`);

        // Build set of files in the unified diff
        const diffFiles = new Set();
        for (const key of Object.keys(positionMap)) {
          diffFiles.add(key.split(':').slice(0, -2).join(':'));
        }
        log('INFO', `[github-review] Diff files: ${[...diffFiles].join(', ')}`);

        // Filter out comments on files NOT in the unified diff
        // (e.g. files that were modified then reverted — net change is zero)
        const skippedFiles = [];
        const validComments = [];
        for (const c of inlineComments) {
          if (!diffFiles.has(c.file)) {
            skippedFiles.push(c.file);
            log('WARN', `[github-review] Skipping comment on ${c.file} — file not in unified diff (likely reverted)`);
          } else {
            validComments.push(c);
          }
        }

        if (skippedFiles.length > 0) {
          const uniqueSkipped = [...new Set(skippedFiles)];
          log('WARN', `[github-review] ${uniqueSkipped.length} file(s) not in unified diff: ${uniqueSkipped.join(', ')}`);
        }

        const mapped = [];
        const unmapped = [];
        for (const c of validComments) {
          const key = `${c.file}:${c.line}:${c.side || 'RIGHT'}`;
          const position = positionMap[key];
          if (position) {
            mapped.push({ path: c.file, position, body: c.text });
          } else {
            unmapped.push(key);
            // Try alternate side (LEFT for context lines)
            const altKey = `${c.file}:${c.line}:${c.side === 'RIGHT' ? 'LEFT' : 'RIGHT'}`;
            const altPosition = positionMap[altKey];
            if (altPosition) {
              log('INFO', `[github-review] Found position via alternate side for ${key} -> ${altKey}`);
              mapped.push({ path: c.file, position: altPosition, body: c.text });
            }
          }
        }

        if (unmapped.length > 0) {
          log('WARN', `[github-review] ${unmapped.length} comments could not be mapped: ${unmapped.join('; ')}`);
          // Log sample of available keys near the first unmapped comment for debugging
          const firstUnmapped = unmapped[0];
          const [unmappedFile] = firstUnmapped.split(':');
          const nearbyKeys = Object.keys(positionMap)
            .filter(k => k.startsWith(unmappedFile + ':'))
            .slice(0, 10);
          log('WARN', `[github-review] Available positions for ${unmappedFile}: ${nearbyKeys.join(', ')}`);
        }

        ghComments.push(...mapped);

        // If some comments were skipped (file not in unified diff), store info for the user
        if (skippedFiles.length > 0) {
          skippedCommentsInfo = [...new Set(skippedFiles)].map(f => ({
            file: f,
            reason: 'File was modified then reverted — no net changes in PR'
          }));
        }
      } else {
        // Diff fetch failed — can't map positions, can't submit inline comments
        log('ERROR', '[github-review] PR diff empty — cannot submit inline comments');
      }
    }
  }

  const payload = { body: body || '', event: ghEvent };
  if (ghComments.length > 0) {
    payload.comments = ghComments;
  }

  // Validate: REQUEST_CHANGES and COMMENT require something meaningful
  if ((ghEvent === 'REQUEST_CHANGES' || ghEvent === 'COMMENT') && !payload.body && ghComments.length === 0 && fileCommentsPosted === 0) {
    return { error: 'Cannot submit an empty review. Write a review body or add inline comments.' };
  }

  // Ensure body is non-empty for REQUEST_CHANGES and COMMENT (GitHub rejects empty body)
  if (!payload.body && (ghEvent === 'REQUEST_CHANGES' || ghEvent === 'COMMENT')) {
    if (ghComments.length > 0) {
      payload.body = `Review with ${ghComments.length} comment${ghComments.length > 1 ? 's' : ''}`;
    } else if (fileCommentsPosted > 0) {
      payload.body = `Review with ${fileCommentsPosted} file comment${fileCommentsPosted > 1 ? 's' : ''}`;
    }
  }

  // Delete any existing pending review (GitHub only allows one at a time)
  try {
    const existingReviews = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100"`,
      { timeout: 15000 }
    );
    const reviews = JSON.parse(existingReviews || '[]');
    const currentUser = await execPromise('gh api user --jq .login', { timeout: 10000 });
    const pending = reviews.filter(r => r.state === 'PENDING' && r.user.login === currentUser.trim());
    for (const p of pending) {
      await execPromise(
        `gh api "repos/${owner}/${repo}/pulls/${prNumber}/reviews/${p.id}" --method DELETE`,
        { timeout: 10000 }
      );
      log('INFO', `[github-review] Deleted pending review ${p.id}`);
    }
  } catch (delErr) {
    log('WARN', '[github-review] Failed to check/delete pending reviews:', delErr.message);
  }

  // Write payload to temp file for gh api --input
  const tmpPath = path.join(getGeneratedDir(), `review-payload-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));

  log('INFO', '[github-review] submitting review:', JSON.stringify({ event: payload.event, bodyLen: (payload.body || '').length, commentCount: (payload.comments || []).length }));
  if (payload.comments && payload.comments.length > 0) {
    log('INFO', '[github-review] comments:', JSON.stringify(payload.comments.map(c => ({ path: c.path, pos: c.position, body: c.body?.substring(0, 50) }))));
  }

  try {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/reviews" --method POST --input "${tmpPath}"`
    );
    const result = JSON.parse(stdout || '{}');
    log('INFO', '[github-review] submitted successfully:', result.id);
    const response = { success: true, reviewId: result.id, htmlUrl: result.html_url };
    if (skippedCommentsInfo.length > 0) {
      response.skippedComments = skippedCommentsInfo;
    }
    return response;
  } catch (err) {
    const is422 = err.message && err.message.includes('422');
    log('ERROR', '[github-review] submission failed:', err.message);
    if (is422) {
      log('ERROR', '[github-review] HTTP 422 payload dump:', JSON.stringify(payload, null, 2));
      // Also persist the payload for post-mortem debugging
      try {
        const debugPath = path.join(getGeneratedDir(), `review-422-debug-${Date.now()}.json`);
        fs.writeFileSync(debugPath, JSON.stringify({ payload, error: err.message, repo: `${owner}/${repo}`, prNumber }, null, 2));
        log('ERROR', '[github-review] 422 debug payload saved to:', debugPath);
      } catch (dumpErr) { log('ERROR', '[github-review] Failed to save 422 debug payload:', dumpErr.message); }
    }
    return { error: err.message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { console.warn('[github-review] Failed to clean up temp review file:', e.message); }
  }
});

// Auto-fix with AI: send review comments to Hermes agent to create a fix PR
let currentUserLogin = null; // Cache for the session

ipcMain.handle('auto-fix-with-ai', async (event, { prNumber, comments, reviewBody, repo: repoKey }) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { error: 'Valid PR number is required' };
  let owner, repo;
  if (repoKey && repoKey.includes('/')) {
    [owner, repo] = repoKey.split('/');
  } else {
    owner = appConfig.repoOwner;
    repo = appConfig.repoName;
  }
  if (!owner || !repo) {
    return { error: 'repoOwner and repoName must be configured in config.json' };
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

    // Collect owner + assignees (not requested reviewers — they were just asked to review)
    const allParticipants = new Set([prAuthor, ...assignees]);
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

    // Worktree path in app data directory (avoids polluting main repo)
    const worktreePath = path.join(app.getPath('userData'), 'worktrees', `pr-${prNumber}`);
    const repoPath = getLocalRepoPath(repoKey);

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
1. Fetch the repository: \`cd <repo-path> && git fetch origin\`
2. Create a worktree for your changes: \`git worktree add ../auto-fix/pr-${prNumber} origin/${headBranch}\`
3. Change into the worktree: \`cd ../auto-fix/pr-${prNumber}\`
4. Read each file mentioned in the review comments and make the necessary code changes to address each comment
5. If an AGENTS.md file exists in the repo, follow its guidelines for code changes
6. Commit your changes with a clear message like "fix: address review comments for PR #${prNumber}"
7. Push the branch: \`git push origin HEAD:auto-fix/pr-${prNumber}\`
8. Create a PR targeting the original branch: \`gh pr create --base ${headBranch} --title "Auto-fix: Review comments for PR #${prNumber}" --body "Addresses review comments from PR #${prNumber}.\\n\\nReview comments addressed:\\n${commentSummary.replace(/"/g, '\\"')}"\`
9. Add reviewers and assignees: \`gh pr edit --add-reviewer ${participants.join(',')} --add-assignee ${participants.join(',')}\`
10. After creating the PR, add a comment on the original PR #${prNumber} mentioning the fix PR: \`gh pr comment ${prNumber} --body "🤖 I've created an auto-fix PR addressing the review comments: <link to new PR>"\`
11. Clean up the worktree when done: \`cd <repo-path> && git worktree remove ../auto-fix/pr-${prNumber}\`

IMPORTANT: Return ONLY the new PR URL as the last line of your output, in the format: PR_URL: https://github.com/${owner}/${repo}/pull/<number>`;

    log('INFO', '[auto-fix] Starting auto-fix for PR #' + prNumber + ' in ' + owner + '/' + repo);

    // Run hermes chat with the prompt using execFile to avoid shell escaping issues
    const { execFile } = require('child_process');
    const stdout = await new Promise((resolve, reject) => {
      execFile(appConfig.aiCommand, ['chat', '-p', appConfig.hermesProfile || 'wt', '--yolo', '-q', prompt], { timeout: 600000 }, (err, out) => {
        if (err) reject(err); else resolve(out);
      });
    });

    log('INFO', '[auto-fix] Hermes response:', stdout.substring(0, 200));

    // Extract PR URL from response
    const prUrlMatch = stdout.match(/PR_URL:\s*(https:\/\/[^\s]+)/i);
    const prUrl = prUrlMatch ? prUrlMatch[1] : null;

    // Try to extract PR number from URL
    const prNumMatch = prUrl ? prUrl.match(/\/pull\/(\d+)/) : null;
    const newPrNumber = prNumMatch ? prNumMatch[1] : null;

    if (prUrl) {
      log('INFO', '[auto-fix] Success! Fix PR created:', prUrl, 'PR#', newPrNumber);
      return { success: true, prUrl, prNumber: newPrNumber };
    }

    // If no PR_URL found, try to find any GitHub PR URL in output
    const anyPrUrl = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (anyPrUrl) {
      const num = anyPrUrl[0].match(/\/pull\/(\d+)/);
      return { success: true, prUrl: anyPrUrl[0], prNumber: num ? num[1] : null };
    }

    log('ERROR', '[auto-fix] Agent did not return a PR URL. Output:', stdout.substring(0, 500));
    return { success: false, error: 'Agent did not return a PR URL. Output: ' + stdout.substring(0, 500) };
  } catch (err) {
    log('ERROR', '[auto-fix] Failed:', err.message);
    return { error: err.message };
  } finally {
    // Always clean up the worktree, even if hermes failed
    if (worktreePath) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        log('INFO', '[auto-fix] Cleaned up worktree:', worktreePath);
      } catch (cleanErr) {
        log('ERROR', '[auto-fix] Failed to clean up worktree:', cleanErr.message);
      }
    }
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

9. Open the before/after image comparison slideshow for the current PR:
   {"action":"open_compare"}

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
- If the user says "show before and after" or "compare images" or "open the comparison", use "open_compare".
- For anything else, use "message" to respond.

Return a JSON array of actions. If only one action, still return it as an array: [{"action":"approve"}].
Do not wrap in markdown code fences. Return ONLY the JSON.`;

    console.log('[voice] Sending to Hermes for interpretation...');
    const stdout = await execPromise(
      `hermes chat -p ${appConfig.hermesProfile || 'wt'} ${JSON.stringify(prompt)} --model anthropic/claude-sonnet-4 -Q`,
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
      try { fs.unlinkSync(audioPath); } catch (e) { console.warn('[voice] Failed to clean up temp audio file:', e.message); }
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
  
  const downloadedPaths = [];
  for (const url of urls) {
    let localPath = null;
    try {
      const ext = '.png';
      localPath = path.join(app.getPath('temp'), `pr-img-${Date.now()}${ext}`);
      
      // Download using gh api with authentication
      const token = await execPromise('gh auth token');
      const response = await fetch(url, {
        headers: { 'Authorization': `token ${token}` }
      });
      
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);
        downloadedPaths.push(localPath);
        // Replace URL with local file path
        modifiedBody = modifiedBody.split(url).join(`file://${localPath}`);
        localPath = null; // Don't cleanup - it's referenced in the body
      }
    } catch (err) {
      console.error('[image-download] Failed:', url, err.message);
    } finally {
      // Cleanup temp file if download failed and file was created
      if (localPath) {
        try { fs.unlinkSync(localPath); } catch (e) { console.warn('[image-download] Failed to clean up temp file:', e.message); }
      }
    }
  }
  
  return { prBody: modifiedBody };
});

// Get commits for a PR
ipcMain.handle('get-pr-commits', async (event, prNumber, baseSha) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { commits: [], error: 'Invalid PR number' };
  const owner = appConfig.repoOwner || 'webtoolbox';
  const repo = appConfig.repoName || 'Website-Toolbox';
  try {
    const stdout = await execPromise(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100"`
    );
    let commits = JSON.parse(stdout || '[]');

    // Filter to only show commits since last review (after baseSha)
    if (baseSha) {
      const baseIdx = commits.findIndex(c => c.sha.startsWith(baseSha));
      if (baseIdx >= 0) {
        commits = commits.slice(baseIdx + 1);
        log('INFO', `[get-pr-commits] Filtered to ${commits.length} commits since ${baseSha.substring(0,7)}`);
      }
    }

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

// Get inline review comments for a PR
ipcMain.handle('get-review-comments', async (event, { prNumber, repo }) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { comments: [], error: 'Invalid PR number' };
  let owner, repoName;
  if (repo && repo.includes('/')) {
    [owner, repoName] = repo.split('/');
  } else {
    owner = appConfig.repoOwner || 'webtoolbox';
    repoName = appConfig.repoName || 'Website-Toolbox';
  }

  try {
    let allComments = [];
    let page = 1;
    while (true) {
      const stdout = await execPromise(
        `gh api "repos/${owner}/${repoName}/pulls/${prNumber}/comments?per_page=100&page=${page}"`
      );
      const batch = JSON.parse(stdout || '[]');
      allComments = allComments.concat(batch);
      if (batch.length < 100) break;
      page++;
    }

    // Map to our format
    const comments = allComments.map(c => ({
      id: c.id,
      path: c.path,
      line: c.line,
      side: c.side, // LEFT or RIGHT
      body: c.body,
      author: c.user.login,
      authorAvatar: c.user.avatar_url,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      diffHunk: c.diff_hunk,
      resolved: c.resolved || false,
      inReplyToId: c.in_reply_to_id,
      position: c.position,
      originalLine: c.original_line,
      originalPosition: c.original_position
    }));

    return { comments };
  } catch (err) {
    console.error('[review-comments] failed:', err.message);
    return { comments: [], error: err.message };
  }
});

// Get blame/annotation for a file to map lines to commits
ipcMain.handle('get-file-blame', async (event, { prNumber, filePath, repo }) => {
  prNumber = safePrNumber(prNumber);
  if (!prNumber) return { error: 'Invalid PR number' };
  const repoPath = getLocalRepoPath(repo);
  // Validate filePath: reject shell metacharacters (including double-quote)
  if (!filePath || /[;&|`$(){}!<>"\n]/.test(filePath)) {
    return { error: 'Invalid file path' };
  }
  try {
    const owner = (repo && repo.includes('/')) ? repo.split('/')[0] : (appConfig.repoOwner || 'webtoolbox');
    const repoName = (repo && repo.includes('/')) ? repo.split('/')[1] : (appConfig.repoName || 'Website-Toolbox');
    const headSha = await execPromise(
      `gh pr view ${prNumber} --repo ${owner}/${repoName} --json headRefOid --jq '.headRefOid'`
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

// Fetch the body of a named Perl subroutine or JS function from the repo at a
// given SHA, for the hover-preview popover in the diff view.
// ── Cross-codebase function/sub preview resolution ─────────────────────────────
// git grep / git show results are cached so repeated hovers over the same symbol
// (or over symbols in the same file) resolve instantly without re-running git.

const gitGrepCache = new Map();      // `${repoPath}|${tree}|${pattern}|F/E` -> string[] (file paths)
const fileContentCache = new Map();  // `${repoPath}|${tree}|${file}` -> content string | null

function runGitCapture(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

// `git grep -l <tree>` prefixes each line with `<tree>:`; strip it to get the path.
function stripTreePrefix(line, tree) {
  if (tree && line.startsWith(tree + ':')) return line.slice(tree.length + 1);
  const m = line.match(/^[0-9a-f]{7,40}:(.*)$/);
  return m ? m[1] : line;
}

function isSourceFile(p) {
  return /\.(pm|pl|cgi|t|psgi|plx|fcgi|js|jsx|ts|tsx|mjs|cjs)$/i.test(p);
}

async function grepFilePaths(repoPath, tree, pattern, fixed = false) {
  const key = `${repoPath}|${tree}|${pattern}|${fixed ? 'F' : 'E'}`;
  if (gitGrepCache.has(key)) return gitGrepCache.get(key);
  const args = ['grep', '-l', '--no-color'];
  if (fixed) args.push('-F', '-e', pattern);
  else args.push('-E', '-e', pattern);
  args.push(tree, '--');
  const r = await runGitCapture(repoPath, args);
  let paths = [];
  if (r.ok) {
    paths = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
      .map(s => stripTreePrefix(s, tree))
      .filter(isSourceFile);
  }
  gitGrepCache.set(key, paths);
  return paths;
}

async function readFileAtTree(repoPath, tree, file) {
  const key = `${repoPath}|${tree}|${file}`;
  if (fileContentCache.has(key)) return fileContentCache.get(key);
  const args = ['show', `${tree}:${file}`];
  const r = await runGitCapture(repoPath, args);
  const content = r.ok && r.stdout ? r.stdout : null;
  fileContentCache.set(key, content);
  return content;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A grep pattern that only matches DEFINITION lines (so call sites like
// `Module::sub(...)` don't match). JS pattern keeps to the common declaration
// forms (function decl, assignment, arrow, and object/class method shorthand);
// extractFunctionBody confirms and does the real extraction.
function defGrepPattern(lang, funcName) {
  const n = escapeRegex(funcName);
  if (lang === 'perl') return `^\\s*sub\\s+${n}\\b`;
  return `function\\s+${n}\\b|\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*=>)|\\b${n}\\s*\\([^)]*\\)\\s*\\{`;
}

// Extract parent class/module names a package inherits from, by reading its
// `our @ISA = qw(...)`, `use base qw(...)`, or `extends '...'` declarations.
function getParentPackages(content) {
  if (!content) return [];
  const parents = [];
  const addMatches = (re) => {
    let m;
    while ((m = re.exec(content)) !== null) {
      const s = m[1] || '';
      for (const p of s.matchAll(/[A-Za-z_]\w*(?:::\w+)+/g)) parents.push(p[0]);
    }
  };
  addMatches(/our\s+@ISA\s*=\s*\(?\s*qw\s*\(([^)]*)\)/g);
  addMatches(/use\s+base\s+\(?\s*qw\s*\(([^)]*)\)/g);
  addMatches(/\bextends\s+['"]([A-Za-z_]\w*(?:::\w+)+)['"]/g);
  return parents;
}

// Search a class's own package file(s) for funcName, walking the inheritance
// chain (parents via @ISA / use base / extends). Returns { code, file } or null.
async function findInClass(repoPath, tree, module, funcName, seen) {
  if (seen.has(module)) return null;
  seen.add(module);
  const pkgFiles = await grepFilePaths(repoPath, tree, `package ${module};`, true);
  for (const f of pkgFiles) {
    const content = await readFileAtTree(repoPath, tree, f);
    if (!content) continue;
    const body = extractFunctionBody(content, funcName);
    if (body) return { code: body, file: f };
    // Not defined here; search the parents this class inherits from.
    for (const parent of getParentPackages(content)) {
      const found = await findInClass(repoPath, tree, parent, funcName, seen);
      if (found) return found;
    }
  }
  return null;
}

// Resolve the definition of funcName across the repo. Tries each tree in order
// (PR head first, then master as a fallback). For a qualified Perl call the
// module's package file is searched first (following inheritance), so the
// correct sub wins; otherwise it greps the whole codebase and prefers the
// caller's own file. Returns { code, file, tree } or null.
async function resolveFunctionPreview(repoPath, trees, filePath, funcName, lang, module) {
  for (const tree of trees) {
    // 1) Qualified Perl call: locate the package file, look for the sub there.
    if (module) {
      const found = await findInClass(repoPath, tree, module, funcName, new Set());
      if (found) return { code: found.code, file: found.file, tree };
    }
    // 2) Codebase-wide search; prefer the caller's own file, then first match.
    const candidates = await grepFilePaths(repoPath, tree, defGrepPattern(lang, funcName));
    const ordered = candidates.slice().sort(
      (a, b) => (a === filePath ? -1 : 0) - (b === filePath ? -1 : 0)
    );
    for (const f of ordered) {
      const content = await readFileAtTree(repoPath, tree, f);
      const body = content ? extractFunctionBody(content, funcName) : null;
      if (body) return { code: body, file: f, tree };
    }
  }
  return null;
}

ipcMain.handle('get-function-preview', async (event, { filePath, funcName, module, lang, sha, repo }) => {
  if (!filePath || !funcName) return { error: 'Missing filePath or funcName' };
  // Validate filePath: reject shell metacharacters (including double-quote)
  if (/[;&|`$(){}!<>"\n]/.test(filePath)) return { error: 'Invalid file path' };
  const repoPath = getLocalRepoPath(repo);
  const cleanSha = String(sha || '').replace(/[^0-9a-f]/gi, '');
  // funcName must be a valid identifier to prevent regex injection into git grep.
  if (!/^[A-Za-z_][\w$]*$/.test(String(funcName))) return { error: 'Invalid function name' };
  const cleanLang = lang === 'perl' ? 'perl' : 'js';
  const cleanModule = String(module || '').replace(/[^A-Za-z0-9_:]/g, '');
  const trees = cleanSha ? [cleanSha, 'master'] : ['master'];
  try {
    const found = await resolveFunctionPreview(repoPath, trees, filePath, funcName, cleanLang, cleanModule);
    if (found) return { code: found.code, file: found.file };
    return { error: `Could not find ${funcName}` };
  } catch (err) {
    return { error: err.message };
  }
});

// Extract the source of a named Perl sub or JS function from file content.
// Returns the full definition including its signature and body (brace-balanced),
// or null if not found.
function extractFunctionBody(content, funcName) {
  if (!content) return null;
  const lines = content.split('\n');
  const nameRe = new RegExp(`\\bsub\\s+${funcName}\\b`);
  const jsFnRe = new RegExp(`(?:function\\s+|^\\s*${funcName}\\s*=\\s*(?:async\\s*)?function|\\b${funcName}\\s*(?::\\s*function|\\s*=\\s*\\([^)]*\\)\\s*=>|\\s*\\([^)]*\\)\\s*\\{))`);
  const isPerl = nameRe.test(content) || /\.(pm|pl|cgi|t|psgi)$/i.test(lines[0] || '') ? true : false;

  // Find the definition line
  let startLine = -1;
  const perlMatch = new RegExp(`^(\\s*sub\\s+${funcName}\\b)`);
  const jsMatch = new RegExp(`^(\\s*(?:async\\s+)?function\\s+${funcName}\\b)`);
  const jsAssignMatch = new RegExp(`^(\\s*${funcName}\\s*=\\s*(?:async\\s*)?(?:function|\\())`);
  const jsArrowMatch = new RegExp(`^(\\s*(?:const|let|var)\\s+${funcName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>)`);
  const jsMethodMatch = new RegExp(`^(\\s*${funcName}\\s*\\([^)]*\\)\\s*\\{)`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (perlMatch.test(line) || jsMatch.test(line) || jsAssignMatch.test(line) ||
        jsArrowMatch.test(line) || jsMethodMatch.test(line)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  // Determine the opening brace position on the start line
  let braceIdx = -1;
  const open = lines[startLine].indexOf('{');
  if (open !== -1) {
    braceIdx = open;
  } else {
    // Arrow function may not have a brace on the same line; find the next brace
    for (let j = startLine; j < lines.length; j++) {
      const o = lines[j].indexOf('{');
      if (o !== -1) { braceIdx = o; break; }
    }
  }
  if (braceIdx === -1) return null;

  // Collect from the start line, counting braces to find the matching close
  let depth = 0;
  const result = [];
  let inSingle = false, inDouble = false, inLineComment = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    let out = '';
    // Brace-balance, skipping braces inside strings/comments
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inLineComment) { out += ch; continue; }
      if (inSingle) { out += ch; if (ch === "'") { inSingle = false; if (line[c-1] !== '\\') { /* escape handled below */ } } continue; }
      if (inDouble) { out += ch; if (ch === '"' && line[c-1] !== '\\') inDouble = false; continue; }
      if (ch === "'") { inSingle = true; out += ch; continue; }
      if (ch === '"') { inDouble = true; out += ch; continue; }
      if (ch === '#') { inLineComment = true; out += ch; continue; }
      if (ch === '{') { depth++; out += ch; continue; }
      if (ch === '}') { depth--; out += ch; if (depth === 0) { result.push(out); return result.join('\n'); } continue; }
      out += ch;
    }
    result.push(out);
    inLineComment = false;
  }
  return result.join('\n');
}

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
  hermesProfile: appConfig.hermesProfile || 'wt',
  prFilter: appConfig.prFilter || {},
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
  autoFix: appConfig.autoFix || { enabled: false }
}));

ipcMain.handle('open-external', async (event, url) => {
  try {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { error: 'Invalid URL' };
  } catch (err) {
    log('ERROR', '[open-external] failed:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('save-preferences', async (event, prefs) => {
  try {
    // Deep merge into appConfig
    if (prefs.repoOwner !== undefined) appConfig.repoOwner = prefs.repoOwner;
    if (prefs.repoName !== undefined) appConfig.repoName = prefs.repoName;
    if (prefs.repoPath !== undefined) appConfig.repoPath = prefs.repoPath;
    if (prefs.aiCommand !== undefined) appConfig.aiCommand = prefs.aiCommand;
    if (prefs.aiTagPrefix !== undefined) appConfig.aiTagPrefix = prefs.aiTagPrefix;
    if (prefs.hermesProfile !== undefined) appConfig.hermesProfile = prefs.hermesProfile;
    if (prefs.editorCommand !== undefined) appConfig.editorCommand = prefs.editorCommand;
    if (prefs.contextLines !== undefined) appConfig.contextLines = prefs.contextLines;
    if (prefs.diff !== undefined) appConfig.diff = { ...(appConfig.diff || {}), ...prefs.diff };
    if (prefs.imageUpload !== undefined) appConfig.imageUpload = { ...(appConfig.imageUpload || {}), ...prefs.imageUpload };
    if (prefs.cleanup !== undefined) appConfig.cleanup = { ...(appConfig.cleanup || {}), ...prefs.cleanup };
    if (prefs.rules !== undefined) appConfig.rules = { ...(appConfig.rules || {}), ...prefs.rules };
    if (prefs.prFilter !== undefined) appConfig.prFilter = { ...(appConfig.prFilter || {}), ...prefs.prFilter };

    // Save to private config file
    const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
    const privateConfigPath = path.join(privateDir, 'config.json');
    fs.mkdirSync(privateDir, { recursive: true });
    atomicWriteFileSync(privateConfigPath, JSON.stringify(appConfig, null, 2));
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
        atomicWriteFileSync(privateConfigPath, JSON.stringify(appConfig, null, 2));
      } catch (err) { console.error('[autoDetectAgent] Failed to save detected agent config:', err.message); }
      return { detected: true, agent: agent.command };
    }
  }

  return { detected: false, agent: null };
});

// ===================== AUTO-UPDATE =====================

let autoUpdateInterval = null;
let lastUpdateCheck = 0;
let pendingUpdate = false;
let appFocused = true;

// Track app focus state
app.on('browser-window-focus', () => { appFocused = true; });
app.on('browser-window-blur', () => {
  // Only set unfocused if no windows are focused
  setTimeout(() => {
    const allWindows = BrowserWindow.getAllWindows();
    appFocused = allWindows.some(w => w.isFocused());
  }, 500);
});

// Apply pending update when app loses focus
function applyPendingUpdate() {
  if (!pendingUpdate || appFocused) return;
  pendingUpdate = false;
  console.log('[auto-update] App is idle, applying update...');
  const repoDir = app.getAppPath();
  exec('git pull origin main', { cwd: repoDir, timeout: 30000 }, (pullErr) => {
    if (pullErr) { console.error('[auto-update] pull failed:', pullErr.message); return; }
    exec('npm install', { cwd: repoDir, timeout: 120000 }, (installErr) => {
      if (installErr) { console.error('[auto-update] npm install failed:', installErr.message); return; }
      exec('npm run build', { cwd: repoDir, timeout: 300000 }, (buildErr) => {
        if (buildErr) { console.error('[auto-update] build failed:', buildErr.message); return; }
        console.log('[auto-update] Update complete! Restarting...');
        updateLastCheckTime();
        app.relaunch();
        app.exit(0);
      });
    });
  });
}

// Check for updates (fetch + compare, but don't install yet)
async function checkForUpdates() {
  try {
    const repoDir = app.getAppPath();
    const privateConfigPath = path.join(app.getPath('home'), '.config', 'pr-reviewer', 'config.json');

    // Check if auto-update is enabled
    let autoUpdateEnabled = true;
    try {
      const raw = fs.readFileSync(privateConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      autoUpdateEnabled = parsed.autoUpdate !== false;
    } catch (err) { console.warn('[checkForUpdates] Could not read auto-update setting (using default):', err.message); }

    if (!autoUpdateEnabled) return;

    // Check if more than 1 day since last check
    const ONE_DAY = 24 * 60 * 60 * 1000;
    try {
      const raw = fs.readFileSync(privateConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      lastUpdateCheck = parsed.lastUpdateCheck || 0;
    } catch (err) { console.warn('[checkForUpdates] Could not read last update check time:', err.message); }

    if (lastUpdateCheck && (Date.now() - lastUpdateCheck) < ONE_DAY) {
      return;
    }

    console.log('[auto-update] Checking for updates...');

    exec('git fetch origin main', { cwd: repoDir, timeout: 30000 }, (fetchErr) => {
      if (fetchErr) { console.error('[auto-update] fetch failed:', fetchErr.message); return; }

      exec('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }, (localErr, localSha) => {
        if (localErr) return;
        exec('git rev-parse origin/main', { cwd: repoDir, encoding: 'utf8' }, (remoteErr, remoteSha) => {
          if (remoteErr) return;
          updateLastCheckTime();

          if (localSha.trim() === remoteSha.trim()) {
            console.log('[auto-update] Already up to date');
            return;
          }

          console.log('[auto-update] Update available, waiting for idle...');
          pendingUpdate = true;
          applyPendingUpdate();
        });
      });
    });
  } catch (err) {
    console.error('[auto-update] error:', err.message);
  }
}

function updateLastCheckTime() {
  lastUpdateCheck = Date.now();
  try {
    const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
    const privateConfigPath = path.join(privateDir, 'config.json');
    let config = {};
    try {
      const raw = fs.readFileSync(privateConfigPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) { console.warn('[updateLastCheckTime] Could not read existing config (may be first run):', err.message); }
    config.lastUpdateCheck = lastUpdateCheck;
    fs.mkdirSync(privateDir, { recursive: true });
    atomicWriteFileSync(privateConfigPath, JSON.stringify(config, null, 2));
  } catch (err) { console.error('[updateLastCheckTime] Failed to save last update check time:', err.message); }
}

// Start auto-update check interval (every 6 hours)
function startAutoUpdate() {
  if (autoUpdateInterval) clearInterval(autoUpdateInterval);
  // Check immediately on startup
  checkForUpdates();
  // Then every 6 hours
  autoUpdateInterval = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

// Apply pending updates when app loses focus
app.on('browser-window-blur', () => {
  setTimeout(() => {
    if (!appFocused) applyPendingUpdate();
  }, 1000);
});

// IPC: manual update check
ipcMain.handle('check-update', async () => {
  try {
    const repoDir = app.getAppPath();
    const { stdout: localSha } = await new Promise((resolve, reject) => {
      exec('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(err); else resolve({ stdout, stderr });
      });
    });

    await new Promise((resolve, reject) => {
      exec('git fetch origin main', { cwd: repoDir, timeout: 30000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const { stdout: remoteSha } = await new Promise((resolve, reject) => {
      exec('git rev-parse origin/main', { cwd: repoDir, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(err); else resolve({ stdout, stderr });
      });
    });

    if (localSha.trim() === remoteSha.trim()) {
      return { upToDate: true };
    }

    // Get commit log between local and remote
    const { stdout: logOutput } = await new Promise((resolve, reject) => {
      exec(`git log HEAD..origin/main --oneline`, { cwd: repoDir, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(err); else resolve({ stdout, stderr });
      });
    });

    return { upToDate: false, commits: logOutput.trim() };
  } catch (err) {
    return { error: err.message };
  }
});

// IPC: apply update
ipcMain.handle('apply-update', async () => {
  try {
    const repoDir = app.getAppPath();

    await new Promise((resolve, reject) => {
      exec('git pull origin main', { cwd: repoDir, timeout: 30000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      exec('npm install', { cwd: repoDir, timeout: 120000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    await new Promise((resolve, reject) => {
      exec('npm run build', { cwd: repoDir, timeout: 300000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    updateLastCheckTime();

    // Restart the app
    app.relaunch();
    app.exit(0);
    // Note: code after app.exit() is unreachable
  } catch (err) {
    return { error: err.message };
  }
});

// IPC: toggle auto-update
ipcMain.handle('set-auto-update', async (event, enabled) => {
  try {
    const privateDir = path.join(app.getPath('home'), '.config', 'pr-reviewer');
    const privateConfigPath = path.join(privateDir, 'config.json');
    let config = {};
    try {
      const raw = fs.readFileSync(privateConfigPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) { console.warn('[set-auto-update] Could not read existing config (may be first run):', err.message); }
    config.autoUpdate = enabled;
    fs.mkdirSync(privateDir, { recursive: true });
    atomicWriteFileSync(privateConfigPath, JSON.stringify(config, null, 2));

    if (enabled) {
      startAutoUpdate();
    } else if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
      autoUpdateInterval = null;
    }

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Start auto-update when app is ready
app.whenReady().then(() => {
  startAutoUpdate();
});

// Open file in editor at specific line
ipcMain.handle('open-file-in-editor', async (event, { filePath, line }) => {
  const editor = appConfig.editorCommand || 'code';
  const repoPath = appConfig.repoPath || '';
  const fullPath = repoPath ? path.join(repoPath, filePath) : filePath;

  console.log(`[editor] Opening ${fullPath} at line ${line} with ${editor}`);

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

// Get AGENTS.md and referenced rules files from the local repo
ipcMain.handle('get-agent-rules', async () => {
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  if (!owner || !repo) return { error: 'No repo configured' };

  const repoPath = getLocalRepoPath(`${owner}/${repo}`);
  if (!repoPath) return { error: 'No local repo path found' };

  try {
    // Read AGENTS.md from local repo
    const agentsPath = path.join(repoPath, 'AGENTS.md');
    let agentsMd = '';
    try {
      agentsMd = fs.readFileSync(agentsPath, 'utf8');
    } catch (err) {
      log('WARN', '[get-agents-md] AGENTS.md not found locally:', agentsPath);
      // Fallback to gh api
      try {
        agentsMd = await execPromise(
          `gh api repos/${owner}/${repo}/contents/AGENTS.md --jq .content | base64 -d`
        );
      } catch { /* not found */ }
    }

    // Find and read referenced rules files (.github/instructions/*.md, etc.)
    const referencedFiles = [];
    const instructionsDir = path.join(repoPath, '.github', 'instructions');
    try {
      const files = fs.readdirSync(instructionsDir);
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.instructions.md')) {
          try {
            const content = fs.readFileSync(path.join(instructionsDir, file), 'utf8');
            referencedFiles.push({ path: `.github/instructions/${file}`, content });
          } catch {}
        }
      }
      log('INFO', `[get-agents-md] Found ${referencedFiles.length} instruction files in .github/instructions/`);
    } catch {
      log('INFO', '[get-agents-md] No .github/instructions/ directory found');
    }

    // Also check AGENTS.md for explicit references to other files
    const fileRefs = agentsMd.match(/(?:\.github\/instructions\/[\w.-]+\.md|\.github\/[\w.-]+\.md)/g) || [];
    const uniqueRefs = [...new Set(fileRefs)];
    for (const ref of uniqueRefs) {
      if (referencedFiles.some(f => f.path === ref)) continue; // Already loaded
      try {
        const content = fs.readFileSync(path.join(repoPath, ref), 'utf8');
        referencedFiles.push({ path: ref, content });
      } catch {}
    }

    return { agentsMd, referencedFiles };
  } catch (err) {
    return { error: err.message };
  }
});

// Analyze review feedback against existing rules and propose new ones
ipcMain.handle('propose-rules', async (event, { feedback, agentsMd, referencedFiles }) => {
  const rulesConfig = appConfig.rules || {};
  if (!rulesConfig.enabled) return { proposals: [], disabled: true };
  
  const aiCmd = rulesConfig.aiCommand || appConfig.aiCommand || 'hermes';
  const owner = appConfig.repoOwner;
  const repo = appConfig.repoName;
  
  const feedbackText = feedback.map(f => `- [${f.file}${f.line ? ` line ${f.line}` : ''}] ${f.text}`).join('\n');
  
  // Build the referenced files section
  let referencedFilesText = '';
  const availableFiles = ['AGENTS.md'];
  if (referencedFiles && referencedFiles.length > 0) {
    referencedFilesText = '\nReferenced rules files:\n';
    for (const file of referencedFiles) {
      referencedFilesText += `\n--- ${file.path} ---\n${file.content}\n`;
      availableFiles.push(file.path);
    }
  }

  const prompt = `You are analyzing code review feedback to propose new agent rules for the ${owner}/${repo} repository.

AGENTS.md content:
${agentsMd}
${referencedFilesText}
REVIEW FEEDBACK:
${feedbackText}

Analyze the feedback. For each piece of feedback:
1. Determine whether an existing rule ALREADY explicitly and unambiguously prevents this exact issue.
   - If NO existing rule covers it, propose a NEW brief, generalized rule.
   - If an existing rule is too vague, too narrow, or only partially covers it, propose a MODIFICATION of that rule (type: "modify") that strengthens/generalizes it enough to prevent the feedback. A rule you can interpret either way is NOT sufficient coverage.
2. Recommend which file it belongs in (AGENTS.md for general rules, or the appropriate referenced file for language-specific rules).
3. Rules must be GENERALIZED — they must prevent the whole class of issue, not just this one PR. Avoid naming specific files, functions, or line numbers. Avoid describing a single specific situation (e.g. a method used in a condition and again in its output); capture the underlying principle instead.

IMPORTANT: Your entire response MUST be ONLY a valid JSON object. No markdown, no explanation, no text before or after. Just the raw JSON object:
{"proposedRules": [{"rule": "...", "file": "path/to/file.md", "reason": "brief reason", "type": "new", "existingRule": ""}], "availableFiles": ["AGENTS.md", ".github/instructions/perl.instructions.md", ...]}

- \`type\` is "new" for a brand-new rule, or "modify" to change an existing rule. For "modify", \`existingRule\` must contain the EXACT current text of the rule being replaced, and \`rule\` must be the replacement text.
- If all feedback is already fully covered by explicit rules, return: {"proposedRules": [], "availableFiles": [...]}
Rules should be generalized, not specific to this one PR.
Keep rules concise — one sentence each when possible.`;

  return new Promise((resolve) => {
    // -Q (quiet) suppresses hermes' banner and box-drawing UI so the response is
    // the raw JSON the prompt asks for — no border pipes or chrome to strip.
    const args = ['chat', '-p', rulesConfig.aiProfile || appConfig.hermesProfile || 'wt', '-q', prompt, '-Q'];
    const proc = require('child_process').execFile(aiCmd, args, { timeout: 60000 }, (err, stdout) => {
      if (err) { log('ERROR', '[propose-rules] AI command failed:', err.message); resolve({ proposals: [], availableFiles, error: err.message }); return; }
      log('INFO', '[propose-rules] AI response received, length:', stdout.length, 'chars');
      log('INFO', '[propose-rules] Raw response (first 500):', stdout.substring(0, 500));
      try {
        // The response should be a single JSON object. Clean any hermes
        // chrome (warning banners, box-drawing UI) first, then parse directly.
        const source = cleanHermesResponse(stdout) || stdout;
        let parsed = null;

        // Strategy 1: the whole cleaned response is the JSON object.
        try { parsed = JSON.parse(source); } catch {}

        // Strategy 2 (defensive): if extra text wrapped the JSON, extract the
        // first {...} object by brace matching and parse it.
        if (!parsed) {
          const start = source.indexOf('{');
          if (start !== -1) {
            let depth = 0;
            for (let i = start; i < source.length; i++) {
              if (source[i] === '{') depth++;
              else if (source[i] === '}') { depth--; if (depth === 0) {
                const candidate = source.substring(start, i + 1);
                try { parsed = JSON.parse(candidate); } catch {}
                break;
              }}
            }
          }
        }

        if (parsed) {
          log('INFO', '[propose-rules] AI returned', (parsed.proposedRules || []).length, 'proposals');
          resolve({ proposals: parsed.proposedRules || [], availableFiles: parsed.availableFiles || availableFiles });
        } else {
          log('ERROR', '[propose-rules] Failed to parse AI response. Raw output:', stdout.substring(0, 500));
          resolve({ proposals: [], availableFiles, error: 'Failed to parse AI response' });
        }
      } catch (e) {
        log('ERROR', '[propose-rules] Parse error:', e.message, 'Raw output:', stdout.substring(0, 500));
        resolve({ proposals: [], availableFiles, error: 'Failed to parse AI response' });
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
    byFile[r.file].push(r);
  }
  
  for (const [file, newRules] of Object.entries(byFile)) {
    try {
      // Fetch current content
      let current = '';
      try {
        current = await execPromise(
          `gh api repos/${owner}/${repo}/contents/${file} --jq .content | base64 -d`
        );
      } catch (err) { console.warn(`[propose-rules] Existing rules file ${file} not found or unreadable:`, err.message); }
      
      // Apply each rule: "modify" replaces existingRule text in place; "new" appends
      let updated = current;
      const additions = [];
      for (const r of newRules) {
        if (r.type === 'modify' && r.existingRule) {
          const idx = updated.indexOf(r.existingRule);
          if (idx !== -1) {
            updated = updated.slice(0, idx) + r.rule + updated.slice(idx + r.existingRule.length);
          } else {
            // existingRule text not found — fall back to appending
            additions.push(r.rule);
          }
        } else {
          additions.push(r.rule);
        }
      }
      if (additions.length > 0) {
        const sep = updated.length && !updated.endsWith('\n') ? '\n' : '';
        updated = updated.trimEnd() + sep + additions.map(a => `- ${a}`).join('\n') + '\n';
      }
      
      // Get SHA for update
      let sha = '';
      try {
        sha = await execPromise(
          `gh api repos/${owner}/${repo}/contents/${file} --jq .sha`
        );
      } catch (err) { console.warn(`[propose-rules] Could not get SHA for ${file} (may be new file):`, err.message); }
      
      const payload = JSON.stringify({
        message: `Add review-derived rules to ${file}`,
        content: Buffer.from(updated).toString('base64'),
        ...(sha ? { sha } : {})
      });
      
      const rulesTmpPath = path.join(getGeneratedDir(), `rules-payload-${Date.now()}.json`);
      fs.writeFileSync(rulesTmpPath, payload);
      try {
        await execPromise(
          `gh api repos/${owner}/${repo}/contents/${file} --method PUT --input "${rulesTmpPath}"`
        );
      } finally {
        try { fs.unlinkSync(rulesTmpPath); } catch (e) { console.warn('[propose-rules] Failed to clean up temp rules file:', e.message); }
      }

      // Best-effort sync: update the local working copy of this file from origin
      // so the change is visible in the user's checkout, not just on GitHub.
      // Only do this if the local repo is ON master (never a feature branch) and
      // the local file is clean (no uncommitted edits), so we never clobber
      // in-progress work or inject master changes into another branch.
      try {
        const localRepo = getLocalRepoPath(`${owner}/${repo}`);
        if (fs.existsSync(localRepo)) {
          const branch = await execPromise(`git -C "${localRepo}" rev-parse --abbrev-ref HEAD`).catch(() => '');
          const isMaster = branch.trim() === 'master' || branch.trim() === 'main';
          if (!isMaster) {
            log('INFO', `[propose-rules] Skipped local sync for ${file} (repo on branch ${branch.trim() || 'unknown'}, not master)`);
          } else {
            const status = await execPromise(`git -C "${localRepo}" status --porcelain -- "${file}"`).catch(() => '');
            if (!status.trim()) {
              await execPromise(`git -C "${localRepo}" fetch origin master --quiet`).catch(() => {});
              const updatedContent = await execPromise(`git -C "${localRepo}" show "origin/master:${file}"`).catch(() => '');
              if (updatedContent) {
                const abs = path.join(localRepo, file);
                fs.writeFileSync(abs, updatedContent);
                log('INFO', `[propose-rules] Updated local file ${file} in ${localRepo}`);
              }
            } else {
              log('INFO', `[propose-rules] Skipped local sync for ${file} (has uncommitted changes)`);
            }
          }
        }
      } catch (localErr) {
        log('WARN', '[propose-rules] Local file sync failed:', localErr.message);
      }

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
      // Use boundary-aware matching to avoid PR #1 matching PR #10, #100, etc.
      if (f.includes(`-${prNumber}-`) || f === `pr-${prNumber}-clean.diff` || f.startsWith(`pr-${prNumber}-`)) {
        fs.unlinkSync(path.join(generatedDir, f));
        deleted++;
      }
    }
  } catch (err) { console.warn('[cleanup-pr-files] Failed to clean generated files:', err.message); }
  
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
      } catch (e) { console.warn('[cleanup-pr-files] Failed to read/parse draft file:', f, e.message); }
    }
  } catch (err) { console.warn('[cleanup-pr-files] Failed to read drafts directory:', err.message); }
  
  return { deleted };
});

// Get next PR to review from the list
ipcMain.handle('get-next-pr', async (event, { prNumber: currentPrNumber, repo: repoKey } = {}) => {
  try {
    const safeCurrentPr = safePrNumber(currentPrNumber);
    let owner, repo;
    if (repoKey && repoKey.includes('/')) {
      [owner, repo] = repoKey.split('/');
    } else {
      owner = appConfig.repoOwner;
      repo = appConfig.repoName;
    }
    if (!owner || !repo) {
      return { error: 'repoOwner and repoName must be configured' };
    }
    const filter = appConfig.prFilter || {};
    
    let cmd = `gh pr list --repo ${owner}/${repo} --state open --json number,title,author,createdAt,headRefName,isDraft`;
    
    const output = await execPromise(cmd);
    let prs = JSON.parse(output);
    
    if (filter.reviewRequested) {
      // Use gh search to filter server-side (single API call instead of N+1)
      const viewer = await execPromise('gh api user --jq .login');
      try {
        const searchCmd = `gh search prs --repo ${owner}/${repo} --state open --review-requested ${viewer.trim()} --json number --limit 100`;
        const searchOutput = await execPromise(searchCmd, { timeout: 15000 });
        const reviewPrNumbers = new Set(JSON.parse(searchOutput || '[]').map(r => r.number));
        prs = prs.filter(pr => reviewPrNumbers.has(pr.number));
      } catch {
        // If search fails, fall back to showing all PRs
        log('WARN', '[get-next-pr] review-requested search failed, showing all PRs');
      }
    }
    
    if (filter.excludeTitleStartsWith && filter.excludeTitleStartsWith.length) {
      const prefixes = filter.excludeTitleStartsWith.map(p => p.toLowerCase());
      prs = prs.filter(pr => {
        const title = (pr.title || '').toLowerCase();
        return !prefixes.some(p => title.startsWith(p));
      });
    }
    if (filter.titleContains) {
      const needle = filter.titleContains.toLowerCase();
      prs = prs.filter(pr => (pr.title || '').toLowerCase().includes(needle));
    }
    
    // Find next PR after current
    const currentIdx = prs.findIndex(pr => String(pr.number) === safeCurrentPr);
    if (currentIdx >= 0 && currentIdx < prs.length - 1) {
      return { pr: prs[currentIdx + 1] };
    } else if (prs.length > 0 && String(prs[0].number) !== safeCurrentPr) {
      return { pr: prs[0] };
    }
    
    return { pr: null };
  } catch (err) {
    return { error: err.message };
  }
});

// Expand diff context for a single file
ipcMain.handle('expand-diff-context', async (event, { repoPath, filePath, contextLines, baseSha, headSha, sinceReviewRef } = {}) => {
  try {
    // Validate inputs to prevent shell injection
    const ctxLines = parseInt(contextLines, 10);
    if (isNaN(ctxLines) || ctxLines < 0 || ctxLines > 9999) {
      return { error: 'Invalid contextLines value', content: '' };
    }
    if (!filePath || /[;&|`$(){}!<>"]/.test(filePath)) {
      return { error: 'Invalid file path', content: '' };
    }
    // Use the same range as the displayed since-review diff when available.
    // A since-review diff is computed by replaying only the PR's own commits
    // onto the review base (see computeSinceReviewNetDiff); expanding a file
    // must diff against that same rebased base, otherwise the extra lines come
    // from a different range (e.g. master merges) and don't match what's on
    // screen. When no since-review ref exists, fall back to the historical
    // 3-dot (merge-base) then 2-dot ranges.
    let diffOut = '';
    if (sinceReviewRef && baseSha) {
      const cmdSince = `git diff ${baseSha} ${sinceReviewRef} -U${ctxLines} -- "${filePath}"`;
      log('INFO', '[expand-diff-context] Using since-review range:', cmdSince);
      try {
        diffOut = await execPromise(cmdSince, { cwd: repoPath, timeout: 15000 });
      } catch (e) {
        log('WARN', '[expand-diff-context] since-review range failed:', e.message);
      }
    }
    if (!diffOut && headSha) {
      try {
        const cmd3 = `git diff origin/master...${headSha} -U${ctxLines} -- "${filePath}"`;
        log('INFO', '[expand-diff-context] Trying 3-dot:', cmd3);
        diffOut = await execPromise(cmd3, { cwd: repoPath, timeout: 15000 });
        log('INFO', '[expand-diff-context] 3-dot got', diffOut.length, 'chars');
      } catch (e) {
        log('INFO', '[expand-diff-context] 3-dot failed, falling back to 2-dot:', e.message);
      }
    }
    if (!diffOut) {
      const range = (baseSha && headSha) ? `${baseSha}..${headSha} ` : '';
      const cmd2 = `git diff ${range}-U${ctxLines} -- "${filePath}"`;
      log('INFO', '[expand-diff-context] Trying 2-dot:', cmd2);
      diffOut = await execPromise(cmd2, { cwd: repoPath, timeout: 15000 });
      log('INFO', '[expand-diff-context] 2-dot got', diffOut.length, 'chars');
    }
    return { content: diffOut };
  } catch (err) {
    log('ERROR', '[expand-diff-context] failed:', err.message);
    return { error: err.message, content: '' };
  }
});
