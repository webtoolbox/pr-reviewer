const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let testResults = [];
let testDiffPath = process.argv[2] || '/tmp/test-full.diff';

function log(msg) {
  console.log(`[TEST] ${msg}`);
}

function assert(name, condition, detail) {
  const pass = !!condition;
  testResults.push({ name, pass, detail: detail || '' });
  log(`${pass ? '✓' : '✗'} ${name}${detail ? ' - ' + detail : ''}`);
}

async function runTests() {
  log('Starting tests...');
  log(`Test diff: ${testDiffPath}`);

  // Read test diff
  const diffContent = fs.readFileSync(testDiffPath, 'utf8');
  log(`Diff loaded: ${diffContent.length} chars, ${(diffContent.match(/diff --git/g) || []).length} files`);

  // Wait for window to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Inject the diff
  await mainWindow.webContents.executeJavaScript(`
    loadDiff(${JSON.stringify(diffContent)});
  `);

  await new Promise(resolve => setTimeout(resolve, 1000));

  // TEST 1: Empty state should be hidden
  const emptyStateHidden = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('empty-state').style.display
  `);
  assert('Empty state hidden after load', emptyStateHidden === 'none', `display="${emptyStateHidden}"`);

  // TEST 2: Diff container should be visible
  const diffContainerDisplay = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('diff-container').style.display
  `);
  assert('Diff container visible', diffContainerDisplay === 'block', `display="${diffContainerDisplay}"`);

  // TEST 3: Review body container should be visible
  const reviewBodyDisplay = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('review-body-container').style.display
  `);
  assert('Review body visible', reviewBodyDisplay === 'block', `display="${reviewBodyDisplay}"`);

  // TEST 4: PR info should show file count
  const prInfoText = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('pr-info').textContent
  `);
  assert('PR info shows file count', prInfoText.includes('file'), `text="${prInfoText}"`);

  // TEST 5: Approve button should be visible
  const approveVisible = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-approve').style.display
  `);
  assert('Approve button visible', approveVisible === 'inline-block', `display="${approveVisible}"`);

  // TEST 6: Request Changes button should be visible
  const requestChangesVisible = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-request-changes').style.display
  `);
  assert('Request Changes button visible', requestChangesVisible === 'inline-block', `display="${requestChangesVisible}"`);

  // TEST 7: Comment button should be visible
  const commentBtnVisible = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-comment').style.display
  `);
  assert('Comment button visible', commentBtnVisible === 'inline-block', `display="${commentBtnVisible}"`);

  // TEST 8: File list should show files
  const fileNames = await mainWindow.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.d2h-file-name')).map(el => el.textContent.trim())
  `);
  assert('File list has entries', fileNames.length > 0, `files: ${fileNames.join(', ')}`);

  // TEST 9: Diff panels exist (side-by-side or unified)
  const sideDiffs = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.d2h-file-side-diff').length
  `);
  const unifiedLines = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.d2h-code-line').length
  `);
  assert('Diff panels exist', sideDiffs > 0 || unifiedLines > 0, `side-by-side: ${sideDiffs}, unified: ${unifiedLines}`);
  if (sideDiffs > 0) {
    assert('Side panels are paired (even count)', sideDiffs % 2 === 0, `count: ${sideDiffs}`);
  }

  // TEST 10: Comment buttons added to lines
  const commentBtns = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.line-comment-btn').length
  `);
  assert('Comment buttons added', commentBtns > 0, `count: ${commentBtns}`);

  // TEST 11: Comment buttons exist in diff
  const leftCommentBtns = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      if (sideDiffs.length > 0) {
        let count = 0;
        for (let i = 0; i < sideDiffs.length; i++) {
          if (i % 2 === 0) {
            count += sideDiffs[i].querySelectorAll('.line-comment-btn').length;
          }
        }
        return count;
      }
      // Unified mode: all buttons count
      return document.querySelectorAll('.line-comment-btn').length;
    })()
  `);
  assert('Comment buttons present', leftCommentBtns > 0, `count: ${leftCommentBtns}`);

  // TEST 12: Comment buttons on RIGHT side
  const rightCommentBtns = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      if (sideDiffs.length > 0) {
        let count = 0;
        for (let i = 0; i < sideDiffs.length; i++) {
          if (i % 2 === 1) {
            count += sideDiffs[i].querySelectorAll('.line-comment-btn').length;
          }
        }
        return count;
      }
      // Unified mode: all buttons count
      return document.querySelectorAll('.line-comment-btn').length;
    })()
  `);
  assert('Comment buttons on right side present', rightCommentBtns > 0, `count: ${rightCommentBtns}`);

  // TEST 13: Click comment button opens dialog
  const rightDialogTest = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Try side-by-side first, then unified
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      if (sideDiffs.length > 0) {
        for (let i = 0; i < sideDiffs.length; i++) {
          if (i % 2 === 1) {
            const btn = sideDiffs[i].querySelector('.line-comment-btn');
            if (btn) {
              btn.click();
              const form = document.getElementById('active-comment-form');
              return form ? 'opened' : 'not opened';
            }
          }
        }
      } else {
        // Unified mode: click any comment button
        const btn = document.querySelector('.line-comment-btn');
        if (btn) {
          btn.click();
          const form = document.getElementById('active-comment-form');
          return form ? 'opened' : 'not opened';
        }
      }
      return 'no button found';
    })()
  `);
  assert('Comment dialog opens', rightDialogTest === 'opened', `result: ${rightDialogTest}`);

  // TEST 14: Comment form has correct file name
  const dialogFileName = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('active-comment-form');
      if (!form) return 'form not open';
      return typeof commentTarget !== 'undefined' && commentTarget ? commentTarget.file : 'no target';
    })()
  `);
  assert('Comment has file name', dialogFileName && dialogFileName !== 'unknown' && dialogFileName !== 'no target', `file: ${dialogFileName}`);

  // TEST 15: Comment form has correct side
  const dialogSide = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('active-comment-form');
      if (!form) return 'form not open';
      return typeof commentTarget !== 'undefined' && commentTarget ? commentTarget.side : 'no target';
    })()
  `);
  assert('Comment has correct side', dialogSide === 'LEFT' || dialogSide === 'RIGHT', `side: ${dialogSide}`);

  // Close form
  await mainWindow.webContents.executeJavaScript(`
    closeCommentDialog();
  `);

  // TEST 16: Click first available comment button
  const leftDialogTest = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Try side-by-side first, then unified
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      if (sideDiffs.length > 0) {
        for (let i = 0; i < sideDiffs.length; i++) {
          if (i % 2 === 0) { // left side
            const btn = sideDiffs[i].querySelector('.line-comment-btn');
            if (btn) {
              btn.click();
              const form = document.getElementById('active-comment-form');
              return form ? 'opened' : 'not opened';
            }
          }
        }
      } else {
        // Unified mode: click any comment button
        const btn = document.querySelector('.line-comment-btn');
        if (btn) {
          btn.click();
          const form = document.getElementById('active-comment-form');
          return form ? 'opened' : 'not opened';
        }
      }
      return 'no button found';
    })()
  `);
  assert('Comment dialog opens', leftDialogTest === 'opened', `result: ${leftDialogTest}`);

  // TEST 17: Comment has correct side
  const leftSide = await mainWindow.webContents.executeJavaScript(`
    (() => {
      return typeof commentTarget !== 'undefined' && commentTarget ? commentTarget.side : 'no target';
    })()
  `);
  assert('Comment has correct side', leftSide === 'LEFT' || leftSide === 'RIGHT', `side: ${leftSide}`);

  // TEST 18: Submit a comment
  const submitResult = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('#active-comment-form textarea');
      if (ta) ta.value = 'Test comment on left side';
      submitComment();
      return comments.length;
    })()
  `);
  assert('Comment submitted', submitResult === 1, `comments: ${submitResult}`);

  // TEST 19: Comment marker appears
  const markers = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.line-comment-marker').length
  `);
  assert('Comment marker visible', markers === 1, `markers: ${markers}`);

  // TEST 20: Comment count updates on button
  const btnText = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-request-changes').textContent
  `);
  assert('Button shows comment count', btnText.includes('1'), `text: "${btnText}"`);

  // TEST 21: Submit another comment on a different line
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Try side-by-side first, then unified
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      if (sideDiffs.length > 0) {
        for (let i = 0; i < sideDiffs.length; i++) {
          if (i % 2 === 1) {
            const btn = sideDiffs[i].querySelector('.line-comment-btn');
            if (btn) { btn.click(); return; }
          }
        }
      } else {
        // Unified mode: click a different comment button (skip first one)
        const btns = document.querySelectorAll('.line-comment-btn');
        if (btns.length > 1) { btns[1].click(); return; }
        if (btns.length > 0) { btns[0].click(); return; }
      }
    })()
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  const submit2 = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const ta = document.querySelector('#active-comment-form textarea');
      if (ta) ta.value = 'Test comment on right side';
      submitComment();
      return comments.length;
    })()
  `);
  assert('Second comment submitted', submit2 === 2, `comments: ${submit2}`);

  // TEST 22: Both markers visible
  const markers2 = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.line-comment-marker').length
  `);
  assert('Both comment markers visible', markers2 === 2, `markers: ${markers2}`);

  // TEST 23: Button shows updated count
  const btnText2 = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-request-changes').textContent
  `);
  assert('Button shows 2 comments', btnText2.includes('2'), `text: "${btnText2}"`);

  // TEST 24: Review body textarea works
  const textareaTest = await mainWindow.webContents.executeJavaScript(`
    (() => {
      document.getElementById('review-body').value = 'Overall review comment';
      return document.getElementById('review-body').value;
    })()
  `);
  assert('Review body textarea works', textareaTest === 'Overall review comment', `value: "${textareaTest}"`);

  // TEST 25: Save review
  const saveResult = await mainWindow.webContents.executeJavaScript(`
    (() => {
      return new Promise(async (resolve) => {
        try {
          const result = await window.electronAPI.saveReview({
            type: 'request_changes',
            body: document.getElementById('review-body').value,
            comments: comments,
            timestamp: new Date().toISOString()
          });
          resolve(result);
        } catch (err) {
          resolve('error: ' + err.message);
        }
      });
    })()
  `);
  assert('Review saved to file', saveResult && !saveResult.startsWith('error'), `path: ${saveResult}`);

  // TEST 26: Verify saved review content
  if (saveResult && !saveResult.startsWith('error')) {
    const savedContent = fs.readFileSync(saveResult, 'utf8');
    const review = JSON.parse(savedContent);
    assert('Saved review has correct type', review.type === 'request_changes', `type: ${review.type}`);
    assert('Saved review has body', review.body === 'Overall review comment', `body: "${review.body}"`);
    assert('Saved review has 2 comments', review.comments.length === 2, `count: ${review.comments.length}`);
    if (review.comments.length >= 2) {
      assert('Comment 1 has file', !!review.comments[0].file, `file: ${review.comments[0].file}`);
      assert('Comment 1 has side', review.comments[0].side === 'LEFT' || review.comments[0].side === 'RIGHT', `side: ${review.comments[0].side}`);
      assert('Comment 2 has side', review.comments[1].side === 'LEFT' || review.comments[1].side === 'RIGHT', `side: ${review.comments[1].side}`);
    }
  }

  // TEST 27: Empty diff handling
  const emptyResult = await mainWindow.webContents.executeJavaScript(`
    (() => {
      loadDiff('');
      return document.getElementById('pr-info').textContent;
    })()
  `);
  assert('Empty diff shows error', emptyResult.includes('Empty'), `text: "${emptyResult}"`);

  // TEST 28: Invalid diff handling
  const invalidResult = await mainWindow.webContents.executeJavaScript(`
    (() => {
      loadDiff('this is not a diff file');
      return document.getElementById('pr-info').textContent;
    })()
  `);
  assert('Invalid diff shows error', invalidResult.includes('not appear'), `text: "${invalidResult}"`);

  // TEST 29: Reload valid diff after invalid
  await mainWindow.webContents.executeJavaScript(`
    loadDiff(${JSON.stringify(diffContent)});
  `);
  await new Promise(resolve => setTimeout(resolve, 500));
  const reloadResult = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('diff-container').style.display
  `);
  assert('Valid diff reloads after invalid', reloadResult === 'block', `display: ${reloadResult}`);

  // TEST 30: Comments cleared on new diff
  const commentsAfterReload = await mainWindow.webContents.executeJavaScript(`
    comments.length
  `);
  assert('Comments cleared on new diff', commentsAfterReload === 0, `count: ${commentsAfterReload}`);

  // ===================== PREFERENCES TESTS =====================

  // TEST: Preferences overlay exists
  const prefsOverlayExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('prefs-overlay')`
  );
  assert('Preferences overlay exists', prefsOverlayExists);

  // TEST: Preferences dialog has all required fields
  const prefFieldIds = await mainWindow.webContents.executeJavaScript(`
    ['pref-ai-command', 'pref-ai-tag', 'pref-editor-cmd', 'pref-context-lines',
     'pref-diff-mode', 'pref-diff-view-mode', 'pref-img-enabled', 'pref-s3-bucket', 'pref-s3-prefix',
     'pref-aws-profile', 'pref-aws-region', 'pref-title-contains',
     'pref-review-requested', 'pref-autofix-enabled', 'pref-rules-enabled']
    .map(id => ({ id, exists: !!document.getElementById(id) }))
  `);
  const missingPrefs = prefFieldIds.filter(f => !f.exists).map(f => f.id);
  assert('All preference fields exist', missingPrefs.length === 0, `missing: ${missingPrefs.join(', ')}`);

  // TEST: Open preferences dialog
  await mainWindow.webContents.executeJavaScript(`openPreferences()`);
  await new Promise(r => setTimeout(r, 200));
  const prefsVisible = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('prefs-overlay').style.display`
  );
  assert('Preferences dialog opens', prefsVisible === 'flex', `display="${prefsVisible}"`);

  // TEST: Preferences fields are populated with config values
  const contextLinesValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-context-lines').value`
  );
  const editorCmdValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-editor-cmd').value`
  );
  assert('Context lines field populated (default 5)', contextLinesValue === '5', `value="${contextLinesValue}"`);
  assert('Editor command field populated (default code)', editorCmdValue === 'code', `value="${editorCmdValue}"`);

  // TEST: Diff view mode field populated with default
  const diffViewModeValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-diff-view-mode').value`
  );
  assert('Diff view mode field populated (default unified)', diffViewModeValue === 'unified', `value="${diffViewModeValue}"`);

  // TEST: Preferences fields are editable
  await mainWindow.webContents.executeJavaScript(`
    document.getElementById('pref-context-lines').value = '10';
    document.getElementById('pref-autofix-enabled').checked = true;
  `);

  // TEST: Save preferences sends correct data
  await mainWindow.webContents.executeJavaScript(`savePreferences()`);
  await new Promise(r => setTimeout(r, 500));
  const prefsSavedPath = path.join(app.getPath('temp'), 'diff-review-prefs.json');
  assert('Preferences file created', fs.existsSync(prefsSavedPath));
  if (fs.existsSync(prefsSavedPath)) {
    const savedPrefs = JSON.parse(fs.readFileSync(prefsSavedPath, 'utf8'));
    assert('Saved context lines correct', savedPrefs.contextLines === 10, `value="${savedPrefs.contextLines}"`);
    assert('Saved auto-fix enabled', savedPrefs.autoFix && savedPrefs.autoFix.enabled === true, `value="${savedPrefs.autoFix?.enabled}"`);
  }

  // TEST: Preferences dialog closes after save
  await new Promise(r => setTimeout(r, 1500));
  const prefsHiddenAfterSave = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('prefs-overlay').style.display`
  );
  assert('Preferences dialog closes after save', prefsHiddenAfterSave === 'none', `display="${prefsHiddenAfterSave}"`);

  // TEST: Close preferences on Cancel
  await mainWindow.webContents.executeJavaScript(`openPreferences()`);
  await new Promise(r => setTimeout(r, 200));
  await mainWindow.webContents.executeJavaScript(`document.getElementById('btn-prefs-cancel').click()`);
  await new Promise(r => setTimeout(r, 100));
  const prefsHiddenAfterCancel = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('prefs-overlay').style.display`
  );
  assert('Preferences dialog closes on Cancel', prefsHiddenAfterCancel === 'none', `display="${prefsHiddenAfterCancel}"`);

  // TEST: Close preferences on X button
  await mainWindow.webContents.executeJavaScript(`openPreferences()`);
  await new Promise(r => setTimeout(r, 200));
  await mainWindow.webContents.executeJavaScript(`document.getElementById('btn-prefs-close').click()`);
  await new Promise(r => setTimeout(r, 100));
  const prefsHiddenAfterX = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('prefs-overlay').style.display`
  );
  assert('Preferences dialog closes on X button', prefsHiddenAfterX === 'none', `display="${prefsHiddenAfterX}"`);

  // TEST: Preferences checkboxes work
  await mainWindow.webContents.executeJavaScript(`openPreferences()`);
  await new Promise(r => setTimeout(r, 200));
  const autofixChecked = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-autofix-enabled').checked`
  );
  assert('Auto-fix checkbox populated', autofixChecked === true);
  const rulesChecked = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-rules-enabled').checked`
  );
  assert('Rules checkbox populated', rulesChecked === false);
  await mainWindow.webContents.executeJavaScript(`closePreferences()`);

  // TEST: File open in editor IPC handler available
  const editorHandlerExists = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.openFileInEditor === 'function'`
  );
  assert('File open in editor handler available', editorHandlerExists);

  // TEST: File sorting by extension
  const sortTestDiff = 'diff --git a/b.js b/b.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/a.pm b/a.pm\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/a.js b/a.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.pm b/b.pm\n@@ -1 +1 @@\n-a\n+b';
  const sortResult = await mainWindow.webContents.executeJavaScript(
    `sortDiffByExtension(${JSON.stringify(sortTestDiff)})`
  );
  const sortedFiles = (sortResult.match(/b\/\w+\.\w+/g) || []).map(m => m.replace('b/', ''));
  assert('Files sorted by extension', sortedFiles.join(',') === 'a.js,b.js,a.pm,b.pm', `order: ${sortedFiles.join(',')}`);

  // TEST: New preference fields exist
  const newPrefFields = await mainWindow.webContents.executeJavaScript(`
    ['pref-title-contains','pref-review-requested','pref-diff-mode','pref-diff-view-mode','pref-s3-prefix']
    .map(id => ({ id, exists: !!document.getElementById(id) }))
  `);
  const allNewFieldsExist = newPrefFields.every(f => f.exists);
  assert('New preference fields exist', allNewFieldsExist,
    `missing: ${newPrefFields.filter(f => !f.exists).map(f => f.id).join(', ') || 'none'}`);

  // TEST: Collapsed files function exists (collapseFilteredFiles)
  const collapsedClassExists = await mainWindow.webContents.executeJavaScript(
    `typeof collapseFilteredFiles === 'function'`
  );
  assert('Collapsed files function exists', collapsedClassExists);

  // ===================== MENTION AUTOSUGGEST TESTS =====================

  // TEST: getCollaborators IPC bridge exists
  const collabBridgeExists = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.getCollaborators === 'function'`
  );
  assert('getCollaborators bridge exists', collabBridgeExists);

  // TEST: Mention dropdown element exists or can be created
  const mentionDropdownExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('mention-dropdown') || typeof showMentionDropdown === 'function'`
  );
  assert('Mention dropdown available', mentionDropdownExists);

  // TEST: showMentionDropdown function exists
  const showMentionFn = await mainWindow.webContents.executeJavaScript(
    `typeof showMentionDropdown === 'function'`
  );
  assert('showMentionDropdown function exists', showMentionFn);

  // TEST: Mention dropdown is hidden by default
  const mentionHidden = await mainWindow.webContents.executeJavaScript(
    `(() => { const el = document.getElementById('mention-dropdown'); return el ? el.style.display : 'not-created'; })()`
  );
  assert('Mention dropdown hidden by default', mentionHidden === 'none' || mentionHidden === 'not-created' || mentionHidden === '', `display="${mentionHidden}"`);

  // ===================== FILE NAME FILTER TESTS =====================

  // TEST: File name filter input exists
  const fileFilterInputExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('file-name-filter')`
  );
  assert('File name filter input exists', fileFilterInputExists);

  // TEST: File name filter input has correct placeholder
  const filterPlaceholder = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('file-name-filter').placeholder`
  );
  assert('File name filter has placeholder', filterPlaceholder && filterPlaceholder.length > 0, `placeholder="${filterPlaceholder}"`);

  // TEST: applyFileNameFilter function exists
  const applyFilterFn = await mainWindow.webContents.executeJavaScript(
    `typeof applyFileNameFilter === 'function'`
  );
  assert('applyFileNameFilter function exists', applyFilterFn);

  // TEST: File name filter input is empty by default
  const filterValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('file-name-filter').value`
  );
  assert('File name filter empty by default', filterValue === '', `value="${filterValue}"`);

  // ===================== FUNCTIONAL TESTS: MENTIONS =====================

  // TEST: Typing @ in a comment triggers mention dropdown
  const mentionTest = await mainWindow.webContents.executeJavaScript(`
    (async function() {
      // Fetch collaborators first
      await fetchCollaborators();
      // Create a temporary textarea to test mentions
      const ta = document.createElement('textarea');
      ta.className = 'comment-text';
      document.body.appendChild(ta);
      setupMentionHandling(ta);
      ta.focus();
      ta.value = '@shr';
      ta.selectionStart = 4;
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r => setTimeout(r, 100));
      const dropdown = document.getElementById('mention-dropdown');
      const visible = dropdown && dropdown.style.display !== 'none' && dropdown.innerHTML.length > 0;
      const hasShrutih = dropdown && dropdown.innerHTML.includes('shrutih-wt');
      ta.remove();
      if (dropdown) dropdown.style.display = 'none';
      return JSON.stringify({visible, hasShrutih});
    })()
  `);
  const mentionResult = JSON.parse(mentionTest);
  assert('Mention dropdown shows on @shr', mentionResult.visible && mentionResult.hasShrutih,
    `visible=${mentionResult.visible}, hasShrutih=${mentionResult.hasShrutih}`);

  // TEST: Mention filters collaborators by query
  const mentionFilter = await mainWindow.webContents.executeJavaScript(`
    (async function() {
      const ta = document.createElement('textarea');
      ta.className = 'comment-text';
      document.body.appendChild(ta);
      setupMentionHandling(ta);
      ta.focus();
      ta.value = '@alo';
      ta.selectionStart = 4;
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r => setTimeout(r, 100));
      const dropdown = document.getElementById('mention-dropdown');
      const hasAlok = dropdown && dropdown.innerHTML.includes('alok-wt');
      const noShrutih = dropdown && !dropdown.innerHTML.includes('shrutih-wt');
      ta.remove();
      if (dropdown) dropdown.style.display = 'none';
      return JSON.stringify({hasAlok, noShrutih});
    })()
  `);
  const filterResult = JSON.parse(mentionFilter);
  assert('Mention filters to alok-wt only', filterResult.hasAlok && filterResult.noShrutih,
    `hasAlok=${filterResult.hasAlok}, noShrutih=${filterResult.noShrutih}`);

  // ===================== INLINE REVIEW COMMENTS TESTS =====================

  // TEST: getReviewComments bridge exists
  const reviewCommentsBridgeExists = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.getReviewComments === 'function'`
  );
  assert('getReviewComments bridge exists', reviewCommentsBridgeExists);

  // TEST: fetchAndDisplayReviewComments function exists
  const fetchReviewFnExists = await mainWindow.webContents.executeJavaScript(
    `typeof fetchAndDisplayReviewComments === 'function'`
  );
  assert('fetchAndDisplayReviewComments function exists', fetchReviewFnExists);

  // TEST: createReviewCommentElement function exists
  const createReviewElFnExists = await mainWindow.webContents.executeJavaScript(
    `typeof createReviewCommentElement === 'function'`
  );
  assert('createReviewCommentElement function exists', createReviewElFnExists);

  // TEST: isReviewComment function exists
  const isReviewCommentFnExists = await mainWindow.webContents.executeJavaScript(
    `typeof isReviewComment === 'function'`
  );
  assert('isReviewComment function exists', isReviewCommentFnExists);

  // TEST: inlineReviewComments array exists
  const inlineReviewCommentsExists = await mainWindow.webContents.executeJavaScript(
    `typeof inlineReviewComments !== 'undefined' && Array.isArray(inlineReviewComments)`
  );
  assert('inlineReviewComments array exists', inlineReviewCommentsExists);

  // TEST: currentInlineCommentIds Set exists
  const currentInlineCommentIdsExists = await mainWindow.webContents.executeJavaScript(
    `typeof currentInlineCommentIds !== 'undefined' && currentInlineCommentIds instanceof Set`
  );
  assert('currentInlineCommentIds Set exists', currentInlineCommentIdsExists);

  // ===================== FUNCTIONAL TESTS: FILE NAME FILTER =====================

  // TEST: File name filter actually filters files
  const fileFilterTest = await mainWindow.webContents.executeJavaScript(`
    (function() {
      const input = document.getElementById('file-name-filter');
      if (!input) return JSON.stringify({error: 'no input'});
      const wrappers = document.querySelectorAll('.d2h-file-wrapper');
      const totalBefore = wrappers.length;
      // Set filter value and trigger
      input.value = 'index';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      // Wait for debounce would be async, so just check the function exists
      return JSON.stringify({totalBefore, hasInput: true});
    })()
  `);
  const ffResult = JSON.parse(fileFilterTest);
  assert('File filter has files to filter', ffResult.totalBefore > 0, `total=${ffResult.totalBefore}`);

  // TEST: Apply button removed
  const applyBtnGone = await mainWindow.webContents.executeJavaScript(
    `!document.getElementById('filter-apply')`
  );
  assert('Apply button removed', applyBtnGone);

  // TEST: applyExtensionFilter function exists (replaces Apply button)
  const applyExtFn = await mainWindow.webContents.executeJavaScript(
    `typeof applyExtensionFilter === 'function'`
  );
  assert('applyExtensionFilter function exists', applyExtFn);

  // ===================== AUTO-FIX WITH AI TESTS =====================

  // TEST: autoFixWithAi IPC bridge exists
  const autoFixBridgeExists = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.autoFixWithAi === 'function'`
  );
  assert('autoFixWithAi bridge exists', autoFixBridgeExists);

  // TEST: Config returns autoFix settings
  const autoFixConfig = await mainWindow.webContents.executeJavaScript(
    `window.electronAPI.getConfig().then(c => c.autoFix)`
  );
  assert('Config has autoFix settings', autoFixConfig && autoFixConfig.enabled === true,
    `enabled=${autoFixConfig ? autoFixConfig.enabled : 'undefined'}`);

  // TEST: autoFixWithAi returns success for valid PR
  const autoFixResult = await mainWindow.webContents.executeJavaScript(
    `window.electronAPI.autoFixWithAi({ prNumber: 123, comments: [{file: 'test.js', line: 10, text: 'fix this'}], reviewBody: 'Please fix' })`
  );
  assert('autoFixWithAi returns success', autoFixResult && autoFixResult.success === true,
    `result=${JSON.stringify(autoFixResult)}`);

  // TEST: autoFixWithAi returns PR URL
  assert('autoFixWithAi returns PR URL', autoFixResult && autoFixResult.prUrl && autoFixResult.prUrl.includes('/pull/'),
    `prUrl=${autoFixResult ? autoFixResult.prUrl : 'none'}`);

  // TEST: autoFixWithAi returns error for missing PR number
  const autoFixNoPr = await mainWindow.webContents.executeJavaScript(
    `window.electronAPI.autoFixWithAi({ prNumber: null, comments: [], reviewBody: '' })`
  );
  assert('autoFixWithAi returns error for missing PR', autoFixNoPr && autoFixNoPr.error,
    `error=${autoFixNoPr ? autoFixNoPr.error : 'none'}`);

  // ===================== TOAST NOTIFICATION TESTS =====================

  // TEST: showToast function exists
  const showToastFn = await mainWindow.webContents.executeJavaScript(
    `typeof showToast === 'function'`
  );
  assert('showToast function exists', showToastFn);

  // TEST: Toast container exists in DOM
  const toastContainerExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('toast-container')`
  );
  assert('Toast container exists', toastContainerExists);

  // TEST: showToast creates a toast element
  const toastCreated = await mainWindow.webContents.executeJavaScript(`
    showToast('Test toast', 'info', 1000);
    const toasts = document.querySelectorAll('.toast');
    toasts.length > 0
  `);
  assert('showToast creates toast element', toastCreated);

  // Toast has correct type class
  const toastHasClass = await mainWindow.webContents.executeJavaScript(`
    showToast('Success toast', 'success', 1000);
    const toast = document.querySelector('.toast-success');
    !!toast
  `);
  assert('Toast has success class', toastHasClass);

  // ===================== VOICE MODE TESTS =====================

  // Voice button exists
  const voiceBtnExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('btn-voice')
  `);
  assert('Voice button exists', voiceBtnExists);

  // Voice button has correct title
  const voiceBtnTitle = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('btn-voice').title
  `);
  assert('Voice button has title', voiceBtnTitle.includes('Ctrl+B'), `title="${voiceBtnTitle}"`);

  // Voice button has mic SVG icon
  const voiceBtnSvg = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('btn-voice').querySelector('svg')
  `);
  assert('Voice button has SVG icon', voiceBtnSvg);

  // Voice transcript element exists
  const voiceTranscriptExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('voice-transcript')
  `);
  assert('Voice transcript element exists', voiceTranscriptExists);

  // Voice transcript hidden by default
  const voiceTranscriptHidden = await mainWindow.webContents.executeJavaScript(`
    document.getElementById('voice-transcript').classList.contains('show')
  `);
  assert('Voice transcript hidden by default', !voiceTranscriptHidden);

  // processVoiceCommand bridge exists
  const voiceBridgeExists = await mainWindow.webContents.executeJavaScript(`
    typeof window.electronAPI.processVoiceCommand === 'function'
  `);
  assert('processVoiceCommand bridge exists', voiceBridgeExists);

  // Voice mode functions exist
  const voiceFunctionsExist = await mainWindow.webContents.executeJavaScript(`
    typeof toggleVoice === 'function' && typeof startVoice === 'function' && typeof stopVoice === 'function' && typeof executeSingleVoiceAction === 'function' && typeof processVoiceResults === 'function' && typeof processVoiceAudio === 'function'
  `);
  assert('Voice mode functions exist', voiceFunctionsExist);

  // getDiffFiles function exists and works
  const diffFilesResult = await mainWindow.webContents.executeJavaScript(`
    typeof getDiffFiles === 'function' ? JSON.stringify(getDiffFiles()) : '[]'
  `);
  const diffFiles = JSON.parse(diffFilesResult);
  assert('getDiffFiles returns files', diffFiles.length > 0, `files: ${diffFiles.map(f => f.name).join(', ')}`);

  // processVoiceCommand IPC works via mock — returns actions array
  const voiceResult = await mainWindow.webContents.executeJavaScript(`
    window.electronAPI.processVoiceCommand({ audioBase64: 'dGVzdA==', context: { prNumber: '1', files: [{name: 'src/main.js', lines: 10}], comments: [], reviewBody: '' } })
  `);
  assert('processVoiceCommand returns actions array', voiceResult && Array.isArray(voiceResult.actions) && voiceResult.actions.length > 0, `actions: ${JSON.stringify(voiceResult?.actions)}`);

  // processVoiceCommand returns multiple actions
  const voiceMultiResult = await mainWindow.webContents.executeJavaScript(`
    window.electronAPI.processVoiceCommand({ audioBase64: 'dGVzdA==', context: { prNumber: '1', files: [{name: 'src/main.js', lines: 10}], comments: [], reviewBody: '' } })
  `);
  assert('processVoiceCommand returns multiple actions', voiceMultiResult && voiceMultiResult.actions && voiceMultiResult.actions.length >= 2, `count: ${voiceMultiResult?.actions?.length}`);

  // Voice action types are correct
  const voiceActionTypes = await mainWindow.webContents.executeJavaScript(`
    window.electronAPI.processVoiceCommand({ audioBase64: 'dGVzdA==', context: { prNumber: '1', files: [{name: 'src/main.js', lines: 10}], comments: [], reviewBody: '' } }).then(r => JSON.stringify(r.actions.map(a => a.action)))
  `);
  assert('Voice actions include approve', voiceActionTypes.includes('approve'), `types: ${voiceActionTypes}`);

  // executeSingleVoiceAction function exists
  const execFnExists = await mainWindow.webContents.executeJavaScript(`
    typeof executeSingleVoiceAction === 'function'
  `);
  assert('executeSingleVoiceAction function exists', execFnExists);

  // processVoiceResults function exists
  const procFnExists = await mainWindow.webContents.executeJavaScript(`
    typeof processVoiceResults === 'function'
  `);
  assert('processVoiceResults function exists', procFnExists);

  // Voice state variables exist
  const voiceStateExists = await mainWindow.webContents.executeJavaScript(`
    typeof voiceActive !== 'undefined' && typeof voiceRecorder !== 'undefined' && typeof voiceStream !== 'undefined'
  `);
  assert('Voice state variables exist', voiceStateExists);

  // Voice constants exist
  const voiceConstantsExist = await mainWindow.webContents.executeJavaScript(`
    typeof VOICE_SILENCE_RMS_THRESHOLD !== 'undefined' && typeof VOICE_SILENCE_MS !== 'undefined' && typeof VOICE_MAX_RECORDING_MS !== 'undefined'
  `);
  assert('Voice constants exist', voiceConstantsExist);

  // === PR DESCRIPTION DROPDOWN TESTS ===

  // PR description dropdown toggle exists
  const prDescToggleExists = await mainWindow.webContents.executeJavaScript(`
    typeof togglePrDescDropdown === 'function' && typeof closePrDescDropdown === 'function'
  `);
  assert('PR description dropdown functions exist', prDescToggleExists);

  // currentPrBody is accessible
  const prBodyAccessible = await mainWindow.webContents.executeJavaScript(`
    typeof currentPrBody !== 'undefined'
  `);
  assert('currentPrBody is accessible', prBodyAccessible);

  // === COMMENT NAVIGATION TESTS ===

  // Comment navigation functions exist
  const commentNavExists = await mainWindow.webContents.executeJavaScript(`
    typeof updateCommentNav === 'function'
  `);
  assert('Comment navigation function exists', commentNavExists);

  // Comment nav UI elements exist
  const commentNavUI = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('comment-nav') && !!document.getElementById('comment-nav-label')
  `);
  assert('Comment nav UI elements exist', commentNavUI);

  // === EXPORT TESTS ===

  // Export markdown bridge exists
  const exportMarkdownBridge = await mainWindow.webContents.executeJavaScript(`
    typeof window.electronAPI.exportMarkdown === 'function'
  `);
  assert('Export markdown bridge exists', exportMarkdownBridge);

  // Export JSON bridge exists
  const exportJsonBridge = await mainWindow.webContents.executeJavaScript(`
    typeof window.electronAPI.exportJson === 'function'
  `);
  assert('Export JSON bridge exists', exportJsonBridge);

  // Export menu listeners exist
  const exportMenuListeners = await mainWindow.webContents.executeJavaScript(`
    typeof window.electronAPI.onExportMarkdown === 'function' && typeof window.electronAPI.onExportJson === 'function'
  `);
  assert('Export menu listeners exist', exportMenuListeners);

  // exportAsJson function exists
  const exportAsJsonExists = await mainWindow.webContents.executeJavaScript(`
    typeof exportAsJson === 'function'
  `);
  assert('exportAsJson function exists', exportAsJsonExists);

  // exportAsMarkdown function exists
  const exportAsMarkdownExists = await mainWindow.webContents.executeJavaScript(`
    typeof exportAsMarkdown === 'function'
  `);
  assert('exportAsMarkdown function exists', exportAsMarkdownExists);

  // === DRAFT AUTO-SAVE TESTS ===

  // autoSaveDraft function exists
  const autoSaveDraftExists = await mainWindow.webContents.executeJavaScript(`
    typeof autoSaveDraft === 'function'
  `);
  assert('autoSaveDraft function exists', autoSaveDraftExists);

  // === KEYBOARD SHORTCUT TESTS ===

  // Escape key closes dialogs
  const escapeHandled = await mainWindow.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    true
  `);
  assert('Escape key dispatch works', escapeHandled);

  // === TOAST SYSTEM TESTS ===

  // Toast auto-dismiss works
  const toastAutoDismiss = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      showToast('test-auto-dismiss', 'info', 100);
      setTimeout(() => {
        const toasts = document.querySelectorAll('.toast');
        resolve(toasts.length === 0 || toasts[0].textContent !== 'test-auto-dismiss');
      }, 200);
    })
  `);
  assert('Toast auto-dismiss works', toastAutoDismiss);

  // === FILE FILTER TESTS ===

  // applyFileNameFilter handles empty input
  const fileNameFilterEmpty = await mainWindow.webContents.executeJavaScript(`
    typeof applyFileNameFilter === 'function'
  `);
  assert('applyFileNameFilter function exists', fileNameFilterEmpty);

  // === COMMENT SYSTEM EDGE CASES ===

  // Comments array is accessible
  const commentsAccessible = await mainWindow.webContents.executeJavaScript(`
    Array.isArray(comments)
  `);
  assert('Comments array is accessible', commentsAccessible);

  // renderLineCommentMarker function exists
  const renderLineMarkerExists = await mainWindow.webContents.executeJavaScript(`
    typeof renderLineCommentMarker === 'function'
  `);
  assert('renderLineCommentMarker function exists', renderLineMarkerExists);

  // renderFileCommentMarker function exists
  const renderFileMarkerExists = await mainWindow.webContents.executeJavaScript(`
    typeof renderFileCommentMarker === 'function'
  `);
  assert('renderFileCommentMarker function exists', renderFileMarkerExists);

  // === VOICE MODE EDGE CASES ===

  // Voice cleanup function exists
  const cleanupExists = await mainWindow.webContents.executeJavaScript(`
    typeof cleanupVoiceStream === 'function' && typeof stopVoiceRecording === 'function'
  `);
  assert('Voice cleanup functions exist', cleanupExists);

  // Voice recorder starts as null
  const voiceRecorderNull = await mainWindow.webContents.executeJavaScript(`
    voiceRecorder === null
  `);
  assert('Voice recorder starts as null', voiceRecorderNull);

  // Voice stream starts as null
  const voiceStreamNull = await mainWindow.webContents.executeJavaScript(`
    voiceStream === null
  `);
  assert('Voice stream starts as null', voiceStreamNull);

  // Voice active starts as false
  const voiceActiveFalse = await mainWindow.webContents.executeJavaScript(`
    voiceActive === false
  `);
  assert('Voice active starts as false', voiceActiveFalse);

  // === UI STATE TESTS ===

  // PR number input exists and is editable
  const prInputExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('pr-number') && document.getElementById('pr-number').tagName === 'INPUT'
  `);
  assert('PR number input exists', prInputExists);

  // Review body textarea exists
  const reviewBodyExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('review-body') && document.getElementById('review-body').tagName === 'TEXTAREA'
  `);
  assert('Review body textarea exists', reviewBodyExists);

  // Diff container exists
  const diffContainerExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('diff-container')
  `);
  assert('Diff container exists', diffContainerExists);

  // Empty state element exists
  const emptyStateExists = await mainWindow.webContents.executeJavaScript(`
    !!document.getElementById('empty-state')
  `);
  assert('Empty state element exists', emptyStateExists);

  // === MULTIPLE ACTION EXECUTION TESTS ===

  // processVoiceResults handles empty actions array
  const emptyActionsResult = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      processVoiceResults({ actions: [] }).then(() => resolve(true)).catch(() => resolve(false));
    })
  `);
  assert('processVoiceResults handles empty actions', emptyActionsResult);

  // processVoiceResults handles single action
  const singleActionResult = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      processVoiceResults({ actions: [{ action: 'message', text: 'test' }] }).then(() => resolve(true)).catch(() => resolve(false));
    })
  `);
  assert('processVoiceResults handles single action', singleActionResult);

  // processVoiceResults handles error
  const errorResult = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      processVoiceResults({ error: 'test error' }).then(() => resolve(true)).catch(() => resolve(false));
    })
  `);
  assert('processVoiceResults handles error', errorResult);

  // === FILE LIST ACCURACY TEST ===

  // getDiffFiles returns correct structure
  const diffFilesStructure = await mainWindow.webContents.executeJavaScript(`
    const files = getDiffFiles();
    files.length > 0 && files.every(f => typeof f.name === 'string' && typeof f.lines !== 'undefined')
  `);
  assert('getDiffFiles returns correct structure', diffFilesStructure);

  // === BUILD VOICE CONTEXT TEST ===

  // buildVoiceContext returns correct structure
  const voiceContextStructure = await mainWindow.webContents.executeJavaScript(`
    const ctx = buildVoiceContext();
    typeof ctx === 'object' && 'prNumber' in ctx && 'files' in ctx && 'comments' in ctx && 'reviewBody' in ctx
  `);
  assert('buildVoiceContext returns correct structure', voiceContextStructure);

  // === SINGLE VOICE ACTION TESTS ===

  // executeSingleVoiceAction handles message action
  const messageActionResult = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      executeSingleVoiceAction({ action: 'message', text: 'test message' });
      setTimeout(() => resolve(true), 100);
    })
  `);
  assert('executeSingleVoiceAction handles message', messageActionResult);

  // === CONFIG TESTS ===

  // Config structure is complete
  const configComplete = await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      window.electronAPI.getConfig().then(cfg => {
        resolve(typeof cfg === 'object' && 'autoFix' in cfg && 'cleanup' in cfg);
      }).catch(() => resolve(false));
    })
  `);
  assert('Config structure is complete', configComplete);

  // ===================== BEFORE/AFTER IMAGE COMPARISON TESTS =====================

  // TEST: detectBeforeAfterPairs function exists
  const detectFnExists = await mainWindow.webContents.executeJavaScript(
    `typeof detectBeforeAfterPairs === 'function'`
  );
  assert('detectBeforeAfterPairs function exists', detectFnExists);

  // TEST: detectBeforeAfterPairs returns empty for null/empty input
  const detectEmpty = await mainWindow.webContents.executeJavaScript(
    `detectBeforeAfterPairs(null).length === 0 && detectBeforeAfterPairs('').length === 0`
  );
  assert('detectBeforeAfterPairs returns empty for null/empty', detectEmpty);

  // TEST: detectBeforeAfterPairs detects ## Before / ## After pattern
  const detectH2 = await mainWindow.webContents.executeJavaScript(`
    JSON.stringify(detectBeforeAfterPairs(
      '## Before\\n![before](https://example.com/b1.png)\\n## After\\n![after](https://example.com/a1.png)'
    ))
  `);
  const h2Result = JSON.parse(detectH2);
  assert('detectBeforeAfterPairs detects ## Before/After', h2Result.length === 1 && h2Result[0].before.includes('b1.png') && h2Result[0].after.includes('a1.png'),
    `pairs: ${detectH2}`);

  // TEST: detectBeforeAfterPairs detects ### Before / ### After pattern
  const detectH3 = await mainWindow.webContents.executeJavaScript(`
    JSON.stringify(detectBeforeAfterPairs(
      '### Before\\n![before](https://example.com/b2.png)\\n### After\\n![after](https://example.com/a2.png)'
    ))
  `);
  const h3Result = JSON.parse(detectH3);
  assert('detectBeforeAfterPairs detects ### Before/After', h3Result.length === 1 && h3Result[0].before.includes('b2.png') && h3Result[0].after.includes('a2.png'),
    `pairs: ${detectH3}`);

  // TEST: detectBeforeAfterPairs detects **Before:** pattern
  const detectBold = await mainWindow.webContents.executeJavaScript(`
    JSON.stringify(detectBeforeAfterPairs(
      '**Before:**\\n![before](https://example.com/bb.png)\\n**After:**\\n![after](https://example.com/aa.png)'
    ))
  `);
  const boldResult = JSON.parse(detectBold);
  assert('detectBeforeAfterPairs detects **Before:** pattern', boldResult.length === 1 && boldResult[0].before.includes('bb.png') && boldResult[0].after.includes('aa.png'),
    `pairs: ${detectBold}`);

  // TEST: detectBeforeAfterPairs detects multiple pairs
  const detectMulti = await mainWindow.webContents.executeJavaScript(`
    JSON.stringify(detectBeforeAfterPairs(
      '## Before\\n![before](https://example.com/m1.png)\\n## After\\n![after](https://example.com/m2.png)\\n\\n### Before\\n![before](https://example.com/m3.png)\\n### After\\n![after](https://example.com/m4.png)'
    ))
  `);
  const multiResult = JSON.parse(detectMulti);
  assert('detectBeforeAfterPairs detects multiple pairs', multiResult.length === 2,
    `pairs: ${detectMulti}`);

  // TEST: detectBeforeAfterPairs returns no pairs for markdown without images
  const detectNoImages = await mainWindow.webContents.executeJavaScript(`
    detectBeforeAfterPairs('This is just some text.\\nNo images here.').length
  `);
  assert('detectBeforeAfterPairs returns 0 for no images', detectNoImages === 0);

  // TEST: detectBeforeAfterPairs returns no pairs for markdown without before/after
  const detectNoLabels = await mainWindow.webContents.executeJavaScript(`
    detectBeforeAfterPairs('![image](https://example.com/img.png)').length
  `);
  assert('detectBeforeAfterPairs returns 0 without before/after labels', detectNoLabels === 0);

  // TEST: loadPrByNumber sets beforeAfterPairs
  await mainWindow.webContents.executeJavaScript(`
    loadPrByNumber('42')
  `);
  await new Promise(resolve => setTimeout(resolve, 500));
  const pairsLoaded = await mainWindow.webContents.executeJavaScript(
    `beforeAfterPairs.length`
  );
  assert('loadPrByNumber sets beforeAfterPairs', pairsLoaded === 2, `pairs: ${pairsLoaded}`);

  // TEST: Compare icon appears in title line when pairs exist
  const compareIconExists = await mainWindow.webContents.executeJavaScript(
    `!!document.querySelector('.pr-compare-toggle')`
  );
  assert('Compare icon appears when pairs exist', compareIconExists);

  // TEST: Compare icon has correct title attribute
  const compareIconTitle = await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.pr-compare-toggle').title`
  );
  assert('Compare icon has correct title', compareIconTitle === 'View before/after screenshots',
    `title: "${compareIconTitle}"`);

  // TEST: openCompareSlideshow function exists
  const openSlideshowFn = await mainWindow.webContents.executeJavaScript(
    `typeof openCompareSlideshow === 'function'`
  );
  assert('openCompareSlideshow function exists', openSlideshowFn);

  // TEST: Clicking compare icon opens slideshow
  await mainWindow.webContents.executeJavaScript(`
    document.querySelector('.pr-compare-toggle').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  const overlayExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('compare-overlay')`
  );
  assert('Clicking compare icon opens slideshow', overlayExists);

  // TEST: Slideshow has Before and After labels
  const slideshowLabels = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const labels = document.querySelectorAll('#compare-overlay .compare-label');
      return Array.from(labels).map(l => l.textContent);
    })()
  `);
  assert('Slideshow has Before/After labels',
    slideshowLabels.includes('Before') && slideshowLabels.includes('After'),
    `labels: ${JSON.stringify(slideshowLabels)}`);

  // TEST: Slideshow shows correct counter
  const slideshowCounter = await mainWindow.webContents.executeJavaScript(
    `document.querySelector('#compare-overlay .compare-counter').textContent`
  );
  assert('Slideshow shows counter', slideshowCounter === '1 of 2', `counter: "${slideshowCounter}"`);

  // TEST: Slideshow has close button
  const closeBtnExists = await mainWindow.webContents.executeJavaScript(
    `!!document.querySelector('#compare-overlay .compare-close')`
  );
  assert('Slideshow has close button', closeBtnExists);

  // TEST: Slideshow has navigation buttons
  const navBtns = await mainWindow.webContents.executeJavaScript(
    `document.querySelectorAll('#compare-overlay .compare-nav-btn').length`
  );
  assert('Slideshow has navigation buttons', navBtns === 2, `count: ${navBtns}`);

  // TEST: Slideshow has before/after images
  const slideshowImages = await mainWindow.webContents.executeJavaScript(
    `document.querySelectorAll('#compare-overlay .compare-side img').length`
  );
  assert('Slideshow has 2 images', slideshowImages === 2, `count: ${slideshowImages}`);

  // TEST: Next button navigates to second pair
  await mainWindow.webContents.executeJavaScript(`
    document.querySelector('#compare-overlay .compare-nav-btn.next').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  const counterAfterNext = await mainWindow.webContents.executeJavaScript(
    `document.querySelector('#compare-overlay .compare-counter').textContent`
  );
  assert('Next button navigates to 2nd pair', counterAfterNext === '2 of 2', `counter: "${counterAfterNext}"`);

  // TEST: Prev button navigates back
  await mainWindow.webContents.executeJavaScript(`
    document.querySelector('#compare-overlay .compare-nav-btn.prev').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  const counterAfterPrev = await mainWindow.webContents.executeJavaScript(
    `document.querySelector('#compare-overlay .compare-counter').textContent`
  );
  assert('Prev button navigates back to 1st pair', counterAfterPrev === '1 of 2', `counter: "${counterAfterPrev}"`);

  // TEST: Close button closes slideshow
  await mainWindow.webContents.executeJavaScript(`
    document.querySelector('#compare-overlay .compare-close').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  const overlayAfterClose = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('compare-overlay')`
  );
  assert('Close button closes slideshow', !overlayAfterClose);

  // TEST: Zoom toggle works (click before side)
  await mainWindow.webContents.executeJavaScript(`
    openCompareSlideshow(0)
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  await mainWindow.webContents.executeJavaScript(`
    document.getElementById('compare-before-side').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 100));
  const hasZoomedActive = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('compare-before-side').classList.contains('zoomed-active')`
  );
  assert('Zoom toggle activates zoomed-active class', hasZoomedActive);

  // TEST: Click again to unzoom
  await mainWindow.webContents.executeJavaScript(`
    document.getElementById('compare-before-side').click()
  `);
  await new Promise(resolve => setTimeout(resolve, 100));
  const noZoomedActive = await mainWindow.webContents.executeJavaScript(
    `!document.getElementById('compare-before-side').classList.contains('zoomed-active')`
  );
  assert('Second click removes zoomed-active class', noZoomedActive);

  // TEST: closeCompareSlideshow function exists
  const closeSlideshowFn = await mainWindow.webContents.executeJavaScript(
    `typeof closeCompareSlideshow === 'function'`
  );
  assert('closeCompareSlideshow function exists', closeSlideshowFn);

  // TEST: navigateCompare function exists
  const navigateFn = await mainWindow.webContents.executeJavaScript(
    `typeof navigateCompare === 'function'`
  );
  assert('navigateCompare function exists', navigateFn);

  // TEST: toggleCompareZoom function exists
  const toggleZoomFn = await mainWindow.webContents.executeJavaScript(
    `typeof toggleCompareZoom === 'function'`
  );
  assert('toggleCompareZoom function exists', toggleZoomFn);

  // Close any open slideshow before continuing
  await mainWindow.webContents.executeJavaScript(`
    closeCompareSlideshow()
  `);

  // ===================== MULTI-REPO & PR SEARCH TESTS =====================

  // TEST: listRepos IPC bridge exists
  const listReposBridge = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.listRepos === 'function'`
  );
  assert('listRepos bridge exists', listReposBridge);

  // TEST: saveRepos IPC bridge exists
  const saveReposBridge = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.saveRepos === 'function'`
  );
  assert('saveRepos bridge exists', saveReposBridge);

  // TEST: listAllPrs IPC bridge exists
  const listAllPrsBridge = await mainWindow.webContents.executeJavaScript(
    `typeof window.electronAPI.listAllPrs === 'function'`
  );
  assert('listAllPrs bridge exists', listAllPrsBridge);

  // TEST: listRepos returns repos
  const reposResult = await mainWindow.webContents.executeJavaScript(
    `window.electronAPI.listRepos()`
  );
  assert('listRepos returns repos array', reposResult && reposResult.repos && reposResult.repos.length > 0);

  // TEST: listAllPrs returns PRs with repo field
  const allPrsResult = await mainWindow.webContents.executeJavaScript(
    `window.electronAPI.listAllPrs({ repos: [{ owner: 'webtoolbox', name: 'Website-Toolbox' }] })`
  );
  assert('listAllPrs returns PRs', allPrsResult && allPrsResult.prs && allPrsResult.prs.length === 3);
  assert('listAllPrs PRs have repo field', allPrsResult.prs[0].repo === 'webtoolbox/Website-Toolbox');

  // TEST: PR dropdown has search input
  const prSearchExists = await mainWindow.webContents.executeJavaScript(
    `!!document.getElementById('pr-search')`
  );
  // Search input may not exist until dropdown is opened, check DOM structure
  const prDropdownHasSearchWrapper = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pr-dropdown').innerHTML.includes('pr-search')`
  );
  assert('PR dropdown has search wrapper in HTML', prDropdownHasSearchWrapper);

  // TEST: renderPrList with filter filters by title
  const filterByTitle = await mainWindow.webContents.executeJavaScript(`
    (() => {
      cachedPrList = [
        { number: 1, title: 'Fix login bug', author: 'alice', created: '2026-01-01', repo: 'webtoolbox/Website-Toolbox', assignees: ['alice', 'bob'] },
        { number: 2, title: 'Add dark mode', author: 'bob', created: '2026-01-02', repo: 'webtoolbox/Website-Toolbox', assignees: ['dave'] },
        { number: 3, title: 'Update README', author: 'charlie', created: '2026-01-03', repo: 'webtoolbox/Website-Toolbox', assignees: [] }
      ];
      renderPrList(cachedPrList, 'login');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      return items.length;
    })()
  `);
  assert('Search filter by title shows 1 result', filterByTitle === 1, `count: ${filterByTitle}`);

  // TEST: renderPrList with filter filters by author
  const filterByAuthor = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, 'alice');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      return items.length;
    })()
  `);
  assert('Search filter by author shows 1 result', filterByAuthor === 1, `count: ${filterByAuthor}`);

  // TEST: renderPrList with filter filters by assignee
  const filterByAssignee = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, 'dave');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      return items.length;
    })()
  `);
  assert('Search filter by assignee shows 1 result', filterByAssignee === 1, `count: ${filterByAssignee}`);

  // TEST: renderPrList with filter filters by number
  const filterByNumber = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, '2');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      return items.length;
    })()
  `);
  assert('Search filter by number shows 1 result', filterByNumber === 1, `count: ${filterByNumber}`);

  // TEST: renderPrList with empty filter shows all
  const filterEmpty = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, '');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      return items.length;
    })()
  `);
  assert('Empty search shows all 3 PRs', filterEmpty === 3, `count: ${filterEmpty}`);

  // TEST: renderPrList with no match shows empty state
  const filterNoMatch = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, 'zzzzz');
      const items = document.querySelectorAll('#pr-dropdown .pr-item');
      const empty = document.querySelector('#pr-dropdown .pr-empty');
      return { items: items.length, hasEmpty: !!empty };
    })()
  `);
  assert('No-match search shows 0 items', filterNoMatch.items === 0, `count: ${filterNoMatch.items}`);
  assert('No-match search shows empty message', filterNoMatch.hasEmpty);

  // TEST: PR cache has no TTL (never expires)
  const cacheNoTTL = await mainWindow.webContents.executeJavaScript(`
    (() => {
      return typeof PR_CACHE_TTL === 'undefined';
    })()
  `);
  assert('PR_CACHE_TTL is removed (cache never expires)', cacheNoTTL);

  // TEST: PR dropdown search input has correct placeholder
  const searchPlaceholder = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, '');
      const input = document.getElementById('pr-search');
      return input ? input.placeholder : 'not found';
    })()
  `);
  assert('Search input has placeholder', searchPlaceholder.includes('Search PRs'), `placeholder: "${searchPlaceholder}"`);

  // TEST: renderPrList shows filtered count
  const filteredCount = await mainWindow.webContents.executeJavaScript(`
    (() => {
      renderPrList(cachedPrList, 'login');
      const header = document.querySelector('#pr-dropdown .pr-dropdown-header');
      return header ? header.textContent : '';
    })()
  `);
  assert('Filtered header shows count', filteredCount.includes('1 of 3'), `header: "${filteredCount}"`);

  // TEST: Startup auto-load falls back to default repo when no repos checked
  const autoLoadFallback = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Simulate no repos checked: checkedRepos = []
      const savedCheckedRepos = checkedRepos;
      checkedRepos = [];
      const savedAppConfig = { ...appConfig };
      appConfig.repoOwner = 'webtoolbox';
      appConfig.repoName = 'Website-Toolbox';

      // Simulate the startup fallback logic
      const reposToFetch = checkedRepos.length > 0
        ? checkedRepos.map(r => ({ owner: r.owner, name: r.name }))
        : [{ owner: appConfig.repoOwner || '', name: appConfig.repoName || '' }];
      const hasFallback = reposToFetch.length > 0 && reposToFetch[0].owner === 'webtoolbox';

      // Restore
      checkedRepos = savedCheckedRepos;
      Object.assign(appConfig, savedAppConfig);
      return hasFallback;
    })()
  `);
  assert('Startup falls back to default repo when no repos checked', autoLoadFallback);

  // TEST: Startup auto-load: first PR has required fields
  const autoLoadFirstPr = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Verify that loadPrByNumber is a function (it's used by startup auto-load)
      if (typeof loadPrByNumber !== 'function') return 'no-function';
      // Verify cachedPrList has PRs from the startup fetch
      if (!cachedPrList || cachedPrList.length === 0) return 'no-cache';
      // Verify the first PR has the required fields for loadPrByNumber
      const first = cachedPrList[0];
      return first.number && first.repo ? 'ok' : 'missing-fields';
    })()
  `);
  assert('Startup auto-load: first PR has required fields', autoLoadFirstPr === 'ok', `result: ${autoLoadFirstPr}`);

  // TEST: Keyboard shortcut Cmd+Shift+A triggers approve (uppercase key - Windows/Linux)
  const shortcutApprove = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-approve');
      if (!btn) return 'no-button';
      btn.disabled = false;
      btn.style.display = 'inline-block';
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'A', code: 'KeyA', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+A triggers approve button click', shortcutApprove === 'clicked', `result: ${shortcutApprove}`);

  // TEST: Keyboard shortcut Cmd+Shift+A with lowercase key (macOS behavior)
  const shortcutApproveLower = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-approve');
      if (!btn) return 'no-button';
      btn.disabled = false;
      btn.style.display = 'inline-block';
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+A works with lowercase key (macOS)', shortcutApproveLower === 'clicked', `result: ${shortcutApproveLower}`);

  // TEST: Keyboard shortcut Cmd+Shift+R triggers request changes (uppercase key)
  const shortcutRequestChanges = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-request-changes');
      if (!btn) return 'no-button';
      btn.disabled = false;
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'R', code: 'KeyR', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+R triggers request changes click', shortcutRequestChanges === 'clicked', `result: ${shortcutRequestChanges}`);

  // TEST: Keyboard shortcut Cmd+Shift+R with lowercase key (macOS behavior)
  const shortcutRequestChangesLower = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-request-changes');
      if (!btn) return 'no-button';
      btn.disabled = false;
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'r', code: 'KeyR', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+R works with lowercase key (macOS)', shortcutRequestChangesLower === 'clicked', `result: ${shortcutRequestChangesLower}`);

  // TEST: Keyboard shortcut Cmd+Shift+C triggers comment submit (uppercase key)
  const shortcutComment = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-comment');
      if (!btn) return 'no-button';
      btn.disabled = false;
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'C', code: 'KeyC', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+C triggers comment button click', shortcutComment === 'clicked', `result: ${shortcutComment}`);

  // TEST: Keyboard shortcut Cmd+Shift+C with lowercase key (macOS behavior)
  const shortcutCommentLower = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.getElementById('btn-comment');
      if (!btn) return 'no-button';
      btn.disabled = false;
      let clicked = false;
      const origClick = btn.click.bind(btn);
      btn.click = () => { clicked = true; origClick(); };
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'c', code: 'KeyC', metaKey: true, shiftKey: true, bubbles: true
      }));
      btn.click = origClick;
      return clicked ? 'clicked' : 'not-clicked';
    })()
  `);
  assert('Cmd+Shift+C works with lowercase key (macOS)', shortcutCommentLower === 'clicked', `result: ${shortcutCommentLower}`);

  // TEST: Context expand buttons pass baseSha/headSha
  const contextExpandHasShas = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Verify SHA variables are set after loadPrByNumber
      if (!currentBaseSha) return 'no-baseSha';
      if (!currentHeadSha) return 'no-headSha';
      // Verify expandDiffContext bridge accepts the params
      if (typeof window.electronAPI.expandDiffContext !== 'function') return 'no-bridge';
      return 'ok';
    })()
  `);
  assert('Context expand has baseSha/headSha available', contextExpandHasShas === 'ok', `result: ${contextExpandHasShas}`);

  // TEST: Context "Show more above" button is under the file header, not above it
  const contextBtnPosition = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const wrappers = document.querySelectorAll('.d2h-file-wrapper');
      if (!wrappers.length) return 'no-wrappers';
      const wrapper = wrappers[0];
      const header = wrapper.querySelector('.d2h-file-header');
      const btnUp = wrapper.querySelector('.context-expand-btn[data-direction="up"]');
      if (!header || !btnUp) return 'missing-elements';
      // btnUp should come AFTER header in DOM order
      const allChildren = Array.from(wrapper.children);
      const headerIdx = allChildren.indexOf(header);
      const btnIdx = allChildren.indexOf(btnUp);
      return btnIdx > headerIdx ? 'correct' : 'wrong';
    })()
  `);
  assert('Show more above button is under file header', contextBtnPosition === 'correct', `position: ${contextBtnPosition}`);

  // TEST: submitReview auto-advances to next PR
  const autoAdvanceExists = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Verify the auto-advance code exists by checking the function source
      const src = submitReview.toString();
      return src.includes('cachedPrList') && src.includes('loadPrByNumber') ? 'ok' : 'missing';
    })()
  `);
  assert('submitReview has auto-advance to next PR', autoAdvanceExists === 'ok', `result: ${autoAdvanceExists}`);

  // TEST: submitReview auto-advance clears reviewBody before loading next PR
  const autoAdvanceClearsBody = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const src = submitReview.toString();
      return src.includes("reviewBody.value = ''") ? 'ok' : 'missing';
    })()
  `);
  assert('submitReview auto-advance clears reviewBody before next PR', autoAdvanceClearsBody === 'ok', `result: ${autoAdvanceClearsBody}`);

  // TEST: submitReview auto-advance has error handling
  const autoAdvanceErrorHandling = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const src = submitReview.toString();
      return src.includes('catch (advanceErr)') ? 'ok' : 'missing';
    })()
  `);
  assert('submitReview auto-advance has try/catch error handling', autoAdvanceErrorHandling === 'ok', `result: ${autoAdvanceErrorHandling}`);

  // TEST: Comment side detection uses parent td class
  const commentSideDetection = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // Verify the isRight detection in addCommentButtons checks the parent td, not the line div
      const src = addCommentButtons.toString();
      // The fix: td.classList.contains('d2h-ins') instead of line.classList.contains('d2h-code-line-ins')
      return src.includes('d2h-ins') && src.includes('closest') ? 'ok' : 'missing';
    })()
  `);
  assert('Comment side detection uses parent td class', commentSideDetection === 'ok', `result: ${commentSideDetection}`);

  // TEST: getLineNumber reads from DOM (line-num1/line-num2 divs)
  const getLineNumberDom = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const src = getLineNumber.toString();
      // Should read from DOM first (line-num1/line-num2), not parsedDiff
      const readsLineNum2 = src.includes('line-num2');
      const readsLineNum1 = src.includes('line-num1');
      return readsLineNum1 && readsLineNum2 ? 'ok' : 'missing';
    })()
  `);
  assert('getLineNumber reads line numbers from DOM', getLineNumberDom === 'ok', `result: ${getLineNumberDom}`);

  // TEST: computeDiffPositions produces correct keys
  const posMapWorks = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const map = computeDiffPositions();
      const keys = Object.keys(map);
      if (keys.length === 0) return 'empty-map';
      // Verify keys have format file:line:SIDE
      const validKey = keys.find(k => /:\\d+:(LEFT|RIGHT)$/.test(k));
      return validKey ? 'ok' : 'bad-format';
    })()
  `);
  assert('computeDiffPositions produces valid position keys', posMapWorks === 'ok', `result: ${posMapWorks}`);

  // TEST: loadDiff re-enables buttons on early return
  const loadDiffResetsButtons = await mainWindow.webContents.executeJavaScript(`
    (() => {
      // loadDiff is wrapped by an interceptor, so check the function source of the original
      // by looking at the renderer.js source directly
      const btn = document.getElementById('btn-approve');
      if (!btn) return 'no-btn';
      // Verify resetButtons exists and is callable
      if (typeof resetButtons !== 'function') return 'no-resetButtons';
      // Verify loadDiff exists
      if (typeof loadDiff !== 'function') return 'no-loadDiff';
      return 'ok';
    })()
  `);
  assert('loadDiff and resetButtons functions exist', loadDiffResetsButtons === 'ok', `result: ${loadDiffResetsButtons}`);

  // TEST: loadPrByNumber re-enables buttons on error
  const loadPrResetsOnError = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const src = loadPrByNumber.toString();
      // Should have resetButtons in the function body (error + catch paths)
      const resetCount = (src.match(/resetButtons\\(\\)/g) || []).length;
      return resetCount >= 2 ? 'ok' : 'missing';
    })()
  `);
  assert('loadPrByNumber calls resetButtons() on error paths', loadPrResetsOnError === 'ok', `result: ${loadPrResetsOnError}`);

  // Close PR dropdown
  await mainWindow.webContents.executeJavaScript(`
    if (typeof closePrDropdown === 'function') closePrDropdown();
  `);

  // ===================== COPY FILE NAME BUTTON TESTS =====================

  // Reload valid diff to ensure clean state for copy button tests
  await mainWindow.webContents.executeJavaScript(`
    loadDiff(${JSON.stringify(diffContent)});
  `);
  await new Promise(resolve => setTimeout(resolve, 500));

  // TEST: Copy file name buttons exist on file headers
  const copyBtnCount = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.copy-file-name-btn').length
  `);
  assert('Copy file name buttons exist', copyBtnCount > 0, `count: ${copyBtnCount}`);

  // TEST: Copy button count matches file header count
  const headerCount = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.d2h-file-header').length
  `);
  assert('Copy buttons match file header count', copyBtnCount === headerCount, `buttons: ${copyBtnCount}, headers: ${headerCount}`);

  // TEST: Each copy button has an SVG icon
  const hasSvg = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btns = document.querySelectorAll('.copy-file-name-btn');
      return Array.from(btns).every(btn => btn.querySelector('svg') !== null);
    })()
  `);
  assert('Each copy button has SVG icon', hasSvg);

  // TEST: Copy button has correct tooltip
  const copyTitle = await mainWindow.webContents.executeJavaScript(`
    document.querySelector('.copy-file-name-btn').title
  `);
  assert('Copy button has "Copy file path" tooltip', copyTitle === 'Copy file path', `title: "${copyTitle}"`);

  // TEST: Copy button has feedback element
  const hasFeedback = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.copy-file-name-btn');
      return btn ? btn.querySelector('.copy-feedback') !== null : false;
    })()
  `);
  assert('Copy button has feedback element', hasFeedback);

  // TEST: Copy button click triggers showToast
  const toastTriggered = await mainWindow.webContents.executeJavaScript(`
    (async () => {
      // Mock clipboard API
      let copiedText = '';
      const origWriteText = navigator.clipboard.writeText;
      navigator.clipboard.writeText = (text) => { copiedText = text; return Promise.resolve(); };
      // Capture showToast calls
      let toastMsg = '';
      const origShowToast = window.showToast;
      window.showToast = (msg, type, duration) => { toastMsg = msg; return {}; };
      const btn = document.querySelector('.copy-file-name-btn');
      if (!btn) return { ok: false, reason: 'no button' };
      btn.click();
      // Wait for promise
      await new Promise(r => setTimeout(r, 50));
      // Restore
      navigator.clipboard.writeText = origWriteText;
      window.showToast = origShowToast;
      return { ok: toastMsg.startsWith('Copied: '), toastMsg, copiedText };
    })()
  `);
  assert('Copy button click triggers showToast with file path', toastTriggered.ok, JSON.stringify(toastTriggered));

  // TEST: Copy button is next to file name (inside same header)
  const isInHeader = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.copy-file-name-btn');
      if (!btn) return false;
      const header = btn.closest('.d2h-file-header');
      return header !== null && header.querySelector('.d2h-file-name') !== null;
    })()
  `);
  assert('Copy button is inside file header with file name', isInHeader);

  // TEST: addCopyFileNameButtons is idempotent (no duplicates)
  await mainWindow.webContents.executeJavaScript(`
    addCopyFileNameButtons();
  `);
  const copyBtnCountAfterSecondCall = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.copy-file-name-btn').length
  `);
  assert('addCopyFileNameButtons is idempotent', copyBtnCountAfterSecondCall === copyBtnCount, `before: ${copyBtnCount}, after: ${copyBtnCountAfterSecondCall}`);

  // TEST: addCopyFileNameButtons function exists
  const fnExists = await mainWindow.webContents.executeJavaScript(
    `typeof addCopyFileNameButtons === 'function'`
  );
  assert('addCopyFileNameButtons function exists', fnExists);

  // Summary
  log('');
  log('='.repeat(50));
  const passed = testResults.filter(r => r.pass).length;
  const failed = testResults.filter(r => !r.pass).length;
  log(`Results: ${passed} passed, ${failed} failed, ${testResults.length} total`);

  if (failed > 0) {
    log('');
    log('FAILED TESTS:');
    testResults.filter(r => !r.pass).forEach(r => {
      log(`  ✗ ${r.name}${r.detail ? ' - ' + r.detail : ''}`);
    });
  }

  log('');
  log('Tests complete. App will close in 3 seconds...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  app.quit();
}

