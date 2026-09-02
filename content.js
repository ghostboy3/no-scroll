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
  // The Explore grid doesn't use the article wrapper at all — it's rows of
  // plain divs with no visible Follow/Suggested text anywhere in a tile, so
  // there's no per-tile signal to check (see decideExploreGrid, which hides
  // the whole grid instead). The one stable hook to find a row at all is its
  // inline `--x-gridTemplateColumns` custom property — not one of
  // Instagram's obfuscated class names, so it's unlikely to drift.
  exploreGridRow: '[style*="--x-gridTemplateColumns"]',
  // The infinite-scroll spinner Instagram shows below the grid while it
  // fetches the next page. Hooked the same way — a stable non-obfuscated
  // attribute pair rather than a class name.
  exploreLoadingSpinner: '[role="progressbar"][data-visualcompletion="loading-state"]',
  // Home interleaves a horizontal "Suggested for you" people-to-follow
  // carousel between posts — not a post/reel itself, so decideContainer
  // never sees it. Its one stable, non-obfuscated hook is the "See all"
  // link's fixed destination (see findSuggestedAccountsWidget).
  suggestedAccountsSeeAll: 'a[href="/explore/people/"]',
  // The Reels tab icon in the left nav, present on every instagram.com
  // page. aria-label is "Reels" (plural) here vs. "Reel" (singular) on the
  // per-post video badge elsewhere, so this doesn't collide with that.
  sidebarReelsIcon: 'svg[aria-label="Reels"]',
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

// Marks an element for wholesale hiding (display: none, no placeholder
// label) rather than the per-post blank-and-label treatment decideContainer
// uses — for widgets that aren't a single post/reel, so there's nothing
// sensible to key by href or explain with a label. Re-synced by
// applyVisibility like everything else.
function markWholeBlock(el) {
  el.dataset.noscrollBlock = '1';
  applyWholeBlockVisibility(el);
}

function applyWholeBlockVisibility(el) {
  el.classList.toggle('noscroll-blocked-block', currentSurfaceEnabled());
}

// The Explore grid is virtualized (React swaps rows in/out as you scroll)
// and its tiles have no Follow button or Suggested-for-you text to check —
// it's algorithmic by definition, so there's no per-tile signal at all.
// Blanking tiles one at a time also fought the virtualizer and made
// scrolling glitchy, so instead find the single wrapper div all the grid
// rows live in (its rows are identified by SELECTORS.exploreGridRow) and
// hide that whole thing in one shot.
function decideExploreGrid() {
  const row = document.querySelector(SELECTORS.exploreGridRow);
  const container = row && row.parentElement;
  if (container) markWholeBlock(container);

  // With the grid gone there's nothing left to show for the fetch this
  // spinner represents — left alone it just keeps spinning (and, since
  // it's still visible, can keep re-triggering "load more" as it scrolls
  // into view) — so hide it the same way as the grid itself.
  document.querySelectorAll(SELECTORS.exploreLoadingSpinner).forEach(markWholeBlock);
}

// Walks up from the "Suggested for you" widget's "See all" link
// (SELECTORS.suggestedAccountsSeeAll — the one stable, non-obfuscated hook
// available) to the widget's outer wrapper. The level count below matches
// the nesting depth found by live inspection; if this stops matching, it's
// likely Instagram changed that nesting and it needs recounting from a
// fresh page inspection (turn on DEBUG and check the console).
const SUGGESTED_ACCOUNTS_ANCESTOR_LEVELS = 4;

function findSuggestedAccountsWidget() {
  const seeAllLink = document.querySelector(SELECTORS.suggestedAccountsSeeAll);
  if (!seeAllLink) return null;

  let node = seeAllLink;
  for (let i = 0; i < SUGGESTED_ACCOUNTS_ANCESTOR_LEVELS && node.parentElement; i++) {
    node = node.parentElement;
  }
  return node;
}

