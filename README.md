# NoScroll

A Chrome extension that blocks Instagram posts and reels from accounts you
don't follow, on the Home feed, the Reels tab, and Explore — replacing each
one with a plain "Post blocked" / "Reel blocked" square instead of the
actual content.

## How it works

Instagram always shows a "Follow" (or "Follow Back") button next to a
post's or reel's author when you don't already follow them, and never
shows one for accounts you follow or your own content. `content.js`
watches the page for post/reel permalink links, checks each one's
container for that button, and blanks out any where it's present — the
real content is hidden and replaced with a placeholder, rather than
removed from the page. Everything runs locally in the browser — nothing is
scraped, stored remotely, or automated.

Because Instagram's markup changes over time, the CSS selectors and the
follow-text pattern the filter looks for are all kept together near the
top of `content.js` so they're easy to update if the filter stops catching
posts/reels it should.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Visit [instagram.com](https://www.instagram.com/) — the extension icon
   opens a popup to turn filtering on/off, and its options page lets you
   pick which surfaces (Home feed / Reels tab / Explore) are filtered.

## Debugging

Set `DEBUG = true` at the top of `content.js` and reload the extension to
log scan/hide counts to the console — useful for telling whether
Instagram's markup has drifted out from under the selectors.
