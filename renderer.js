// State
let currentDiff = '';
let currentFileName = '';
let currentFilePath = '';
let comments = []; // { file, line, side, text, isAiTagged, level, codeContext, imageDataUrl }
let commentTarget = null; // { file, line, side, element, level, codeContext }
let parsedDiff = null;
let aiTagPrefix = '@Hermes';
let fileCommentCounts = {};
let currentCommentIndex = -1; // For batch navigation
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

// ===================== AUTO-SAVE =====================

let saveTimeout = null;
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
    window.electronAPI.saveDraft({ filePath: currentFilePath, draft }).catch(() => {});
  }, 500); // Debounce 500ms
}

async function loadSavedDraft(filePath) {
  try {
    const draft = await window.electronAPI.loadDraft(filePath);
    if (draft && draft.comments && draft.comments.length > 0) {
      return draft;
    }
  } catch {}
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
  if (!parsedDiff) return '';
  const fileName = getFileName(lineElement);
  const fileData = parsedDiff[fileName];
  if (!fileData) return '';
  const sideDiff = lineElement.closest('.d2h-file-side-diff');
  if (!sideDiff) return '';
  const allLines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
  const lineIndex = Array.from(allLines).indexOf(lineElement);
  if (lineIndex < 0) return '';
  const sideData = isRight ? fileData.right : fileData.left;
  const entry = sideData[lineIndex];
  return entry ? String(entry.lineNum) : '';
}

// ===================== LOAD DIFF =====================