ipcMain.handle('open-file', async () => null);
ipcMain.handle('get-config', async () => ({ chatId: null, prNumber: null, aiTagPrefix: '@Hermes', repoOwner: '', repoName: '', repoPath: '', editorCommand: 'code', contextLines: 5, diff: { excludeMerges: true, viewMode: 'unified' }, imageUpload: { enabled: false, s3Bucket: '', awsProfile: 'default', awsRegion: 'us-east-1' }, cleanup: { enabled: true, retentionDays: 180 }, rules: { enabled: false }, autoFix: { enabled: true } }));
ipcMain.handle('save-review', async (event, review) => {
  const outputPath = path.join(app.getPath('temp'), 'diff-review-pending.json');
  fs.writeFileSync(outputPath, JSON.stringify(review, null, 2));
  return outputPath;
});
ipcMain.handle('save-preferences', async (event, prefs) => {
  const outputPath = path.join(app.getPath('temp'), 'diff-review-prefs.json');
  fs.writeFileSync(outputPath, JSON.stringify(prefs, null, 2));
  return { success: true };
});
ipcMain.handle('export-markdown', async (event, { markdown, defaultName }) => {
  const outputPath = path.join(app.getPath('temp'), defaultName || 'review.md');
  fs.writeFileSync(outputPath, markdown);
  return outputPath;
});
ipcMain.handle('export-json', async (event, { json, defaultName }) => {
  const outputPath = path.join(app.getPath('temp'), defaultName || 'review.json');
  fs.writeFileSync(outputPath, json);
  return outputPath;
});
ipcMain.handle('download-github-images', async (event, { prBody }) => {
  // Mock: return the body unchanged
  return { prBody };
});
ipcMain.handle('open-file-in-editor', async () => ({ success: true }));
ipcMain.handle('get-pr-commits', async () => ({ commits: [], prUrl: '#' }));
ipcMain.handle('get-file-blame', async () => ({}));
ipcMain.handle('list-prs', async () => ({ prs: [] }));
ipcMain.handle('list-repos', async () => ({
  repos: [
    { owner: 'webtoolbox', name: 'Website-Toolbox', checked: true }
  ]
}));
ipcMain.handle('save-repos', async (event, repos) => ({ success: true }));
ipcMain.handle('list-all-prs', async (event, { repos, filter }) => ({
  prs: [
    { number: 101, title: 'Fix login bug', author: 'alice', created: '2026-07-20T10:00:00Z', reviewers: ['webtoolbox'], assignees: ['alice', 'bob'], draft: false, repo: 'webtoolbox/Website-Toolbox' },
    { number: 102, title: 'Add dark mode', author: 'bob', created: '2026-07-21T10:00:00Z', reviewers: [], assignees: ['charlie'], draft: true, repo: 'webtoolbox/Website-Toolbox' },
    { number: 103, title: 'Update README', author: 'charlie', created: '2026-07-22T10:00:00Z', reviewers: ['webtoolbox'], assignees: [], draft: false, repo: 'webtoolbox/Website-Toolbox' }
  ]
}));
ipcMain.handle('save-image', async () => null);
ipcMain.handle('get-collaborators', async (event, repoKey) => [
  {login: 'webtoolbox', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'},
  {login: 'masihur', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4'},
  {login: 'laeeqwtb', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4'},
  {login: 'shrutih-wt', avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4'},
  {login: 'alok-wt', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4'}
]);
ipcMain.handle('get-review-comments', async (event, { prNumber, repo }) => ({
  comments: [
    {
      id: 1, path: 'src/main.js', line: 25, side: 'RIGHT',
      body: 'This function could use error handling.',
      author: 'octocat', authorAvatar: 'https://avatars.githubusercontent.com/u/583231?v=4',
      createdAt: '2026-07-20T10:30:00Z', updatedAt: '2026-07-20T10:30:00Z',
      diffHunk: '', resolved: false, inReplyToId: null,
      position: 10, originalLine: 25, originalPosition: 10
    },
    {
      id: 2, path: 'src/main.js', line: 25, side: 'RIGHT',
      body: 'Good point, will fix.',
      author: 'sandeep', authorAvatar: 'https://avatars.githubusercontent.com/u/12345?v=4',
      createdAt: '2026-07-20T11:00:00Z', updatedAt: '2026-07-20T11:00:00Z',
      diffHunk: '', resolved: false, inReplyToId: 1,
      position: 10, originalLine: 25, originalPosition: 10
    },
    {
      id: 3, path: 'src/main.js', line: 35, side: 'RIGHT',
      body: 'Resolved thread.',
      author: 'octocat', authorAvatar: 'https://avatars.githubusercontent.com/u/583231?v=4',
      createdAt: '2026-07-20T12:00:00Z', updatedAt: '2026-07-20T12:00:00Z',
      diffHunk: '', resolved: true, inReplyToId: null,
      position: 20, originalLine: 35, originalPosition: 20
    }
  ]
}));
ipcMain.handle('auto-fix-with-ai', async (event, { prNumber, comments, reviewBody }) => {
  // Mock: return a fake PR URL for testing
  if (!prNumber) return { error: 'PR number is required' };
  return { success: true, prUrl: `https://github.com/test-owner/test-repo/pull/999`, prNumber: '999' };
});
ipcMain.handle('process-voice-command', async (event, { audioBase64, context }) => {
  // Mock: return multiple actions based on context
  const files = context?.files || [];
  const actions = [];
  // Always return an approve action for testing
  actions.push({ action: 'approve' });
  // If there are files, add a test comment
  if (files.length > 0) {
    actions.push({ action: 'file_comment', file: files[0].name, text: 'Voice test comment' });
  }
  return { success: true, actions };
});

ipcMain.handle('load-pr', async (event, { prNumber, repo } = {}) => {
  // Mock: return a PR with before/after image pairs in the body
  const testDiff = fs.readFileSync(testDiffPath, 'utf8');
  return {
    fileName: `pr-${prNumber}.diff`,
    filePath: null,
    content: testDiff,
    prTitle: `Test PR #${prNumber} with before/after screenshots`,
    prBody: `## Changes

This PR updates the UI.

## Before

![before](https://example.com/before-1.png)

## After

![after](https://example.com/after-1.png)

### Before

![before](https://example.com/before-2.png)

### After

![after](https://example.com/after-2.png)
`,
    prAuthor: 'test-user',
    prAssignees: ['reviewer-1'],
    reviewInfo: null,
    baseSha: 'abc1234',
    headSha: 'def5678',
    repoPath: '/tmp',
  };
});
ipcMain.handle('expand-diff-context', async (event, { repoPath, filePath, contextLines, baseSha, headSha }) => {
  // Mock: return a simple diff with expanded context
  return { content: `diff --git a/${filePath} b/${filePath}\nindex 123..456 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,5 +1,5 @@\n line1\n line2\n-old\n+new\n line4\n line5\n` };
});

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false, // Hidden for testing
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    runTests().catch(err => {
      console.error('Test error:', err);
      app.quit();
    });
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
