'use strict';

// Set to true (and reload the extension) to get scan/hide counts in the
// console — useful for telling whether Instagram's markup has drifted out
// from under the selectors below.
const DEBUG = true;

// Instagram's class names are obfuscated and change often, so detection
// leans on signals that are unlikely to change: a reel permalink link, the
// `article[data-interactable="|click|"]` wrapper Instagram uses for
// feed/reel/explore items (found via live inspection), and the visible
// "Follow" text Instagram shows for accounts you don't already follow.
// Tweak here first if the filter stops working.
const SELECTORS = {
  // Coarse pre-filter for querySelectorAll — cheap to run broadly, then
  // narrowed precisely by REEL_LINK_PATTERN below. Needed because Instagram
  // also uses "/reel(s)/" for non-permalink links, e.g. /reels/audio/<id>/.
  reelLinkCoarse: 'a[href*="/reel"]',
  articleContainer: 'article[data-interactable="|click|"]',
  // Fallback container guess, used only if an article doesn't match the
  // precise selector above.
  containerCandidates: ['article', 'div[role="presentation"]', 'section'],
};

// An actual reel permalink is /reel/<code>/ or /reels/<code>/ — Instagram
// has used both singular and plural over time. This excludes the bare
// /reels/ tab link and multi-segment links like /reels/audio/<id>/.
const REEL_LINK_PATTERN = /^\/reels?\/[^/?#]+\/?(?:[?#].*)?$/;

// Word-boundary match so "Follow" / "Follow Back" hit but "Following" and
// "Requested" (already following / request pending) don't — a plain
// substring check would false-positive on "Following" since it literally
// contains the characters "follow".
const FOLLOW_TEXT_PATTERN = /\bfollow\b/i;

const DEFAULT_STATE = {
  filterEnabled: true,
  scopeHome: true,
  scopeReels: true,
  scopeExplore: true,
};

let state = { ...DEFAULT_STATE };
const stats = { scanned: 0, hidden: 0 };

function log(...args) {
  if (DEBUG) console.log('[NoScroll]', ...args);
}

function surfaceForPath(pathname) {
  if (pathname === '/') return 'scopeHome';
  if (pathname.startsWith('/reels/')) return 'scopeReels';
  if (pathname.startsWith('/explore/')) return 'scopeExplore';
  return null; // profile pages and everything else are out of scope for now
}

function currentSurfaceEnabled() {
  const surfaceKey = surfaceForPath(location.pathname);
  if (!surfaceKey) return false;
  return Boolean(state.filterEnabled && state[surfaceKey]);
}

function findReelContainer(anchor) {
  const container = anchor.closest(SELECTORS.containerCandidates.join(', '));
  return container || anchor.parentElement;
}

function hasFollowText(container) {
  // innerText (not textContent) so adjacent block-level text gets a real
  // separator — textContent concatenates with nothing between elements
  // (e.g. "...Slow LifeFollow"), which can swallow the word boundary
  // \bfollow\b relies on to avoid matching inside "Following".
  const text = container.innerText || container.textContent;
  return FOLLOW_TEXT_PATTERN.test(text);
}

function isReelLink(anchor) {
  return REEL_LINK_PATTERN.test(anchor.getAttribute('href') || '');
}

function findReelLink(container) {
  const candidates = container.querySelectorAll(SELECTORS.reelLinkCoarse);
  for (const anchor of candidates) {
    if (isReelLink(anchor)) return anchor;
  }
  return null;
}

// Instagram's Reels/Home feeds are virtualized: it reuses the same article
// and anchor DOM nodes as you scroll, just swapping their content/href for
// the next reel. So containers can't be marked "done" once and skipped —
// instead each is keyed by its *current* reel link, and re-evaluated
// whenever that key changes (i.e. the node got recycled for a new reel).
function decideReel(container) {
  if (!container) return;

  const reelLink = findReelLink(container);
  if (!reelLink) return; // a regular post, not a reel — leave it alone

  const key = reelLink.getAttribute('href');
  if (!key || container.dataset.noscrollKey === key) {
    applyVisibilityTo(container); // unchanged reel, just sync class to state
    return;
  }

  container.dataset.noscrollKey = key;
  stats.scanned += 1;

  const shouldHide = hasFollowText(container);
  container.dataset.noscrollHide = shouldHide ? '1' : '0';
  if (shouldHide) {
    stats.hidden += 1;
    log('flagged reel for hiding:', key);
  }

  applyVisibilityTo(container);
}

function applyVisibilityTo(container) {
  const enabled = currentSurfaceEnabled();
  const shouldHide = enabled && container.dataset.noscrollHide === '1';
  container.classList.toggle('noscroll-hidden-reel', shouldHide);
}

// Re-syncs every already-decided container to the current on/off + scope
// state — used when a toggle changes, not when new reels load in.
function applyVisibility() {
  document.querySelectorAll('[data-noscroll-key]').forEach(applyVisibilityTo);
}

function scan() {
  const surfaceKey = surfaceForPath(location.pathname);
  if (!surfaceKey) return;

  // Primary: the precise container Instagram actually uses.
  document.querySelectorAll(SELECTORS.articleContainer).forEach(decideReel);

  // Fallback: walk up from any reel link, in case Instagram renders a reel
  // outside that exact article shape. decideReel is idempotent per key, so
  // re-checking containers already handled above is harmless.
  document.querySelectorAll(SELECTORS.reelLinkCoarse).forEach((anchor) => {
    if (!isReelLink(anchor)) return;
    decideReel(findReelContainer(anchor));
  });

  log(`scan complete — decided so far: ${stats.scanned}, hidden so far: ${stats.hidden}`);
}

function ensureStyleTag() {
  const id = 'noscroll-style';
  if (document.getElementById(id)) return;

  const style = document.createElement('style');
  style.id = id;
  style.textContent = '.noscroll-hidden-reel { display: none !important; }';
  document.head.appendChild(style);
}

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 150);
}

// Instagram is a client-side router — it never does a full page load when
// moving between Home, Reels and Explore, so patch history + popstate to
// notice those transitions and re-evaluate scope immediately.
function watchForNavigation(onChange) {
  const wrapHistoryMethod = (methodName) => {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      onChange();
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', onChange);
}

function init() {
  log('content script loaded');
  ensureStyleTag();

  chrome.storage.local.get(DEFAULT_STATE, (stored) => {
    state = { ...DEFAULT_STATE, ...stored };
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    let relevant = false;
    for (const key of Object.keys(changes)) {
      if (key in DEFAULT_STATE) {
        state[key] = changes[key].newValue;
        relevant = true;
      }
    }
    if (relevant) applyVisibility();
  });

  // attributes+characterData catch the recycled-node case: Instagram often
  // swaps a reused article's href/text in place for the next reel rather
  // than adding/removing DOM nodes, which a childList-only observer misses.
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
    characterData: true,
  });

  watchForNavigation(scheduleScan);
}

init();
