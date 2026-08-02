// Forward renderer console to main process log file
(() => {
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of ['log', 'warn', 'error', 'info']) {
    console[level] = (...args) => {
      orig[level](...args);
      try {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        window.electronAPI?.rendererLog(level.toUpperCase(), msg);
      } catch {}
    };
  }
})();

// State
let appConfig = {}; // Config from main process (repoOwner, repoName, etc.)
let currentDiff = '';
let currentFileName = '';
let currentFilePath = '';
let comments = []; // { _uid, file, line, side, text, isAiTagged, level, codeContext, imageDataUrl }
let commentTarget = null; // { file, line, side, element, level, codeContext }
let parsedDiff = null;
let aiTagPrefix = '@Hermes';
// Helper to strip AI tag prefix from comment text (handles both @ask and @Hermes)
function stripAiTag(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('@ask')) return text.slice(4).trim();
  if (lower.startsWith(aiTagPrefix.toLowerCase())) return text.slice(aiTagPrefix.length).trim();
  return text;
}
function getAiTagLabel(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('@ask')) return '<span class="ai-tag">@ask</span> ';
  if (lower.startsWith(aiTagPrefix.toLowerCase())) return `<span class="ai-tag">${escapeHtml(aiTagPrefix)}</span> `;
  return '';
}
let fileCommentCounts = {};
let currentCommentIndex = -1; // For batch navigation
let commentUidCounter = 0; // Unique ID counter for stable comment references
let collaborators = []; // GitHub collaborators for @mentions

// DOM elements
const diffContainer = document.getElementById('diff-container');
const emptyState = document.getElementById('empty-state');
const prInfo = document.getElementById('pr-info');
const reviewBodyContainer = document.getElementById('review-body-container');
const reviewBody = document.getElementById('review-body');
const btnApprove = document.getElementById('btn-approve');
const btnRequestChanges = document.getElementById('btn-request-changes');
const btnComment = document.getElementById('btn-comment');
const btnOpen = document.getElementById('btn-open');
const commentNav = document.getElementById('comment-nav');
const commentNavLabel = document.getElementById('comment-nav-label');
const btnPrevComment = document.getElementById('btn-prev-comment');
const btnNextComment = document.getElementById('btn-next-comment');
const prNumberInput = document.getElementById('pr-number');
const prNumberWrapper = document.getElementById('pr-number-wrapper');
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarList = document.getElementById('file-sidebar-list');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const contentDiv = document.getElementById('content');

// ===================== FILE SIDEBAR =====================

function populateFileSidebar() {
  if (!diffContainer || !fileSidebarList) return;
  fileSidebarList.innerHTML = '';

  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  if (fileWrappers.length === 0) return;

  // Parse diff content to determine file status from --git headers
  const fileStatusMap = {}; // fileName -> { status, additions, deletions }
  if (currentDiff) {
    const diffLines = currentDiff.split('\n');
    for (const line of diffLines) {
      if (!line.startsWith('diff --git ')) continue;
      // Parse: diff --git a/path/to/file b/path/to/file
      const gitMatch = line.match(/diff --git (.+?) (.+)/);
      if (!gitMatch) continue;
      const aPath = gitMatch[1];
      const bPath = gitMatch[2];
      // Strip a/ and b/ prefixes
      const aName = aPath.startsWith('a/') ? aPath.slice(2) : aPath;
      const bName = bPath.startsWith('b/') ? bPath.slice(2) : bPath;
      const hasA = aPath.startsWith('a/') && aPath !== 'a/dev/null';
      const hasB = bPath.startsWith('b/') && bPath !== 'b/dev/null';

      let status = 'modified';
      if (hasA && !hasB) {
        status = 'removed';
      } else if (!hasA && hasB) {
        status = 'added';
      } else if (aName !== bName) {
        status = 'renamed';
      }
      fileStatusMap[bName] = { status };
    }
  }

  // Collect file info from wrappers
  const files = [];
  fileWrappers.forEach((wrapper, index) => {
    const nameEl = wrapper.querySelector('.d2h-file-name');
    if (!nameEl) return;
    const fileName = nameEl.textContent.trim();
    // NOTE: Do NOT skip filtered-out extensions here. The sidebar lists every
    // file in the diff (regardless of the extension filter) so the user can see
    // all files changed and toggle them. The extension filter only collapses the
    // corresponding wrappers in the main diff area.

    // Extract +/- counts
    const header = wrapper.querySelector('.d2h-file-header');
    let additions = 0, deletions = 0;
    if (header) {
      const addedEl = header.querySelector('.d2h-tag.d2h-added-tag, .d2h-added-tag');
      const deletedEl = header.querySelector('.d2h-tag.d2h-deleted-tag, .d2h-deleted-tag');
      const changedEl = header.querySelector('.d2h-tag.d2h-changed-tag, .d2h-changed-tag');
      if (addedEl) additions = parseInt(addedEl.textContent.replace(/[^0-9]/g, ''), 10) || 0;
      if (deletedEl) deletions = parseInt(deletedEl.textContent.replace(/[^0-9]/g, ''), 10) || 0;
      if (changedEl) {
        const changed = parseInt(changedEl.textContent.replace(/[^0-9]/g, ''), 10) || 0;
        additions += changed;
      }
    }

    const statusInfo = fileStatusMap[fileName] || { status: 'modified' };

    files.push({
      name: fileName,
      index,
      status: statusInfo.status,
      additions,
      deletions,
      wrapper
    });
  });

  // Build folder tree from flat file list
  const tree = {}; // { folderName: { _files: [], _children: {} } }
  for (const file of files) {
    const parts = file.name.split('/');
    const fileName = parts.pop();
    let target = tree;

    // Navigate/create folder hierarchy, then add file to the deepest folder node
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!target[part]) target[part] = { _files: [], _children: {} };
      // Navigate to _children for intermediate folders, stay on folder node for the last
      target = (i < parts.length - 1) ? target[part]._children : target[part];
    }
    target._files = target._files || [];
    target._files.push({ ...file, displayName: fileName });
  }

  // Build tree recursively and render
  function renderTree(node, container, depth) {
    const entries = Object.keys(node).sort();
    for (const key of entries) {
      const group = node[key];
      if (key === '_files') continue;

      const folderEl = document.createElement('div');
      folderEl.className = 'sidebar-folder-group';

      const allFiles = collectFiles(group);
      const folderRow = document.createElement('div');
      folderRow.className = 'sidebar-folder-row';
      folderRow.style.paddingLeft = (8 + depth * 12) + 'px';

      const toggle = document.createElement('span');
      toggle.className = 'sidebar-folder-toggle';
      toggle.textContent = '▾';

      const folderIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      folderIcon.setAttribute('class', 'sidebar-folder-icon');
      folderIcon.setAttribute('viewBox', '0 0 16 16');
      folderIcon.innerHTML = '<path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/>';

      const folderName = document.createElement('span');
      folderName.className = 'sidebar-folder-name';
      folderName.textContent = key;

      const fileCount = document.createElement('span');
      fileCount.className = 'sidebar-folder-count';
      fileCount.textContent = allFiles.length;

      folderRow.appendChild(toggle);
      folderRow.appendChild(folderIcon);
      folderRow.appendChild(folderName);
      folderRow.appendChild(fileCount);

      const filesContainer = document.createElement('div');
      filesContainer.className = 'sidebar-folder-files';

      // Render files in this folder
      if (group._files) {
        for (const file of group._files) {
          filesContainer.appendChild(createFileRow(file, depth + 1));
        }
      }

      // Recursively render sub-folders
      if (Object.keys(group._children || {}).length > 0) {
        renderTree(group._children, filesContainer, depth + 1);
      }

      // Toggle expand/collapse
      let expanded = true;
      folderRow.addEventListener('click', () => {
        expanded = !expanded;
        toggle.textContent = expanded ? '▾' : '▸';
        toggle.classList.toggle('collapsed', !expanded);
        filesContainer.style.display = expanded ? 'block' : 'none';
      });

      folderEl.appendChild(folderRow);
      folderEl.appendChild(filesContainer);
      container.appendChild(folderEl);
    }
  }

  function createFileRow(file, depth) {
    const row = document.createElement('div');
    row.className = 'sidebar-file-row';
    row.dataset.fileIndex = file.index;
    row.title = file.name;
    row.style.paddingLeft = (8 + depth * 12) + 'px';

    // Status icon
    const statusIcon = document.createElement('span');
    statusIcon.className = 'file-status-icon ' + file.status;
    switch (file.status) {
      case 'added': statusIcon.textContent = '+'; break;
      case 'removed': statusIcon.textContent = '−'; break;
      case 'modified': statusIcon.textContent = '■'; break;
      case 'renamed': statusIcon.textContent = '±'; break;
      default: statusIcon.textContent = '■'; break;
    }

    // File name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file.displayName;

    row.appendChild(statusIcon);
    row.appendChild(nameSpan);

    // Counts
    if (file.additions > 0 || file.deletions > 0) {
      const countsSpan = document.createElement('span');
      countsSpan.className = 'file-counts';
      if (file.additions > 0) {
        const addSpan = document.createElement('span');
        addSpan.className = 'additions';
        addSpan.textContent = '+' + file.additions;
        countsSpan.appendChild(addSpan);
      }
      if (file.deletions > 0) {
        const delSpan = document.createElement('span');
        delSpan.className = 'deletions';
        delSpan.textContent = '−' + file.deletions;
        countsSpan.appendChild(delSpan);
      }
      row.appendChild(countsSpan);
    }

    // Click handler - scroll to file
    row.addEventListener('click', () => {
      // Find wrapper by matching file name (more reliable than index after filtering)
      const allWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
      let wrapper = null;
      for (const w of allWrappers) {
        const nameEl = w.querySelector('.d2h-file-name');
        if (nameEl && nameEl.textContent.trim() === file.name.trim()) {
          wrapper = w;
          break;
        }
      }
      if (!wrapper) {
        // Fallback: use index
        wrapper = allWrappers[file.index];
      }
      if (!wrapper) return;
      const hdr = wrapper.querySelector('.d2h-file-header');
      const target = hdr || wrapper;
      // Use scrollIntoView which works regardless of which ancestor is the scroll container
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Highlight active
      fileSidebarList.querySelectorAll('.sidebar-file-row, .sidebar-file-item').forEach(el => el.classList.remove('active'));
      row.classList.add('active');
    });

    return row;
  }

  function collectFiles(node) {
    const result = [];
    if (node._files) result.push(...node._files);
    for (const key of Object.keys(node._children || {})) {
      result.push(...collectFiles(node._children[key]));
    }
    return result;
  }

  renderTree(tree, fileSidebarList, 0);

  // Remove the original file list from diff container
  const fileListWrapper = diffContainer.querySelector('.d2h-file-list-wrapper');
  if (fileListWrapper) fileListWrapper.remove();

  // Show sidebar
  fileSidebar.style.display = 'block';
  contentDiv.classList.add('diff-loaded');

  // Set up filter input (only once — use a flag to avoid duplicate listeners)
  const filterInput = document.getElementById('file-sidebar-filter');
  if (filterInput && !filterInput._sidebarFilterBound) {
    filterInput.value = '';
    filterInput._sidebarFilterBound = true;
    filterInput.addEventListener('input', () => {
      const query = filterInput.value.toLowerCase().trim();
      const allFileRows = fileSidebarList.querySelectorAll('.sidebar-file-row');
      const allFolderGroups = fileSidebarList.querySelectorAll('.sidebar-folder-group');

      if (!query) {
        // Show everything
        allFileRows.forEach(row => row.style.display = '');
        allFolderGroups.forEach(g => {
          g.style.display = '';
          const filesContainer = g.querySelector('.sidebar-folder-files');
          if (filesContainer) filesContainer.style.display = '';
        });
        return;
      }

      // Hide all folders first
      allFolderGroups.forEach(g => g.style.display = 'none');

      // Show files matching query and their parent folders
      allFileRows.forEach(row => {
        const fileName = (row.title || '').toLowerCase();
        if (fileName.includes(query)) {
          row.style.display = '';
          // Show parent folder
          let parent = row.parentElement;
          while (parent && parent !== fileSidebarList) {
            if (parent.classList && parent.classList.contains('sidebar-folder-group')) {
              parent.style.display = '';
              const filesContainer = parent.querySelector('.sidebar-folder-files');
              if (filesContainer) filesContainer.style.display = '';
            }
            parent = parent.parentElement;
          }
        } else {
          row.style.display = 'none';
        }
      });
    });
  }
}

function hideFileSidebar() {
  if (fileSidebar) fileSidebar.style.display = 'none';
  contentDiv.classList.remove('diff-loaded');
}

// Sidebar toggle handler
if (btnToggleSidebar && fileSidebar) {
  btnToggleSidebar.addEventListener('click', () => {
    const collapsed = fileSidebar.classList.contains('collapsed');
    if (collapsed) {
      fileSidebar.classList.remove('collapsed');
      btnToggleSidebar.textContent = '◀';
    } else {
      fileSidebar.classList.add('collapsed');
      btnToggleSidebar.textContent = '▶';
    }
  });
}

// ===================== AUTO-SAVE =====================

let saveTimeout = null;
// Persist unsent comments to localStorage
function saveCommentsToStorage() {
  try {
    const prKey = currentPrNumber ? `pr-reviewer-comments-${currentPrNumber}` : null;
    if (!prKey) return;
    // Strip non-serializable fields (DOM elements, imageDataUrl can be large)
    const serializable = comments.map(c => ({
      _uid: c._uid, file: c.file, line: c.line, side: c.side,
      text: c.text, isAiTagged: c.isAiTagged, level: c.level,
      codeContext: c.codeContext, imageDataUrl: c.imageDataUrl
    }));
    localStorage.setItem(prKey, JSON.stringify(serializable));
  } catch {}
}

// Restore unsent comments from localStorage
function loadCommentsFromStorage() {
  try {
    const prKey = currentPrNumber ? `pr-reviewer-comments-${currentPrNumber}` : null;
    if (!prKey) return [];
    const stored = localStorage.getItem(prKey);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

// Clear persisted comments (after successful submission)
function clearCommentsFromStorage() {
  try {
    const prKey = currentPrNumber ? `pr-reviewer-comments-${currentPrNumber}` : null;
    if (prKey) localStorage.removeItem(prKey);
  } catch {}
}

function autoSaveDraft() {
  if (!currentFilePath) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const draft = {
      filePath: currentFilePath,
      fileName: currentFileName,
      prNumber: prNumberInput.value.trim(),
      reviewBody: reviewBody.value.trim(),
      comments: comments,
      timestamp: new Date().toISOString()
    };
    window.electronAPI.saveDraft({ filePath: currentFilePath, draft }).catch((err) => { console.warn('[autosave] Failed to save draft:', err.message); });

    // Also save PR-specific draft (persists across app restarts)
    if (currentPrNumber) {
      window.electronAPI.savePrDraft({
        prNumber: currentPrNumber,
        repoKey: currentRepoKey,
        reviewBody: reviewBody.value.trim(),
        comments: comments
      }).catch((err) => { console.warn('[autosave] Failed to save PR draft:', err.message); });
    }
  }, 500); // Debounce 500ms
}

async function loadSavedDraft(filePath) {
  try {
    const draft = await window.electronAPI.loadDraft(filePath);
    if (draft && draft.comments && draft.comments.length > 0) {
      return draft;
    }
  } catch (err) { console.warn('[loadDraft] No saved draft or failed to load:', err.message); }
  return null;
}

// ===================== DIFF PARSING =====================

function parseDiffLineNumbers(diffContent) {
  const files = {};
  let currentFile = null;
  let leftLine = 0;
  let rightLine = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  const lines = diffContent.split('\n');
  let inHeaders = false;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
        files[currentFile] = { left: [], right: [] };
        leftIndex = 0;
        rightIndex = 0;
        inHeaders = true;
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
    } else if (currentFile && files[currentFile] && !inHeaders) {
      if (line.startsWith('-')) {
        files[currentFile].left.push({ lineNum: leftLine, index: leftIndex });
        leftLine++;
        leftIndex++;
      } else if (line.startsWith('+')) {
        files[currentFile].right.push({ lineNum: rightLine, index: rightIndex });
        rightLine++;
        rightIndex++;
      } else if (line.startsWith(' ')) {
        files[currentFile].left.push({ lineNum: leftLine, index: leftIndex });
        files[currentFile].right.push({ lineNum: rightLine, index: rightIndex });
        leftLine++;
        rightLine++;
        leftIndex++;
        rightIndex++;
      } else if (line.startsWith('\\')) {
        // "No newline at end of file" - skip
      }
    }
  }
  return files;
}

function getFileName(lineElement) {
  const fileWrapper = lineElement.closest('.d2h-file-wrapper');
  if (!fileWrapper) return 'unknown';
  const fileNameEl = fileWrapper.querySelector('.d2h-file-name');
  return fileNameEl ? fileNameEl.textContent.trim() : 'unknown';
}

function getLineNumber(lineElement, isRight) {
  // Unified mode: try reading directly from DOM first (most reliable)
  const row = lineElement.closest('tr');
  if (row) {
    const linenumEl = row.querySelector('.d2h-code-linenumber');
    if (linenumEl) {
      // .line-num1 = old (left), .line-num2 = new (right)
      const numEl = isRight
        ? linenumEl.querySelector('.line-num2') || linenumEl.querySelector('.line-num1')
        : linenumEl.querySelector('.line-num1') || linenumEl.querySelector('.line-num2');
      if (numEl) {
        const num = numEl.textContent.trim();
        if (num) return num;
      }
    }
  }

  // Side-by-side mode: derive from parsedDiff structure
  if (!parsedDiff) return '';
  const fileName = getFileName(lineElement);
  const fileData = parsedDiff[fileName];
  if (!fileData) return '';

  const sideDiff = lineElement.closest('.d2h-file-side-diff');
  if (sideDiff) {
    const allLines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
    const lineIndex = Array.from(allLines).indexOf(lineElement);
    if (lineIndex < 0) return '';
    const sideData = isRight ? fileData.right : fileData.left;
    const entry = sideData[lineIndex];
    return entry ? String(entry.lineNum) : '';
  }

  return '';
}

// ===================== LOAD DIFF =====================

function loadDiff(content, filePath) {
  console.log('[loadDiff] Called with', content ? content.length : 0, 'chars, filePath:', filePath);
  hideDiffLoading(); // The new diff has arrived — remove the loading indicator
  updatePrArrowStates(); // Recompute prev/next availability now that a PR is loaded
  if (!content || !content.trim()) {
    prInfo.textContent = 'Error: Empty diff file';
    resetButtons();
    return;
  }
  if (!content.includes('diff --git') && !content.includes('@@') && !content.includes('---')) {
    prInfo.textContent = 'Error: File does not appear to be a valid diff';
    resetButtons();
    return;
  }

  // Sort files by extension, then by name
  content = sortDiffByExtension(content);

  currentDiff = content;
  currentDiffContent = content;
  currentDiffFilePath = filePath;
  allExtensionsInDiff = extractExtensionsFromDiff(content);
  if (filePath) currentFilePath = filePath;
  comments = [];
  fileCommentCounts = {};
  if (btnPrComment) btnPrComment.classList.remove('active'); // reset comment indicator for new PR
  parsedDiff = parseDiffLineNumbers(content);

  emptyState.style.display = 'none';
  diffContainer.style.display = 'block';
  if (reviewBodyContainer) reviewBodyContainer.style.display = 'block';
  contentDiv.classList.add('diff-loaded');
  console.log('[loadDiff] contentDiv:', contentDiv, 'classes right after add:', contentDiv.className);

  resetButtons();

  // Use Diff2HtmlUI.draw() which handles hljs internally and preserves word-level del/ins tags
  const diff2htmlUi = new Diff2HtmlUI(diffContainer, content, {
    drawFileList: true,
    matching: 'words',
    outputFormat: currentDiffViewMode === 'split' ? 'side-by-side' : 'line-by-line',
    colorScheme: 'dark'
  }, typeof window.hljs !== 'undefined' ? window.hljs : undefined);
  diff2htmlUi.draw();
  diff2htmlUi.fileListToggle(false);
  highlightUnrecognizedFiles();

  const fileCount = (content.match(/diff --git/g) || []).length;
  prInfo.innerHTML = `<strong>${fileCount} file${fileCount !== 1 ? 's' : ''}</strong> changed`;
  prNumberWrapper.style.display = 'inline-flex';
  prNumberWrapper.style.alignItems = 'center';
  prNumberWrapper.style.gap = '4px';

  const prMatch = currentFileName?.match(/pr[-_]?(\d+)/i) || currentFileName?.match(/(\d+)/);
  if (prMatch) {
    prNumberInput.value = prMatch[1];
  }

  addCommentButtons();
  addFileCommentButtons();
  addCopyFileNameButtons();
  populateFileSidebar();
  addContextButtons();
  showReviewButtons();



  // Scroll to top when loading a new PR
  window.scrollTo(0, 0);

  // Reset description dropdown scroll position
  const descDropdown = document.getElementById('pr-desc-dropdown');
  if (descDropdown) {
    descDropdown.scrollTop = 0;
    descDropdown.classList.remove('open');
  }

  // Apply extension filter to diff view on initial load
  // Only if user has explicitly unchecked extensions (null = show all, [] = hide all)
  if (activeExtensions !== null && activeExtensions.length > 0) {
    const allExts = extractExtensionsFromDiff(currentDiffContent);
    const excludedExts = allExts.filter(e => !activeExtensions.includes(e));
    if (excludedExts.length > 0) {
      collapseFilteredFiles(excludedExts);
    }
    updateFilteredFilesNotice(excludedExts);
  } else {
    updateFilteredFilesNotice([]);
  }

  // Try to load saved draft
  if (currentFilePath) {
    loadSavedDraft(currentFilePath).then(draft => {
      if (draft) {
        restoreDraft(draft);
      }
    });
  }
}

// ===================== RESTORE DRAFT =====================

function restoreDraft(draft) {
  if (draft.prNumber) prNumberInput.value = draft.prNumber;
  if (draft.reviewBody) reviewBody.value = draft.reviewBody;

  const draftComments = draft.comments || [];
  console.log('[restoreDraft] Restoring', draftComments.length, 'comments');
  for (const c of draftComments) {
    if (!c._uid) c._uid = ++commentUidCounter;
    // Verify the comment's target line exists in current diff before adding
    if (c.level !== 'file' && !findDiffLineRow(c.file, c.line, c.side)) {
      console.warn('[restoreDraft] Skipping stale comment:', c.file, c.line, c.side);
      continue;
    }
    comments.push(c);
    if (c.level === 'file') {
      // Restore file-level comment marker
      renderFileCommentMarker(c);
    } else {
      // Restore line-level comment marker
      renderLineCommentMarker(c);
    }
  }
  updateCommentCount();
  updateCommentNav();
  autoSaveDraft(); // Save immediately to confirm draft is valid
}

// ===================== INLINE REVIEW COMMENTS =====================

// Track which comments are from the current user (to avoid re-posting)
let inlineReviewComments = [];
let currentInlineCommentIds = new Set();

async function fetchAndDisplayReviewComments(prNumber, repoKey) {
  try {
    const { comments, error } = await window.electronAPI.getReviewComments({ prNumber, repo: repoKey });
    if (error || !comments || comments.length === 0) return;

    // Guard: if user loaded a different PR while we were fetching, discard results
    if (currentPrNumber !== prNumber) return;

    // Group comments by file and line
    const commentsByFileLine = {};
    for (const comment of comments) {
      // Skip reply comments (they'll be shown as threads)
      if (comment.inReplyToId) continue;

      const key = `${comment.path}:${comment.line || comment.originalLine}`;
      if (!commentsByFileLine[key]) commentsByFileLine[key] = [];
      commentsByFileLine[key].push(comment);
    }

    // Also collect replies and attach to parent comments
    const repliesByParentId = {};
    for (const comment of comments) {
      if (comment.inReplyToId) {
        if (!repliesByParentId[comment.inReplyToId]) repliesByParentId[comment.inReplyToId] = [];
        repliesByParentId[comment.inReplyToId].push(comment);
      }
    }

    // Store all comment IDs to prevent re-posting
    inlineReviewComments = comments;
    currentInlineCommentIds = new Set(comments.map(c => c.id));

    // Insert comments into the diff
    insertInlineComments(commentsByFileLine, repliesByParentId);
  } catch (err) {
    console.error('[review-comments] fetch failed:', err);
  }
}