function loadDiff(content, filePath) {
  if (!content || !content.trim()) {
    prInfo.textContent = 'Error: Empty diff file';
    return;
  }
  if (!content.includes('diff --git') && !content.includes('@@') && !content.includes('---')) {
    prInfo.textContent = 'Error: File does not appear to be a valid diff';
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
  parsedDiff = parseDiffLineNumbers(content);

  emptyState.style.display = 'none';
  diffContainer.style.display = 'block';
  reviewBodyContainer.style.display = 'block';

  resetButtons();

  const html = Diff2Html.html(content, {
    drawFileList: true,
    matching: 'lines',
    outputFormat: 'side-by-side',
    colorScheme: 'dark',
    synchronisedScroll: true,
  });

  diffContainer.innerHTML = html;

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
  showReviewButtons();

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

  for (const c of draft.comments || []) {
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
  autoSaveDraft(); // Save immediately to confirm draft is valid
}

// ===================== LINE COMMENT BUTTONS =====================

function addCommentButtons() {
  const fileWrappers = diffContainer.querySelectorAll('.d2h-file-wrapper');
  fileWrappers.forEach(wrapper => {
    const sideDiffs = wrapper.querySelectorAll('.d2h-file-side-diff');
    sideDiffs.forEach((sideDiff, index) => {
      const isRight = index % 2 === 1;
      const lines = sideDiff.querySelectorAll('.d2h-code-side-line:not(.d2h-code-side-emptyplaceholder)');
      lines.forEach(line => {
        const btn = document.createElement('button');
        btn.className = 'line-comment-btn';
        btn.textContent = '+';
        btn.title = 'Add comment (Cmd+Enter to submit)';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openCommentDialog(line, btn, isRight, e);
        });
        line.style.position = 'relative';
        line.appendChild(btn);
      });
    });
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
          const num = parseInt(firstLine.textContent.trim());
          if (!isNaN(num)) line = num;
        }
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

  const idx = comments.indexOf(comment);
  const marker = document.createElement('div');
  marker.className = 'file-comment-marker' + (comment.isAiTagged ? ' ai-tagged' : '');
  marker.dataset.commentIndex = idx;

  const displayText = comment.isAiTagged ? comment.text.slice(aiTagPrefix.length).trim() : comment.text;
  const tagLabel = comment.isAiTagged ? `<span class="ai-tag">${escapeHtml(aiTagPrefix)}</span> ` : '';
  marker.innerHTML = `<strong>You</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
    <div class="comment-actions">
      <button class="btn-edit" title="Edit">Edit</button>
      <button class="btn-delete" title="Delete">Delete</button>
    </div>`;

  // Insert after the file header
  const header = targetWrapper.querySelector('.d2h-file-header');
  header.parentNode.insertBefore(marker, header.nextSibling);

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
  formCell.innerHTML = `
    <div class="comment-form">
      <div class="comment-label">${escapeHtml(fileName)} line ${lineNum} (${side} side)</div>
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
  marker.dataset.commentIndex = comments.indexOf(comment);
  const markerCell = document.createElement('td');
  markerCell.setAttribute('colspan', '2');

  const displayText = comment.isAiTagged ? comment.text.slice(aiTagPrefix.length).trim() : comment.text;
  const tagLabel = comment.isAiTagged ? `<span class="ai-tag">${escapeHtml(aiTagPrefix)}</span> ` : '';
  markerCell.innerHTML = `<strong>You (line ${comment.line})</strong>: ${tagLabel}<span class="comment-text">${escapeHtml(displayText)}</span>
    <div class="comment-actions">
      <button class="btn-edit" title="Edit">Edit</button>
      <button class="btn-delete" title="Delete">Delete</button>
    </div>`;
  marker.appendChild(markerCell);

  const formRow = document.getElementById('active-comment-form');
  if (formRow) {
    formRow.parentNode.replaceChild(marker, formRow);
  }

  marker.querySelector('.btn-edit').addEventListener('click', () => editComment(marker));
  marker.querySelector('.btn-delete').addEventListener('click', () => deleteComment(marker));
}

// ===================== EDIT / DELETE =====================

function editComment(marker) {
  const idx = parseInt(marker.dataset.commentIndex, 10);
  if (isNaN(idx) || !comments[idx]) return;

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
      const displayText = isAi ? newText.slice(aiTagPrefix.length).trim() : newText;
      const tagLabel = isAi ? `<span class="ai-tag">${escapeHtml(aiTagPrefix)}</span> ` : '';
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
    formCell.innerHTML = `
      <div class="comment-form">
        <div class="comment-label">${escapeHtml(comment.file)} line ${comment.line} (${side} side)</div>
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
      const displayText = isAi ? newText.slice(aiTagPrefix.length).trim() : newText;
      const tagLabel = isAi ? `<span class="ai-tag">${escapeHtml(aiTagPrefix)}</span> ` : '';
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
  const idx = parseInt(marker.dataset.commentIndex, 10);
  if (isNaN(idx)) return;
  const deletedComment = comments[idx];
  comments.splice(idx, 1);
  // Reindex remaining markers (all levels)
  document.querySelectorAll('[data-comment-index]').forEach(m => {
    const i = parseInt(m.dataset.commentIndex, 10);
    if (i > idx) m.dataset.commentIndex = i - 1;
  });
  marker.remove();
  if (deletedComment && deletedComment.file) {
    updateFileCommentCount(deletedComment.file);
  }
  updateCommentCount();
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
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
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
  const count = comments.length;
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
      } else if (line.startsWith(' ') || line === '' || line.startsWith('\\')) {
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
    let msg = '<strong style="color:#3fb950">✓ Review saved</strong>';
    if (aiCount > 0) msg += ` <span style="color:#58a6ff">(${aiCount} sent to AI)</span>`;
    if (askCount > 0) msg += ` <span style="color:#3fb950">(${askCount} AI responses received)</span>`;
    prInfo.innerHTML = msg;

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
      prInfo.innerHTML = '<strong style="color:#58a6ff">⏳ Submitting to GitHub...</strong>';

      // Compute diff positions for inline comments
      const positionMap = computeDiffPositions();
      const githubComments = comments
        .filter(c => !c.isAiTagged && c.level !== 'file' && c.line && c.side)
        .map(c => {
          const key = `${c.file}:${c.line}:${c.side}`;
          const position = positionMap[key];
          return position ? { file: c.file, position, text: c.text } : null;
        })
        .filter(Boolean);

      const result = await window.electronAPI.submitGitHubReview({
        prNumber: review.prNumber,
        body: review.body,
        eventType: eventType,
        comments: githubComments
      });

      if (result.error) {
        showToast(`⚠ GitHub submission failed: ${escapeHtml(result.error)}`, 'error', 10000);
        prInfo.innerHTML = `<strong style="color:#f85149">GitHub submission failed:</strong> ${escapeHtml(result.error)}`;
      } else {
        const ghMsg = eventType === 'approve' ? '✓ Review approved on GitHub' :
                      eventType === 'request_changes' ? '✓ Changes requested on GitHub' :
                      '✓ Comment submitted to GitHub';
        showToast(ghMsg, 'success', 8000);
        prInfo.innerHTML = '<strong style="color:#3fb950">✓ Review submitted to GitHub</strong>';
        if (aiCount > 0) {
          prInfo.innerHTML += ` <span style="color:#58a6ff">(${aiCount} sent to AI)</span>`;
        }

        // Auto-remove this PR from the cached list
        if (review.prNumber && cachedPrList) {
          cachedPrList = cachedPrList.filter(pr => pr.number !== review.prNumber);
        }

        // Collect feedback for rules analysis
        const feedback = [];
        for (const c of comments) {
          const t = c.text.toLowerCase();
          if (!t.startsWith('@hermes') && !t.startsWith('@ask')) {
            feedback.push({ file: c.file, line: c.line, text: c.text });
          }
        }
        if (feedback.length > 0) {
          await showRulesDialog(feedback);
        }

        // Auto-fix with AI: trigger Hermes agent to create a fix PR (only for request_changes)
        if (eventType === 'request_changes' && window.electronAPI.autoFixWithAi) {
          try {
            const autoFixConfig = await window.electronAPI.getConfig();
            const autoFixEnabled = autoFixConfig.autoFix && autoFixConfig.autoFix.enabled !== false;
            if (autoFixEnabled) {
              showToast('🤖 Auto-fixing with AI...', 'progress', 30000);
              const autoFixComments = comments
                .filter(c => !c.isAiTagged && c.text && c.file)
                .map(c => ({ file: c.file, line: c.line, text: c.text }));
              const autoFixResult = await window.electronAPI.autoFixWithAi({
                prNumber: review.prNumber,
                comments: autoFixComments,
                reviewBody: review.body
              });
              if (autoFixResult.error) {
                showToast(`⚠ Auto-fix failed: ${escapeHtml(autoFixResult.error)}`, 'error', 10000);
              } else if (autoFixResult.success && autoFixResult.prUrl) {
                const prLink = autoFixResult.prUrl;
                const prNum = autoFixResult.prNumber || '';
                showToast(`✓ Auto-fix PR #${escapeHtml(prNum)} created — <a href="${escapeHtml(prLink)}" style="color:#58a6ff" class="pr-url-link">View PR</a>`, 'success', 10000);
              }
            }
          } catch (autoFixErr) {
            showToast(`⚠ Auto-fix error: ${escapeHtml(autoFixErr.message)}`, 'error', 10000);
          }
        }
      }
    }
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${err.message}`;
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

// Auto-save on review body change
reviewBody.addEventListener('input', () => autoSaveDraft());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const isMeta = e.metaKey || e.ctrlKey;

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

  // Cmd+Shift+A — Approve
  if (e.key === 'A' && isMeta && e.shiftKey) {
    e.preventDefault();
    if (!btnApprove.disabled) btnApprove.click();
    return;
  }

  // Cmd+Shift+R — Request Changes
  if (e.key === 'R' && isMeta && e.shiftKey) {
    e.preventDefault();
    if (!btnRequestChanges.disabled) btnRequestChanges.click();
    return;
  }

  // Cmd+Shift+C — Comment (submit review as comment, not line comment)
  if (e.key === 'C' && isMeta && e.shiftKey) {
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
  if (e.key === ']' && isMeta && !e.shiftKey) {
    e.preventDefault();
    navigateToComment('next');
    return;
  }

  // Cmd+[ — Previous comment
  if (e.key === '[' && isMeta && !e.shiftKey) {
    e.preventDefault();
    navigateToComment('prev');
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
  } catch {}
}

async function autoDetectAgent() {
  try {
    const result = await window.electronAPI.autoDetectAgent();
    if (result.detected) {
      // Update the select dropdown if it exists
      const select = document.getElementById('pref-ai-command');
      if (select) select.value = result.agent;
    }
  } catch {}
}

// Re-check on focus if previously missing
window.addEventListener('focus', async () => {
  if (ghMissing || noAgentFound) {
    await checkBinariesAndMaybeShowError();
  }
});

// Fetch config from main process
window.electronAPI.getConfig().then(async (config) => {
  if (config.prNumber) prNumberInput.value = config.prNumber;
  if (config.aiTagPrefix) aiTagPrefix = config.aiTagPrefix;
  fetchCollaborators();

  // Check binaries on startup
  await checkBinariesAndMaybeShowError();

  // Auto-detect AI agent if not configured
  await autoDetectAgent();

  // Load repos and pre-fetch PRs on startup
  try {
    const { repos } = await window.electronAPI.listRepos();
    checkedRepos = (repos || []).filter(r => r.checked);
    if (checkedRepos.length > 0) {
      const reposToFetch = checkedRepos.map(r => ({ owner: r.owner, name: r.name }));
      const { prs } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
      if (prs && prs.length > 0) {
        cachedPrList = prs;
        cachedPrListTime = Date.now();
        // Auto-load first PR if none is loaded
        if (!currentPrNumber && prs.length > 0) {
          await loadPrByNumber(prs[0].number, prs[0].repo);
        }
      }
    }
  } catch {}
}).catch(() => {});

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
  const markers = document.querySelectorAll('[data-comment-index]');
  for (const m of markers) {
    if (parseInt(m.dataset.commentIndex, 10) === currentCommentIndex) {
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

// Override showReviewButtons to also show nav
const _originalShowReviewButtons = showReviewButtons;
function showReviewButtons() {
  btnApprove.style.display = 'inline-block';
  btnRequestChanges.style.display = 'inline-block';
  btnComment.style.display = 'inline-block';
}

// Override updateCommentCount to also update nav
const _originalUpdateCommentCount = updateCommentCount;

// ===================== PR LOADING =====================

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
  prInfo.innerHTML = `<strong>Loading PR #${prNumber}...</strong>`;
  try {
    const result = await window.electronAPI.loadPr({ prNumber, repo: repoKey });
    if (result.error) {
      prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${result.error}`;
      return;
    }
    currentFileName = result.fileName || `pr-${prNumber}.diff`;
    currentDiffContent = result.content;
    currentDiffFilePath = result.filePath;
    allExtensionsInDiff = extractExtensionsFromDiff(result.content);
    loadDiff(result.content, result.filePath);

    // Store PR title for later use
    currentPrTitle = result.prTitle || '';
    currentPrNumber = prNumber;
    currentPrBody = result.prBody || '';

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

    // Update title bar
    document.title = currentPrTitle ? `${currentPrTitle} — PR Reviewer` : `PR Reviewer — PR #${prNumber}`;
    // Store PR number
    prNumberInput.value = prNumber;

    // Build info bar
    updatePrInfoBar(prNumber, currentPrTitle, result);

    // Fetch collaborators from this PR's repo
    if (repoKey) fetchCollaborators(repoKey);

    // Load commits for this PR
    loadPrCommits(prNumber);
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${err.message}`;
  }
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

  // Show cached results immediately if available, else fetch
  if (cachedPrList) {
    renderPrList(cachedPrList);
  } else {
    prDropdown.innerHTML = `
      <div class="pr-search-wrapper">
        <span class="search-icon"><svg viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
        <input type="text" id="pr-search" placeholder="Search PRs by title, author, or number...">
      </div>
      <div class="pr-dropdown-header">Pull Requests Pending Review</div>
      <div class="pr-loading">Loading...</div>`;
    // Get checked repos
    const reposToFetch = checkedRepos.length > 0
      ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
      : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
    const { prs, error } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
    if (error) {
      prDropdown.innerHTML = `
        <div class="pr-search-wrapper">
          <span class="search-icon"><svg viewBox="0 0 24 24" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
          <input type="text" id="pr-search" placeholder="Search PRs by title, author, or number...">
        </div>
        <div class="pr-dropdown-header">Pull Requests Pending Review</div>
        <div class="pr-empty">Error: ${escapeHtml(error)}</div>`;
      return;
    }
    cachedPrList = prs;
    cachedPrListTime = Date.now();
    renderPrList(prs);
  }
}

// Refresh PR list in background (update cache and re-render if dropdown is open)
async function refreshPrList() {
  try {
    const reposToFetch = checkedRepos.length > 0
      ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
      : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
    const { prs, error } = await window.electronAPI.listAllPrs({ repos: reposToFetch });
    if (error || !prs) return null;
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
      prInfo.innerHTML = `<strong>Loading PR #${num} in new window...</strong>`;
      const result = await window.electronAPI.openPrNewWindow(num);
      if (result.error) {
        prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${result.error}`;
      } else {
        prInfo.textContent = '';
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
let activeExtensions = null;
let allExtensionsInDiff = [];

// All possible file extensions (comprehensive list)
const ALL_EXTENSIONS = [
  '.pm', '.cgi', '.js', '.jsx', '.ts', '.tsx', '.tpl', '.css', '.scss', '.less',
  '.json', '.html', '.py', '.rb', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.sql', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt',
  '.php', '.pl', '.rs', '.swift', '.kt', '.scala', '.r', '.m', '.mm',
  '.vue', '.svelte', '.astro', '.elm', '.ex', '.exs', '.erl', '.hs'
];

// Initialize filter from config
async function initFileFilter() {
  const config = await window.electronAPI.getConfig();
  const diffConfig = config.diff || {};
  const configExtensions = diffConfig.codeFileExtensions;
  // If config is blank/empty array, all extensions are active (show all)
  // If config has specific extensions, only those are active
  activeExtensions = (configExtensions && configExtensions.length > 0) ? configExtensions : null;
}

initFileFilter();

// Extract extensions from diff content
function extractExtensionsFromDiff(diffContent) {
  const extensions = new Set();
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      const filePath = line.substring(6);
      const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '';
      if (ext && ALL_EXTENSIONS.includes(ext)) {
        extensions.add(ext);
      }
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
  activeExtensions = (allChecked || noneChecked) ? null : selected;
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

  fileWrappers.forEach(wrapper => {
    const fileNameEl = wrapper.querySelector('.d2h-file-name');
    if (!fileNameEl) return;
    const fileName = fileNameEl.textContent.trim().toLowerCase();
    const matchesName = !currentNameFilter || fileName.includes(currentNameFilter);
    wrapper.style.display = matchesName ? '' : 'none';
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

// Store current diff content for re-rendering
let currentDiffContent = null;
let currentDiffFilePath = null;
let currentPrTitle = '';
let cachedPrList = null;
let cachedPrListTime = 0;
// PR cache never expires — only invalidated by repo changes or manual refresh
let currentPrNumber = null;
let currentPrBody = '';

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

  // Use diff2html to render everything
  const diff2htmlUi = new Diff2HtmlUI(document.getElementById('diff-container'), sortedDiff, {
    drawFileList: true,
    matching: 'lines',
    outputFormat: 'side-by-side',
    colorScheme: 'dark'
  });
  diff2htmlUi.draw();
  diff2htmlUi.fileListToggle(false);

  // Re-add comment buttons
  addLineCommentButtons();
  addFileCommentButtons();

  // Determine which extensions are excluded
  const allExts = extractExtensionsFromDiff(currentDiffContent);
  const excludedExts = activeExtensions ? allExts.filter(e => !activeExtensions.includes(e)) : [];

  // Collapse filtered-out file wrappers
  if (excludedExts.length > 0) {
    collapseFilteredFiles(excludedExts);
  }
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

    // Collapse: hide the diff content area, add toggle icon to header
    const header = wrapper.querySelector('.d2h-file-header');
    const diffContent = wrapper.querySelector('.d2h-files-diff');
    if (!header || !diffContent) continue;

    diffContent.style.display = 'none';

    // Add toggle icon (same SVG chevron as PR description toggle)
    const icon = document.createElement('span');
    icon.className = 'filtered-toggle-icon';
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
    icon.style.cssText = 'cursor:pointer;margin-right:6px;display:inline-flex;align-items:center;transition:transform 0.2s;transform:rotate(-90deg);vertical-align:middle;';
    header.style.cursor = 'pointer';
    fileNameEl.insertBefore(icon, fileNameEl.firstChild);

    // Add "filtered" indicator
    const badge = document.createElement('span');
    badge.className = 'filtered-badge';
    badge.textContent = 'filtered';
    badge.style.cssText = 'font-size:10px;color:#484f58;margin-left:8px;padding:1px 6px;background:#21262d;border-radius:10px;vertical-align:middle;';
    fileNameEl.appendChild(badge);

    // Click handler on header to toggle
    header.addEventListener('click', () => {
      const isHidden = diffContent.style.display === 'none';
      diffContent.style.display = isHidden ? '' : 'none';
      icon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
      if (badge) badge.style.display = isHidden ? 'none' : '';
    });
  }
}

// Filter diff content by file extensions
function filterDiffByExtensions(diffContent, extensions) {
  if (!extensions || extensions.length === 0) return { filtered: sortDiffByExtension(diffContent), excluded: [] };

  const files = diffContent.split(/^diff --git /m);
  const includedFiles = [];
  const excludedFiles = [];

  for (const file of files) {
    if (!file.trim()) return false;
    const firstLine = file.split('\n')[0];
    const filePath = firstLine.match(/a\/(.+?) b\//);
    if (!filePath) continue;
    const ext = filePath[1].includes('.') ? '.' + filePath[1].split('.').pop() : '';
    if (extensions.includes(ext)) {
      includedFiles.push(file);
    } else {
      excludedFiles.push({ name: filePath[1], ext, diff: 'diff --git ' + file });
    }
  }

  // Sort included files by extension, then by name
  includedFiles.sort((a, b) => {
    const extA = getExt(a);
    const extB = getExt(b);
    if (extA !== extB) return extA.localeCompare(extB);
    return getName(a).localeCompare(getName(b));
  });

  return {
    filtered: includedFiles.map(file => 'diff --git ' + file).join(''),
    excluded: excludedFiles
  };
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

  return validFiles.map(f => 'diff --git ' + f).join('');
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
const btnPrNewWindow = document.getElementById('btn-pr-new-window');
const commitsPanel = document.getElementById('commits-panel');
const commitsCount = document.getElementById('commits-count');
let commitsPanelOpen = false;
let prCommits = [];
let prUrl = '';
let blameCache = {};  // { filePath: { lineNum: sha } }
let commitMap = {};   // { sha: commitObj }

// Toggle commits panel
// Open PR in new window
btnPrNewWindow.addEventListener('click', async () => {
  const prNumber = prNumberInput.value.trim();
  if (!prNumber) return;
  try {
    const result = await window.electronAPI.openPrNewWindow(parseInt(prNumber, 10));
    if (result && result.error) {
      prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${result.error}`;
    }
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${err.message}`;
  }
});

btnCommits.addEventListener('click', (e) => {
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
          <span style="font-size:11px;color:#8b949e">${commit.author} · ${date}</span>
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
        require('electron').shell.openExternal(commit.url);
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
    const result = await window.electronAPI.getPrCommits(prNumber);
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
    btnPrNewWindow.style.display = 'flex';

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
      compareIcon = '<span class="pr-compare-toggle" title="View before/after screenshots"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="8" height="18" rx="1"/><rect x="14" y="3" width="8" height="18" rx="1"/></svg></span>';
    }
    html += `<div class="pr-title-line"><span class="pr-title-text" title="Click to show PR description">${escapeHtml(prTitle)}</span><span class="pr-desc-toggle" title="Show PR description"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>${compareIcon}</div>`;
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

  // Render markdown
  const body = currentPrBody || '';
  let rendered = '';
  if (body) {
    try {
      rendered = marked.parse(body);
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
      if (img.naturalWidth > 600) { hasLargeImg = true; break; }
    }
    if (hasLargeImg) {
      dropdown.style.width = '95vw';
      dropdown.style.maxWidth = '95vw';
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
  const imageUrlRegex = /!\[.*?\]\(((?:https?|file):\/\/[^\\s)]+)\)|src="((?:https?|file):\/\/[^"]+)"/;

  // Pattern 1: Look for "before" label followed by image, then "after" label followed by image
  // Supports: ## Before, ### Before, **Before:**, *Before:* etc.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';

    // Check if current line has a "before" indicator
    const beforeMatch = line.match(/^#{1,6}\s+.*before/i) ||
                        line.match(/^\*{1,2}\s*before\s*:?\s*\*{0,2}/i) ||
                        line.match(/^before\s*:/i);

    if (beforeMatch) {
      // Look for an image URL on this line or the next few lines (up to 3 lines ahead)
      let beforeUrl = null;
      for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
        const imgMatch = lines[j].match(imageUrlRegex);
        if (imgMatch) {
          beforeUrl = imgMatch[1] || imgMatch[2]; // markdown or HTML
          break;
        }
      }

      if (beforeUrl) {
        // Now look for "after" label within the next ~10 lines
        for (let k = i + 1; k <= Math.min(i + 10, lines.length - 1); k++) {
          const afterLine = lines[k].trim();
          const afterMatch = afterLine.match(/^#{1,6}\s+.*after/i) ||
                             afterLine.match(/^\*{1,2}\s*after\s*:?\s*\*{0,2}/i) ||
                             afterLine.match(/^after\s*:/i);

          if (afterMatch) {
            // Look for image URL on this line or next few lines
            for (let m = k; m <= Math.min(k + 3, lines.length - 1); m++) {
              const afterImgMatch = lines[m].match(imageUrlRegex);
              if (afterImgMatch) {
                pairs.push({ before: beforeUrl, after: afterImgMatch[1] || afterImgMatch[2] });
                break;
              }
            }
            break; // Found the after pair, stop looking
          }
        }
      }
    }
  }

  // Pattern 2: If no pairs found via headings, try sequential image detection
  // Look for images near standalone "before"/"after" text
  if (pairs.length === 0) {
    let pendingBefore = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Check for standalone before/after text (not headings)
      const isBeforeLine = /^(?:before|after)\s*:?\s*$/i.test(line) ||
                           /^\*{1,2}\s*(?:before|after)\s*:?\s*\*{0,2}$/i.test(line);

      if (isBeforeLine) {
        const isBefore = /^before/i.test(line);
        // Look for image on this line or next 2 lines
        for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
          const imgMatch = lines[j].match(imageUrlRegex);
          if (imgMatch) {
            const url = imgMatch[1] || imgMatch[2]; // markdown or HTML
            if (isBefore) {
              pendingBefore = url;
            } else if (pendingBefore) {
              pairs.push({ before: pendingBefore, after: url });
              pendingBefore = null;
            }
            break;
          }
        }
      }
    }
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

  overlay.innerHTML = `
    <div class="compare-header">
      <span class="compare-counter">${compareOverlayIndex + 1} of ${beforeAfterPairs.length}</span>
      <button class="compare-close" title="Close (Esc)">✕</button>
    </div>
    <div class="compare-body">
      <button class="compare-nav-btn prev" title="Previous (←)">◀</button>
      <div class="compare-side" id="compare-before-side" title="Click to zoom">
        <div class="compare-label">Before</div>
        <img src="${escapeHtml(beforeAfterPairs[compareOverlayIndex].before)}" alt="Before">
      </div>
      <div class="compare-divider"></div>
      <div class="compare-side" id="compare-after-side" title="Click to zoom">
        <div class="compare-label">After</div>
        <img src="${escapeHtml(beforeAfterPairs[compareOverlayIndex].after)}" alt="After">
      </div>
      <button class="compare-nav-btn next" title="Next (→)">▶</button>
    </div>
    <div class="compare-hint">← → Navigate &nbsp;|&nbsp; Click image to zoom &nbsp;|&nbsp; Esc Close</div>
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
  overlay.querySelector('#compare-before-side img').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCompareZoom('before');
  });
  overlay.querySelector('#compare-after-side img').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCompareZoom('after');
  });

  updateCompareNavButtons();
}

