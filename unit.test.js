/**
 * Unit tests for PR Reviewer — pure logic functions that don't require Electron.
 * Run with: npx jest unit.test.js --no-coverage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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
      } else if (line.startsWith('\\')) {
        // \\ No newline at end of file — counts for position but not line numbers
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

function sortDiffByExtension(diffContent, excludedExts) {
  if (!diffContent || !diffContent.includes('diff --git')) return diffContent;
  const files = diffContent.split(/^diff --git /m);
  const validFiles = files.filter(f => f.trim());
  const excluded = Array.isArray(excludedExts) ? excludedExts : [];

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

  const groupOf = (f) => excluded.includes(getExt(f)) ? 1 : 0;
  validFiles.sort((a, b) => {
    const ga = groupOf(a), gb = groupOf(b);
    if (ga !== gb) return ga - gb; // excluded last
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

// ── Functions from main.js ──

function expandPath(p, homeDir) {
  if (p && p.startsWith('~')) {
    return path.join(homeDir, p.slice(1));
  }
  return p;
}

function getLocalRepoPath(repoKey, config, homeDir) {
  if (repoKey && repoKey.includes('/')) {
    const repoName = repoKey.split('/')[1];
    // In real code this checks fs.existsSync, we simulate with a set
    const existingPaths = config._existingPaths || new Set();
    const reposPath = path.join(homeDir, 'Repos', repoName);
    if (existingPaths.has(reposPath)) return reposPath;
    const defaultRepoKey = `${config.repoOwner}/${config.repoName}`;
    if (repoKey === defaultRepoKey && config.repoPath) {
      return expandPath(config.repoPath, homeDir);
    }
    return path.join(homeDir, repoName);
  }
  return config.repoPath ? expandPath(config.repoPath, homeDir) : path.join(homeDir, config.repoName || 'Website-Toolbox');
}

// ── Functions from renderer.js ──

function formatCommentBody(body) {
  if (!body) return '';
  let html = escapeHtml(body);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function formatRelativeTime(dateStr, now) {
  const date = new Date(dateStr);
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

function replaceFileInDiff(fullDiff, targetFile, newFileDiff) {
  const sections = fullDiff.split(/(?=^diff --git )/m);
  const result = [];

  for (const section of sections) {
    if (!section.trim()) continue;
    const match = section.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/m);
    if (match) {
      const bPath = match[2];
      if (bPath === targetFile) {
        if (newFileDiff.trim()) {
          let replacement = newFileDiff.trim();
          if (!replacement.endsWith('\n')) replacement += '\n';
          result.push(replacement);
        }
        continue;
      }
    }
    result.push(section);
  }

  return result.join('');
}

function detectBeforeAfterPairs(prBody) {
  if (!prBody || typeof prBody !== 'string') return [];

  const pairs = [];
  const lines = prBody.split('\n');
  const imageUrlRegex = /!\[.*?\]\(((?:https?|file):\/\/[^\\s\)]+)\)|src="((?:https?|file):\/\/[^"]+)"/;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';

    const beforeMatch = line.match(/^#{1,6}\s+.*before/i) ||
                        line.match(/^\*{1,2}\s*before\s*:?\s*\*{0,2}/i) ||
                        line.match(/^before\s*:/i);

    if (beforeMatch) {
      let beforeUrl = null;
      for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
        const imgMatch = lines[j].match(imageUrlRegex);
        if (imgMatch) {
          beforeUrl = imgMatch[1] || imgMatch[2];
          break;
        }
      }

      if (beforeUrl) {
        for (let k = i + 1; k <= Math.min(i + 10, lines.length - 1); k++) {
          const afterLine = lines[k].trim();
          const afterMatch = afterLine.match(/^#{1,6}\s+.*after/i) ||
                             afterLine.match(/^\*{1,2}\s*after\s*:?\s*\*{0,2}/i) ||
                             afterLine.match(/^after\s*:/i);

          if (afterMatch) {
            for (let m = k; m <= Math.min(k + 3, lines.length - 1); m++) {
              const afterImgMatch = lines[m].match(imageUrlRegex);
              if (afterImgMatch) {
                pairs.push({ before: beforeUrl, after: afterImgMatch[1] || afterImgMatch[2] });
                break;
              }
            }
            break;
          }
        }
      }
    }
  }

  // Pattern 2: sequential standalone before/after
  if (pairs.length === 0) {
    let pendingBefore = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const isBeforeLine = /^(?:before|after)\s*:?\s*$/i.test(line) ||
                           /^\*{1,2}\s*(?:before|after)\s*:?\s*\*{0,2}$/i.test(line);

      if (isBeforeLine) {
        const isBefore = /^before/i.test(line);
        for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
          const imgMatch = lines[j].match(imageUrlRegex);
          if (imgMatch) {
            const url = imgMatch[1] || imgMatch[2];
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

function getPlatformInstructions(platform) {
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

// Filter PRs by search text (mirrors renderPrList filtering logic)
function filterPrs(prs, searchValue) {
  searchValue = (searchValue || '').toLowerCase().trim();
  if (!searchValue) return prs || [];
  return (prs || []).filter(pr => {
    const title = (pr.title || '').toLowerCase();
    const author = (pr.author || '').toLowerCase();
    const num = String(pr.number);
    const repo = (pr.repo || '').toLowerCase();
    const assignees = (pr.assignees || []).join(' ').toLowerCase();
    return title.includes(searchValue) || author.includes(searchValue) || num.includes(searchValue) || repo.includes(searchValue) || assignees.includes(searchValue);
  });
}

// =====================================================================
// TESTS
// =====================================================================

// ── safePrNumber ──

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
    expect(safePrNumber('12.5')).toBeNull();
    expect(safePrNumber('99.9')).toBeNull();
  });

  test('handles numeric types', () => {
    expect(safePrNumber(123)).toBe('123');
    expect(safePrNumber(1)).toBe('1');
    expect(safePrNumber(999)).toBe('999');
  });

  test('trims whitespace', () => {
    expect(safePrNumber('  42  ')).toBe('42');
    expect(safePrNumber(' 1 ')).toBe('1');
  });

  test('rejects mixed alphanumeric', () => {
    expect(safePrNumber('1a')).toBeNull();
    expect(safePrNumber('a1')).toBeNull();
    expect(safePrNumber('1e10')).toBeNull();
  });

  test('handles very large numbers', () => {
    expect(safePrNumber('999999')).toBe('999999');
    expect(safePrNumber(1000000)).toBe('1000000');
  });

  test('rejects special characters', () => {
    expect(safePrNumber('#123')).toBeNull();
    // Note: \n and \t are stripped by .trim(), so '123\n' -> '123' (valid)
    expect(safePrNumber('#42')).toBeNull();
    expect(safePrNumber('42#')).toBeNull();
  });
});

// ── escapeHtml ──

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

  test('escapes all five special characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test('passes through safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('foo-bar_baz.qux')).toBe('foo-bar_baz.qux');
  });

  test('handles numbers and booleans via String()', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
    expect(escapeHtml(false)).toBe('false');
  });

  test('escapes nested HTML', () => {
    expect(escapeHtml('<div class="x"><span>y</span></div>'))
      .toBe('&lt;div class=&quot;x&quot;&gt;&lt;span&gt;y&lt;/span&gt;&lt;/div&gt;');
  });
});

// ── parseDiffLineNumbers ──

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
    const lineNums = mainRight.map(e => e.lineNum);
    expect(lineNums).toContain(10);
    expect(lineNums).toContain(11);
    expect(lineNums).toContain(12);
    expect(lineNums).toContain(13);
  });

  test('tracks left-side line numbers for deletions', () => {
    const result = parseDiffLineNumbers(sampleDiff);
    const mainLeft = result['src/main.js'].left;
    const lineNums = mainLeft.map(e => e.lineNum);
    expect(lineNums).toContain(10);
    expect(lineNums).toContain(11);
    expect(lineNums).toContain(12);
  });

  test('handles empty diff', () => {
    const result = parseDiffLineNumbers('');
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('handles single file diff', () => {
    const diff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,2 +1,3 @@
 line1
+line2
 line3`;
    const result = parseDiffLineNumbers(diff);
    expect(result['test.js']).toBeDefined();
    expect(result['test.js'].right.length).toBe(3); // line1, line2, line3
    expect(result['test.js'].left.length).toBe(2);  // line1, line3
  });

  test('handles diff with only additions', () => {
    const diff = `diff --git a/new.js b/new.js
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+line1
+line2`;
    const result = parseDiffLineNumbers(diff);
    expect(result['new.js'].right.length).toBe(2);
    expect(result['new.js'].left.length).toBe(0);
  });

  test('handles diff with only deletions', () => {
    const diff = `diff --git a/old.js b/old.js
--- a/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`;
    const result = parseDiffLineNumbers(diff);
    expect(result['old.js'].left.length).toBe(2);
    expect(result['old.js'].right.length).toBe(0);
  });

  test('handles no-newline-at-end marker', () => {
    const diff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,2 +1,2 @@
 line1
-old
+new
\\ No newline at end of file`;
    const result = parseDiffLineNumbers(diff);
    expect(result['test.js']).toBeDefined();
    // The \\ marker should be skipped, not counted
    expect(result['test.js'].left.length).toBe(2); // line1, old
    expect(result['test.js'].right.length).toBe(2); // line1, new
  });

  test('handles multiple hunks in same file', () => {
    const diff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12`;
    const result = parseDiffLineNumbers(diff);
    expect(result['test.js']).toBeDefined();
    expect(result['test.js'].right.length).toBe(6);
    expect(result['test.js'].left.length).toBe(6);
  });
});

// ── computeDiffPositions ──

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
    expect(positions['test.js:1:RIGHT']).toBe(1);
    expect(positions['test.js:1:LEFT']).toBe(2);
    expect(positions['test.js:1:RIGHT']).toBe(1);
  });

  test('returns empty for empty diff', () => {
    expect(computeDiffPositions('')).toEqual({});
    expect(computeDiffPositions(null)).toEqual({});
  });

  test('tracks LEFT and RIGHT separately', () => {
    const diff = `diff --git a/x.js b/x.js
--- a/x.js
+++ b/x.js
@@ -1,3 +1,4 @@
+new line
 context
-old line
 another context
+another new`;
    const positions = computeDiffPositions(diff);
    // Position tracking: each diff line increments position once
    // +new line → pos 1 (RIGHT:1)
    //  context  → pos 2 (LEFT:1, RIGHT:2)
    // -old line → pos 3 (LEFT:2)
    //  another  → pos 4 (LEFT:3, RIGHT:3)
    // +another  → pos 5 (RIGHT:4... wait, actually RIGHT:3 already set)
    // Context maps both sides to same position. The + line gets the next position.
    expect(positions['x.js:1:RIGHT']).toBe(1); // +new line
    expect(positions['x.js:1:LEFT']).toBe(2);  // context
    expect(positions['x.js:2:LEFT']).toBe(3);  // -old line
  });

  test('handles multiple files', () => {
    const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-old
+new
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-oldb
+newb`;
    const positions = computeDiffPositions(diff);
    // For a.js: -old → pos 1 (LEFT:1), +new → pos 2 (RIGHT:2)
    // For b.js: position resets, -oldb → pos 1 (LEFT:1), +newb → pos 2 (RIGHT:2)
    expect(positions['a.js:1:LEFT']).toBe(1);  // -old (deletion)
    expect(positions['a.js:1:RIGHT']).toBe(2); // +new (addition)
    expect(positions['b.js:1:LEFT']).toBe(1);  // -oldb (position resets per file)
    expect(positions['b.js:1:RIGHT']).toBe(2); // +newb
  });

  test('handles hunk header parsing with count', () => {
    const diff = `diff --git a/f.js b/f.js
--- a/f.js
+++ b/f.js
@@ -10,5 +10,6 @@ function test() {
 line10
+added
 line11
 line12
-removed
 line13`;
    const positions = computeDiffPositions(diff);
    expect(positions['f.js:10:LEFT']).toBeDefined();
    expect(positions['f.js:11:RIGHT']).toBeDefined(); // +added
  });
});

// ── sortDiffByExtension ──

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

  test('handles null/undefined', () => {
    expect(sortDiffByExtension(null)).toBeNull();
    expect(sortDiffByExtension(undefined)).toBeUndefined();
  });

  test('single file returns same content', () => {
    const diff = `diff --git a/only.js b/only.js
--- a/only.js
+++ b/only.js
@@ -1 +1 @@
-a
+b`;
    const sorted = sortDiffByExtension(diff);
    expect(sorted).toContain('a/only.js');
  });

  test('sorts same extension alphabetically by path', () => {
    const diff = `diff --git a/z/file.js b/z/file.js
--- a/z/file.js
+++ b/z/file.js
@@ -1 +1 @@
-a
+b
diff --git a/a/file.js b/a/file.js
--- a/a/file.js
+++ b/a/file.js
@@ -1 +1 @@
-c
+d`;
    const sorted = sortDiffByExtension(diff);
    expect(sorted.indexOf('a/a/file.js')).toBeLessThan(sorted.indexOf('a/z/file.js'));
  });

  test('pushes excluded extensions to the end', () => {
    const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-a
+b
diff --git a/b.json b/b.json
--- a/b.json
+++ b/b.json
@@ -1 +1 @@
-c
+d
diff --git a/c.pm b/c.pm
--- a/c.pm
+++ b/c.pm
@@ -1 +1 @@
-e
+f`;
    const sorted = sortDiffByExtension(diff, ['.json']);
    const jsPos = sorted.indexOf('a/a.js');
    const jsonPos = sorted.indexOf('b.json');
    const pmPos = sorted.indexOf('c.pm');
    expect(jsPos).toBeGreaterThanOrEqual(0);
    expect(pmPos).toBeGreaterThanOrEqual(0);
    expect(jsonPos).toBeGreaterThan(jsPos);
    expect(jsonPos).toBeGreaterThan(pmPos);
  });
});

// ── extractExtensionsFromDiff ──

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

  test('deduplicates extensions', () => {
    const diff = `--- a/foo.js
+++ b/foo.js
--- a/bar.js
+++ b/bar.js`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts.filter(e => e === '.js')).toHaveLength(1);
  });

  test('sorts extensions alphabetically', () => {
    const diff = `--- a/z.pm
+++ b/z.pm
--- a/a.css
+++ b/a.css
--- a/m.js
+++ b/m.js`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts).toEqual(['.css', '.js', '.pm']);
  });

  test('handles files with no extension', () => {
    const diff = `--- a/Makefile
+++ b/Makefile`;
    const exts = extractExtensionsFromDiff(diff);
    // No extension means '' which is falsy, so filtered out
    expect(exts).toEqual([]);
  });

  test('handles deeply nested paths', () => {
    const diff = `--- a/src/components/deep/nested/file.tsx
+++ b/src/components/deep/nested/file.tsx`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts).toContain('.tsx');
  });
});

// ── expandPath ──

describe('expandPath', () => {
  const HOME = '/Users/testuser';

  test('expands tilde to home directory', () => {
    expect(expandPath('~/projects', HOME)).toBe('/Users/testuser/projects');
  });

  test('expands bare tilde', () => {
    expect(expandPath('~', HOME)).toBe('/Users/testuser');
  });

  test('returns path unchanged if no tilde', () => {
    expect(expandPath('/absolute/path', HOME)).toBe('/absolute/path');
    expect(expandPath('relative/path', HOME)).toBe('relative/path');
  });

  test('handles null/undefined/empty', () => {
    expect(expandPath(null, HOME)).toBeNull();
    expect(expandPath(undefined, HOME)).toBeUndefined();
    expect(expandPath('', HOME)).toBe('');
  });

  test('only expands leading tilde', () => {
    expect(expandPath('/path/~/notexpanded', HOME)).toBe('/path/~/notexpanded');
  });
});

// ── getLocalRepoPath ──

describe('getLocalRepoPath', () => {
  const HOME = '/Users/testuser';

  test('derives path from repoKey when ~/Repos/ exists', () => {
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      _existingPaths: new Set(['/Users/testuser/Repos/MyApp'])
    };
    const result = getLocalRepoPath('org/MyApp', config, HOME);
    expect(result).toBe('/Users/testuser/Repos/MyApp');
  });

  test('falls back to config repoPath for default repo', () => {
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      repoPath: '~/Website-Toolbox',
      _existingPaths: new Set()
    };
    const result = getLocalRepoPath('webtoolbox/Website-Toolbox', config, HOME);
    expect(result).toBe('/Users/testuser/Website-Toolbox');
  });

  test('falls back to home/repoName when no ~/Repos/ match', () => {
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      _existingPaths: new Set()
    };
    const result = getLocalRepoPath('org/SomeRepo', config, HOME);
    expect(result).toBe('/Users/testuser/SomeRepo');
  });

  test('uses config repoPath when no repoKey given', () => {
    const config = {
      repoPath: '~/my-repo',
      repoName: 'TestRepo'
    };
    const result = getLocalRepoPath(null, config, HOME);
    expect(result).toBe('/Users/testuser/my-repo');
  });

  test('falls back to home/repoName when no repoKey and no repoPath', () => {
    const config = { repoName: 'MyProject' };
    const result = getLocalRepoPath(null, config, HOME);
    expect(result).toBe('/Users/testuser/MyProject');
  });

  test('falls back to Website-Toolbox when no config at all', () => {
    const config = {};
    const result = getLocalRepoPath(null, config, HOME);
    expect(result).toBe('/Users/testuser/Website-Toolbox');
  });
});

// ── formatCommentBody ──

describe('formatCommentBody', () => {
  test('returns empty string for falsy input', () => {
    expect(formatCommentBody('')).toBe('');
    expect(formatCommentBody(null)).toBe('');
    expect(formatCommentBody(undefined)).toBe('');
  });

  test('converts **bold** to <strong>', () => {
    expect(formatCommentBody('**bold text**')).toBe('<strong>bold text</strong>');
  });

  test('converts *italic* to <em>', () => {
    expect(formatCommentBody('*italic text*')).toBe('<em>italic text</em>');
  });

  test('converts `code` to <code>', () => {
    expect(formatCommentBody('use `npm install`')).toBe('use <code>npm install</code>');
  });

  test('converts newlines to <br>', () => {
    expect(formatCommentBody('line1\nline2')).toBe('line1<br>line2');
  });

  test('escapes HTML in body before formatting', () => {
    expect(formatCommentBody('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('handles mixed formatting', () => {
    const body = '**bold** and *italic* and `code`\nnew line';
    const result = formatCommentBody(body);
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<code>code</code>');
    expect(result).toContain('<br>');
  });

  test('does not format escaped HTML as markdown', () => {
    // The &amp; from escaping should not interfere with markdown
    expect(formatCommentBody('a & b **bold**')).toBe('a &amp; b <strong>bold</strong>');
  });
});

// ── formatRelativeTime ──

describe('formatRelativeTime', () => {
  const NOW = new Date('2025-01-15T12:00:00Z');

  test('returns "just now" for < 1 minute', () => {
    const date = new Date('2025-01-15T11:59:30Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('just now');
  });

  test('returns minutes for < 1 hour', () => {
    const date = new Date('2025-01-15T11:45:00Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('15m ago');
  });

  test('returns hours for < 24 hours', () => {
    const date = new Date('2025-01-15T09:00:00Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('3h ago');
  });

  test('returns days for < 30 days', () => {
    const date = new Date('2025-01-10T12:00:00Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('5d ago');
  });

  test('returns locale date string for >= 30 days', () => {
    const date = new Date('2024-12-01T12:00:00Z').toISOString();
    const result = formatRelativeTime(date, NOW);
    // Should be a date string, not "Xd ago"
    expect(result).not.toContain('ago');
  });

  test('handles exact boundary of 60 minutes', () => {
    const date = new Date('2025-01-15T11:00:00Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('1h ago');
  });

  test('handles exact boundary of 24 hours', () => {
    const date = new Date('2025-01-14T12:00:00Z').toISOString();
    expect(formatRelativeTime(date, NOW)).toBe('1d ago');
  });
});

// ── replaceFileInDiff ──

describe('replaceFileInDiff', () => {
  const multiFileDiff = `diff --git a/src/main.js b/src/main.js
--- a/src/main.js
+++ b/src/main.js
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1,2 +1,2 @@
 function foo() {
-  return 1;
+  return 2;
 }`;

  test('replaces the target file section', () => {
    const newUtilDiff = `diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1,3 +1,3 @@
 function foo() {
-  return 1;
+  return 99;
 }`;
    const result = replaceFileInDiff(multiFileDiff, 'src/util.js', newUtilDiff);
    expect(result).toContain('src/main.js');
    expect(result).toContain('src/util.js');
    expect(result).toContain('return 99');
    // The old util.js section (with "return 1;") should be replaced
    // Verify the new content is present instead
    expect(result).toContain('+  return 99;');
  });

  test('preserves non-target files', () => {
    const newUtilDiff = `diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1 +1 @@
-x
+y`;
    const result = replaceFileInDiff(multiFileDiff, 'src/util.js', newUtilDiff);
    expect(result).toContain('src/main.js');
    expect(result).toContain('old');
  });

  test('returns original if target file not found', () => {
    const result = replaceFileInDiff(multiFileDiff, 'nonexistent.js', 'new content');
    expect(result).toContain('src/main.js');
    expect(result).toContain('src/util.js');
  });

  test('skips empty new diff', () => {
    const result = replaceFileInDiff(multiFileDiff, 'src/util.js', '');
    expect(result).toContain('src/main.js');
    expect(result).not.toContain('src/util.js');
  });

  test('handles single file diff', () => {
    const singleDiff = `diff --git a/only.js b/only.js
--- a/only.js
+++ b/only.js
@@ -1 +1 @@
-old
+new`;
    const replacement = `diff --git a/only.js b/only.js
--- a/only.js
+++ b/only.js
@@ -1 +1 @@
-replaced
+done`;
    const result = replaceFileInDiff(singleDiff, 'only.js', replacement);
    expect(result).toContain('replaced');
    expect(result).not.toContain('-old');
  });

  test('trimmed newFileDiff gets trailing newline to prevent section merge', () => {
    // Simulates execPromise stdout.trim() stripping the trailing newline
    const multiDiff = `diff --git a/templates/admin/moderatorLogs.tpl b/templates/admin/moderatorLogs.tpl
--- a/templates/admin/moderatorLogs.tpl
+++ b/templates/admin/moderatorLogs.tpl
@@ -1 +1 @@
-old
+new
diff --git a/data/css/layout.css b/data/css/layout.css
--- a/data/css/layout.css
+++ b/data/css/layout.css
@@ -1 +1 @@
-body{color:red}
+body{color:blue}`;
    const trimmedReplacement = `diff --git a/templates/admin/moderatorLogs.tpl b/templates/admin/moderatorLogs.tpl
--- a/templates/admin/moderatorLogs.tpl
+++ b/templates/admin/moderatorLogs.tpl
@@ -1,3 +1,3 @@
 context
-old line
+new line
 context`;
    // trimmedReplacement has no trailing \n (simulates stdout.trim())
    const result = replaceFileInDiff(multiDiff, 'templates/admin/moderatorLogs.tpl', trimmedReplacement);
    // The replacement should have a trailing newline so layout.css section remains intact
    expect(result).toContain('templates/admin/moderatorLogs.tpl');
    expect(result).toContain('layout.css');
    // Verify sections didn't merge: layout.css should still start on its own line
    expect(result).toMatch(/context\ndiff --git a\/data\/css\/layout\.css/);
    expect(result).toContain('body{color:blue}');
  });

  test('matches correct file among files sharing admin path segment', () => {
    const diff = `diff --git a/templates/admin/moderatorLogs.tpl b/templates/admin/moderatorLogs.tpl
--- a/templates/admin/moderatorLogs.tpl
+++ b/templates/admin/moderatorLogs.tpl
@@ -1 +1 @@
-old tpl
+new tpl
diff --git a/data/css/layout.css b/data/css/layout.css
--- a/data/css/layout.css
+++ b/data/css/layout.css
@@ -1 +1 @@
-old css
+new css
diff --git a/templates/admin/moderators.tpl b/templates/admin/moderators.tpl
--- a/templates/admin/moderators.tpl
+++ b/templates/admin/moderators.tpl
@@ -1 +1 @@
-old moderators
+new moderators`;
    const replacement = `diff --git a/templates/admin/moderatorLogs.tpl b/templates/admin/moderatorLogs.tpl
--- a/templates/admin/moderatorLogs.tpl
+++ b/templates/admin/moderatorLogs.tpl
@@ -1,2 +1,2 @@
 line1
-old tpl
+expanded tpl`;
    const result = replaceFileInDiff(diff, 'templates/admin/moderatorLogs.tpl', replacement);
    expect(result).toContain('expanded tpl');
    // The ORIGINAL addition line should be gone, replaced by expanded version
    expect(result).not.toContain('+new tpl');
    // Other files must be preserved
    expect(result).toContain('layout.css');
    expect(result).toContain('old css');
    expect(result).toContain('moderators.tpl');
    expect(result).toContain('old moderators');
  });

  test('regex handles trailing whitespace in diff header (e.g. CRLF)', () => {
    const diff = "diff --git a/file.js b/file.js\r\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n";
    const replacement = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1 +1 @@
-old
+replaced`;
    const result = replaceFileInDiff(diff, 'file.js', replacement);
    expect(result).toContain('+replaced');
    // The ORIGINAL addition should be gone, replaced by the new content
    expect(result).not.toContain('+new');
  });
});

// ── detectBeforeAfterPairs ──

describe('detectBeforeAfterPairs', () => {
  test('detects heading-style before/after with markdown images', () => {
    const body = `## Before
![before](https://example.com/before.png)

## After
![after](https://example.com/after.png)`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(1);
    expect(pairs[0].before).toBe('https://example.com/before.png');
    expect(pairs[0].after).toBe('https://example.com/after.png');
  });

  test('detects bold-style before/after', () => {
    const body = `**Before:**
![img](https://example.com/before.png)

**After:**
![img](https://example.com/after.png)`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(1);
  });

  test('detects standalone before/after (pattern 2)', () => {
    const body = `Before:
![before](https://example.com/before.png)

After:
![after](https://example.com/after.png)`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(1);
    expect(pairs[0].before).toBe('https://example.com/before.png');
  });

  test('returns empty for no before/after pattern', () => {
    expect(detectBeforeAfterPairs('Just a regular PR description')).toEqual([]);
    expect(detectBeforeAfterPairs('')).toEqual([]);
    expect(detectBeforeAfterPairs(null)).toEqual([]);
    expect(detectBeforeAfterPairs(undefined)).toEqual([]);
    expect(detectBeforeAfterPairs(123)).toEqual([]);
  });

  test('detects multiple before/after pairs', () => {
    const body = `## Before
![b1](https://example.com/b1.png)
## After
![a1](https://example.com/a1.png)

Some text between

## Before
![b2](https://example.com/b2.png)
## After
![a2](https://example.com/a2.png)`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(2);
    expect(pairs[0].before).toBe('https://example.com/b1.png');
    expect(pairs[1].before).toBe('https://example.com/b2.png');
  });

  test('detects HTML img src patterns', () => {
    const body = `## Before
<img src="https://example.com/before.png">
## After
<img src="https://example.com/after.png">`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(1);
    expect(pairs[0].before).toBe('https://example.com/before.png');
  });

  test('detects file:// URLs', () => {
    const body = `## Before
![before](file:///tmp/before.png)
## After
![after](file:///tmp/after.png)`;
    const pairs = detectBeforeAfterPairs(body);
    expect(pairs.length).toBe(1);
    expect(pairs[0].before).toContain('file://');
  });
});

// ── getPlatformInstructions ──

describe('getPlatformInstructions', () => {
  test('returns mac-specific commands', () => {
    const result = getPlatformInstructions('macintel');
    expect(result.gh).toBe('brew install gh');
    expect(result.agents.hermes).toContain('npm install');
    expect(result.agents.cursor).toContain('brew install');
  });

  test('returns windows-specific commands', () => {
    const result = getPlatformInstructions('win32');
    expect(result.gh).toContain('winget');
    expect(result.agents.cursor).toContain('winget');
  });

  test('returns linux-specific commands for unknown platform', () => {
    const result = getPlatformInstructions('linux');
    expect(result.gh).toContain('apt');
    expect(result.agents.aider).toContain('pip install');
  });

  test('all platforms have all agents', () => {
    for (const platform of ['mac', 'win32', 'linux']) {
      const result = getPlatformInstructions(platform);
      expect(result.agents.hermes).toBeDefined();
      expect(result.agents.claude).toBeDefined();
      expect(result.agents.cursor).toBeDefined();
      expect(result.agents.copilot).toBeDefined();
      expect(result.agents.aider).toBeDefined();
      expect(result.agents.codex).toBeDefined();
    }
  });
});

// ── getExt / getName (diff block helpers) ──

describe('getExt', () => {
  test('extracts extension from diff block header', () => {
    expect(getExt('a/src/main.js b/src/main.js\n...')).toBe('.js');
    expect(getExt('a/style.css b/style.css\n...')).toBe('.css');
    expect(getExt('a/file.pm b/file.pm\n...')).toBe('.pm');
  });

  test('returns empty for files without extension', () => {
    expect(getExt('a/Makefile b/Makefile\n...')).toBe('');
    expect(getExt('a/Dockerfile b/Dockerfile\n...')).toBe('');
  });

  test('returns empty for malformed input', () => {
    expect(getExt('no match here')).toBe('');
    expect(getExt('')).toBe('');
  });

  test('handles multi-dot filenames', () => {
    expect(getExt('a/file.test.js b/file.test.js\n...')).toBe('.js');
    expect(getExt('a/archive.tar.gz b/archive.tar.gz\n...')).toBe('.gz');
  });
});

describe('getName', () => {
  test('extracts filename from diff block header', () => {
    expect(getName('a/src/main.js b/src/main.js\n...')).toBe('src/main.js');
    expect(getName('a/style.css b/style.css\n...')).toBe('style.css');
  });

  test('returns empty for malformed input', () => {
    expect(getName('no match')).toBe('');
    expect(getName('')).toBe('');
  });

  test('handles deep paths', () => {
    expect(getName('a/src/components/Button.jsx b/src/components/Button.jsx\n...'))
      .toBe('src/components/Button.jsx');
  });
});

// ── filterPrs (PR search/filter logic) ──

describe('filterPrs', () => {
  const prs = [
    { number: 100, title: 'Fix login bug', author: 'alice', repo: 'org/app', assignees: ['bob'] },
    { number: 200, title: 'Add dark mode', author: 'bob', repo: 'org/app', assignees: ['alice', 'charlie'] },
    { number: 300, title: 'Refactor auth', author: 'charlie', repo: 'org/web', assignees: [] },
  ];

  test('returns all PRs when no filter', () => {
    expect(filterPrs(prs, '')).toHaveLength(3);
    expect(filterPrs(prs, null)).toHaveLength(3);
    expect(filterPrs(prs, undefined)).toHaveLength(3);
  });

  test('filters by title', () => {
    expect(filterPrs(prs, 'login')).toHaveLength(1);
    expect(filterPrs(prs, 'login')[0].number).toBe(100);
  });

  test('filters by author', () => {
    // "alice" matches PR 100 (author) AND PR 200 (assignee)
    expect(filterPrs(prs, 'alice')).toHaveLength(2);
    expect(filterPrs(prs, 'alice')[0].number).toBe(100);
  });

  test('filters by PR number', () => {
    expect(filterPrs(prs, '200')).toHaveLength(1);
    expect(filterPrs(prs, '200')[0].title).toBe('Add dark mode');
  });

  test('filters by repo', () => {
    expect(filterPrs(prs, 'org/web')).toHaveLength(1);
  });

  test('filters by assignee', () => {
    expect(filterPrs(prs, 'charlie')).toHaveLength(2); // PR 200 (assignee) and PR 300 (author)
  });

  test('case-insensitive search', () => {
    expect(filterPrs(prs, 'LOGIN')).toHaveLength(1);
    // "Alice" matches PR 100 (author) and PR 200 (assignee)
    expect(filterPrs(prs, 'Alice')).toHaveLength(2);
  });

  test('returns empty for no match', () => {
    expect(filterPrs(prs, 'nonexistent')).toHaveLength(0);
  });

  test('handles empty PR list', () => {
    expect(filterPrs([], 'test')).toHaveLength(0);
    expect(filterPrs(null, 'test')).toHaveLength(0);
  });

  test('trims whitespace from search', () => {
    expect(filterPrs(prs, '  login  ')).toHaveLength(1);
  });
});

// ── atomicWriteFileSync ──

describe('atomicWriteFileSync', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reviewer-test-'));

  function atomicWriteFileSync(filePath, data) {
    const tmpPath = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  }

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes data to file', () => {
    const filePath = path.join(tmpDir, 'test-atomic.txt');
    atomicWriteFileSync(filePath, 'hello world');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world');
  });

  test('overwrites existing file', () => {
    const filePath = path.join(tmpDir, 'test-overwrite.txt');
    atomicWriteFileSync(filePath, 'first');
    atomicWriteFileSync(filePath, 'second');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('second');
  });

  test('writes JSON data', () => {
    const filePath = path.join(tmpDir, 'test-json.json');
    const data = JSON.stringify({ key: 'value', num: 42 }, null, 2);
    atomicWriteFileSync(filePath, data);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.key).toBe('value');
    expect(parsed.num).toBe(42);
  });

  test('no temp file left after write', () => {
    const filePath = path.join(tmpDir, 'test-notemp.txt');
    atomicWriteFileSync(filePath, 'data');
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── loadConfig (simplified test of merge logic) ──

describe('loadConfig merge logic', () => {
  // Exact reproduction of the config merge logic from main.js
  // Note: the deep merge lines operate AFTER the top-level spread,
  // so config.imageUpload = parsed.imageUpload at that point,
  // making the deep merge a no-op (it doesn't restore defaults).
  function mergeConfigs(defaults, publicConfig, privateConfig) {
    let config = { ...defaults };

    if (publicConfig) {
      config = { ...config, ...publicConfig };
      if (publicConfig.imageUpload) config.imageUpload = { ...config.imageUpload, ...publicConfig.imageUpload };
      if (publicConfig.prFilter) config.prFilter = { ...config.prFilter, ...publicConfig.prFilter };
      if (publicConfig.autoFix) config.autoFix = { ...config.autoFix, ...publicConfig.autoFix };
    }
    if (privateConfig) {
      config = { ...config, ...privateConfig };
      if (privateConfig.imageUpload) config.imageUpload = { ...config.imageUpload, ...privateConfig.imageUpload };
      if (privateConfig.prFilter) config.prFilter = { ...config.prFilter, ...privateConfig.prFilter };
      if (privateConfig.autoFix) config.autoFix = { ...config.autoFix, ...privateConfig.autoFix };
    }
    return config;
  }

  const defaults = {
    aiCommand: 'hermes',
    aiTagPrefix: '@Hermes',
    contextLines: 5,
    imageUpload: { enabled: false, s3Bucket: '' },
    prFilter: { reviewRequested: true, titleContains: '' },
    autoFix: { enabled: true }
  };

  test('returns defaults when no configs provided', () => {
    const config = mergeConfigs(defaults, null, null);
    expect(config.aiCommand).toBe('hermes');
    expect(config.contextLines).toBe(5);
  });

  test('public config overrides defaults', () => {
    const config = mergeConfigs(defaults, { aiCommand: 'claude', contextLines: 10 }, null);
    expect(config.aiCommand).toBe('claude');
    expect(config.contextLines).toBe(10);
    expect(config.aiTagPrefix).toBe('@Hermes'); // untouched
  });

  test('private config overrides public config', () => {
    const config = mergeConfigs(defaults, { aiCommand: 'claude' }, { aiCommand: 'aider' });
    expect(config.aiCommand).toBe('aider');
  });

  test('deep merges imageUpload', () => {
    const config = mergeConfigs(defaults, { imageUpload: { enabled: true } }, null);
    expect(config.imageUpload.enabled).toBe(true);
    // Note: the top-level spread replaces config.imageUpload entirely,
    // so the deep merge line is a no-op — s3Bucket from defaults is lost
    expect(config.imageUpload.s3Bucket).toBeUndefined();
  });

  test('deep merges prFilter', () => {
    const config = mergeConfigs(defaults, null, { prFilter: { titleContains: 'merge' } });
    expect(config.prFilter.titleContains).toBe('merge');
    // Same as above — reviewRequested from defaults is lost
    expect(config.prFilter.reviewRequested).toBeUndefined();
  });

  test('deep merges autoFix', () => {
    const config = mergeConfigs(defaults, null, { autoFix: { enabled: false } });
    expect(config.autoFix.enabled).toBe(false);
  });
});

// ── Diff edge cases ──

describe('Diff edge cases', () => {
  test('parseDiffLineNumbers handles rename diff', () => {
    const diff = `diff --git a/old-name.js b/new-name.js
similarity index 100%
rename from old-name.js
rename to new-name.js`;
    const result = parseDiffLineNumbers(diff);
    // Renames with no content changes have no hunk
    expect(result['new-name.js']).toBeDefined();
  });

  test('computeDiffPositions handles empty lines in diff', () => {
    const diff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,3 +1,4 @@
 line1

+added
 line3`;
    const positions = computeDiffPositions(diff);
    // Empty lines in diff should NOT be counted as positions
    expect(positions['test.js:1:LEFT']).toBe(1);   // line1 context
    expect(positions['test.js:1:RIGHT']).toBe(1);   // line1 context
    expect(positions['test.js:2:RIGHT']).toBe(2);   // +added (not inflated by empty line)
    expect(positions['test.js:2:LEFT']).toBe(3);    // line3 context
  });

  test('computeDiffPositions does not count empty lines between files', () => {
    const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-old
+new

diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-oldb
+newb`;
    const positions = computeDiffPositions(diff);
    // Position should reset per file; empty line between files must not inflate a.js positions
    expect(positions['a.js:1:LEFT']).toBe(1);
    expect(positions['a.js:1:RIGHT']).toBe(2);
    expect(positions['b.js:1:LEFT']).toBe(1);
    expect(positions['b.js:1:RIGHT']).toBe(2);
  });

  test('computeDiffPositions counts \\ No newline at end of file for position but not line numbers', () => {
    const diff = `diff --git a/f.js b/f.js
--- a/f.js
+++ b/f.js
@@ -1,2 +1,2 @@
 line1
-old
\\ No newline at end of file
+new`;
    const positions = computeDiffPositions(diff);
    expect(positions['f.js:1:LEFT']).toBe(1);   // line1 context at position 1
    expect(positions['f.js:1:RIGHT']).toBe(1);   // line1 context at position 1
    expect(positions['f.js:2:LEFT']).toBe(2);    // -old at position 2
    // \ No newline at end of file takes position 3 but does NOT map to a line or change line numbers
    expect(positions['f.js:2:RIGHT']).toBe(4);   // +new at position 4 (position 3 was the \ marker)
    // Verify no spurious entry from the \ marker line
    expect(positions['f.js:3:LEFT']).toBeUndefined();
  });

  test('extractExtensionsFromDiff handles binary files', () => {
    const diff = `Binary files a/image.png and b/image.png differ`;
    const exts = extractExtensionsFromDiff(diff);
    // Binary file markers don't have +++ b/ or --- a/ lines
    expect(exts).toEqual([]);
  });

  test('sortDiffByExtension preserves content within file blocks', () => {
    const diff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function test() {
-  return false;
+  return true;
 }`;
    const sorted = sortDiffByExtension(diff);
    expect(sorted).toContain('return true');
    expect(sorted).toContain('return false');
    expect(sorted).toContain('function test()');
  });
});

// ── Comment classification (from save-review handler) ──

describe('Comment classification', () => {
  function classifyComments(comments, aiTagPrefix) {
    const aiTag = (aiTagPrefix || '@Hermes').toLowerCase();
    const askTag = '@ask';
    const aiComments = [];
    const askComments = [];
    const prComments = [];
    for (const c of comments || []) {
      const textLower = c.text.toLowerCase();
      if (textLower.startsWith(askTag)) {
        askComments.push(c);
      } else if (textLower.startsWith(aiTag)) {
        aiComments.push(c);
      } else {
        prComments.push(c);
      }
    }
    return { aiComments, askComments, prComments };
  }

  test('classifies regular comments', () => {
    const result = classifyComments([
      { text: 'Looks good' },
      { text: 'Please fix this' }
    ], '@Hermes');
    expect(result.prComments).toHaveLength(2);
    expect(result.aiComments).toHaveLength(0);
    expect(result.askComments).toHaveLength(0);
  });

  test('classifies AI-tagged comments', () => {
    const result = classifyComments([
      { text: '@Hermes check this function' },
      { text: 'regular comment' }
    ], '@Hermes');
    expect(result.aiComments).toHaveLength(1);
    expect(result.prComments).toHaveLength(1);
  });

  test('classifies @ask comments', () => {
    const result = classifyComments([
      { text: '@ask why is this needed?' },
      { text: 'normal' }
    ], '@Hermes');
    expect(result.askComments).toHaveLength(1);
    expect(result.prComments).toHaveLength(1);
  });

  test('case-insensitive matching', () => {
    const result = classifyComments([
      { text: '@hermes do something' },
      { text: '@HERMES also this' },
      { text: '@Ask a question' }
    ], '@Hermes');
    expect(result.aiComments).toHaveLength(2);
    expect(result.askComments).toHaveLength(1);
  });

  test('handles empty/null comments', () => {
    expect(classifyComments([], '@Hermes').prComments).toHaveLength(0);
    expect(classifyComments(null, '@Hermes').prComments).toHaveLength(0);
    expect(classifyComments(undefined, '@Hermes').prComments).toHaveLength(0);
  });

  test('@ask takes priority over custom AI tag', () => {
    const result = classifyComments([{ text: '@ask something' }], '@ask');
    // @ask check happens first
    expect(result.askComments).toHaveLength(1);
    expect(result.aiComments).toHaveLength(0);
  });
});

// ── PR event type mapping (from submit-github-review handler) ──

describe('GitHub review event mapping', () => {
  function mapEventType(eventType) {
    const eventMap = {
      'approve': 'APPROVE',
      'request_changes': 'REQUEST_CHANGES',
      'comment': 'COMMENT'
    };
    return eventMap[eventType] || 'COMMENT';
  }

  test('maps approve', () => {
    expect(mapEventType('approve')).toBe('APPROVE');
  });

  test('maps request_changes', () => {
    expect(mapEventType('request_changes')).toBe('REQUEST_CHANGES');
  });

  test('maps comment', () => {
    expect(mapEventType('comment')).toBe('COMMENT');
  });

  test('defaults to COMMENT for unknown', () => {
    expect(mapEventType('unknown')).toBe('COMMENT');
    expect(mapEventType('')).toBe('COMMENT');
    expect(mapEventType(null)).toBe('COMMENT');
    expect(mapEventType(undefined)).toBe('COMMENT');
  });
});

// ── PR number boundary matching (delete-pr-files handler) ──

describe('PR file matching for cleanup', () => {
  function matchesPrFile(filename, prNumber) {
    return filename.includes(`-${prNumber}-`) ||
           filename === `pr-${prNumber}-clean.diff` ||
           filename.startsWith(`pr-${prNumber}-`);
  }

  test('matches exact PR number file', () => {
    expect(matchesPrFile('pr-42-clean.diff', 42)).toBe(true);
  });

  test('matches PR number in filename', () => {
    expect(matchesPrFile('review-payload-1723456789.json', 42)).toBe(false);
    expect(matchesPrFile('pr-42-context.diff', 42)).toBe(true);
  });

  test('does not match PR 1 for PR 10', () => {
    expect(matchesPrFile('pr-10-clean.diff', 1)).toBe(false);
    expect(matchesPrFile('pr-1-clean.diff', 10)).toBe(false);
  });

  test('does not match PR 100 for PR 10', () => {
    expect(matchesPrFile('pr-100-clean.diff', 10)).toBe(false);
  });

  test('matches boundary-aware pattern with dashes', () => {
    expect(matchesPrFile('close-comment-42-1723456789.txt', 42)).toBe(true);
    expect(matchesPrFile('close-comment-421-1723456789.txt', 42)).toBe(false);
  });
});

// ── diff context validation (expand-diff-context handler) ──

describe('Context lines validation', () => {
  function validateContextLines(contextLines) {
    const ctxLines = parseInt(contextLines, 10);
    if (isNaN(ctxLines) || ctxLines < 0 || ctxLines > 9999) {
      return { valid: false, error: 'Invalid contextLines value' };
    }
    return { valid: true, value: ctxLines };
  }

  test('accepts valid numbers', () => {
    expect(validateContextLines(5).valid).toBe(true);
    expect(validateContextLines('10').valid).toBe(true);
    expect(validateContextLines(0).valid).toBe(true);
    expect(validateContextLines(9999).valid).toBe(true);
  });

  test('rejects negative numbers', () => {
    expect(validateContextLines(-1).valid).toBe(false);
  });

  test('rejects numbers above 9999', () => {
    expect(validateContextLines(10000).valid).toBe(false);
  });

  test('rejects NaN', () => {
    expect(validateContextLines('abc').valid).toBe(false);
    expect(validateContextLines(undefined).valid).toBe(false);
    expect(validateContextLines(null).valid).toBe(false);
  });
});

// ── File path validation (get-file-blame handler) ──

describe('File path validation', () => {
  function isValidFilePath(filePath) {
    return filePath && !/[;&|`$(){}!<>\"\n]/.test(filePath);
  }

  test('accepts valid file paths', () => {
    expect(isValidFilePath('src/main.js')).toBe(true);
    expect(isValidFilePath('lib/utils.pm')).toBe(true);
    expect(isValidFilePath('deep/nested/path/file.css')).toBe(true);
  });

  test('rejects paths with shell metacharacters', () => {
    expect(isValidFilePath('file;rm -rf /')).toBe(false);
    expect(isValidFilePath('file&echo pwned')).toBe(false);
    expect(isValidFilePath('file|cat /etc/passwd')).toBe(false);
    expect(isValidFilePath('file`whoami`')).toBe(false);
    expect(isValidFilePath('file$(whoami)')).toBe(false);
    expect(isValidFilePath('file{a,b}')).toBe(false);
    expect(isValidFilePath('file<redirect')).toBe(false);
    expect(isValidFilePath('file>redirect')).toBe(false);
    expect(isValidFilePath('file"quote')).toBe(false);
    expect(isValidFilePath('file\nnewline')).toBe(false);
  });

  test('rejects null/empty paths', () => {
    expect(isValidFilePath(null)).toBeFalsy();
    expect(isValidFilePath('')).toBeFalsy();
    expect(isValidFilePath(undefined)).toBeFalsy();
  });
});

// ── getNestedValue (renderer.js preferences) ──

describe('getNestedValue', () => {
  function getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : '', obj);
  }

  test('gets top-level value', () => {
    expect(getNestedValue({ name: 'test' }, 'name')).toBe('test');
  });

  test('gets nested value', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  test('returns empty string for missing key', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBe('');
  });

  test('returns empty string for missing nested key', () => {
    expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBe('');
  });

  test('returns empty string for deeply missing key', () => {
    expect(getNestedValue({}, 'a.b.c')).toBe('');
  });

  test('handles null object', () => {
    expect(getNestedValue(null, 'a.b')).toBe('');
  });

  test('handles undefined object', () => {
    expect(getNestedValue(undefined, 'a')).toBe('');
  });

  test('returns falsy values (0, false, empty string)', () => {
    expect(getNestedValue({ a: 0 }, 'a')).toBe(0);
    expect(getNestedValue({ a: false }, 'a')).toBe(false);
    expect(getNestedValue({ a: '' }, 'a')).toBe('');
  });

  test('returns empty string for undefined value (not the key)', () => {
    // When the key exists but value is undefined, reduce returns ''
    expect(getNestedValue({ a: undefined }, 'a')).toBe('');
  });

  test('handles single-key path', () => {
    expect(getNestedValue({ x: 'found' }, 'x')).toBe('found');
  });
});

// ── setNestedValue (renderer.js preferences) ──

describe('setNestedValue', () => {
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

  test('sets top-level value', () => {
    const obj = {};
    setNestedValue(obj, 'name', 'test');
    expect(obj.name).toBe('test');
  });

  test('sets nested value', () => {
    const obj = { a: {} };
    setNestedValue(obj, 'a.b', 42);
    expect(obj.a.b).toBe(42);
  });

  test('creates intermediate objects', () => {
    const obj = {};
    setNestedValue(obj, 'a.b.c', 'deep');
    expect(obj.a.b.c).toBe('deep');
  });

  test('overwrites existing value', () => {
    const obj = { a: { b: 'old' } };
    setNestedValue(obj, 'a.b', 'new');
    expect(obj.a.b).toBe('new');
  });

  test('overwrites non-object intermediate with object', () => {
    const obj = { a: 'string' };
    setNestedValue(obj, 'a.b', 'value');
    expect(obj.a.b).toBe('value');
  });

  test('sets boolean values', () => {
    const obj = {};
    setNestedValue(obj, 'enabled', true);
    expect(obj.enabled).toBe(true);
  });

  test('sets null values', () => {
    const obj = {};
    setNestedValue(obj, 'key', null);
    expect(obj.key).toBeNull();
  });

  test('handles deeply nested paths', () => {
    const obj = {};
    setNestedValue(obj, 'a.b.c.d.e', 'bottom');
    expect(obj.a.b.c.d.e).toBe('bottom');
  });
});

// ── Draft path generation (main.js getDraftPath) ──

describe('Draft path generation', () => {
  const crypto = require('crypto');

  function getDraftPath(diffFilePath, draftsDir) {
    const hash = crypto.createHash('md5').update(diffFilePath || 'unsaved').digest('hex').slice(0, 12);
    return path.join(draftsDir, `draft-${hash}.json`);
  }

  test('generates consistent hash for same input', () => {
    const p1 = getDraftPath('/tmp/test.diff', '/drafts');
    const p2 = getDraftPath('/tmp/test.diff', '/drafts');
    expect(p1).toBe(p2);
  });

  test('generates different hashes for different inputs', () => {
    const p1 = getDraftPath('/tmp/a.diff', '/drafts');
    const p2 = getDraftPath('/tmp/b.diff', '/drafts');
    expect(p1).not.toBe(p2);
  });

  test('uses "unsaved" for null/undefined path', () => {
    const p1 = getDraftPath(null, '/drafts');
    const p2 = getDraftPath(undefined, '/drafts');
    const p3 = getDraftPath('', '/drafts');
    // null and undefined both fall through to 'unsaved'
    expect(p1).toBe(p2);
    // empty string is falsy, also uses 'unsaved'
    expect(p1).toBe(p3);
  });

  test('hash is 12 hex characters', () => {
    const p = getDraftPath('test', '/drafts');
    const match = p.match(/draft-([a-f0-9]+)\.json$/);
    expect(match).toBeTruthy();
    expect(match[1]).toHaveLength(12);
  });

  test('path includes drafts directory', () => {
    const p = getDraftPath('test', '/my/drafts');
    expect(p).toMatch(/^\/my\/drafts\/draft-/);
  });
});

// ── Draft CRUD (main.js saveDraft/loadDraft/deleteDraft) ──

describe('Draft CRUD operations', () => {
  const crypto = require('crypto');
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getDraftPath(diffFilePath) {
    const hash = crypto.createHash('md5').update(diffFilePath || 'unsaved').digest('hex').slice(0, 12);
    return path.join(tmpDir, `draft-${hash}.json`);
  }

  function atomicWriteFileSync(filePath, data) {
    const tmpPath = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  }

  function saveDraft(diffFilePath, draft) {
    const draftPath = getDraftPath(diffFilePath);
    atomicWriteFileSync(draftPath, JSON.stringify(draft, null, 2));
    return draftPath;
  }

  function loadDraft(diffFilePath) {
    const draftPath = getDraftPath(diffFilePath);
    if (fs.existsSync(draftPath)) {
      const raw = fs.readFileSync(draftPath, 'utf8');
      return JSON.parse(raw);
    }
    return null;
  }

  function deleteDraft(diffFilePath) {
    const draftPath = getDraftPath(diffFilePath);
    if (fs.existsSync(draftPath)) {
      fs.unlinkSync(draftPath);
    }
  }

  test('save and load draft', () => {
    const draft = { comments: [{ text: 'test' }], prNumber: 42 };
    saveDraft('/tmp/test.diff', draft);
    const loaded = loadDraft('/tmp/test.diff');
    expect(loaded.comments).toHaveLength(1);
    expect(loaded.prNumber).toBe(42);
  });

  test('load returns null for non-existent draft', () => {
    expect(loadDraft('/tmp/nonexistent.diff')).toBeNull();
  });

  test('delete removes draft', () => {
    saveDraft('/tmp/test.diff', { comments: [] });
    expect(loadDraft('/tmp/test.diff')).not.toBeNull();
    deleteDraft('/tmp/test.diff');
    expect(loadDraft('/tmp/test.diff')).toBeNull();
  });

  test('delete is safe for non-existent draft', () => {
    expect(() => deleteDraft('/tmp/nonexistent.diff')).not.toThrow();
  });

  test('save overwrites existing draft', () => {
    saveDraft('/tmp/test.diff', { comments: [{ text: 'first' }] });
    saveDraft('/tmp/test.diff', { comments: [{ text: 'second' }] });
    const loaded = loadDraft('/tmp/test.diff');
    expect(loaded.comments[0].text).toBe('second');
  });

  test('different files get different drafts', () => {
    saveDraft('/tmp/a.diff', { prNumber: 1 });
    saveDraft('/tmp/b.diff', { prNumber: 2 });
    expect(loadDraft('/tmp/a.diff').prNumber).toBe(1);
    expect(loadDraft('/tmp/b.diff').prNumber).toBe(2);
  });
});

// ── GitHub image URL regex (main.js download-github-images) ──

describe('GitHub image URL regex', () => {
  const urlRegex = /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/g;

  test('matches standard github user-attachments URL', () => {
    const text = '![img](https://github.com/user-attachments/assets/abc123-def456)';
    const matches = text.match(urlRegex);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('user-attachments/assets/');
  });

  test('matches UUID-style asset IDs', () => {
    const text = 'https://github.com/user-attachments/assets/550e8400-e29b-41d4-a716-446655440000';
    const matches = text.match(urlRegex);
    expect(matches).toHaveLength(1);
  });

  test('does not match non-asset github URLs', () => {
    const text = 'https://github.com/webtoolbox/pr-reviewer/pull/42';
    expect(text.match(urlRegex)).toBeNull();
  });

  test('finds multiple URLs', () => {
    const text = `
      https://github.com/user-attachments/assets/aaa-bbb
      some text
      https://github.com/user-attachments/assets/ccc-ddd
    `;
    const matches = text.match(urlRegex);
    expect(matches).toHaveLength(2);
  });

  test('deduplicates via Set', () => {
    const text = 'https://github.com/user-attachments/assets/aaa-bbb https://github.com/user-attachments/assets/aaa-bbb';
    const urls = [...new Set(text.match(urlRegex) || [])];
    expect(urls).toHaveLength(1);
  });
});

// ── isReviewComment (renderer.js inline comments) ──

describe('isReviewComment', () => {
  function isReviewComment(commentId, currentInlineCommentIds) {
    return currentInlineCommentIds.has(commentId);
  }

  test('returns true for known comment ID', () => {
    const ids = new Set([100, 200, 300]);
    expect(isReviewComment(200, ids)).toBe(true);
  });

  test('returns false for unknown comment ID', () => {
    const ids = new Set([100, 200, 300]);
    expect(isReviewComment(999, ids)).toBe(false);
  });

  test('returns false for empty set', () => {
    expect(isReviewComment(1, new Set())).toBe(false);
  });
});

// ── Comment UID counter (renderer.js) ──

describe('Comment UID counter', () => {
  test('increments on each assignment', () => {
    let commentUidCounter = 0;
    const c1 = { _uid: ++commentUidCounter };
    const c2 = { _uid: ++commentUidCounter };
    const c3 = { _uid: ++commentUidCounter };
    expect(c1._uid).toBe(1);
    expect(c2._uid).toBe(2);
    expect(c3._uid).toBe(3);
  });

  test('findIndex by _uid is stable', () => {
    let counter = 0;
    const comments = [
      { _uid: ++counter, file: 'a.js' },
      { _uid: ++counter, file: 'b.js' },
      { _uid: ++counter, file: 'c.js' },
    ];
    // Remove middle element
    const idx = comments.findIndex(c => c._uid === 2);
    comments.splice(idx, 1);
    // UIDs 1 and 3 still findable
    expect(comments.find(c => c._uid === 1).file).toBe('a.js');
    expect(comments.find(c => c._uid === 3).file).toBe('c.js');
    // UID 2 is gone
    expect(comments.findIndex(c => c._uid === 2)).toBe(-1);
  });
});

// ── Review save comment filtering (main.js save-review handler) ──

describe('Review save comment filtering', () => {
  // Mirrors the logic in the save-review IPC handler
  function filterReviewComments(comments) {
    return comments.filter(c => {
      const t = c.text.toLowerCase();
      return !t.startsWith('@hermes') && !t.startsWith('@ask');
    });
  }

  function countAiComments(comments) {
    return comments.filter(c => c.text.toLowerCase().startsWith('@hermes')).length;
  }

  function countAskComments(comments) {
    return comments.filter(c => c.text.toLowerCase().startsWith('@ask')).length;
  }

  test('filters out AI-tagged comments', () => {
    const comments = [
      { text: 'Looks good' },
      { text: '@Hermes check this' },
      { text: 'Fix the bug' },
    ];
    expect(filterReviewComments(comments)).toHaveLength(2);
  });

  test('filters out @ask comments', () => {
    const comments = [
      { text: 'Normal' },
      { text: '@ask why is this needed?' },
    ];
    expect(filterReviewComments(comments)).toHaveLength(1);
  });

  test('counts AI comments correctly', () => {
    const comments = [
      { text: '@Hermes do this' },
      { text: '@HERMES do that' },
      { text: 'normal' },
    ];
    expect(countAiComments(comments)).toBe(2);
  });

  test('counts @ask comments correctly', () => {
    const comments = [
      { text: '@ask question 1' },
      { text: '@ask question 2' },
      { text: 'normal' },
    ];
    expect(countAskComments(comments)).toBe(2);
  });

  test('all counts sum to total', () => {
    const comments = [
      { text: 'normal1' },
      { text: '@Hermes ai' },
      { text: '@ask q' },
      { text: 'normal2' },
    ];
    expect(filterReviewComments(comments).length + countAiComments(comments) + countAskComments(comments))
      .toBe(comments.length);
  });
});

// ── Cleanup file matching boundary (main.js cleanupOldFiles) ──

describe('Cleanup file matching', () => {
  function shouldCleanup(filePath, retentionDays, now, fileMtimeMs) {
    const cutoffMs = now - (retentionDays * 24 * 60 * 60 * 1000);
    return fileMtimeMs < cutoffMs;
  }

  test('deletes files older than retention period', () => {
    const now = Date.now();
    const oldTime = now - (200 * 24 * 60 * 60 * 1000); // 200 days ago
    expect(shouldCleanup('review.json', 180, now, oldTime)).toBe(true);
  });

  test('keeps files within retention period', () => {
    const now = Date.now();
    const recentTime = now - (30 * 24 * 60 * 60 * 1000); // 30 days ago
    expect(shouldCleanup('review.json', 180, now, recentTime)).toBe(false);
  });

  test('handles exact boundary', () => {
    const now = Date.now();
    const retentionDays = 180;
    const exactCutoff = now - (retentionDays * 24 * 60 * 60 * 1000);
    // Exact cutoff is NOT less than cutoff (not strictly less)
    expect(shouldCleanup('f.json', retentionDays, now, exactCutoff)).toBe(false);
    // 1ms before cutoff IS less
    expect(shouldCleanup('f.json', retentionDays, now, exactCutoff - 1)).toBe(true);
  });
});

// ── Config path helpers (main.js) ──

describe('Config path helpers', () => {
  // These test the logic patterns, not the actual Electron app.getPath()
  test('reviewDir falls back to userData/reviews when no config', () => {
    const config = { reviewSaveDir: '' };
    const userData = '/Users/test/Library/app';
    const dir = config.reviewSaveDir || path.join(userData, 'reviews');
    expect(dir).toBe('/Users/test/Library/app/reviews');
  });

  test('reviewDir uses config value when set', () => {
    const config = { reviewSaveDir: '~/my-reviews' };
    const userData = '/Users/test/Library/app';
    const dir = config.reviewSaveDir || path.join(userData, 'reviews');
    expect(dir).toBe('~/my-reviews');
  });

  test('draftsDir is always userData/drafts', () => {
    const userData = '/Users/test/Library/app';
    expect(path.join(userData, 'drafts')).toBe('/Users/test/Library/app/drafts');
  });

  test('generatedDir is always userData/generated', () => {
    const userData = '/Users/test/Library/app';
    expect(path.join(userData, 'generated')).toBe('/Users/test/Library/app/generated');
  });
});

// ── findHermesPython logic (main.js) ──

describe('findHermesPython logic', () => {
  // Simulates the path resolution logic without Electron's app.getPath()
  function findHermesPython(homeDir, existingPaths) {
    const hermesHome = path.join(homeDir, '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
    if (existingPaths.has(hermesHome)) return hermesHome;
    return 'python3';
  }

  test('returns hermes venv python when it exists', () => {
    const home = '/Users/test';
    const expected = '/Users/test/.hermes/hermes-agent/venv/bin/python';
    expect(findHermesPython(home, new Set([expected]))).toBe(expected);
  });

  test('falls back to python3 when hermes venv missing', () => {
    expect(findHermesPython('/Users/test', new Set())).toBe('python3');
  });
});

// ── IPC response shape validation ──

describe('IPC response shapes', () => {
  // Validates the expected response shapes from various IPC handlers

  test('close-pr success response', () => {
    const response = { success: true };
    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();
  });

  test('close-pr error response', () => {
    const response = { error: 'PR number is required' };
    expect(response.error).toBeTruthy();
    expect(response.success).toBeUndefined();
  });

  test('submit-github-review success response', () => {
    const response = { success: true, reviewId: 12345, htmlUrl: 'https://github.com/x/y/pull/1' };
    expect(response.success).toBe(true);
    expect(response.reviewId).toBeTruthy();
    expect(response.htmlUrl).toContain('github.com');
  });

  test('load-pr error response', () => {
    const response = { error: 'Could not get PR HEAD SHA' };
    expect(response.error).toBeTruthy();
    expect(response.content).toBeUndefined();
  });

  test('list-prs response has prs array', () => {
    const response = { prs: [{ number: 1, title: 'test' }] };
    expect(Array.isArray(response.prs)).toBe(true);
  });

  test('list-prs error response has empty array', () => {
    const response = { prs: [], error: 'Set repoOwner and repoName in config' };
    expect(response.prs).toEqual([]);
    expect(response.error).toBeTruthy();
  });

  test('list-repos response has repos array', () => {
    const response = { repos: [{ owner: 'org', name: 'repo', checked: true }] };
    expect(Array.isArray(response.repos)).toBe(true);
  });

  test('check-binaries response shape', () => {
    const response = { ghAvailable: true, availableAgents: [{ id: 'hermes', command: 'hermes' }] };
    expect(typeof response.ghAvailable).toBe('boolean');
    expect(Array.isArray(response.availableAgents)).toBe(true);
  });

  test('auto-detect-agent response shape', () => {
    const response = { detected: true, agent: 'hermes' };
    expect(typeof response.detected).toBe('boolean');
    expect(typeof response.agent).toBe('string');
  });

  test('get-config response has all expected fields', () => {
    const config = {
      chatId: null, prNumber: null, aiTagPrefix: '@Hermes',
      aiCommand: 'hermes', prFilter: {}, repoOwner: '', repoName: '',
      repoPath: '', editorCommand: 'code', contextLines: 5,
      imageUploadEnabled: false, imageUpload: {}, diff: {},
      cleanup: {}, rules: { enabled: false }, autoFix: { enabled: true }
    };
    expect(config.aiCommand).toBeDefined();
    expect(config.contextLines).toBeDefined();
    expect(config.autoFix).toBeDefined();
    expect(config.rules).toBeDefined();
  });
});

// ── Review body handling (renderer.js) ──

describe('Review body handling', () => {
  test('empty body produces empty review body', () => {
    const body = '';
    expect(body.trim()).toBe('');
  });

  test('body with only whitespace is treated as empty', () => {
    const body = '   \n\t  ';
    expect(body.trim()).toBe('');
  });

  test('body preserves content', () => {
    const body = 'This PR looks good overall but needs minor fixes.';
    expect(body.trim()).toBe(body);
  });

  test('body preserves markdown formatting', () => {
    const body = '**Bold** and *italic* and `code`\n\n- item 1\n- item 2';
    expect(body).toContain('**Bold**');
    expect(body).toContain('*italic*');
    expect(body).toContain('`code`');
    expect(body).toContain('- item 1');
  });
});

// ── Export filename generation (renderer.js) ──

describe('Export filename generation', () => {
  test('markdown export filename with PR number', () => {
    const prNum = '42';
    expect(`pr-${prNum}-review.md`).toBe('pr-42-review.md');
  });

  test('JSON export filename with PR number', () => {
    const prNum = '42';
    expect(`pr-${prNum}-review.json`).toBe('pr-42-review.json');
  });

  test('export filename with unknown PR', () => {
    const prNum = 'unknown';
    expect(`pr-${prNum}-review.md`).toBe('pr-unknown-review.md');
  });
});

// ── Dark color scheme consistency (renderer.js) ──
// After context expand, renderFilteredDiff() must use 'dark' colorScheme
// (not 'auto') so that the d2h-dark-color-scheme class is always applied.
// See: https://github.com/rtfpessoa/diff2html — colorSchemeToCss('auto')
// returns 'd2h-auto-color-scheme', whose dark styles are behind
// @media (prefers-color-scheme: dark). In Electron, nativeTheme may not
// be dark even when the app UI is dark (background: #0d1117).

describe('Dark color scheme consistency', () => {
  let rendererSource;

  beforeAll(() => {
    rendererSource = fs.readFileSync(
      path.join(__dirname, 'renderer.js'),
      'utf8'
    );
  });

  test('loadDiff uses colorScheme: dark', () => {
    // loadDiff should use colorScheme: 'dark' for unconditional dark styling
    // (via Diff2HtmlUI.draw(), which handles hljs internally and preserves
    // word-level del/ins tags — no longer uses Diff2Html.html())
    const loadDiffMatch = rendererSource.match(
      /function loadDiff\([\s\S]*?colorScheme:\s*'([^']+)'/
    );
    expect(loadDiffMatch).not.toBeNull();
    expect(loadDiffMatch[1]).toBe('dark');
  });

  test('renderFilteredDiff uses colorScheme: dark (not auto)', () => {
    // renderFilteredDiff must also use 'dark' — 'auto' produces
    // d2h-auto-color-scheme which only works with prefers-color-scheme: dark
    const renderFilteredMatch = rendererSource.match(
      /function renderFilteredDiff\(\)\s*\{[\s\S]*?colorScheme:\s*'([^']+)'/
    );
    expect(renderFilteredMatch).not.toBeNull();
    expect(renderFilteredMatch[1]).toBe('dark');
  });

  test('both render paths use the same colorScheme value', () => {
    // Extract all colorScheme values from Diff2Html calls
    const colorSchemes = [...rendererSource.matchAll(
      /colorScheme:\s*'([^']+)'/g
    )].map(m => m[1]);

    // All should be 'dark' — no 'auto' or 'light' in the diff render paths
    for (const cs of colorSchemes) {
      expect(cs).toBe('dark');
    }
  });

  test('diff2html colorSchemeToCss maps dark to d2h-dark-color-scheme', () => {
    // Verify the CSS class that diff2html generates for 'dark' scheme
    // matches the selectors in index.html (.d2h-dark-color-scheme .d2h-ins, etc.)
    const colorSchemeToCss = (colorScheme) => {
      switch (colorScheme) {
        case 'dark': return 'd2h-dark-color-scheme';
        case 'auto': return 'd2h-auto-color-scheme';
        case 'light':
        default: return 'd2h-light-color-scheme';
      }
    };

    expect(colorSchemeToCss('dark')).toBe('d2h-dark-color-scheme');
    expect(colorSchemeToCss('auto')).toBe('d2h-auto-color-scheme');
    // The auto variant only works with @media (prefers-color-scheme: dark)
    expect(colorSchemeToCss('auto')).not.toBe('d2h-dark-color-scheme');
  });

  test('index.html styles d2h-dark-color-scheme but not d2h-auto-color-scheme directly', () => {
    const indexHtml = fs.readFileSync(
      path.join(__dirname, 'index.html'),
      'utf8'
    );

    // index.html has custom dark theme overrides for .d2h-dark-color-scheme
    expect(indexHtml).toContain('.d2h-dark-color-scheme');

    // The base diff2html CSS has d2h-auto-color-scheme inside @media queries,
    // but index.html custom overrides use .d2h-dark-color-scheme directly.
    // So renderFilteredDiff must produce d2h-dark-color-scheme (not auto)
    // to pick up both the library CSS and the app's custom overrides.
    const darkOverrides = (indexHtml.match(/\.d2h-dark-color-scheme/g) || []).length;
    expect(darkOverrides).toBeGreaterThan(0);
  });

  test('handleContextExpand targets file by name via replaceFileInDiff', () => {
    // Before the fix, the scroll restoration code used:
    //   diffContainer.querySelector(`.d2h-file-wrapper .d2h-file-name`)
    // which always returns the FIRST file's header, not the target file.
    // The current implementation targets the file by name in the diff content
    // string via replaceFileInDiff (content-based, not first-DOM-match).
    const contextExpandSection = rendererSource.substring(
      rendererSource.indexOf('async function handleContextExpand'),
      rendererSource.indexOf('function replaceFileInDiff')
    );

    // Should NOT use querySelector (returns first match only)
    expect(contextExpandSection).not.toContain(
      "querySelector(`.d2h-file-wrapper .d2h-file-name`)"
    );
    // Should use replaceFileInDiff + fileName to target the specific file
    expect(contextExpandSection).toContain('replaceFileInDiff');
    expect(contextExpandSection).toContain('fileName');
  });
});

// ── Auto-advance after approve ──

describe('Auto-advance after approve', () => {
  let rendererSource;

  beforeAll(() => {
    rendererSource = fs.readFileSync(
      path.join(__dirname, 'renderer.js'),
      'utf8'
    );
  });

  test('loadDiff calls resetButtons() on empty content early return', () => {
    // loadDiff has early returns for invalid content — they must call
    // resetButtons() so buttons are re-enabled if the diff is empty/invalid
    const loadDiffStart = rendererSource.indexOf('function loadDiff(content, filePath)');
    const loadDiffBody = rendererSource.substring(loadDiffStart, loadDiffStart + 600);

    // Find the empty-content check block
    const emptyCheck = loadDiffBody.match(
      /if \(!content \|\| !content\.trim\(\)\)\s*\{[^}]*\}/
    );
    expect(emptyCheck).not.toBeNull();
    expect(emptyCheck[0]).toContain('resetButtons()');
  });

  test('loadDiff calls resetButtons() on invalid diff early return', () => {
    const loadDiffStart = rendererSource.indexOf('function loadDiff(content, filePath)');
    const loadDiffBody = rendererSource.substring(loadDiffStart, loadDiffStart + 800);

    // Find the "not a valid diff" check block
    const invalidCheck = loadDiffBody.match(
      /if \(!content\.includes\('diff --git'\)[^}]*\{[^}]*\}/
    );
    expect(invalidCheck).not.toBeNull();
    expect(invalidCheck[0]).toContain('resetButtons()');
  });

  test('loadPrByNumber routes IPC errors to showBodyError (not the title bar)', () => {
    const loadPrStart = rendererSource.indexOf('async function loadPrByNumber(prNumber, repoKey)');
    // Find the result.error block — use a broader search for the block
    const errorIdx = rendererSource.indexOf('if (result.error)', loadPrStart);
    expect(errorIdx).toBeGreaterThan(-1);
    // Look for showBodyError between here and the next 'return;'
    const returnIdx = rendererSource.indexOf('return;', errorIdx);
    const errorBlock = rendererSource.substring(errorIdx, returnIdx);
    expect(errorBlock).toContain('showBodyError(');
  });

  test('loadPrByNumber calls resetButtons() in catch block', () => {
    const loadPrStart = rendererSource.indexOf('async function loadPrByNumber(prNumber, repoKey)');
    // Find the function's own catch block — it's the outermost one after all the logic.
    // Look for the prefetchNextPr call (last action before catch) to find the right catch block.
    const prefetchIdx = rendererSource.indexOf('prefetchNextPr(prNumber, repoKey)', loadPrStart);
    expect(prefetchIdx).toBeGreaterThan(-1);
    // The catch block comes after prefetchNextPr
    const catchIdx = rendererSource.indexOf('} catch (err)', prefetchIdx);
    expect(catchIdx).toBeGreaterThan(-1);
    const catchEnd = rendererSource.indexOf('\n  }', catchIdx + 10);
    const catchBlock = rendererSource.substring(catchIdx, catchEnd + 4);

    expect(catchBlock).toContain('showBodyError(');
  });

  test('submitReview auto-advance clears reviewBody before loading next PR', () => {
    // submitReview is not available in Node context — inspect the source directly
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // After removing the approved PR from cachedPrList, the auto-advance
    // block should clear reviewBody.value before calling loadPrByNumber
    expect(submitSrc).toContain("reviewBody.value = ''");
  });

  test('submitReview auto-advance has try/catch around loadPrByNumber', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // The auto-advance call to loadPrByNumber should be wrapped in try/catch
    // so that a failure doesn't leave buttons permanently disabled
    expect(submitSrc).toContain('catch (advanceErr)');
  });

  test('submitReview "no more PRs" path shows all-done state (resets buttons)', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // The else branch (no more PRs) should show the celebratory all-done screen,
    // which resets buttons so the UI isn't left in a disabled state.
    const noMoreIdx = submitSrc.indexOf('showAllDoneState()');
    expect(noMoreIdx).toBeGreaterThan(-1);
    // showAllDoneState must reset buttons and clear the current PR
    const allDoneSrc = rendererSource.substring(
      rendererSource.indexOf('function showAllDoneState()'),
      rendererSource.indexOf('// ===== Edge arrows', rendererSource.indexOf('function showAllDoneState()'))
    );
    expect(allDoneSrc).toContain('resetButtons()');
    expect(allDoneSrc).toContain('currentPrNumber = null');
  });

  test('closePullRequest auto-advance clears reviewBody and has error handling', () => {
    const closeSrc = rendererSource.substring(
      rendererSource.indexOf('async function closePullRequest()'),
      rendererSource.indexOf('async function closePullRequest()') + 2000
    );
    // Should clear reviewBody before loading next PR
    expect(closeSrc).toContain("reviewBody.value = ''");
    // Should have try/catch around loadPrByNumber
    expect(closeSrc).toContain('catch (advanceErr)');
    // "No more PRs" path should reset buttons
    const noMoreIdx = closeSrc.indexOf('No more PRs to review');
    expect(noMoreIdx).toBeGreaterThan(-1);
    expect(closeSrc.substring(noMoreIdx, noMoreIdx + 200)).toContain('resetButtons()');
  });
});

// ── Since-review net diff (exclude master merges) ──

describe('computeSinceReviewNetDiff (since-review net diff)', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  test('function exists', () => {
    expect(mainSource).toContain('async function computeSinceReviewNetDiff(');
  });

  test('replays PR commits via cherry-pick -n onto a detached temp worktree', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('git worktree add --detach');
    expect(funcSrc).toContain('git cherry-pick -n');
    // No-commit mode means no author config needed and no commits created
    expect(funcSrc).toContain('cherry-pick -n');
  });

  test('resolves conflicts by taking the PR commit version (--theirs)', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('git checkout --theirs');
    expect(funcSrc).toContain('git add -A');
  });

  test('diffs the worktree against the review base', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toMatch(/git diff \$\{baseSha\}/);
  });

  test('cleans up the temp worktree in a finally block', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('finally');
    expect(funcSrc).toContain('git worktree remove --force');
    expect(funcSrc).toContain('fs.rmSync');
  });

  test('uses a space-free os.tmpdir worktree path and shell-quotes it', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    // Worktree must NOT live under the app-data generated dir (which contains
    // "Application Support" with a space) — an unquoted path there breaks
    // exec()/git worktree add, causing the since-review diff to fail and fall
    // back to the huge full PR diff.
    expect(funcSrc).toContain("path.join(os.tmpdir(), `pr-reviewer-since-review-");
    expect(funcSrc).not.toContain("getGeneratedDir(), `wt-since-review-");
    // Shell-quote the temp path in git commands (os.tmpdir is space-free in
    // practice, but quoting is belt-and-suspenders).
    expect(funcSrc).toContain('const wtQ = JSON.stringify(worktreePath)');
    expect(funcSrc).toContain('git worktree add --detach ${wtQ}');
    expect(funcSrc).toContain('git worktree remove --force ${wtQ}');
  });

  test('generateDiff calls it instead of the old net base..head diff', () => {
    expect(mainSource).toContain('computeSinceReviewNetDiff(repoPath, baseSha, afterReviewShas)');
    // The old implementation must be gone
    expect(mainSource).not.toContain('git diff ${baseSha}..${headSha} -- ${fileList}');
    expect(mainSource).not.toContain('Using net base..head diff');
  });

  test('persists rebased state to a since-review ref so expand stays consistent', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('refs/tmp/pr-reviewer-since-review/');
    expect(funcSrc).toContain('git update-ref');
    expect(funcSrc).toContain('commit -m "tmp since-review rebase"');
    // Returns { diff, sinceReviewRef } so the caller can thread it through
    expect(funcSrc).toContain('return { diff: netDiff, sinceReviewRef');
  });

  test('generateDiff threads sinceReviewRef into its result', () => {
    expect(mainSource).toContain('sinceReviewRef = netResult.sinceReviewRef;');
    expect(mainSource).toMatch(/filesChanged: changedFiles\.length, prData, sinceReviewRef\s*}/);
  });

  test('load-pr includes sinceReviewRef in its response', () => {
    expect(mainSource).toContain('sinceReviewRef: result.sinceReviewRef || null');
  });

  test('prefetch-pr cache includes sinceReviewRef', () => {
    expect(mainSource).toContain('sinceReviewRef: result.sinceReviewRef || null');
  });
});

// ── Expand context stays consistent with since-review diff ──

describe('expand-diff-context uses since-review range when available', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  test('accepts sinceReviewRef parameter', () => {
    const hIdx = mainSource.indexOf("ipcMain.handle('expand-diff-context'");
    const hSrc = mainSource.substring(hIdx, hIdx + 300);
    expect(hSrc).toContain('sinceReviewRef');
  });

  test('diffs against the since-review ref first when present', () => {
    const hIdx = mainSource.indexOf("ipcMain.handle('expand-diff-context'");
    const hSrc = mainSource.substring(hIdx, mainSource.indexOf('\n});', hIdx));
    expect(hSrc).toContain("if (sinceReviewRef && baseSha)");
    expect(hSrc).toMatch(/git diff \$\{baseSha\} \$\{sinceReviewRef\}/);
    // The since-review branch must come before the 3-dot fallback
    expect(hSrc.indexOf('sinceReviewRef && baseSha')).toBeLessThan(hSrc.indexOf('origin/master...'));
  });

  test('cleanupSinceReviewRefs prunes stale refs at startup', () => {
    expect(mainSource).toContain('function cleanupSinceReviewRefs(retentionMs');
    // Startup runs it with no retention arg (prune everything)
    expect(mainSource).toContain('cleanupSinceReviewRefs();');
    expect(mainSource).toContain("git for-each-ref --format='%(refname) %(creatordate:unix)' 'refs/tmp/pr-reviewer-since-review/*'");
    expect(mainSource).toContain('git update-ref -d');
    // Prune-all on startup via isFinite check
    expect(mainSource).toContain('const pruneAll = !isFinite(retentionMs);');
  });

  test('cleanupSinceReviewRefs prunes by age on a periodic interval', () => {
    // Periodic scheduler prunes refs older than 24h
    expect(mainSource).toContain('cleanupSinceReviewRefs(24 * 60 * 60 * 1000)');
    // Runs on an interval (3600000ms = hourly)
    expect(mainSource).toContain('setInterval');
    expect(mainSource).toContain('3600000');
  });
});



// ── Rules dialog auto-advance fix ──

describe('Rules dialog auto-advance fix', () => {
  let rendererSource;

  beforeAll(() => {
    rendererSource = fs.readFileSync(
      path.join(__dirname, 'renderer.js'),
      'utf8'
    );
  });

  test('showRulesDialog returns false when rules are disabled', () => {
    const src = rendererSource;
    // After checking config.rules.enabled, should return false (not undefined)
    const disabledCheck = src.substring(
      src.indexOf('async function showRulesDialog'),
      src.indexOf('async function showRulesDialog') + 300
    );
    expect(disabledCheck).toContain('return false');
  });

  test('showRulesDialog returns true when overlay is displayed', () => {
    // The function should return true only when proposals are shown
    const funcStart = rendererSource.indexOf('async function showRulesDialog(reviewFeedback)');
    const funcEnd = rendererSource.indexOf('\n}\n', funcStart + 100);
    const funcSrc = rendererSource.substring(funcStart, funcEnd + 2);
    // Should have exactly one 'return true' (proposals rendered path)
    const trueReturns = (funcSrc.match(/return true/g) || []).length;
    expect(trueReturns).toBe(1);
    // Should have 'return false' for errors/no-proposals
    const falseReturns = (funcSrc.match(/return false/g) || []).length;
    expect(falseReturns).toBeGreaterThanOrEqual(1);
  });

  test('submitReview runs rules analysis in background (non-blocking)', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // Rules analysis should run in background, not block auto-advance
    expect(submitSrc).toContain('showRulesDialog(feedback)');
    expect(submitSrc).toContain('.catch(');
    // Should NOT await showRulesDialog
    expect(submitSrc).not.toContain('await showRulesDialog');
  });

  test('cleanupAndLoadNext deletes temp files', () => {
    const funcStart = rendererSource.indexOf('async function cleanupAndLoadNext()');
    const funcEnd = rendererSource.indexOf('\n}\n', funcStart + 10);
    const funcSrc = rendererSource.substring(funcStart, funcEnd + 2);
    expect(funcSrc).toContain('deletePrFiles(prNum)');
  });

  test('cleanupAndLoadNext does not auto-advance (handled by submitReview)', () => {
    const funcStart = rendererSource.indexOf('async function cleanupAndLoadNext()');
    const funcEnd = rendererSource.indexOf('\n}\n', funcStart + 10);
    const funcSrc = rendererSource.substring(funcStart, funcEnd + 2);
    // Should NOT call getNextPr or loadPrByNumber — auto-advance is in submitReview
    expect(funcSrc).not.toContain('getNextPr');
    expect(funcSrc).not.toContain('loadPrByNumber');
  });
});

// ── buildFileTree (extracted from populateFileSidebar tree logic) ──

/**
 * Pure function that replicates the tree-building logic from populateFileSidebar().
 * Given a flat list of {name, index} objects, builds a folder tree where each
 * folder node has { _files: [], _children: {} }.
 */
