chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    filterEnabled: true,
    scopeHome: true,
    scopeReels: true,
    scopeExplore: true,
  });
});