function closeCompareSlideshow() {
  const overlay = document.getElementById('compare-overlay');
  if (overlay) overlay.remove();
  compareZoomedSide = null;
}

function navigateCompare(direction) {
  if (direction === 'prev' && compareOverlayIndex > 0) {
    compareOverlayIndex--;
  } else if (direction === 'next' && compareOverlayIndex < beforeAfterPairs.length - 1) {
    compareOverlayIndex++;
  } else {
    return;
  }
  compareZoomedSide = null;

  const overlay = document.getElementById('compare-overlay');
  if (!overlay) return;

  const pair = beforeAfterPairs[compareOverlayIndex];
  overlay.querySelector('.compare-counter').textContent = `${compareOverlayIndex + 1} of ${beforeAfterPairs.length}`;
  const beforeImg = overlay.querySelector('#compare-before-side img');
  const afterImg = overlay.querySelector('#compare-after-side img');
  if (beforeImg) beforeImg.src = pair.before;
  if (afterImg) afterImg.src = pair.after;

  // Reset zoom state
  const beforeSide = overlay.querySelector('#compare-before-side');
  const afterSide = overlay.querySelector('#compare-after-side');
  if (beforeSide) { beforeSide.classList.remove('zoomed', 'zoomed-active'); }
  if (afterSide) { afterSide.classList.remove('zoomed', 'zoomed-active'); }

  updateCompareNavButtons();
}