function insertInlineComments(commentsByFileLine, repliesByParentId) {
  if (!parsedDiff) return;

  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');

  for (const wrapper of fileWrappers) {
    const fileNameEl = wrapper.querySelector('.d2h-file-name');
    const fileName = fileNameEl ? fileNameEl.textContent.trim() : '';

    // Get parsed diff data for this file
    const fileData = parsedDiff[fileName];
    if (!fileData) continue;

    // Process each side (LEFT=index 0, RIGHT=index 1)
    const sideDiffs = wrapper.querySelectorAll('.d2h-file-side-diff');
    sideDiffs.forEach((sideDiff, sideIndex) => {
      const isRight = sideIndex === 1;
      const sideData = isRight ? fileData.right : fileData.left;
      const side = isRight ? 'RIGHT' : 'LEFT';

      const codeLines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');

      codeLines.forEach((lineEl, lineIndex) => {
        // Get the actual line number from parsedDiff
        const entry = sideData[lineIndex];
        if (!entry) return;
        const lineNum = entry.lineNum;

        // Check if there are comments for this file/line/side
        const key = `${fileName}:${lineNum}`;
        const lineComments = commentsByFileLine[key] || [];
        const relevantComments = lineComments.filter(c => {
          if (c.side === 'RIGHT' && !isRight) return false;
          if (c.side === 'LEFT' && isRight) return false;
          return true;
        });

        if (relevantComments.length === 0) return;

        // Create comment container
        const commentContainer = document.createElement('div');
        commentContainer.className = 'inline-review-comments';
        commentContainer.dataset.line = lineNum;
        commentContainer.dataset.file = fileName;
        commentContainer.dataset.side = side;

        for (const comment of relevantComments) {
          // Unresolved threads expand by default, resolved collapse
          const defaultExpanded = comment.resolved === false;
          const commentEl = createReviewCommentElement(comment, repliesByParentId, defaultExpanded);
          commentContainer.appendChild(commentEl);
        }

        // Insert after the line
        lineEl.parentNode.insertBefore(commentContainer, lineEl.nextSibling);
      });
    });
  }
}

function createReviewCommentElement(comment, repliesByParentId, defaultExpanded = false) {
  const el = document.createElement('div');
  el.className = 'inline-review-comment' + (defaultExpanded ? '' : ' resolved-collapsed');
  el.dataset.commentId = comment.id;

  // Format the comment body (basic markdown)
  const bodyHtml = formatCommentBody(comment.body);

  // Get replies
  const replies = repliesByParentId[comment.id] || [];

  // Determine initial display state based on resolved status
  const repliesDisplay = replies.length > 0 ? (defaultExpanded ? 'block' : 'none') : 'none';
  const bodyDisplay = defaultExpanded ? 'block' : 'none';
  const toggleExpandedClass = defaultExpanded ? ' expanded' : '';

  el.innerHTML = `
    <div class="review-comment-header">
      <img class="review-comment-avatar" src="${escapeHtml(comment.authorAvatar)}" alt="${escapeHtml(comment.author)}">
      <span class="review-comment-author">${escapeHtml(comment.author)}</span>
      <span class="review-comment-date">${formatRelativeTime(comment.createdAt)}</span>
      ${replies.length > 0 || !defaultExpanded ? `
      <button class="review-comment-toggle${toggleExpandedClass}" title="${defaultExpanded ? 'Collapse thread' : 'Expand thread'}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
        </svg>
        ${replies.length > 0 ? `<span class="reply-count">${replies.length}</span>` : ''}
      </button>` : ''}
    </div>
    <div class="review-comment-body" style="display:${bodyDisplay}">${bodyHtml}</div>
    <div class="review-comment-replies" style="display:${repliesDisplay}">
      ${replies.map(reply => `
        <div class="inline-review-comment reply">
          <div class="review-comment-header">
            <img class="review-comment-avatar" src="${escapeHtml(reply.authorAvatar)}" alt="${escapeHtml(reply.author)}">
            <span class="review-comment-author">${escapeHtml(reply.author)}</span>
            <span class="review-comment-date">${formatRelativeTime(reply.createdAt)}</span>
          </div>
          <div class="review-comment-body">${formatCommentBody(reply.body)}</div>
        </div>
      `).join('')}
    </div>
  `;

  // Add toggle handler
  const toggleBtn = el.querySelector('.review-comment-toggle');
  const repliesContainer = el.querySelector('.review-comment-replies');
  const bodyContainer = el.querySelector('.review-comment-body');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isCurrentlyCollapsed = !toggleBtn.classList.contains('expanded');
      // Toggle body and replies together
      if (bodyContainer) bodyContainer.style.display = isCurrentlyCollapsed ? 'block' : 'none';
      if (repliesContainer) repliesContainer.style.display = isCurrentlyCollapsed ? 'block' : 'none';
      toggleBtn.classList.toggle('expanded', isCurrentlyCollapsed);
      el.classList.toggle('resolved-collapsed', !isCurrentlyCollapsed);
    });
  }

  return el;
}

function formatCommentBody(body) {
  if (!body) return '';
  // Basic markdown: bold, italic, code, links
  let html = escapeHtml(body);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Check if a comment ID is from a fetched review comment (to prevent re-posting)
function isReviewComment(commentId) {
  return currentInlineCommentIds.has(commentId);
}

// ===================== LINE COMMENT BUTTONS =====================

function addCommentButtons() {
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  fileWrappers.forEach(wrapper => {
    const sideDiffs = wrapper.querySelectorAll('.d2h-file-side-diff');
    if (sideDiffs.length > 0) {
      // Side-by-side mode
      sideDiffs.forEach((sideDiff, index) => {
        const isRight = index % 2 === 1;
        const lines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
        lines.forEach(line => {
          // Navigate up to the <tr> to find the sibling line number cell
          // (diff2html puts .d2h-code-side-linenumber in a <td> sibling, not inside the <div class="d2h-code-side-line">)
          const row = line.closest('tr');
          if (!row) return;
          const lineNumEl = row.querySelector('.d2h-code-side-linenumber');
          if (!lineNumEl) return;
          const numText = lineNumEl.textContent.trim();
          if (!numText || !/^\d+$/.test(numText)) return;

          // Skip if this line already has a comment button
          if (lineNumEl.querySelector('.line-comment-btn')) return;

          const btn = document.createElement('button');
          btn.className = 'line-comment-btn';
          btn.textContent = '+';
          btn.title = 'Add comment (Cmd+Enter to submit)';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            openCommentDialog(line, btn, isRight, e);
          });
          lineNumEl.appendChild(btn);
        });
      });
    } else {
      // Unified (line-by-line) mode
      const lines = wrapper.querySelectorAll('.d2h-code-line');
      lines.forEach(line => {
        // Only add comment button if line has a valid line number
        const row = line.closest('tr');
        if (!row) return;
        const linenumEl = row.querySelector('.d2h-code-linenumber');
        if (!linenumEl) return;
        const numText = linenumEl.textContent.trim();
        if (!numText || !/^\d+$/.test(numText)) return;

        // Skip if this line already has a comment button
        if (linenumEl.querySelector('.line-comment-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'line-comment-btn';
        btn.textContent = '+';
        btn.title = 'Add comment (Cmd+Enter to submit)';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          // Determine side from parent td class: d2h-del=LEFT, d2h-ins=RIGHT
          const td = line.closest('td');
          const isRight = td ? td.classList.contains('d2h-ins') : (row ? row.querySelector('.d2h-code-linenumber.d2h-ins') !== null : false);
          openCommentDialog(line, btn, isRight, e);
        });
        linenumEl.appendChild(btn);
      });
    }
  });
}

// ===================== FILE-LEVEL COMMENT BUTTONS =====================

function addFileCommentButtons() {
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  fileWrappers.forEach(wrapper => {
    const header = wrapper.querySelector('.d2h-file-header');
    if (!header) return;
    const fileNameEl = header.querySelector('.d2h-file-name');
    const fileName = fileNameEl ? fileNameEl.textContent.trim() : 'unknown';

    // Make file name clickable to open in editor
    if (fileNameEl) {
      fileNameEl.style.cursor = 'pointer';
      fileNameEl.title = 'Click to open in editor';
      fileNameEl.addEventListener('click', (e) => {
        e.stopPropagation();
        // Get the first line number shown in this file's diff
        const firstLine = wrapper.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
        let line = 1;
        if (firstLine) {
          // Get the actual line number from parsedDiff if available
          const num = parseInt(firstLine.textContent.trim());
          if (!isNaN(num) && num > 0) line = num;
        }
        console.log(`[editor] Opening ${fileName} at line ${line}`);
        window.electronAPI.openFileInEditor({ filePath: fileName, line });
      });
    }

    const btn = document.createElement('button');
    btn.className = 'file-comment-btn';
    btn.dataset.fileName = fileName;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> <span class="comment-count" style="display:none">0</span>';
    btn.title = 'Add file-level comment (Cmd+Enter to submit)';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openFileCommentDialog(wrapper, fileName);
    });
    header.appendChild(btn);
  });
}

// ===================== COPY FILE NAME BUTTONS =====================

function addCopyFileNameButtons() {
  const fileHeaders = document.querySelectorAll('.d2h-file-header');
  fileHeaders.forEach(header => {
    // Skip if already has a copy button
    if (header.querySelector('.copy-file-name-btn')) return;

    const fileNameEl = header.querySelector('.d2h-file-name');
    if (!fileNameEl) return;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-file-name-btn';
    copyBtn.title = 'Copy file path';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><span class="copy-feedback">Copied!</span>';

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const filePath = fileNameEl.textContent.trim();
      navigator.clipboard.writeText(filePath).then(() => {
        showToast('Copied: ' + filePath, 'info', 2000);
      }).catch(err => {
        console.error('Failed to copy file path:', err);
        showToast('Failed to copy file path', 'error', 3000);
      });
    });

    // Insert right after the file name (before stats)
    fileNameEl.after(copyBtn);
  });
}

