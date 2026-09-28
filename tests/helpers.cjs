const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const adapter = fs.readFileSync(path.join(root, 'extension/conversation.js'), 'utf8');
const content = process.env.CANVAS_BASELINE
  ? execFileSync('git', ['show', `${process.env.CANVAS_BASELINE}:extension/content.js`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
const tick = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));

function createPage(html = '', saved = {}, options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => errors.push(err));
  const dom = new JSDOM(`<!doctype html><main><div id="thread">${html}</div><form data-type="unified-composer"><div id="prompt-textarea" contenteditable="true"></div></form></main>`, {
    url: 'https://chatgpt.com/c/test-chat', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  // jsdom has no layout/innerText. Supply the old reader's plain-text behavior
  // so baseline failures concern grouping/streaming, not an absent DOM method.
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  }
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  const store = structuredClone(saved);
  const writes = [];
  let listener;
  window.chrome = {
    storage: { local: {
      get(keys, cb) {
        const data = structuredClone(store);
        window.setTimeout(() => cb(data), options.storageDelay || 0);
      },
      set(data) { Object.assign(store, structuredClone(data)); writes.push(data); },
    } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  };
  window.eval(adapter);
  const page = {
    window, document: window.document, store, writes, errors,
    getTurns: () => JSON.parse(JSON.stringify(window.ChatGPTCanvasConversation.getTurns())),
    start: async () => { window.eval(content); listener({ action: 'toggle' }); await tick(process.env.CANVAS_BASELINE ? 750 : (options.storageDelay || 0) + 40); },
    toggle: () => listener({ action: 'toggle' }),
    blocks: () => Array.from(window.document.querySelectorAll('.gpt-block')),
    text: () => Array.from(window.document.querySelectorAll('.gpt-block-content'), el => el.textContent),
    close: () => window.close(),
  };
  return page;
}

function message(role, text, id = '', attrs = '') {
  return `<div data-message-author-role="${role}" ${id ? `data-message-id="${id}"` : ''} ${attrs}>${role === 'assistant' ? `<div class="markdown">${text}</div>` : `<div class="whitespace-pre-wrap">${text}</div>`}</div>`;
}

module.exports = { createPage, message, tick };
