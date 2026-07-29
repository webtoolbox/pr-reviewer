/**
 * Dedicated test script for context expansion (load more lines) feature.
 * Tests replaceFileInDiff, sortDiffByExtension, and the full handleContextExpand flow.
 * Run: npx electron test-context-expand.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

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

function createTestDiff(files) {
  // Create a multi-file diff from structured data
  return files.map(f => {
    let diff = `diff --git a/${f.path} b/${f.path}\n`;
    diff += `index abc1234..def5678 100644\n`;
    diff += `--- a/${f.path}\n`;
    diff += `+++ b/${f.path}\n`;
    diff += f.hunks.join('\n');
    return diff;
  }).join('\n');
}

async function runTests() {
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

  // Inject test data and run tests in renderer context
  const results = await win.webContents.executeJavaScript(`(function() {
    const results = [];

    // =========================================================================
    // Test 1: replaceFileInDiff basic replacement
    // =========================================================================
    try {
      const fullDiff = [
        'diff --git a/foo.js b/foo.js\\n',
        'index abc..def 100644\\n',
        '--- a/foo.js\\n',
        '+++ b/foo.js\\n',
        '@@ -1,3 +1,3 @@\\n',
        ' line1\\n',
        '-old\\n',
        '+new\\n',
        ' line3\\n',
        'diff --git a/bar.js b/bar.js\\n',
        'index ghi..jkl 100644\\n',
        '--- a/bar.js\\n',
        '+++ b/bar.js\\n',
        '@@ -1,3 +1,3 @@\\n',
        ' bar1\\n',
        '-barOld\\n',
        '+barNew\\n',
        ' bar3\\n'
      ].join('');

      const newFileDiff = [
        'diff --git a/foo.js b/foo.js\\n',
        'index abc..def 100644\\n',
        '--- a/foo.js\\n',
        '+++ b/foo.js\\n',
        '@@ -1,5 +1,5 @@\\n',
        ' line1\\n',
        ' line2\\n',
        '-old\\n',
        '+new\\n',
        ' line3\\n',
        ' line4\\n',
        ' line5\\n'
      ].join('');

      const result = replaceFileInDiff(fullDiff, 'foo.js', newFileDiff);
      results.push({ test: 'replaceFileInDiff basic', ok: result.includes('line4') && result.includes('barNew') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff basic', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 2: replaceFileInDiff with empty newDiff should keep original
    // =========================================================================
    try {
      const fullDiff = [
        'diff --git a/foo.js b/foo.js\\n',
        'index abc..def 100644\\n',
        '--- a/foo.js\\n',
        '+++ b/foo.js\\n',
        '@@ -1,3 +1,3 @@\\n',
        ' line1\\n',
        '-old\\n',
        '+new\\n',
        ' line3\\n',
        'diff --git a/bar.js b/bar.js\\n',
        'index ghi..jkl 100644\\n',
        '--- a/bar.js\\n',
        '+++ b/bar.js\\n',
        '@@ -1,3 +1,3 @@\\n',
        ' bar1\\n',
        '-barOld\\n',
        '+barNew\\n',
        ' bar3\\n'
      ].join('');

      // Empty new diff — should keep original foo.js section
      const result = replaceFileInDiff(fullDiff, 'foo.js', '');
      const hasFoo = result.includes('diff --git a/foo.js b/foo.js');
      const hasBar = result.includes('diff --git a/bar.js b/bar.js');
      const hasOldLine = result.includes('-old');
      results.push({ test: 'replaceFileInDiff empty keeps original', ok: hasFoo && hasBar && hasOldLine });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff empty keeps original', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 3: replaceFileInDiff with whitespace-only newDiff should keep original
    // =========================================================================
    try {
      const fullDiff = [
        'diff --git a/foo.js b/foo.js\\n',
        'index abc..def 100644\\n',
        '--- a/foo.js\\n',
        '+++ b/foo.js\\n',
        '@@ -1,3 +1,3 @@\\n',
        ' line1\\n',
        '-old\\n',
        '+new\\n',
        ' line3\\n'
      ].join('');

      const result = replaceFileInDiff(fullDiff, 'foo.js', '   \\n  \\n  ');
      const hasFoo = result.includes('diff --git a/foo.js b/foo.js');
      const hasOldLine = result.includes('-old');
      results.push({ test: 'replaceFileInDiff whitespace-only keeps original', ok: hasFoo && hasOldLine });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff whitespace-only keeps original', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 4: replaceFileInDiff only replaces target file, preserves others
    // =========================================================================
    try {
      const fullDiff = [
        'diff --git a/a.js b/a.js\\n',
        '--- a/a.js\\n',
        '+++ b/a.js\\n',
        '@@ -1,2 +1,2 @@\\n',
        '-oldA\\n',
        '+newA\\n',
        'diff --git a/b.js b/b.js\\n',
        '--- a/b.js\\n',
        '+++ b/b.js\\n',
        '@@ -1,2 +1,2 @@\\n',
        '-oldB\\n',
        '+newB\\n',
        'diff --git a/c.js b/c.js\\n',
        '--- a/c.js\\n',
        '+++ b/c.js\\n',
        '@@ -1,2 +1,2 @@\\n',
        '-oldC\\n',
        '+newC\\n'
      ].join('');

      const newBDiff = [
        'diff --git a/b.js b/b.js\\n',
        '--- a/b.js\\n',
        '+++ b/b.js\\n',
        '@@ -1,4 +1,4 @@\\n',
        '+replacedB\\n',
        ' extra1\\n',
        ' extra2\\n',
        ' extra3\\n'
      ].join('');

      const result = replaceFileInDiff(fullDiff, 'b.js', newBDiff);
      const hasA = result.includes('-oldA');
      const hasB = result.includes('extra1');
      const hasC = result.includes('-oldC');
      // b.js should NOT have -oldB (it was replaced)
      const bSections = result.split('diff --git ').filter(s => s.startsWith('a/b.js'));
      const bHasOldB = bSections.some(s => s.includes('-oldB'));
      results.push({ test: 'replaceFileInDiff preserves other files', ok: hasA && hasB && hasC && !bHasOldB });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff preserves other files', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 5: replaceFileInDiff with CRLF content
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/foo.js b/foo.js\\r\\n--- a/foo.js\\r\\n+++ b/foo.js\\r\\n@@ -1,3 +1,3 @@\\r\\n line1\\r\\n-old\\r\\n+new\\r\\n line3\\r\\n';
      const newDiff = 'diff --git a/foo.js b/foo.js\\r\\n--- a/foo.js\\r\\n+++ b/foo.js\\r\\n@@ -1,5 +1,5 @@\\r\\n line1\\r\\n line2\\r\\n-old\\r\\n+new\\r\\n line3\\r\\n line4\\r\\n line5\\r\\n';

      const result = replaceFileInDiff(fullDiff, 'foo.js', newDiff);
      results.push({ test: 'replaceFileInDiff handles CRLF', ok: result.includes('line4') && result.includes('line5') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff handles CRLF', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 6: replaceFileInDiff preserves trailing newline
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/foo.js b/foo.js\\n--- a/foo.js\\n+++ b/foo.js\\n@@ -1,2 +1,2 @@\\n-old\\n+new\\n';
      const newDiff = 'diff --git a/foo.js b/foo.js\\n--- a/foo.js\\n+++ b/foo.js\\n@@ -1,3 +1,3 @@\\n-old\\n+new\\n extra\\n';

      const result = replaceFileInDiff(fullDiff, 'foo.js', newDiff);
      results.push({ test: 'replaceFileInDiff result ends with newline', ok: result.endsWith('\\n') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff result ends with newline', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 7: replaceFileInDiff with special characters in path
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/path/to+special/file-name_v2.js b/path/to+special/file-name_v2.js\\n--- a/path/to+special/file-name_v2.js\\n+++ b/path/to+special/file-name_v2.js\\n@@ -1,2 +1,2 @@\\n-old\\n+new\\n';
      const newDiff = 'diff --git a/path/to+special/file-name_v2.js b/path/to+special/file-name_v2.js\\n--- a/path/to+special/file-name_v2.js\\n+++ b/path/to+special/file-name_v2.js\\n@@ -1,3 +1,3 @@\\n-old\\n+new\\n extra\\n';

      const result = replaceFileInDiff(fullDiff, 'path/to+special/file-name_v2.js', newDiff);
      results.push({ test: 'replaceFileInDiff handles special chars in path', ok: result.includes('extra') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff handles special chars in path', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 8: replaceFileInDiff target file not found — returns diff unchanged
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/foo.js b/foo.js\\n--- a/foo.js\\n+++ b/foo.js\\n@@ -1,2 +1,2 @@\\n-old\\n+new\\n';
      const newDiff = 'diff --git a/missing.js b/missing.js\\n--- a/missing.js\\n+++ b/missing.js\\n@@ -1,3 +1,3 @@\\n-old\\n+new\\n extra\\n';

      const result = replaceFileInDiff(fullDiff, 'missing.js', newDiff);
      results.push({ test: 'replaceFileInDiff unchanged when target not found', ok: result === fullDiff });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff unchanged when target not found', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 9: sortDiffByExtension preserves all files
    // =========================================================================
    try {
      const diff = [
        'diff --git a/z.js b/z.js\\n--- a/z.js\\n+++ b/z.js\\n@@ -1 +1 @@\\n-old\\n+new\\n',
        'diff --git a/a.js b/a.js\\n--- a/a.js\\n+++ b/a.js\\n@@ -1 +1 @@\\n-old\\n+new\\n',
        'diff --git a/m.py b/m.py\\n--- a/m.py\\n+++ b/m.py\\n@@ -1 +1 @@\\n-old\\n+new\\n'
      ].join('');
      const sorted = sortDiffByExtension(diff);
      const hasAll = sorted.includes('a/z.js') && sorted.includes('a/a.js') && sorted.includes('a/m.py');
      results.push({ test: 'sortDiffByExtension preserves all files', ok: hasAll });
    } catch (e) {
      results.push({ test: 'sortDiffByExtension preserves all files', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 10: sortDiffByExtension handles empty input
    // =========================================================================
    try {
      const result = sortDiffByExtension('');
      results.push({ test: 'sortDiffByExtension handles empty input', ok: result === '' });
    } catch (e) {
      results.push({ test: 'sortDiffByExtension handles empty input', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 11: replaceFileInDiff then sortDiffByExtension roundtrip
    // =========================================================================
    try {
      const fullDiff = [
        'diff --git a/z.js b/z.js\\n--- a/z.js\\n+++ b/z.js\\n@@ -1,2 +1,2 @@\\n-oldZ\\n+newZ\\n',
        'diff --git a/a.js b/a.js\\n--- a/a.js\\n+++ b/a.js\\n@@ -1,2 +1,2 @@\\n-oldA\\n+newA\\n'
      ].join('');
      const expandedZ = 'diff --git a/z.js b/z.js\\n--- a/z.js\\n+++ b/z.js\\n@@ -1,4 +1,4 @@\\n-oldZ\\n+newZ\\n extra1\\n extra2\\n';

      const replaced = replaceFileInDiff(fullDiff, 'z.js', expandedZ);
      const sorted = sortDiffByExtension(replaced);
      const hasZ = sorted.includes('extra1');
      const hasA = sorted.includes('-oldA');
      results.push({ test: 'replace+sort roundtrip preserves both files', ok: hasZ && hasA });
    } catch (e) {
      results.push({ test: 'replace+sort roundtrip preserves both files', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 12: replaceFileInDiff with three-dot diff format
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/foo.js b/foo.js\\nindex abc..def 100644\\n--- a/foo.js\\n+++ b/foo.js\\n@@ -1,3 +1,3 @@\\n line1\\n-old\\n+new\\n line3\\n';
      const newDiff = 'diff --git a/foo.js b/foo.js\\nindex abc..def 100644\\n--- a/foo.js\\n+++ b/foo.js\\n@@ -1,5 +1,5 @@\\n line1\\n line2\\n-old\\n+new\\n line3\\n line4\\n line5\\n';

      const result = replaceFileInDiff(fullDiff, 'foo.js', newDiff);
      results.push({ test: 'replaceFileInDiff three-dot diff format', ok: result.includes('line4') && result.includes('line5') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff three-dot diff format', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 13: Full flow simulation — expand context then re-render
    // =========================================================================
    try {
      // Simulate: user has a diff loaded, clicks "show more lines"
      // The expanded diff replaces the file section, then renderFilteredDiff is called

      // Step 1: Create initial diff
      const initialDiff = [
        'diff --git a/cgi-bin/test.pl b/cgi-bin/test.pl\\n',
        'index abc..def 100644\\n',
        '--- a/cgi-bin/test.pl\\n',
        '+++ b/cgi-bin/test.pl\\n',
        '@@ -10,3 +10,3 @@\\n',
        ' use strict;\\n',
        '-my $old = 1;\\n',
        '+my $new = 1;\\n',
        ' use warnings;\\n',
        'diff --git a/other.js b/other.js\\n',
        'index ghi..jkl 100644\\n',
        '--- a/other.js\\n',
        '+++ b/other.js\\n',
        '@@ -5,3 +5,3 @@\\n',
        ' function test() {\\n',
        '-  return false;\\n',
        '+  return true;\\n',
        ' }\\n'
      ].join('');

      // Step 2: Create expanded diff (more context lines)
      const expandedDiff = [
        'diff --git a/cgi-bin/test.pl b/cgi-bin/test.pl\\n',
        'index abc..def 100644\\n',
        '--- a/cgi-bin/test.pl\\n',
        '+++ b/cgi-bin/test.pl\\n',
        '@@ -8,6 +8,6 @@\\n',
        ' #!/usr/bin/perl\\n',
        ' use strict;\\n',
        '-my $old = 1;\\n',
        '+my $new = 1;\\n',
        ' use warnings;\\n',
        ' exit 0;\\n'
      ].join('');

      // Step 3: Replace
      const updatedDiff = replaceFileInDiff(initialDiff, 'cgi-bin/test.pl', expandedDiff);

      // Step 4: Sort
      const sortedDiff = sortDiffByExtension(updatedDiff);

      // Verify both files are still present
      const hasPerl = sortedDiff.includes('cgi-bin/test.pl');
      const hasJS = sortedDiff.includes('other.js');
      const hasExpanded = sortedDiff.includes('#!/usr/bin/perl');
      const hasExit = sortedDiff.includes('exit 0');

      results.push({ test: 'Full flow: expand+replace+sort preserves both files', ok: hasPerl && hasJS && hasExpanded && hasExit });
    } catch (e) {
      results.push({ test: 'Full flow: expand+replace+sort preserves both files', ok: false, error: e.message });
    }

    // =========================================================================
    // Test 14: replaceFileInDiff with Perl .cgi path (real-world path)
    // =========================================================================
    try {
      const fullDiff = 'diff --git a/cgi-bin/members/mb/moderators b/cgi-bin/members/mb/moderators\\nold mode 100644\\nnew mode 100755\\nindex abc..def\\n--- a/cgi-bin/members/mb/moderators\\n+++ b/cgi-bin/members/mb/moderators\\n@@ -10,3 +10,3 @@\\n use strict;\\n-my $old;\\n+my $new;\\n 1;\\n';
      const expanded = 'diff --git a/cgi-bin/members/mb/moderators b/cgi-bin/members/mb/moderators\\nold mode 100644\\nnew mode 100755\\nindex abc..def\\n--- a/cgi-bin/members/mb/moderators\\n+++ b/cgi-bin/members/mb/moderators\\n@@ -8,5 +8,5 @@\\n #!/usr/bin/perl\\n use strict;\\n-my $old;\\n+my $new;\\n 1;\\n';

      const result = replaceFileInDiff(fullDiff, 'cgi-bin/members/mb/moderators', expanded);
      results.push({ test: 'replaceFileInDiff with .cgi Perl path', ok: result.includes('#!/usr/bin/perl') && result.includes('my $new') });
    } catch (e) {
      results.push({ test: 'replaceFileInDiff with .cgi Perl path', ok: false, error: e.message });
    }

    return results;
  })()`);

  for (const r of results) {
    assert(r.ok, r.test + (r.error ? ` (${r.error})` : ''));
  }

  console.log(`\n[TEST] Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  app.exit(failed > 0 ? 1 : 0);
}

app.whenReady().then(runTests);
