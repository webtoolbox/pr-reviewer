/**
 * Hidden file paths — the config-driven counterpart of the extension filter.
 *
 * The extension filter is a runtime UI (the funnel button unchecks an
 * extension). Paths are an internal config option: `diff.hiddenPaths` in
 * config.json / ~/.config/pr-reviewer/config.json, e.g. ["/tests/**"].
 *
 * SINGLE SOURCE for the matcher:
 *   - index.html loads this file as a script BEFORE renderer.js (browser global)
 *   - unit.test.js requires it under jest (module.exports)
 * Do not copy this logic into renderer.js — the two copies would drift.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.HiddenPaths = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Regex metacharacters that must be escaped in a literal path segment.
  var REGEX_SPECIALS = '\\^$.|+()[]{}';

  // Compile one glob pattern to an anchored RegExp:
  //   *   any run of characters except '/'
  //   **  any run of characters, '/' included
  //   ?   exactly one character except '/'
  function globToRegExp(pattern) {
    var re = '^';
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern[i];
      if (ch === '*') {
        if (pattern[i + 1] === '*') { re += '.*'; i++; }
        else { re += '[^/]*'; }
      } else if (ch === '?') {
        re += '[^/]';
      } else if (REGEX_SPECIALS.indexOf(ch) !== -1) {
        re += '\\' + ch;
      } else {
        re += ch;
      }
    }
    return new RegExp(re + '$');
  }

  // Patterns are matched against the repo-root-relative path as it appears in
  // the diff ('modules/Members/Foo.pm'), always prefixed with '/' so a LEADING
  // slash anchors the pattern to the repo root:
  //   '/tests/**'  -> matches 'tests/a.js', never 'app/tests/a.js'
  //   'tests/**'   -> matches at any depth, including 'app/tests/a.js'
  //   '*.min.js'   -> also 'any/depth/x.min.js' (a pattern with no slash is not
  //                   anchored, same as gitignore)
  function matchesHiddenPath(filePath, pattern) {
    if (!filePath || typeof pattern !== 'string') return false;
    var clean = pattern.trim().replace(/^\.\//, '');
    if (!clean) return false;
    var anchored = clean.charAt(0) === '/';
    var body = anchored ? clean.slice(1) : clean;
    if (!body) return false;
    // A pattern that already opens with '**/' is not anchored, so it needs no
    // extra prefix — '**/**/*.min.js' would demand two directory levels.
    var prefix = anchored ? '/' : (body.indexOf('**/') === 0 ? '' : '**/');
    // Accept any spelling of the same path: './tests/a.js', '/tests/a.js',
    // 'tests/a.js' all become '/tests/a.js'.
    var target = '/' + String(filePath).replace(/^\.\//, '').replace(/^\/+/, '');
    return globToRegExp(prefix + body).test(target);
  }

  // True when the file path matches ANY of the configured patterns.
  function isHiddenPath(filePath, patterns) {
    if (!filePath || !Array.isArray(patterns) || patterns.length === 0) return false;
    for (var i = 0; i < patterns.length; i++) {
      if (matchesHiddenPath(filePath, patterns[i])) return true;
    }
    return false;
  }

  // Config may hold an array of globs or one comma-separated string. Undefined,
  // non-string and blank entries are dropped, so a stray value can never end up
  // hiding every file in the diff.
  function normalizeHiddenPaths(value) {
    var list = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] === 'string' && list[i].trim()) out.push(list[i].trim());
    }
    return out;
  }

  return {
    globToRegExp: globToRegExp,
    matchesHiddenPath: matchesHiddenPath,
    isHiddenPath: isHiddenPath,
    normalizeHiddenPaths: normalizeHiddenPaths
  };
});
