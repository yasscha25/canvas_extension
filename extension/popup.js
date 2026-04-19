/**
 * ChatGPT Canvas — popup.js
 * Gestiona el toggle, exportación y comunicación con content.js
 */

const toggleEl  = document.getElementById('toggle-canvas');
const statusEl  = document.getElementById('status-badge');
const exportBtn = document.getElementById('export-btn');
const clearBtn  = document.getElementById('clear-btn');
const openBtn   = document.getElementById('open-tab-btn');

// ─── Helpers ──────────────────────────────────────────────────
function setStatus(enabled) {
  toggleEl.checked = enabled;
  if (enabled) {
    statusEl.textContent = '▶ Canvas activo';
    statusEl.classList.add('active');
  } else {
    statusEl.textContent = '⏸ Canvas desactivado';
    statusEl.classList.remove('active');
  }
}

function getActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) cb(tabs[0]);
  });
}

function isChatGPTTab(tab) {
  return tab.url && (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com'));
}

// ─── Estado inicial ───────────────────────────────────────────
chrome.storage.local.get(['canvasEnabled'], (res) => {
  setStatus(!!res.canvasEnabled);
});

// ─── Toggle ───────────────────────────────────────────────────
toggleEl.addEventListener('change', () => {
  getActiveTab((tab) => {
    if (!isChatGPTTab(tab)) {
      alert('Abre ChatGPT (chatgpt.com) en esta pestaña primero.');
      toggleEl.checked = !toggleEl.checked; // revertir
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: 'toggle' }, () => {
      const enabled = toggleEl.checked;
      setStatus(enabled);
    });
  });
});

// ─── Abrir ChatGPT ────────────────────────────────────────────
openBtn.addEventListener('click', () => {
  getActiveTab((tab) => {
    if (!isChatGPTTab(tab)) {
      chrome.tabs.create({ url: 'https://chatgpt.com' });
    } else {
      chrome.tabs.update(tab.id, { active: true });
      window.close();
    }
  });
});

// ─── Exportar canvas ──────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  chrome.storage.local.get(null, (allData) => {
    const canvasData = {};
    Object.keys(allData).forEach(key => {
      if (key.startsWith('canvas_')) canvasData[key] = allData[key];
    });
    const blob = new Blob([JSON.stringify(canvasData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'chatgpt-canvas-' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ─── Limpiar datos del chat actual ────────────────────────────
clearBtn.addEventListener('click', () => {
  getActiveTab((tab) => {
    const url  = tab.url || '';
    const m    = url.match(/\/c\/([a-zA-Z0-9\-_]+)/);
    const chatId = m ? m[1] : '__default__';
    const key  = 'canvas_' + chatId;

    if (confirm('¿Limpiar los datos del canvas para este chat? Esta acción no se puede deshacer.')) {
      chrome.storage.local.remove([key], () => {
        statusEl.textContent = '✓ Datos eliminados';
        setTimeout(() => setStatus(false), 1500);
      });
    }
  });
});
