const statusText = document.getElementById('status-text');
const toggleButton = document.getElementById('toggle-button');
const optionsButton = document.getElementById('options-button');

async function getCurrentState() {
  const stored = await chrome.storage.local.get('filterEnabled');
  return stored.filterEnabled !== false;
}

function updateUI(isEnabled) {
  statusText.textContent = isEnabled
    ? "Filtering reels from accounts you don't follow."
    : 'Filter is off — all reels are shown.';
  toggleButton.textContent = isEnabled ? 'Turn filter off' : 'Turn filter on';
}

async function toggleFilter() {
  const isEnabled = await getCurrentState();
  const nextState = !isEnabled;

  await chrome.storage.local.set({ filterEnabled: nextState });
  updateUI(nextState);
}

async function init() {
  const isEnabled = await getCurrentState();
  updateUI(isEnabled);
}

toggleButton.addEventListener('click', toggleFilter);
optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

init();
