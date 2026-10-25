/**
 * detectBeforeAfterPairs(prBody) -> [{ before: [url, ...], after: [url, ...] }, ...]
 *
 * SINGLE SOURCE for the before/after screenshot-pair detector.
 *   - index.html loads this file as a script BEFORE renderer.js (browser global)
 *   - unit.test.js requires it under jest (module.exports)
 * Do not copy this function anywhere — the old unit.test.js copy drifted
 * (string-shaped pairs, different label windows) and hid real bugs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.detectBeforeAfterPairs = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// Detect before/after image pairs from raw markdown text
function detectBeforeAfterPairs(prBody) {
  if (!prBody || typeof prBody !== 'string') return [];

  const pairs = [];
  const lines = prBody.split('\n');
  // Match both markdown ![alt](url) and HTML <img src="url"> tags (http, https, or file://)
  const imageUrlRegex = /!\[.*?\]\(((?:https?|file):\/\/[^\s)]+)\)|src="((?:https?|file):\/\/[^"]+)"/g;

  // Collect all images from a range of lines
  function collectImages(fromLine, toLine) {
    const urls = [];
    for (let j = fromLine; j <= Math.min(toLine, lines.length - 1); j++) {
      const line = lines[j];
      let m;
      imageUrlRegex.lastIndex = 0;
      while ((m = imageUrlRegex.exec(line)) !== null) {
        urls.push(m[1] || m[2]);
      }
    }
    return urls;
  }

  function isBeforeLabel(line) {
    return /^#{1,6}\s+.*before/i.test(line) ||
           /^\*{1,2}\s*before\s*:?\s*\*{0,2}/i.test(line) ||
           /^before(?:\s+\d+)?\s*:/i.test(line) ||
           /^(?:before)\s*:?\s*$/i.test(line) ||
           /^\*{1,2}\s*(?:before)\s*:?\s*\*{0,2}$/i.test(line);
  }

  function isAfterLabel(line) {
    return /^#{1,6}\s+.*after/i.test(line) ||
           /^\*{1,2}\s*after\s*:?\s*\*{0,2}/i.test(line) ||
           /^after(?:\s+\d+)?\s*:/i.test(line) ||
           /^(?:after)\s*:?\s*$/i.test(line) ||
           /^\*{1,2}\s*(?:after)\s*:?\s*\*{0,2}$/i.test(line);
  }

  // Find all before/after sections and collect ALL images under each
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!isBeforeLabel(line)) continue;

    // Collect all images between this "Before:" label and the next "After:" label
    let beforeImages = [];
    let afterImages = [];
    let afterStart = -1;

    // Find the next "After:" label
    for (let k = i + 1; k <= Math.min(i + 20, lines.length - 1); k++) {
      if (isAfterLabel(lines[k].trim())) {
        afterStart = k;
        break;
      }
    }

    if (afterStart < 0) continue;

    // Collect before images: from line after "Before:" to line before "After:"
    beforeImages = collectImages(i + 1, afterStart - 1);

    // Collect after images: from line after "After:" to next before/after heading or end
    let afterEnd = lines.length - 1;
    for (let k = afterStart + 1; k < lines.length; k++) {
      const l = lines[k].trim();
      if (isBeforeLabel(l) || isAfterLabel(l)) {
        afterEnd = k - 1;
        break;
      }
      // Also stop at a new heading (### ...) that's not before/after
      if (/^#{1,6}\s+/.test(l) && !isBeforeLabel(l) && !isAfterLabel(l)) {
        afterEnd = k - 1;
        break;
      }
    }
    afterImages = collectImages(afterStart + 1, afterEnd);

    if (beforeImages.length > 0 && afterImages.length > 0) {
      pairs.push({ before: beforeImages, after: afterImages });
    }

    // Skip past this section
    i = afterEnd;
  }

  return pairs;
}

  return detectBeforeAfterPairs;
});
