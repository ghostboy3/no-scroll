const SCOPES = [
  { id: 'scope-home', key: 'scopeHome' },
  { id: 'scope-reels', key: 'scopeReels' },
  { id: 'scope-explore', key: 'scopeExplore' },
];

const defaults = Object.fromEntries(SCOPES.map(({ key }) => [key, true]));

chrome.storage.local.get(defaults, (stored) => {
  SCOPES.forEach(({ id, key }) => {
    document.getElementById(id).checked = Boolean(stored[key]);
  });
});

SCOPES.forEach(({ id, key }) => {
  document.getElementById(id).addEventListener('change', (event) => {
    chrome.storage.local.set({ [key]: event.target.checked });
  });
});