function decideSuggestedAccountsWidget() {
  const widget = findSuggestedAccountsWidget();
  if (widget) markWholeBlock(widget);
}

// Reusing the Reels-tab toggle for both "redirect away from /reels/" and
// "hide the sidebar's Reels icon" — the sidebar link is the only way back
// into the surface the redirect blocks, so tying them to the same toggle
// keeps them consistent (both on together, both off together).
function reelsTabBlockingEnabled() {
  return Boolean(state.filterEnabled && state.scopeReels);
}

// Covers the bare Reels tab and every path under it — individual reel
// permalinks (/reels/<code>/, reached via a direct share link) included —
// so there's no way into the surface at all, not just its entry point. A
// real navigation (not a history.pushState) is used so it works regardless
// of whether Instagram's own router notices a raw history call.
function redirectAwayFromReelsTab() {
  if (!reelsTabBlockingEnabled()) return false;
  if (location.pathname === '/reels' || location.pathname.startsWith('/reels/')) {
    log('redirecting away from Reels to Home:', location.pathname);
    location.replace('/');
    return true;
  }
  return false;
}

// Walks up from the sidebar's Reels icon (SELECTORS.sidebarReelsIcon) to
// the whole nav item — icon, label and click target together — so hiding
// it doesn't leave a dead clickable sliver behind. Present on every
// instagram.com page, so this runs unconditionally in scan(), not gated by
// the Home/Reels/Explore surface check the rest of scan() uses. Level
// count matches the nesting found by live inspection — see the
// suggested-accounts widget above for the same caveat.
const SIDEBAR_REELS_ANCESTOR_LEVELS = 4;

function updateSidebarReelsVisibility() {
  const icon = document.querySelector(SELECTORS.sidebarReelsIcon);
  if (!icon) return;

  let node = icon;
  for (let i = 0; i < SIDEBAR_REELS_ANCESTOR_LEVELS && node.parentElement; i++) {
    node = node.parentElement;
  }
  node.dataset.noscrollSidebar = '1';
  applySidebarReelsVisibility(node);
}

function applySidebarReelsVisibility(node) {
  node.classList.toggle('noscroll-blocked-block', reelsTabBlockingEnabled());
}

// Re-syncs every already-decided container to the current on/off + scope
// state — used when a toggle changes, not when new posts/reels load in.
function applyVisibility() {
  document.querySelectorAll('[data-noscroll-key]').forEach(applyVisibilityTo);
  document.querySelectorAll('[data-noscroll-block]').forEach(applyWholeBlockVisibility);
  document.querySelectorAll('[data-noscroll-sidebar]').forEach(applySidebarReelsVisibility);
}

function scan() {
  // Present on every page (profile pages included), so this runs before
  // the surface check below, which bails out early on pages that aren't
  // Home/Reels/Explore.
  updateSidebarReelsVisibility();

  // Also checked synchronously wherever navigation is observed (see init)
  // for a faster bounce; repeating it here is a cheap no-op in the common
  // case and a safety net for any navigation path that reaches scan()
  // without going through those hooks.
  if (redirectAwayFromReelsTab()) return;

  const surfaceKey = surfaceForPath(location.pathname);
  if (!surfaceKey) return;

  if (surfaceKey === 'scopeExplore') {
    decideExploreGrid();
    return;
  }

  if (surfaceKey === 'scopeHome') {
    decideSuggestedAccountsWidget();
  }

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
    .noscroll-blocked-block {
      display: none !important;
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
    redirectAwayFromReelsTab();
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
    if (relevant) {
      // Covers turning the Reels toggle on while already sitting on the tab.
      redirectAwayFromReelsTab();
      applyVisibility();
    }
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

  // The redirect check runs synchronously here (not debounced through
  // scheduleScan) so clicking into the Reels tab from elsewhere in the app
  // bounces back to Home immediately rather than after scheduleScan's
  // 150ms delay.
  watchForNavigation(() => {
    redirectAwayFromReelsTab();
    scheduleScan();
  });
}

init();
