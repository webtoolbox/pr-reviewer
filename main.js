const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let mainWindow;

// Load config from config.json
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const defaults = {
    aiCommand: 'hermes',
    aiSendArgs: ['send', '--to'],
    aiChatId: null,
    aiTagPrefix: '@Hermes',
    reviewSaveDir: '~/.hermes/profiles/wt/diff-reviews/pending'
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

// Filter out our flags to leave positional args (diff file path) intact
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

// Expand ~ in paths
function expandPath(p) {
  if (p && p.startsWith('~')) {
    return path.join(app.getPath('home'), p.slice(1));
  }
  return p;
}

// Draft management — auto-save drafts keyed by diff file path
function getDraftPath(diffFilePath) {
  const draftDir = expandPath(path.join(appConfig.reviewSaveDir, '..', 'drafts'));
  fs.mkdirSync(draftDir, { recursive: true });
  // Use a hash of the file path as the draft filename
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

  // If a diff file was passed as argument, load it
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

// Handle file open dialog
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

// Auto-save draft (called on every comment change)
ipcMain.handle('save-draft', async (event, { filePath, draft }) => {
  return saveDraft(filePath, draft);
});

// Load draft for a given diff file
ipcMain.handle('load-draft', async (event, filePath) => {
  return loadDraft(filePath);
});

// Delete draft (called after successful final submit)
ipcMain.handle('delete-draft', async (event, filePath) => {
  deleteDraft(filePath);
  return true;
});

// Handle saving review (final submit)
ipcMain.handle('save-review', async (event, review) => {
  // Filter out @Hermes-tagged comments — those are sent to AI, not included in PR review
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

  // Send each @Hermes comment to the AI agent (with full context)
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

  // Save review with only PR comments
  const reviewToSave = { ...review, comments: prComments };
  const reviewDir = expandPath(appConfig.reviewSaveDir);
  fs.mkdirSync(reviewDir, { recursive: true });
  const filename = `review-${Date.now()}.json`;
  const outputPath = path.join(reviewDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(reviewToSave, null, 2));

  // Delete the draft since review is submitted
  if (review.filePath) {
    deleteDraft(review.filePath);
  }

  // Send notification
  const prNum = review.prNumber || cliPrNumber;
  const prCount = prComments.length;
  const aiCount = aiComments.length;
  let summary = `Review submitted for PR #${prNum || '?'}: ${review.type}`;
  if (prCount > 0) summary += ` with ${prCount} line comment${prCount !== 1 ? 's' : ''}`;
  if (aiCount > 0) summary += ` (${aiCount} sent to AI)`;
  sendAiMessage(summary);

  return outputPath;
});

// Expose config to renderer
ipcMain.handle('get-config', async () => ({
  chatId: aiChatId,
  prNumber: cliPrNumber,
  aiTagPrefix: appConfig.aiTagPrefix || '@Hermes',
  aiCommand: appConfig.aiCommand
}));

// Export review as markdown file
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
