// Which repositories this app is allowed to WRITE to.
//
// The app keeps its own clones under <appData>/repos (and its own worktrees),
// and everything it fetches, checks out, merges or writes must stay inside
// them. Any other path is a checkout the reviewer has open in their editor:
// fetching a PR head into it leaves pr-<N> branches behind, `git worktree
// add`/`remove` and `git checkout` change what they are working on (their
// Website-Toolbox checkout really was switched to a PR branch this way, and a
// half-finished merge of master was left in it).
//
// Read-only commands (git show / git log / git diff with explicit refs) are
// fine anywhere, so this only gates the mutating call sites.
//
// UMD: `require()`-d by main.js in the app and by unit.test.js, so the rule
// lives in exactly one place.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoGuard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function clean(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
  }

  /**
   * True when repoPath is a checkout the app owns and may write to.
   * @param {string} repoPath
   * @param {{appDataDir?: string, tmpDir?: string}} [opts] app data dir (holds
   *        repos/ and worktrees/) and the OS temp dir (holds pr-reviewer-*
   *        worktrees created for since-review replays)
   */
  function isAppOwnedRepoPath(repoPath, opts) {
    const p = clean(repoPath);
    if (!p) return false;
    const o = opts || {};
    const appData = clean(o.appDataDir);
    if (appData) {
      if (p === appData + '/repos') return true;
      if (p.startsWith(appData + '/repos/')) return true;
      if (p.startsWith(appData + '/worktrees/')) return true;
    }
    const tmp = clean(o.tmpDir);
    if (tmp && p.startsWith(tmp + '/pr-reviewer')) return true;
    return false;
  }

  return { isAppOwnedRepoPath: isAppOwnedRepoPath };
});
