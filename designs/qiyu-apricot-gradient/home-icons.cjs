// Homepage icon set selected by the user: A2 / exec-cf1ffcb2.
// Voice and memory share the already approved navigation contours.
// Match all four optical footprints; keep open gaps in the left-hand glyphs.
const nav = require('./nav-icons.cjs');
const svg = paths => `<svg class="qiyu-home-glyph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
module.exports = {
  homeChat: svg('<path d="M29.8 15.3C29.8 22.1 24 27 16.1 27C13.6 27 11.2 26.5 9.1 25.4L2.2 28.4L4.5 21.5C3 19.7 2.2 17.6 2.2 15.3C2.2 8.4 8.3 3.6 16.1 3.6C22 3.6 27 6.4 29 10.8"/>'),
  homeVoice: nav.navCompanion.replace('qiyu-nav-glyph','qiyu-home-glyph'),
  homeMoment: svg('<path d="M29.8 15V7.7A3.2 3.2 0 0 0 26.6 4.5H5.4A3.2 3.2 0 0 0 2.2 7.7V24.3A3.2 3.2 0 0 0 5.4 27.5H26.6C28.4 27.5 29.2 26.9 28 25.7L18.2 18.3C16.7 17.2 15.6 17.2 14.1 18.3L3.6 26.1"/><circle cx="9" cy="11" r="2.2"/>'),
  homeMemory: nav.navMemory.replace('qiyu-nav-glyph','qiyu-home-glyph')
};