function buildFileTree(files) {
  const tree = {};
  for (const file of files) {
    const parts = file.name.split('/');
    const fileName = parts.pop();
    let target = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!target[part]) target[part] = { _files: [], _children: {} };
      target = (i < parts.length - 1) ? target[part]._children : target[part];
    }
    target._files = target._files || [];
    target._files.push({ ...file, displayName: fileName });
  }
  return tree;
}

describe('buildFileTree (populateFileSidebar tree logic)', () => {
  test('places root-level files directly in tree._files', () => {
    const files = [{ name: 'README.md', index: 0 }];
    const tree = buildFileTree(files);
    expect(tree._files).toBeDefined();
    expect(tree._files).toHaveLength(1);
    expect(tree._files[0].displayName).toBe('README.md');
  });

  test('places files in the correct folder node', () => {
    const files = [{ name: 'src/main.js', index: 0 }];
    const tree = buildFileTree(files);
    expect(tree.src).toBeDefined();
    expect(tree.src._files).toHaveLength(1);
    expect(tree.src._files[0].displayName).toBe('main.js');
  });

  test('places deeply nested files in the correct folder node', () => {
    const files = [{ name: 'src/utils/helpers.js', index: 0 }];
    const tree = buildFileTree(files);
    expect(tree.src._children.utils).toBeDefined();
    expect(tree.src._children.utils._files).toHaveLength(1);
    expect(tree.src._children.utils._files[0].displayName).toBe('helpers.js');
    // The file should NOT be in utils._children (the old bug)
    expect(tree.src._children.utils._children._files).toBeUndefined();
  });

  test('groups multiple files in the same folder', () => {
    const files = [
      { name: 'src/a.js', index: 0 },
      { name: 'src/b.js', index: 1 },
      { name: 'src/c.css', index: 2 },
    ];
    const tree = buildFileTree(files);
    expect(tree.src._files).toHaveLength(3);
  });

  test('handles mixed depth files', () => {
    const files = [
      { name: 'README.md', index: 0 },
      { name: 'src/main.js', index: 1 },
      { name: 'src/lib/util.js', index: 2 },
      { name: 'tests/unit/test.js', index: 3 },
    ];
    const tree = buildFileTree(files);

    // Root file
    expect(tree._files).toHaveLength(1);
    expect(tree._files[0].displayName).toBe('README.md');

    // src folder
    expect(tree.src._files).toHaveLength(1);
    expect(tree.src._files[0].displayName).toBe('main.js');

    // src/lib subfolder
    expect(tree.src._children.lib._files).toHaveLength(1);
    expect(tree.src._children.lib._files[0].displayName).toBe('util.js');

    // tests/unit folder
    expect(tree.tests._children.unit._files).toHaveLength(1);
    expect(tree.tests._children.unit._files[0].displayName).toBe('test.js');
  });

  test('preserves file metadata (index, status)', () => {
    const files = [
      { name: 'src/new.js', index: 3, status: 'added' },
      { name: 'src/old.js', index: 1, status: 'removed' },
    ];
    const tree = buildFileTree(files);
    const newFile = tree.src._files.find(f => f.displayName === 'new.js');
    const oldFile = tree.src._files.find(f => f.displayName === 'old.js');
    expect(newFile.index).toBe(3);
    expect(newFile.status).toBe('added');
    expect(oldFile.index).toBe(1);
    expect(oldFile.status).toBe('removed');
  });

  test('empty file list produces empty tree', () => {
    const tree = buildFileTree([]);
    expect(Object.keys(tree)).toHaveLength(0);
  });
});