// Wrapper-specific versions for targeted DOM updates (context expand)
function addCommentButtonsForWrapper(wrapper, fileName) {
  const sideDiffs = wrapper.querySelectorAll('.d2h-file-side-diff');
  if (sideDiffs.length > 0) {
    sideDiffs.forEach((sideDiff, index) => {
      const isRight = index % 2 === 1;
      const lines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
      lines.forEach(line => {
        const row = line.closest('tr');
        if (!row) return;
        const lineNumEl = row.querySelector('.d2h-code-side-linenumber');
        if (!lineNumEl || lineNumEl.querySelector('.line-comment-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'line-comment-btn';
        btn.title = 'Add comment (Cmd+Enter to submit)';
        btn.textContent = '+';
        lineNumEl.appendChild(btn);
      });
    });
  } else {
    const lines = wrapper.querySelectorAll('.d2h-code-line:not(.d2h-code-line-emptyplaceholder)');
    lines.forEach(line => {
      const row = line.closest('tr');
      if (!row) return;
      const lineNumEl = row.querySelector('.d2h-code-linenumber');
      if (!lineNumEl || lineNumEl.querySelector('.line-comment-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'line-comment-btn';
      btn.title = 'Add comment (Cmd+Enter to submit)';
      btn.textContent = '+';
      lineNumEl.appendChild(btn);
    });
  }
}

function addContextButtonsForWrapper(wrapper, fileName) {
  if (!fileContextLevels.has(fileName)) {
    fileContextLevels.set(fileName, CONTEXT_INITIAL);
  }
  const header = wrapper.querySelector('.d2h-file-header');
  const btnUp = document.createElement('button');
  btnUp.className = 'context-expand-btn';
  btnUp.dataset.fileName = fileName;
  btnUp.dataset.direction = 'up';
  btnUp.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"/></svg> Show more lines above`;
  btnUp.addEventListener('click', () => handleContextExpand(fileName, wrapper));
  const btnDown = document.createElement('button');
  btnDown.className = 'context-expand-btn';
  btnDown.dataset.fileName = fileName;
  btnDown.dataset.direction = 'down';
  btnDown.innerHTML = `Show more lines below <svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.78 5.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 6.28a.75.75 0 111.06-1.06L8 8.94l3.72-3.72a.75.75 0 011.06 0z"/></svg>`;
  btnDown.addEventListener('click', () => handleContextExpand(fileName, wrapper));
  if (header && header.nextSibling) {
    wrapper.insertBefore(btnUp, header.nextSibling);
  } else if (header) {
    header.after(btnUp);
  }
  wrapper.appendChild(btnDown);
  addInterHunkExpandButtons(fileName, wrapper);
  updateContextButtonStates(fileName, wrapper);
}

// ===================== CONTEXT EXPAND BUTTONS =====================

const CONTEXT_INCREMENT = 6;
const CONTEXT_INITIAL = 3;
const CONTEXT_MAX = 60;

function addContextButtons() {
  // Remove all existing context expand buttons first to prevent accumulation
  diffContainer.querySelectorAll('.context-expand-btn').forEach(b => b.remove());

  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');

  fileWrappers.forEach(wrapper => {
    const fileNameEl = wrapper.querySelector('.d2h-file-name');
    const fileName = fileNameEl ? fileNameEl.textContent.trim() : 'unknown';

    // Initialize context level if not set
    if (!fileContextLevels.has(fileName)) {
      fileContextLevels.set(fileName, CONTEXT_INITIAL);
    }

    // Get the diff content area (everything after the header)
    const header = wrapper.querySelector('.d2h-file-header');
    const diffContent = wrapper.querySelector('.d2h-files-diff') || wrapper.querySelector('.d2h-file-diff');

    // Create "Show more above" button (up chevron)
    const btnUp = document.createElement('button');
    btnUp.className = 'context-expand-btn';
    btnUp.dataset.fileName = fileName;
    btnUp.dataset.direction = 'up';
    btnUp.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"/></svg> Show more lines above`;
    btnUp.addEventListener('click', () => handleContextExpand(fileName, wrapper));

    // Create "Show more below" button (down chevron)
    const btnDown = document.createElement('button');
    btnDown.className = 'context-expand-btn';
    btnDown.dataset.fileName = fileName;
    btnDown.dataset.direction = 'down';
    btnDown.innerHTML = `Show more lines below <svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.78 5.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 6.28a.75.75 0 111.06-1.06L8 8.94l3.72-3.72a.75.75 0 011.06 0z"/></svg>`;
    btnDown.addEventListener('click', () => handleContextExpand(fileName, wrapper));

    // Insert "Expand up" after the file header (not above it)
    if (header && header.nextSibling) {
      wrapper.insertBefore(btnUp, header.nextSibling);
    } else if (header) {
      header.after(btnUp);
    } else {
      wrapper.insertBefore(btnUp, wrapper.firstChild);
    }

    // Insert "Expand down" as the last child of the wrapper
    wrapper.appendChild(btnDown);

    // Add expand buttons between hunk gaps (rows with empty line numbers on both sides)
    addInterHunkExpandButtons(fileName, wrapper);

    // Update disabled state
    updateContextButtonStates(fileName, wrapper);
  });
}

function addInterHunkExpandButtons(fileName, wrapper) {
  // Hunk boundaries are d2h-info rows containing @@ headers.
  // Select ONLY the @@ code cell (td.d2h-info:not(.d2h-code-linenumber)) — one
  // per hunk. Using 'tr .d2h-info' matches TWO cells per hunk (the line-number
  // cell ALSO carries d2h-info), which made hunkIndex double-count and placed
  // an expand button on the FIRST hunk too — duplicating the "Show more lines
  // above" button. Replace the @@ header text with an expand button (skip the
  // first hunk header since the file already has top/bottom expand buttons).
  const infoRows = wrapper.querySelectorAll('td.d2h-info:not(.d2h-code-linenumber)');
  let hunkIndex = 0;
  for (const codeCell of infoRows) {
    const row = codeCell.closest('tr');
    if (!row) continue;
    hunkIndex++;
    // Skip the first @@ header — expand buttons at file top/bottom cover that
    if (hunkIndex <= 1) continue;

    // Replace the @@ text with a compact expand button
    if (!codeCell) continue;
    const origText = codeCell.textContent.trim();
    codeCell.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'context-expand-btn context-expand-inter';
    btn.dataset.fileName = fileName;
    btn.title = origText;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg> Expand context`;
    btn.addEventListener('click', () => handleContextExpand(fileName, wrapper));
    codeCell.appendChild(btn);
    codeCell.style.textAlign = 'center';
    codeCell.style.padding = '2px 0';
  }
}

function updateContextButtonStates(fileName, wrapper) {
  const ctxLevel = fileContextLevels.get(fileName) || CONTEXT_INITIAL;
  const maxReached = ctxLevel >= CONTEXT_MAX;

  const btnUp = wrapper.querySelector('.context-expand-btn[data-direction="up"]');
  const btnDown = wrapper.querySelector('.context-expand-btn[data-direction="down"]');

  // Parse hunk headers to check if we're already at file boundaries
  const hunkHeaders = wrapper.querySelectorAll('.d2h-code-line-ins');
  const hunkLines = [];
  wrapper.querySelectorAll('.d2h-code-linenumber .line-num1, .d2h-code-linenumber .line-num2').forEach(el => {
    const num = parseInt(el.textContent.trim(), 10);
    if (!isNaN(num)) hunkLines.push(num);
  });

  // Check if first hunk starts near line 1 (no more above to show)
  const firstHunkHeaders = wrapper.querySelectorAll('.d2h-code-line-ins');
  let startsAtTop = false;
  let endsAtBottom = false;

  // Parse @@ headers to find the range of the diff
  const diffTable = wrapper.querySelector('.d2h-diff-table');
  let firstOldStart = Infinity, lastOldEnd = 0;
  if (diffTable) {
    const allRows = diffTable.querySelectorAll('tbody tr');
    for (const row of allRows) {
      const insCell = row.querySelector('.d2h-ins');
      if (insCell) {
        const match = insCell.textContent.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          const oldStart = parseInt(match[1], 10);
          const oldCount = parseInt(match[2] || '1', 10);
          const newStart = parseInt(match[3], 10);
          const newCount = parseInt(match[4] || '1', 10);
          if (oldStart < firstOldStart) firstOldStart = oldStart;
          const oldEnd = oldStart + oldCount;
          const newEnd = newStart + newCount;
          if (oldEnd > lastOldEnd) lastOldEnd = oldEnd;
          if (newEnd > lastOldEnd) lastOldEnd = newEnd;
          if (oldStart <= 1 || newStart <= 1) startsAtTop = true;
        }
      }
    }
  }

  // Check last line number in the diff table
  if (diffTable) {
    const lineNums = diffTable.querySelectorAll('.line-num1, .line-num2');
    let maxLine = 0;
    lineNums.forEach(el => {
      const num = parseInt(el.textContent.trim(), 10);
      if (!isNaN(num) && num > maxLine) maxLine = num;
    });
    // If max visible line is close to the last hunk end, we're at the bottom
    if (maxLine > 0 && lastOldEnd > 0 && maxLine >= lastOldEnd - 1) {
      endsAtBottom = true;
    }
  }

  // If max context reached, also consider it at boundaries (nothing more to fetch)
  if (maxReached) {
    startsAtTop = true;
    endsAtBottom = true;
  }

  if (btnUp) {
    if (startsAtTop) {
      btnUp.style.display = 'none';
    } else {
      btnUp.style.display = '';
      btnUp.disabled = maxReached;
    }
  }

  if (btnDown) {
    if (endsAtBottom) {
      btnDown.style.display = 'none';
    } else {
      btnDown.style.display = '';
      btnDown.disabled = maxReached;
    }
  }
}

async function handleContextExpand(fileName) {
  // Increase context for this file
  const current = fileContextLevels.get(fileName) || CONTEXT_INITIAL;
  if (current >= CONTEXT_MAX) return;

  const newContext = Math.min(current + CONTEXT_INCREMENT, CONTEXT_MAX);
  fileContextLevels.set(fileName, newContext);

  // If no repo path available, we can't fetch from git — just re-render with default
  if (!currentRepoPath) {
    console.warn('[context-expand] No repoPath available, cannot fetch expanded diff');
    return;
  }

  // Fetch expanded diff for this file from git
  try {
    const result = await window.electronAPI.expandDiffContext({
      repoPath: currentRepoPath,
      filePath: fileName,
      contextLines: newContext,
      baseSha: currentBaseSha,
      headSha: currentHeadSha
    });

    if (result.error) {
      console.error('[context-expand] Failed:', result.error);
      return;
    }

    // Replace this file's section in currentDiffContent
    if (result.content && currentDiffContent) {
      console.log('[context-expand] Got', result.content.length, 'chars for', fileName);
      console.log('[context-expand] First 200 chars:', result.content.substring(0, 200));
      console.log('[context-expand] currentDiffContent before:', currentDiffContent.length, 'chars');

      currentDiffContent = replaceFileInDiff(currentDiffContent, fileName, result.content);
      console.log('[context-expand] currentDiffContent after:', currentDiffContent.length, 'chars');
      console.log('[context-expand] File still present:', currentDiffContent.includes(fileName));

      // Re-render, preserving the expanded file's position in the viewport.
      // Restoring the absolute scrollY makes the view jump when expanding at the
      // bottom of a diff, because inserting context lines above the viewport
      // shifts the file downward. Anchor the file wrapper instead so it stays put.
      let anchorTop = null;
      if (window.scrollY > 0) {
        const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
        for (const w of wrappers) {
          const nameEl = w.querySelector('.d2h-file-name');
          if (nameEl && nameEl.textContent.trim() === fileName) {
            anchorTop = w.getBoundingClientRect().top;
            break;
          }
        }
      }
      const savedScroll = window.scrollY;
      renderFilteredDiff();
      if (anchorTop !== null) {
        const newWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
        for (const w of newWrappers) {
          const nameEl = w.querySelector('.d2h-file-name');
          if (nameEl && nameEl.textContent.trim() === fileName) {
            const newTop = w.getBoundingClientRect().top;
            window.scrollBy(0, newTop - anchorTop);
            break;
          }
        }
      } else {
        window.scrollTo(0, savedScroll);
      }
    }
  } catch (err) {
    console.error('[context-expand] Error:', err);
  }
}

function replaceFileInDiff(fullDiff, targetFile, newFileDiff) {
  // Split the full diff into per-file sections
  const sections = fullDiff.split(/(?=^diff --git )/m);
  const result = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    // Check if this section is for the target file
    const match = section.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/m);
    if (match) {
      const bPath = match[2];
      if (bPath === targetFile) {
        // Replace with the new expanded diff
        if (newFileDiff.trim()) {
          // Ensure trailing newline so the next section's diff --git header
          // starts on its own line (prevents sortDiffByExtension corruption)
          let replacement = newFileDiff;
          if (!replacement.endsWith('\n')) replacement += '\n';
          result.push(replacement);
        } else {
          // New diff is empty — keep the original section rather than dropping it
          result.push(section);
        }
        continue;
      }
    }
    result.push(section);
  }

  return result.join('');
}

function openFileCommentDialog(wrapper, fileName) {
  closeCommentDialog();

  commentTarget = {
    file: fileName,
    line: null,
    side: null,
    element: wrapper,
    level: 'file'
  };

  // Insert form after the file header
  const header = wrapper.querySelector('.d2h-file-header');
  const formDiv = document.createElement('div');
  formDiv.className = 'comment-form-row';
  formDiv.id = 'active-comment-form';
  formDiv.innerHTML = `
    <div class="comment-form">
      <div class="comment-label">💬 ${escapeHtml(fileName)} — file-level comment</div>
      <textarea id="comment-text" placeholder="Write a comment about this file... (${escapeHtml(aiTagPrefix)} to message AI, @ask for inline response)" autofocus></textarea>
      <div class="actions">
        <button class="btn-cancel" id="comment-cancel">Cancel</button>
        <button class="btn-submit" id="comment-submit">Add Comment</button>
      </div>
    </div>
  `;
  header.parentNode.insertBefore(formDiv, header.nextSibling);

  const ta = formDiv.querySelector('textarea');
  if (ta) { ta.focus(); setupMentionHandling(ta); }

  formDiv.querySelector('#comment-cancel').addEventListener('click', closeCommentDialog);
  formDiv.querySelector('#comment-submit').addEventListener('click', submitComment);
}

function renderFileCommentMarker(comment) {
  const wrapper = diffContainer.querySelector(`.d2h-file-wrapper:has(.d2h-file-name)`);
  // Find the correct wrapper by file name
  const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  let targetWrapper = null;
  for (const w of wrappers) {
    const nameEl = w.querySelector('.d2h-file-name');
    if (nameEl && nameEl.textContent.trim() === comment.file) {
      targetWrapper = w;
      break;
    }
  }
  if (!targetWrapper) return;

  const marker = document.createElement('div');
  marker.className = 'file-comment-marker' + (comment.isAiTagged ? ' ai-tagged' : '');
  marker.dataset.commentUid = comment._uid || (comment._uid = ++commentUidCounter);

  const displayText = comment.isAiTagged ? stripAiTag(comment.text) : comment.text;
  const tagLabel = comment.isAiTagged ? getAiTagLabel(comment.text) : '';
  marker.innerHTML = `<strong>You</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
    <div class="comment-actions">
      <button class="btn-edit" title="Edit">Edit</button>
      <button class="btn-delete" title="Delete">Delete</button>
    </div>`;

  // Insert after the file header
  const header = targetWrapper.querySelector('.d2h-file-header');
  header.parentNode.insertBefore(marker, header.nextSibling);

  // Remove the comment form (it should have been replaced, not left open)
  const existingForm = document.getElementById('active-comment-form');
  if (existingForm) existingForm.remove();
  commentTarget = null;

  marker.querySelector('.btn-edit').addEventListener('click', () => editComment(marker));
  marker.querySelector('.btn-delete').addEventListener('click', () => deleteComment(marker));
  updateFileCommentCount(comment.file);
}

// ===================== COMMENT DIALOG (LINE-LEVEL) =====================

function openCommentDialog(lineElement, btnElement, isRight, event) {
  const fileName = getFileName(lineElement);
  const lineNum = getLineNumber(lineElement, isRight);

  // Capture the actual code content of this line
  const codeContent = lineElement.querySelector('.d2h-code-line-ctn, .d2h-code-side-linenumber');
  const codeText = lineElement.textContent.replace(/^\s*\d+/, '').trim(); // strip line number prefix

  closeCommentDialog();

  commentTarget = {
    file: fileName,
    line: lineNum,
    side: isRight ? 'RIGHT' : 'LEFT',
    element: lineElement,
    level: 'line',
    codeContext: codeText
  };

  const formRow = document.createElement('tr');
  formRow.className = 'comment-form-row';
  formRow.id = 'active-comment-form';
  const formCell = document.createElement('td');
  formCell.setAttribute('colspan', '2');

  const side = isRight ? 'right' : 'left';
  const lineLabel = lineNum ? `line ${escapeHtml(String(lineNum))}` : '';
  formCell.innerHTML = `
    <div class="comment-form">
      <div class="comment-label">${escapeHtml(fileName)} ${lineLabel}</div>
      <textarea id="comment-text" placeholder="Write a comment... (${escapeHtml(aiTagPrefix)} to message AI, @ask for inline response)" autofocus></textarea>
      <div class="image-paste-hint">💡 Paste (Cmd+V) or drag & drop an image to attach</div>
      <div class="actions">
        <button class="btn-cancel" id="comment-cancel">Cancel</button>
        <button class="btn-submit" id="comment-submit">Add Comment</button>
      </div>
    </div>
  `;
  formRow.appendChild(formCell);

  const row = lineElement.closest('tr');
  if (row) {
    row.parentNode.insertBefore(formRow, row.nextSibling);
  }

  // Focus and add image paste support
  const ta = formRow.querySelector('textarea');
  if (ta) {
    ta.focus();
    setupImagePaste(ta);
    setupMentionHandling(ta);
  }

  formRow.querySelector('#comment-cancel').addEventListener('click', closeCommentDialog);
  formRow.querySelector('#comment-submit').addEventListener('click', submitComment);
}

function closeCommentDialog() {
  const existing = document.getElementById('active-comment-form');
  if (existing) existing.remove();
  commentTarget = null;
}

// ===================== SUBMIT COMMENT =====================

function submitComment() {
  const ta = document.getElementById('comment-text');
  const text = ta ? ta.value.trim() : '';
  if (!text || !commentTarget) return;

  // Check for pasted image
  const imageEl = document.querySelector('#active-comment-form .pasted-image');
  const imageDataUrl = imageEl ? imageEl.src : null;

  const isAiTagged = text.toLowerCase().startsWith(aiTagPrefix.toLowerCase()) || text.toLowerCase().startsWith('@ask');
  const level = commentTarget.level || 'line';

  const comment = {
    _uid: ++commentUidCounter,
    file: commentTarget.file,
    line: commentTarget.line,
    side: commentTarget.side,
    text: text,
    isAiTagged: isAiTagged,
    level: level,
    codeContext: commentTarget.codeContext || null,
    imageDataUrl: imageDataUrl || null
  };
  comments.push(comment);
  console.log('[comments] Added comment, total now:', comments.length, 'file:', comment.file, 'line:', comment.line);

  if (level === 'file') {
    renderFileCommentMarker(comment);
  } else {
    renderLineCommentMarker(comment);
  }

  commentTarget = null;
  updateCommentCount();
  updateCommentNav();
  autoSaveDraft();
}

function renderLineCommentMarker(comment) {
  const marker = document.createElement('tr');
  marker.className = 'line-comment-marker' + (comment.isAiTagged ? ' ai-tagged' : '');
  marker.dataset.commentUid = comment._uid || (comment._uid = ++commentUidCounter);
  const markerCell = document.createElement('td');
  markerCell.setAttribute('colspan', '2');

  const displayText = comment.isAiTagged ? stripAiTag(comment.text) : comment.text;
  const tagLabel = comment.isAiTagged ? getAiTagLabel(comment.text) : '';
  markerCell.innerHTML = `<strong>You (line ${comment.line})</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
    <div class="comment-actions">
      <button class="btn-edit" title="Edit">Edit</button>
      <button class="btn-delete" title="Delete">Delete</button>
    </div>`;
  marker.appendChild(markerCell);

  const formRow = document.getElementById('active-comment-form');
  if (formRow) {
    formRow.parentNode.replaceChild(marker, formRow);
  } else {
    // Find the correct diff line and insert the marker after it
    const lineRow = findDiffLineRow(comment.file, comment.line, comment.side);
    if (lineRow) {
      lineRow.parentNode.insertBefore(marker, lineRow.nextSibling);
    } else {
      // Comment line not found in current diff — skip it (stale line numbers)
      console.warn('[restoreDraft] Skipping comment — line not found:', comment.file, comment.line, comment.side);
      marker.remove();
      return;
    }
  }

  marker.querySelector('.btn-edit').addEventListener('click', () => editComment(marker));
  marker.querySelector('.btn-delete').addEventListener('click', () => deleteComment(marker));
}

function findDiffLineRow(fileName, lineNum, side) {
  if (!diffContainer || !fileName || !lineNum) return null;
  const targetLine = parseInt(lineNum, 10);
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  for (const wrapper of fileWrappers) {
    const nameEl = wrapper.querySelector('.d2h-file-name');
    if (!nameEl || nameEl.textContent.trim() !== fileName) continue;
    const rows = wrapper.querySelectorAll('tr');
    for (const row of rows) {
      // In unified mode, each row has a single line number cell with
      // .line-num1 (left/old) and .line-num2 (right/new) divs inside
      const lineCell = row.querySelector('.d2h-code-linenumber');
      if (!lineCell) continue;

      const num1El = lineCell.querySelector('.line-num1');
      const num2El = lineCell.querySelector('.line-num2');

      if (side === 'RIGHT' && num2El) {
        const num = parseInt(num2El.textContent.trim(), 10);
        if (num === targetLine) return row;
      } else if (side === 'LEFT' && num1El) {
        const num = parseInt(num1El.textContent.trim(), 10);
        if (num === targetLine) return row;
      } else {
        // Fallback: check both line numbers
        const num1 = num1El ? parseInt(num1El.textContent.trim(), 10) : NaN;
        const num2 = num2El ? parseInt(num2El.textContent.trim(), 10) : NaN;
        if (num1 === lineNum || num2 === lineNum) return row;
      }
    }
  }
  return null;
}

// ===================== EDIT / DELETE =====================

function editComment(marker) {
  const uid = parseInt(marker.dataset.commentUid, 10);
  const idx = comments.findIndex(c => c._uid === uid);
  if (idx < 0 || !comments[idx]) return;

  const comment = comments[idx];
  closeCommentDialog();

  commentTarget = { file: comment.file, line: comment.line, side: comment.side, element: marker, level: comment.level || 'line' };

  if (comment.level === 'file') {
    // File-level edit: replace marker with form
    const formDiv = document.createElement('div');
    formDiv.className = 'comment-form-row';
    formDiv.id = 'active-comment-form';
    formDiv.innerHTML = `
      <div class="comment-form">
        <div class="comment-label">💬 ${escapeHtml(comment.file)} — file-level comment</div>
        <textarea id="comment-text" placeholder="Write a comment about this file...">${escapeHtml(comment.text)}</textarea>
        <div class="actions">
          <button class="btn-cancel" id="comment-cancel">Cancel</button>
          <button class="btn-submit" id="comment-submit">Save</button>
        </div>
      </div>`;
    marker.parentNode.replaceChild(formDiv, marker);

    const ta = formDiv.querySelector('textarea');
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; setupMentionHandling(ta); }

    formDiv.querySelector('#comment-cancel').addEventListener('click', () => {
      formDiv.parentNode.replaceChild(marker, formDiv);
      commentTarget = null;
    });
    formDiv.querySelector('#comment-submit').addEventListener('click', () => {
      const newTa = document.getElementById('comment-text');
      const newText = newTa ? newTa.value.trim() : '';
      if (!newText) return;
      comments[idx].text = newText;
      comments[idx].isAiTagged = newText.toLowerCase().startsWith(aiTagPrefix.toLowerCase()) || newText.toLowerCase().startsWith('@ask');
      // Rebuild marker
      const isAi = comments[idx].isAiTagged;
      marker.className = 'file-comment-marker' + (isAi ? ' ai-tagged' : '');
      const displayText = isAi ? stripAiTag(newText) : newText;
      const tagLabel = isAi ? getAiTagLabel(newText) : '';
      marker.innerHTML = `<strong>You</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
        <div class="comment-actions">
          <button class="btn-edit" title="Edit">Edit</button>
          <button class="btn-delete" title="Delete">Delete</button>
        </div>`;
      marker.querySelector('.btn-edit').addEventListener('click', () => editComment(marker));
      marker.querySelector('.btn-delete').addEventListener('click', () => deleteComment(marker));
      formDiv.parentNode.replaceChild(marker, formDiv);
      commentTarget = null;
      autoSaveDraft();
    });
  } else {
    // Line-level edit
    const formRow = document.createElement('tr');
    formRow.className = 'comment-form-row';
    formRow.id = 'active-comment-form';
    const formCell = document.createElement('td');
    formCell.setAttribute('colspan', '2');
    const side = comment.side === 'RIGHT' ? 'right' : 'left';
    const editLineLabel = comment.line ? `line ${escapeHtml(String(comment.line))}` : '';
    formCell.innerHTML = `
      <div class="comment-form">
        <div class="comment-label">${escapeHtml(comment.file)} ${editLineLabel}</div>
        <textarea id="comment-text" placeholder="Write a comment...">${escapeHtml(comment.text)}</textarea>
        <div class="actions">
          <button class="btn-cancel" id="comment-cancel">Cancel</button>
          <button class="btn-submit" id="comment-submit">Save</button>
        </div>
      </div>`;
    formRow.appendChild(formCell);
    marker.parentNode.replaceChild(formRow, marker);

    const ta = formRow.querySelector('textarea');
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; setupMentionHandling(ta); }

    formRow.querySelector('#comment-cancel').addEventListener('click', () => {
      formRow.parentNode.replaceChild(marker, formRow);
      commentTarget = null;
    });
    formRow.querySelector('#comment-submit').addEventListener('click', () => {
      const newTa = document.getElementById('comment-text');
      const newText = newTa ? newTa.value.trim() : '';
      if (!newText) return;
      comments[idx].text = newText;
      comments[idx].isAiTagged = newText.toLowerCase().startsWith(aiTagPrefix.toLowerCase()) || newText.toLowerCase().startsWith('@ask');
      const isAi = comments[idx].isAiTagged;
      marker.className = 'line-comment-marker' + (isAi ? ' ai-tagged' : '');
      const displayText = isAi ? stripAiTag(newText) : newText;
      const tagLabel = isAi ? getAiTagLabel(newText) : '';
      marker.querySelector('td').innerHTML = `<strong>You (line ${comment.line})</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
        <div class="comment-actions">
          <button class="btn-edit" title="Edit">Edit</button>
          <button class="btn-delete" title="Delete">Delete</button>
        </div>`;
      marker.querySelector('.btn-edit').addEventListener('click', () => editComment(marker));
      marker.querySelector('.btn-delete').addEventListener('click', () => deleteComment(marker));
      formRow.parentNode.replaceChild(marker, formRow);
      commentTarget = null;
      autoSaveDraft();
    });
  }
}

function deleteComment(marker) {
  const uid = parseInt(marker.dataset.commentUid, 10);
  const idx = comments.findIndex(c => c._uid === uid);
  if (idx < 0) return;
  const deletedComment = comments[idx];
  comments.splice(idx, 1);
  // No need to reindex — markers use stable _uid, not array indices
  marker.remove();
  if (deletedComment && deletedComment.file) {
    updateFileCommentCount(deletedComment.file);
  }
  updateCommentCount();
  updateCommentNav();
  autoSaveDraft();
}

// ===================== UTILITIES =====================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Toast notification system
function showToast(message, type = 'info', duration = 8000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = message;
  container.appendChild(toast);
  const timer = setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
  // Return a dismiss handle so callers can remove the toast early
  toast._dismiss = () => {
    clearTimeout(timer);
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  };
  return toast;
}

// XSS-safe toast: escapes HTML in message (use for user-controlled content)
function showSafeToast(message, type = 'info', duration = 8000) {
  return showToast(escapeHtml(message), type, duration);
}

function resetButtons() {
  btnApprove.disabled = false;
  btnRequestChanges.disabled = false;
  btnComment.disabled = false;
  btnApprove.style.opacity = '1';
  btnRequestChanges.style.opacity = '1';
  btnComment.style.opacity = '1';
  btnApprove.textContent = 'Approve';
  btnRequestChanges.textContent = 'Request Changes';
  btnComment.textContent = 'Comment';
}

function updateCommentCount() {
  // Only count comments that will be sent to GitHub (exclude AI-tagged)
  const count = comments.filter(c => !c.isAiTagged).length;
  if (count > 0) {
    btnRequestChanges.innerHTML = `Request Changes <span class="badge">${count}</span>`;
    btnComment.innerHTML = `Comment <span class="badge">${count}</span>`;
  } else {
    btnRequestChanges.textContent = 'Request Changes';
    btnComment.textContent = 'Comment';
  }
}

function updateFileCommentCount(fileName) {
  const count = comments.filter(c => c.file === fileName && c.level === 'file').length;
  const btns = diffContainer.querySelectorAll(`.file-comment-btn[data-file-name="${CSS.escape(fileName)}"]`);
  btns.forEach(btn => {
    const countEl = btn.querySelector('.comment-count');
    if (countEl) {
      countEl.textContent = count;
      countEl.style.display = count > 0 ? 'inline' : 'none';
    }
  });
}

// ===================== SUBMIT REVIEW

// Compute diff line positions for GitHub review comments.
// Returns a map of "file:line:side" -> diff position (1-indexed).
function computeDiffPositions() {
  if (!currentDiff) return {};
  const map = {};
  let currentFile = null;
  let position = 0;
  let leftLine = 0;
  let rightLine = 0;
  const lines = currentDiff.split('\n');
  let inHeaders = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
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
        // \ No newline at end of file — counts for position but not line numbers
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

async function submitReview(eventType) {
  const prNumber = prNumberInput.value.trim();
  const review = {
    type: eventType,
    prNumber: prNumber ? parseInt(prNumber, 10) : null,
    body: reviewBody.value.trim(),
    comments: comments,
    filePath: currentFilePath,
    timestamp: new Date().toISOString()
  };

  try {
    const result = await window.electronAPI.saveReview(review);
    const savedPath = result.outputPath || result;
    const askResponses = result.askResponses || [];
    const prCount = comments.filter(c => { const t = c.text.toLowerCase(); return !t.startsWith('@hermes') && !t.startsWith('@ask'); }).length;
    const aiCount = comments.filter(c => c.text.toLowerCase().startsWith('@hermes')).length;
    const askCount = comments.filter(c => c.text.toLowerCase().startsWith('@ask')).length;
    let msg = '✓ Review saved';
    if (aiCount > 0) msg += ` (${aiCount} sent to AI)`;
    if (askCount > 0) msg += ` (${askCount} AI responses received)`;
    showToast(msg, 'success', 6000);

    // If a PR comment was submitted via the header comment button, mark it active
    if (review.body && btnPrComment) btnPrComment.classList.add('active');

    // Toast for AI messages sent
    if (aiCount > 0) {
      showToast(`✓ ${aiCount} comment${aiCount > 1 ? 's' : ''} sent to AI agent`, 'info', 6000);
    }

    // Show @ask responses inline
    if (askResponses.length > 0) {
      let askErrors = 0;
      for (const resp of askResponses) {
        const label = resp.error ? `<span style="color:#f85149">Error: ${escapeHtml(resp.error)}</span>` : `<div style="white-space:pre-wrap;color:#c9d1d9;font-size:13px;">${escapeHtml(resp.response)}</div>`;
        prInfo.innerHTML += `<div style="margin-top:8px;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:6px;">
          <span style="color:#8b949e;font-size:11px;">@ask ${escapeHtml(resp.file)}:${resp.line}</span>
          ${label}
        </div>`;
        if (resp.error) askErrors++;
      }
      const askOk = askResponses.length - askErrors;
      if (askOk > 0) showToast(`✓ ${askOk} AI response${askOk > 1 ? 's' : ''} received`, 'success', 6000);
      if (askErrors > 0) showToast(`⚠ ${askErrors} AI response${askErrors > 1 ? 's' : ''} failed`, 'error', 8000);
    }

    btnApprove.disabled = true;
    btnRequestChanges.disabled = true;
    btnComment.disabled = true;
    btnApprove.style.opacity = '0.5';
    btnRequestChanges.style.opacity = '0.5';
    btnComment.style.opacity = '0.5';

    // Submit directly to GitHub if PR number is available
    if (review.prNumber && window.electronAPI.submitGitHubReview) {
      showToast('Submitting to GitHub…', 'progress', 30000);

      // Compute diff positions for inline comments
      const positionMap = computeDiffPositions();
      console.log('[submit] comments array:', comments.length, 'positionMap keys:', Object.keys(positionMap).length);
      comments.forEach((c, i) => console.log(`[submit] comment ${i}:`, JSON.stringify({ file: c.file, line: c.line, side: c.side, isAiTagged: c.isAiTagged, level: c.level, text: c.text?.substring(0, 50) })));
      // Send line, side, and renderer-computed position to backend
      // Backend recomputes positions from gh pr diff, but falls back to renderer positions if mapping fails
      const githubComments = comments
        .filter(c => !c.isAiTagged && c.text)
        .map(c => {
          // File-level comments: send without line/side (backend handles them separately)
          if (c.level === 'file' || !c.line) {
            return { file: c.file, line: null, side: null, text: c.text, level: 'file', rendererPosition: 0 };
          }
          const posKey = `${c.file}:${c.line}:${c.side}`;
          const rendererPosition = positionMap[posKey] || 0;
          return { file: c.file, line: c.line, side: c.side, text: c.text, level: c.level, rendererPosition };
        });

      const result = await window.electronAPI.submitGitHubReview({
        prNumber: review.prNumber,
        body: review.body,
        eventType: eventType,
        comments: githubComments,
        repo: currentRepoKey
      });

      if (result.error) {
        showToast(`⚠ GitHub submission failed: ${escapeHtml(result.error)}`, 'error', 10000);
        resetButtons();
      } else {
        const ghMsg = eventType === 'approve' ? '✓ Review approved on GitHub' :
                      eventType === 'request_changes' ? '✓ Changes requested on GitHub' :
                      '✓ Comment submitted to GitHub';
        showToast(ghMsg, 'success', 8000);

        // Record this action in the review history (only actions, not mere loads)
        recordReviewAction(review.prNumber, eventType, prTitleForHistory(), githubComments.length);

        // Warn about skipped comments (files not in unified diff — e.g. reverted changes)
        if (result.skippedComments && result.skippedComments.length > 0) {
          const skippedFiles = result.skippedComments.map(c => c.file).join(', ');
          showToast(`⚠ ${result.skippedComments.length} comment(s) skipped — file(s) not in PR diff: ${skippedFiles}`, 'warning', 15000);
        }

        // Clear persisted comments after successful submission

        // Delete PR draft after successful GitHub submission
        if (review.prNumber) {
          window.electronAPI.deletePrDraft(review.prNumber).catch((err) => {
            console.warn('[submit] Failed to delete PR draft:', err.message);
          });
        }

        // Auto-remove this PR from the cached list
        if (review.prNumber && cachedPrList) {
          cachedPrList = cachedPrList.filter(pr => pr.number !== review.prNumber);
        }

        // Re-render dropdown if open to reflect removal
        if (prDropdownOpen) {
          const searchInput = document.getElementById('pr-search');
          renderPrList(cachedPrList, searchInput ? searchInput.value : '');
        }

        // Collect feedback for rules analysis
        const feedback = [];
        for (const c of comments) {
          const t = c.text.toLowerCase();
          if (!t.startsWith('@hermes') && !t.startsWith('@ask')) {
            feedback.push({ file: c.file, line: c.line, text: c.text });
          }
        }
        // Run rules analysis in background — don't block auto-advance
        if (feedback.length > 0) {
          showRulesDialog(feedback).catch(err => {
            console.warn('[rules] Background rules analysis error:', err.message);
          });
        }

        // Auto-fix with AI: trigger Hermes agent to create a fix PR (only for request_changes)
        // Fire-and-forget — don't block auto-advance
        if (eventType === 'request_changes' && window.electronAPI.autoFixWithAi) {
          (async () => {
            try {
              const autoFixConfig = await window.electronAPI.getConfig();
              const autoFixEnabled = autoFixConfig.autoFix && autoFixConfig.autoFix.enabled === true;
              if (autoFixEnabled) {
                showToast('🤖 Auto-fixing with AI...', 'progress', 30000);
                const autoFixComments = comments
                  .filter(c => !c.isAiTagged && c.text && c.file)
                  .map(c => ({ file: c.file, line: c.line, text: c.text }));
                const autoFixResult = await window.electronAPI.autoFixWithAi({
                  prNumber: review.prNumber,
                  comments: autoFixComments,
                  reviewBody: review.body,
                  repo: currentRepoKey
                });
                if (autoFixResult.error) {
                  showSafeToast(`⚠ Auto-fix failed: ${autoFixResult.error}`, 'error', 10000);
                } else if (autoFixResult.success && autoFixResult.prUrl) {
                  const prLink = autoFixResult.prUrl;
                  const prNum = autoFixResult.prNumber || '';
                  showToast(`✓ Auto-fix PR #${escapeHtml(prNum)} created — <a href="${escapeHtml(prLink)}" style="color:#58a6ff" class="pr-url-link">View PR</a>`, 'success', 10000);
                }
              }
            } catch (autoFixErr) {
              showSafeToast(`⚠ Auto-fix error: ${autoFixErr.message}`, 'error', 10000);
            }
          })();
        }

        // Auto-advance to next PR after successful review
        if (cachedPrList && cachedPrList.length > 0) {
            const nextPr = cachedPrList[0];
            console.log('[auto-advance] Moving to PR #' + nextPr.number, 'repo:', nextPr.repo || 'default', 'list size:', cachedPrList.length);
            showToast('Loading next PR #' + nextPr.number + '...', 'progress');
            // Clear previous review state before loading next PR
            reviewBody.value = '';
            try {
              await loadPrByNumber(nextPr.number, nextPr.repo);
            } catch (advanceErr) {
              console.error('[auto-advance] Failed to load next PR:', advanceErr);
              prInfo.innerHTML = `<strong style="color:#f85149">Error loading next PR:</strong> ${escapeHtml(advanceErr.message)}`;
              resetButtons();
            }
          } else {
            // All PRs reviewed — show the celebratory "all done" screen instead of
            // leaving the last PR's diff on screen.
            showAllDoneState();
            // Switch repo back to master/main when no more PRs
            if (window.electronAPI.checkoutMaster) {
              window.electronAPI.checkoutMaster(currentRepoKey || '').then(r => {
                if (r.branch) showToast('Switched to ' + r.branch + ' branch', 'success');
              });
            }
          }
      }
    }
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${escapeHtml(err.message)}`;
    resetButtons();
  }
}

// ===================== EVENT LISTENERS =====================

if (btnOpen) btnOpen.addEventListener('click', async () => {
  const result = await window.electronAPI.openFile();
  if (result && result.content) {
    currentFileName = result.fileName || '';
    loadDiff(result.content, result.filePath);
  }
});

btnApprove.addEventListener('click', () => {
  if (comments.length > 0 && !confirm('You have line comments but are approving. Continue?')) return;
  submitReview('approve');
});

btnRequestChanges.addEventListener('click', () => submitReview('request_changes'));
btnComment.addEventListener('click', () => submitReview('comment'));

// Auto-save on review body change + reflect active (blue) state while a comment is being written
reviewBody.addEventListener('input', () => {
  autoSaveDraft();
  if (btnPrComment) btnPrComment.classList.toggle('active', reviewBody.value.trim().length > 0);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const isMeta = e.metaKey || e.ctrlKey;
  // Normalize single-char keys to uppercase for comparison.
  // On macOS, Cmd+letter reports e.key as lowercase even with Shift held,
  // so we must normalize to avoid case-sensitive mismatches.
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;

  // Escape — close comment form
  if (e.key === 'Escape') {
    closeCommentDialog();
    return;
  }

  // Cmd+Enter — submit current comment form
  if (e.key === 'Enter' && isMeta && !e.shiftKey) {
    const form = document.getElementById('active-comment-form');
    if (form) {
      e.preventDefault();
      submitComment();
      return;
    }
  }

  // Cmd+R — Reload current PR diff
  if (key === 'R' && isMeta && !e.shiftKey) {
    e.preventDefault();
    if (currentPrNumber) {
      showToast('Reloading PR…');
      loadPrByNumber(currentPrNumber, currentRepoKey);
    }
    return;
  }

  // Cmd+Shift+A — Approve
  if (key === 'A' && isMeta && e.shiftKey) {
    e.preventDefault();
    if (!btnApprove.disabled) btnApprove.click();
    return;
  }

  // Cmd+Shift+R — Request Changes
  if (key === 'R' && isMeta && e.shiftKey) {
    e.preventDefault();
    if (!btnRequestChanges.disabled) btnRequestChanges.click();
    return;
  }

  // Cmd+Shift+C — Comment (submit review as comment, not line comment)
  if (key === 'C' && isMeta && e.shiftKey) {
    e.preventDefault();
    if (!btnComment.disabled) btnComment.click();
    return;
  }

  // Cmd+Shift+Enter — Submit review (uses whichever button is focused or last used type)
  if (e.key === 'Enter' && isMeta && e.shiftKey) {
    e.preventDefault();
    const form = document.getElementById('active-comment-form');
    if (!form) {
      // No line comment open — submit review as comment
      if (!btnComment.disabled) submitReview('comment');
    }
    return;
  }

  // Cmd+] — Next comment
  if (key === ']' && isMeta && !e.shiftKey) {
    e.preventDefault();
    navigateToComment('next');
    return;
  }

  // Cmd+[ — Previous comment
  if (key === '[' && isMeta && !e.shiftKey) {
    e.preventDefault();
    navigateToComment('prev');
    return;
  }

  // Shift+? — show keyboard shortcuts dialog (with the meta modifier absent)
  if (key === '?' && !isMeta) {
    e.preventDefault();
    toggleShortcutsDialog();
    return;
  }
});

// Drag and drop
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer.files[0];
  if (file) {
    currentFileName = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => loadDiff(ev.target.result);
    reader.readAsText(file);
  }
});

// Load diff from main process (when opened with file argument)
window.electronAPI.onLoadDiff((data) => {
  if (data && data.content) {
    currentFileName = data.fileName || '';
    loadDiff(data.content, data.filePath);
  }
});

// ===================== BINARY CHECKS =====================

let ghMissing = false;
let noAgentFound = false;

function getPlatformInstructions() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) {
    return {
      gh: 'brew install gh',
      agents: {
        hermes: 'npm install -g @nousresearch/hermes-agent',
        claude: 'npm install -g @anthropic-ai/claude-code',
        cursor: 'brew install --cask cursor',
        copilot: 'npm install -g @githubnext/copilot-cli',
        aider: 'pip install aider-chat',
        codex: 'npm install -g @openai/codex',
      }
    };
  } else if (platform.includes('win')) {
    return {
      gh: 'winget install GitHub.cli',
      agents: {
        hermes: 'npm install -g @nousresearch/hermes-agent',
        claude: 'npm install -g @anthropic-ai/claude-code',
        cursor: 'winget install Cursor.Cursor',
        copilot: 'npm install -g @githubnext/copilot-cli',
        aider: 'pip install aider-chat',
        codex: 'npm install -g @openai/codex',
      }
    };
  } else {
    return {
      gh: 'sudo apt install gh  # or: sudo dnf install gh',
      agents: {
        hermes: 'npm install -g @nousresearch/hermes-agent',
        claude: 'npm install -g @anthropic-ai/claude-code',
        cursor: 'wget -q https://www.cursor.com/download -O cursor.deb && sudo dpkg -i cursor.deb',
        copilot: 'npm install -g @githubnext/copilot-cli',
        aider: 'pip install aider-chat',
        codex: 'npm install -g @openai/codex',
      }
    };
  }
}

function showErrorScreen(errors) {
  const screen = document.getElementById('error-screen');
  const content = document.getElementById('error-content');
  const retryBtn = document.getElementById('error-retry');

  let html = '';
  for (const err of errors) {
    html += `<div class="error-section">
      <h3>${err.title}</h3>
      <div class="error-msg">${err.message}</div>
      <div class="error-cmd">${err.cmd}</div>
    </div>`;
  }
  content.innerHTML = html;
  retryBtn.style.display = 'inline-block';
  screen.classList.add('visible');
}

function hideErrorScreen() {
  const screen = document.getElementById('error-screen');
  screen.classList.remove('visible');
}

async function checkBinariesAndMaybeShowError() {
  try {
    const { ghAvailable, availableAgents } = await window.electronAPI.checkBinaries();
    const platform = getPlatformInstructions();
    const errors = [];

    if (!ghAvailable) {
      ghMissing = true;
      errors.push({
        title: 'GitHub CLI (gh) is not installed',
        message: 'PR Reviewer requires the GitHub CLI to fetch pull requests. Install it with:',
        cmd: platform.gh
      });
    } else {
      ghMissing = false;
    }

    if (availableAgents.length === 0) {
      noAgentFound = true;
      errors.push({
        title: 'No AI agent found',
        message: 'PR Reviewer requires at least one AI agent for auto-fix and review features. Install one of:',
        cmd: Object.values(platform.agents).join('\n    ')
      });
    } else {
      noAgentFound = false;
    }

    if (errors.length > 0) {
      showErrorScreen(errors);
    } else {
      hideErrorScreen();
    }
  } catch (err) { console.error('[checkBinaries] Error checking binaries:', err.message); }
}

async function autoDetectAgent() {
  try {
    const result = await window.electronAPI.autoDetectAgent();
    if (result.detected) {
      // Update the select dropdown if it exists
      const select = document.getElementById('pref-ai-command');
      if (select) select.value = result.agent;
    }
  } catch (err) { console.warn('[autoDetectAgent] Agent auto-detection failed:', err.message); }
}

// Re-check on focus if previously missing
window.addEventListener('focus', async () => {
  if (ghMissing || noAgentFound) {
    await checkBinariesAndMaybeShowError();
  }
});

// Fetch config from main process
window.electronAPI.getConfig().then(async (config) => {
  appConfig = config; // Store for use in openPrDropdown(), refreshPrList(), etc.
  if (config.prNumber) prNumberInput.value = config.prNumber;
  if (config.aiTagPrefix) aiTagPrefix = config.aiTagPrefix;
  if (config.diff && config.diff.viewMode) currentDiffViewMode = config.diff.viewMode;
  // Note: fetchCollaborators() is called in loadPrByNumber() with the correct repoKey

  // Check binaries on startup
  await checkBinariesAndMaybeShowError();

  // Auto-detect AI agent if not configured
  await autoDetectAgent();

  // Load repos and pre-fetch PRs on startup
  try {
    const loadingToast = showToast('Loading pull requests…', 'progress', 30000);
    const { repos } = await window.electronAPI.listRepos();
    checkedRepos = (repos || []).filter(r => r.checked);
    console.log('[Startup] Checked repos:', checkedRepos.map(r => r.name).join(', ') || '(none)');
    {
      const reposToFetch = checkedRepos.length > 0
        ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
        : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
      const { prs, errors } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
      if (errors && errors.length > 0) console.warn('[Startup] Repo errors:', errors.map(e => `${e.repo}: ${e.error}`).join('; '));
      console.log('[Startup] Fetched', prs ? prs.length : 0, 'PRs on startup');
      if (loadingToast && loadingToast._dismiss) loadingToast._dismiss();
      if (prs && prs.length > 0) {
        cachedPrList = prs;
        cachedPrListTime = Date.now();
        // Auto-load first PR if none is loaded
        if (!currentPrNumber && prs.length > 0) {
          await loadPrByNumber(prs[0].number, prs[0].repo);
        }
      } else {
        showToast('No pull requests found', 'info', 5000);
      }
    }
  } catch (startupErr) {
    console.error('[Startup] Error:', startupErr);
    showToast(`Startup error: ${startupErr.message}`, 'error', 10000);
  }
}).catch((configErr) => {
  console.error('[Config] Error:', configErr);
});

// ===================== IMAGE PASTE =====================

function setupImagePaste(textarea) {
  const form = textarea.closest('.comment-form');

  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const existing = form.querySelector('.pasted-image');
      if (existing) existing.remove();
      const img = document.createElement('img');
      img.className = 'pasted-image';
      img.src = dataUrl;
      img.style.cssText = 'max-width:100%;max-height:200px;border-radius:4px;border:1px solid #30363d;margin-top:4px;display:block;cursor:pointer;';
      img.title = 'Click to remove';
      img.addEventListener('click', () => img.remove());
      const actions = form.querySelector('.actions');
      form.insertBefore(img, actions);
    };
    reader.readAsDataURL(file);
  }

  // Paste support
  textarea.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        handleImageFile(item.getAsFile());
        return;
      }
    }
  });

  // Drag-and-drop support on the textarea
  textarea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    textarea.style.borderColor = '#58a6ff';
  });

  textarea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    textarea.style.borderColor = '#30363d';
  });

  textarea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    textarea.style.borderColor = '#30363d';
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleImageFile(files[0]);
    }
  });
}

// ===================== @MENTION / COLLABORATOR TAGGING =====================

const mentionState = {
  active: false,
  textarea: null,
  query: '',
  startIndex: -1,
  selectedIndex: 0,
  filtered: [],
  dropdown: null
};

async function fetchCollaborators(repoKey) {
  try {
    collaborators = await window.electronAPI.getCollaborators(repoKey);
  } catch (e) {
    collaborators = [];
  }
}

function setupMentionHandling(textarea) {
  textarea.addEventListener('input', onMentionInput);
  textarea.addEventListener('keydown', onMentionKeydown);
  textarea.addEventListener('blur', () => {
    setTimeout(() => hideMentionDropdown(), 200);
  });
}

function onMentionInput(e) {
  const textarea = e.target;
  const value = textarea.value;
  const cursorPos = textarea.selectionStart;

  // Find @ before cursor, bounded by space/newline/start
  let atIndex = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    if (value[i] === '@') {
      atIndex = i;
      break;
    }
    if (value[i] === ' ' || value[i] === '\n') break;
  }

  if (atIndex === -1) {
    hideMentionDropdown();
    return;
  }

  const query = value.substring(atIndex + 1, cursorPos);
  if (query.includes(' ') || query.includes('\n')) {
    hideMentionDropdown();
    return;
  }

  mentionState.query = query;
  mentionState.startIndex = atIndex;
  mentionState.textarea = textarea;

  const filtered = collaborators.filter(c =>
    c.login.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 10);

  if (filtered.length === 0) {
    hideMentionDropdown();
    return;
  }

  mentionState.filtered = filtered;
  mentionState.selectedIndex = 0;
  mentionState.active = true;

  showMentionDropdown(textarea, filtered);
}

function showMentionDropdown(textarea, items) {
  if (!mentionState.dropdown) {
    mentionState.dropdown = document.createElement('div');
    mentionState.dropdown.id = 'mention-dropdown';
    document.body.appendChild(mentionState.dropdown);
  }

  const rect = textarea.getBoundingClientRect();
  const dropdown = mentionState.dropdown;

  dropdown.style.top = (rect.bottom + 4) + 'px';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.minWidth = Math.min(rect.width, 300) + 'px';

  dropdown.innerHTML = items.map((item, i) => `
    <div class="mention-item${i === 0 ? ' active' : ''}" data-index="${i}" data-login="${escapeHtml(item.login)}">
      <img class="mention-avatar" src="${item.avatar_url}" alt="">
      <span class="mention-username">${escapeHtml(item.login)}</span>
    </div>
  `).join('');

  dropdown.style.display = 'block';

  // Add click handlers
  dropdown.querySelectorAll('.mention-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectMention(el.dataset.login);
    });
  });
}

function hideMentionDropdown() {
  mentionState.active = false;
  if (mentionState.dropdown) {
    mentionState.dropdown.style.display = 'none';
  }
}

function onMentionKeydown(e) {
  if (!mentionState.active) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation(); // Don't close the comment dialog
    hideMentionDropdown();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    mentionState.selectedIndex = Math.min(mentionState.selectedIndex + 1, mentionState.filtered.length - 1);
    updateMentionHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    mentionState.selectedIndex = Math.max(mentionState.selectedIndex - 1, 0);
    updateMentionHighlight();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectMention(mentionState.filtered[mentionState.selectedIndex].login);
  }
}

function updateMentionHighlight() {
  if (!mentionState.dropdown) return;
  mentionState.dropdown.querySelectorAll('.mention-item').forEach((el, i) => {
    el.classList.toggle('active', i === mentionState.selectedIndex);
  });
  const activeEl = mentionState.dropdown.querySelector('.mention-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function selectMention(login) {
  const textarea = mentionState.textarea;
  const value = textarea.value;
  const before = value.substring(0, mentionState.startIndex);
  const after = value.substring(textarea.selectionStart);

  textarea.value = before + '@' + login + ' ' + after;
  textarea.selectionStart = textarea.selectionEnd = (before + '@' + login + ' ').length;

  hideMentionDropdown();
  textarea.focus();
}

// ===================== COMMENT NAVIGATION =====================

function updateCommentNav() {
  const count = comments.length;
  if (count === 0) {
    commentNav.style.display = 'none';
    currentCommentIndex = -1;
    return;
  }
  commentNav.style.display = 'inline-flex';
  commentNav.style.alignItems = 'center';
  if (currentCommentIndex >= count) currentCommentIndex = count - 1;
  if (currentCommentIndex < 0) currentCommentIndex = 0;
  commentNavLabel.textContent = `${currentCommentIndex + 1} / ${count}`;
}

function navigateToComment(direction) {
  const count = comments.length;
  if (count === 0) return;

  if (direction === 'next') {
    currentCommentIndex = (currentCommentIndex + 1) % count;
  } else {
    currentCommentIndex = (currentCommentIndex - 1 + count) % count;
  }

  updateCommentNav();

  // Find and scroll to the marker
  const currentComment = comments[currentCommentIndex];
  if (!currentComment) return;
  const markers = document.querySelectorAll('[data-comment-uid]');
  for (const m of markers) {
    if (parseInt(m.dataset.commentUid, 10) === currentComment._uid) {
      m.scrollIntoView({ behavior: 'instant', block: 'center' });
      // Brief highlight
      m.style.outline = '2px solid #58a6ff';
      setTimeout(() => { m.style.outline = ''; }, 1500);
      return;
    }
  }
}

btnPrevComment.addEventListener('click', () => navigateToComment('prev'));
btnNextComment.addEventListener('click', () => navigateToComment('next'));

// ===================== EXPORT AS MARKDOWN =====================

async function exportAsMarkdown() {
  const prNumber = prNumberInput.value.trim();
  const prNum = prNumber || 'unknown';
  const reviewBodyText = reviewBody.value.trim();
  const type = 'comment'; // Default type for export

  let md = `# PR #${prNum} Review\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Files changed:** ${(currentDiff.match(/diff --git/g) || []).length}\n\n`;

  if (reviewBodyText) {
    md += `## Review Summary\n\n${reviewBodyText}\n\n`;
  }

  // Group comments by file
  const byFile = {};
  for (const c of comments) {
    if (!byFile[c.file]) byFile[c.file] = [];
    byFile[c.file].push(c);
  }

  const prComments = comments.filter(c => !c.isAiTagged);
  const aiComments = comments.filter(c => c.isAiTagged);

  if (prComments.length > 0) {
    md += `## Line & File Comments (${prComments.length})\n\n`;
    for (const [file, fileComments] of Object.entries(byFile)) {
      const prFileComments = fileComments.filter(c => !c.isAiTagged);
      if (prFileComments.length === 0) continue;
      md += `### ${file}\n\n`;
      for (const c of prFileComments) {
        if (c.level === 'file') {
          md += `**File-level comment:**\n> ${c.text}\n\n`;
        } else {
          md += `**Line ${c.line}** (${c.side}):\n`;
          if (c.codeContext) {
            md += `\`\`\`\n${c.codeContext}\n\`\`\`\n`;
          }
          md += `> ${c.text}\n\n`;
          if (c.imageDataUrl) {
            const imgName = `comment-${comments.indexOf(c)}-${Date.now()}.png`;
            const imgResult = await window.electronAPI.saveImage({
              reviewDir: null, imageDataUrl: c.imageDataUrl, fileName: imgName
            });
            // Prefer S3 URL (works in GitHub markdown), fall back to local path
            const imgRef = (imgResult && imgResult.url) || (imgResult && imgResult.localPath) || null;
            if (imgRef) {
              md += `![comment image](${imgRef})\n\n`;
            } else {
              md += `*(image could not be saved)*\n\n`;
            }
          }
        }
      }
    }
  }

  if (aiComments.length > 0) {
    md += `## AI-Tagged Comments (${aiComments.length})\n\n`;
    for (const c of aiComments) {
      if (c.level === 'file') {
        md += `**${c.file}** — ${c.text}\n\n`;
      } else {
        md += `**${c.file}:${c.line}** (${c.side}) — ${c.text}\n\n`;
      }
    }
  }

  const defaultName = `pr-${prNum}-review.md`;
  const savedPath = await window.electronAPI.exportMarkdown({ markdown: md, defaultName });
  if (savedPath) {
    prInfo.innerHTML = `<strong style="color:#3fb950">✓ Exported to ${savedPath.split('/').pop()}</strong>`;
  }
}

