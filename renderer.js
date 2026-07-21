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
const btnExport = document.getElementById('btn-export');
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
      <textarea id="comment-text" placeholder="Write a comment about this file... (start with ${escapeHtml(aiTagPrefix)} to message AI)" autofocus></textarea>
      <div class="actions">
        <button class="btn-cancel" id="comment-cancel">Cancel</button>
        <button class="btn-submit" id="comment-submit">Add Comment</button>
      </div>
    </div>
  `;
  header.parentNode.insertBefore(formDiv, header.nextSibling);

  const ta = formDiv.querySelector('textarea');
  if (ta) ta.focus();

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
      <textarea id="comment-text" placeholder="Write a comment... (start with ${escapeHtml(aiTagPrefix)} to message AI)" autofocus></textarea>
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

  const isAiTagged = text.toLowerCase().startsWith(aiTagPrefix.toLowerCase());
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
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }

    formDiv.querySelector('#comment-cancel').addEventListener('click', () => {
      formDiv.parentNode.replaceChild(marker, formDiv);
      commentTarget = null;
    });
    formDiv.querySelector('#comment-submit').addEventListener('click', () => {
      const newTa = document.getElementById('comment-text');
      const newText = newTa ? newTa.value.trim() : '';
      if (!newText) return;
      comments[idx].text = newText;
      comments[idx].isAiTagged = newText.toLowerCase().startsWith(aiTagPrefix.toLowerCase());
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
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }

    formRow.querySelector('#comment-cancel').addEventListener('click', () => {
      formRow.parentNode.replaceChild(marker, formRow);
      commentTarget = null;
    });
    formRow.querySelector('#comment-submit').addEventListener('click', () => {
      const newTa = document.getElementById('comment-text');
      const newText = newTa ? newTa.value.trim() : '';
      if (!newText) return;
      comments[idx].text = newText;
      comments[idx].isAiTagged = newText.toLowerCase().startsWith(aiTagPrefix.toLowerCase());
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
    const savedPath = await window.electronAPI.saveReview(review);
    const prCount = comments.filter(c => !c.isAiTagged).length;
    const aiCount = comments.filter(c => c.isAiTagged).length;
    let msg = '<strong style="color:#3fb950">✓ Review saved</strong>';
    if (aiCount > 0) msg += ` <span style="color:#58a6ff">(${aiCount} sent to AI)</span>`;
    prInfo.innerHTML = msg;

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
        prInfo.innerHTML = `<strong style="color:#f85149">GitHub submission failed:</strong> ${escapeHtml(result.error)}`;
      } else {
        prInfo.innerHTML = '<strong style="color:#3fb950">✓ Review submitted to GitHub</strong>';
        if (aiCount > 0) {
          prInfo.innerHTML += ` <span style="color:#58a6ff">(${aiCount} sent to AI)</span>`;
        }

        // Collect feedback for rules analysis
        const feedback = [];
        for (const c of comments) {
          if (c.text && !c.text.toLowerCase().startsWith('@hermes')) {
            feedback.push({ file: c.file, line: c.line, text: c.text });
          }
        }
        if (feedback.length > 0) {
          await showRulesDialog(feedback);
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

// Fetch config from main process
window.electronAPI.getConfig().then((config) => {
  if (config.prNumber) prNumberInput.value = config.prNumber;
  if (config.aiTagPrefix) aiTagPrefix = config.aiTagPrefix;
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

btnExport.addEventListener('click', exportAsMarkdown);

// ===================== SHOW/HIDE BUTTONS =====================

// Override showReviewButtons to also show export and nav
const _originalShowReviewButtons = showReviewButtons;
function showReviewButtons() {
  btnApprove.style.display = 'inline-block';
  btnRequestChanges.style.display = 'inline-block';
  btnComment.style.display = 'inline-block';
  btnExport.style.display = 'inline-block';
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

async function loadPrByNumber(prNumber) {
  prInfo.innerHTML = `<strong>Loading PR #${prNumber}...</strong>`;
  try {
    const result = await window.electronAPI.loadPr(prNumber);
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

    // Update title bar
    document.title = currentPrTitle ? `${currentPrTitle} — Diff Reviewer` : `Diff Reviewer — PR #${prNumber}`;
    // Store PR number
    prNumberInput.value = prNumber;

    // Build info bar
    updatePrInfoBar(prNumber, currentPrTitle, result);

    // Load commits for this PR
    loadPrCommits(prNumber);
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${err.message}`;
  }
}

// PR dropdown toggle
btnPrList.addEventListener('click', async (e) => {
  e.stopPropagation();
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
  prDropdown.innerHTML = '<div class="pr-dropdown-header">Pull Requests Pending Review</div><div class="pr-loading">Loading...</div>';

  const { prs, error } = await window.electronAPI.listPrs();

  if (error) {
    prDropdown.innerHTML = `<div class="pr-dropdown-header">Pull Requests Pending Review</div><div class="pr-empty">Error: ${escapeHtml(error)}</div>`;
    return;
  }

  if (prs.length === 0) {
    prDropdown.innerHTML = '<div class="pr-dropdown-header">Pull Requests Pending Review</div><div class="pr-empty">No PRs match your filter</div>';
    return;
  }

  let html = `<div class="pr-dropdown-header">Pull Requests Pending Review (${prs.length})</div>`;
  for (const pr of prs) {
    const date = new Date(pr.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const draft = pr.draft ? '<span class="pr-draft">DRAFT</span>' : '';
    html += `
      <div class="pr-item" data-pr="${pr.number}">
        <div class="pr-item-content">
          <div class="pr-title">${escapeHtml(pr.title)}${draft}</div>
          <div class="pr-meta">
            <span class="pr-number">#${pr.number}</span>
            <span class="pr-author"> by ${escapeHtml(pr.author)}</span>
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
  prDropdown.innerHTML = html;

  // Wire up click handlers
  prDropdown.querySelectorAll('.pr-item-content').forEach(content => {
    content.addEventListener('click', async () => {
      const num = parseInt(content.closest('.pr-item').dataset.pr, 10);
      closePrDropdown();
      await loadPrByNumber(num);
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
        prInfo.textContent = 'No diff loaded';
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
const filterApply = document.getElementById('filter-apply');
let fileFilterOpen = false;
let activeExtensions = [];
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
});

// Select none
filterSelectNone.addEventListener('click', () => {
  filterList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
});

// Apply filter
filterApply.addEventListener('click', () => {
  const selected = [];
  filterList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push(cb.value);
  });
  // If all extensions in the diff are selected, set to null (show all)
  const allChecked = selected.length === allExtensionsInDiff.length;
  activeExtensions = allChecked ? null : selected;
  updateFilterButtonState();
  closeFileFilterDropdown();

  // Re-render the diff with filtered extensions
  if (currentDiffContent) {
    renderFilteredDiff();
  }
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (fileFilterOpen && !fileFilterDropdown.contains(e.target) && e.target !== btnFileFilter) {
    closeFileFilterDropdown();
  }
});

// Store current diff content for re-rendering
let currentDiffContent = null;
let currentDiffFilePath = null;
let currentPrTitle = '';
let currentPrNumber = null;
let currentPrBody = '';

// Override loadDiff to store content and apply filter
const originalLoadDiff = typeof loadDiff !== 'undefined' ? loadDiff : null;

// This function will be called to re-render with current filter
function renderFilteredDiff() {
  if (!currentDiffContent) return;

  // Parse diff and filter by extensions
  const filteredDiff = filterDiffByExtensions(currentDiffContent, activeExtensions);

  // Use diff2html to render
  const diff2htmlUi = new Diff2HtmlUI(document.getElementById('diff-container'), filteredDiff, {
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
}

// Filter diff content by file extensions
function filterDiffByExtensions(diffContent, extensions) {
  if (!extensions || extensions.length === 0) return diffContent;

  const files = diffContent.split(/^diff --git /m);
  const filteredFiles = files.filter(file => {
    if (!file.trim()) return false;
    // Check if this file matches any of the selected extensions
    const firstLine = file.split('\n')[0];
    const filePath = firstLine.match(/a\/(.+?) b\//);
    if (!filePath) return false;
    const ext = filePath[1].includes('.') ? '.' + filePath[1].split('.').pop() : '';
    return extensions.includes(ext);
  });

  return filteredFiles.map(file => 'diff --git ' + file).join('');
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
    html += `<div class="pr-title-line"><strong>${escapeHtml(prTitle)}</strong><button id="btn-pr-desc-toggle" title="Show PR description">▾</button></div>`;
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

  // Add ▾ toggle handler
  const toggleBtn = document.getElementById('btn-pr-desc-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePrDescDropdown();
    });
  }

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

  // Position below the review bar
  const reviewBar = document.getElementById('review-bar');
  const barRect = reviewBar.getBoundingClientRect();
  dropdown.style.top = `${barRect.bottom + 4}px`;
  dropdown.style.left = '50%';
  dropdown.style.transform = 'translateX(-50%)';
  dropdown.classList.add('open');

  // Rotate ▾ arrow
  const toggleBtn = document.getElementById('btn-pr-desc-toggle');
  if (toggleBtn) toggleBtn.classList.add('open');
}

function closePrDescDropdown() {
  const dropdown = document.getElementById('pr-desc-dropdown');
  if (dropdown) dropdown.classList.remove('open');
  const toggleBtn = document.getElementById('btn-pr-desc-toggle');
  if (toggleBtn) toggleBtn.classList.remove('open');
}

// Close PR desc dropdown on click outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('pr-desc-dropdown');
  if (dropdown && dropdown.classList.contains('open')) {
    if (!dropdown.contains(e.target) && e.target.id !== 'btn-pr-desc-toggle') {
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
  
  // Fetch existing rules
  const rulesData = await window.electronAPI.getAgentRules();
  if (rulesData.error) {
    rulesBody.innerHTML = `<div class="rules-empty">Error: ${escapeHtml(rulesData.error)}</div>`;
    return;
  }
  
  // Build available files list
  rulesAvailableFiles = ['AGENTS.md'];
  if (rulesData.instructionFiles) {
    rulesAvailableFiles.push(...Object.keys(rulesData.instructionFiles));
  }
  
  // Get proposals from AI
  const result = await window.electronAPI.proposeRules({
    feedback: reviewFeedback,
    agentsMd: rulesData.agentsMd || '',
    instructionFiles: rulesData.instructionFiles || {}
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


