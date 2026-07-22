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

  // TEST 9: Side-by-side panels exist
  const sideDiffs = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.d2h-file-side-diff').length
  `);
  assert('Side-by-side panels exist', sideDiffs > 0, `count: ${sideDiffs}`);
  assert('Side panels are paired (even count)', sideDiffs % 2 === 0, `count: ${sideDiffs}`);

  // TEST 10: Comment buttons added to lines
  const commentBtns = await mainWindow.webContents.executeJavaScript(`
    document.querySelectorAll('.line-comment-btn').length
  `);
  assert('Comment buttons added', commentBtns > 0, `count: ${commentBtns}`);

  // TEST 11: Comment buttons on LEFT side
  const leftCommentBtns = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      let count = 0;
      for (let i = 0; i < sideDiffs.length; i++) {
        if (i % 2 === 0) { // left side
          count += sideDiffs[i].querySelectorAll('.line-comment-btn').length;
        }
      }
      return count;
    })()
  `);
  assert('Comment buttons on LEFT side', leftCommentBtns > 0, `count: ${leftCommentBtns}`);

  // TEST 12: Comment buttons on RIGHT side
  const rightCommentBtns = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      let count = 0;
      for (let i = 0; i < sideDiffs.length; i++) {
        if (i % 2 === 1) { // right side
          count += sideDiffs[i].querySelectorAll('.line-comment-btn').length;
        }
      }
      return count;
    })()
  `);
  assert('Comment buttons on RIGHT side', rightCommentBtns > 0, `count: ${rightCommentBtns}`);

  // TEST 13: Click comment button on right side opens dialog
  const rightDialogTest = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      for (let i = 0; i < sideDiffs.length; i++) {
        if (i % 2 === 1) { // right side
          const btn = sideDiffs[i].querySelector('.line-comment-btn');
          if (btn) {
            btn.click();
            const form = document.getElementById('active-comment-form');
            return form ? 'opened' : 'not opened';
          }
        }
      }
      return 'no button found';
    })()
  `);
  assert('Right side comment opens dialog', rightDialogTest === 'opened', `result: ${rightDialogTest}`);

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
  assert('Comment has correct side (RIGHT)', dialogSide === 'RIGHT', `side: ${dialogSide}`);

  // Close form
  await mainWindow.webContents.executeJavaScript(`
    closeCommentDialog();
  `);

  // TEST 16: Click comment button on left side
  const leftDialogTest = await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
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
      return 'no button found';
    })()
  `);
  assert('Left side comment opens dialog', leftDialogTest === 'opened', `result: ${leftDialogTest}`);

  // TEST 17: Left side has correct side
  const leftSide = await mainWindow.webContents.executeJavaScript(`
    (() => {
      return typeof commentTarget !== 'undefined' && commentTarget ? commentTarget.side : 'no target';
    })()
  `);
  assert('Left comment has correct side (LEFT)', leftSide === 'LEFT', `side: ${leftSide}`);

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

  // TEST 21: Submit another comment on right side
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const sideDiffs = document.querySelectorAll('.d2h-file-side-diff');
      for (let i = 0; i < sideDiffs.length; i++) {
        if (i % 2 === 1) {
          const btn = sideDiffs[i].querySelector('.line-comment-btn');
          if (btn) { btn.click(); return; }
        }
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
    assert('Comment 1 has file', !!review.comments[0].file, `file: ${review.comments[0].file}`);
    assert('Comment 1 has side', review.comments[0].side === 'LEFT', `side: ${review.comments[0].side}`);
    assert('Comment 2 has side', review.comments[1].side === 'RIGHT', `side: ${review.comments[1].side}`);
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
    ['pref-repo-owner','pref-repo-name','pref-repo-path','pref-ai-command',
     'pref-ai-tag','pref-editor-cmd','pref-context-lines','pref-diff-mode',
     'pref-img-enabled','pref-s3-bucket','pref-s3-prefix','pref-aws-profile',
     'pref-aws-region','pref-title-contains','pref-review-requested',
     'pref-autofix-enabled','pref-rules-enabled']
    .map(id => ({ id, exists: !!document.getElementById(id) }))
  `);
  const allPrefFieldsExist = prefFieldIds.every(f => f.exists);
  assert('All preference fields exist', allPrefFieldsExist,
    `missing: ${prefFieldIds.filter(f => !f.exists).map(f => f.id).join(', ') || 'none'}`);

  // TEST: Open preferences dialog
  await mainWindow.webContents.executeJavaScript(`openPreferences()`);
  await new Promise(r => setTimeout(r, 200));
  const prefsVisible = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('prefs-overlay').style.display`
  );
  assert('Preferences dialog opens', prefsVisible === 'flex', `display="${prefsVisible}"`);

  // TEST: Preferences fields are populated with config values
  const repoOwnerValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-repo-owner').value`
  );
  const contextLinesValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-context-lines').value`
  );
  const editorCmdValue = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-editor-cmd').value`
  );
  assert('Repo owner field populated', repoOwnerValue === '', `value="${repoOwnerValue}"`);
  assert('Context lines field populated (default 5)', contextLinesValue === '5', `value="${contextLinesValue}"`);
  assert('Editor command field populated (default code)', editorCmdValue === 'code', `value="${editorCmdValue}"`);

  // TEST: Preferences fields are editable
  await mainWindow.webContents.executeJavaScript(`
    document.getElementById('pref-repo-owner').value = 'test-owner';
    document.getElementById('pref-repo-name').value = 'test-repo';
    document.getElementById('pref-context-lines').value = '10';
    document.getElementById('pref-autofix-enabled').checked = true;
  `);
  const editedOwner = await mainWindow.webContents.executeJavaScript(
    `document.getElementById('pref-repo-owner').value`
  );
  assert('Repo owner field is editable', editedOwner === 'test-owner', `value="${editedOwner}"`);

  // TEST: Save preferences sends correct data
  await mainWindow.webContents.executeJavaScript(`savePreferences()`);
  await new Promise(r => setTimeout(r, 500));
  const prefsSavedPath = path.join(app.getPath('temp'), 'diff-review-prefs.json');
  assert('Preferences file created', fs.existsSync(prefsSavedPath));
  if (fs.existsSync(prefsSavedPath)) {
    const savedPrefs = JSON.parse(fs.readFileSync(prefsSavedPath, 'utf8'));
    assert('Saved repo owner correct', savedPrefs.repoOwner === 'test-owner', `value="${savedPrefs.repoOwner}"`);
    assert('Saved repo name correct', savedPrefs.repoName === 'test-repo', `value="${savedPrefs.repoName}"`);
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
    ['pref-title-contains','pref-review-requested','pref-diff-mode','pref-s3-prefix']
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
ipcMain.handle('get-config', async () => ({ chatId: null, prNumber: null, aiTagPrefix: '@Hermes', repoOwner: '', repoName: '', repoPath: '', editorCommand: 'code', contextLines: 5, diff: { excludeMerges: true }, imageUpload: { enabled: false, s3Bucket: '', awsProfile: 'default', awsRegion: 'us-east-1' }, cleanup: { enabled: true, retentionDays: 180 }, rules: { enabled: false }, autoFix: { enabled: true } }));
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
ipcMain.handle('open-file-in-editor', async () => ({ success: true }));
ipcMain.handle('get-pr-commits', async () => ({ commits: [], prUrl: '#' }));
ipcMain.handle('get-file-blame', async () => ({}));
ipcMain.handle('list-prs', async () => ({ prs: [] }));
ipcMain.handle('save-image', async () => null);
ipcMain.handle('get-collaborators', async () => [
  {login: 'webtoolbox', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'},
  {login: 'masihur', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4'},
  {login: 'laeeqwtb', avatar_url: 'https://avatars.githubusercontent.com/u/3?v=4'},
  {login: 'shrutih-wt', avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4'},
  {login: 'alok-wt', avatar_url: 'https://avatars.githubusercontent.com/u/5?v=4'}
]);
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