// ===================== SHOW/HIDE BUTTONS =====================

function showReviewButtons() {
  btnApprove.style.display = 'inline-block';
  btnRequestChanges.style.display = 'inline-block';
  btnComment.style.display = 'inline-block';
  // The PR-wide comment icon only makes sense when a PR is loaded
  if (btnPrComment) btnPrComment.style.display = 'inline-flex';
}

// ===================== PR LOADING =====================

const NEXT_PR_EDGE_PX = 60; // distance from screen edge (px) that reveals an arrow

// Current position within cachedPrList, used to resolve prev/next.
let currentPrIndex = -1;
// Declared here (before the arrow functions reference them) to avoid a
// temporal-dead-zone error when loadDiff/updatePrArrowStates run early.
let cachedPrList = null;
let currentPrNumber = null;

// ===== Diff loading indicator =====
function showDiffLoading(text) {
  const el = document.getElementById('diff-loading');
  if (!el) return;
  const t = document.getElementById('diff-loading-text');
  if (t) t.textContent = text || 'Loading diff…';
  el.classList.add('show');
  const dc = document.getElementById('diff-container');
  if (dc) dc.style.display = 'none';
  const ff = document.getElementById('filtered-files-notice');
  if (ff) ff.style.display = 'none';
}
function hideDiffLoading() {
  const el = document.getElementById('diff-loading');
  if (el) el.classList.remove('show');
  const dc = document.getElementById('diff-container');
  if (dc) dc.style.display = '';
}

// Celebratory screen shown when every PR has been reviewed. Clears the diff and
// hides all the stale UI, then shows a green checkmark + "All caught up!".
function showAllDoneState() {
  currentPrNumber = null;
  currentPrTitle = '';
  const ad = document.getElementById('all-done-state');
  const es = document.getElementById('empty-state');
  const dc = document.getElementById('diff-container');
  const loading = document.getElementById('diff-loading');
  const ff = document.getElementById('filtered-files-notice');
  // Clear the previous PR's content
  if (dc) { dc.innerHTML = ''; dc.style.display = 'none'; }
  if (loading) loading.classList.remove('show');
  if (ff) ff.style.display = 'none';
  if (es) es.style.display = 'none';
  if (ad) ad.style.display = 'flex';
  if (fileSidebarList) fileSidebarList.innerHTML = '';
  // Hide the review buttons + PR comment icon — there's no PR to act on
  if (btnPrComment) btnPrComment.style.display = 'none';
  if (btnApprove) btnApprove.style.display = 'none';
  if (btnRequestChanges) btnRequestChanges.style.display = 'none';
  if (btnComment) btnComment.style.display = 'none';
  prInfo.innerHTML = '<strong style="color:#3fb950">All caught up!</strong>';
  resetButtons();
  closeReviewHistoryDropdown();
  updatePrArrowStates();
}

// ===== Edge arrows: next (right) / prev (left) =====
const prevPrArrow = document.getElementById('prev-pr-arrow');
const nextPrArrow = document.getElementById('next-pr-arrow');

function currentIndexInList() {
  if (!cachedPrList || currentPrNumber == null) return -1;
  return cachedPrList.findIndex(pr => String(pr.number) === String(currentPrNumber));
}

// Enable/disable arrows based on whether a prev/next PR actually exists.
// Arrows still reveal on edge hover, but appear disabled when at the ends.
function updatePrArrowStates() {
  const idx = currentIndexInList();
  const listLen = cachedPrList ? cachedPrList.length : 0;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < listLen - 1;
  // Fallback: if the current PR isn't in the list but there are PRs, allow next.
  const anyNext = listLen > 0 && idx < 0;
  if (prevPrArrow) prevPrArrow.classList.toggle('disabled', !hasPrev);
  if (nextPrArrow) nextPrArrow.classList.toggle('disabled', !(hasNext || anyNext));
}

function gotoNextPr() {
  if (!cachedPrList || cachedPrList.length === 0) return;
  const idx = currentIndexInList();
  let nextPr = null;
  if (idx >= 0 && idx < cachedPrList.length - 1) nextPr = cachedPrList[idx + 1];
  else if (idx < 0) nextPr = cachedPrList[0]; // current PR not in list → first pending
  if (!nextPr) { showToast('No next PR', 'info'); return; }
  showDiffLoading('Loading next PR #' + nextPr.number + '…');
  loadPrByNumber(nextPr.number, nextPr.repo)
    .catch(advanceErr => {
      console.error('[next-pr] Failed to load next PR:', advanceErr);
      hideDiffLoading();
      prInfo.innerHTML = `<strong style="color:#f85149">Error loading next PR:</strong> ${escapeHtml(advanceErr.message)}`;
      resetButtons();
    });
}

function gotoPrevPr() {
  if (!cachedPrList || cachedPrList.length === 0) return;
  const idx = currentIndexInList();
  if (idx <= 0) { showToast('No previous PR', 'info'); return; }
  const prevPr = cachedPrList[idx - 1];
  showDiffLoading('Loading previous PR #' + prevPr.number + '…');
  loadPrByNumber(prevPr.number, prevPr.repo)
    .catch(advanceErr => {
      console.error('[prev-pr] Failed to load previous PR:', advanceErr);
      hideDiffLoading();
      prInfo.innerHTML = `<strong style="color:#f85149">Error loading previous PR:</strong> ${escapeHtml(advanceErr.message)}`;
      resetButtons();
    });
}

if (prevPrArrow) prevPrArrow.addEventListener('click', gotoPrevPr);
if (nextPrArrow) nextPrArrow.addEventListener('click', gotoNextPr);

document.addEventListener('mousemove', (e) => {
  // Only reveal arrows when the cursor is in the main content area, i.e. BELOW
  // the top review bar. Moving the mouse to an edge inside the header shouldn't
  // show the prev/next arrows.
  const barH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--review-bar-height')) || 52;
  const inContent = e.clientY > barH;
  const nearRight = e.clientX >= (window.innerWidth - NEXT_PR_EDGE_PX);
  const nearLeft = e.clientX <= NEXT_PR_EDGE_PX;
  if (nextPrArrow) nextPrArrow.classList.toggle('visible', inContent && nearRight);
  if (prevPrArrow) prevPrArrow.classList.toggle('visible', inContent && nearLeft);
});
// Hide both again once the cursor leaves the window
document.addEventListener('mouseleave', () => {
  if (nextPrArrow) nextPrArrow.classList.remove('visible');
  if (prevPrArrow) prevPrArrow.classList.remove('visible');
});
updatePrArrowStates();

