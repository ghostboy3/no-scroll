# NoScroll

A Chrome extension that hides Instagram Reels posted by accounts you don't
follow, on the Home feed, the Reels tab, and Explore.

## How it works

Instagram always shows a "Follow" (or "Follow Back") button next to a
reel's author when you don't already follow them, and never shows one for
accounts you follow or your own content. `content.js` watches the page for
reel links, checks each one's container for that button, and hides any
reel where it's present. Everything runs locally in the browser — nothing
is scraped, stored remotely, or automated.

Because Instagram's markup changes over time, the CSS selectors and the
list of "not following" button labels the filter looks for are all kept
together near the top of `content.js` so they're easy to update if the
filter stops catching reels it should.

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
