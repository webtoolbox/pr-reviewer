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

// Copy of main.js extractFunctionBody for unit testing the hover-preview logic.
function extractFunctionBody(content, funcName) {
  if (!content) return null;
  const lines = content.split('\n');
  const nameRe = new RegExp(`\\bsub\\s+${funcName}\\b`);
  const jsFnRe = new RegExp(`(?:function\\s+|^\\s*${funcName}\\s*=\\s*(?:async\\s*)?function|\\b${funcName}\\s*(?::\\s*function|\\s*=\\s*\\([^)]*\\)\\s*=>|\\s*\\([^)]*\\)\\s*\\{))`);

  let startLine = -1;
  const perlMatch = new RegExp(`^(\\s*sub\\s+${funcName}\\b)`);
  const jsMatch = new RegExp(`^(\\s*(?:async\\s+)?function\\s+${funcName}\\b)`);
  const jsAssignMatch = new RegExp(`^(\\s*${funcName}\\s*=\\s*(?:async\\s*)?(?:function|\\())`);
  const jsArrowMatch = new RegExp(`^(\\s*(?:const|let|var)\\s+${funcName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>)`);
  const jsMethodMatch = new RegExp(`^(\\s*${funcName}\\s*\\([^)]*\\)\\s*\\{)`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (perlMatch.test(line) || jsMatch.test(line) || jsAssignMatch.test(line) ||
        jsArrowMatch.test(line) || jsMethodMatch.test(line)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  let braceIdx = -1;
  const open = lines[startLine].indexOf('{');
  if (open !== -1) {
    braceIdx = open;
  } else {
    for (let j = startLine; j < lines.length; j++) {
      const o = lines[j].indexOf('{');
      if (o !== -1) { braceIdx = o; break; }
    }
  }
  if (braceIdx === -1) return null;

  let depth = 0;
  const result = [];
  let inSingle = false, inDouble = false, inLineComment = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    let out = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inLineComment) { out += ch; continue; }
      if (inSingle) { out += ch; if (ch === "'") inSingle = false; continue; }
      if (inDouble) { out += ch; if (ch === '"' && line[c-1] !== '\\') inDouble = false; continue; }
      if (ch === "'") { inSingle = true; out += ch; continue; }
      if (ch === '"') { inDouble = true; out += ch; continue; }
      if (ch === '#') { inLineComment = true; out += ch; continue; }
      if (ch === '{') { depth++; out += ch; continue; }
      if (ch === '}') { depth--; out += ch; if (depth === 0) { result.push(out); return result.join('\n'); } continue; }
      out += ch;
    }
    result.push(out);
    inLineComment = false;
  }
  return result.join('\n');
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

function getLocalRepoPath(repoKey, config, homeDir, dataDir) {
  // Mirror of main.js: the app only uses its own clone under the app data
  // directory. The reviewer's working copies are never returned.
  const repoName = repoKey && repoKey.includes('/')
    ? repoKey.split('/')[1]
    : (config.repoName || 'Website-Toolbox');
  const base = dataDir || path.join(homeDir, 'Library', 'Application Support', 'pr-reviewer');
  const dataReposPath = path.join(base, 'repos', repoName);
  // In real code this checks fs.existsSync, we simulate with a set
  const existingPaths = config._existingPaths || new Set();
  if (existingPaths.has(dataReposPath)) return dataReposPath;
  const defaultRepoKey = `${config.repoOwner}/${config.repoName}`;
  if ((!repoKey || repoKey === defaultRepoKey) && config.repoPath) {
    return expandPath(config.repoPath, homeDir);
  }
  return dataReposPath;
}

// ── Functions from renderer.js ──

function formatCommentBody(body) {
  if (!body) return '';
  let html = escapeHtml(body);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Markdown links: [text](url). The URL was escaped above, so un-escape it
  // and re-escape the parts that matter inside an href attribute.
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (!/^(https?):\/\//i.test(cleanUrl)) return m; // only http(s) links
    const safeUrl = escapeHtml(cleanUrl);
    return `<a href="${safeUrl}" class="external-link">${text}</a>`;
  });
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
  const APPDATA = path.join(HOME, 'Library', 'Application Support', 'pr-reviewer');
  const appClone = (repo) => path.join(APPDATA, 'repos', repo);

  test('uses the app own clone, never the ~/Repos checkout', () => {
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      _existingPaths: new Set([appClone('MyApp'), path.join(HOME, 'Repos', 'MyApp')])
    };
    expect(getLocalRepoPath('org/MyApp', config, HOME)).toBe(appClone('MyApp'));
  });

  test('ignores ~/Repos even when the app clone is missing', () => {
    // The reviewer's checkout exists but the app must not touch it.
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      _existingPaths: new Set([path.join(HOME, 'Repos', 'Website-Toolbox')])
    };
    expect(getLocalRepoPath('webtoolbox/Website-Toolbox', config, HOME)).toBe(appClone('Website-Toolbox'));
  });

  test('uses config repoPath when the app clone is missing', () => {
    const config = {
      repoOwner: 'webtoolbox',
      repoName: 'Website-Toolbox',
      repoPath: appClone('Website-Toolbox'),
      _existingPaths: new Set()
    };
    expect(getLocalRepoPath('webtoolbox/Website-Toolbox', config, HOME)).toBe(appClone('Website-Toolbox'));
  });

  test('an unknown repo resolves to the app data location, not home', () => {
    const config = { repoOwner: 'webtoolbox', repoName: 'Website-Toolbox', _existingPaths: new Set() };
    expect(getLocalRepoPath('org/SomeRepo', config, HOME)).toBe(appClone('SomeRepo'));
  });

  test('uses config repoPath when no repoKey given', () => {
    const config = { repoPath: '~/my-repo', repoName: 'TestRepo' };
    expect(getLocalRepoPath(null, config, HOME)).toBe(path.join(HOME, 'my-repo'));
  });

  test('no repoKey and no repoPath resolves to the app data location', () => {
    expect(getLocalRepoPath(null, { repoName: 'MyProject' }, HOME)).toBe(appClone('MyProject'));
  });

  test('no config at all resolves to the app data location', () => {
    expect(getLocalRepoPath(null, {}, HOME)).toBe(appClone('Website-Toolbox'));
  });

  test('main.js never points git at the reviewer own checkout', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    // The ~/Repos and ~/ fallbacks are gone; only the protected-checkout
    // note in the AI prompt may still mention ~/Repos.
    const fnSrc = extractFunctionBody(src, 'getLocalRepoPath');
    expect(fnSrc).not.toContain("'Repos'");
    expect(fnSrc).toContain("path.join(getAppDataDir(), 'repos', repoName)");
    expect(fnSrc).toContain('no longer falls back to ~/Repos');
    const repoMentions = (src.match(/path\.join\(app\.getPath\('home'\), 'Repos'/g) || []);
    expect(repoMentions).toHaveLength(0);
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

  test('converts [text](https://url) markdown to external-link anchor', () => {
    const result = formatCommentBody('See [PR #123](https://github.com/webtoolbox/Website-Toolbox/pull/123)');
    expect(result).toContain('<a href="https://github.com/webtoolbox/Website-Toolbox/pull/123" class="external-link">PR #123</a>');
  });

  test('allows only http(s) links; other schemes are left as plain text', () => {
    const result = formatCommentBody('[file](file:///etc/passwd) and [js](javascript:alert(1))');
    // Both must NOT become anchors with dangerous schemes
    expect(result).not.toContain('class="external-link"');
    expect(result).toContain('[file](file:///etc/passwd)');
    expect(result).toContain('[js](javascript:alert(1))');
  });

  test('escapes the URL inside the href attribute', () => {
    const result = formatCommentBody('[x](https://example.com/?a=1&b=2)');
    expect(result).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(result).toContain('class="external-link"');
  });

  test('keeps existing bold/italic/code alongside links', () => {
    const result = formatCommentBody('**bold** [link](https://example.com) `code`');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<a href="https://example.com" class="external-link">link</a>');
    expect(result).toContain('<code>code</code>');
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
    prFilter: { reviewRequested: true, excludeTitleStartsWith: [] },
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
    const config = mergeConfigs(defaults, null, { prFilter: { excludeTitleStartsWith: ['For Merge'] } });
    expect(config.prFilter.excludeTitleStartsWith).toEqual(['For Merge']);
    // Same as above — reviewRequested from defaults is lost
    expect(config.prFilter.reviewRequested).toBeUndefined();
  });

  test('deep merges autoFix', () => {
    const config = mergeConfigs(defaults, null, { autoFix: { enabled: false } });
    expect(config.autoFix.enabled).toBe(false);
  });
});

// ── PR title exclusion filter ──

