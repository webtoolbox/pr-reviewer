/**
 * Unit tests for PR Reviewer — pure logic functions that don't require Electron.
 * Run with: npx jest unit.test.js --no-coverage
 */

// ── Utility functions (extracted from renderer.js / main.js for testing) ──

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safePrNumber(prNumber) {
  if (prNumber === null || prNumber === undefined) return null;
  const str = String(prNumber).trim();
  if (!/^\d+$/.test(str)) return null;
  const num = parseInt(str, 10);
  if (isNaN(num) || num <= 0) return null;
  return String(num);
}

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

function computeDiffPositions(diffContent) {
  if (!diffContent) return {};
  const map = {};
  let currentFile = null;
  let position = 0;
  let leftLine = 0;
  let rightLine = 0;
  const lines = diffContent.split('\n');
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

function sortDiffByExtension(diffContent) {
  if (!diffContent || !diffContent.includes('diff --git')) return diffContent;
  const files = diffContent.split(/^diff --git /m);
  const validFiles = files.filter(f => f.trim());

  function getExt(fileBlock) {
    const match = fileBlock.split('\n')[0].match(/a\/(.+?) b\//);
    if (!match) return '';
    const name = match[1];
    return name.includes('.') ? '.' + name.split('.').pop() : '';
  }

  function getName(fileBlock) {
    const match = fileBlock.split('\n')[0].match(/a\/(.+?) b\//);
    return match ? match[1] : '';
  }

  validFiles.sort((a, b) => {
    const extA = getExt(a);
    const extB = getExt(b);
    if (extA !== extB) return extA.localeCompare(extB);
    return getName(a).localeCompare(getName(b));
  });

  return validFiles.map(f => 'diff --git ' + f).join('');
}

function extractExtensionsFromDiff(diffContent) {
  const extensions = new Set();
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
      const filePath = line.substring(6);
      const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '';
      if (ext) extensions.add(ext);
    }
  }
  return Array.from(extensions).sort();
}

// ── Tests ──

describe('safePrNumber', () => {
  test('valid integer returns string', () => {
    expect(safePrNumber(123)).toBe('123');
    expect(safePrNumber('456')).toBe('456');
    expect(safePrNumber('1')).toBe('1');
  });

  test('rejects zero and negative', () => {
    expect(safePrNumber(0)).toBeNull();
    expect(safePrNumber(-1)).toBeNull();
    expect(safePrNumber('-5')).toBeNull();
  });

  test('rejects non-numeric', () => {
    expect(safePrNumber('abc')).toBeNull();
    expect(safePrNumber('')).toBeNull();
    expect(safePrNumber(null)).toBeNull();
    expect(safePrNumber(undefined)).toBeNull();
  });

  test('rejects shell injection attempts', () => {
    expect(safePrNumber('1; rm -rf /')).toBeNull();
    expect(safePrNumber('123 && echo pwned')).toBeNull();
    expect(safePrNumber('$(whoami)')).toBeNull();
    expect(safePrNumber('`id`')).toBeNull();
    expect(safePrNumber('12.5')).toBeNull(); // Not pure digits
    expect(safePrNumber('99.9')).toBeNull();
  });

  test('handles numeric types', () => {
    expect(safePrNumber(123)).toBe('123');
    expect(safePrNumber(1)).toBe('1');
    expect(safePrNumber(999)).toBe('999');
  });
});

describe('escapeHtml', () => {
  test('escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("it's a test")).toBe("it&#39;s a test");
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('handles empty and non-string', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });
});

describe('parseDiffLineNumbers', () => {
  const sampleDiff = `diff --git a/src/main.js b/src/main.js
index abc1234..def5678 100644
--- a/src/main.js
+++ b/src/main.js
@@ -10,6 +10,8 @@ function foo() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/src/util.js b/src/util.js
index 1111111..2222222 100644
--- a/src/util.js
+++ b/src/util.js
@@ -1,3 +1,4 @@
+// header
 function bar() {
   return 1;
 }`;

  test('parses file names', () => {
    const result = parseDiffLineNumbers(sampleDiff);
    expect(result['src/main.js']).toBeDefined();
    expect(result['src/util.js']).toBeDefined();
  });

  test('tracks right-side line numbers for additions', () => {
    const result = parseDiffLineNumbers(sampleDiff);
    const mainRight = result['src/main.js'].right;
    // Line 11 is 'const b = 3' (replacement), line 12 is 'const c = 4' (addition)
    const lineNums = mainRight.map(e => e.lineNum);
    expect(lineNums).toContain(10); // 'const a = 1' (context)
    expect(lineNums).toContain(11); // 'const b = 3'
    expect(lineNums).toContain(12); // 'const c = 4'
    expect(lineNums).toContain(13); // 'const d = 5'
  });

  test('tracks left-side line numbers for deletions', () => {
    const result = parseDiffLineNumbers(sampleDiff);
    const mainLeft = result['src/main.js'].left;
    const lineNums = mainLeft.map(e => e.lineNum);
    expect(lineNums).toContain(10); // 'const a = 1'
    expect(lineNums).toContain(11); // 'const b = 2' (deleted)
    expect(lineNums).toContain(12); // 'const d = 5' (context, shifted)
  });
});

describe('computeDiffPositions', () => {
  const sampleDiff = `diff --git a/test.js b/test.js
index abc..def 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
+// added line
 function hello() {
   return "world";
-  // removed
 }`;

  test('computes 1-indexed positions', () => {
    const positions = computeDiffPositions(sampleDiff);
    expect(positions['test.js:1:RIGHT']).toBe(1); // +// added line
    expect(positions['test.js:1:LEFT']).toBe(2);   //  function hello()
    expect(positions['test.js:1:RIGHT']).toBe(1);
  });

  test('returns empty for empty diff', () => {
    expect(computeDiffPositions('')).toEqual({});
    expect(computeDiffPositions(null)).toEqual({});
  });
});

describe('sortDiffByExtension', () => {
  test('sorts files by extension then name', () => {
    const diff = `diff --git a/z.css b/z.css
index abc..def 100644
--- a/z.css
+++ b/z.css
@@ -1 +1 @@
-old
+new
diff --git a/a.js b/a.js
index abc..def 100644
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-old
+new
diff --git a/b.js b/b.js
index abc..def 100644
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-old
+new`;
    const sorted = sortDiffByExtension(diff);
    // .css should come before .js (alphabetical by extension)
    const cssPos = sorted.indexOf('a/z.css');
    const jsAPos = sorted.indexOf('a/a.js');
    const jsBPos = sorted.indexOf('a/b.js');
    expect(cssPos).toBeLessThan(jsAPos);
    expect(jsAPos).toBeLessThan(jsBPos);
  });

  test('returns original for non-diff content', () => {
    expect(sortDiffByExtension('hello')).toBe('hello');
    expect(sortDiffByExtension('')).toBe('');
  });
});

describe('extractExtensionsFromDiff', () => {
  test('extracts unique extensions', () => {
    const diff = `diff --git a/src/main.js b/src/main.js
--- a/src/main.js
+++ b/src/main.js
@@ -1 +1 @@
-old
+new
diff --git a/src/style.css b/src/style.css
--- a/src/style.css
+++ b/src/style.css
@@ -1 +1 @@
-old
+new`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts).toContain('.js');
    expect(exts).toContain('.css');
    expect(exts.length).toBe(2);
  });

  test('returns empty for no files', () => {
    expect(extractExtensionsFromDiff('')).toEqual([]);
  });
});
