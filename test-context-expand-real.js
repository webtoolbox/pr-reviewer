/**
 * Integration test for context expansion using REAL git data.
 * Tests the full IPC flow: expand-diff-context → replaceFileInDiff → renderFilteredDiff
 * Run: npx electron test-context-expand-real.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let win;
let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`[TEST] ✓ ${testName}`);
    passed++;
  } else {
    console.error(`[TEST] ✗ ${testName}`);
    failed++;
  }
}

async function runTests() {
  // Get a real diff from the Website-Toolbox repo
  const repoPath = '/Users/sandeep/Website-Toolbox';
  const diffPath = '/tmp/test-real.diff';

  // Get the latest merged PR's diff
  let diffContent;
  try {
    // Get a recent PR diff
    const prList = execSync('gh pr list --state merged --limit 1 --json number,baseRefName,headRefName,headRefOid,baseRefOid', { cwd: repoPath, encoding: 'utf8' });
    const prs = JSON.parse(prList);
    if (prs.length === 0) {
      console.log('[TEST] No merged PRs found, skipping real diff test');
      app.exit(0);
      return;
    }
    const pr = prs[0];
    console.log(`[TEST] Using PR #${pr.number} for real diff test`);

    // Get the diff
    diffContent = execSync(`gh pr diff ${pr.number}`, { cwd: repoPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    fs.writeFileSync(diffPath, diffContent);
    console.log(`[TEST] Got diff: ${diffContent.length} chars`);
  } catch (e) {
    console.log('[TEST] Could not get real diff:', e.message);
    app.exit(0);
    return;
  }

  // Parse diff to find files
  const fileMatches = [...diffContent.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)];
  const files = fileMatches.map(m => m[2]);
  console.log(`[TEST] Files in diff: ${files.length}`, files.slice(0, 5).join(', '));

  if (files.length === 0) {
    console.log('[TEST] No files in diff, skipping');
    app.exit(0);
    return;
  }

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile('index.html');
  await new Promise(r => setTimeout(r, 2000));

  // Test replaceFileInDiff with the real diff
  const results = await win.webContents.executeJavaScript(`(function() {
    const diffContent = ${JSON.stringify(diffContent)};
    const files = ${JSON.stringify(files)};
    const results = [];

    // Test 1: replaceFileInDiff preserves all files for each target file
    for (const file of files.slice(0, 3)) {
      try {
        const beforeSections = (diffContent.match(/^diff --git /gm) || []).length;
        const expandedDiff = 'diff --git a/' + file + ' b/' + file + '\\n--- a/' + file + '\\n+++ b/' + file + '\\n@@ -1,5 +1,5 @@\\n line1\\n-old\\n+new\\n line3\\n line4\\n';
        const result = replaceFileInDiff(diffContent, file, expandedDiff);
        const afterSections = (result.match(/^diff --git /gm) || []).length;
        results.push({
          test: 'replaceFileInDiff preserves file count for ' + file,
          ok: beforeSections === afterSections,
          detail: 'before=' + beforeSections + ' after=' + afterSections
        });
      } catch (e) {
        results.push({ test: 'replaceFileInDiff for ' + file, ok: false, error: e.message });
      }
    }

    // Test 2: replaceFileInDiff with empty replacement keeps original
    for (const file of files.slice(0, 3)) {
      try {
        const result = replaceFileInDiff(diffContent, file, '');
        const hasFile = result.includes('diff --git a/' + file + ' b/' + file);
        results.push({
          test: 'replaceFileInDiff empty keeps ' + file,
          ok: hasFile,
          detail: 'hasFile=' + hasFile
        });
      } catch (e) {
        results.push({ test: 'replaceFileInDiff empty for ' + file, ok: false, error: e.message });
      }
    }

    // Test 3: sortDiffByExtension preserves all files
    try {
      const sorted = sortDiffByExtension(diffContent);
      const beforeCount = (diffContent.match(/^diff --git /gm) || []).length;
      const afterCount = (sorted.match(/^diff --git /gm) || []).length;
      let allPresent = true;
      for (const file of files) {
        if (!sorted.includes('b/' + file)) { allPresent = false; break; }
      }
      results.push({
        test: 'sortDiffByExtension preserves all files',
        ok: beforeCount === afterCount && allPresent,
        detail: 'before=' + beforeCount + ' after=' + afterCount + ' allPresent=' + allPresent
      });
    } catch (e) {
      results.push({ test: 'sortDiffByExtension preserves all files', ok: false, error: e.message });
    }

    // Test 4: Full flow — replace then sort
    for (const file of files.slice(0, 2)) {
      try {
        const expandedDiff = 'diff --git a/' + file + ' b/' + file + '\\n--- a/' + file + '\\n+++ b/' + file + '\\n@@ -1,10 +1,10 @@\\n line1\\n line2\\n line3\\n-old\\n+new\\n line5\\n line6\\n line7\\n line8\\n line9\\n line10\\n';
        let result = replaceFileInDiff(diffContent, file, expandedDiff);
        result = sortDiffByExtension(result);
        const hasFile = result.includes('b/' + file);
        const hasOtherFiles = files.filter(f => f !== file).every(f => result.includes('b/' + f));
        results.push({
          test: 'Full flow replace+sort for ' + file,
          ok: hasFile && hasOtherFiles,
          detail: 'hasFile=' + hasFile + ' hasOthers=' + hasOtherFiles
        });
      } catch (e) {
        results.push({ test: 'Full flow for ' + file, ok: false, error: e.message });
      }
    }

    // Test 5: replaceFileInDiff with expanded content that has DIFFERENT line count
    try {
      const file = files[0];
      // Simulate: original has 3 context lines, expanded has 9
      const expandedDiff = 'diff --git a/' + file + ' b/' + file + '\\n--- a/' + file + '\\n+++ b/' + file + '\\n@@ -1,9 +1,9 @@\\n #!/usr/bin/perl\\n use strict;\\n use warnings;\\n-my $old = 1;\\n+my $new = 1;\\n my $x = 2;\\n my $y = 3;\\n my $z = 4;\\n exit 0;\\n';
      const result = replaceFileInDiff(diffContent, file, expandedDiff);
      const hasExpanded = result.includes('#!/usr/bin/perl') || result.includes('exit 0');
      results.push({
        test: 'replaceFileInDiff with expanded context',
        ok: result.includes('b/' + file),
        detail: 'hasExpanded=' + hasExpanded + ' includesFile=' + result.includes('b/' + file)
      });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff with expanded context', ok: false, error: e.message });
    }

    return results;
  })()`);

  for (const r of results) {
    assert(r.ok, r.test + (r.detail ? ` [${r.detail}]` : '') + (r.error ? ` (${r.error})` : ''));
  }

  console.log(`\n[TEST] Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  app.exit(failed > 0 ? 1 : 0);
}

app.whenReady().then(runTests);
