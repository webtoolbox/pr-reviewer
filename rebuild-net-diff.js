// Rebuild the since-review net diff by swapping conflicted files' replayed
// diffs for the author's residue (what the branch changed relative to master).
// Extracted from main.js so the logic is testable without Electron.
//
// Behavior contract (regression history):
// - #7359: a file taken via `--theirs` carries every master change the branch
//   absorbed, so conflicted files must come from the residue, not the replay.
// - #6460: execPromise resolves stdout.trim(), so a residue never ends with a
//   newline. Pushing it raw glued the next file's `diff --git` header onto the
//   residue's last line and diff2html merged two files into one section
//   (heading of file A over hunks of file B). Every pushed piece must end
//   with exactly one newline so each `diff --git` separator starts its line.

// Split a unified diff into one chunk per file, each carrying its path.
// Lines before the first `diff --git` header are dropped.
function splitPerFileDiff(diffText) {
  const text = String(diffText || '');
  if (!text) return [];
  const chunks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) chunks.push(current);
      const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\s*$/);
      const raw = m && m[2] ? m[2] : line.slice('diff --git '.length);
      current = {
        path: raw.replace(/^"|"$/g, '').replace(/\\([ "\\])/g, '$1'),
        text: line + '\n',
      };
    } else if (current) {
      current.text += line + '\n';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Every `diff --git` separator in assembled diff text must start its own
// line, or diff2html merges the sections and the heading no longer matches
// the content below it.
function hasGluedSeparators(diffText) {
  return String(diffText || '')
    .split('\n')
    .some((line) => line.includes('diff --git ') && !line.startsWith('diff --git '));
}

// Rebuild a net diff: non-conflicted files keep the replayed text verbatim,
// conflicted files are replaced by their residue.
//
//   netDiff        - full replayed diff text (git diff output)
//   conflictedPaths- Set (or array) of paths that conflicted during replay
//   residues       - { [path]: residue diff text } as execPromise returns it
//                    (i.e. TRIMMED — no trailing newline); a missing/empty
//                    residue means the file has no author changes vs master
//
// Returns { diff, replacedFiles, leftOutFiles }.
function rebuildNetDiff(netDiff, conflictedPaths, residues) {
  const conflicted =
    conflictedPaths instanceof Set ? conflictedPaths : new Set(conflictedPaths || []);
  const residueMap = residues || {};
  const rebuilt = [];
  // Keep every non-conflicted file exactly as the replay produced it.
  for (const chunk of splitPerFileDiff(netDiff)) {
    if (!chunk.path || !conflicted.has(chunk.path)) rebuilt.push(chunk.text);
  }
  // Re-derive conflicted files from the residue. Preserve the separator: a
  // trimmed residue must get its trailing newline back before the next
  // section's `diff --git` line follows it (#6460).
  const replacedFiles = [];
  const leftOutFiles = [];
  for (const file of conflicted) {
    const residue = residueMap[file];
    if (residue) {
      rebuilt.push(residue.endsWith('\n') ? residue : `${residue}\n`);
      replacedFiles.push(file);
    } else {
      leftOutFiles.push(file);
    }
  }
  return { diff: rebuilt.join(''), replacedFiles, leftOutFiles };
}

module.exports = { splitPerFileDiff, rebuildNetDiff, hasGluedSeparators };