const btnPrList = document.getElementById('btn-pr-list');
const prDropdown = document.getElementById('pr-dropdown');
let prDropdownOpen = false;

// Enter in PR number input loads that PR
prNumberInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const num = parseInt(prNumberInput.value.trim(), 10);
    if (num > 0) {
      await loadPrByNumber(num);
    }
  }
});

async function loadPrByNumber(prNumber, repoKey) {
  console.log('[loadPr] Loading PR #' + prNumber, 'repo:', repoKey || 'default');
  clearAiChat(); // Reset AI chat for the new PR — stale branch/PR context shouldn't linger
  // Show the loading indicator immediately so the previous PR's diff doesn't
  // linger while the next one loads (the title bar changes before the diff).
  showDiffLoading('Loading PR #' + prNumber + '…');
  prInfo.innerHTML = `<strong>Loading PR #${prNumber}...</strong>`;
  const loadingToast = showToast('Loading PR…', 'progress', 30000);

  try {
    // Phase 1: Fetch metadata first (~1-2s) — title, author, assignees
    // This shows the user key info immediately while the diff loads
    let prMeta = null;
    if (window.electronAPI.getPrInfo) {
      try {
        prMeta = await window.electronAPI.getPrInfo({ prNumber, repo: repoKey });
        if (prMeta && !prMeta.error) {
          // Update UI immediately with metadata
          currentPrTitle = prMeta.prTitle || '';
          currentPrNumber = prNumber;
          currentRepoKey = repoKey || null;
          currentPrBody = prMeta.prBody || '';
          document.title = currentPrTitle ? `${currentPrTitle} — PR Reviewer` : `PR Reviewer — PR #${prNumber}`;
          prNumberInput.value = prNumber;
          // Show title/author immediately — diff count will update when diff arrives
          updatePrInfoBar(prNumber, currentPrTitle, {
            prAuthor: prMeta.prAuthor,
            prAssignees: prMeta.prAssignees,
            filesChanged: prMeta.filesChanged,
            reviewInfo: null // Will be set when diff loads
          });
          // Start review comments fetch early (doesn't depend on diff)
          fetchAndDisplayReviewComments(prNumber, repoKey).catch((err) => { console.warn('[loadPr] Failed to fetch review comments:', err.message); });
          // Load commits early
          loadPrCommits(prNumber);
          // Fetch collaborators early
          if (repoKey) fetchCollaborators(repoKey);
          console.log('[loadPr] Metadata loaded for PR #' + prNumber + ':', currentPrTitle);
        }
      } catch (metaErr) {
        console.warn('[loadPr] Fast metadata fetch failed, will get from diff:', metaErr.message);
      }
    }

    // Phase 2: Load the diff (may be instant from prefetch cache, or 10-30s)
    const result = await window.electronAPI.loadPr({ prNumber, repo: repoKey });
    if (result.error) {
      prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${escapeHtml(result.error)}`;
      if (loadingToast && loadingToast._dismiss) loadingToast._dismiss();
      resetButtons();
      return;
    }
    currentFileName = result.fileName || `pr-${prNumber}.diff`;
    currentDiffContent = result.content;
    currentDiffFilePath = result.filePath;
    currentRepoPath = result.repoPath || null;
    currentBaseSha = result.baseSha || null;
    currentHeadSha = result.headSha || null;
    allExtensionsInDiff = extractExtensionsFromDiff(result.content);
    loadDiff(result.content, result.filePath);

    // Store PR metadata (from diff result, in case fast metadata wasn't available)
    if (!currentPrTitle) currentPrTitle = result.prTitle || '';
    if (!currentPrNumber) currentPrNumber = prNumber;
    if (!currentRepoKey) currentRepoKey = repoKey || null;
    if (!currentPrBody) currentPrBody = result.prBody || '';

    // Check for saved PR draft (persists across app restarts)
    try {
      const prDraft = await window.electronAPI.loadPrDraft(prNumber);
      if (prDraft && prDraft.comments && prDraft.comments.length > 0) {
        // Clear any comments restored from file-based draft
        comments = [];
        diffContainer.querySelectorAll('.line-comment-marker, .file-comment-marker').forEach(el => el.remove());
        if (prDraft.reviewBody) reviewBody.value = prDraft.reviewBody;
        restoreDraft({ comments: prDraft.comments });
      }
    } catch (err) {
      console.warn('[loadPr] No PR draft or failed to load:', err.message);
    }

    // Download GitHub-attached images to local files (they need auth to access)
    if (currentPrBody.includes('github.com/user-attachments/')) {
      try {
        const dlResult = await window.electronAPI.downloadGithubImages({ prBody: currentPrBody });
        if (dlResult.prBody) currentPrBody = dlResult.prBody;
      } catch (err) {
        console.warn('[pr] Image download failed:', err.message);
      }
    }

    // Detect before/after image pairs in PR body
    beforeAfterPairs = detectBeforeAfterPairs(currentPrBody);

    // Update title bar (may already be set from fast metadata, now we have full info)
    document.title = currentPrTitle ? `${currentPrTitle} — PR Reviewer` : `PR Reviewer — PR #${prNumber}`;
    prNumberInput.value = prNumber;

    // Build info bar with full data (including review info from diff)
    updatePrInfoBar(prNumber, currentPrTitle, result);

    // Fetch collaborators and review comments if not already started
    if (!prMeta || prMeta.error) {
      if (repoKey) fetchCollaborators(repoKey);
      fetchAndDisplayReviewComments(prNumber, repoKey).catch((err) => { console.warn('[loadPr] Failed to fetch review comments:', err.message); });
      loadPrCommits(prNumber);
    }

    if (loadingToast && loadingToast._dismiss) loadingToast._dismiss();

    // Phase 3: Prefetch the next PR in the list
    prefetchNextPr(prNumber, repoKey);
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${escapeHtml(err.message)}`;
    if (loadingToast && loadingToast._dismiss) loadingToast._dismiss();
    resetButtons();
  }
}

// Prefetch the next PR in the cached list so it loads instantly when auto-advancing
function prefetchNextPr(currentPrNumber, currentRepoKey) {
  if (!cachedPrList || cachedPrList.length === 0) return;
  const nextPr = cachedPrList.find(pr => pr.number !== currentPrNumber);
  if (!nextPr) return;
  if (!window.electronAPI.prefetchPr) return;
  console.log('[prefetch] Starting background fetch for next PR #' + nextPr.number);
  window.electronAPI.prefetchPr({ prNumber: nextPr.number, repo: nextPr.repo || currentRepoKey })
    .then(result => {
      if (result.error) {
        console.warn('[prefetch] Failed for PR #' + nextPr.number + ':', result.error);
      } else {
        console.log('[prefetch] PR #' + nextPr.number + ' ready:', result.status);
      }
    })
    .catch(err => console.warn('[prefetch] Error:', err.message));
}

// PR dropdown toggle
btnPrList.addEventListener('click', async (e) => {
  e.stopPropagation();
  closeRepoDropdown(); // Close repo dropdown when opening PR dropdown
  if (prDropdownOpen) {
    closePrDropdown();
  } else {
    await openPrDropdown();
  }
});

function closePrDropdown() {
  prDropdown.classList.remove('open');
  prDropdownOpen = false;
}

async function openPrDropdown() {
  // Position dropdown directly under the ▾ button
  const btnRect = btnPrList.getBoundingClientRect();
  prDropdown.style.top = (btnRect.bottom + 4) + 'px';
  prDropdown.style.right = (window.innerWidth - btnRect.right) + 'px';
  prDropdown.style.left = 'auto';

  prDropdown.classList.add('open');
  prDropdownOpen = true;

  // Clear search when opening
  const searchInput = document.getElementById('pr-search');
  if (searchInput) searchInput.value = '';

  // Show cached results immediately, then fetch fresh data in background
  if (cachedPrList) {
    renderPrList(cachedPrList);
  }

  // Always fetch fresh data in background and update
  try {
    const reposToFetch = checkedRepos.length > 0
      ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
      : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
    const { prs, errors } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
    if (errors && errors.length > 0) {
      console.warn('[PR dropdown] Repo errors:', errors.map(e => `${e.repo}: ${e.error}`).join('; '));
    }
    if (prs && prs.length > 0) {
      cachedPrList = prs;
      cachedPrListTime = Date.now();
    } else if (prs && prs.length === 0) {
      cachedPrList = [];
      cachedPrListTime = Date.now();
    }
    // Re-render with fresh data if dropdown is still open
    if (prDropdownOpen) {
      const currentSearch = document.getElementById('pr-search')?.value || '';
      renderPrList(cachedPrList, currentSearch);
    }
  } catch (err) {
    console.error('[PR dropdown] Fetch error:', err);
  }
}

// Refresh PR list in background (update cache and re-render if dropdown is open)
async function refreshPrList() {
  try {
    const reposToFetch = checkedRepos.length > 0
      ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
      : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
    const { prs, errors } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
    if (errors && errors.length > 0) console.warn('[refreshPrList] Repo errors:', errors.map(e => `${e.repo}: ${e.error}`).join('; '));
    if (!prs) return null;
    cachedPrList = prs;
    cachedPrListTime = Date.now();
    if (prDropdownOpen) {
      const searchInput = document.getElementById('pr-search');
      renderPrList(prs, searchInput ? searchInput.value : '');
    }
    return prs;
  } catch { return null; }
}

// Render PR list into the dropdown
function renderPrList(prs, filterText) {
  const searchValue = (filterText || '').toLowerCase().trim();

  // Filter PRs by search text (title, author, number, repo, assignees)
  let filtered = prs || [];
  if (searchValue) {
    filtered = prs.filter(pr => {
      const title = (pr.title || '').toLowerCase();
      const author = (pr.author || '').toLowerCase();
      const num = String(pr.number);
      const repo = (pr.repo || '').toLowerCase();
      const assignees = (pr.assignees || []).join(' ').toLowerCase();
      return title.includes(searchValue) || author.includes(searchValue) || num.includes(searchValue) || repo.includes(searchValue) || assignees.includes(searchValue);
    });
  }

  if (!prs || prs.length === 0) {
    prDropdown.innerHTML = `
      <div class="pr-search-wrapper">
        <span class="search-icon"><svg viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
        <input type="text" id="pr-search" placeholder="Search PRs by title, author, or number...">
      </div>
      <div class="pr-dropdown-header">Pull Requests Pending Review</div>
      <div class="pr-empty">No PRs match your filter</div>`;
    return;
  }

  const hasMultipleRepos = checkedRepos.length > 1;
  let html = `
    <div class="pr-search-wrapper">
      <span class="search-icon"><svg viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
      <input type="text" id="pr-search" placeholder="Search PRs by title, author, or number..." value="${escapeHtml(searchValue)}">
    </div>
    <div class="pr-dropdown-header">Pull Requests Pending Review (${filtered.length}${searchValue ? ' of ' + prs.length : ''})</div>`;
  for (const pr of filtered) {
    const date = new Date(pr.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const draft = pr.draft ? '<span class="pr-draft">DRAFT</span>' : '';
    const repoLabel = hasMultipleRepos && pr.repo ? `<span class="pr-repo-label"> ${escapeHtml(pr.repo)}</span>` : '';
    const assignees = (pr.assignees || []).filter(a => a !== pr.author);
    const assigneeLabel = assignees.length > 0 ? `<span class="pr-assignees"> → ${assignees.map(a => escapeHtml(a)).join(', ')}</span>` : '';
    html += `
      <div class="pr-item" data-pr="${pr.number}" data-repo="${pr.repo || ''}">
        <div class="pr-item-content">
          <div class="pr-title">${escapeHtml(pr.title)}${draft}</div>
          <div class="pr-meta">
            <span class="pr-number">#${pr.number}</span>
            <span class="pr-author"> by ${escapeHtml(pr.author)}</span>${assigneeLabel}${repoLabel}
            <span> · ${date}</span>
          </div>
        </div>
        <button class="pr-new-window-btn" data-pr="${pr.number}" title="Open in new window">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
        </button>
      </div>`;
  }
  if (filtered.length === 0 && searchValue) {
    html += `<div class="pr-empty">No PRs match "${escapeHtml(searchValue)}"</div>`;
  }
  prDropdown.innerHTML = html;

  // Wire up search input
  const searchInput = document.getElementById('pr-search');
  if (searchInput) {
    searchInput.focus();
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderPrList(cachedPrList, searchInput.value);
      }, 200);
    });
    // Prevent clicks inside search from closing dropdown
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    // Restore cursor position after re-render
    if (searchValue) {
      searchInput.setSelectionRange(searchValue.length, searchValue.length);
    }
  }

  // Wire up click handlers
  prDropdown.querySelectorAll('.pr-item-content').forEach(content => {
    content.addEventListener('click', async () => {
      const prItem = content.closest('.pr-item');
      const num = parseInt(prItem.dataset.pr, 10);
      const repo = prItem.dataset.repo || '';
      closePrDropdown();
      await loadPrByNumber(num, repo);
    });
  });

  // Wire up new window buttons
  prDropdown.querySelectorAll('.pr-new-window-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const num = parseInt(btn.dataset.pr, 10);
      closePrDropdown();
      // Opening in a browser switches to the new page immediately, so no toast
      // is needed — the user sees the PR open. Don't touch prInfo (the top-left
      // title/author bar) either; the browser opening is self-evident.
      const result = await window.electronAPI.openPrNewWindow(num);
      if (result.error) {
        showToast(`Error opening PR #${num}: ${result.error}`, 'error', 8000);
      }
    });
  });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (prDropdownOpen && !prDropdown.contains(e.target) && e.target !== btnPrList) {
    closePrDropdown();
  }
});

// Handle menu "Open Diff" trigger
window.electronAPI.onTriggerOpenFile(async () => {
  const result = await window.electronAPI.openFile();
  if (result && result.content) {
    currentFileName = result.fileName || '';
    loadDiff(result.content, result.filePath);
  }
});

// ===================== FILE EXTENSION FILTER =====================

const btnFileFilter = document.getElementById('btn-file-filter');
const fileFilterDropdown = document.getElementById('file-filter-dropdown');
const filterList = document.getElementById('filter-list');
const filterSelectAll = document.getElementById('filter-select-all');
const filterSelectNone = document.getElementById('filter-select-none');

let fileFilterOpen = false;
// Persist active extensions across PR loads via localStorage
// null = show all, [...] = show only these extensions, [] = stale/broken → treat as null
let activeExtensions = (() => {
  try {
    const stored = localStorage.getItem('pr-reviewer-active-extensions');
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    // Empty array is a stale state — treat as "show all"
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch { return null; }
})();
let allExtensionsInDiff = [];
// Update filter button on startup in case extensions were persisted
setTimeout(() => { if (typeof updateFilterButtonState === 'function') updateFilterButtonState(); }, 0);

function saveActiveExtensions() {
  try {
    localStorage.setItem('pr-reviewer-active-extensions', JSON.stringify(activeExtensions));
  } catch { /* ignore quota errors */ }
}

// Extract extensions from diff content
function extractExtensionsFromDiff(diffContent) {
  const extensions = new Set();
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      const filePath = line.substring(6);
      const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '(no ext)';
      extensions.add(ext);
    }
  }
  return Array.from(extensions).sort();
}

// Open/close file filter dropdown
btnFileFilter.addEventListener('click', (e) => {
  e.stopPropagation();
  if (fileFilterOpen) {
    closeFileFilterDropdown();
  } else {
    openFileFilterDropdown();
  }
});

function closeFileFilterDropdown() {
  fileFilterDropdown.classList.remove('open');
  fileFilterOpen = false;
}

function openFileFilterDropdown() {
  // Position dropdown under the button
  const btnRect = btnFileFilter.getBoundingClientRect();
  fileFilterDropdown.style.top = (btnRect.bottom + 4) + 'px';
  fileFilterDropdown.style.right = (window.innerWidth - btnRect.right) + 'px';
  fileFilterDropdown.style.left = 'auto';

  fileFilterDropdown.classList.add('open');
  fileFilterOpen = true;

  // Only show extensions that exist in the current diff
  const extensionsToShow = allExtensionsInDiff.length > 0 ? allExtensionsInDiff : [];

  let html = '';
  for (const ext of extensionsToShow) {
    // If activeExtensions is null (blank config), check all
    // If activeExtensions is an array, only check those in the array
    const checked = (activeExtensions === null || activeExtensions.includes(ext)) ? 'checked' : '';
    html += `
      <div class="filter-item">
        <input type="checkbox" id="ext-${ext}" value="${ext}" ${checked}>
        <label for="ext-${ext}">${ext}</label>
      </div>`;
  }
  filterList.innerHTML = html;

  // Auto-apply on checkbox change
  filterList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', applyExtensionFilter);
  });

  // Normalize: if all diff extensions are checked, treat as "no filter"
  const allCheckedNow = extensionsToShow.length > 0 &&
    extensionsToShow.every(ext => {
      const cb = filterList.querySelector(`input[value="${ext}"]`);
      return cb && cb.checked;
    });
  if (allCheckedNow || extensionsToShow.length === 0) {
    activeExtensions = null;
    saveActiveExtensions();
  }

  // Update button state
  updateFilterButtonState();
}

// Update filter button appearance
function updateFilterButtonState() {
  // null means show all (blank config), array means filtered
  const isFiltered = activeExtensions !== null;
  btnFileFilter.classList.toggle('active', isFiltered);
}

// Select all
filterSelectAll.addEventListener('click', () => {
  filterList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
  });
  applyExtensionFilter();
});

// Select none
filterSelectNone.addEventListener('click', () => {
  filterList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  applyExtensionFilter();
});

// Apply extension filter (called on checkbox change, select all/none)
function applyExtensionFilter() {
  const selected = [];
  filterList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push(cb.value);
  });
  // If all or none selected, set to null (show all)
  const allChecked = selected.length === allExtensionsInDiff.length;
  const noneChecked = selected.length === 0;
  activeExtensions = allChecked ? null : (noneChecked ? [] : selected);
  saveActiveExtensions();
  updateFilterButtonState();

  // Re-render the diff with filtered extensions
  if (currentDiffContent) {
    renderFilteredDiff();
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (fileFilterOpen && !fileFilterDropdown.contains(e.target) && e.target !== btnFileFilter && e.target !== document.getElementById('file-name-filter')) {
    closeFileFilterDropdown();
  }
});

// ===================== FILE NAME FILTER =====================

const fileNameFilterInput = document.getElementById('file-name-filter');
let fileNameFilterDebounceTimer = null;
let currentNameFilter = '';

// Debounced input handler (200ms)
fileNameFilterInput.addEventListener('input', () => {
  clearTimeout(fileNameFilterDebounceTimer);
  fileNameFilterDebounceTimer = setTimeout(() => {
    currentNameFilter = fileNameFilterInput.value.trim().toLowerCase();
    applyFileNameFilter();
  }, 200);
});

// Prevent dropdown from closing when clicking inside the input
fileNameFilterInput.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Apply the combined name + extension filter
function applyFileNameFilter() {
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  const fileListLinks = document.querySelectorAll('.d2h-file-list .d2h-file-link');

  // Compute excluded extensions for combined filtering
  const excludedExts = activeExtensions
    ? (allExtensionsInDiff || []).filter(e => !activeExtensions.includes(e))
    : [];

  fileWrappers.forEach(wrapper => {
    const fileNameEl = wrapper.querySelector('.d2h-file-name');
    if (!fileNameEl) return;
    const fileName = fileNameEl.textContent.trim();
    const fileNameLower = fileName.toLowerCase();
    const matchesName = !currentNameFilter || fileNameLower.includes(currentNameFilter);
    // Also check extension filter
    let matchesExt = true;
    if (excludedExts.length > 0) {
      const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
      if (ext && excludedExts.includes(ext)) matchesExt = false;
    }
    wrapper.style.display = (matchesName && matchesExt) ? '' : 'none';
  });

  // Also hide/show corresponding file list entries
  fileListLinks.forEach(link => {
    const linkName = link.textContent.trim().toLowerCase();
    const matchesName = !currentNameFilter || linkName.includes(currentNameFilter);
    const listItem = link.closest('li') || link.parentElement;
    if (listItem) {
      listItem.style.display = matchesName ? '' : 'none';
    }
  });
}

// Store current diff content for re-rendering
let currentDiffContent = null;
let currentDiffFilePath = null;
let currentDiffViewMode = 'unified';
let currentPrTitle = '';
let cachedPrListTime = 0;
// PR cache never expires — only invalidated by repo changes or manual refresh
let currentRepoKey = null;
let currentPrBody = '';
let currentRepoPath = null;
let currentBaseSha = null;
let currentHeadSha = null;
const fileContextLevels = new Map(); // filename -> current context lines count

// ===================== MULTI-REPO STATE =====================

let allRepos = []; // All repos from config
let checkedRepos = []; // Currently checked repos
let repoDropdownOpen = false;

const btnRepos = document.getElementById('btn-repos');
const repoDropdown = document.getElementById('repo-dropdown');
const repoListEl = document.getElementById('repo-list');
const repoAddToggle = null;
const repoAddForm = null;

async function loadRepos() {
  try {
    const { repos } = await window.electronAPI.listRepos();
    allRepos = repos || [];
    checkedRepos = allRepos.filter(r => r.checked);
  } catch {
    allRepos = [];
    checkedRepos = [];
  }
}

function renderRepoDropdown(filterText) {
  const searchValue = (filterText || '').toLowerCase().trim();
  let filtered = allRepos;
  if (searchValue) {
    filtered = allRepos.filter(r => {
      const key = `${r.owner}/${r.name}`.toLowerCase();
      return key.includes(searchValue);
    });
  }

  let html = '';
  for (const repo of filtered) {
    const key = `${repo.owner}/${repo.name}`;
    const checked = repo.checked ? 'checked' : '';
    html += `
      <div class="repo-item" data-repo-key="${key}">
        <input type="checkbox" id="repo-cb-${key}" ${checked} data-owner="${repo.owner}" data-name="${repo.name}">
        <label for="repo-cb-${key}" class="repo-name">${repo.owner}/${repo.name}</label>
      </div>`;
  }
  if (filtered.length === 0 && searchValue) {
    html = `<div class="pr-empty" style="padding:12px">No repos match "${escapeHtml(searchValue)}"</div>`;
  }
  repoListEl.innerHTML = html;

  // Wire up checkbox handlers (auto-apply)
  repoListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const owner = cb.dataset.owner;
      const name = cb.dataset.name;
      const repo = allRepos.find(r => r.owner === owner && r.name === name);
      if (repo) {
        repo.checked = cb.checked;
      }
      checkedRepos = allRepos.filter(r => r.checked);
      await window.electronAPI.saveRepos(allRepos);
      // Invalidate PR cache and re-fetch
      cachedPrList = null;
      cachedPrListTime = 0;
      if (prDropdownOpen) {
        await openPrDropdown();
      }
    });
  });

  // Wire up search input
  const searchInput = document.getElementById('repo-search');
  if (searchInput) {
    searchInput.focus();
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderRepoDropdown(searchInput.value);
      }, 200);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    if (searchValue) {
      searchInput.setSelectionRange(searchValue.length, searchValue.length);
    }
  }
}

function toggleRepoDropdown() {
  if (repoDropdownOpen) {
    closeRepoDropdown();
  } else {
    closePrDropdown(); // Close PR dropdown when opening repo dropdown
    openRepoDropdown();
  }
}

function openRepoDropdown() {
  const btnRect = btnRepos.getBoundingClientRect();
  repoDropdown.style.top = (btnRect.bottom + 4) + 'px';
  repoDropdown.style.right = (window.innerWidth - btnRect.right) + 'px';
  repoDropdown.style.left = 'auto';
  repoDropdown.classList.add('open');
  repoDropdownOpen = true;
  renderRepoDropdown();
}

function closeRepoDropdown() {
  repoDropdown.classList.remove('open');
  repoDropdownOpen = false;
}

// Refresh PRs when app regains focus after 30+ minutes
window.addEventListener('focus', async () => {
  const THIRTY_MIN = 30 * 60 * 1000;
  if (cachedPrListTime && (Date.now() - cachedPrListTime) > THIRTY_MIN) {
    const prs = await refreshPrList();
    // Auto-load first PR if none is loaded and PRs are available
    if (!currentPrNumber && prs && prs.length > 0) {
      await loadPrByNumber(prs[0].number, prs[0].repo);
    }
  }
});

// Close dropdown when clicking outside
btnRepos.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleRepoDropdown();
});

// Close repo dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (repoDropdownOpen && !repoDropdown.contains(e.target) && e.target !== btnRepos) {
    closeRepoDropdown();
  }
});

// Initialize repos on load
loadRepos();

// Override loadDiff to store content and apply filter
const originalLoadDiff = typeof loadDiff !== 'undefined' ? loadDiff : null;

