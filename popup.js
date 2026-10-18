/**
 * Saturn AI - Popup Script
 * Manages UI interactions, API key storage, model selection,
 * active tab detection, and real-time activity log synchronization.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const statusPill = document.getElementById('statusPill');
  const statusLabel = document.getElementById('statusLabel');
  const activeTabTitle = document.getElementById('activeTabTitle');

  const settingsToggle = document.getElementById('settingsToggle');
  const settingsContent = document.getElementById('settingsContent');
  const settingsArrow = document.getElementById('settingsArrow');

  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const modelSelect = document.getElementById('modelSelect');

  const promptInput = document.getElementById('promptInput');
  const presetChips = document.querySelectorAll('.chip');
  const runBtn = document.getElementById('runBtn');
  const runBtnText = document.getElementById('runBtnText');
  const stopBtn = document.getElementById('stopBtn');

  const stepCounterBadge = document.getElementById('stepCounterBadge');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const logStream = document.getElementById('logStream');

  // State
  let isSettingsOpen = true;

  // 1. Detect Active Tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const url = tab.url ? new URL(tab.url).hostname : 'Active Tab';
      activeTabTitle.textContent = `${tab.title ? tab.title.slice(0, 30) : ''} (${url})`;
      activeTabTitle.title = tab.url || '';
    } else {
      activeTabTitle.textContent = 'No active tab detected';
    }
  } catch {
    activeTabTitle.textContent = 'Active browser tab';
  }

  // 2. Load Stored Settings
  chrome.storage.local.get(['saturn_api_key', 'saturn_model', 'saturn_settings_open'], (res) => {
    if (res.saturn_api_key) {
      apiKeyInput.value = res.saturn_api_key;
      // If key is already configured, collapse settings by default
      if (res.saturn_settings_open !== true) {
        toggleSettings(false);
      }
    } else {
      // Expand settings if no key configured
      toggleSettings(true);
    }

    if (res.saturn_model) {
      modelSelect.value = res.saturn_model;
    }
  });

  // Settings Accordion
  function toggleSettings(open) {
    isSettingsOpen = open !== undefined ? open : !isSettingsOpen;
    if (isSettingsOpen) {
      settingsContent.classList.remove('hidden');
      settingsArrow.classList.remove('collapsed');
    } else {
      settingsContent.classList.add('hidden');
      settingsArrow.classList.add('collapsed');
    }
    chrome.storage.local.set({ saturn_settings_open: isSettingsOpen }).catch(() => {});
  }

  settingsToggle.addEventListener('click', () => toggleSettings());

  // Show/Hide Key Toggle
  toggleKeyVisibility.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyVisibility.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyVisibility.textContent = '👁️';
    }
  });

  // Save API Key
  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ saturn_api_key: key }, () => {
      saveKeyBtn.textContent = '✓ Saved';
      saveKeyBtn.style.background = 'rgba(16, 185, 129, 0.3)';
      saveKeyBtn.style.color = '#6ee7b7';
      setTimeout(() => {
        saveKeyBtn.textContent = 'Save';
        saveKeyBtn.style.background = '';
        saveKeyBtn.style.color = '';
      }, 1500);
    });
  });

  // Model Selection Change
  modelSelect.addEventListener('change', () => {
    chrome.storage.local.set({ saturn_model: modelSelect.value }).catch(() => {});
  });

  // 3. Preset Chips Click
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      promptInput.value = chip.getAttribute('data-prompt');
      promptInput.focus();
    });
  });

  // 4. Update UI from Agent State
  function renderAgentState(state) {
    if (!state) return;

    // Status Pill
    statusPill.className = `status-pill status-${state.status || 'idle'}`;
    statusLabel.textContent = state.statusText || 'Ready';

    // Buttons
    if (state.isRunning) {
      runBtn.disabled = true;
      runBtnText.textContent = 'Agent Running...';
      stopBtn.disabled = false;
    } else {
      runBtn.disabled = false;
      runBtnText.textContent = 'Run Agent';
      stopBtn.disabled = true;
    }

    // Step counter
    stepCounterBadge.textContent = `Step ${state.currentStep || 0}/${state.maxSteps || 25}`;

    // Render Logs
    if (state.logs && state.logs.length > 0) {
      renderLogs(state.logs);
    }
  }

  // Render Log Stream
  function renderLogs(logs) {
    logStream.innerHTML = '';

    logs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = `log-entry type-${log.type}`;

      const meta = document.createElement('div');
      meta.className = 'log-meta';

      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = log.timestamp;

      const tag = document.createElement('span');
      tag.className = 'log-tag';
      tag.textContent = getTagLabel(log.type);

      meta.appendChild(time);
      meta.appendChild(tag);

      const msg = document.createElement('div');
      msg.className = 'log-message';
      msg.textContent = log.message;

      entry.appendChild(meta);
      entry.appendChild(msg);

      if (log.details) {
        const details = document.createElement('div');
        details.className = 'log-details';
        details.textContent = log.details;
        entry.appendChild(details);
      }

      logStream.appendChild(entry);
    });

    // Auto-scroll to latest log
    logStream.scrollTop = logStream.scrollHeight;
  }

  function getTagLabel(type) {
    switch (type) {
      case 'thought': return 'Reasoning';
      case 'action': return 'Tool Call';
      case 'success': return 'Success';
      case 'error': return 'Error';
      case 'complete': return 'Finished';
      default: return 'Info';
    }
  }

  // 5. Run Agent Action
  runBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const prompt = promptInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      toggleSettings(true);
      apiKeyInput.focus();
      apiKeyInput.style.borderColor = '#f43f5e';
      setTimeout(() => { apiKeyInput.style.borderColor = ''; }, 2000);
      return;
    }

    if (!prompt) {
      promptInput.focus();
      promptInput.style.borderColor = '#f43f5e';
      setTimeout(() => { promptInput.style.borderColor = ''; }, 2000);
      return;
    }

    // Save key in storage
    chrome.storage.local.set({ saturn_api_key: apiKey });

    // Send Start message to background service worker
    chrome.runtime.sendMessage({
      type: 'START_AGENT',
      prompt,
      apiKey,
      model
    }, (response) => {
      if (response && !response.success) {
        alert(response.error || 'Failed to start agent.');
      }
    });
  });

  // 6. Stop Agent Action
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
  });

  // 7. Clear Logs Action
  clearLogsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
      logStream.innerHTML = `
        <div class="log-empty-state">
          <div class="empty-icon">🪐</div>
          <p>Ready to explore. Enter your task and click <strong>Run Agent</strong>.</p>
        </div>
      `;
      stepCounterBadge.textContent = 'Step 0/25';
    });
  });

  // 8. Listen for Live Updates from Background
  chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'AGENT_STATE_UPDATE') {
      renderAgentState(request.state);
    }
  });

  // 9. Initial State Request on popup open
  chrome.runtime.sendMessage({ type: 'GET_AGENT_STATE' }, (response) => {
    if (response && response.success && response.state) {
      renderAgentState(response.state);
    }
  });
});
