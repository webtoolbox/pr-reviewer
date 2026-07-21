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
    btn.innerHTML = '💬 Comment <span class="comment-count" style="display:none">0</span>';
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
      <div class="image-paste-hint">💡 Paste an image (Cmd+V) to attach it to your comment</div>
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

// ===================== SUBMIT REVIEW =====================

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
  } catch (err) {
    prInfo.innerHTML = `<strong style="color:#f85149">Error:</strong> ${err.message}`;
  }
}

// ===================== EVENT LISTENERS =====================

btnOpen.addEventListener('click', async () => {
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
  textarea.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          // Show image preview below textarea
          const form = textarea.closest('.comment-form');
          const existing = form.querySelector('.pasted-image');
          if (existing) existing.remove();
          const img = document.createElement('img');
          img.className = 'pasted-image';
          img.src = dataUrl;
          img.style.cssText = 'max-width:100%;max-height:200px;border-radius:4px;border:1px solid #30363d;margin-top:4px;display:block;';
          const actions = form.querySelector('.actions');
          form.insertBefore(img, actions);
        };
        reader.readAsDataURL(blob);
        return;
      }
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
            // Save image as file, use relative path in markdown
            const imgName = `comment-${comments.indexOf(c)}-${Date.now()}.png`;
            const imgPath = await window.electronAPI.saveImage({
              reviewDir: null, imageDataUrl: c.imageDataUrl, fileName: imgName
            });
            if (imgPath) {
              md += `![comment image](${imgPath})\n\n`;
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
    loadDiff(result.content, result.filePath);
    // Update title bar
    document.title = `Diff Reviewer — PR #${prNumber}`;
    // Store PR number
    prNumberInput.value = prNumber;
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
    const reviewers = (pr.reviewers || []).filter(r => r !== pr.author).join(', ');
    const draft = pr.draft ? '<span class="pr-draft">DRAFT</span>' : '';
    html += `
      <div class="pr-item" data-pr="${pr.number}">
        <div class="pr-title">${escapeHtml(pr.title)}${draft}</div>
        <div class="pr-meta">
          <span class="pr-number">#${pr.number}</span>
          <span class="pr-author"> by ${escapeHtml(pr.author)}</span>
          <span> · ${date}</span>
          ${reviewers ? `<span class="pr-reviewers"> · reviewers: ${escapeHtml(reviewers)}</span>` : ''}
        </div>
      </div>`;
  }
  prDropdown.innerHTML = html;

  // Wire up click handlers
  prDropdown.querySelectorAll('.pr-item').forEach(item => {
    item.addEventListener('click', async () => {
      const num = parseInt(item.dataset.pr, 10);
      closePrDropdown();
      await loadPrByNumber(num);
    });
  });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (prDropdownOpen && !prDropdown.contains(e.target) && e.target !== btnPrList) {
    closePrDropdown();
  }
});