// This function will be called to re-render with current filter
function renderFilteredDiff() {
  if (!currentDiffContent) return;

  // Always render ALL files — sorted by extension
  const sortedDiff = sortDiffByExtension(currentDiffContent);

  // Use diff2html to render everything — pass window.hljs for syntax highlighting
  const diff2htmlUi = new Diff2HtmlUI(document.getElementById('diff-container'), sortedDiff, {
    drawFileList: true,
    matching: 'words',
    outputFormat: currentDiffViewMode === 'split' ? 'side-by-side' : 'line-by-line',
    colorScheme: 'dark'
  }, typeof window.hljs !== 'undefined' ? window.hljs : undefined);
  diff2htmlUi.draw();
  diff2htmlUi.fileListToggle(false);

  // Post-process: highlight Perl files that diff2html didn't recognize
  // (.cgi is mapped already, but extensionless Perl scripts need detection)
  highlightUnrecognizedFiles();

  // Remove old context buttons before re-adding
  diffContainer.querySelectorAll('.context-expand-btn').forEach(b => b.remove());

  // Re-add comment buttons
  addCommentButtons();
  addFileCommentButtons();
  addCopyFileNameButtons();
  populateFileSidebar();
  addContextButtons();

  // Determine which extensions are excluded
  const allExts = extractExtensionsFromDiff(currentDiffContent);
  const excludedExts = activeExtensions ? allExts.filter(e => !activeExtensions.includes(e)) : [];

  // Collapse filtered-out file wrappers
  if (excludedExts.length > 0) {
    collapseFilteredFiles(excludedExts);
  }
  updateFilteredFilesNotice(excludedExts);
}

// Show (or hide) a notice in the main content area when the extension filter
// hides some or all of the files in the diff. This prevents the confusing case
// where a diff appears empty simply because its file types were filtered out.
function updateFilteredFilesNotice(excludedExts) {
  const notice = document.getElementById('filtered-files-notice');
  if (!notice) return;
  if (!currentDiffContent) { notice.style.display = 'none'; notice.innerHTML = ''; return; }

  const exts = Array.isArray(excludedExts) ? excludedExts : [];
  if (exts.length === 0) {
    notice.style.display = 'none';
    notice.innerHTML = '';
    return;
  }

  // Count wrappers hidden by the filter
  const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  let total = 0, hidden = 0;
  wrappers.forEach(w => {
    total++;
    if (w.style.display === 'none') hidden++;
  });

  // If nothing is actually hidden (e.g. filter no longer matches), hide the notice.
  if (hidden === 0) {
    notice.style.display = 'none';
    notice.innerHTML = '';
    return;
  }

  const extLabels = exts.map(e => `<code>${escapeHtml(e)}</code>`).join(', ');
  const allHidden = hidden >= total && total > 0;
  const title = allHidden
    ? 'All files in this diff are filtered out'
    : `${hidden} of ${total} files are hidden by the file filter`;
  const plural = exts.length !== 1;
  const msg = `Files with extension${plural ? 's' : ''} ${extLabels} are not shown because they're filtered out in the Files Changed panel.`;

  notice.innerHTML = `
    <div class="ffn-title">${title}</div>
    <div class="ffn-muted">${msg}</div>
    <button id="ffn-show-all">Show all files</button>
  `;
  notice.style.display = 'block';

  const btn = notice.querySelector('#ffn-show-all');
  if (btn) {
    btn.addEventListener('click', () => {
      // Reset the extension filter to show everything
      const checkboxes = document.querySelectorAll('#filter-list input[type="checkbox"]');
      checkboxes.forEach(cb => { cb.checked = true; });
      activeExtensions = null;
      saveActiveExtensions();
      updateFilterButtonState();
      renderFilteredDiff();
    });
  }
}

/**
 * Apply syntax highlighting to all code blocks in the diff container.
 * Used by loadDiff() which renders via Diff2Html.html() (raw HTML, no highlighting).
 */
function applySyntaxHighlighting() {
  if (typeof window.hljs === 'undefined') { console.warn('[hljs] highlight.js not loaded'); return; }

  const wrappers = document.querySelectorAll('.d2h-file-wrapper');
  console.log('[hljs] Applying syntax highlighting to', wrappers.length, 'file wrappers');
  wrappers.forEach(wrapper => {
    const lang = wrapper.getAttribute('data-lang') || '';
    const hljsLanguage = lang && lang !== 'plaintext' && window.hljs.getLanguage(lang) ? lang : 'plaintext';
    const codeLines = wrapper.querySelectorAll('.d2h-code-line-ctn');
    console.log('[hljs] File:', wrapper.querySelector('.d2h-file-name')?.textContent, 'lang:', lang, '→', hljsLanguage, 'lines:', codeLines.length);
    codeLines.forEach(line => {
      try {
        const text = line.textContent;
        if (text === null) return;
        const result = window.hljs.highlight(text, {
          language: hljsLanguage,
          ignoreIllegals: true,
        });
        line.classList.add('hljs');
        if (result.language) {
          line.classList.add(result.language);
        }
        line.innerHTML = result.value;
      } catch (e) {
        // Ignore highlight errors for individual lines
      }
    });
  });
}

/**
 * Post-process diff to highlight files that diff2html didn't recognize.
 * diff2html maps extensions → languages, but files with no extension
 * get data-lang="" and fall to plaintext.
 * This function uses hljs.highlightAuto() to detect the language from code content.
 */
function highlightUnrecognizedFiles() {
  if (typeof window.hljs === 'undefined' || !window.hljs.highlightAuto) return;

  const wrappers = document.querySelectorAll('.d2h-file-wrapper');
  wrappers.forEach(wrapper => {
    const lang = wrapper.getAttribute('data-lang');
    // Only process files with no recognized extension
    if (lang && lang !== '' && lang !== 'plaintext') return;

    // Gather all code content for auto-detection
    const codeLines = wrapper.querySelectorAll('.d2h-code-line-ctn');
    if (codeLines.length === 0) return;

    // Sample up to 20 lines for language detection (enough for reliable detection)
    const sampleLines = Array.from(codeLines).slice(0, 20).map(l => l.textContent).join('\n');
    if (!sampleLines.trim()) return;

    // Use highlightAuto to detect language from code content
    let detectedLang = null;
    try {
      const autoResult = window.hljs.highlightAuto(sampleLines);
      if (autoResult.language && autoResult.relevance > 5) {
        detectedLang = autoResult.language;
      }
    } catch (e) {
      // Auto-detection failed, fall through to Perl-specific check
    }

    // Fallback: check filename for Perl extensions
    if (!detectedLang) {
      const fileName = wrapper.querySelector('.d2h-file-name');
      const name = fileName ? fileName.textContent.trim() : '';
      if (/\.(cgi|pl|pm|t|psgi|plx|fcgi)$/i.test(name)) {
        detectedLang = 'perl';
      }
    }

    if (!detectedLang) return;

    // Re-highlight all code lines in this file with the detected language
    codeLines.forEach(line => {
      const text = line.textContent;
      if (!text) return;

      try {
        const result = window.hljs.highlight(text, { language: detectedLang, ignoreIllegals: true });
        line.classList.add('hljs', detectedLang);
        line.innerHTML = result.value;
      } catch (e) {
        // Ignore highlight errors for individual lines
      }
    });
  });
}

// Apply name filter after extension filter renders
const origRenderFilteredDiff = typeof renderFilteredDiff === 'function' ? renderFilteredDiff : null;
if (origRenderFilteredDiff) {
  const _origRenderFilteredDiff = renderFilteredDiff;
  renderFilteredDiff = function() {
    _origRenderFilteredDiff.call(this);
    // Re-apply name filter after re-render
    if (currentNameFilter) {
      applyFileNameFilter();
    }
  };
}

// Collapse files matching excluded extensions — same diff2html rendering,
// just hidden by default with a toggle icon on the header
function collapseFilteredFiles(excludedExts) {
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  for (const wrapper of fileWrappers) {
    const fileNameEl = wrapper.querySelector('.d2h-file-name');
    if (!fileNameEl) continue;
    const fileName = fileNameEl.textContent.trim();
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
    if (!excludedExts.includes(ext)) continue;

    // Hide the entire file wrapper
    wrapper.style.display = 'none';
  }
}

// Extract file extension from diff file block
function getExt(fileBlock) {
  const match = fileBlock.split('\n')[0].match(/a\/(.+?) b\//);
  if (!match) return '';
  const name = match[1];
  return name.includes('.') ? '.' + name.split('.').pop() : '';
}

// Extract file name from diff file block
function getName(fileBlock) {
  const match = fileBlock.split('\n')[0].match(/a\/(.+?) b\//);
  return match ? match[1] : '';
}

// Sort diff content by file extension, then by name
function sortDiffByExtension(diffContent) {
  if (!diffContent || !diffContent.includes('diff --git')) return diffContent;
  const files = diffContent.split(/^diff --git /m);
  const validFiles = files.filter(f => f.trim());

  validFiles.sort((a, b) => {
    const extA = getExt(a);
    const extB = getExt(b);
    if (extA !== extB) return extA.localeCompare(extB);
    return getName(a).localeCompare(getName(b));
  });

  // Ensure each section ends with a newline before joining
  return validFiles.map(f => {
    const trimmed = f.trimEnd();
    return 'diff --git ' + trimmed + '\n';
  }).join('');
}

// Update the loadDiff function to store content
if (typeof window !== 'undefined') {
  // Intercept the loadDiff call to store the content
  const origLoadDiff = window.loadDiff;
  if (origLoadDiff) {
    window.loadDiff = function(content, filePath) {
      currentDiffContent = content;
      currentDiffFilePath = filePath;
      allExtensionsInDiff = extractExtensionsFromDiff(content);
      origLoadDiff.call(this, content, filePath);
    };
  }
}

// ===================== COMMITS PANEL & PR URL =====================

const btnCommits = document.getElementById('btn-commits');
const commitsPanel = document.getElementById('commits-panel');
const commitsCount = document.getElementById('commits-count');
let commitsPanelOpen = false;
let prCommits = [];
let prUrl = '';
let blameCache = {};  // { filePath: { lineNum: sha } }
let commitMap = {};   // { sha: commitObj }

// Toggle commits panel
// Open PR in new window (inline button in title line)
document.addEventListener('click', async (e) => {
  const newWindowBtn = e.target.closest('.pr-new-window-inline');
  if (!newWindowBtn) return;
  e.stopPropagation();
  const prNumber = prNumberInput.value.trim();
  if (!prNumber) return;
  try {
    const result = await window.electronAPI.openPrNewWindow(parseInt(prNumber, 10));
    if (result && result.error) {
      prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${escapeHtml(result.error)}`;
    }
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${escapeHtml(err.message)}`;
  }
});

if (btnCommits) btnCommits.addEventListener('click', (e) => {
  e.stopPropagation();
  if (commitsPanelOpen) {
    closeCommitsPanel();
  } else {
    openCommitsPanel();
  }
});

function closeCommitsPanel() {
  commitsPanel.classList.remove('open');
  commitsPanelOpen = false;
}

function openCommitsPanel() {
  const btnRect = btnCommits.getBoundingClientRect();
  commitsPanel.style.top = (btnRect.bottom + 4) + 'px';
  commitsPanel.style.right = (window.innerWidth - btnRect.right) + 'px';
  commitsPanel.style.left = 'auto';

  commitsPanel.classList.add('open');
  commitsPanelOpen = true;

  if (prCommits.length > 0) {
    renderCommitsList();
  }
}

function renderCommitsList() {
  commitsCount.textContent = `${prCommits.length} commit${prCommits.length !== 1 ? 's' : ''}`;

  let html = `<div class="commits-header"><span>Commits</span><span style="font-size:11px;color:#8b949e">${prCommits.length} commits</span></div>`;
  for (const commit of prCommits) {
    const date = new Date(commit.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    html += `
      <div class="commit-item" data-sha="${commit.sha}" title="${escapeHtml(commit.fullMessage)}">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="commit-sha">${commit.sha}</span>
          <span style="font-size:11px;color:#8b949e">${escapeHtml(commit.author)} · ${date}</span>
        </div>
        <div class="commit-message">${escapeHtml(commit.message)}</div>
      </div>`;
  }
  commitsPanel.innerHTML = html;

  // Click a commit to open it in browser
  commitsPanel.querySelectorAll('.commit-item').forEach(item => {
    item.addEventListener('click', () => {
      const sha = item.dataset.sha;
      const commit = commitMap[sha];
      if (commit && commit.url) {
        window.electronAPI.openExternal(commit.url);
      }
    });
  });
}

// Close commits panel on outside click
document.addEventListener('click', (e) => {
  if (commitsPanelOpen && !commitsPanel.contains(e.target) && e.target !== btnCommits) {
    closeCommitsPanel();
  }
});

// Load commits when a PR is loaded
async function loadPrCommits(prNumber) {
  try {
    const result = await window.electronAPI.getPrCommits(prNumber, currentBaseSha);
    if (result.error) {
      console.error('[commits] error:', result.error);
      return;
    }
    prCommits = result.commits || [];
    prUrl = result.prUrl || '';

    // Build commit map
    commitMap = {};
    for (const commit of prCommits) {
      commitMap[commit.sha] = commit;
      // Also map full SHA prefix variations
      for (let len = 7; len <= 12; len++) {
        commitMap[commit.fullSha.substring(0, len)] = commit;
      }
    }

    // Show commits button and new window button
    btnCommits.style.display = 'flex';
    const newWindowInline = document.querySelector('.pr-new-window-inline');
    if (newWindowInline) newWindowInline.style.display = 'inline-flex';

    // Load blame data for files in the diff
    loadBlameData(prNumber);
  } catch (err) {
    console.error('[commits] load failed:', err.message);
  }
}

// Update PR info bar — just the title, subtitle removed (PR# is in the text box)
function updatePrInfoBar(prNumber, prTitle, result) {
  // Title line + author/assignees line
  let html = '';
  if (prTitle) {
    let compareIcon = '';
    if (beforeAfterPairs && beforeAfterPairs.length > 0) {
      compareIcon = '<span class="pr-compare-toggle" title="View before/after screenshots"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 17l5-5 3 3 4-5 8 7"/><circle cx="8" cy="9" r="1.5" fill="currentColor"/></svg></span>';
    }
    html += `<div class="pr-title-line"><span class="pr-title-text" title="Click to show PR description">${escapeHtml(prTitle)}</span><span class="pr-desc-toggle" title="Show PR description"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span><span class="pr-new-window-inline" title="Open PR in new window"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg></span>${compareIcon}</div>`;
  }
  // Second line: author + assignees
  if (result) {
    const parts = [];
    if (result.prAuthor) parts.push(`by <strong>${escapeHtml(result.prAuthor)}</strong>`);
    if (result.prAssignees && result.prAssignees.length > 0) {
      parts.push(`→ ${result.prAssignees.map(a => escapeHtml(a)).join(', ')}`);
    }
    if (parts.length > 0) {
      html += `<div class="pr-author-line">${parts.join(' ')}</div>`;
    }
  }
  prInfo.innerHTML = html;

  // Add ▾ toggle handler (both title and chevron)
  const toggleBtn = document.querySelector('.pr-desc-toggle');
  const titleText = document.querySelector('.pr-title-text');
  if (toggleBtn) toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePrDescDropdown(); });
  if (titleText) titleText.addEventListener('click', (e) => { e.stopPropagation(); togglePrDescDropdown(); });

  // Add compare toggle handler
  const compareBtn = document.querySelector('.pr-compare-toggle');
  if (compareBtn) compareBtn.addEventListener('click', (e) => { e.stopPropagation(); openCompareSlideshow(0); });

  // Inject review info into the diff2html file list area (right-aligned, same row as files changed)
  if (result) {
    let reviewInfoText = '';
    if (result.reviewInfo) {
      const date = new Date(result.reviewInfo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const state = result.reviewInfo.state.toLowerCase().replace('_', ' ');
      reviewInfoText = `Changes since ${date} (${state})`;
      if (result.reviewInfo.commitMutated) reviewInfoText += ' *';
    } else {
      reviewInfoText = 'Full diff';
    }

    // Find the file list header and add the review info on the same row
    const fileListWrapper = document.querySelector('.d2h-file-list-wrapper');
    if (fileListWrapper) {
      const existing = fileListWrapper.querySelector('.d2h-review-info');
      if (existing) existing.remove();

      // Find the file list header that shows "X files changed"
      const fileListHeader = fileListWrapper.querySelector('.d2h-file-list-header');
      if (fileListHeader) {
        // Add review info as a right-aligned span inside the header
        const reviewSpan = document.createElement('span');
        reviewSpan.className = 'd2h-review-info';
        reviewSpan.textContent = reviewInfoText;
        fileListHeader.appendChild(reviewSpan);
      }
    }
  }
}

// ===================== PR DESCRIPTION DROPDOWN =====================

function togglePrDescDropdown() {
  let dropdown = document.getElementById('pr-desc-dropdown');
  if (dropdown && dropdown.classList.contains('open')) {
    closePrDescDropdown();
    return;
  }
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'pr-desc-dropdown';
    document.body.appendChild(dropdown);
  }

  // Render markdown with sanitization (strip raw HTML from PR body to prevent XSS)
  const body = currentPrBody || '';
  let rendered = '';
  if (body) {
    try {
      // Configure marked to strip dangerous HTML
      const cleanRenderer = new marked.Renderer();
      // Override HTML rendering: sanitize dangerous elements/attributes, allow safe HTML through
      cleanRenderer.html = (token) => {
        const raw = typeof token === 'string' ? token : (token.text || token.raw || '');
        try {
          const tmp = document.createElement('div');
          tmp.innerHTML = raw;
          // Remove dangerous elements
          tmp.querySelectorAll('script, iframe, object, embed, form, input, textarea, button, select, style, link, meta, base').forEach(el => el.remove());
          // Remove dangerous attributes (on* events, javascript: URLs)
          tmp.querySelectorAll('*').forEach(el => {
            [...el.attributes].forEach(attr => {
              if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
              if (/^(href|src|action)$/i.test(attr.name) && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
            });
          });
          return tmp.innerHTML;
        } catch {
          return escapeHtml(raw);
        }
      };
      // Disable image URLs that aren't http/https/file
      const origImage = cleanRenderer.image;
      cleanRenderer.image = (token) => {
        const href = typeof token === 'string' ? token : (token.href || '');
        if (href && !/^https?:\/\//i.test(href) && !/^file:\/\//i.test(href)) {
          return '';
        }
        return origImage.call(cleanRenderer, token);
      };
      rendered = marked.parse(body, { renderer: cleanRenderer });
    } catch {
      rendered = `<p>${escapeHtml(body)}</p>`;
    }
  } else {
    rendered = '<p style="color:#484f58;font-style:italic;">No description provided.</p>';
  }

  dropdown.innerHTML = `<div class="pr-desc-content">${rendered}</div>`;

  // Position below the review bar, left-aligned under the title
  const reviewBar = document.getElementById('review-bar');
  const barRect = reviewBar.getBoundingClientRect();
  const prInfo = document.getElementById('pr-info');
  const infoRect = prInfo.getBoundingClientRect();
  dropdown.style.top = `${barRect.bottom + 4}px`;
  dropdown.style.left = `${infoRect.left}px`;
  dropdown.style.transform = 'none';

  // Check for large images and expand if needed
  setTimeout(() => {
    const imgs = dropdown.querySelectorAll('img');
    let hasLargeImg = false;
    for (const img of imgs) {
      if (img.naturalWidth > 600 || img.naturalHeight > 400) { hasLargeImg = true; break; }
    }
    if (hasLargeImg) {
      dropdown.style.width = '95vw';
      dropdown.style.maxWidth = '95vw';
      dropdown.style.maxHeight = '85vh';
      dropdown.style.overflow = 'auto';
      // Also make images responsive within the wider dropdown
      dropdown.querySelectorAll('img').forEach(img => {
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
      });
    }
  }, 50);

  dropdown.classList.add('open');

  // Rotate ▾ arrow
  const toggleBtn = document.querySelector('.pr-desc-toggle');
  if (toggleBtn) toggleBtn.classList.add('open');
}

function closePrDescDropdown() {
  const dropdown = document.getElementById('pr-desc-dropdown');
  if (dropdown) { dropdown.classList.remove('open'); dropdown.style.width = ''; dropdown.style.maxWidth = ''; }
  const toggleBtn = document.querySelector('.pr-desc-toggle');
  if (toggleBtn) toggleBtn.classList.remove('open');
}
// ===================== BEFORE/AFTER IMAGE COMPARISON =====================

let beforeAfterPairs = [];
let compareOverlayIndex = 0;
let compareZoomedSide = null; // null | 'before' | 'after'

// Detect before/after image pairs from raw markdown text
function detectBeforeAfterPairs(prBody) {
  if (!prBody || typeof prBody !== 'string') return [];

  const pairs = [];
  const lines = prBody.split('\n');
  // Match both markdown ![alt](url) and HTML <img src="url"> tags (http, https, or file://)
  const imageUrlRegex = /!\[.*?\]\(((?:https?|file):\/\/[^\\s)]+)\)|src="((?:https?|file):\/\/[^"]+)"/g;

  // Collect all images from a range of lines
  function collectImages(fromLine, toLine) {
    const urls = [];
    for (let j = fromLine; j <= Math.min(toLine, lines.length - 1); j++) {
      const line = lines[j];
      let m;
      imageUrlRegex.lastIndex = 0;
      while ((m = imageUrlRegex.exec(line)) !== null) {
        urls.push(m[1] || m[2]);
      }
    }
    return urls;
  }

  function isBeforeLabel(line) {
    return /^#{1,6}\s+.*before/i.test(line) ||
           /^\*{1,2}\s*before\s*:?\s*\*{0,2}/i.test(line) ||
           /^before(?:\s+\d+)?\s*:/i.test(line) ||
           /^(?:before)\s*:?\s*$/i.test(line) ||
           /^\*{1,2}\s*(?:before)\s*:?\s*\*{0,2}$/i.test(line);
  }

  function isAfterLabel(line) {
    return /^#{1,6}\s+.*after/i.test(line) ||
           /^\*{1,2}\s*after\s*:?\s*\*{0,2}/i.test(line) ||
           /^after(?:\s+\d+)?\s*:/i.test(line) ||
           /^(?:after)\s*:?\s*$/i.test(line) ||
           /^\*{1,2}\s*(?:after)\s*:?\s*\*{0,2}$/i.test(line);
  }

  // Find all before/after sections and collect ALL images under each
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!isBeforeLabel(line)) continue;

    // Collect all images between this "Before:" label and the next "After:" label
    let beforeImages = [];
    let afterImages = [];
    let afterStart = -1;

    // Find the next "After:" label
    for (let k = i + 1; k <= Math.min(i + 20, lines.length - 1); k++) {
      if (isAfterLabel(lines[k].trim())) {
        afterStart = k;
        break;
      }
    }

    if (afterStart < 0) continue;

    // Collect before images: from line after "Before:" to line before "After:"
    beforeImages = collectImages(i + 1, afterStart - 1);

    // Collect after images: from line after "After:" to next before/after heading or end
    let afterEnd = lines.length - 1;
    for (let k = afterStart + 1; k < lines.length; k++) {
      const l = lines[k].trim();
      if (isBeforeLabel(l) || isAfterLabel(l)) {
        afterEnd = k - 1;
        break;
      }
      // Also stop at a new heading (### ...) that's not before/after
      if (/^#{1,6}\s+/.test(l) && !isBeforeLabel(l) && !isAfterLabel(l)) {
        afterEnd = k - 1;
        break;
      }
    }
    afterImages = collectImages(afterStart + 1, afterEnd);

    if (beforeImages.length > 0 && afterImages.length > 0) {
      pairs.push({ before: beforeImages, after: afterImages });
    }

    // Skip past this section
    i = afterEnd;
  }

  return pairs;
}