function updateCompareNavButtons() {
  const overlay = document.getElementById('compare-overlay');
  if (!overlay) return;
  const prevBtn = overlay.querySelector('.compare-nav-btn.prev');
  const nextBtn = overlay.querySelector('.compare-nav-btn.next');
  if (prevBtn) prevBtn.disabled = compareOverlayIndex <= 0;
  if (nextBtn) nextBtn.disabled = compareOverlayIndex >= beforeAfterPairs.length - 1;
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
    const { shell } = require('electron');
    shell.openExternal(link.href);
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
  // Remove existing listeners
  document.querySelectorAll('.d2h-code-side-linenumber').forEach(el => {
    el.removeEventListener('mouseenter', handleLineNumberHover);
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
  if (!config.rules || !config.rules.enabled) return;
  
  rulesOverlay.style.display = 'flex';
  rulesBody.innerHTML = '<div class="rules-loading">Analyzing feedback against existing rules...</div>';
  btnRulesSave.disabled = true;
  
  // Fetch AGENTS.md
  const rulesData = await window.electronAPI.getAgentRules();
  if (rulesData.error) {
    rulesBody.innerHTML = `<div class="rules-empty">Error: ${escapeHtml(rulesData.error)}</div>`;
    return;
  }
  
  // Get proposals from AI (AI reads referenced files and returns availableFiles)
  const result = await window.electronAPI.proposeRules({
    feedback: reviewFeedback,
    agentsMd: rulesData.agentsMd || ''
  });
  
  if (result.disabled) {
    rulesOverlay.style.display = 'none';
    return;
  }
  
  if (result.error) {
    rulesBody.innerHTML = `<div class="rules-empty">Error: ${escapeHtml(result.error)}</div>`;
    return;
  }
  
  currentRuleProposals = result.proposals || [];
  rulesAvailableFiles = result.availableFiles || ['AGENTS.md'];
  
  if (currentRuleProposals.length === 0) {
    rulesBody.innerHTML = '<div class="rules-empty">All feedback is already covered by existing rules. No new rules needed.</div>';
    // Auto-close after 2 seconds and proceed to cleanup
    setTimeout(async () => {
      rulesOverlay.style.display = 'none';
      await cleanupAndLoadNext();
    }, 2000);
    return;
  }
  
  // Render proposals
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
  
  // Load next PR
  const nextResult = await window.electronAPI.getNextPr(prNum);
  if (nextResult.pr) {
    await loadPrByNumber(nextResult.pr.number);
  }
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
  { id: 'pref-editor-cmd', key: 'editorCommand', type: 'text' },
  { id: 'pref-context-lines', key: 'contextLines', type: 'number' },
  { id: 'pref-diff-mode', key: 'diff.mode', type: 'select' },
  { id: 'pref-title-contains', key: 'prFilter.titleContains', type: 'text' },
  { id: 'pref-review-requested', key: 'prFilter.reviewRequested', type: 'checkbox' },
  { id: 'pref-ai-command', key: 'aiCommand', type: 'text' },
  { id: 'pref-ai-tag', key: 'aiTagPrefix', type: 'text' },
  { id: 'pref-autofix-enabled', key: 'autoFix.enabled', type: 'checkbox' },
  { id: 'pref-rules-enabled', key: 'rules.enabled', type: 'checkbox' },
  { id: 'pref-editor-cmd', key: 'editorCommand', type: 'text' },
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
    switchPrefsSection('repository');

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
});

// Listen for menu triggers
window.electronAPI.onOpenPreferences(() => openPreferences());

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
        showToast(`⚠ File "${action.file}" not found in diff`, 'error', 5000);
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
    showToast(`⚠ File "${fileName}" not found in diff`, 'error', 5000);
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
  if (voiceAudioCtx) { voiceAudioCtx.close().catch(() => {}); voiceAudioCtx = null; }
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