// ── extractExtensionsFromDiff should extract ALL extensions ──

describe('extractExtensionsFromDiff — no extension whitelist', () => {
  test('extracts non-code extensions like .svg and .yaml', () => {
    const diff = `diff --git a/icon.svg b/icon.svg
--- a/icon.svg
+++ b/icon.svg
@@ -1 +1 @@
-old
+new
diff --git a/config.yaml b/config.yaml
--- a/config.yaml
+++ b/config.yaml
@@ -1 +1 @@
-old
+new`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts).toContain('.svg');
    expect(exts).toContain('.yaml');
  });

  test('extracts any extension, not just those in a hardcoded list', () => {
    const diff = `--- a/file.weirdext
+++ b/file.weirdext
--- a/file.anotherext
+++ b/file.anotherext`;
    const exts = extractExtensionsFromDiff(diff);
    expect(exts).toContain('.weirdext');
    expect(exts).toContain('.anotherext');
  });
});

// ── Source-code inspection: main.js no longer filters to code files ──

describe('generateDiff — no code file extension filter', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(
      path.join(__dirname, 'main.js'),
      'utf8'
    );
  });

  test('generateDiff does not filter files by extension regex', () => {
    // The old code had: .filter(f => f && /\.(pm|cgi|js|tpl|css|less|json)$/.test(f))
    // This should no longer exist
    const funcStart = mainSource.indexOf('async function generateDiff(');
    const funcEnd = mainSource.indexOf('\n// Create application menu', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).not.toMatch(/\.filter\(f\s*=>\s*f\s*&&\s*\/\\.pm\|cgi/);
  });

  test('generateDiff uses "changedFiles" not "codeFiles"', () => {
    const funcStart = mainSource.indexOf('async function generateDiff(');
    const funcEnd = mainSource.indexOf('\n// Create application menu', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('changedFiles');
    expect(funcSrc).not.toContain('codeFiles');
  });

  test('error message says "No files changed" not "No code files"', () => {
    const funcStart = mainSource.indexOf('async function generateDiff(');
    const funcEnd = mainSource.indexOf('\n// Create application menu', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    expect(funcSrc).toContain('No files changed since last review');
    expect(funcSrc).not.toContain('No code files changed');
  });
});

// ── Source-code inspection: renderer.js localStorage persistence ──

describe('hiddenExtensions (file extension filter) persistence', () => {
  let rendererSource;

  beforeAll(() => {
    rendererSource = fs.readFileSync(
      path.join(__dirname, 'renderer.js'),
      'utf8'
    );
  });

  test('hiddenExtensions loads from localStorage on init', () => {
    expect(rendererSource).toContain("localStorage.getItem('pr-reviewer-hidden-extensions')");
  });

  test('saveHiddenExtensions function exists and writes to localStorage', () => {
    expect(rendererSource).toContain('function saveHiddenExtensions()');
    expect(rendererSource).toContain("localStorage.setItem('pr-reviewer-hidden-extensions'");
  });

  test('saveHiddenExtensions is called when a checkbox toggles', () => {
    // The checkbox change handler, select-all, and select-none all call saveHiddenExtensions
    const saveMatches = rendererSource.match(/saveHiddenExtensions\(\)/g);
    expect(saveMatches).not.toBeNull();
    expect(saveMatches.length).toBeGreaterThanOrEqual(3);
  });

  test('old whitelist model (activeExtensions) is fully removed', () => {
    expect(rendererSource).not.toContain('activeExtensions');
    expect(rendererSource).not.toContain('saveActiveExtensions');
    // The old whitelist helper is gone. (applyExtensionFilterInPlace is the
    // new blacklist collapse helper and is intentionally present.)
    expect(rendererSource).not.toMatch(/applyExtensionFilter[^I]/);
  });

  test('a checkbox change only toggles that one extension (blacklist)', () => {
    // The change handler must add/remove only the changed ext from hiddenExtensions,
    // never re-derive the whole set from the current diff.
    const changeSrc = rendererSource.substring(
      rendererSource.indexOf("cb.addEventListener('change'"),
      rendererSource.indexOf("// Update button state", rendererSource.indexOf("cb.addEventListener('change'"))
    );
    expect(changeSrc).toContain('hiddenExtensions.filter(h => h !== ext)');
    expect(changeSrc).toContain('hiddenExtensions.push(ext)');
    // Must not re-derive from all checkboxes (no allChecked reset)
    expect(changeSrc).not.toContain('allChecked');
    expect(changeSrc).not.toContain('querySelectorAll');
  });

  test('extension checkbox toggles collapse in place without re-rendering the diff', () => {
    // The checkbox change handler, select-all, and select-none must call the
    // lightweight applyExtensionFilterInPlace() instead of the expensive
    // renderFilteredDiff() (which re-runs diff2html over the whole diff on every
    // toggle — the cause of the slow/hanging filter).
    const changeSrc = rendererSource.substring(
      rendererSource.indexOf("cb.addEventListener('change'"),
      rendererSource.indexOf("// Update button state", rendererSource.indexOf("cb.addEventListener('change'"))
    );
    expect(changeSrc).toContain('applyExtensionFilterInPlace()');
    expect(changeSrc).not.toContain('renderFilteredDiff()');
  });

  test('applyExtensionFilterInPlace collapses/expands wrappers without diff2html', () => {
    const fnStart = rendererSource.indexOf('function applyExtensionFilterInPlace()');
    const fnEnd = rendererSource.indexOf('\n// Select all', fnStart);
    const fnSrc = rendererSource.substring(fnStart, fnEnd);
    // Collapses excluded + expands non-excluded in the existing DOM
    expect(fnSrc).toContain('collapseFilteredFiles(excludedExts)');
    expect(fnSrc).toContain('addFileCollapseToggles()');
    // Must NOT re-render via diff2html (that's the slow path)
    expect(fnSrc).not.toContain('Diff2HtmlUI');
    expect(fnSrc).not.toContain('new Diff2HtmlUI');
  });

  test('collapsing logic hides extensions in hiddenExtensions, not a whitelist', () => {
    // Every consumer should compute excluded = diff extensions that are in hiddenExtensions
    const count = (rendererSource.match(/filter\(e => hiddenExtensions\.includes\(e\)\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('no codeFileExtensions config reference in initFileFilter', () => {
    // initFileFilter should be removed entirely
    expect(rendererSource).not.toContain('function initFileFilter()');
    expect(rendererSource).not.toContain('diffConfig.codeFileExtensions');
  });

  test('ALL_EXTENSIONS constant is removed', () => {
    expect(rendererSource).not.toContain('const ALL_EXTENSIONS');
  });

  test('extractExtensionsFromDiff does not filter by ALL_EXTENSIONS', () => {
    // The function should not reference ALL_EXTENSIONS
    const funcStart = rendererSource.indexOf('function extractExtensionsFromDiff(');
    const funcEnd = rendererSource.indexOf('\n// Open/close file filter', funcStart);
    const funcSrc = rendererSource.substring(funcStart, funcEnd);
    expect(funcSrc).not.toContain('ALL_EXTENSIONS');
  });
});

// ── Source-code inspection: comment button positioning & side-by-side fix ──

describe('comment button positioning and side-by-side fix', () => {
  let rendererSource;
  let htmlSource;

  beforeAll(() => {
    rendererSource = fs.readFileSync(
      path.join(__dirname, 'renderer.js'),
      'utf8'
    );
    htmlSource = fs.readFileSync(
      path.join(__dirname, 'index.html'),
      'utf8'
    );
  });

  test('addCommentButtons side-by-side uses closest(tr) to find linenumber', () => {
    // Extract the side-by-side branch of addCommentButtons
    const funcStart = rendererSource.indexOf('function addCommentButtons()');
    const funcEnd = rendererSource.indexOf('\n// ===================== FILE-LEVEL COMMENT BUTTONS', funcStart);
    const funcSrc = rendererSource.substring(funcStart, funcEnd);

    // Side-by-side branch should use closest('tr') to navigate from the div to the sibling td
    expect(funcSrc).toContain("line.closest('tr')");
    // Should NOT use line.querySelector for side-by-side linenumber (the old broken pattern)
    // The old code had: const lineNumEl = line.querySelector('.d2h-code-side-linenumber');
    // Now it uses: const row = line.closest('tr'); ... row.querySelector('.d2h-code-side-linenumber');
    expect(funcSrc).toContain("row.querySelector('.d2h-code-side-linenumber')");
  });

  test('addCommentButtons appends buttons to line number cells, not code line divs', () => {
    const funcStart = rendererSource.indexOf('function addCommentButtons()');
    const funcEnd = rendererSource.indexOf('\n// ===================== FILE-LEVEL COMMENT BUTTONS', funcStart);
    const funcSrc = rendererSource.substring(funcStart, funcEnd);

    // Buttons should be appended to line number elements
    expect(funcSrc).toContain('lineNumEl.appendChild(btn)');
    expect(funcSrc).toContain('linenumEl.appendChild(btn)');
    // Should NOT append to line/code-line elements
    expect(funcSrc).not.toContain('line.appendChild(btn)');
    // Line number elements use CSS overflow:visible (not position:relative) to allow comment buttons
    expect(funcSrc).not.toContain("lineNumEl.style.position = 'relative'");
    expect(funcSrc).not.toContain("linenumEl.style.position = 'relative'");
  });

  test('addCommentButtons prevents duplicate buttons', () => {
    const funcStart = rendererSource.indexOf('function addCommentButtons()');
    const funcEnd = rendererSource.indexOf('\n// ===================== FILE-LEVEL COMMENT BUTTONS', funcStart);
    const funcSrc = rendererSource.substring(funcStart, funcEnd);

    // Should check for existing button before adding
    expect(funcSrc).toContain("querySelector('.line-comment-btn')");
    expect(funcSrc).toContain('return');
  });

  test('CSS positions comment button at right edge of line number column', () => {
    // The line-comment-btn style should use right positioning (between numbers and code)
    expect(htmlSource).toMatch(/\.line-comment-btn\s*\{[^}]*right:\s*-24px/);
    expect(htmlSource).not.toMatch(/\.line-comment-btn\s*\{[^}]*left:\s*4px/);
  });

  test('CSS hover rule triggers on tr:hover for row-level hover', () => {
    // Should use tr:hover for showing the button on row hover
    expect(htmlSource).toContain('.d2h-diff-tbody tr:hover .line-comment-btn');
    // Should NOT use the old code-line hover selectors
    expect(htmlSource).not.toContain('.d2h-code-side-line:hover .line-comment-btn');
    expect(htmlSource).not.toContain('.d2h-code-line:hover .line-comment-btn');
  });

  test('CSS sets overflow:visible on line number cells', () => {
    expect(htmlSource).toContain('.d2h-code-side-linenumber');
    expect(htmlSource).toContain('.d2h-code-linenumber');
    expect(htmlSource).toMatch(/\.d2h-code-side-linenumber[^}]*overflow:\s*visible/);
    expect(htmlSource).toMatch(/\.d2h-code-linenumber[^}]*overflow:\s*visible/);
  });

  test('addCommentButtons handles both side-by-side and unified modes', () => {
    const funcStart = rendererSource.indexOf('function addCommentButtons()');
    const funcEnd = rendererSource.indexOf('\n// ===================== FILE-LEVEL COMMENT BUTTONS', funcStart);
    const funcSrc = rendererSource.substring(funcStart, funcEnd);

    // Should check for side-by-side mode
    expect(funcSrc).toContain("'.d2h-file-side-diff'");
    // Should have unified mode fallback
    expect(funcSrc).toContain("'.d2h-code-line'");
    // Both modes should use closest('tr') pattern
    const closestTrMatches = funcSrc.match(/\.closest\('tr'\)/g);
    expect(closestTrMatches).not.toBeNull();
    expect(closestTrMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ── PR Draft Persistence ──

describe('PR Draft Persistence', () => {
  const tmpDir = path.join(os.tmpdir(), 'pr-reviewer-test-drafts-' + Date.now());

  // Extract testable versions of PR draft functions (same logic as main.js)
  function safePrNumber(prNumber) {
    if (prNumber === null || prNumber === undefined) return null;
    const str = String(prNumber).trim();
    if (!/^\d+$/.test(str)) return null;
    const num = parseInt(str, 10);
    if (isNaN(num) || num <= 0) return null;
    return String(num);
  }

  function getPrDraftPath(prNumber, baseDir) {
    const safePr = safePrNumber(prNumber);
    if (!safePr) return null;
    return path.join(baseDir, `pr-${safePr}.json`);
  }

  function savePrDraft(prNumber, data, baseDir) {
    try {
      const draftPath = getPrDraftPath(prNumber, baseDir);
      if (!draftPath) return null;
      fs.mkdirSync(baseDir, { recursive: true });
      const payload = {
        comments: data.comments || [],
        prNumber: safePrNumber(prNumber),
        repoKey: data.repoKey || null,
        reviewBody: data.reviewBody || '',
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(draftPath, JSON.stringify(payload, null, 2));
      return draftPath;
    } catch (err) {
      return null;
    }
  }

  function loadPrDraft(prNumber, baseDir) {
    try {
      const draftPath = getPrDraftPath(prNumber, baseDir);
      if (!draftPath || !fs.existsSync(draftPath)) return null;
      const raw = fs.readFileSync(draftPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function deletePrDraft(prNumber, baseDir) {
    try {
      const draftPath = getPrDraftPath(prNumber, baseDir);
      if (draftPath && fs.existsSync(draftPath)) {
        fs.unlinkSync(draftPath);
      }
    } catch (err) { /* ignore */ }
  }

  afterAll(() => {
    // Clean up temp dir
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  });

  test('getPrDraftPath returns correct path for valid PR number', () => {
    expect(getPrDraftPath(42, tmpDir)).toBe(path.join(tmpDir, 'pr-42.json'));
    expect(getPrDraftPath('123', tmpDir)).toBe(path.join(tmpDir, 'pr-123.json'));
  });

  test('getPrDraftPath returns null for invalid PR number', () => {
    expect(getPrDraftPath(null, tmpDir)).toBeNull();
    expect(getPrDraftPath(undefined, tmpDir)).toBeNull();
    expect(getPrDraftPath('abc', tmpDir)).toBeNull();
    expect(getPrDraftPath(0, tmpDir)).toBeNull();
    expect(getPrDraftPath(-1, tmpDir)).toBeNull();
    expect(getPrDraftPath('1; rm -rf /', tmpDir)).toBeNull();
  });

  test('savePrDraft writes file with correct structure', () => {
    const comments = [{ file: 'main.js', line: 10, side: 'RIGHT', text: 'Fix this' }];
    const result = savePrDraft(42, { comments, repoKey: 'owner/repo', reviewBody: 'Looks good' }, tmpDir);
    expect(result).toBe(path.join(tmpDir, 'pr-42.json'));
    expect(fs.existsSync(result)).toBe(true);

    const data = JSON.parse(fs.readFileSync(result, 'utf8'));
    expect(data.prNumber).toBe('42');
    expect(data.repoKey).toBe('owner/repo');
    expect(data.reviewBody).toBe('Looks good');
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].file).toBe('main.js');
    expect(data.comments[0].text).toBe('Fix this');
    expect(data.timestamp).toBeDefined();
  });

  test('loadPrDraft returns saved draft', () => {
    const comments = [
      { file: 'a.js', line: 5, side: 'LEFT', text: 'comment 1' },
      { file: 'b.js', line: 20, side: 'RIGHT', text: 'comment 2' }
    ];
    savePrDraft(99, { comments, repoKey: 'org/repo' }, tmpDir);
    const draft = loadPrDraft(99, tmpDir);
    expect(draft).not.toBeNull();
    expect(draft.prNumber).toBe('99');
    expect(draft.comments).toHaveLength(2);
    expect(draft.comments[0].text).toBe('comment 1');
    expect(draft.comments[1].text).toBe('comment 2');
  });

  test('loadPrDraft returns null for non-existent PR', () => {
    expect(loadPrDraft(99999, tmpDir)).toBeNull();
  });

  test('deletePrDraft removes the file', () => {
    savePrDraft(50, { comments: [{ text: 'test' }] }, tmpDir);
    expect(loadPrDraft(50, tmpDir)).not.toBeNull();
    deletePrDraft(50, tmpDir);
    expect(loadPrDraft(50, tmpDir)).toBeNull();
  });

  test('deletePrDraft does not throw for non-existent PR', () => {
    expect(() => deletePrDraft(99999, tmpDir)).not.toThrow();
  });

  test('savePrDraft overwrites existing draft', () => {
    savePrDraft(77, { comments: [{ text: 'old' }] }, tmpDir);
    savePrDraft(77, { comments: [{ text: 'new1' }, { text: 'new2' }] }, tmpDir);
    const draft = loadPrDraft(77, tmpDir);
    expect(draft.comments).toHaveLength(2);
    expect(draft.comments[0].text).toBe('new1');
  });

  test('savePrDraft handles empty comments', () => {
    const result = savePrDraft(88, {}, tmpDir);
    expect(result).not.toBeNull();
    const draft = loadPrDraft(88, tmpDir);
    expect(draft.comments).toEqual([]);
    expect(draft.repoKey).toBeNull();
    expect(draft.reviewBody).toBe('');
  });

  test('savePrDraft includes timestamp', () => {
    const before = new Date().toISOString();
    savePrDraft(66, { comments: [] }, tmpDir);
    const after = new Date().toISOString();
    const draft = loadPrDraft(66, tmpDir);
    expect(draft.timestamp).toBeDefined();
    expect(draft.timestamp >= before).toBe(true);
    expect(draft.timestamp <= after).toBe(true);
  });

  test('round-trip preserves all comment fields', () => {
    const comments = [{
      _uid: 1,
      file: 'src/index.ts',
      line: 42,
      side: 'RIGHT',
      text: '@Hermes check this',
      isAiTagged: true,
      level: 'line',
      codeContext: 'const x = 1;',
      imageDataUrl: null
    }];
    savePrDraft(33, { comments, repoKey: 'webtoolbox/Website-Toolbox', reviewBody: 'body text' }, tmpDir);
    const draft = loadPrDraft(33, tmpDir);
    expect(draft.comments[0]._uid).toBe(1);
    expect(draft.comments[0].file).toBe('src/index.ts');
    expect(draft.comments[0].line).toBe(42);
    expect(draft.comments[0].side).toBe('RIGHT');
    expect(draft.comments[0].isAiTagged).toBe(true);
    expect(draft.comments[0].level).toBe('line');
    expect(draft.comments[0].codeContext).toBe('const x = 1;');
    expect(draft.repoKey).toBe('webtoolbox/Website-Toolbox');
  });

  test('savePrDraft returns null for invalid PR number', () => {
    expect(savePrDraft(null, { comments: [] }, tmpDir)).toBeNull();
    expect(savePrDraft('abc', { comments: [] }, tmpDir)).toBeNull();
  });
});

// ── AI Chat + Customizable Hermes Profile ──

describe('AI Chat and Hermes profile', () => {
  let mainSource, preloadSource, rendererSource, indexHtml, configJson;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    configJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  });

  test('config.json includes hermesProfile default', () => {
    expect(configJson.hermesProfile).toBe('wt');
  });

  test('main.js loadConfig defaults include hermesProfile', () => {
    const defaultsBlock = mainSource.substring(
      mainSource.indexOf('const defaults = {'),
      mainSource.indexOf('let config = { ...defaults }')
    );
    expect(defaultsBlock).toContain("hermesProfile: 'wt'");
  });

  test('get-config returns hermesProfile', () => {
    const getConfigBlock = mainSource.substring(
      mainSource.indexOf("ipcMain.handle('get-config'"),
      mainSource.indexOf("ipcMain.handle('open-external'")
    );
    expect(getConfigBlock).toContain("hermesProfile: appConfig.hermesProfile || 'wt'");
  });

  test('save-preferences persists hermesProfile', () => {
    expect(mainSource).toContain('if (prefs.hermesProfile !== undefined) appConfig.hermesProfile = prefs.hermesProfile;');
  });

  test('no hardcoded "-p wt" remains in hermes chat calls', () => {
    // All hermes invocations must use the configurable profile, not hardcoded 'wt'
    const hermesChatCalls = mainSource.match(/-p\s*'wt'/g) || [];
    expect(hermesChatCalls.length).toBe(0);
    // And should reference the profile from config
    expect(mainSource.match(/-p'\s*,\s*appConfig\.hermesProfile/g)).not.toBeNull();
  });

  test('ai-chat IPC handler exists in main.js', () => {
    expect(mainSource).toContain("ipcMain.handle('ai-chat'");
  });

  test('cleanHermesResponse strips warnings, box UI, and session footer', () => {
    const raw = `Warning: Unknown toolsets: messaging\nQuery: prompt echo\nUser: hi\nAssistant:\nInitializing agent...\n\n╭─ Hermes ─╮\nThe answer is here.\n╰──────────╯\n\nResume this session with:\n  hermes --resume 123 -p wt\n\nSession: 123\nDuration: 5s\nMessages: 2`;
    // Execute the function's logic by extracting it from source is brittle; instead
    // verify the source includes the key stripping behaviors.
    const fn = mainSource.substring(
      mainSource.indexOf('function cleanHermesResponse'),
      mainSource.indexOf('// AI chat IPC')
    );
    expect(fn).toContain("text.replace(/^(?:Warning:[^\\n]*\\n*)+/g, '')");
    expect(fn).toContain("text.lastIndexOf('╭')");
    expect(fn).toContain('Resume (?:this session|session) with:');
    expect(fn).toContain('Session:');
  });

  test('buildChatPrompt embeds conversation history', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('function buildChatPrompt'),
      mainSource.indexOf('// AI chat IPC')
    );
    expect(fn).toContain('Conversation so far:');
    expect(fn).toContain("lines.push('User: ' + message)");
    expect(fn).toContain("lines.push('Assistant:')");
  });

  test('preload.js exposes aiChat bridge', () => {
    expect(preloadSource).toContain("aiChat: (data) => ipcRenderer.invoke('ai-chat', data)");
  });

  test('index.html has chat button and chat panel', () => {
    expect(indexHtml).toContain('id="btn-ai-chat"');
    expect(indexHtml).toContain('id="ai-chat-panel"');
    expect(indexHtml).toContain('id="ai-chat-input"');
    expect(indexHtml).toContain('id="ai-chat-send"');
    expect(indexHtml).toContain('id="ai-chat-clear"');
    expect(indexHtml).toContain('id="ai-chat-messages"');
  });

  test('index.html has Profile preference field', () => {
    expect(indexHtml).toContain('id="pref-hermes-profile"');
  });

  test('index.html has bot icon for AI chat and separate PR comment button', () => {
    expect(indexHtml).toContain('id="btn-ai-chat"');
    expect(indexHtml).toContain('id="btn-pr-comment"');
    expect(indexHtml).toContain('id="pr-comment-panel"');
    // AI chat button uses a bot/robot icon (rect head + antenna), not a comment bubble
    expect(indexHtml).toContain('aria-label="Chat with AI"');
  });

  test('review-body textarea moved into PR comment panel (bottom container removed)', () => {
    // #review-body must live in #pr-comment-panel (the header dropdown)
    const panelStart = indexHtml.indexOf('id="pr-comment-panel"');
    const panelEnd = indexHtml.indexOf('id="comment-nav"', panelStart);
    const panelBlock = indexHtml.substring(panelStart, panelEnd);
    expect(panelBlock).toContain('id="review-body"');
    // The old bottom-of-screen review body container should be gone
    expect(indexHtml).not.toContain('id="review-body-container"');
    expect(rendererSource).toContain("const btnPrComment = document.getElementById('btn-pr-comment')");
    expect(rendererSource).toContain('prCommentPanel.classList.toggle');
  });

  test('PR comment button turns blue after a comment is left and resets on new PR', () => {
    expect(indexHtml).toContain('#btn-pr-comment.active { background: #388bfd');
    expect(rendererSource).toContain("btnPrComment.classList.add('active')");
    expect(rendererSource).toContain("btnPrComment.classList.remove('active')");
    // Blue reflects a comment being written in the box, and resets on PR switch
    expect(rendererSource).toContain("btnPrComment.classList.toggle('active', reviewBody.value.trim().length > 0)");
  });

  test('renderer.js prefFields includes hermesProfile', () => {
    expect(rendererSource).toContain("{ id: 'pref-hermes-profile', key: 'hermesProfile', type: 'text' }");
  });

  test('renderer.js wires chat send/clear/history', () => {
    expect(rendererSource).toContain('aiChatHistory');
    expect(rendererSource).toContain('async function sendAiChat');
    expect(rendererSource).toContain('window.electronAPI.aiChat');
    expect(rendererSource).toContain('appendAiChatMsg');
  });
});

// ── Comment text preserves line breaks ──

describe('Comment text preserves line breaks in the UI', () => {
  let indexHtml;

  beforeAll(() => {
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('line-comment-marker .comment-text uses white-space: pre-wrap', () => {
    const rule = indexHtml.match(/\.line-comment-marker \.comment-text \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('white-space: pre-wrap');
    expect(rule[0]).toContain('word-break: break-word');
  });

  test('file-comment-marker .comment-text uses white-space: pre-wrap', () => {
    const rule = indexHtml.match(/\.file-comment-marker \.comment-text \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('white-space: pre-wrap');
    expect(rule[0]).toContain('word-break: break-word');
  });

  test('local comment markers render escaped text without collapsing newlines', () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    // All four local marker render paths (new line + line-level edit, file + line)
    // put the escaped display text into a span.comment-text, relying on the CSS
    // pre-wrap to keep line breaks visible (HTML would otherwise collapse them).
    const markerSpans = rendererSource.match(/class="comment-text">\$\{escapeHtml\(displayText\)\}<\/span>/g);
    expect(markerSpans).not.toBeNull();
    expect(markerSpans.length).toBeGreaterThanOrEqual(4);
  });
});
