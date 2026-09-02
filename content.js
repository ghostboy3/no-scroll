'use strict';

// Set to true (and reload the extension) to get scan/hide counts in the
// console — useful for telling whether Instagram's markup has drifted out
// from under the selectors below.
const DEBUG = true;

// Instagram's class names are obfuscated and change often, so detection
// leans on signals that are unlikely to change: a post/reel permalink
// link, the `article[data-interactable="|click|"]` wrapper Instagram uses
// for feed/reel/explore items (found via live inspection), the visible
// "Follow" text Instagram shows for accounts you don't already follow, and
// the "Suggested for you" screen-reader text Instagram attaches to
// recommended posts that don't get a Follow button at all (e.g. some
// suggested reels).
// Tweak here first if the filter stops working.
const SELECTORS = {
  // Coarse pre-filter for querySelectorAll — cheap to run broadly, then
  // narrowed precisely by CONTENT_LINK_PATTERN below. Needed because
  // Instagram also uses "/reel(s)/" and "/p/" for non-permalink links,
  // e.g. /reels/audio/<id>/.
  contentLinkCoarse: 'a[href*="/reel"], a[href*="/p/"]',
  articleContainer: 'article[data-interactable="|click|"]',
  // Fallback container guess, used only if an article doesn't match the
  // precise selector above.
  containerCandidates: ['article', 'div[role="presentation"]', 'section'],
};

// An actual post/reel permalink is /p/<code>/, /reel/<code>/ or
// /reels/<code>/ (Instagram has used both singular and plural for reels
// over time). This excludes the bare /reels/ tab link and multi-segment
// links like /reels/audio/<id>/. The capture group tells posts and reels
// apart so the placeholder can say which one was blocked.
const CONTENT_LINK_PATTERN = /^\/(p|reels?)\/[^/?#]+\/?(?:[?#].*)?$/;

// Word-boundary match so "Follow" / "Follow Back" hit but "Following" and
// "Requested" (already following / request pending) don't — a plain
// substring check would false-positive on "Following" since it literally
// contains the characters "follow".
const FOLLOW_TEXT_PATTERN = /\bfollow\b/i;

// Instagram renders "Suggested for you" as visually-hidden screen-reader
// text (visibility: hidden, height: 0) rather than visible copy, so it
// won't show up in innerText — see hasSuggestedForYouText below.
const SUGGESTED_TEXT_PATTERN = /suggested for you/i;

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

function findFallbackContainer(anchor) {
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

// Some recommended posts/reels don't get a Follow button at all (e.g. IG
// occasionally omits it on suggested reels) — the only signal left is the
// "Suggested for you" label, which IG renders as visually-hidden
// screen-reader-only text. That rules out innerText (it skips hidden
// content) and plain textContent (concatenating across elements can glue
// unrelated text directly onto the phrase, e.g. "...1dSuggested for you",
// which would sneak past a naive \b boundary check). Walking individual
// text nodes sidesteps both: each node's own data is tested in isolation,
// never merged with a neighboring element's text.
function hasSuggestedForYouText(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (SUGGESTED_TEXT_PATTERN.test(node.nodeValue)) return true;
  }
  return false;
}

// Returns 'post' / 'reel' for an actual permalink href, or null for
// anything else (the /reels/ tab link, /reels/audio/<id>/, etc).
function contentTypeForHref(href) {
  const match = CONTENT_LINK_PATTERN.exec(href || '');
  if (!match) return null;
  return match[1] === 'p' ? 'post' : 'reel';
}

function isContentLink(anchor) {
  return Boolean(contentTypeForHref(anchor.getAttribute('href')));
}

function findContentLink(container) {
  const candidates = container.querySelectorAll(SELECTORS.contentLinkCoarse);
  for (const anchor of candidates) {
    if (isContentLink(anchor)) return anchor;
  }
  return null;
}

// Instagram's feeds are virtualized: it reuses the same article and anchor
// DOM nodes as you scroll, just swapping their content/href for the next
// post or reel. So containers can't be marked "done" once and skipped —
// instead each is keyed by its *current* content link, and re-evaluated
// whenever that key changes (i.e. the node got recycled for new content).
function decideContainer(container) {
  if (!container) return;

  const contentLink = findContentLink(container);
  if (!contentLink) return; // not a post or reel — leave it alone

  const key = contentLink.getAttribute('href');
  if (!key || container.dataset.noscrollKey === key) {
    applyVisibilityTo(container); // unchanged content, just sync class to state
    return;
  }

  container.dataset.noscrollKey = key;
  container.dataset.noscrollLabel =
    contentTypeForHref(key) === 'post' ? 'Post blocked' : 'Reel blocked';
  stats.scanned += 1;

  const shouldHide = hasFollowText(container) || hasSuggestedForYouText(container);
  container.dataset.noscrollHide = shouldHide ? '1' : '0';
  if (shouldHide) {
    stats.hidden += 1;
    log('flagged for hiding:', key);
  }

  applyVisibilityTo(container);
}

function applyVisibilityTo(container) {
  const enabled = currentSurfaceEnabled();
  const shouldHide = enabled && container.dataset.noscrollHide === '1';
  container.classList.toggle('noscroll-blocked', shouldHide);
}

// Re-syncs every already-decided container to the current on/off + scope
// state — used when a toggle changes, not when new posts/reels load in.
function applyVisibility() {
  document.querySelectorAll('[data-noscroll-key]').forEach(applyVisibilityTo);
}

function scan() {
  const surfaceKey = surfaceForPath(location.pathname);
  if (!surfaceKey) return;

  // Primary: the precise container Instagram actually uses.
  document.querySelectorAll(SELECTORS.articleContainer).forEach(decideContainer);

  // Fallback: walk up from any post/reel link, in case Instagram renders
  // one outside that exact article shape. decideContainer is idempotent
  // per key, so re-checking containers already handled above is harmless.
  document.querySelectorAll(SELECTORS.contentLinkCoarse).forEach((anchor) => {
    if (!isContentLink(anchor)) return;
    decideContainer(findFallbackContainer(anchor));
  });

  log(`scan complete — decided so far: ${stats.scanned}, hidden so far: ${stats.hidden}`);
}

function ensureStyleTag() {
  const id = 'noscroll-style';
  if (document.getElementById(id)) return;

  const style = document.createElement('style');
  style.id = id;
  // Rather than collapsing the post/reel away, keep its slot in the layout
  // but blank it out to a plain square with a label — hide its real
  // content and use ::after (fed by data-noscroll-label) to draw the
  // placeholder over the top.
  style.textContent = `
    .noscroll-blocked {
      position: relative;
      aspect-ratio: 1 / 1;
      overflow: hidden;
      background: #262626;
      margin-bottom: 12px;
    }
    .noscroll-blocked > * {
      visibility: hidden !important;
    }
    .noscroll-blocked::after {
      content: attr(data-noscroll-label);
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      box-sizing: border-box;
      text-align: center;
      font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #a8a8a8;
    }
  `;
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
  // swaps a reused article's href/text in place for the next post/reel
  // rather than adding/removing DOM nodes, which a childList-only observer
  // misses.
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