// Open before/after comparison slideshow
function openCompareSlideshow(index) {
  if (!beforeAfterPairs || beforeAfterPairs.length === 0) return;
  compareOverlayIndex = index || 0;
  compareZoomedSide = null;

  // Remove any existing overlay
  closeCompareSlideshow();

  const overlay = document.createElement('div');
  overlay.className = 'compare-overlay';
  overlay.id = 'compare-overlay';

  // Build a linear list of side-by-side views. For each pair, enumerate every
  // (before, after) combination so that if one side has multiple images, the
  // main ◀/▶ arrows cycle through that side while the other side stays fixed.
  //   pair with 1 before + 2 afters -> (b0,a0), (b0,a1)
  //   pair with 2 before + 1 after -> (b0,a0), (b1,a0)
  //   pair with 2 before + 2 afters -> (b0,a0), (b0,a1), (b1,a0), (b1,a1)
  window._compareViews = [];
  for (const p of beforeAfterPairs) {
    const bArr = Array.isArray(p.before) ? p.before : [p.before];
    const aArr = Array.isArray(p.after) ? p.after : [p.after];
    for (const bSrc of bArr) {
      for (const aSrc of aArr) {
        window._compareViews.push({
          beforeSrc: bSrc,
          afterSrc: aSrc
        });
      }
    }
  }
  const viewCount = window._compareViews.length;

  overlay.innerHTML = `
    <div class="compare-header">
      <span class="compare-counter">${compareOverlayIndex + 1} of ${viewCount}</span>
      <button class="compare-close" title="Close (Esc)">✕</button>
    </div>
    <div class="compare-body compare-split-view">
      <button class="compare-nav-btn prev" title="Previous (←)">◀</button>
      <div class="compare-side" id="compare-before-side" title="Click to zoom">
        <div class="compare-label">Before</div>
        <img id="compare-before-img" src="" alt="Before">
      </div>
      <div class="compare-divider"></div>
      <div class="compare-side" id="compare-after-side" title="Click to zoom">
        <div class="compare-label">After</div>
        <img id="compare-after-img" src="" alt="After">
      </div>
      <button class="compare-nav-btn next" title="Next (→)">▶</button>
    </div>
    <div class="compare-hint">← → Navigate images &nbsp;|&nbsp; Click image to zoom &nbsp;|&nbsp; Esc Close</div>
  `;

  document.body.appendChild(overlay);

  // Event handlers
  overlay.querySelector('.compare-close').addEventListener('click', closeCompareSlideshow);
  overlay.querySelector('.compare-nav-btn.prev').addEventListener('click', () => navigateCompare('prev'));
  overlay.querySelector('.compare-nav-btn.next').addEventListener('click', () => navigateCompare('next'));
  overlay.querySelector('#compare-before-side').addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') toggleCompareZoom('before');
  });
  overlay.querySelector('#compare-after-side').addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') toggleCompareZoom('after');
  });
  overlay.querySelector('#compare-before-img').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCompareZoom('before');
  });
  overlay.querySelector('#compare-after-img').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCompareZoom('after');
  });

  renderCompareView();
}

// Render the current compareOverlayIndex view (side-by-side Before | After)
function renderCompareView() {
  const overlay = document.getElementById('compare-overlay');
  const views = window._compareViews || [];
  if (!overlay || views.length === 0) return;
  const view = views[compareOverlayIndex] || views[0];
  if (!view) return;

  overlay.querySelector('.compare-counter').textContent = `${compareOverlayIndex + 1} of ${views.length}`;
  const beforeImg = overlay.querySelector('#compare-before-img');
  const afterImg = overlay.querySelector('#compare-after-img');
  if (beforeImg) beforeImg.src = view.beforeSrc;
  if (afterImg) afterImg.src = view.afterSrc;

  // Reset zoom state
  compareZoomedSide = null;
  const beforeSide = overlay.querySelector('#compare-before-side');
  const afterSide = overlay.querySelector('#compare-after-side');
  if (beforeSide) beforeSide.classList.remove('zoomed', 'zoomed-active');
  if (afterSide) afterSide.classList.remove('zoomed', 'zoomed-active');

  updateCompareNavButtons();
}

function closeCompareSlideshow() {
  const overlay = document.getElementById('compare-overlay');
  if (overlay) overlay.remove();
  compareZoomedSide = null;
}

function navigateCompare(direction) {
  const views = window._compareViews || [];
  if (views.length === 0) return;
  if (direction === 'prev' && compareOverlayIndex > 0) {
    compareOverlayIndex--;
  } else if (direction === 'next' && compareOverlayIndex < views.length - 1) {
    compareOverlayIndex++;
  } else {
    return;
  }
  renderCompareView();
}

function updateCompareNavButtons() {
  const overlay = document.getElementById('compare-overlay');
  const views = window._compareViews || [];
  if (!overlay) return;
  const prevBtn = overlay.querySelector('.compare-nav-btn.prev');
  const nextBtn = overlay.querySelector('.compare-nav-btn.next');
  if (prevBtn) prevBtn.disabled = compareOverlayIndex <= 0;
  if (nextBtn) nextBtn.disabled = compareOverlayIndex >= views.length - 1;
}

function toggleCompareZoom(side) {
  const overlay = document.getElementById('compare-overlay');
  if (!overlay) return;

  const beforeSide = overlay.querySelector('#compare-before-side');
  const afterSide = overlay.querySelector('#compare-after-side');

  if (compareZoomedSide === side) {
    // Unzoom
    compareZoomedSide = null;
    beforeSide.classList.remove('zoomed', 'zoomed-active');
    afterSide.classList.remove('zoomed', 'zoomed-active');
  } else {
    // Zoom the clicked side
    compareZoomedSide = side;
    if (side === 'before') {
      beforeSide.classList.add('zoomed-active');
      beforeSide.classList.remove('zoomed');
      afterSide.classList.add('zoomed');
      afterSide.classList.remove('zoomed-active');
    } else {
      afterSide.classList.add('zoomed-active');
      afterSide.classList.remove('zoomed');
      beforeSide.classList.add('zoomed');
      beforeSide.classList.remove('zoomed-active');
    }
  }
}

// Keyboard handler for compare overlay
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('compare-overlay');
  if (!overlay) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeCompareSlideshow();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateCompare('prev');
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigateCompare('next');
  }
});

// Close PR desc dropdown on click outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('pr-desc-dropdown');
  if (dropdown && dropdown.classList.contains('open')) {
    if (!dropdown.contains(e.target) && !e.target.classList.contains('pr-desc-toggle') && !e.target.closest('.pr-title-text')) {
      closePrDescDropdown();
    }
  }
});

// Open PR URL in browser
document.addEventListener('click', (e) => {
  const link = e.target.closest('.pr-url-link');
  if (link) {
    e.preventDefault();
    window.electronAPI.openExternal(link.href);
  }
});

// Load blame data for files in the diff
async function loadBlameData(prNumber) {
  if (!currentDiffContent) return;

  // Extract file paths from diff
  const files = [];
  const lines = currentDiffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      files.push(line.substring(6));
    }
  }

  // Load blame for each file (in parallel, limit to avoid overwhelming)
  const blamePromises = files.slice(0, 20).map(async (filePath) => {
    try {
      const blame = await window.electronAPI.getFileBlame({ prNumber, filePath });
      blameCache[filePath] = blame;
    } catch (err) {
      // Ignore blame errors
    }
  });

  await Promise.all(blamePromises);

  // Add tooltips to line numbers
  addCommitTooltipsToLineNumbers();
}

// Add hover tooltips to line numbers showing commit info
function addCommitTooltipsToLineNumbers() {
  // Remove existing listeners to prevent duplicates
  document.querySelectorAll('.d2h-code-side-linenumber').forEach(el => {
    el.removeEventListener('mouseenter', handleLineNumberHover);
    el.removeEventListener('mouseleave', handleLineNumberLeave);
    el.addEventListener('mouseenter', handleLineNumberHover);
    el.addEventListener('mouseleave', handleLineNumberLeave);
  });
}

let activeTooltip = null;
let tooltipTimer = null;

function handleLineNumberHover(e) {
  // Clear any pending tooltip
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }

  const td = e.target;
  const lineText = td.textContent.trim();
  const lineNum = parseInt(lineText, 10);
  if (isNaN(lineNum)) return;

  // Find the file this line belongs to
  const fileWrapper = td.closest('.d2h-file-wrapper');
  if (!fileWrapper) return;
  const fileNameEl = fileWrapper.querySelector('.d2h-file-name');
  if (!fileNameEl) return;
  const fileName = fileNameEl.textContent.trim();

  // Look up blame
  const blame = blameCache[fileName];
  if (!blame || !blame[lineNum]) return;

  const sha = blame[lineNum];
  const commit = commitMap[sha];
  if (!commit) return;

  // Delay 400ms before showing tooltip
  tooltipTimer = setTimeout(() => {
    // Show tooltip with full multi-line description
    const tooltip = document.createElement('div');
    tooltip.className = 'commit-tooltip';
    const fullMsg = escapeHtml(commit.fullMessage || commit.message).replace(/\n/g, '<br>');
    tooltip.innerHTML = `
      <div class="tt-sha">${commit.sha}</div>
      <div class="tt-message">${fullMsg}</div>
      <div class="tt-author">${commit.author} · ${new Date(commit.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
    `;

    const rect = td.getBoundingClientRect();
    tooltip.style.left = (rect.right + 8) + 'px';
    tooltip.style.top = rect.top + 'px';

    document.body.appendChild(tooltip);
    activeTooltip = tooltip;
  }, 400);
}

function handleLineNumberLeave() {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}

// ===================== RULES PROPOSAL =====================

const rulesOverlay = document.getElementById('rules-overlay');
const rulesBody = document.getElementById('rules-body');
const btnRulesSave = document.getElementById('btn-rules-save');
const btnRulesCancel = document.getElementById('btn-rules-cancel');

let currentRuleProposals = [];
let rulesAvailableFiles = [];

async function showRulesDialog(reviewFeedback) {
  const config = await window.electronAPI.getConfig();
  if (!config.rules || !config.rules.enabled) return false;
  
  showToast('Analyzing feedback against existing rules...', 'progress');
  
  // Run analysis in background — don't show overlay until we have proposals
  try {
    const rulesData = await window.electronAPI.getAgentRules();
    if (rulesData.error) {
      console.error('[rules] Failed to load agent rules:', rulesData.error);
      showToast('Rules analysis failed', 'error');
      return false;
    }
    
    const result = await window.electronAPI.proposeRules({
      feedback: reviewFeedback,
      agentsMd: rulesData.agentsMd || '',
      referencedFiles: rulesData.referencedFiles || []
    });
    
    if (result.error) {
      console.error('[rules] Propose rules failed:', result.error);
      showToast('Rules analysis failed', 'error');
      return false;
    }
    
    if (result.disabled || !result.proposals || result.proposals.length === 0) {
      showToast('No new rules needed', 'info', 4000);
      return false;
    }
    
    // We have proposals — now show the overlay
    currentRuleProposals = result.proposals || [];
    rulesAvailableFiles = result.availableFiles || ['AGENTS.md'];
    
    rulesOverlay.style.display = 'flex';
    btnRulesSave.disabled = false;
    let html = '';
    currentRuleProposals.forEach((proposal, i) => {
      html += `<div class="rule-item" data-index="${i}">
        <div class="rule-item-header">
          <input type="checkbox" id="rule-check-${i}" checked>
          <span class="rule-reason">${escapeHtml(proposal.reason || '')}</span>
          <select id="rule-file-${i}">
            ${rulesAvailableFiles.map(f => `<option value="${f}" ${f === proposal.file ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
        <textarea id="rule-text-${i}">${escapeHtml(proposal.rule)}</textarea>
      </div>`;
    });
    rulesBody.innerHTML = html;
    return true;
  } catch (err) {
    console.error('[rules] Analysis failed:', err);
    showToast('Rules analysis failed', 'error');
    return false;
  }
}

btnRulesSave.addEventListener('click', async () => {
  const rulesToSave = [];
  currentRuleProposals.forEach((proposal, i) => {
    const checkbox = document.getElementById(`rule-check-${i}`);
    if (checkbox && checkbox.checked) {
      rulesToSave.push({
        rule: document.getElementById(`rule-text-${i}`).value,
        file: document.getElementById(`rule-file-${i}`).value
      });
    }
  });
  
  if (rulesToSave.length > 0) {
    btnRulesSave.disabled = true;
    btnRulesSave.textContent = 'Saving...';
    const result = await window.electronAPI.saveAgentRules({ rules: rulesToSave });
    // Could show success/failure message here
  }
  
  rulesOverlay.style.display = 'none';
  btnRulesSave.textContent = 'Save Rules';
  await cleanupAndLoadNext();
});

btnRulesCancel.addEventListener('click', async () => {
  rulesOverlay.style.display = 'none';
  await cleanupAndLoadNext();
});

async function cleanupAndLoadNext() {
  const prNum = currentPrNumber;
  if (!prNum) return;
  
  // Delete temp files
  await window.electronAPI.deletePrFiles(prNum);
  
  // Rules analysis now runs in background (non-blocking), so auto-advance
  // already happened. Just close the dialog — don't load next PR again.
}

// ===================== PREFERENCES DIALOG =====================

const prefsOverlay = document.getElementById('prefs-overlay');
const btnPrefsClose = document.getElementById('btn-prefs-close');
const btnPrefsCancel = document.getElementById('btn-prefs-cancel');
const btnPrefsSave = document.getElementById('btn-prefs-save');
const prefsSaved = document.getElementById('prefs-saved');
const prefsSidebar = document.getElementById('prefs-sidebar');

function switchPrefsSection(sectionName) {
  if (!prefsSidebar) return;
  // Update sidebar active state
  prefsSidebar.querySelectorAll('.prefs-sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionName);
  });
  // Show/hide panels
  document.querySelectorAll('.prefs-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.section === sectionName);
  });
}

// Sidebar click handler (event delegation)
if (prefsSidebar) {
  prefsSidebar.addEventListener('click', (e) => {
    const item = e.target.closest('.prefs-sidebar-item');
    if (item && item.dataset.section) {
      switchPrefsSection(item.dataset.section);
    }
  });
}

// Preference field IDs and their config paths
const prefFields = [
  { id: 'pref-ai-command', key: 'aiCommand', type: 'text' },
  { id: 'pref-ai-tag', key: 'aiTagPrefix', type: 'text' },
  { id: 'pref-hermes-profile', key: 'hermesProfile', type: 'text' },
  { id: 'pref-editor-cmd', key: 'editorCommand', type: 'text' },
  { id: 'pref-context-lines', key: 'contextLines', type: 'number' },
  { id: 'pref-diff-mode', key: 'diff.mode', type: 'select' },
  { id: 'pref-diff-view-mode', key: 'diff.viewMode', type: 'select' },
  { id: 'pref-title-contains', key: 'prFilter.titleContains', type: 'text' },
  { id: 'pref-review-requested', key: 'prFilter.reviewRequested', type: 'checkbox' },
  { id: 'pref-autofix-enabled', key: 'autoFix.enabled', type: 'checkbox' },
  { id: 'pref-rules-enabled', key: 'rules.enabled', type: 'checkbox' },
  { id: 'pref-auto-update', key: 'autoUpdate', type: 'checkbox' },
  { id: 'pref-img-enabled', key: 'imageUpload.enabled', type: 'checkbox' },
  { id: 'pref-s3-bucket', key: 'imageUpload.s3Bucket', type: 'text' },
  { id: 'pref-s3-prefix', key: 'imageUpload.s3Prefix', type: 'text' },
  { id: 'pref-aws-profile', key: 'imageUpload.awsProfile', type: 'text' },
  { id: 'pref-aws-region', key: 'imageUpload.awsRegion', type: 'text' }
];

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : '', obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

async function openPreferences() {
  try {
    const config = await window.electronAPI.getConfig();

    for (const field of prefFields) {
      const el = document.getElementById(field.id);
      if (!el) continue;
      const value = getNestedValue(config, field.key);
      if (field.type === 'checkbox') {
        el.checked = !!value;
      } else {
        el.value = value !== undefined && value !== null ? value : '';
      }
    }

    // Reset to first section
    switchPrefsSection('review');

    prefsOverlay.style.display = 'flex';
  } catch (err) {
    console.error('[prefs] load failed:', err);
  }
}

function closePreferences() {
  prefsOverlay.style.display = 'none';
}

async function savePreferences() {
  const prefs = {};

  for (const field of prefFields) {
    const el = document.getElementById(field.id);
    if (!el) continue;
    let value;
    if (field.type === 'checkbox') {
      value = el.checked;
    } else if (field.type === 'number') {
      value = parseInt(el.value, 10);
      if (isNaN(value)) continue;
    } else {
      value = el.value.trim();
    }
    setNestedValue(prefs, field.key, value);
  }

  const result = await window.electronAPI.savePreferences(prefs);
  if (result && result.success) {
    // Sync in-memory view mode from saved prefs
    if (prefs.diff && prefs.diff.viewMode) currentDiffViewMode = prefs.diff.viewMode;
    // Re-render diff with new view mode
    if (currentDiffContent && typeof Diff2HtmlUI !== 'undefined') renderFilteredDiff();
    // Show brief "Saved" confirmation
    prefsSaved.classList.add('show');
    setTimeout(() => {
      prefsSaved.classList.remove('show');
      closePreferences();
    }, 1200);
  }
}

btnPrefsClose.addEventListener('click', closePreferences);
btnPrefsCancel.addEventListener('click', closePreferences);
btnPrefsSave.addEventListener('click', savePreferences);

// Close on overlay click (outside dialog)
prefsOverlay.addEventListener('click', (e) => {
  if (e.target === prefsOverlay) closePreferences();
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && prefsOverlay.style.display === 'flex') {
    closePreferences();
  }
  if (e.key === 'Escape' && shortcutsOverlay.style.display === 'flex') {
    closeShortcutsDialog();
  }
});

// ===================== REVIEW HISTORY =====================
// Persistent list of PRs the user took action on (approved / requested changes /
// commented) this session AND across restarts. Stored in localStorage (max 50).
// Only actions are recorded — merely loading a PR is not.

const REVIEW_HISTORY_KEY = 'pr-reviewer-review-history';
const REVIEW_HISTORY_MAX = 50;

function loadReviewHistory() {
  try {
    const raw = localStorage.getItem(REVIEW_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveReviewHistory(arr) {
  try {
    localStorage.setItem(REVIEW_HISTORY_KEY, JSON.stringify(arr.slice(0, REVIEW_HISTORY_MAX)));
  } catch (e) { /* ignore quota errors */ }
}

let reviewHistory = loadReviewHistory();

function prTitleForHistory() {
  return currentPrTitle || '';
}

// Record a review action. Dedupes: if the same PR number+repo already has an
// entry, move it to the top and update its action/label/count. Keeps newest first.
function recordReviewAction(prNumber, eventType, title, commentCount) {
  if (!prNumber) return;
  const action = eventType === 'approve' ? 'approved' :
                 eventType === 'request_changes' ? 'requested changes' : 'commented';
  const entry = {
    prNumber: parseInt(prNumber, 10),
    repo: currentRepoKey || 'default',
    title: title || `PR #${prNumber}`,
    action,
    commentCount: commentCount || 0,
    timestamp: Date.now()
  };
  reviewHistory = reviewHistory.filter(h => !(h.prNumber === entry.prNumber && h.repo === entry.repo));
  reviewHistory.unshift(entry);
  reviewHistory = reviewHistory.slice(0, REVIEW_HISTORY_MAX);
  saveReviewHistory(reviewHistory);
  renderReviewHistoryDropdown();
  console.log('[history] recorded action', JSON.stringify(entry));
}

function renderReviewHistoryDropdown() {
  const listEl = document.getElementById('review-history-list');
  if (!listEl) return;
  const empty = reviewHistory.length === 0;
  listEl.innerHTML = empty
    ? '<div class="rh-empty">No review actions yet this session</div>'
    : reviewHistory.map(h => {
        const d = new Date(h.timestamp);
        const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const badge = h.commentCount > 0
          ? `<span class="rh-comment-badge" title="${h.commentCount} comment${h.commentCount !== 1 ? 's' : ''}">${h.commentCount} ${h.commentCount !== 1 ? 'comments' : 'comment'}</span>`
          : '';
        return `<div class="rh-item" data-pr="${h.prNumber}" data-repo="${h.repo}" title="Click to load PR #${h.prNumber}">
          <div class="rh-main"><span class="rh-number">#${h.prNumber}</span> <span class="rh-action rh-action-${h.action.replace(/\s+/g,'-')}">${h.action}</span> <span class="rh-title">${escapeHtml(h.title)}</span></div>
          <div class="rh-sub">${time} ${badge}</div>
        </div>`;
      }).join('');
  // Wire clicks
  listEl.querySelectorAll('.rh-item').forEach(item => {
    item.addEventListener('click', () => {
      const prNum = item.dataset.pr;
      const repo = item.dataset.repo;
      closeReviewHistoryDropdown();
      loadPrByNumber(prNum, repo);
    });
  });
}

function toggleReviewHistoryDropdown() {
  const ov = document.getElementById('review-history-overlay');
  if (!ov) return;
  if (ov.style.display === 'flex') {
    closeReviewHistoryDropdown();
  } else {
    openReviewHistoryDropdown();
  }
}

function closeReviewHistoryDropdown() {
  const ov = document.getElementById('review-history-overlay');
  if (ov) ov.style.display = 'none';
}

// Open the history dialog (used by the View menu / Cmd+Shift+H). It's a centered
// modal overlay like the preferences dialog, not a positioned dropdown.
const reviewHistoryOverlay = document.getElementById('review-history-overlay');
const btnReviewHistoryClose = document.getElementById('btn-review-history-close');

function openReviewHistoryDropdown() {
  if (!reviewHistoryOverlay) return;
  closePrDropdown();
  closeRepoDropdown();
  renderReviewHistoryDropdown();
  reviewHistoryOverlay.style.display = 'flex';
}

// Close button + Escape + click outside the dialog
if (btnReviewHistoryClose) btnReviewHistoryClose.addEventListener('click', closeReviewHistoryDropdown);
if (reviewHistoryOverlay) reviewHistoryOverlay.addEventListener('click', (e) => {
  if (e.target === reviewHistoryOverlay) closeReviewHistoryDropdown();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReviewHistoryDropdown();
});

// ===================== KEYBOARD SHORTCUTS DIALOG =====================

const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const btnShortcutsClose = document.getElementById('btn-shortcuts-close');

function openShortcutsDialog() {
  if (!shortcutsOverlay) return;
  // Close prefs if open so the shortcut dialog sits on top cleanly
  if (prefsOverlay && prefsOverlay.style.display === 'flex') closePreferences();
  shortcutsOverlay.style.display = 'flex';
}
function closeShortcutsDialog() {
  if (shortcutsOverlay) shortcutsOverlay.style.display = 'none';
}
function toggleShortcutsDialog() {
  if (shortcutsOverlay.style.display === 'flex') closeShortcutsDialog();
  else openShortcutsDialog();
}

if (btnShortcutsClose) btnShortcutsClose.addEventListener('click', closeShortcutsDialog);
// Click outside the dialog closes it
if (shortcutsOverlay) shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === shortcutsOverlay) closeShortcutsDialog();
});

// Listen for menu triggers
window.electronAPI.onOpenPreferences(() => openPreferences());
window.electronAPI.onOpenShortcuts(() => openShortcutsDialog());
window.electronAPI.onOpenReviewHistory(() => toggleReviewHistoryDropdown());

// Menu: File > Check for Updates (immediate, no idle wait)
window.electronAPI.onCheckUpdateMenu(async () => {
  try {
    showToast('Checking for updates...', 'info');
    const result = await window.electronAPI.checkUpdate();
    if (result.upToDate) {
      showToast('Up to date', 'success');
    } else if (result.error) {
      showToast(`Update check failed: ${result.error}`, 'error');
    } else {
      showToast('Update found! Installing...', 'info');
      await window.electronAPI.applyUpdate();
    }
  } catch (err) {
    showToast(`Update failed: ${err.message}`, 'error');
  }
});

// ===================== AUTO-UPDATE UI =====================

// Auto-update checkbox handler
const prefAutoUpdate = document.getElementById('pref-auto-update');
if (prefAutoUpdate) {
  prefAutoUpdate.addEventListener('change', async () => {
    try {
      await window.electronAPI.setAutoUpdate(prefAutoUpdate.checked);
    } catch (err) {
      console.error('[auto-update] toggle failed:', err);
    }
  });
}