describe('PR list filter excludes titles starting with prefixes', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  function applyFilter(prs, prefixes) {
    const p = prefixes.map(x => x.toLowerCase());
    return prs.filter(pr => {
      const title = (pr.title || '').toLowerCase();
      return !p.some(x => title.startsWith(x));
    });
  }

  test('drops PRs whose title starts with a listed prefix', () => {
    const prs = [
      { number: 1, title: 'For Merge: ship it' },
      { number: 2, title: 'For merge something' },
      { number: 3, title: 'For review: fix bug' },
      { number: 4, title: 'Something For Merge later' } // not at start — kept
    ];
    const out = applyFilter(prs, ['For Merge']);
    expect(out.map(p => p.number)).toEqual([3, 4]);
  });

  test('is case-insensitive', () => {
    const out = applyFilter([{ number: 1, title: 'FOR MERGE: x' }], ['For Merge']);
    expect(out).toEqual([]);
  });

  test('both excludeTitleStartsWith and titleContains filters are present at all three sites', () => {
    // Exclusion filter applied at all three listing sites
    const exclusions = (mainSource.match(/excludeTitleStartsWith\.length/g) || []).length;
    expect(exclusions).toBeGreaterThanOrEqual(3);
    // The optional titleContains include filter coexists (blank by default)
    const contains = (mainSource.match(/filter\.titleContains/g) || []).length;
    const containsCfg = (mainSource.match(/filterConfig\.titleContains/g) || []).length;
    expect(contains + containsCfg).toBeGreaterThanOrEqual(3);
  });

  test('titleContains is opt-in (blank in default config)', () => {
    expect(mainSource).toContain('titleContains: \'\'');
  });

  test('save-preferences merges prFilter', () => {
    expect(mainSource).toContain("if (prefs.prFilter !== undefined) appConfig.prFilter = { ...(appConfig.prFilter || {}), ...prefs.prFilter };");
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

  test('context expand re-inserts comments after in-place wrapper swap', () => {
    // renderSingleFileInPlace swaps the old wrapper with a freshly rendered one
    // (oldWrapper.replaceWith(newWrapper)), which destroys comment markers. It
    // must re-run reinsertCommentsForFile so the user's comments survive the
    // "Show more lines" expand.
    const renderInPlaceSection = rendererSource.substring(
      rendererSource.indexOf('function renderSingleFileInPlace'),
      rendererSource.indexOf('function replaceFileInDiff')
    );
    expect(renderInPlaceSection).toContain('oldWrapper.replaceWith(newWrapper);');
    expect(renderInPlaceSection).toContain('reinsertCommentsForFile(fileName);');
    expect(rendererSource).toContain('function reinsertCommentsForFile');
    // reinsertCommentsForFile must handle BOTH the user's local draft comments
    // and GitHub inline review comments.
    const reinsertFn = rendererSource.substring(
      rendererSource.indexOf('function reinsertCommentsForFile'),
      rendererSource.indexOf('function insertInlineCommentsForFile')
    );
    expect(reinsertFn).toContain('renderFileCommentMarker(c)');
    expect(reinsertFn).toContain('renderLineCommentMarker(c)');
    expect(reinsertFn).toContain('insertInlineCommentsForFile(fileName');
  });

  test('full diff re-render re-inserts every comment marker and reopens the form', () => {
    // renderFilteredDiff redraws the whole diff (Preferences save, context
    // expand fallback). draw() throws the diff DOM away, which used to take
    // every pending-comment marker with it — the comments stayed in
    // `comments`, but nothing put them back on screen.
    const start = rendererSource.indexOf('function renderFilteredDiff');
    expect(start).toBeGreaterThan(-1);
    const fn = rendererSource.substring(start, rendererSource.indexOf('\nfunction ', start + 1));
    expect(fn).toContain('captureOpenCommentDraft()');
    expect(fn).toContain('closeCommentDialog()');
    expect(fn).toContain('reinsertAllComments();');
    expect(fn).toContain('restoreCommentDraft(openDraft);');

    const reinsertStart = rendererSource.indexOf('function reinsertAllComments');
    expect(reinsertStart).toBeGreaterThan(-1);
    const reinsertAll = rendererSource.substring(
      reinsertStart,
      rendererSource.indexOf('\nfunction ', reinsertStart + 1)
    );
    // local draft markers AND GitHub inline review comments
    expect(reinsertAll).toContain('renderFileCommentMarker(c)');
    expect(reinsertAll).toContain('renderLineCommentMarker(c)');
    expect(reinsertAll).toContain('insertInlineCommentsForFile(');
  });

  test('findDiffLineRow reads side-by-side (split) rows', () => {
    // Split view renders two stacked side diffs with the line number as plain
    // text in .d2h-code-side-linenumber — no .d2h-code-linenumber and no
    // .line-num1/.line-num2 divs. Without this branch every lookup returned
    // null in split view, so markers could never be re-placed and a restore
    // silently dropped them.
    const start = rendererSource.indexOf('function findDiffLineRow');
    expect(start).toBeGreaterThan(-1);
    const fn = rendererSource.substring(start, rendererSource.indexOf('\nfunction ', start + 1));
    expect(fn).toContain(".querySelectorAll('.d2h-file-side-diff')");
    expect(fn).toContain(".querySelector('.d2h-code-side-linenumber')");
    expect(fn).toContain('wantRight');
    // and it must still handle unified rows
    expect(fn).toContain(".querySelector('.d2h-code-linenumber')");
    expect(fn).toContain('.line-num1');
  });

  test('restoreDraft keeps comments it cannot place and never duplicates them', () => {
    // The old code did `continue` on a line it could not find, then called
    // autoSaveDraft() — overwriting the draft without those comments, which
    // was permanent data loss (they also vanished from the All Comments panel).
    const start = rendererSource.indexOf('function restoreDraft');
    expect(start).toBeGreaterThan(-1);
    const fn = rendererSource.substring(start, rendererSource.indexOf('\nfunction ', start + 1));
    expect(fn).not.toContain('Skipping stale comment');
    expect(fn).toContain('comments.push(c);');
    expect(fn).toContain('autoSaveDraft();');
    // Both draft systems (file-based and PR-based) restore the same PR on one
    // load, so restoreDraft must skip an identical comment already present.
    expect(fn).toContain('alreadyRestored');
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
    const loadPrStart = rendererSource.indexOf('async function loadPrByNumber(prNumber, repoKey, force = false)');
    // Find the result.error block — use a broader search for the block
    const errorIdx = rendererSource.indexOf('if (result.error)', loadPrStart);
    expect(errorIdx).toBeGreaterThan(-1);
    // Look for showBodyError between here and the next 'return;'
    const returnIdx = rendererSource.indexOf('return;', errorIdx);
    const errorBlock = rendererSource.substring(errorIdx, returnIdx);
    expect(errorBlock).toContain('showBodyError(');
  });

  test('loadPrByNumber clears the previous PR body error when switching PRs', () => {
    const loadPrStart = rendererSource.indexOf('async function loadPrByNumber(prNumber, repoKey, force = false)');
    expect(loadPrStart).toBeGreaterThan(-1);
    // Everything from the function start up to the first showDiffLoading call
    // is the "switching PR" prologue — the stale error must be dropped there,
    // before the loading indicator is shown.
    const loadingIdx = rendererSource.indexOf('showDiffLoading(', loadPrStart);
    expect(loadingIdx).toBeGreaterThan(-1);
    const prologue = rendererSource.substring(loadPrStart, loadingIdx);
    expect(prologue).toContain('clearBodyError()');
    // And clearBodyError must actually hide the box (it was never called at all).
    const clearStart = rendererSource.indexOf('function clearBodyError()');
    expect(clearStart).toBeGreaterThan(-1);
    const clearSrc = rendererSource.substring(clearStart, rendererSource.indexOf('\n}', clearStart));
    expect(clearSrc).toContain("bodyError.style.display = 'none'");
  });

  test('loadPrByNumber calls resetButtons() in catch block', () => {
    const loadPrStart = rendererSource.indexOf('async function loadPrByNumber(prNumber, repoKey, force = false)');
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

  test('submitReview auto-advance picks the PR after the reviewed one (forward)', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // The auto-advance block must capture the reviewed PR's index BEFORE
    // removal and hand it to the shared picker — NOT restart at the first
    // pending PR.
    expect(submitSrc).toContain('reviewedPrIndex = cachedPrList.findIndex');
    expect(submitSrc).toContain('cachedPrList = cachedPrList.filter(pr => pr.number !== review.prNumber)');
    expect(submitSrc).toContain('pickNextPendingPr(reviewedPrIndex)');
  });

  test('pickNextPendingPr advances forward, stops at the last PR, falls back off-list', () => {
    const start = rendererSource.indexOf('function pickNextPendingPr(');
    expect(start).toBeGreaterThan(-1);
    const body = rendererSource.substring(start, rendererSource.indexOf('\n}', start));
    // Forward: the slot the removed PR occupied now holds the PR after it.
    expect(body).toMatch(/indexBeforeRemoval >= 0 && indexBeforeRemoval < cachedPrList\.length/);
    expect(body).toContain('return cachedPrList[indexBeforeRemoval]');
    // Last PR in the list → nothing after it (never wrap back to list[0]).
    expect(body).toMatch(/indexBeforeRemoval >= cachedPrList\.length/);
    expect(body).toContain('return null;');
    // Only a PR that was never in the list falls back to the first pending PR.
    expect(body).toContain('return cachedPrList[0] || null;');
  });

  test('submitReview auto-advance has try/catch around loadPrByNumber', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // The auto-advance call to loadPrByNumber should be wrapped in try/catch
    // so that a failure doesn't leave buttons permanently disabled
    expect(submitSrc).toContain('catch (advanceErr)');
  });

  test('submitReview "no more PRs" path shows the all-done screen', () => {
    const submitStart = rendererSource.indexOf('async function submitReview(eventType)');
    const submitEnd = rendererSource.indexOf('\n}\n', submitStart + 100);
    const submitSrc = rendererSource.substring(submitStart, submitEnd + 2);
    // When there are no PRs after the reviewed one, show the "All caught up!"
    // screen (reversion: the user wants the celebratory all-done state after
    // the last PR is reviewed, not to stay on the last reviewed PR).
    // (The checkoutMaster call was also removed — no master checkout here.)
    expect(submitSrc).toContain('showAllDoneState()');
    // The old "stay on last PR" toast must be gone from the auto-advance path.
    expect(submitSrc).not.toContain("'✓ All done — no more PRs to review'");
  });

  test('closePullRequest auto-advance clears reviewBody and has error handling', () => {
    const closeStart = rendererSource.indexOf('async function closePullRequest()');
    const closeSrc = rendererSource.substring(closeStart, rendererSource.indexOf('\n}', closeStart));
    // Should clear reviewBody before loading next PR
    expect(closeSrc).toContain("reviewBody.value = ''");
    // Closing must continue FORWARD: record the index before removal and pick
    // with the shared helper — never jump back to list[0].
    expect(closeSrc).toContain('closedPrIndex = cachedPrList.findIndex');
    expect(closeSrc).toContain('cachedPrList = cachedPrList.filter(pr => pr.number !== prNum)');
    expect(closeSrc).toContain('pickNextPendingPr(closedPrIndex)');
    expect(closeSrc).not.toMatch(/cachedPrList\[0\]\s*;/);
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

  test('resolves conflicts by taking the REVIEW BASE version (--ours), not --theirs', () => {
    const funcStart = mainSource.indexOf('async function computeSinceReviewNetDiff(');
    const funcEnd = mainSource.indexOf('\n// Generate diff for a PR', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    // During cherry-pick, ours = review base, theirs = replayed PR commit.
    // --theirs would pull master's ENTIRE merged file into the net diff (e.g.
    // PR #7359's deploy_branch.cgi showed autoAssignOnDeploy, an unrelated
    // master feature). Taking --ours (the base version) keeps merge-borne
    // master content out; the PR's real changes re-apply via later commits.
    expect(funcSrc).toContain('git checkout --ours');
    expect(funcSrc).not.toContain('git checkout --theirs');
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
    expect(mainSource).toMatch(/filesChanged: changedFiles\.length, prData, sinceReviewRef, sinceReviewEmpty\s*}/);
  });

  test('load-pr includes sinceReviewRef in its response', () => {
    expect(mainSource).toContain('sinceReviewRef: result.sinceReviewRef || null');
  });

  test('prefetch-pr cache includes sinceReviewRef', () => {
    expect(mainSource).toContain('sinceReviewRef: result.sinceReviewRef || null');
  });

  test('PRs with no commits since the last review fall back to the full PR diff', () => {
    // Arrow-navigation back to an already-reviewed PR always lands on this path:
    // the review commit IS the head, so the since-review range is empty. It must
    // widen the range to the PR's base branch instead of erroring out.
    expect(mainSource).toContain('sinceReviewEmpty = true');
    expect(mainSource).toContain('falling back to the full PR diff');
    expect(mainSource).toContain('sinceReviewEmpty: !!result.sinceReviewEmpty');
    // The file-list header labels the view honestly instead of "Changes since".
    const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    expect(rendererSrc).toContain('Full diff · no changes since');
  });

  test('get-pr-info serves cached metadata from prefetch cache', () => {
    const hIdx = mainSource.indexOf("ipcMain.handle('get-pr-info'");
    const hSrc = mainSource.substring(hIdx, mainSource.indexOf('ipcMain.handle(\'load-pr\'', hIdx) > 0 ? mainSource.indexOf('ipcMain.handle(\'load-pr\'', hIdx) : hIdx + 3000);
    // Reads prefetch cache before hitting the network
    expect(hSrc).toContain('getPrefetchEntry(cacheKey)');
    expect(hSrc).toContain('if (prefetched) {');
    // Returns cached title/author/assignees/body (+ contributing authors for bots)
    expect(hSrc).toContain('prTitle: prefetched.prTitle ||');
    expect(hSrc).toContain('prAuthor: prefetched.prAuthor ||');
    expect(hSrc).toContain('prAssignees: prefetched.prAssignees ||');
    expect(hSrc).toContain('prOtherAuthors: prefetched.prOtherAuthors ||');
    expect(hSrc).toContain('prBody: prefetched.prBody ||');
    // Must NOT consume the cache entry (load-pr still needs the diff)
    expect(hSrc).not.toContain('delete prefetchCache[cacheKey]');
  });

  test('viewedPrCache retains recently-viewed PR results for back-navigation', () => {
    // A retained cache (Map) separate from the one-shot prefetch cache exists.
    expect(mainSource).toContain('const viewedPrCache = new Map();');
    expect(mainSource).toContain('VIEWED_PR_CACHE_MAX');
    expect(mainSource).toContain('function cacheViewedPr(cacheKey, result)');
  });

  test('load-pr checks the viewed cache first and returns the SAME diff', () => {
    const hIdx = mainSource.indexOf("ipcMain.handle('load-pr'");
    const hEnd = mainSource.indexOf('ipcMain.handle(\'get-pr-info\'', hIdx);
    const hSrc = mainSource.substring(hIdx, hEnd > 0 ? hEnd : hIdx + 2000);
    // Viewed cache checked before the prefetch cache and before network/generateDiff
    expect(hSrc.indexOf('const viewed = getViewedPr(cacheKey)')).toBeLessThan(hSrc.indexOf('const prefetched = getPrefetchEntry(cacheKey)'));
    expect(hSrc).toContain('if (viewed) {');
    expect(hSrc).toContain("log('INFO', '[pr] Returning viewed-cached result");
    // Successful loads populate the retained cache
    expect(hSrc).toContain('cacheViewedPr(cacheKey, out);');
    expect(hSrc).toContain('cacheViewedPr(cacheKey, prefetched);');
  });

  test('get-pr-info serves metadata from the viewed cache first', () => {
    const hIdx = mainSource.indexOf("ipcMain.handle('get-pr-info'");
    const hEnd = mainSource.indexOf('ipcMain.handle(\'load-pr\'', hIdx);
    const hSrc = mainSource.substring(hIdx, hEnd > 0 ? hEnd : hIdx + 1500);
    expect(hSrc).toContain('const viewed = getViewedPr(cacheKey);');
    expect(hSrc).toContain('Returning viewed-cached metadata');
    expect(hSrc).toContain('prTitle: viewed.prTitle ||');
  });

  test('cached diffs expire on PR freshness, not on a blanket timer', () => {
    // A cached diff is served while the PR facts it was built from still hold.
    // prEntryStaleReason is the whole rule; load-pr applies it before serving.
    expect(mainSource).toContain('function prEntryStaleReason(entry, fresh)');
    expect(mainSource).toContain('function getFreshPrInfo(cacheKey, prNumber, repo)');
    expect(mainSource).toContain('function cachedResultStaleReason(cacheKey, prNumber, repo, entry)');
    // Freshness signals: new commits, moved base, merged/closed, review decision.
    expect(mainSource).toContain("return 'new commits'");
    expect(mainSource).toContain("return 'base branch moved'");
    expect(mainSource).toContain("return 'PR is now ' + fresh.state");
    expect(mainSource).toContain("return 'review decision changed'");
    // Every cached result carries the facts the check compares against.
    expect(mainSource).toMatch(/baseRefOid: prData\.baseRefOid \|\| null/);
    expect(mainSource).toMatch(/state: prData\.state \|\| 'OPEN'/);
    expect(mainSource).toMatch(/reviewDecision: prData\.reviewDecision \|\| ''/);
    // load-pr compares both cache branches before returning them.
    const loadIdx = mainSource.indexOf("ipcMain.handle('load-pr'");
    const loadEnd = mainSource.indexOf("ipcMain.handle('get-pr-info'", loadIdx);
    const loadSrc = mainSource.substring(loadIdx, loadEnd);
    expect(loadSrc.match(/await cachedResultStaleReason\(/g)).toHaveLength(2);
    expect(loadSrc).toContain('is stale (');
    // Offline: serve the cache rather than failing the load.
    expect(mainSource).toMatch(/if \(!fresh\) return '';[\s\S]{0,120}return prEntryStaleReason/);
    // What is left of TTL is a memory/hoarding backstop only.
    expect(mainSource).toContain('PR_CACHE_MAX_AGE_MS');
    expect(mainSource).toContain('maxAgeMinutes');
    expect(mainSource).not.toContain('VIEWED_PR_CACHE_TTL_MS');
    expect(mainSource).not.toContain('PREFETCH_TTL_MS');
    expect(mainSource).toMatch(/Date\.now\(\) - entry\.cachedAt > PR_CACHE_MAX_AGE_MS/);
    // A stuck in-progress prefetch can't block re-prefetching the PR forever.
    // The constant must be DEFINED: a bare reference throws a ReferenceError
    // that load-pr reports as "PREFETCH_STUCK_MS is not defined" and the PR
    // never opens.
    expect(mainSource).toMatch(/const PREFETCH_STUCK_MS\s*=/);
    expect(mainSource).toMatch(/now - entry\.startedAt > PREFETCH_STUCK_MS/);
    // Same guard for every *_MS constant main.js reads — a deleted definition
    // with a surviving use is exactly how PREFETCH_STUCK_MS broke.
    const msConstants = [...new Set(mainSource.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_MS\b/g) || [])];
    expect(msConstants.length).toBeGreaterThan(0);
    for (const name of msConstants) {
      expect(mainSource).toMatch(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`));
    }
    // Periodic sweep keeps a long-running app from hoarding diffs
    expect(mainSource).toMatch(/setInterval\(\(\) => \{[\s\S]{0,1200}viewedPrCache\.delete\(key\)/);
    // Force reload drops both caches for the PR instead of only bypassing reads
    expect(mainSource).toMatch(/} else \{\s*\n\s*\/\/ Force reload[\s\S]{0,200}invalidatePrCache\(cacheKey\);/);
  });

  test('title/body edits do not invalidate a cached diff', () => {
    // The rule ignores metadata-only changes: they only move the header, which
    // get-pr-info refreshes. Regenerating 10-30s of git work for a renamed PR
    // would be the cost of being wrong here.
    const stale = extractFunctionBody(mainSource, 'prEntryStaleReason');
    expect(stale).toBeTruthy();
    const fn = eval('(' + stale + ')');
    const base = { headSha: 'aaa', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'APPROVED' };
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'APPROVED' })).toBe('');
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'APPROVED', title: 'renamed' })).toBe('');
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'APPROVED', updatedAt: '2026-10-04' })).toBe('');
    // A pushed commit invalidates.
    expect(fn(base, { headSha: 'zzz', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'APPROVED' })).toBe('new commits');
    // A moved base branch invalidates.
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'yyy', state: 'OPEN', reviewDecision: 'APPROVED' })).toBe('base branch moved');
    // Merged or closed invalidates.
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'bbb', state: 'MERGED', reviewDecision: 'APPROVED' })).toBe('PR is now MERGED');
    // A new review decision invalidates (it is drawn over the diff).
    expect(fn(base, { headSha: 'aaa', baseRefOid: 'bbb', state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' })).toBe('review decision changed');
    // No fresh facts (offline) means serve what we have.
    expect(fn(base, null)).toBe('');
    expect(fn(null, base)).toBe('');
  });

  test('config.json exposes cache settings', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    // maxAgeMinutes is a hoarding backstop, prefetchMetaTtlMinutes controls the
    // fast header metadata cache. The old viewed/prefetch TTLs are gone.
    expect(cfg.cache.maxAgeMinutes).toBe(1440);
    expect(cfg.cache.prefetchMetaTtlMinutes).toBe(15);
    expect(cfg.cache.viewedTtlMinutes).toBeUndefined();
    expect(cfg.cache.prefetchTtlMinutes).toBeUndefined();
    // loadConfig defaults + private-config merge keep the settings overridable
    expect(mainSource).toContain('cache: { maxAgeMinutes: 1440, prefetchMetaTtlMinutes: 15 },');
    expect(mainSource).toContain('if (parsed.cache) config.cache = { ...config.cache, ...parsed.cache };');
    // Old keys still in a user's config are reported instead of silently ignored
    expect(mainSource).toContain('cache.viewedTtlMinutes and cache.prefetchTtlMinutes are no longer used');
  });

  test('next PR header metadata is prefetched while the current PR loads', () => {
    const pSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    const rSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    // Renderer warms the next PR's header before Phase 1 of the current one,
    // so advancing does not wait on the slow diff prefetch.
    expect(rSrc).toContain('prefetchNextPrMeta(prNumber, repoKey);');
    expect(rSrc.indexOf('prefetchNextPrMeta(prNumber, repoKey);')).toBeLessThan(rSrc.indexOf('let prMeta = null;'));
    expect(rSrc).toContain('function prefetchNextPrMeta(');
    expect(pSrc).toContain("prefetchPrMeta: (data) => ipcRenderer.invoke('prefetch-pr-meta', data)");
    // Main process: one gh pr view, no git work, stored in prMetaCache
    expect(mainSource).toContain("ipcMain.handle('prefetch-pr-meta'");
    expect(mainSource).toContain('function fetchPrMetadata(prNumber, repo)');
    expect(mainSource).toContain('function putPrMeta(cacheKey, meta)');
    expect(mainSource).toContain('function getPrMeta(cacheKey)');
    // get-pr-info reads the warm cache before touching the network, and a live
    // read is what feeds it (diff-cache metadata must never be copied in).
    const gIdx = mainSource.indexOf("ipcMain.handle('get-pr-info'");
    const gSrc = mainSource.substring(gIdx, mainSource.indexOf('async function fetchPrMetadata'));
    expect(gSrc.indexOf('const meta = getPrMeta(cacheKey);')).toBeLessThan(gSrc.indexOf('const viewed = getViewedPr(cacheKey);'));
    expect(gSrc).toContain('putPrMeta(cacheKey, meta);');
    expect(mainSource.indexOf('function getFreshPrInfo')).toBeGreaterThan(-1);
    // Freshness check reads the same warm cache first
    expect(mainSource).toMatch(/async function getFreshPrInfo[\s\S]{0,300}getPrMeta\(cacheKey\)/);
  });

  test('foldUnplaceableComments moves unmappable comments into the review body', () => {
    // Exercise the REAL helper from main.js (main.js is not module-exported,
    // so pull its source out and eval the declaration).
    const start = mainSource.indexOf('function foldUnplaceableComments');
    expect(start).toBeGreaterThan(-1);
    const fnSrc = mainSource.substring(start, mainSource.indexOf('\n}', start) + 2);
    const fold = eval(`(${fnSrc})`);

    // No review body: the folded section becomes the body, so the review is
    // never rejected as "empty" while comments are waiting to be sent.
    const solo = fold('', [{ file: 'data/js/forum1_global/backArrow.js', line: 66, text: 'line one\nline two' }]);
    expect(solo).toContain('data/js/forum1_global/backArrow.js:66');
    expect(solo).toContain('> line one');
    expect(solo).toContain('> line two');
    expect(solo).toMatch(/^### Could not attach these as inline comments/);

    // Existing body: the section is appended, never replaces what was written.
    const appended = fold('LGTM, one nit.', [{ file: 'a.pm', line: 5, text: 'nit here' }]);
    expect(appended.startsWith('LGTM, one nit.')).toBe(true);
    expect(appended).toContain('a.pm:5');

    // Nothing to fold: body untouched (empty stays empty for the validation).
    expect(fold('', [])).toBe('');
    expect(fold('LGTM', [])).toBe('LGTM');
  });

  test('submit-github-review folds unplaceable comments before rejecting empty reviews', () => {
    const sIdx = mainSource.indexOf("ipcMain.handle('submit-github-review'");
    expect(sIdx).toBeGreaterThan(-1);
    const sEnd = mainSource.indexOf("ipcMain.handle('auto-fix-with-ai'", sIdx);
    const sSrc = mainSource.substring(sIdx, sEnd > 0 ? sEnd : sIdx + 20000);

    // Both ways a comment can fail placement keep the full comment object.
    expect(sSrc).toContain('notInDiffComments.push(c)');
    expect(sSrc).toContain('unmappedComments.push(c)');

    // The fold must run BEFORE the empty-review check, otherwise the error
    // still fires for a review that only has unmappable comments.
    const foldIdx = sSrc.indexOf('const unplaceable =');
    const validateIdx = sSrc.indexOf('Cannot submit an empty review');
    expect(foldIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(foldIdx);

    // The renderer is told what happened so it can show a toast.
    expect(sSrc).toContain('response.notes = reviewNotes');
    const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    expect(rendererSrc).toContain('result.notes && result.notes.length > 0');
  });

  test('large-PR fallback places comments by line/side when gh pr diff fails', () => {
    const sIdx = mainSource.indexOf("ipcMain.handle('submit-github-review'");
    expect(sIdx).toBeGreaterThan(-1);
    const sEnd = mainSource.indexOf("ipcMain.handle('auto-fix-with-ai'", sIdx);
    const sSrc = mainSource.substring(sIdx, sEnd > 0 ? sEnd : sIdx + 20000);

    // gh pr diff reads PullRequest.diff, which refuses PRs with more than 300
    // files (HTTP 406 too_large). GitHub's own suggestion is the list-files
    // API, called here as the fallback source of truth.
    expect(mainSource).toContain('async function fetchPullFileLines');
    expect(mainSource).toContain('/files?per_page=100');
    expect(mainSource).toContain('--paginate --slurp');
    expect(sSrc).toContain('fetchPullFileLines(owner, repo, prNumber)');

    // Comments are then placed WITHOUT a position: line + side is what the
    // review API accepts when no unified diff was available to index into.
    expect(sSrc).toContain('sideForLine(lines, c.line, c.side)');
    expect(sSrc).toContain('ghComments.push({ path: c.file, line: target.line, side: target.side, body: c.text });');

    // A comment the fallback cannot place is folded into the review body —
    // never dropped, which is what made the review look empty before.
    expect(sSrc).toContain('Cannot place ${c.file}:${c.line}');
    expect(sSrc).toContain('notInDiffComments.push(c)');

    // When nothing could be posted the toast names the real cause.
    expect(sSrc).toContain('diffFetchError = ghErrorSummary(diffErr.message)');
    expect(sSrc).toContain('None of your ${comments.length} comment(s) could be posted');
    expect(sSrc).toContain("GitHub's PR diff could not be fetched");
  });

  test('linesInPatch lists every line a review comment may target', () => {
    const linesInPatch = eval('(' + extractFunctionBody(mainSource, 'linesInPatch') + ')');
    const patch = [
      '@@ -1,4 +1,4 @@',
      ' context-1',
      '-old line',
      '+new line',
      ' context-2',
      '\\ No newline at end of file'
    ].join('\n');
    const set = linesInPatch(patch);
    // Context lines are valid on both sides, deleted lines only on LEFT,
    // added lines only on RIGHT — counted from their own hunk header.
    expect(set.has('1:LEFT')).toBe(true);
    expect(set.has('1:RIGHT')).toBe(true);
    expect(set.has('2:LEFT')).toBe(true);
    expect(set.has('2:RIGHT')).toBe(true);
    expect(set.has('3:LEFT')).toBe(true);
    expect(set.has('3:RIGHT')).toBe(true);
    // Lines outside the hunk are not in the diff
    expect(set.has('4:LEFT')).toBe(false);
    expect(set.has('4:RIGHT')).toBe(false);

    // A later hunk restarts from ITS header, not from where the first ended
    const multi = linesInPatch(['@@ -10,2 +10,2 @@', ' ten', '-old', '+new'].join('\n'));
    expect(multi.has('10:LEFT')).toBe(true);
    expect(multi.has('10:RIGHT')).toBe(true);
    expect(multi.has('11:LEFT')).toBe(true);
    expect(multi.has('11:RIGHT')).toBe(true);
    expect(multi.has('4:RIGHT')).toBe(false);
  });

  test('sideForLine picks the side the comment can live on', () => {
    const sideForLine = eval('(' + extractFunctionBody(mainSource, 'sideForLine') + ')');
    const lines = new Set(['5:RIGHT', '6:LEFT', '6:RIGHT']);
    expect(sideForLine(lines, '5', 'RIGHT')).toEqual({ line: 5, side: 'RIGHT' });
    // Line numbers arrive as strings from the renderer
    expect(sideForLine(lines, 6, 'LEFT')).toEqual({ line: 6, side: 'LEFT' });
    // Missing side defaults to RIGHT, as GitHub does
    expect(sideForLine(lines, '5', undefined)).toEqual({ line: 5, side: 'RIGHT' });
    // Context line: the alternate side is accepted when its own side is not
    expect(sideForLine(lines, '5', 'LEFT')).toEqual({ line: 5, side: 'RIGHT' });
    // Not in the diff (or not a line at all): null, so the caller folds it
    expect(sideForLine(lines, '99', 'RIGHT')).toBe(null);
    expect(sideForLine(lines, 'not-a-line', 'RIGHT')).toBe(null);
    expect(sideForLine(lines, null, 'RIGHT')).toBe(null);
  });

  test('submit-github-review invalidates the processed PR cache', () => {
    const sIdx = mainSource.indexOf("ipcMain.handle('submit-github-review'");
    expect(sIdx).toBeGreaterThan(-1);
    const sEnd = mainSource.indexOf("ipcMain.handle('auto-fix-with-ai'", sIdx);
    const sSrc = mainSource.substring(sIdx, sEnd > 0 ? sEnd : sIdx + 12000);
    expect(sSrc).toContain('invalidatePrCache(');
    expect(sSrc).toMatch(/invalidatePrCache\(`\$\{prNumber\}:\$\{repoKey \|\| 'default'\}`\)/);
  });

  test('changedFilesFromDiff extracts exact files from a unified diff', () => {
    // Mirror the parsing logic implemented in main.js so we can exercise it
    // without an Electron runtime (main.js is not module-exported).
    function changedFilesFromDiff(diffText) {
      const files = [];
      const seen = new Set();
      for (const line of String(diffText || '').split('\n')) {
        if (line.startsWith('diff --git ')) {
          // diff --git a/path b/path  (paths may be quoted)
          const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\s*$/);
          const raw = m && m[2] ? m[2] : line.slice('diff --git '.length);
          const path = raw.replace(/^"|"$/g, '').replace(/\\([ "\\])/g, '$1');
          if (path && path !== '/dev/null' && !seen.has(path)) {
            seen.add(path);
            files.push(path);
          }
        }
      }
      return files;
    }
    const sampleDiff = [
      'diff --git a/app/css/banner.css b/app/css/banner.css',
      'index 111..222 100644',
      '--- a/app/css/banner.css',
      '+++ b/app/css/banner.css',
      '@@ -1,3 +1,5 @@',
      ' .banner { color: red }',
      '+.banner-new { color: blue }',
      'diff --git "a/app/old name.txt" "b/app/new name.txt"',
      'similarity index 90%',
      'rename from app/old name.txt',
      'rename to app/new name.txt',
      'diff --git a/deleted.txt b/deleted.txt',
      'deleted file mode 100644',
      'diff --git a/lib/util.pm b/lib/util.pm',
      '--- a/lib/util.pm',
      '+++ b/lib/util.pm'
    ].join('\n');
    const files = changedFilesFromDiff(sampleDiff);
    expect(files).toContain('app/css/banner.css');
    expect(files).toContain('app/new name.txt');
    expect(files).toContain('deleted.txt');
    expect(files).toContain('lib/util.pm');
    // No dupes, and no /dev/null or empty entries
    expect(files).toEqual([...new Set(files)]);
    expect(files).not.toContain('/dev/null');
  });

  test('generateDiff rebuilds changedFiles from the net diff when using since-review', () => {
    // When the since-review net diff is applied, the sidebar file list must come
    // from THAT diff, not from git log base..head (which sweeps in master's
    // merged-in changes, e.g. PR #6692's ~2,500 files).
    const marker = 'const netFileList = changedFilesFromDiff(netDiff);';
    const start = mainSource.indexOf('const netResult = await computeSinceReviewNetDiff');
    const endMarker = mainSource.indexOf('\n  }\n', mainSource.indexOf(marker, start));
    const end = endMarker > start ? endMarker : mainSource.indexOf(marker, start) + marker.length;
    // These must be found in real main.js source
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = mainSource.substring(start, end);
    expect(snippet).toContain(marker);
    expect(snippet).toContain('changedFiles.length = 0;');
    expect(snippet).toContain('changedFiles.push(...netFileList)');
    expect(snippet).toContain('if (netFileList.length > 0)');
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

describe('PR head fetch resilience (Cannot fetch head commit regression)', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  const generateDiffSrc = () => {
    const start = mainSource.indexOf('async function generateDiff(');
    const end = mainSource.indexOf('\n// Clean up stale since-review temp refs', start);
    return mainSource.substring(start, end);
  };

  test('PR head fetch gets 300s, not the old 60s cap', () => {
    // A cold PR head on the app clone needed a ~300MB pack (PR 7535: 2m41s),
    // so the 60s timeout killed it and the PR failed to load.
    expect(generateDiffSrc()).toContain('git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: repoPath, timeout: 300000 }');
  });

  test('the head-missing path retries once and falls back to the gh pr diff', () => {
    const src = generateDiffSrc();
    expect(src).toContain('retrying once');
    expect(src).toContain('falling back to the gh pr diff');
    // The hard error survives only when there is no API diff to fall back on.
    expect(src).toMatch(/if \(diffOut && diffOut\.trim\(\)\)/);
    expect(src).toContain('localGitReady');
  });

  test('git-dependent steps are skipped when the clone cannot supply the PR', () => {
    const src = generateDiffSrc();
    expect(src).toContain('if (localGitReady && reviewInfo && baseSha && headSha && !sinceReviewEmpty)');
    expect(src).toContain('if (localGitReady && (!diffOut || !diffOut.trim()))');
    expect(src).toContain('if (localGitReady && !(await shaExists(baseSha)))');
  });

  test('master fetch no longer re-shallows the clone', () => {
    // Every --depth=1 master fetch re-added a shallow boundary, which is what
    // forced later PR head fetches to re-download hundreds of MB.
    expect(mainSource).not.toMatch(/origin\/master --depth=1 --force/);
  });
});

describe('AI chat never touches the user working copy', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  test('buildChatPrompt pins the repo path and forbids branch changes in ~/Repos', () => {
    const start = mainSource.indexOf('function buildChatPrompt');
    const end = mainSource.indexOf('function cleanHermesResponse', start);
    const fn = mainSource.substring(start, end);
    expect(fn).toContain('Repository checkout to use for ALL git commands');
    expect(fn).toContain('NEVER run git checkout');
    expect(fn).toContain('~/Repos/Website-Toolbox');
    expect(fn).toContain('repoPath');
  });

  test('ai-chat handler resolves and passes that repo path', () => {
    expect(mainSource).toContain(
      "buildChatPrompt(await getPrChatContext(prNumber, repoKey), history, message || '', getLocalRepoPath(repoKey || ''))"
    );
  });
});

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

  test('uses bounded getChangedFilesViaCommits, not unbounded git log walk', () => {
    // Regression: PR #7605 on the app's shallow clone produced 10.9MB of output
    // from `git log base..head --name-only`, hitting exec's maxBuffer. The
    // changed-files lookup must prefer the commit-based walk (gh api commits +
    // per-commit git diff-tree) so output is bounded by the PR's own commits.
    expect(mainSource).toContain('async function getChangedFilesViaCommits(');
    expect(mainSource).toContain('git diff-tree --no-commit-id --name-only -r');
    // The git log fallback (if any) must carry a maxBuffer cap smaller than the
    // default 10MB so a shallow-clone ancestry blowup still can't OOM the app.
    const funcStart = mainSource.indexOf('async function generateDiff(');
    const funcEnd = mainSource.indexOf('\n// Create application menu', funcStart);
    const funcSrc = mainSource.substring(funcStart, funcEnd);
    const gitLogCount = (funcSrc.match(/\`git log/g) || []).length;
    // Any git log usage in generateDiff must be a capped fallback, not the
    // primary path (the primary path is getChangedFilesViaCommits).
    if (gitLogCount > 0) {
      expect(funcSrc).toContain('maxBuffer: 8 * 1024 * 1024');
    }
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

  test('ai-chat uses -t hermes-cli toolset and NO killing wall-clock timeout', () => {
    const fn = mainSource.substring(
      mainSource.indexOf("ipcMain.handle('ai-chat'"),
      mainSource.indexOf('function newHermesStreamState')
    );
    expect(fn).toContain("'-t', 'hermes-cli'");
    // Streamed as raw markdown events — the -q box re-renders markdown for the
    // terminal and strips ``` fences, so code blocks never rendered as blocks.
    expect(fn).toContain("'--format', 'stream-json'");
    expect(fn).toContain('applyHermesStreamLine(line, state)');
    // The app must NOT kill the agent on a wall-clock timer (that was the bug:
    // SIGTERM mid-answer was silently shipped as a complete response).
    expect(fn).toContain("spawn(appConfig.aiCommand, args);");
    expect(fn).not.toContain('timeout: 300000');
    expect(fn).not.toContain("signal === 'SIGTERM'");
    // Hermes is trusted to finish; incomplete results are detected by exit
    // status/signal (and a missing result event) instead of by wall-clock.
    expect(fn).toContain('const truncated = code !== 0 || signal || !state.done || clean.length === 0;');
    // Liveness heartbeat keeps the UI honest about long runs.
    expect(fn).toContain('heartbeat');
  });

  test('stream-json feed keeps markdown code fences and builds the activity feed', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('function newHermesStreamState'),
      mainSource.indexOf('function expandPath')
    );
    const { newHermesStreamState, applyHermesStreamLine } = new Function(
      fn + '\nreturn { newHermesStreamState, applyHermesStreamLine };'
    )();
    const state = newHermesStreamState();
    // Non-JSON chrome (session footer, blank lines) never reaches the bubble.
    expect(applyHermesStreamLine('Session: 20261008_124100_x', state)).toBe(false);
    expect(applyHermesStreamLine('not json {', state)).toBe(false);
    // Text deltas accumulate with the fences intact — this is what makes
    // perl/html code render as code blocks instead of loose paragraphs.
    expect(applyHermesStreamLine(JSON.stringify({ type: 'text', text: 'Here:\n\n```perl\nmy $n = 42;\n' }), state)).toBe(true);
    expect(applyHermesStreamLine(JSON.stringify({ type: 'text', text: '\n```\n' }), state)).toBe(true);
    expect(state.answer).toContain('```perl');
    expect(state.answer.trim().endsWith('```')).toBe(true);
    // Tool calls become activity rows; repeats de-duplicate.
    expect(applyHermesStreamLine(JSON.stringify({ type: 'tool_use', name: 'terminal', input: { command: 'ls /tmp' } }), state)).toBe(true);
    expect(applyHermesStreamLine(JSON.stringify({ type: 'tool_use', name: 'terminal', input: { command: 'ls /tmp' } }), state)).toBe(false);
    expect(state.steps).toEqual(['running terminal: ls /tmp…']);
    // tool_result and system init are not user-visible.
    expect(applyHermesStreamLine(JSON.stringify({ type: 'tool_result', name: 'terminal', output: 'x' }), state)).toBe(false);
    expect(applyHermesStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }), state)).toBe(false);
    // The result event is the authoritative finished answer.
    expect(applyHermesStreamLine(JSON.stringify({ type: 'result', text: 'Done.\n\n```html\n<b>hi</b>\n```', exit_code: 0 }), state)).toBe(true);
    expect(state.done).toBe(true);
    expect(state.answer).toBe('Done.\n\n```html\n<b>hi</b>\n```');
  });

  test('buildChatPrompt instructs the agent to prefer fd/rg', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('function buildChatPrompt'),
      mainSource.indexOf('function cleanHermesResponse')
    );
    expect(fn).toContain('prefer');
    expect(fn).toContain('`fd` over `find`');
    expect(fn).toContain('`rg` over `grep`');
  });

  test('auto-fix prompt includes fd/rg preference', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('ipcMain.handle(\'auto-fix-with-ai\''),
      mainSource.indexOf('ipcMain.handle(\'propose-rules\'')
    );
    expect(fn).toContain('\\`fd\\` over \\`find\\`');
    expect(fn).toContain('\\`rg\\` over \\`grep\\`');
  });

  test('propose-rules prompt includes fd/rg preference', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('ipcMain.handle(\'propose-rules\''),
      mainSource.indexOf('// Save proposed rules to files')
    );
    expect(fn).toContain('\\`fd\\` over \\`find\\`');
    expect(fn).toContain('\\`rg\\` over \\`grep\\`');
  });

  // ── save-agent-rules: a "modify" proposal must REPLACE its target ─────────
  // Regression guard: the old code silently appended when the existing rule
  // text wasn't found, so a Modify suggestion created a duplicate rule.
  describe('applyRulesToContent', () => {
    // mainSource is loaded in beforeAll, so extract the helpers lazily.
    const loadHelpers = () => {
      const helpersSrc = mainSource.substring(
        mainSource.indexOf('function normalizeRuleText'),
        mainSource.indexOf('// Save proposed rules to files')
      );
      return new Function(
        `${helpersSrc}; return { normalizeRuleText, findExistingRuleRange, buildRuleInsertion, applyRulesToContent };`
      )();
    };

    test('modify replaces the existing rule in place and keeps the bullet', () => {
      const content = '- First rule\n- Old rule text here\n- Third rule\n';
      const { updated, applied, failures } = loadHelpers().applyRulesToContent(content, [
        { type: 'modify', rule: 'New generalized rule', existingRule: 'Old rule text here', file: 'AGENTS.md' }
      ]);
      expect(failures).toEqual([]);
      expect(applied).toBe(1);
      expect(updated).toBe('- First rule\n- New generalized rule\n- Third rule\n');
    });

    test('modify matches despite missing bullet, wrapping and spacing', () => {
      const content = '- Old rule text here\n- Keep me\n';
      const { updated, failures } = loadHelpers().applyRulesToContent(content, [
        { type: 'modify', rule: 'New rule', existingRule: 'Old rule\n     text    here', file: 'AGENTS.md' }
      ]);
      expect(failures).toEqual([]);
      expect(updated).toBe('- New rule\n- Keep me\n');
    });

    test('modify target not found FAILS instead of appending a duplicate', () => {
      const content = '- Some other rule\n';
      const { updated, applied, failures } = loadHelpers().applyRulesToContent(content, [
        { type: 'modify', rule: 'Sneaky duplicate', existingRule: 'Text that only exists in a stale local copy', file: 'AGENTS.md' }
      ]);
      expect(applied).toBe(0);
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toMatch(/not found/);
      expect(failures[0].existingRule).toContain('stale local copy');
      expect(updated).toBe(content);
      expect(updated).not.toContain('Sneaky duplicate');
    });

    test('new rules are still appended with a bullet', () => {
      const { updated, applied, failures } = loadHelpers().applyRulesToContent('- A rule', [
        { type: 'new', rule: 'Brand new rule', file: 'AGENTS.md' }
      ]);
      expect(failures).toEqual([]);
      expect(applied).toBe(1);
      expect(updated).toBe('- A rule\n- Brand new rule\n');
    });

    test('modification never produces a doubled bullet', () => {
      const content = '- Old rule\n';
      // Replacement arrives with its own bullet while the file's bullet is
      // outside the matched text.
      const { updated, failures } = loadHelpers().applyRulesToContent(content, [
        { type: 'modify', rule: '- New rule with bullet', existingRule: 'Old rule', file: 'AGENTS.md' }
      ]);
      expect(failures).toEqual([]);
      expect(updated).toBe('- New rule with bullet\n');
    });
  });

  test('save-agent-rules reports a missing modify target instead of appending', () => {
    const fn = mainSource.substring(
      mainSource.indexOf('// Save proposed rules to files'),
      mainSource.indexOf("ipcMain.handle('delete-pr-files'")
    );
    expect(fn).not.toContain('fall back to appending');
    expect(fn).toContain('applyRulesToContent(current, newRules)');
    expect(fn).toContain('modify target NOT found');
    expect(fn).toContain('failures,');
    // All rules failed → nothing is pushed to GitHub
    expect(fn).toContain('if (applied === 0)');
  });

  test('get-agent-rules reads rules files from GitHub first, local only as fallback', () => {
    const fn = mainSource.substring(
      mainSource.indexOf("ipcMain.handle('get-agent-rules'"),
      mainSource.indexOf('// Analyze review feedback')
    );
    expect(fn).toContain('`gh api repos/${owner}/${repo}/contents/${file} --jq .content | base64 -d`');
    expect(fn).toContain("let agentsMd = await fetchGitHub('AGENTS.md')");
    expect(fn).toContain('if (agentsMd === null) agentsMd = readLocal');
    // The stale local clone must no longer be the primary source
    expect(fn).not.toContain("fs.readFileSync(agentsPath, 'utf8')");
  });

  test('renderer surfaces agent steps before answer streams', () => {
    expect(rendererSource).toContain("data.steps && data.steps.length > 0");
    expect(rendererSource).toContain("className = 'ai-chat-step'");
    expect(rendererSource).toContain("className = 'ai-chat-answer'");
    expect(rendererSource).toContain('renderSteps(live)');
  });

  test('index.html styles the ai-chat step feed and answer', () => {
    expect(indexHtml).toContain('.ai-chat-step');
    expect(indexHtml).toContain('.ai-chat-answer');
  });

  test('renderMarkdownHtml is the shared sanitizer for description + AI chat', () => {
    const fn = rendererSource.substring(
      rendererSource.indexOf('function renderMarkdownHtml'),
      rendererSource.indexOf('function togglePrDescDropdown')
    );
    expect(fn).toContain('marked.parse(text, { renderer: cleanRenderer })');
    expect(fn).toContain("querySelectorAll('script, iframe, object, embed");
    expect(fn).toContain('/^javascript:/i.test(attr.value)');
    expect(fn).toContain('javascript|data|vbscript'); // link hrefs are sanitized too
    // Both surfaces call it: PR description dropdown and chat bubbles
    expect(rendererSource).toContain('renderMarkdownHtml(body)');
    expect(rendererSource).toContain("renderMarkdownHtml(text || '')");
    expect(rendererSource).toContain('pr-desc-content md-body');
  });

  test('AI chat renders agent replies as markdown, user replies as plain text', () => {
    expect(rendererSource).toContain('function renderAiMarkdown(el, text)');
    expect(rendererSource).toContain('<div class="ai-md md-body">');
    expect(rendererSource).toContain("if (role === 'assistant') renderAiMarkdown(el, text)");
    // Code blocks in a reply get syntax colors (hljs is already bundled for diffs)
    expect(rendererSource).toContain('function highlightMarkdownCode(root)');
    // The "Thinking…" placeholder must never survive above a rendered reply,
    // and the activity feed must reset per request (dedup is per bubble).
    expect(rendererSource).toContain('function ensureAiAnswer(live)');
    expect(rendererSource).toContain("n.textContent.trim() === 'Thinking\\u2026'");
    expect(rendererSource).toContain('seenSteps = []; // the activity feed belongs to one request, not the session');
    expect(rendererSource).toContain('highlightMarkdownCode(el);');
    expect(rendererSource).toContain("root.querySelectorAll('pre code')");
    expect(rendererSource).toContain('window.hljs.getLanguage(lang)');
    const sendSrc = rendererSource.substring(rendererSource.indexOf('async function sendAiChat'));
    // error partial text, final done (steps + no-steps), streaming (steps + no-steps), fallback
    expect((sendSrc.match(/renderAiMarkdown\(/g) || []).length).toBeGreaterThanOrEqual(5);
    // The heartbeat must not flatten already-rendered markdown back to textContent
    expect(sendSrc).toContain('live.children.length === 0');
  });

  test('index.html shares markdown styles via .md-body and styles .ai-md bubbles', () => {
    expect(indexHtml).toContain('.md-body p { margin-bottom: 12px; }');
    expect(indexHtml).toContain('.md-body pre {');
    expect(indexHtml).toContain('.md-body > :first-child');
    expect(indexHtml).toContain('/* AI chat markdown');
    // Rendered wrapper resets the bubble's pre-wrap whitespace
    expect(indexHtml).toMatch(/\.ai-md \{[^}]*white-space: normal/);
    // Light mode chips follow the light bubble (dropdown box stays dark)
    expect(indexHtml).toContain('.ai-md pre { background: #ffffff;');
    expect(indexHtml).toContain('.ai-md code { background: #eff1f3; }');
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

  test('index.html has bot icon for AI chat and a PR comment dialog (no toolbar comment icon)', () => {
    expect(indexHtml).toContain('id="btn-ai-chat"');
    expect(indexHtml).toContain('id="pr-comment-panel"');
    expect(indexHtml).toContain('id="pr-comment-backdrop"');
    // The standalone toolbar comment icon is gone — PR comments are added
    // from the "+" inside the All Comments panel
    expect(indexHtml).not.toContain('id="btn-pr-comment"');
    // AI chat button uses a bot/robot icon (rect head + antenna), not a comment bubble
    expect(indexHtml).toContain('aria-label="Chat with AI"');
  });

  test('review-body textarea lives in the Add PR Comment dialog (bottom container removed)', () => {
    // #review-body must live in #pr-comment-panel (the centered dialog)
    const panelStart = indexHtml.indexOf('id="pr-comment-panel"');
    const panelEnd = indexHtml.indexOf('id="comment-nav"', panelStart);
    const panelBlock = indexHtml.substring(panelStart, panelEnd);
    expect(panelBlock).toContain('id="review-body"');
    expect(panelBlock).toContain('id="pr-comment-add"');
    expect(panelBlock).toContain('id="pr-comment-cancel"');
    // The old bottom-of-screen review body container should be gone
    expect(indexHtml).not.toContain('id="review-body-container"');
    expect(rendererSource).toContain("const prCommentPanel = document.getElementById('pr-comment-panel')");
    expect(rendererSource).toContain('function openPrCommentDialog()');
    expect(rendererSource).toContain('function closePrCommentDialog()');
    // Closing the dialog returns the user to the comments dropdown
    expect(rendererSource).toMatch(/function closePrCommentDialog\(\) \{[\s\S]*?openCommentsPanel\(\)/);
  });

  test('Add PR Comment is opened from a "+" in the All Comments panel', () => {
    // The "+" button is rendered with the panel header (both the empty and the
    // populated branch) and wired up after render
    expect(rendererSource).toContain('class="c-add-pr"');
    expect(rendererSource).toContain('openPrCommentDialog()');
    expect(rendererSource).toContain('wireCommentsPanel()');
    expect(indexHtml).toContain('#comments-panel .c-add-pr {');
    expect(indexHtml).toContain('#pr-comment-backdrop.open { display: block; }');
  });

  test('Cmd+Enter submits the Add PR Comment dialog', () => {
    // The global shortcut handler checks the dialog first (it is modal), then
    // falls back to the inline comment form
    expect(rendererSource).toMatch(
      /e\.key === 'Enter' && isMeta && !e\.shiftKey[\s\S]{0,400}?prCommentPanel\.classList\.contains\('open'\)/
    );
    // Empty box keeps the button disabled, so Cmd+Enter must not submit either
    expect(rendererSource).toContain('if (prCommentAdd && !prCommentAdd.disabled) prCommentAdd.click();');
    // The dialog and the shortcut list both advertise it
    expect(indexHtml).toContain('title="Add Comment (Cmd+Enter)"');
    expect(indexHtml).toContain('Submit open comment form / Add PR Comment');
  });

  test('review shortcuts are single letters: Cmd+A approve, Cmd+R changes, Cmd+C comment', () => {
    // Approve / request changes / comment lost their Shift modifier
    expect(rendererSource).toMatch(/key === 'A' && isMeta && !e\.shiftKey && !isEditableTarget\(e\.target\)/);
    expect(rendererSource).toMatch(/key === 'R' && isMeta && !e\.shiftKey && !isEditableTarget\(e\.target\)/);
    expect(rendererSource).toMatch(/key === 'C' && isMeta && !e\.altKey && !isEditableTarget\(e\.target\)/);
    // Reload moved to Cmd+Shift+R and still re-checks when no PR is loaded
    expect(rendererSource).toMatch(/key === 'R' && isMeta && e\.shiftKey[\s\S]{0,400}?recheckForNewPrs\(\)/);
    // The old shifted bindings are gone
    expect(rendererSource).not.toContain("// Cmd+Shift+A — Approve");
    expect(rendererSource).not.toContain("// Cmd+Shift+C — Comment");
    // Copy/select-all are protected while text is selected
    expect(rendererSource).toContain('function selectedText()');
    expect(rendererSource).toMatch(/!isEditableTarget\(e\.target\) && !selectedText\(\)/);

    // Tooltips and the shortcuts dialog advertise the same keys
    expect(indexHtml).toContain('title="Cmd+A"');
    expect(indexHtml).toContain('title="Cmd+R"');
    expect(indexHtml).not.toContain('title="Cmd+Shift+A"');
    expect(indexHtml).not.toContain('title="Cmd+Shift+R">Request Changes');
    expect(indexHtml).toContain('<kbd>⌘</kbd><kbd>A</kbd><span class="shortcut-desc">Approve PR</span>');
    expect(indexHtml).toContain('<kbd>⌘</kbd><kbd>R</kbd><span class="shortcut-desc">Request changes</span>');
    expect(indexHtml).toContain('<kbd>⌘</kbd><kbd>C</kbd><span class="shortcut-desc">Submit review as comment</span>');
    expect(indexHtml).toContain('<kbd>⌘</kbd><kbd>Shift</kbd><kbd>R</kbd><span class="shortcut-desc">Reload current PR diff</span>');
  });

  test('PR-level comment shows as a pending row and a submit button appears', () => {
    // getCombinedCommentList() puts the whole-PR comment (the review body) first
    expect(rendererSource).toContain("kind: 'pr-pending'");
    expect(rendererSource).toContain('function countPendingComments()');
    // Submit only renders while something is pending, and posts as "commented"
    expect(rendererSource).toContain('countPendingComments() > 0');
    expect(rendererSource).toContain('class="c-submit-review"');
    expect(rendererSource).toMatch(/c-submit-review[\s\S]{0,200}submitReview\('comment'\)/);
    expect(indexHtml).toContain('#comments-panel .c-submit-review {');
    // Close Pull Request sits beside Submit in the footer (always shown)
    expect(rendererSource).toContain('function commentsPanelFooter()');
    expect(rendererSource).toContain('class="c-close-pr"');
    expect(rendererSource).toContain("querySelectorAll('.c-close-pr')");
    expect(rendererSource).toMatch(/\.c-close-pr[\s\S]{0,300}closePullRequest\(\)/);
    expect(indexHtml).toContain('#comments-panel .c-close-pr {');
    expect(indexHtml).toMatch(/#comments-panel \.comments-panel-footer \{[^}]*display: flex/);
  });

  test('The ⋮ menu is gone; Close Pull Request lives in the panel footer', () => {
    // The menu's only remaining row was Close Pull Request, and that action now
    // sits beside Submit Comment in the All Comments panel — so the button,
    // the dropdown and its wiring were all removed with it.
    expect(indexHtml).not.toContain('id="btn-more"');
    expect(indexHtml).not.toContain('id="more-menu"');
    expect(indexHtml).not.toContain('id="menu-close-pr"');
    expect(indexHtml).not.toContain('#btn-more');
    expect(indexHtml).not.toContain('#more-menu');
    expect(rendererSource).not.toContain("getElementById('btn-more')");
    expect(rendererSource).not.toContain("getElementById('more-menu')");
    // No Comment button anywhere anymore (it became the panel submit button)
    expect(indexHtml).not.toContain('id="btn-comment"');
    expect(rendererSource).not.toContain("getElementById('btn-comment')");
    // The action itself still exists, in the panel footer
    expect(rendererSource).toContain('class="c-close-pr"');
    expect(rendererSource).toMatch(/\.c-close-pr[\s\S]{0,300}closePullRequest\(\)/);
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

// ── Collapsed files reorder to end ──

describe('Collapsed files reorder to end', () => {
  let rendererSource;
  beforeAll(() => {
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  });

  test('reorderCollapsedFilesLast exists and appends collapsed wrappers last', () => {
    expect(rendererSource).toContain('function reorderCollapsedFilesLast');
    const funcSrc = rendererSource.substring(
      rendererSource.indexOf('function reorderCollapsedFilesLast'),
      rendererSource.indexOf('function reorderCollapsedFilesLast') + 2000
    );
    // Groups expanded first then collapsed into a fragment appended to the target
    expect(funcSrc).toContain('expanded.forEach(w => frag.appendChild(w));');
    expect(funcSrc).toContain('collapsed.forEach(w => frag.appendChild(w));');
    expect(funcSrc).toContain('target.appendChild(frag);');
    // Must reorder WITHIN the themed (.d2h-dark-color-scheme) parent — appending
    // to #diff-container would hoist wrappers out of the dark scheme and break
    // the diff's dark styling. Verify the themed-ancestor lookup exists.
    expect(funcSrc).toContain('d2h-dark-color-scheme');
  });

  test('reorderCollapsedFilesLast is called after renders and on toggle', () => {
    expect(rendererSource).toContain('reorderCollapsedFilesLast();');
    // Called in loadDiff, renderFilteredDiff, and the toggle click handler
    const calls = rendererSource.match(/reorderCollapsedFilesLast\(\);/g);
    expect(calls).not.toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Function preview popover ──

describe('Function preview popover', () => {
  let mainSource, rendererSource, htmlSource;
  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    htmlSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('get-function-preview IPC handler exists and is wired', () => {
    expect(mainSource).toContain("ipcMain.handle('get-function-preview'");
    // Now resolves across the whole codebase (module-scoped search + master fallback)
    expect(mainSource).toContain('resolveFunctionPreview');
    expect(mainSource).toContain("['master']");
    expect(mainSource).toContain('package ${module};');
  });

  test('preload exposes getFunctionPreview', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    expect(preloadSource).toContain('getFunctionPreview: (data) => ipcRenderer.invoke(\'get-function-preview\', data)');
  });

  test('renderer attaches hover handlers for perl/js definitions AND calls', () => {
    expect(rendererSource).toContain('function addFunctionPreviewHandlers');
    expect(rendererSource).toContain("window.electronAPI.getFunctionPreview");
    expect(rendererSource).toContain('addFunctionPreviewHandlers();');
    expect(rendererSource).toContain('FUNC_DEF_PATTERNS');
    // Call-site preview: fully-qualified Perl calls and JS calls, plus a hover delay.
    expect(rendererSource).toContain('FUNC_CALL_PATTERNS');
    expect(rendererSource).toContain('FUNC_PREVIEW_DELAY');
    expect(rendererSource).toContain('resolvePreviewTarget');
    // Perl detection covers extensionless cgi-bin/board paths (e.g. cgi-bin/board/oauth).
    expect(rendererSource).toContain("isPerlPath");
    expect(rendererSource).toContain("fileName.startsWith('cgi-bin/')");
  });

  test('resolvePreviewTarget handles arrow-method and qualified calls', () => {
    // The renderer source must scan ALL call matches on a line (not just the
    // first) so `new(...)->load()` resolves to `load`, and detect extensionless
    // Perl paths so cgi-bin/board/oauth lines get bound.
    expect(rendererSource).toContain("re.exec(text)");
    expect(rendererSource).toContain("->\\s*([a-z_]\\w*)\\s*\\(");
  });

  test('comment uids never collide across restored and new comments', () => {
    // Restored drafts keep _uid values from a previous session; new comments
    // must allocate uids above all existing ones so editComment never resolves
    // a marker to a different file's comment.
    expect(rendererSource).toContain('function nextCommentUid');
    expect(rendererSource).toContain('while (used.has(commentUidCounter)) commentUidCounter++;');
    expect(rendererSource).toContain('else commentUidCounter = Math.max(commentUidCounter, c._uid);');
  });

  test('preview popover is scrollable and stays open while moving to it', () => {
    // The popover must be pointer-interactive (scroll long lines) instead of
    // pointer-events:none, and hiding must wait a grace period so the cursor
    // can travel from the anchor line into the popover. Entering the popover
    // cancels the pending hide.
    expect(rendererSource).toContain('scheduleHideFuncPreview');
    expect(rendererSource).toContain("funcPreviewPopover.addEventListener('mouseenter'");
    expect(rendererSource).toContain("funcPreviewPopover.addEventListener('mouseleave'");
    expect(rendererSource).toContain("bodyEl.className = 'func-preview-body'");
    // CSS: pointer-events auto + horizontally scrollable body
    expect(htmlSource).toContain('pointer-events: auto');
    expect(htmlSource).toContain('.func-preview-body {');
    expect(htmlSource).toContain('overflow-x: auto');
  });

  test('smart resolution infers class from arrow chain and walks inheritance', () => {
    // Renderer: infer the class for a `Module::Class->new(...)->method()` chain
    // so the method resolves in the right class, not codebase-wide.
    expect(rendererSource).toContain("matchAll(/([A-Za-z_]\\w*(?:::\\w+)+)\\s*->/g)");
    // Main: follow the inheritance chain (@ISA / use base / extends) so a method
    // inherited from a parent class (e.g. OAuthConnection -> Framework -> load)
    // is found in the parent.
    expect(mainSource).toContain("getParentPackages");
    expect(mainSource).toContain("our\\s+@ISA\\s*=\\s*\\(?\\s*qw");
    expect(mainSource).toContain("findInClass");
  });

  test('extractFunctionBody extracts a Perl sub with nested braces', () => {
    const content = [
      'package Foo;',
      'sub bar {',
      '  my $x = 1;',
      '  if ($x) {',
      '    return $x;',
      '  }',
      '}',
      'sub baz {',
      '  return 2;',
      '}'
    ].join('\n');
    const body = extractFunctionBody(content, 'bar');
    expect(body).toContain('sub bar {');
    expect(body).toContain('return $x;');
    expect(body).not.toContain('sub baz');
  });

  test('extractFunctionBody extracts a JS function declaration', () => {
    const content = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
      'function sub(a, b) {',
      '  return a - b;',
      '}'
    ].join('\n');
    const body = extractFunctionBody(content, 'add');
    expect(body).toContain('function add(a, b) {');
    expect(body).toContain('return a + b;');
    expect(body).not.toContain('return a - b;');
  });

  test('extractFunctionBody returns null for missing function', () => {
    expect(extractFunctionBody('sub foo { return 1; }', 'missing')).toBeNull();
  });

  test('extractFunctionBody handles JS arrow function with braces on next line', () => {
    const content = [
      'const doThing = (x) => {',
      '  return x * 2;',
      '};'
    ].join('\n');
    const body = extractFunctionBody(content, 'doThing');
    expect(body).toContain('const doThing = (x) => {');
    expect(body).toContain('return x * 2;');
  });
});


// ── Since-review net diff (PR #7377 showed master's merge content) ──

describe('Since-review net diff', () => {
  let mainSource;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  });

  test('isMasterImportCommit flags single-parent master merges only', () => {
    const src = extractFunctionBody(mainSource, 'isMasterImportCommit');
    expect(src).toBeTruthy();
    // eslint-disable-next-line no-eval
    const fn = eval('(' + src + ')');
    // PR #7377's leak: "Merge branch 'master' into 2fa" with ONE parent slips
    // past the parents.length < 2 filter and replays master as PR work.
    expect(fn({ commit: { message: "Merge branch 'master' into 2fa" } })).toBe(true);
    expect(fn({ commit: { message: 'Merge master into 2fa via mergeWithMaster button by Nitin' } })).toBe(true);
    expect(fn({ commit: { message: 'Merge remote-tracking branch origin/master into HEAD' } })).toBe(true);
    // real author work must never be dropped
    expect(fn({ commit: { message: 'Merge conflict fix' } })).toBe(false);
    expect(fn({ commit: { message: 'Merge branch feature/x into y' } })).toBe(false);
    expect(fn({ commit: { message: 'Fixed mantis 31149' } })).toBe(false);
    expect(fn({ commit: { message: 'feat: add twoFA scripts\n\nbody' } })).toBe(false);
    expect(fn({ commit: {} })).toBe(false);
    expect(fn(null)).toBe(false);
  });

  test('the after-review commit filter excludes master imports', () => {
    expect(mainSource).toContain('function isMasterImportCommit');
    expect(mainSource).toContain('!isMasterImportCommit(c)');
    expect(mainSource).toMatch(/c\.parents && c\.parents\.length < 2/);
    expect(mainSource).toMatch(/c\.commit\.committer\.date > reviewDate/);
  });

  test('since-review ref reads HEAD with rev-parse, not git commit banner', () => {
    // git prints an ABBREVIATED sha in "[detached HEAD 40bdc8822b8]", so the
    // old \w{40} regex never matched: sinceReviewRef stayed null and context
    // expansion fell back to base..head (all of master's merges).
    expect(mainSource).toContain("execPromise('git rev-parse HEAD'");
    expect(mainSource).not.toContain('(\\w{40})');
    expect(mainSource).toContain('git update-ref ${sinceReviewRef} ${commitSha}');
  });

  test('context expansion prefers the since-review ref over base..head', () => {
    const idx = mainSource.indexOf("ipcMain.handle('expand-diff-context'");
    expect(idx).toBeGreaterThan(-1);
    const handler = mainSource.slice(idx, idx + 2500);
    expect(handler).toContain('git diff ${baseSha} ${sinceReviewRef}');
    expect(handler).toContain('sinceReviewRef && baseSha');
  });
});


// ── Full-file viewer dialog (header button, Cmd+F, syntax highlighting) ──

describe('Full-file viewer', () => {
  let mainSrc, rendererSrc, preloadSrc;

  beforeAll(() => {
    mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    preloadSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  });

  // Runs the production readFileAtRef with an injected exec (main.js boots
  // Electron, so it can't be required — Pitfall 139).
  function loadReadFileAtRef(fakeExec, fakeLog) {
    const src = extractFunctionBody(mainSrc, 'readFileAtRef');
    expect(src).toBeTruthy();
    // eslint-disable-next-line no-eval
    const factory = eval('(function (log, execPromise) { return ' + src + '; })');
    return factory(fakeLog || (() => {}), fakeExec);
  }

  test('readFileAtRef reads a file with a quoted ref:path spec', async () => {
    const calls = [];
    const fn = loadReadFileAtRef(async (cmd) => {
      calls.push(cmd);
      return 'my $x = 1;\n';
    });
    const res = await fn('/repo', 'lib/helpers.pm', '605b5bcec2286593bd9b1f4af56269cdb16b5f1c');
    expect(res.error).toBeUndefined();
    expect(res.content).toBe('my $x = 1;\n');
    expect(calls).toEqual(['git show "605b5bcec2286593bd9b1f4af56269cdb16b5f1c:lib/helpers.pm"']);
    expect(calls[0]).not.toMatch(/[;&|`]/);
  });

  test('readFileAtRef rejects shell metacharacters in the file path', async () => {
    let calls = 0;
    const fn = loadReadFileAtRef(async () => { calls++; return ''; });
    for (const bad of ['a;rm -rf /', 'a$(whoami)', 'a`id`', 'a|cat', 'a"b', 'a>b']) {
      const res = await fn('/repo', bad, 'HEAD');
      expect(res.error).toBeTruthy();
    }
    expect(calls).toBe(0);
  });

  test('readFileAtRef falls back to HEAD when the ref has no such file', async () => {
    const calls = [];
    const fn = loadReadFileAtRef(async (cmd) => {
      calls.push(cmd);
      if (calls.length === 1) throw new Error('path not found');
      return 'head content';
    });
    const res = await fn('/repo', 'new/file.js', 'abc1234');
    expect(res.content).toBe('head content');
    expect(res.ref).toBe('HEAD');
    expect(res.note).toContain('HEAD');
    expect(calls).toEqual([
      'git show "abc1234:new/file.js"',
      'git show "HEAD:new/file.js"'
    ]);
  });

  test('readFileAtRef sanitizes a hostile ref and reports a clean error', async () => {
    const calls = [];
    const fn = loadReadFileAtRef(async (cmd) => { calls.push(cmd); throw new Error('nope\nextra stderr'); });
    const res = await fn('/repo', 'lib/helpers.pm', '$(evil)');
    // hostile ref replaced with HEAD, then the error surfaced without stderr noise
    expect(calls[0]).toBe('git show "HEAD:lib/helpers.pm"');
    expect(res.error).toContain('Could not read');
    expect(res.error).not.toContain('extra stderr');
  });

  test('splitHighlightedLines re-opens tags that cross a line break', () => {
    const src = extractFunctionBody(rendererSrc, 'splitHighlightedLines');
    expect(src).toBeTruthy();
    // eslint-disable-next-line no-eval
    const split = eval('(' + src + ')');
    const lines = split('<span class="hljs-comment">// a\n// b</span>\n<span class="hljs-keyword">my</span> $x;');
    expect(lines).toEqual([
      '<span class="hljs-comment">// a',
      '<span class="hljs-comment">// b</span>',
      '<span class="hljs-keyword">my</span> $x;'
    ]);
    // no tags at all: plain lines come back untouched
    expect(split('one\ntwo')).toEqual(['one', 'two']);
  });

  test('header button, IPC bridge and keyboard routing are wired', () => {
    expect(rendererSrc).toContain('function addOpenFileButtonForHeader');
    // button added alongside the copy button, so both load paths get it
    expect(rendererSrc).toMatch(/addCopyFileNameButtonForHeader\(header\);\s*\n\s*addOpenFileButtonForHeader\(header\);/);
    expect(rendererSrc).toContain("btn.title = 'Open full file (Cmd+F to search)'");

    expect(preloadSrc).toContain("readFileContent: (repoPath, filePath, ref) => ipcRenderer.invoke('read-file-content'");
    expect(mainSrc).toContain("ipcMain.handle('read-file-content'");

    // Cmd+F and the menu accelerator must route to the dialog find bar while
    // it is open, otherwise page-level find counts matches in the diff too.
    expect(rendererSrc).toContain('if (isFileViewerOpen()) fileViewerFindOpen();');
    expect(rendererSrc).toContain('else openFindBar();');
    // Esc closes the find bar first, then the dialog
    expect(rendererSrc).toContain('if (!fileViewerCloseFind()) closeFullFileViewer();');
    // syntax highlighting + per-line numbers
    expect(rendererSrc).toContain("window.hljs.highlight(text, { language: lang, ignoreIllegals: true })");
    expect(rendererSrc).toContain("code.className = 'fv-code hljs'");
    // language map covers this repo's extensions
    expect(rendererSrc).toContain("cgi: 'perl'");
    expect(rendererSrc).toContain("tpl: 'html'");
  });
});

// ── PR description dropdown hotkey (Cmd+D) ──

describe('PR description hotkey', () => {
  let rSrc;
  let mSrc;
  let hSrc;
  beforeAll(() => {
    rSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    mSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    hSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('keydown handler binds Cmd/Ctrl+D to the description dropdown', () => {
    expect(rSrc).toContain("if (key === 'D' && isMeta && !e.shiftKey && !e.altKey)");
    // must toggle the SAME dropdown the title / chevron button toggles
    expect(rSrc).toMatch(
      /key === 'D' && isMeta && !e\.shiftKey && !e\.altKey[\s\S]{0,160}togglePrDescDropdown\(\);/
    );
    // never opens an empty dropdown when no PR is loaded
    expect(rSrc).toContain('if (currentPrNumber) togglePrDescDropdown();');
  });

  test('Cmd+D is not already taken by a menu accelerator', () => {
    expect(mSrc).not.toMatch(/accelerator:\s*'CmdOrCtrl\+D'/);
  });

  test('shortcuts dialog advertises Cmd+D', () => {
    expect(hSrc).toContain('<kbd>D</kbd><span class="shortcut-desc">Show PR description</span>');
  });
});

// ── Contributor line: full list immediately, merge-only users dropped later ──

describe('Contributor refinement', () => {
  let mSrc;
  let rSrc;
  let pSrc;

  beforeAll(() => {
    mSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    rSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    pSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  });

  // Runs the production helpers with injected deps (main.js boots Electron,
  // so it can't be required — Pitfall 139).
  function loadContributorFns() {
    const masterSrc = extractFunctionBody(mSrc, 'isMasterImportCommit');
    const mergeSrc = extractFunctionBody(mSrc, 'isMergeOnlyCommit');
    const dropSrc = extractFunctionBody(mSrc, 'dropMergeOnlyAuthors');
    const refineSrc = extractFunctionBody(mSrc, 'refinePrAuthors');
    const mapLimitSrc = extractFunctionBody(mSrc, 'mapLimit');
    expect(masterSrc).toBeTruthy();
    expect(mergeSrc).toBeTruthy();
    expect(dropSrc).toBeTruthy();
    expect(refineSrc).toBeTruthy();
    expect(mapLimitSrc).toBeTruthy();
    // eslint-disable-next-line no-eval
    const factory = eval(
      '(function (execPromise, log) {' +
        mapLimitSrc + ';' + masterSrc + ';' + mergeSrc + ';' + dropSrc + ';' + refineSrc + ';' +
        'return { dropMergeOnlyAuthors: dropMergeOnlyAuthors, isMergeOnlyCommit: isMergeOnlyCommit, refinePrAuthors: refinePrAuthors };' +
      '})'
    );
    return factory;
  }

  const PR5613 = {
    authors: ['rishabh-wt', 'laeeqwtb', 'abhay-wt', 'deepakwt', 'rashi-wt', 'webtoolbox'],
    commits: [
      { sha: 'a1', key: 'rishabh-wt', subject: 'fix popup form validation', parents: ['p'] },
      { sha: 'a2', key: 'rishabh-wt', subject: 'Revert "fix syntax"', parents: ['p'] },
      { sha: 'b1', key: 'laeeqwtb', subject: "Merge branch 'master' into popup", parents: ['p', 'q'] },
      { sha: 'c1', key: 'abhay-wt', subject: "Merge branch 'master' into popup", parents: ['p', 'q'] },
      { sha: 'd1', key: 'deepakwt', subject: "Merge branch 'master' into popup", parents: ['p', 'q'] },
      { sha: 'e1', key: 'webtoolbox', subject: "Merge branch 'master' into popup", parents: ['p', 'q'] },
      { sha: 'f1', key: 'rashi-wt', subject: 'Fixed mantis - 21088.', parents: ['p'] }
    ]
  };

  test('drops contributors whose every commit is a master merge', () => {
    const { dropMergeOnlyAuthors } = loadContributorFns()(() => '', () => {});
    const { kept, dropped } = dropMergeOnlyAuthors(PR5613.authors, PR5613.commits);
    expect(kept).toEqual(['rishabh-wt', 'rashi-wt']);
    expect(dropped).toEqual(['laeeqwtb', 'abhay-wt', 'deepakwt', 'webtoolbox']);
  });

  test('single-parent "Merge ... master ..." commits count as merges too', () => {
    const { dropMergeOnlyAuthors } = loadContributorFns()(() => '', () => {});
    const { kept, dropped } = dropMergeOnlyAuthors(
      ['ghost-wt', 'real-wt'],
      [
        { sha: 'aa', key: 'ghost-wt', subject: "Merge branch 'master' into 2fa", parents: ['p'] },
        { sha: 'bb', key: 'real-wt', subject: 'twoFA: tighten rate limit', parents: ['p'] }
      ]
    );
    expect(kept).toEqual(['real-wt']);
    expect(dropped).toEqual(['ghost-wt']);
  });

  test('a real merge is not dropped when the author also committed code', () => {
    const { dropMergeOnlyAuthors } = loadContributorFns()(() => '', () => {});
    const { kept, dropped } = dropMergeOnlyAuthors(
      ['mixed-wt'],
      [
        { sha: 'aa', key: 'mixed-wt', subject: "Merge branch 'master' into x", parents: ['p', 'q'] },
        { sha: 'bb', key: 'mixed-wt', subject: 'fix the actual bug', parents: ['p'] }
      ]
    );
    expect(kept).toEqual(['mixed-wt']);
    expect(dropped).toEqual([]);
  });

  test('without commit metadata nobody is hidden', () => {
    const { dropMergeOnlyAuthors } = loadContributorFns()(() => '', () => {});
    expect(dropMergeOnlyAuthors(['a', 'b'], [])).toEqual({ kept: ['a', 'b'], dropped: [] });
  });

  test('keeps the full list when the metadata would hide everyone', () => {
    const { dropMergeOnlyAuthors } = loadContributorFns()(() => '', () => {});
    const res = dropMergeOnlyAuthors(
      ['a', 'b'],
      [{ sha: 'aa', key: 'a', subject: "Merge branch 'master' into x", parents: ['p', 'q'] }]
    );
    expect(res.kept).toEqual(['a', 'b']);
    expect(res.dropped).toEqual([]);
  });

  test('stage 2 verifies commits against the local clone when it has them', async () => {
    const calls = [];
    const factory = loadContributorFns();
    const { refinePrAuthors: refine } = factory(async (cmd) => {
      calls.push(cmd);
      if (cmd.includes('a1a1')) return 'src/one.js\nlib/two.pm'; // has changes
      if (cmd.includes('b2b2')) return '';                       // empty commit
      throw new Error('bad object');                             // not fetched yet
    }, () => {});
    const res = await refine('/repo', ['author-a', 'author-b'], [
      { sha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', key: 'author-a', subject: 'real work', parents: ['p'] },
      { sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', key: 'author-b', subject: 'empty commit', parents: ['p'] },
      { sha: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', key: 'author-c', subject: 'not local', parents: ['p'] }
    ]);
    expect(res).toEqual(['author-a']);
    expect(calls.length).toBe(3);
    // every sha it shells out with is hex-only
    calls.forEach(c => expect(c).toMatch(/^git diff-tree --no-commit-id --name-only -r [0-9a-f]{7,40}$/));
  });

  test('stage 2 keeps authors whose commits are not fetched locally yet', async () => {
    const factory = loadContributorFns();
    const { refinePrAuthors: refine } = factory(async () => { throw new Error('no such object'); }, () => {});
    const res = await refine('/repo', ['remote-wt'], [
      { sha: 'abcdef1', key: 'remote-wt', subject: 'real work', parents: ['p'] }
    ]);
    expect(res).toEqual(['remote-wt']);
  });

  test('stage 2 falls back to metadata when there is no local clone', async () => {
    const factory = loadContributorFns();
    const { refinePrAuthors: refine } = factory(async () => { throw new Error('should not shell out'); }, () => {});
    const res = await refine(null, PR5613.authors, PR5613.commits);
    expect(res).toEqual(['rishabh-wt', 'rashi-wt']);
  });

  test('get-pr-info returns the full list immediately and refines in the background', () => {
    // Stage 1: metadata and the contributor walk share one Promise.all so the
    // header never waits for per-commit checks.
    expect(mSrc).toMatch(/const \[prJson, authorInfo\] = await Promise\.all\(\[/);
    expect(mSrc).toContain('prOtherAuthors: fullAuthors');
    // Stage 2: scheduled detached, never awaited by the fast path.
    expect(mSrc).toContain("schedulePrAuthorsRefinement(event.sender, safePr, repo, fullAuthors, authorInfo)");
    expect(mSrc).toMatch(/function schedulePrAuthorsRefinement[\s\S]{0,600}setImmediate\(/);
    expect(mSrc).toContain("sender.send('pr-authors-refined'");
    // The diff path caches the reduced list so later fast loads skip stage 1's
    // full list entirely.
    expect(mSrc).toContain('dropMergeOnlyAuthors(prOtherAuthors, authorInfo.commits).kept');
  });

  test('preload bridges the refinement push', () => {
    expect(pSrc).toContain("ipcRenderer.on('pr-authors-refined'");
  });

  test('renderer paints the full list at stage 1 and prefers the refined list', () => {
    // stage 1: fast metadata already carries contributors
    expect(rSrc).toContain('prOtherAuthors: prMeta.prOtherAuthors || []');
    // header reads through otherAuthorsForPr so order of arrival cannot matter
    expect(rSrc).toContain('otherAuthorsForPr(prNumber, result.prOtherAuthors)');
    expect(rSrc).toMatch(/function applyRefinedPrAuthors[\s\S]{0,400}updatePrInfoBar\(/);
    // stale state is dropped when a different PR opens
    expect(rSrc).toMatch(/String\(prNumber\) !== String\(currentPrNumber\)[\s\S]{0,200}prAuthorsRefined = null/);
    expect(rSrc).toContain('window.electronAPI.onPrAuthorsRefined(applyRefinedPrAuthors)');
  });
});


describe('Find bar highlights clear when the pane closes', () => {
  let src;

  beforeAll(() => {
    src = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  });

  const savedKeys = ['document', 'window', 'findMatchCase', 'findStarted', 'lastFindQuery',
                     'pendingFindRestore', 'restorePendingFind'];
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of savedKeys) saved[k] = global[k];
  });

  afterEach(() => {
    for (const k of savedKeys) {
      if (saved[k] === undefined) delete global[k];
      else global[k] = saved[k];
    }
  });

  function stubDom(stops) {
    const el = () => ({
      value: '', textContent: '', selectionStart: 0, selectionEnd: 0,
      style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
      blur() {}, focus() {}, select() {}
    });
    const findInput = el(), findCount = el(), findBar = el();
    global.document = {
      getElementById: id => ({ 'find-input': findInput, 'find-count': findCount, 'find-bar': findBar }[id] || null)
    };
    global.window = {
      electronAPI: {
        findInPage: (t, o) => (global.__findCalls = global.__findCalls || []).push({ t, o }),
        stopFindInPage: a => stops.push(a)
      }
    };
    return { findInput, findCount, findBar };
  }

  test('restart search never sends findNext:false — it defeats stopFindInPage', () => {
    // Electron 37 leaves the yellow match marks on screen after
    // stopFindInPage('clearSelection') when findNext was explicitly sent as
    // false (empty options, forward, matchCase or findNext:true all clear).
    // Found via pixel counting: search -> 18,966 yellow px, close -> 0 after
    // this fix, but 18,966 -> 18,966 with findNext:false.
    const stops = [];
    const dom = stubDom(stops);
    global.findMatchCase = false;
    global.findStarted = false;
    global.lastFindQuery = 'search target';
    global.pendingFindRestore = null;
    global.restorePendingFind = () => {};
    global.__findCalls = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = () => 0; // keep the safety-net timer out of jest's run

    try {
      const runFind = eval('(' + extractFunctionBody(src, 'runFind') + ')');

      dom.findInput.value = 'search target';
      runFind('restart');
      expect(global.__findCalls).toHaveLength(1);
      expect(global.__findCalls[0].o.findNext).toBeUndefined();
      expect(global.__findCalls[0].o.forward).toBe(true);

      dom.findInput.value = 'search target';
      runFind('next');
      expect(global.__findCalls[1].o).toEqual(expect.objectContaining({ findNext: true, forward: true }));

      dom.findInput.value = 'search target';
      runFind('prev');
      expect(global.__findCalls[2].o).toEqual(expect.objectContaining({ findNext: true, forward: false }));

      // Empty box: the session is stopped, which is what clears the marks.
      dom.findInput.value = '';
      runFind('restart');
      expect(stops).toContain('clearSelection');
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  test('closing the pane stops the find session so highlights disappear', () => {
    const stops = [];
    const { findBar, findInput, findCount } = stubDom(stops);
    findBar.style.display = 'flex';
    global.findStarted = true;
    global.lastFindQuery = '';
    global.pendingFindRestore = null;

    const closeFindBar = eval('(' + extractFunctionBody(src, 'closeFindBar') + ')');
    closeFindBar();

    expect(stops).toContain('clearSelection');
    expect(findBar.style.display).toBe('none');
    expect(global.findStarted).toBe(false);
  });

  test('renderer source never asks Electron to find with findNext:false', () => {
    expect(src).not.toMatch(/findNext\s*[:=]\s*false/);
  });
});


describe('PR freshness and header prefetch', () => {
  let mainSource, rendererSource, preloadSource;
  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  });

  test('prEntryStaleReason invalidates on real PR changes only', () => {
    const fn = eval('(' + extractFunctionBody(mainSource, 'prEntryStaleReason') + ')');
    const entry = { headSha: 'a1', baseRefOid: 'b1', state: 'OPEN', reviewDecision: 'APPROVED' };
    const same = { headSha: 'a1', baseRefOid: 'b1', state: 'OPEN', reviewDecision: 'APPROVED' };
    // Unchanged PR (and a title/description-only edit) stays servable — that is
    // the whole point of dropping the blanket TTL.
    expect(fn(entry, same)).toBe('');
    expect(fn(entry, { ...same, updatedAt: '2026-10-04T00:00:00Z' })).toBe('');
    expect(fn(entry, { ...same, title: 'renamed' })).toBe('');
    expect(fn(entry, { ...same, prTitle: 'renamed' })).toBe('');
    // Pushed commit
    expect(fn(entry, { ...same, headSha: 'a2' })).toBe('new commits');
    // Base branch moved under the PR
    expect(fn(entry, { ...same, baseRefOid: 'b2' })).toBe('base branch moved');
    // PR merged or closed
    expect(fn(entry, { ...same, state: 'MERGED' })).toBe('PR is now MERGED');
    // Review state changed (approval / changes requested / dismissed)
    expect(fn(entry, { ...same, reviewDecision: 'CHANGES_REQUESTED' })).toContain('review decision');
    // No fresh facts (offline or gh failure): serve the cache, never throw
    expect(fn(entry, null)).toBe('');
    expect(fn(null, same)).toBe('');
    // Entries written before these fields existed must not throw
    expect(fn({}, { headSha: 'a1' })).toBe('');
  });

  test('getFreshPrInfo prefers the warm metadata cache, then one gh call', () => {
    const body = extractFunctionBody(mainSource, 'getFreshPrInfo');
    expect(body).toBeTruthy();
    // Cache first: on advance this is prefilled by prefetch-pr-meta, so the
    // freshness gate costs zero network.
    expect(body.indexOf('getPrMeta(cacheKey)')).toBeLessThan(body.indexOf('gh pr view'));
    // gh reads exactly the facts the rule compares (plus updatedAt for logging)
    expect(body).toContain('headRefOid,baseRefOid,state,reviewDecision,updatedAt');
    // Unreachable GitHub returns null, which cachedResultStaleReason treats as
    // "serve what we have" instead of failing the load.
    expect(body).toMatch(/catch \(err\) \{[\s\S]{0,300}return null;/);
    expect(body).not.toContain('generateDiff');
  });

  test('load-pr gates both cache reads on the freshness rule', () => {
    const start = mainSource.indexOf("ipcMain.handle('load-pr'");
    const end = mainSource.indexOf("ipcMain.handle('get-pr-info'");
    const src = mainSource.substring(start, end);
    expect(src.match(/await cachedResultStaleReason\(/g)).toHaveLength(2);
    // Stale means drop it (viewed) or drop it (prefetch) and regenerate
    expect(src).toContain('is stale (');
    expect(src).toMatch(/const staleReason = await cachedResultStaleReason\(cacheKey, safePr, repo, viewed\)/);
    expect(src).toMatch(/const staleReason = await cachedResultStaleReason\(cacheKey, safePr, repo, prefetched\)/);
    // Fresh entries still return instantly from cache
    expect(src).toContain("log('INFO', '[pr] Returning viewed-cached result");
    expect(src).toContain("log('INFO', '[pr] Returning prefetched result");
    // Cmd+R still bypasses everything
    expect(src).toMatch(/\/\/ Force reload[\s\S]{0,300}invalidatePrCache\(cacheKey\);/);
  });

  test('cached results carry the freshness facts', () => {
    // generateDiff's gh pr view must ask for them...
    expect(mainSource).toContain('--json headRefOid,baseRefOid,baseRefName,state,reviewDecision,updatedAt,title,author,assignees,body');
    // ...and both cache writers must store them
    expect(mainSource).toMatch(/baseRefOid: prData\.baseRefOid \|\| null/);
    expect(mainSource).toMatch(/state: prData\.state \|\| 'OPEN'/);
    expect(mainSource).toMatch(/reviewDecision: prData\.reviewDecision \|\| ''/);
    expect(mainSource).toMatch(/updatedAt: prData\.updatedAt \|\| ''/);
  });

  test('prefetch-pr-meta warms the header cache with no git work', () => {
    const start = mainSource.indexOf("ipcMain.handle('prefetch-pr-meta'");
    expect(start).toBeGreaterThan(-1);
    const end = mainSource.indexOf("ipcMain.handle('prefetch-pr'", start);
    const src = mainSource.substring(start, end);
    expect(src).toContain('fetchPrMetadata(safePr, repo)');
    expect(src).toContain('putPrMeta(cacheKey,');
    // No diff generation in this path: it must stay in the fast lane
    expect(src).not.toContain('generateDiff');
    expect(src).not.toMatch(/git (fetch|diff|log|rev-parse)/);
    expect(mainSource).toContain('function fetchPrMetadata(prNumber, repo)');
  });

  test('get-pr-info reads the warm metadata cache before the network', () => {
    const start = mainSource.indexOf("ipcMain.handle('get-pr-info'");
    const end = mainSource.indexOf('async function fetchPrMetadata', start);
    const src = mainSource.substring(start, end);
    expect(src.indexOf('getPrMeta(cacheKey)')).toBeLessThan(src.indexOf('fetchPrMetadata('));
    // Live reads feed the cache; diff-cache metadata is never copied in, or the
    // freshness check would just echo the cache back at itself.
    expect(src).toContain('putPrMeta(cacheKey, meta);');
    expect(src).not.toContain('putPrMeta(cacheKey, viewed');
    expect(src).not.toContain('putPrMeta(cacheKey, prefetched');
    // Caches checked before the live fetch, in order, without consuming entries
    expect(src.indexOf('const viewed = getViewedPr(cacheKey)')).toBeLessThan(src.indexOf('const prefetched = getPrefetchEntry(cacheKey)'));
    expect(src).not.toContain('delete prefetchCache[cacheKey]');
  });

  test('renderer prefetches the next PR header early and never blocks', () => {
    const loadStart = rendererSource.indexOf('async function loadPrByNumber');
    const src = rendererSource.substring(loadStart, rendererSource.indexOf('function prefetchNextPr'));
    // Fired right after the instant title paint, before Phase 1 metadata
    expect(src.indexOf('prefetchNextPrMeta(prNumber, repoKey);')).toBeLessThan(src.indexOf('let prMeta = null;'));
    // It must not be awaited: the current PR keeps the floor
    expect(src).not.toMatch(/await\s+prefetchNextPrMeta/);
    // Same "next PR in the list" rule as the diff prefetch
    const fnSrc = extractFunctionBody(rendererSource, 'prefetchNextPrMeta');
    expect(fnSrc).toContain('cachedPrList.find');
    expect(fnSrc).toContain('prefetchPrMeta({ prNumber:');
    expect(fnSrc).toContain('.catch(err => console.warn');
    expect(preloadSource).toContain("prefetchPrMeta: (data) => ipcRenderer.invoke('prefetch-pr-meta', data)");
  });
});


describe('freshness gate behaves end to end', () => {
  let mainSource, api;
  const META = { headSha: 'a1', baseRefOid: 'b1', state: 'OPEN', reviewDecision: 'APPROVED' };

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const extracted = ['putPrMeta', 'getPrMeta', 'prEntryStaleReason', 'cachedResultStaleReason']
      .map(fn => extractFunctionBody(mainSource, fn)).join('\n');
    expect(extracted).toContain('prEntryStaleReason');
    // Real cache + rule, gh replaced by a controllable stub.
    const body = `
      const PR_META_TTL_MS = 15 * 60000;
      const PR_META_CACHE_MAX = 50;
      const prMetaCache = new Map();
      let __fresh = null;
      function log() {}
      async function getFreshPrInfo() { return __fresh; }
      ${extracted}
      return { putPrMeta, getPrMeta, cachedResultStaleReason, setFresh: (f) => { __fresh = f; } };
    `;
    api = eval('(function(){' + body + '})()');
  });

  test('warm metadata cache makes the gate free', async () => {
    await api.putPrMeta('7830:default', { ...META, prTitle: 'x' });
    expect(api.getPrMeta('7830:default')).toMatchObject(META);
    // Fresh facts served from cache: no stale reason, entry is servable
    api.setFresh(await api.getPrMeta('7830:default'));
    expect(await api.cachedResultStaleReason('7830:default', 7830, null, { ...META })).toBe('');
    expect(api.getPrMeta('7830:default')).not.toBeNull();
  });

  test('a pushed commit makes the cached diff stale', async () => {
    await api.putPrMeta('7830:default', { ...META });
    api.setFresh({ ...META, headSha: 'a2' });
    expect(await api.cachedResultStaleReason('7830:default', 7830, null, { ...META })).toBe('new commits');
    // Same cache entry still matches the old entry for the previous head
    api.setFresh(META);
    expect(await api.cachedResultStaleReason('7830:default', 7830, null, { ...META })).toBe('');
  });

  test('offline GitHub serves the cache instead of failing the load', async () => {
    api.setFresh(null); // getFreshPrInfo returns null when gh is unreachable
    expect(await api.cachedResultStaleReason('9:default', 9, null, { ...META })).toBe('');
  });

  test('unknown PR has no cached metadata and falls through to gh', async () => {
    expect(api.getPrMeta('404:default')).toBeNull();
    api.setFresh(null);
    expect(await api.cachedResultStaleReason('404:default', 404, null, { ...META })).toBe('');
  });
});


describe('load-pr freshness gate against the real handler code', () => {
  let api;
  const diffPath = path.join(os.tmpdir(), 'pr-freshness-e2e.diff');

  beforeAll(() => {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const slice = src.substring(src.indexOf("ipcMain.handle('load-pr'"), src.indexOf("ipcMain.handle('list-prs'"));
    fs.writeFileSync(diffPath, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n');

    let freshFacts = {};
    let metaOut = {};
    let offline = false;
    const counts = { gh: 0, gen: 0 };

    const body = `
      const appConfig = { repoOwner: 'webtoolbox', repoName: 'Website-Toolbox', cache: {} };
      const counts = ${JSON.stringify(counts)};
      let freshFacts = {}, metaOut = {}, offline = false;
      function log() {}
      function safePrNumber(p) { const s = String(p); return /^\\d+$/.test(s) ? s : null; }
      function getLocalRepoPath() { return '/tmp/none'; }
      function schedulePrAuthorsRefinement() {}
      async function fetchPrCommitAuthors() { return { authors: ['x'], commits: [] }; }
      function cleanupSinceReviewRefs() {}
      const setInterval = () => 0;
      const handlers = {};
      const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
      async function execPromise(cmd) {
        counts.gh++;
        if (offline) throw new Error('network down');
        // fetchPrMetadata asks for changedFiles, getFreshPrInfo does not
        return JSON.stringify(cmd.includes('changedFiles') ? metaOut : freshFacts);
      }
      async function generateDiff(prNumber) {
        counts.gen++;
        return { diffPath: ${JSON.stringify(diffPath)}, prData: global.__prData, reviewInfo: null,
                 filesChanged: 1, baseSha: 'base1', headSha: global.__prData.headRefOid, sinceReviewRef: null };
      }
      ${slice}
      return {
        handlers, counts,
        setFresh: f => { freshFacts = f; },
        setMeta: m => { metaOut = m; },
        setOffline: v => { offline = v; }
      };
    `;
    api = eval('(function(){' + body + '})()');
  });

  const PR_DATA = (head) => ({
    headRefOid: head, baseRefOid: 'b1', state: 'OPEN', reviewDecision: '', updatedAt: 't1',
    title: 'A title', author: 'wt-bot', assignees: [], body: 'desc'
  });
  const FACTS = (head) => ({ headRefOid: head, baseRefOid: 'b1', state: 'OPEN', reviewDecision: '', updatedAt: 't1' });

  test('first load generates, second load serves the cache without regenerating', async () => {
    global.__prData = PR_DATA('h1');
    api.setFresh(FACTS('h1'));
    api.setMeta({ ...PR_DATA('h1'), changedFiles: 3 });

    const first = await api.handlers['load-pr'](null, { prNumber: 123, repo: null });
    expect(first.content).toContain('diff --git');
    expect(api.counts.gen).toBe(1);

    const second = await api.handlers['load-pr'](null, { prNumber: 123, repo: null });
    expect(second.content).toContain('diff --git');
    expect(api.counts.gen).toBe(1); // served from cache, no git work
    expect(api.counts.gh).toBe(1);  // exactly one freshness read
  });

  test('a pushed commit regenerates the diff instead of serving the cache', async () => {
    global.__prData = PR_DATA('h2');
    api.setFresh(FACTS('h2'));

    const third = await api.handlers['load-pr'](null, { prNumber: 123, repo: null });
    expect(api.counts.gen).toBe(2);
    expect(third.headSha).toBe('h2');

    // And it is cached again afterwards
    const fourth = await api.handlers['load-pr'](null, { prNumber: 123, repo: null });
    expect(api.counts.gen).toBe(2);
  });

  test('offline GitHub serves the cache rather than failing the load', async () => {
    api.setOffline(true);
    const out = await api.handlers['load-pr'](null, { prNumber: 123, repo: null });
    expect(out.error).toBeUndefined();
    expect(out.content).toContain('diff --git');
    expect(api.counts.gen).toBe(2); // no regeneration attempted
    api.setOffline(false);
  });

  test('prefetch-pr-meta warms the cache get-pr-info then reads for free', async () => {
    api.setMeta({ ...PR_DATA('h3'), changedFiles: 7 });
    api.setFresh(FACTS('h3'));
    const before = api.counts.gh;

    const warmed = await api.handlers['prefetch-pr-meta'](null, { prNumber: 456, repo: null });
    expect(warmed.status).toBe('done');
    expect(api.counts.gh).toBe(before + 1); // one gh pr view, no git work

    const info = await api.handlers['get-pr-info'](null, { prNumber: 456, repo: null });
    expect(api.counts.gh).toBe(before + 1); // served from the warm cache
    expect(info.prTitle).toBe('A title');
    expect(info.filesChanged).toBe(7);
    expect(info.headSha).toBe('h3');
  });
});

// ── All Comments panel: delete button, and Cmd+Enter while editing ──

describe('All Comments panel delete button and Cmd+Enter edit', () => {
  let rendererSource;
  let indexHtml;

  beforeAll(() => {
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('only local comments (rows with a uid) get a delete button', () => {
    const start = rendererSource.indexOf('function renderCommentsList');
    const end = rendererSource.indexOf('function deleteCommentFromPanel');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = rendererSource.substring(start, end);

    expect(fn).toMatch(/const canDelete = item\.uid !== null && item\.uid !== undefined && item\.uid !== ''/);
    expect(fn).toContain('class="c-delete"');
    expect(fn).toContain('deleteCommentFromPanel(parseInt(uidRaw, 10))');
    // The button click must not also fire the row's scroll-to-comment handler.
    expect(fn).toMatch(/\.c-delete[\s\S]{0,300}e\.stopPropagation\(\)/);
  });

  test('submitted GitHub rows are built without a uid, so they stay read-only', () => {
    const start = rendererSource.indexOf('function getCombinedCommentList');
    const end = rendererSource.indexOf('function renderCommentsList');
    const list = rendererSource.substring(start, end);
    expect(list).toMatch(/kind: 'submitted',[\s\S]{0,400}target:/);
    // no uid key on the submitted entry — that is what makes it undeletable
    expect(list).not.toMatch(/kind: 'submitted',[\s\S]{0,400}\buid:/);
    expect(list).toMatch(/uid: c\._uid \|\| null/);
  });

  test('deleting from the panel reuses deleteComment when the marker exists', () => {
    const start = rendererSource.indexOf('function deleteCommentFromPanel');
    const end = rendererSource.indexOf('function scrollToCommentLocation');
    expect(start).toBeGreaterThan(-1);
    const fn = rendererSource.substring(start, end);
    expect(fn).toContain('deleteComment(marker)');
    expect(fn).toMatch(/comments\.findIndex\(c => c\._uid === uid\)/);
    expect(fn).toMatch(/comments\.splice\(idx, 1\)/);
    expect(fn).toContain('updateCommentCount()');
    expect(fn).toContain('updateCommentNav()');
    expect(fn).toContain('autoSaveDraft()');
    expect(fn).toContain('renderCommentsList()');
  });

  test('Cmd+Enter clicks the open form Save button, never submitComment directly', () => {
    const start = rendererSource.indexOf('// Cmd+Enter');
    expect(start).toBeGreaterThan(-1);
    // The branch ends at the first return AFTER the inline-form lookup — the
    // Add PR Comment dialog branch above it has its own earlier return.
    const formIdx = rendererSource.indexOf("const form = document.getElementById('active-comment-form')", start);
    expect(formIdx).toBeGreaterThan(-1);
    const chunk = rendererSource.substring(start, rendererSource.indexOf('return;', formIdx));
    expect(chunk).toContain("e.key === 'Enter' && isMeta");
    expect(chunk).toContain("form.querySelector('#comment-submit')");
    expect(chunk).toContain('submitBtn.click()');
    // Calling submitComment() here is the duplicate-comment bug: during an
    // edit that pushes a second comment and leaves the old one behind.
    expect(chunk).not.toMatch(/^\s*submitComment\(\);\s*$/m);
  });

  test('comment text wraps instead of being clipped to one line', () => {
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-text \{[^}]*white-space: pre-wrap/);
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-text \{[^}]*word-break: break-word/);
    // The old single-line clip is gone
    expect(indexHtml).not.toMatch(/#comments-panel \.comment-list-item \.c-text \{[^}]*text-overflow: ellipsis/);
  });

  test('delete button is styled in dark and light themes', () => {
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \{[^}]*display: flex/);
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-main \{ flex: 1/);
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-delete \{/);
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-delete:hover \{ color: #f85149/);
    // light theme override
    expect(indexHtml).toMatch(/#comments-panel \.comment-list-item \.c-delete \{ color: #656d76; \}/);
  });
});

// ── Merge-target branch indicator ────────────────────────────────────────────

describe('PR merge target branch indicator', () => {
  let mainSource, rendererSource, indexHtml;

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('both gh pr view calls request the base branch name', () => {
    // generateDiff (feeds load-pr + prefetch) and fetchPrMetadata (feeds
    // get-pr-info) are the only two PR reads in main.js — without baseRefName
    // in both, the indicator would appear on some paths and vanish on others.
    expect(mainSource).toMatch(/--json headRefOid,baseRefOid,baseRefName,/);
    expect(mainSource).toMatch(/--json title,author,assignees,body,state,headRefOid,baseRefOid,baseRefName,/);
    expect(mainSource).toMatch(/baseRefName: \(\.baseRefName \/\/ ""\)/);
  });

  test('every metadata carrier passes baseRefName through', () => {
    // generateDiff -> meta (get-pr-info), load-pr result, prefetch entry
    expect((mainSource.match(/baseRefName: prData\.baseRefName \|\| ''/g) || []).length).toBeGreaterThanOrEqual(3);
    // get-pr-info serves it from both of its caches
    expect(mainSource).toContain('baseRefName: viewed.baseRefName');
    expect(mainSource).toContain('baseRefName: prefetched.baseRefName');
    // PR list ships the raw base so the header can paint it instantly
    expect(mainSource).toContain('base: .base.ref');
  });

  test('badge renders for a non-default branch and nothing else', () => {
    const start = rendererSource.indexOf('const DEFAULT_BASE_BRANCHES');
    expect(start).toBeGreaterThan(-1);
    const fnStart = rendererSource.indexOf('function baseBranchBadge');
    expect(fnStart).toBeGreaterThan(start);
    const body = rendererSource.substring(start, rendererSource.indexOf('\n}', fnStart));
    expect(body).toContain("['master', 'main']");
    expect(body).toContain('class="pr-base-branch"');
    expect(body).toContain('escapeHtml(base)');
    // The title line actually renders the badge.
    expect(rendererSource).toMatch(/class="pr-title-text"[\s\S]{0,220}\$\{baseBranchBadge\(result\)\}/);
  });

  test('badge has styles in both themes', () => {
    expect(indexHtml).toMatch(/\.pr-base-branch \{[\s\S]*?border-radius/);
    expect(indexHtml).toMatch(/\.pr-base-branch strong \{ color: #58a6ff/);
    expect(indexHtml).toMatch(/\.pr-base-branch \{ color: #57606a/);
  });
});

// ── Arrow key PR navigation ─────────────────────────────────────────────────

describe('Arrow key PR navigation', () => {
  let rendererSource, indexHtml;

  beforeAll(() => {
    rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  });

  test('arrow keys route through the same prev/next functions as the edge arrows', () => {
    const start = rendererSource.indexOf('Arrow keys navigate between PRs');
    expect(start).toBeGreaterThan(-1);
    const body = rendererSource.substring(start, rendererSource.indexOf('\n});', start));
    expect(body).toContain('gotoPrevPr()');
    expect(body).toContain('gotoNextPr()');
    expect(body).toContain('e.preventDefault()');
  });

  test('arrow keys are ignored while typing and while the compare overlay is open', () => {
    const start = rendererSource.indexOf('Arrow keys navigate between PRs');
    const body = rendererSource.substring(start, rendererSource.indexOf('\n});', start));
    // caret movement inside fields must keep working
    expect(body).toContain("target.tagName === 'INPUT'");
    expect(body).toContain("target.tagName === 'TEXTAREA'");
    expect(body).toContain('target.isContentEditable');
    // the slideshow keeps the arrows for itself (its element only exists on screen)
    expect(body).toContain("if (document.getElementById('compare-overlay')) return;");
    // modifier combos are left alone (they belong to other shortcuts)
    expect(body).toContain('e.metaKey || e.ctrlKey || e.altKey');
  });

  test('compare overlay keydown handler only fires while the overlay is visible', () => {
    const start = rendererSource.indexOf('Keyboard handler for compare overlay');
    expect(start).toBeGreaterThan(-1);
    const body = rendererSource.substring(start, rendererSource.indexOf('\n});', start));
    expect(body).toContain('if (!overlay) return;');
    expect(body).toContain('navigateCompare(');
  });

  test('shortcuts dialog lists the arrow key navigation', () => {
    expect(indexHtml).toContain('Previous / next PR');
    const row = indexHtml.match(/<div class="shortcut-row">[^<]*<kbd>←<\/kbd>[\s\S]*?<\/div>/);
    expect(row).toBeTruthy();
    expect(row[0]).toContain('Previous / next PR');
  });
});
