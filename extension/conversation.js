/* DOM adapter for ChatGPT. No network calls or page-internal state required. */
(function () {
  'use strict';

  const ROLE_SELECTOR = [
    '[data-message-author-role="user"]', '[data-message-author-role="assistant"]',
    '[data-turn="user"]', '[data-turn="assistant"]',
    '[data-testid="user-message"]', '[data-testid="assistant-message"]',
  ].join(',');
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const EXCLUDED = '#gpt-canvas-root, #gpt-fork-indicator, nav, form, [contenteditable="true"], [hidden], [aria-hidden="true"]';
  const OMIT = 'button, [role="button"], script, style, template, svg, iframe, object, embed, input, textarea, select, nav, form, [hidden], [aria-hidden="true"], .sr-only, [data-message-author-role="tool"], [data-message-author-role="system"]';
  const ALLOWED = new Set('DIV P BR HR H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE STRONG EM B I S DEL U SUP SUB A TABLE THEAD TBODY TFOOT TR TH TD CAPTION'.split(' '));
  const BLOCK_TAGS = new Set('DIV P H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE TABLE TR CAPTION'.split(' '));

  function roleOf(el) {
    const role = el.getAttribute('data-message-author-role') || el.getAttribute('data-turn');
    if (role === 'user' || role === 'assistant') return role;
    const testId = el.getAttribute('data-testid');
    if (testId === 'user-message') return 'user';
    if (testId === 'assistant-message') return 'assistant';
    return null;
  }

  function messageId(el) {
    const message = el.closest('[data-message-id]') || el.querySelector('[data-message-id]');
    if (message?.getAttribute('data-message-id')) return 'message:' + message.getAttribute('data-message-id');
    const turn = el.closest('[data-turn-id]');
    if (turn?.getAttribute('data-turn-id')) return 'turn:' + turn.getAttribute('data-turn-id');
    // Positional test IDs are not identities: they can change with a branch or lazy loading.
    return null;
  }

  function safeLink(href, doc) {
    try {
      const url = new URL(href, doc.baseURI);
      return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function copyContent(node, target, doc) {
    if (node.nodeType === 3) {
      target.appendChild(doc.createTextNode(node.nodeValue));
      return;
    }
    if (node.nodeType !== 1 || node.matches(OMIT)) return;
    if (node.tagName === 'IMG') {
      target.appendChild(doc.createTextNode(node.getAttribute('alt') || '[Imagen]'));
      return;
    }
    // Rebuild an allowlisted fragment instead of copying ChatGPT's HTML, styles,
    // IDs, event handlers or data attributes into the observed document.
    const copy = ALLOWED.has(node.tagName) ? doc.createElement(node.tagName.toLowerCase()) : null;
    if (copy?.tagName === 'A') {
      const href = node.hasAttribute('href') ? safeLink(node.getAttribute('href'), doc) : null;
      if (href) {
        copy.setAttribute('href', href);
        copy.setAttribute('target', '_blank');
        copy.setAttribute('rel', 'noopener noreferrer');
      }
    }
    for (const attr of ['start', 'colspan', 'rowspan']) {
      const value = node.getAttribute(attr);
      if (copy && value && /^\d{1,4}$/.test(value)) copy.setAttribute(attr, value);
    }
    const code = node.tagName === 'PRE' ? node.querySelector('code') : null;
    for (const child of code ? [code] : node.childNodes) copyContent(child, copy || target, doc);
    if (copy) target.appendChild(copy);
  }

  function textOf(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeName === 'BR') return '\n';
    const text = Array.from(node.childNodes, textOf).join('');
    if (node.nodeName === 'TD' || node.nodeName === 'TH') return text + '\t';
    return BLOCK_TAGS.has(node.nodeName) ? '\n' + text + '\n' : text;
  }

  function readContent(el, role) {
    const selector = role === 'assistant' ? '.markdown, .prose, [data-message-content]' : '.whitespace-pre-wrap, [data-message-content]';
    let roots = Array.from(el.querySelectorAll(selector)).filter(node => !node.closest(OMIT));
    // A .prose wrapper may itself contain .markdown. Read each subtree once.
    roots = roots.filter(node => !roots.some(other => other !== node && other.contains(node)));
    if (!roots.length) roots = [el];
    const output = el.ownerDocument.createElement('div');
    for (const root of roots) copyContent(root, output, el.ownerDocument);
    const text = textOf(output).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const hasBlocks = output.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote');
    const html = hasBlocks ? output.innerHTML : '<div class="gpt-plain-content">' + output.innerHTML + '</div>';
    return { text, html: text ? html : '' };
  }

  function getTurns(doc = document) {
    const root = doc.querySelector('#thread') || doc.querySelector('main') || doc.body;
    if (!root) return [];
    let messages = Array.from(root.querySelectorAll(ROLE_SELECTOR)).filter(el => !el.closest(EXCLUDED));
    // Prefer the inner message over an outer turn that repeats the same role.
    messages = messages.filter(el => !messages.some(other => other !== el && el.contains(other)));
    let legacy = false;
    if (!messages.length) {
      legacy = true;
      messages = Array.from(root.querySelectorAll(TURN_SELECTOR)).filter(el => !el.closest(EXCLUDED));
      messages = messages.filter(el => !messages.some(other => other !== el && el.contains(other)));
    }

    const turns = [];
    let current = null;
    for (const [index, el] of messages.entries()) {
      // Keep the old article-only layout as a fallback, never pair modern role
      // nodes by index: there can be multiple assistant chunks per user prompt.
      const role = roleOf(el) || (legacy ? (index % 2 === 0 ? 'user' : 'assistant') : null);
      const content = readContent(el, role);
      if (role === 'user') {
        current = {
          sourceId: messageId(el),
          userMsg: content.text || '[Mensaje sin texto]',
          gptMsg: '',
          gptHtml: '',
        };
        turns.push(current);
      } else if (role === 'assistant' && current && content.text) {
        current.gptMsg += (current.gptMsg ? '\n\n' : '') + content.text;
        current.gptHtml += content.html;
      }
    }
    return turns;
  }

  globalThis.ChatGPTCanvasConversation = Object.freeze({ getTurns, ROLE_SELECTOR, TURN_SELECTOR });
})();