// Check for updates button
const btnCheckUpdate = document.getElementById('btn-check-update');
const updateStatus = document.getElementById('update-status');
if (btnCheckUpdate) {
  btnCheckUpdate.addEventListener('click', async () => {
    btnCheckUpdate.disabled = true;
    btnCheckUpdate.textContent = 'Checking...';
    updateStatus.textContent = '';

    try {
      const result = await window.electronAPI.checkUpdate();
      if (result.upToDate) {
        updateStatus.textContent = '✓ Up to date';
        updateStatus.style.color = '#3fb950';
      } else if (result.error) {
        updateStatus.textContent = `Error: ${result.error}`;
        updateStatus.style.color = '#f85149';
      } else {
        updateStatus.innerHTML = `Update available:<br><pre style="margin:8px 0;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:12px;max-height:150px;overflow-y:auto">${escapeHtml(result.commits)}</pre>`;
        updateStatus.style.color = '#d29922';

        // Add apply button
        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Install Update';
        applyBtn.style.cssText = 'background:#238636;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;margin-top:8px';
        applyBtn.addEventListener('click', async () => {
          applyBtn.disabled = true;
          applyBtn.textContent = 'Installing...';
          updateStatus.textContent = 'Pulling changes, building, and restarting...';
          updateStatus.style.color = '#58a6ff';
          try {
            await window.electronAPI.applyUpdate();
          } catch (err) {
            updateStatus.textContent = `Error: ${err.message}`;
            updateStatus.style.color = '#f85149';
          }
        });
        updateStatus.appendChild(applyBtn);
      }
    } catch (err) {
      updateStatus.textContent = `Error: ${err.message}`;
      updateStatus.style.color = '#f85149';
    }

    btnCheckUpdate.disabled = false;
    btnCheckUpdate.textContent = 'Check for Updates';
  });
}

// Menu: File > Export Review > As Markdown
window.electronAPI.onExportMarkdown(() => exportAsMarkdown());

// Menu: File > Export Review > As JSON
window.electronAPI.onExportJson(() => exportAsJson());

function exportAsJson() {
  const prNum = prNumberInput.value.trim() || '0';
  const review = {
    prNumber: prNum ? parseInt(prNum, 10) : null,
    body: reviewBody.value.trim(),
    comments: comments,
    filePath: currentFilePath,
    fileName: currentFileName,
    timestamp: new Date().toISOString()
  };
  const json = JSON.stringify(review, null, 2);
  const defaultName = `pr-${prNum}-review.json`;
  window.electronAPI.exportJson({ json, defaultName }).then(savedPath => {
    if (savedPath) {
      prInfo.innerHTML = `<strong style="color:#3fb950">✓ Exported to ${savedPath.split('/').pop()}</strong>`;
    }
  });
}

// ===================== VOICE MODE =====================

const btnVoice = document.getElementById('btn-voice');
const voiceTranscript = document.getElementById('voice-transcript');
const voiceTranscriptLabel = voiceTranscript ? voiceTranscript.querySelector('.transcript-label') : null;
const voiceTranscriptText = voiceTranscript ? voiceTranscript.querySelector('.transcript-text') : null;

let voiceActive = false;
let voiceRecorder = null;
let voiceStream = null;
let voiceAudioCtx = null;
let voiceAnalyser = null;
let voiceAnimFrame = null;
let voiceSilenceTimer = null;
let voiceHeardSpeech = false;
let voiceStartTime = 0;
let voiceAudioChunks = [];

// Silence detection params (matching Hermes desktop app)
const VOICE_SILENCE_RMS_THRESHOLD = 0.075;
const VOICE_SILENCE_MS = 1500;
const VOICE_IDLE_SILENCE_MS = 12000;
const VOICE_MAX_RECORDING_MS = 60000;

// Get list of files currently visible in the diff
function getDiffFiles() {
  const files = [];
  const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  wrappers.forEach(wrapper => {
    const nameEl = wrapper.querySelector('.d2h-file-name');
    if (nameEl) {
      const name = nameEl.textContent.trim();
      const lines = wrapper.querySelectorAll('.d2h-code-linenumber:not(.d2h-code-side-emptyplaceholder), .d2h-code-side-linenumber:not(.d2h-code-side-emptyplaceholder)');
      files.push({ name, lines: lines.length || '?' });
    }
  });
  return files;
}

// Build context for the voice command
function buildVoiceContext() {
  return {
    prNumber: prNumberInput.value.trim() || null,
    files: getDiffFiles(),
    comments: comments.map(c => ({ file: c.file, line: c.line, side: c.side, text: c.text, level: c.level })),
    reviewBody: reviewBody.value.trim()
  };
}

// Execute a single voice command action on the UI
function executeSingleVoiceAction(action) {
  switch (action.action) {
    case 'line_comment': {
      const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
      let targetWrapper = null;
      for (const w of wrappers) {
        const nameEl = w.querySelector('.d2h-file-name');
        if (nameEl && nameEl.textContent.trim() === action.file) {
          targetWrapper = w;
          break;
        }
      }
      if (!targetWrapper) {
        showSafeToast(`⚠ File "${action.file}" not found in diff`, 'error', 5000);
        return;
      }

      const sideDiffs = targetWrapper.querySelectorAll('.d2h-file-side-diff');
      const isRight = action.side === 'RIGHT';
      const sideDiff = sideDiffs[isRight ? 1 : 0] || sideDiffs[0];
      if (!sideDiff) {
        addVoiceFileComment(action.file, action.text);
        return;
      }

      const lines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
      let targetLine = null;
      for (const line of lines) {
        const lineNumEl = line.querySelector('.d2h-code-side-linenumber');
        if (lineNumEl && parseInt(lineNumEl.textContent.trim()) === action.line) {
          targetLine = line;
          break;
        }
      }
      if (!targetLine) {
        addVoiceFileComment(action.file, action.text);
        return;
      }

      // Add comment directly without opening dialog (voice mode = silent execution)
      comments.push({
        file: action.file,
        line: action.line,
        side: action.side || 'RIGHT',
        text: action.text,
        isAiTagged: false,
        level: 'line',
        codeContext: null,
        imageDataUrl: null
      });
      renderLineCommentMarker(comments[comments.length - 1]);
      updateCommentCount();
      updateCommentNav();
      autoSaveDraft();
      break;
    }

    case 'file_comment': {
      addVoiceFileComment(action.file, action.text);
      break;
    }

    case 'review_body': {
      if (reviewBody.value.trim()) {
        reviewBody.value = reviewBody.value.trim() + '\n\n' + action.text;
      } else {
        reviewBody.value = action.text;
      }
      autoSaveDraft();
      break;
    }

    case 'approve': {
      if (!btnApprove.disabled) btnApprove.click();
      break;
    }

    case 'request_changes': {
      if (!btnRequestChanges.disabled) btnRequestChanges.click();
      break;
    }

    case 'submit_comment': {
      if (!btnComment.disabled) btnComment.click();
      break;
    }

    case 'ask': {
      const askText = `@ask ${action.text}`;
      if (action.file && action.line) {
        comments.push({
          file: action.file, line: action.line, side: 'RIGHT',
          text: askText, isAiTagged: true, level: 'line',
          codeContext: null, imageDataUrl: null
        });
        renderLineCommentMarker(comments[comments.length - 1]);
      } else if (action.file) {
        comments.push({
          file: action.file, line: null, side: null,
          text: askText, isAiTagged: true, level: 'file',
          codeContext: null, imageDataUrl: null
        });
        renderFileCommentMarker(comments[comments.length - 1]);
      } else {
        if (reviewBody.value.trim()) {
          reviewBody.value = reviewBody.value.trim() + '\n\n' + askText;
        } else {
          reviewBody.value = askText;
        }
      }
      updateCommentCount();
      updateCommentNav();
      autoSaveDraft();
      break;
    }

    case 'open_pr': {
      if (action.pr_number || action.prNumber) {
        const prNum = action.pr_number || action.prNumber;
        prNumberInput.value = prNum;
        prNumberInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      break;
    }

    case 'close_pr': {
      closePullRequest();
      break;
    }

    case 'go_to_file': {
      const targetFileName = (action.file || action.fileName || '').toLowerCase();
      if (!targetFileName) break;
      const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
      for (const wrapper of fileWrappers) {
        const nameEl = wrapper.querySelector('.d2h-file-name');
        if (nameEl && nameEl.textContent.trim().toLowerCase().includes(targetFileName)) {
          const header = wrapper.querySelector('.d2h-file-header');
          const target = header || wrapper;
          const toolbarHeight = 52;
          const rect = target.getBoundingClientRect();
          const scrollTop = window.pageYOffset + rect.top - toolbarHeight - 8;
          window.scrollTo({ top: scrollTop, behavior: 'smooth' });
          // Highlight the file briefly
          wrapper.style.outline = '2px solid #58a6ff';
          setTimeout(() => { wrapper.style.outline = ''; }, 2000);
          showToast(`Navigating to ${nameEl.textContent.trim()}`, 'info', 3000);
          break;
        }
      }
      break;
    }

    case 'open_compare':
    case 'compare':
    case 'show_compare': {
      if (typeof openCompareSlideshow === 'function' && beforeAfterPairs && beforeAfterPairs.length > 0) {
        openCompareSlideshow(0);
        showToast('Opening before/after comparison', 'info', 3000);
      } else {
        showSafeToast('No before/after image comparison available for this PR', 'error', 5000);
      }
      break;
    }

    case 'message':
    default: {
      if (action.text) {
        showToast(action.text, 'info', 8000);
      }
      break;
    }
  }
}

function addVoiceFileComment(fileName, text) {
  const wrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  let targetWrapper = null;
  for (const w of wrappers) {
    const nameEl = w.querySelector('.d2h-file-name');
    if (nameEl && nameEl.textContent.trim() === fileName) {
      targetWrapper = w;
      break;
    }
  }
  if (!targetWrapper) {
    showSafeToast(`⚠ File "${fileName}" not found in diff`, 'error', 5000);
    return;
  }

  comments.push({
    file: fileName, line: null, side: null,
    text: text, isAiTagged: false, level: 'file',
    codeContext: null, imageDataUrl: null
  });
  renderFileCommentMarker(comments[comments.length - 1]);
  updateCommentCount();
  updateCommentNav();
  autoSaveDraft();
}

// Process voice results — handles array of actions from Hermes
async function processVoiceResults(result) {
  if (result.error) {
    showToast(`⚠ Voice error: ${result.error}`, 'error', 8000);
    return;
  }

  const actions = result.actions || (result.action ? [result.action] : []);
  if (actions.length === 0) {
    showToast('No actions returned from voice command', 'info', 4000);
    return;
  }

  let successCount = 0;
  for (const action of actions) {
    try {
      executeSingleVoiceAction(action);
      successCount++;
    } catch (err) {
      console.error('[voice] Action execution error:', err);
    }
  }

  if (successCount > 0) {
    showToast(`✓ ${successCount} action${successCount > 1 ? 's' : ''} executed`, 'success', 4000);
  }
}

// Process audio blob: send to main process for STT + Hermes interpretation
async function processVoiceAudio(audioBlob) {
  btnVoice.classList.remove('listening');
  btnVoice.classList.add('processing');
  voiceTranscriptLabel.textContent = 'Processing...';
  voiceTranscriptText.textContent = 'Transcribing and interpreting...';
  voiceTranscriptText.classList.remove('interim');

  try {
    // Convert blob to base64
    const arrayBuffer = await audioBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);

    const context = buildVoiceContext();
    const result = await window.electronAPI.processVoiceCommand({ audioBase64: base64, context });
    await processVoiceResults(result);
  } catch (err) {
    console.error('[voice] Process error:', err);
    showToast(`⚠ Voice processing failed: ${err.message}`, 'error', 8000);
  } finally {
    btnVoice.classList.remove('processing');
    voiceTranscript.classList.remove('show');
  }
}

// Start microphone recording with silence detection (matching Hermes desktop app)
async function startVoice() {
  if (voiceActive) return;

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      showToast('⚠ Microphone access denied. Enable it in System Preferences.', 'error', 8000);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      showToast('⚠ No microphone found.', 'error', 5000);
    } else {
      showToast(`⚠ Microphone error: ${err.message}`, 'error', 5000);
    }
    return;
  }

  // Set up AudioContext + AnalyserNode for silence detection
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  voiceAudioCtx = new AudioCtx();
  voiceAnalyser = voiceAudioCtx.createAnalyser();
  voiceAnalyser.fftSize = 256;
  const source = voiceAudioCtx.createMediaStreamSource(voiceStream);
  source.connect(voiceAnalyser);

  // Set up MediaRecorder
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
  voiceAudioChunks = [];

  voiceRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) voiceAudioChunks.push(e.data);
  };

  voiceRecorder.onstop = () => {
    cleanupVoiceStream();
    if (voiceAudioChunks.length === 0) {
      showToast('No audio recorded', 'info', 3000);
      btnVoice.classList.remove('listening');
      voiceTranscript.classList.remove('show');
      return;
    }
    const blob = new Blob(voiceAudioChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
    voiceAudioChunks = [];
    processVoiceAudio(blob);
  };

  voiceActive = true;
  voiceHeardSpeech = false;
  voiceStartTime = Date.now();
  btnVoice.classList.add('listening');
  voiceTranscriptLabel.textContent = 'Listening...';
  voiceTranscriptText.textContent = '';
  voiceTranscript.classList.add('show');

  voiceRecorder.start();

  // Start silence detection loop (matching Hermes desktop: RMS threshold 0.075)
  const dataArray = new Uint8Array(voiceAnalyser.fftSize);
  let lastSpeechTime = Date.now();

  function checkAudioLevel() {
    if (!voiceActive) return;
    voiceAnalyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = dataArray[i] - 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const normalizedLevel = Math.min(1, rms / 42);

    // Update level indicator in transcript bar
    if (voiceTranscriptText && !voiceTranscriptText.textContent) {
      const bars = Math.round(normalizedLevel * 20);
      voiceTranscriptText.textContent = '█'.repeat(bars) + '░'.repeat(20 - bars);
      voiceTranscriptText.classList.add('interim');
    }

    const elapsed = Date.now() - voiceStartTime;

    if (normalizedLevel >= VOICE_SILENCE_RMS_THRESHOLD) {
      // Speech detected
      voiceHeardSpeech = true;
      lastSpeechTime = Date.now();
    } else if (voiceHeardSpeech && (Date.now() - lastSpeechTime) >= VOICE_SILENCE_MS) {
      // Silence after speech — auto-stop
      console.log('[voice] Silence detected, stopping');
      stopVoiceRecording();
      return;
    } else if (!voiceHeardSpeech && elapsed >= VOICE_IDLE_SILENCE_MS) {
      // Idle timeout — no speech at all
      console.log('[voice] Idle timeout, stopping');
      stopVoiceRecording();
      return;
    }

    if (elapsed >= VOICE_MAX_RECORDING_MS) {
      console.log('[voice] Max recording time reached');
      stopVoiceRecording();
      return;
    }

    voiceAnimFrame = requestAnimationFrame(checkAudioLevel);
  }

  voiceAnimFrame = requestAnimationFrame(checkAudioLevel);
}

function stopVoiceRecording() {
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop();
  } else {
    cleanupVoiceStream();
  }
}

function cleanupVoiceStream() {
  voiceActive = false;
  if (voiceAnimFrame) { cancelAnimationFrame(voiceAnimFrame); voiceAnimFrame = null; }
  if (voiceSilenceTimer) { clearTimeout(voiceSilenceTimer); voiceSilenceTimer = null; }
  if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
  if (voiceAudioCtx) { voiceAudioCtx.close().catch((err) => { console.warn('[voice] Failed to close AudioContext:', err.message); }); voiceAudioCtx = null; }
  voiceAnalyser = null;
  voiceRecorder = null;
  btnVoice.classList.remove('listening');
}

function stopVoice() {
  cleanupVoiceStream();
  voiceTranscript.classList.remove('show');
}

function toggleVoice() {
  if (voiceActive) {
    stopVoice();
  } else {
    startVoice();
  }
}

// Mic button click
btnVoice.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleVoice();
});

// Ctrl+B keyboard shortcut (standalone, not Cmd/Ctrl+Shift)
document.addEventListener('keydown', (e) => {
  if (e.key === 'b' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleVoice();
  }
});

// ===================== AI CHAT PANEL =====================

const btnAiChat = document.getElementById('btn-ai-chat');
const aiChatPanel = document.getElementById('ai-chat-panel');
const aiChatMessages = document.getElementById('ai-chat-messages');
const aiChatInput = document.getElementById('ai-chat-input');
const aiChatSend = document.getElementById('ai-chat-send');
const aiChatClear = document.getElementById('ai-chat-clear');

let aiChatHistory = [];
let aiChatBusy = false;
let aiChatEpoch = 0; // bumped on clear; lets stale in-flight stream events be ignored

// Clear the AI chat conversation (history + messages panel). Called when a new
// PR loads or auto-advance moves to the next PR, so stale PR context doesn't linger.
function clearAiChat() {
  aiChatEpoch++;
  aiChatHistory = [];
  if (aiChatMessages) aiChatMessages.innerHTML = '';
  if (aiChatBusy) {
    // An in-flight request belongs to the old PR — mark busy so its late response
    // is ignored instead of polluting the cleared chat. (See sendAiChat guard.)
    aiChatBusy = false;
  }
}

function positionAiChatPanel() {
  if (!btnAiChat || !aiChatPanel) return;
  const rect = btnAiChat.getBoundingClientRect();
  aiChatPanel.style.right = (window.innerWidth - rect.right) + 'px';
  aiChatPanel.style.top = (rect.bottom + 4) + 'px';
}

function appendAiChatMsg(role, text) {
  if (!aiChatMessages) return null;
  const el = document.createElement('div');
  el.className = 'ai-chat-msg ' + role;
  el.textContent = text;
  aiChatMessages.appendChild(el);
  aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
  return el;
}

async function sendAiChat() {
  if (!aiChatInput || aiChatBusy) return;
  const text = aiChatInput.value.trim();
  if (!text) return;
  aiChatInput.value = '';
  appendAiChatMsg('user', text);
  aiChatBusy = true;
  aiChatSend.disabled = true;
  const myEpoch = aiChatEpoch;

  // Live streaming message: created now, updated as chunks arrive via IPC.
  const live = document.createElement('div');
  live.className = 'ai-chat-msg assistant';
  live.textContent = 'Thinking…';
  if (aiChatMessages) aiChatMessages.appendChild(live);
  aiChatMessages.scrollTop = aiChatMessages.scrollHeight;

  const handleStream = (data) => {
    if (!data) return;
    // If the chat was cleared mid-flight (e.g. auto-advanced to a new PR), drop
    // this stale stream — the message element is gone and history was reset.
    if (myEpoch !== aiChatEpoch) return;
    if (data.error) {
      live.classList.remove('assistant');
      live.classList.add('error');
      live.textContent = 'Error: ' + data.error;
      aiChatHistory.push({ role: 'user', content: text });
      return;
    }
    if (data.done) {
      // Final reply — stop streaming, keep the full cleaned text. Because the
      // text streams in live, the user reads it as it appears; no need to jump
      // to the top. Just push it into history so follow-ups have context.
      live.textContent = data.text || '(no response)';
      aiChatHistory.push({ role: 'user', content: text });
      if (data.text) aiChatHistory.push({ role: 'assistant', content: data.text });
    } else if (data.text) {
      live.textContent = data.text;
      // Keep the panel scrolled so the growing reply stays in view.
      if (aiChatMessages) aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
    }
  };
  window.electronAPI.onAiChatStream(handleStream);

  try {
    const result = await window.electronAPI.aiChat({
      message: text,
      prNumber: prNumberInput.value.trim(),
      repoKey: currentRepoKey,
      history: aiChatHistory
    });
    // The 'ai-chat-stream' done event already finalized the message; this is a
    // safety net in case the stream event listener missed the final chunk.
    if (result && result.response && live.textContent === 'Thinking…') {
      live.textContent = result.response;
      aiChatHistory.push({ role: 'user', content: text });
      aiChatHistory.push({ role: 'assistant', content: result.response });
    } else if (result && result.error && !live.textContent.startsWith('Error')) {
      live.classList.remove('assistant');
      live.classList.add('error');
      live.textContent = 'Error: ' + result.error;
    }
  } catch (err) {
    live.classList.remove('assistant');
    live.classList.add('error');
    live.textContent = 'Error: ' + (err.message || err);
    aiChatHistory.push({ role: 'user', content: text });
  } finally {
    window.electronAPI.removeAiChatStreamListener(handleStream);
    aiChatBusy = false;
    aiChatSend.disabled = false;
    aiChatInput.focus();
  }
}

if (btnAiChat && aiChatPanel) {
  btnAiChat.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = aiChatPanel.classList.contains('open');
    if (!isOpen) positionAiChatPanel();
    aiChatPanel.classList.toggle('open');
    if (!isOpen && aiChatInput) aiChatInput.focus();
  });
  document.addEventListener('click', (e) => {
    if (aiChatPanel.classList.contains('open') &&
        !aiChatPanel.contains(e.target) && e.target !== btnAiChat) {
      aiChatPanel.classList.remove('open');
    }
  });
}

if (aiChatSend) aiChatSend.addEventListener('click', sendAiChat);
if (aiChatInput) {
  aiChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendAiChat(); }
  });
}
if (aiChatClear) {
  aiChatClear.addEventListener('click', () => {
    aiChatHistory = [];
    if (aiChatMessages) aiChatMessages.innerHTML = '';
    aiChatInput.focus();
  });
}

// ===================== OVERALL PR COMMENT PANEL =====================

const btnPrComment = document.getElementById('btn-pr-comment');
const prCommentPanel = document.getElementById('pr-comment-panel');

function positionPrCommentPanel() {
  if (!btnPrComment || !prCommentPanel) return;
  const rect = btnPrComment.getBoundingClientRect();
  prCommentPanel.style.right = (window.innerWidth - rect.right) + 'px';
  prCommentPanel.style.top = (rect.bottom + 4) + 'px';
}

if (btnPrComment && prCommentPanel) {
  btnPrComment.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = prCommentPanel.classList.contains('open');
    if (!isOpen) {
      positionPrCommentPanel();
      setTimeout(() => { if (reviewBody) reviewBody.focus(); }, 0);
    }
    prCommentPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (prCommentPanel.classList.contains('open') &&
        !prCommentPanel.contains(e.target) && e.target !== btnPrComment) {
      prCommentPanel.classList.remove('open');
    }
  });
}

// ===================== MORE MENU (⋮) =====================

const btnMore = document.getElementById('btn-more');
const moreMenu = document.getElementById('more-menu');
const menuClosePr = document.getElementById('menu-close-pr');
const menuDismiss = document.getElementById('menu-dismiss');

if (btnMore && moreMenu) {
  btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = moreMenu.style.display === 'block';
    if (!isOpen) {
      // Position dropdown below the button
      const rect = btnMore.getBoundingClientRect();
      moreMenu.style.right = (window.innerWidth - rect.right) + 'px';
      moreMenu.style.top = (rect.bottom + 4) + 'px';
    }
    moreMenu.style.display = isOpen ? 'none' : 'block';
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!moreMenu.contains(e.target) && e.target !== btnMore) {
      moreMenu.style.display = 'none';
    }
  });
}

if (menuClosePr) {
  menuClosePr.addEventListener('click', async () => {
    moreMenu.style.display = 'none';
    await closePullRequest();
  });
}

if (menuDismiss) {
  menuDismiss.addEventListener('click', () => {
    moreMenu.style.display = 'none';
  });
}

async function closePullRequest() {
  const prNumber = prNumberInput.value.trim();
  if (!prNumber) {
    showToast('No PR number loaded', 'error');
    return;
  }

  const reviewBodyText = reviewBody.value.trim();
  if (!confirm(`Close PR #${prNumber}?${reviewBodyText ? '\n\nYour review comment will be posted as a comment.' : ''}`)) {
    return;
  }

  showToast('Closing pull request...', 'progress', 10000);

  try {
    const result = await window.electronAPI.closePr({ prNumber, comment: reviewBodyText, repo: currentRepoKey });
    if (result.error) {
      showToast(`Failed to close PR: ${result.error}`, 'error', 8000);
    } else {
      showToast(`✓ PR #${prNumber} closed${reviewBodyText ? ' with comment' : ''}`, 'success', 6000);
      prInfo.innerHTML = `<strong style="color:#f85149">PR #${prNumber} closed</strong>`;

      // Remove closed PR from cached list and re-render dropdown if open
      const prNum = parseInt(prNumber, 10);
      if (cachedPrList) {
        cachedPrList = cachedPrList.filter(pr => pr.number !== prNum);
      }
      if (prDropdownOpen) {
        const searchInput = document.getElementById('pr-search');
        renderPrList(cachedPrList, searchInput ? searchInput.value : '');
      }

      // Auto-load next available PR from the list
      if (cachedPrList && cachedPrList.length > 0) {
        const nextPr = cachedPrList[0];
        reviewBody.value = '';
        try {
          await loadPrByNumber(nextPr.number, nextPr.repo);
        } catch (advanceErr) {
          console.error('[auto-advance] Failed to load next PR:', advanceErr);
          prInfo.innerHTML = `<strong style="color:#f85149">Error loading next PR:</strong> ${escapeHtml(advanceErr.message)}`;
          resetButtons();
        }
      } else {
        // No more PRs to review
        prInfo.innerHTML = '<strong style="color:#8b949e">No more PRs to review</strong>';
        resetButtons();
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error', 8000);
  }
}

