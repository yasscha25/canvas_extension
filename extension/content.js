/**
 * ChatGPT Canvas — content.js
 * Núcleo principal de la extensión.
 * Inserta un canvas visual sobre la conversación, manteniendo visible la barra de escritura nativa.
 */

(function () {
  'use strict';

  // ─── Estado global ────────────────────────────────────────────────────────
  const state = {
    enabled: false,
    blocks: [],          // { id, userMsg, gptMsg, parentId, x, y, w, h, minimized, highlights }
    notes: [],           // { id, x, y, html }
    connections: [],     // { fromId, toId }
    pendingParentId: null, // bloque marcado para bifurcación
    currentChatId: null,
    dragState: null,
    resizeState: null,
    annotationMode: null, // 'text' | 'draw' | null
    markMode: null,       // 'highlight' | 'underline' | null
    drawing: false,
    drawPoints: [],
    canvasOffset: { x: 0, y: 0 },
    panState: null,
    idCounter: 0,
    rehydrating: false,
  };

  // ─── Constantes de layout ─────────────────────────────────────────────────
  const BLOCK_W = 360;
  const BLOCK_H = 220;
  const H_GAP   = 80;
  const V_GAP   = 60;
  const START_X  = 60;
  const START_Y  = 60;

  // ─── Elementos DOM principales ────────────────────────────────────────────
  let canvasRoot, svgLayer, blocksLayer, toolbarEl, drawCanvas, drawCtx;
  let resizeHandler = null;
  let restoreGeneration = 0;
  let restoreTimer = null;

  // ─── Utilidades ───────────────────────────────────────────────────────────
  function uid() { return 'b' + (++state.idCounter) + '_' + Date.now(); }

  function getChatId() {
    const m = location.pathname.match(/\/c\/([a-zA-Z0-9\-_]+)/);
    if (m) return m[1];
    // Fallback robusto para rutas sin /c/<id>.
    return `path_${location.pathname}${location.search}`;
  }

  function storageKey() { return 'canvas_' + state.currentChatId; }

  // ─── Persistencia ─────────────────────────────────────────────────────────
  function saveState() {
    if (!state.currentChatId || state.rehydrating) return;
    const data = {
      blocks: state.blocks,
      notes: state.notes,
      connections: state.connections,
      idCounter: state.idCounter,
      canvasOffset: state.canvasOffset,
      pendingParentId: state.pendingParentId,
    };
    chrome.storage.local.set({ [storageKey()]: data });
  }

  function loadState(cb, generation) {
    const key = storageKey();
    chrome.storage.local.get([key], (res) => {
      if (!state.enabled || generation !== restoreGeneration || key !== storageKey()) return;
      const data = res[key];
      if (data) {
        state.blocks = data.blocks || [];
        state.notes = data.notes || [];
        state.connections = data.connections || [];
        state.idCounter = data.idCounter || 0;
        state.canvasOffset = data.canvasOffset || { x: 0, y: 0 };
        state.pendingParentId = data.pendingParentId || null;
      } else {
        // Evitar arrastrar estado de otro chat cuando no hay guardado.
        state.blocks = [];
        state.notes = [];
        state.connections = [];
        state.idCounter = 0;
        state.canvasOffset = { x: 0, y: 0 };
        state.pendingParentId = null;
      }
      cb && cb(!!data);
    });
  }

  // ─── Observador de mensajes ChatGPT ───────────────────────────────────────
  let messageObserver = null;
  let syncTimer = null;

  function stopMessageObserver() {
    if (messageObserver) messageObserver.disconnect();
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  function scheduleMessageSync() {
    if (!state.enabled || state.rehydrating || syncTimer !== null) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (state.enabled && !state.rehydrating) syncMessagesToBlocks();
    }, 120);
  }

  function startMessageObserver() {
    stopMessageObserver();
    messageObserver = new MutationObserver((records) => {
      // Do not observe our own rendering/annotations as new ChatGPT output.
      const hasNativeChange = records.some(({ target }) => {
        const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        return el && !el.closest('#gpt-canvas-root, #gpt-fork-indicator');
      });
      if (hasNativeChange) scheduleMessageSync();
    });
    messageObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-message-author-role', 'data-message-id', 'data-turn', 'data-turn-id', 'data-testid', 'data-message-content', 'hidden', 'aria-hidden'],
    });
  }

  function getConversationTurns() {
    return ChatGPTCanvasConversation.getTurns(document);
  }

  function syncMessagesToBlocks() {
    if (!state.enabled || state.rehydrating) return;
    // React may replace the native container without a URL change.
    if (!canvasRoot?.isConnected) {
      injectCanvas();
      renderAllBlocks();
    }
    if (!blocksLayer) return;
    const turns = getConversationTurns();
    const claimed = new Set();
    let changed = false;
    let added = false;
    for (const turn of turns) {
      let block = turn.sourceId && state.blocks.find(b => b.sourceId === turn.sourceId && !claimed.has(b.id));
      if (!block) {
        // Migrate existing 1.0.1 canvases without touching positions or notes.
        // Do not align by array index: ChatGPT can mount only part of a chat.
        const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
        block = state.blocks.find(b => !claimed.has(b.id) && (!b.sourceId || !turn.sourceId) && normalize(b.userMsg) === normalize(turn.userMsg));
      }
      if (block) {
        claimed.add(block.id);
        if (turn.sourceId && block.sourceId !== turn.sourceId) {
          block.sourceId = turn.sourceId;
          changed = true;
        }
        if (block.userMsg !== turn.userMsg) {
          block.userMsg = turn.userMsg;
          const title = document.getElementById('block-' + block.id)?.querySelector('.gpt-block-title');
          if (title) title.textContent = turn.userMsg;
          changed = true;
        }
        // An empty transient DOM must not erase a previously captured answer.
        if (turn.gptMsg) {
          if (block.gptMsg !== turn.gptMsg) {
            block.gptMsg = turn.gptMsg;
            changed = true;
          }
          if (!block.annotated && (block.contentHtml !== turn.gptHtml || block.contentFormat !== 'rich')) {
            block.contentHtml = turn.gptHtml;
            block.contentFormat = 'rich';
            updateBlockContent(block.id, block.contentHtml, true);
            changed = true;
          }
        }
        continue;
      }

      const parentId = state.pendingParentId || (state.blocks.length > 0 ? state.blocks[state.blocks.length - 1].id : null);
      if (state.pendingParentId) {
        state.pendingParentId = null;
        document.querySelectorAll('.gpt-block.fork-pending').forEach(el => el.classList.remove('fork-pending'));
        document.getElementById('gpt-fork-indicator')?.classList.remove('visible');
      }
      const pos = calcNewBlockPosition(parentId);
      block = {
        id: uid(),
        sourceId: turn.sourceId,
        userMsg: turn.userMsg,
        gptMsg: turn.gptMsg,
        contentHtml: turn.gptHtml || '<span class="gpt-generating">Generando...</span>',
        contentFormat: 'rich',
        annotated: false,
        parentId: parentId,
        x: pos.x,
        y: pos.y,
        w: BLOCK_W,
        h: BLOCK_H,
        minimized: false,
        highlights: [],
      };

      state.blocks.push(block);
      claimed.add(block.id);
      if (parentId) {
        state.connections.push({ fromId: parentId, toId: block.id });
      }

      renderBlock(block);
      added = changed = true;
    }
    if (added) renderConnections();
    const empty = document.getElementById('gpt-canvas-empty');
    if (empty) empty.hidden = state.blocks.length > 0;
    positionCanvasRoot();
    if (changed) saveState();
  }

  function updateBlockContent(blockId, contentHtml, rich) {
    const contentEl = document.getElementById('block-' + blockId)?.querySelector('.gpt-block-content');
    if (!contentEl) return;
    const scrollTop = contentEl.scrollTop;
    contentEl.innerHTML = contentHtml;
    contentEl.classList.toggle('gpt-rich-content', !!rich);
    contentEl.scrollTop = scrollTop;
  }

  function calcNewBlockPosition(parentId) {
    if (!parentId) {
      // Primera columna
      const col0Blocks = state.blocks.filter(b => !b.parentId);
      return {
        x: START_X,
        y: START_Y + col0Blocks.length * (BLOCK_H + V_GAP),
      };
    }
    const parent = state.blocks.find(b => b.id === parentId);
    if (!parent) return { x: START_X, y: START_Y };

    // Contar hijos existentes para desplazar verticalmente
    const siblings = state.blocks.filter(b => b.parentId === parentId);
    const nextY = siblings.length === 0
      ? parent.y
      : Math.max(...siblings.map(s => s.y + (s.h || BLOCK_H))) + V_GAP;
    return {
      x: parent.x + BLOCK_W + H_GAP,
      y: nextY,
    };
  }

  // ─── Inyección del canvas en el DOM ───────────────────────────────────────
  function findChatContainer() {
    const candidates = [
      document.querySelector('[class*="react-scroll-to-bottom"]'),
      document.querySelector('[data-testid="conversation-turns"]')?.parentElement,
      document.querySelector('main [class*="overflow-y-auto"]'),
      document.querySelector('main [class*="flex-col"][class*="flex-1"]'),
      document.querySelector('main'),
    ];
    for (const el of candidates) {
      if (el && !el.closest('nav') && !el.closest('form')) {
        console.log('[Canvas] Container encontrado:', el.tagName, el.className.slice(0,60));
        return el;
      }
    }
    return document.querySelector('main');
  }

  function injectCanvas() {
    if (document.getElementById('gpt-canvas-root')) {
      console.log('[Canvas] Ya existe, saltando');
      return;
    }
    console.log('[Canvas] Inyectando canvas...');

    canvasRoot = document.createElement('div');
    canvasRoot.id = 'gpt-canvas-root';
    canvasRoot.innerHTML = `
      <div id="gpt-canvas-toolbar">
        <span class="gpt-canvas-logo">⬡ Canvas</span>
        <div class="gpt-canvas-tools">
          <button id="tool-select" class="gpt-tool active" title="Seleccionar / mover">↖</button>
          <button id="tool-highlight" class="gpt-tool" title="Resaltador">🖊</button>
          <button id="tool-underline" class="gpt-tool" title="Subrayar">U̲</button>
          <button id="tool-text" class="gpt-tool" title="Nota de texto">T</button>
          <button id="tool-draw" class="gpt-tool" title="Dibujo libre">✏</button>
          <div class="gpt-tool-sep"></div>
          <button id="tool-zoom-in" class="gpt-tool" title="Zoom +">+</button>
          <button id="tool-zoom-out" class="gpt-tool" title="Zoom −">−</button>
          <button id="tool-fit" class="gpt-tool" title="Ajustar vista">⊡</button>
          <button id="tool-sync" class="gpt-tool" title="Volver a detectar mensajes" aria-label="Volver a detectar mensajes">↻</button>
          <div class="gpt-tool-sep"></div>
          <button id="tool-close" class="gpt-tool gpt-tool-close" title="Cerrar canvas">✕</button>
        </div>
      </div>
      <div id="gpt-canvas-viewport">
        <p id="gpt-canvas-empty" role="status">Todavía no se han detectado mensajes. Abre una conversación o pulsa ↻ para volver a intentarlo.</p>
        <canvas id="gpt-draw-canvas"></canvas>
        <svg id="gpt-svg-layer" xmlns="http://www.w3.org/2000/svg"></svg>
        <div id="gpt-blocks-layer"></div>
      </div>
    `;

    const container = findChatContainer();
    if (container) {
      hideNativeChildren(container, true);
      const composerHost = findComposerHost(container);
      if (composerHost) {
        container.insertBefore(canvasRoot, composerHost);
      } else {
        container.insertBefore(canvasRoot, container.firstChild);
      }
      console.log('[Canvas] Insertado dentro del container de ChatGPT');
    } else {
      console.warn('[Canvas] Fallback: insertando en body');
      canvasRoot.style.cssText = 'position:fixed!important;top:0!important;left:260px!important;right:0!important;bottom:160px!important;z-index:9999!important;display:flex!important;flex-direction:column!important;background:#0f0f11!important;';
      document.body.appendChild(canvasRoot);
    }

    svgLayer    = document.getElementById('gpt-svg-layer');
    blocksLayer = document.getElementById('gpt-blocks-layer');
    toolbarEl   = document.getElementById('gpt-canvas-toolbar');
    drawCanvas  = document.getElementById('gpt-draw-canvas');
    drawCtx     = drawCanvas.getContext('2d');

    resizeDrawCanvas();
    positionCanvasRoot();
    bindToolbarEvents();
    bindViewportEvents();
    applyCanvasOffset();
    toggleNativeJumpToBottom(true);
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    resizeHandler = () => {
      positionCanvasRoot();
      resizeDrawCanvas();
    };
    window.addEventListener('resize', resizeHandler);
    console.log('[Canvas] Canvas listo ✓');
  }

  function positionCanvasRoot() {
    if (!canvasRoot) return;
    const main = document.querySelector('main');
    const composer = document.querySelector('#prompt-textarea')?.closest('form') || document.querySelector('form[data-type="unified-composer"]') || document.querySelector('main form');
    const mainRect = main?.getBoundingClientRect();

    // Use the conversation region, not the first nav (which may be a hidden rail).
    const left = mainRect ? Math.max(0, mainRect.left) : 0;
    const right = mainRect ? Math.max(0, window.innerWidth - mainRect.right) : 0;
    const top = mainRect ? mainRect.top : 0;
    let bottom = 16;

    if (composer) {
      const cRect = composer.getBoundingClientRect();
      if (cRect.height > 0) bottom = Math.max(12, window.innerHeight - cRect.top + 8);
    }

    canvasRoot.style.position = 'fixed';
    canvasRoot.style.left = `${Math.max(0, left)}px`;
    canvasRoot.style.right = `${Math.max(0, right)}px`;
    canvasRoot.style.top = `${Math.max(0, top)}px`;
    canvasRoot.style.bottom = `${Math.max(12, bottom)}px`;
    canvasRoot.style.height = 'auto';
    canvasRoot.style.zIndex = '40';
  }

  function findComposerHost(container) {
    if (!container) return null;
    return Array.from(container.children).find((child) => {
      if (child.id === 'gpt-canvas-root') return false;
      return child.matches('form') || !!child.querySelector('form textarea, form [contenteditable="true"]');
    }) || null;
  }

  function isConversationChild(child) {
    if (!child) return false;
    if (child.matches('[data-testid="conversation-turns"]')) return true;
    if ((child.getAttribute('data-testid') || '').startsWith('conversation')) return true;
    if (child.querySelector('[data-testid="conversation-turns"]')) return true;
    if (child.querySelector('article[data-testid^="conversation-turn"]')) return true;
    if (child.querySelector('[data-message-author-role="assistant"], [data-message-author-role="user"]')) return true;
    return false;
  }

  function shouldHideChild(child, composerHost) {
    if (!child || child.id === 'gpt-canvas-root') return false;
    if (composerHost && child === composerHost) return false;
    // Nunca ocultar la zona del composer/input nativo de ChatGPT.
    if (child.matches('form')) return false;
    if (child.querySelector('form textarea, form [contenteditable="true"]')) return false;
    // Solo ocultar capas de conversación, no toda la página.
    return isConversationChild(child);
  }

  function hideNativeChildren(container, hide) {
    if (!container) return;
    const composerHost = findComposerHost(container);
    Array.from(container.children).forEach(child => {
      if (!shouldHideChild(child, composerHost)) return;
      if (hide) {
        if (child.dataset.gptHidden) return;
        child.dataset.gptHidden = '1';
        child.dataset.gptOrigVisibility = child.style.getPropertyValue('visibility');
        child.dataset.gptOrigVisibilityPriority = child.style.getPropertyPriority('visibility');
        // Retain layout so native lazy loading does not lose the message list.
        child.style.setProperty('visibility', 'hidden', 'important');
      } else {
        if (child.dataset.gptHidden) {
          child.style.setProperty('visibility', child.dataset.gptOrigVisibility || '', child.dataset.gptOrigVisibilityPriority || '');
          delete child.dataset.gptHidden;
          delete child.dataset.gptOrigVisibility;
          delete child.dataset.gptOrigVisibilityPriority;
        }
      }
    });
  }

  function removeCanvas() {
    const root = document.getElementById('gpt-canvas-root');
    if (root) {
      const container = root.parentElement;
      root.remove();
      if (container) hideNativeChildren(container, false);
    }
    const ind = document.getElementById('gpt-fork-indicator');
    if (ind) ind.remove();
    toggleNativeJumpToBottom(false);
    canvasRoot = svgLayer = blocksLayer = toolbarEl = drawCanvas = drawCtx = null;
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
    console.log('[Canvas] Canvas eliminado');
  }

  function toggleNativeJumpToBottom(hide) {
    const selectors = [
      'button[aria-label*="bottom" i]',
      'button[data-testid*="jump" i]',
      'button[data-testid*="scroll-to-bottom" i]',
    ];
    document.querySelectorAll(selectors.join(',')).forEach((btn) => {
      if (hide) {
        btn.dataset.gptOrigDisplay = btn.style.display || '';
        btn.style.setProperty('display', 'none', 'important');
      } else if (btn.dataset.gptOrigDisplay !== undefined) {
        btn.style.display = btn.dataset.gptOrigDisplay;
        delete btn.dataset.gptOrigDisplay;
      }
    });
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────────
  function bindToolbarEvents() {
    let scale = 1;

    document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
    document.getElementById('tool-highlight').addEventListener('click', () => setTool('highlight'));
    document.getElementById('tool-underline').addEventListener('click', () => setTool('underline'));
    document.getElementById('tool-text').addEventListener('click', () => setTool('text'));
    document.getElementById('tool-draw').addEventListener('click', () => setTool('draw'));

    document.getElementById('tool-zoom-in').addEventListener('click', () => {
      scale = Math.min(scale * 1.2, 3);
      blocksLayer.style.transform = `scale(${scale})`;
      svgLayer.style.transform = `scale(${scale})`;
      drawCanvas.style.transform = `scale(${scale})`;
    });
    document.getElementById('tool-zoom-out').addEventListener('click', () => {
      scale = Math.max(scale / 1.2, 0.3);
      blocksLayer.style.transform = `scale(${scale})`;
      svgLayer.style.transform = `scale(${scale})`;
      drawCanvas.style.transform = `scale(${scale})`;
    });
    document.getElementById('tool-fit').addEventListener('click', fitView);
    document.getElementById('tool-sync').addEventListener('click', syncMessagesToBlocks);
    document.getElementById('tool-close').addEventListener('click', disableCanvas);
  }

  function setTool(tool) {
    document.querySelectorAll('.gpt-tool').forEach(b => b.classList.remove('active'));
    state.annotationMode = null;
    state.markMode = null;

    if (tool === 'select') {
      document.getElementById('tool-select').classList.add('active');
    } else if (tool === 'highlight') {
      state.markMode = 'highlight';
      document.getElementById('tool-highlight').classList.add('active');
    } else if (tool === 'underline') {
      state.markMode = 'underline';
      document.getElementById('tool-underline').classList.add('active');
    } else if (tool === 'text') {
      state.annotationMode = 'text';
      document.getElementById('tool-text').classList.add('active');
    } else if (tool === 'draw') {
      state.annotationMode = 'draw';
      document.getElementById('tool-draw').classList.add('active');
    }

    updateCursor();
  }

  function updateCursor() {
    const vp = document.getElementById('gpt-canvas-viewport');
    if (!vp) return;
    if (state.annotationMode === 'draw') vp.style.cursor = 'crosshair';
    else if (state.annotationMode === 'text') vp.style.cursor = 'text';
    else if (state.markMode) vp.style.cursor = 'text';
    else vp.style.cursor = 'grab';
  }

  // ─── Viewport / pan ───────────────────────────────────────────────────────
  function bindViewportEvents() {
    const vp = document.getElementById('gpt-canvas-viewport');

    vp.addEventListener('mousedown', (e) => {
      if (state.annotationMode === 'draw') {
        startDrawing(e); return;
      }
      if (state.annotationMode === 'text') {
        const clickedCanvasBg =
          e.target === vp ||
          e.target === svgLayer ||
          e.target === drawCanvas ||
          e.target === blocksLayer;
        if (clickedCanvasBg) {
          spawnTextNote(e);
          return;
        }
      }
      if (e.target === vp || e.target === svgLayer || e.target === drawCanvas || e.target === blocksLayer) {
        // Pan
        state.panState = { startX: e.clientX, startY: e.clientY, ox: state.canvasOffset.x, oy: state.canvasOffset.y };
        vp.style.cursor = 'grabbing';
      }
    });

    vp.addEventListener('wheel', (e) => {
      if (!state.enabled) return;
      // Let long answers and code/table overflow scroll inside their block.
      if (e.target instanceof Element && e.target.closest('.gpt-block-content, .gpt-text-note-editor')) return;
      // Desplazamiento libre con rueda/trackpad dentro del canvas.
      state.canvasOffset.x -= e.deltaX;
      state.canvasOffset.y -= e.deltaY;
      applyCanvasOffset();
      saveState();
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('mousemove', (e) => {
      if (state.drawing) { continueDrawing(e); return; }
      if (state.panState) {
        state.canvasOffset.x = state.panState.ox + (e.clientX - state.panState.startX);
        state.canvasOffset.y = state.panState.oy + (e.clientY - state.panState.startY);
        applyCanvasOffset();
      }
      if (state.dragState) handleBlockDrag(e);
      if (state.resizeState) handleBlockResize(e);
    });

    window.addEventListener('mouseup', (e) => {
      if (state.drawing) { endDrawing(e); return; }
      if (state.panState) {
        state.panState = null;
        const vp2 = document.getElementById('gpt-canvas-viewport');
        if (vp2) vp2.style.cursor = state.annotationMode === 'draw' ? 'crosshair' : 'grab';
        saveState();
      }
      if (state.dragState) { state.dragState = null; saveState(); }
      if (state.resizeState) { state.resizeState = null; saveState(); }
    });
  }

  function applyCanvasOffset() {
    if (!blocksLayer) return;
    const t = `translate(${state.canvasOffset.x}px, ${state.canvasOffset.y}px)`;
    blocksLayer.style.transform = t;
    svgLayer.style.transform    = t;
    drawCanvas.style.transform  = t;
  }

  function fitView() {
    if (state.blocks.length === 0) return;
    const xs = state.blocks.map(b => b.x);
    const ys = state.blocks.map(b => b.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    state.canvasOffset.x = START_X - minX;
    state.canvasOffset.y = START_Y - minY;
    applyCanvasOffset();
    saveState();
  }

  // ─── Dibujo libre ─────────────────────────────────────────────────────────
  function resizeDrawCanvas() {
    if (!drawCanvas) return;
    const vp = document.getElementById('gpt-canvas-viewport');
    drawCanvas.width  = vp.offsetWidth  * 3; // gran superficie
    drawCanvas.height = vp.offsetHeight * 3;
  }

  function startDrawing(e) {
    state.drawing = true;
    state.drawPoints = [{ x: e.offsetX, y: e.offsetY }];
    drawCtx.beginPath();
    drawCtx.moveTo(e.offsetX, e.offsetY);
    drawCtx.strokeStyle = '#f59e0b';
    drawCtx.lineWidth   = 2.5;
    drawCtx.lineCap     = 'round';
    drawCtx.lineJoin    = 'round';
  }

  function continueDrawing(e) {
    if (!state.drawing) return;
    const rect = drawCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    drawCtx.lineTo(x, y);
    drawCtx.stroke();
  }

  function endDrawing() {
    state.drawing = false;
  }

  // ─── Notas de texto ───────────────────────────────────────────────────────
  function spawnTextNote(e) {
    const vp = document.getElementById('gpt-canvas-viewport');
    const rect = vp.getBoundingClientRect();
    const x = e.clientX - rect.left - state.canvasOffset.x;
    const y = e.clientY - rect.top  - state.canvasOffset.y;

    const noteData = {
      id: uid(),
      x,
      y,
      html: '',
    };
    state.notes.push(noteData);
    const noteEl = renderTextNote(noteData);
    const editor = noteEl?.querySelector('.gpt-text-note-editor');
    if (editor) editor.focus();
    saveState();
  }

  function renderTextNote(noteData) {
    if (!blocksLayer || !noteData) return null;
    const note = document.createElement('div');
    note.className = 'gpt-text-note';
    note.dataset.noteId = noteData.id;
    note.style.left = noteData.x + 'px';
    note.style.top  = noteData.y + 'px';
    note.innerHTML = `
      <button class="gpt-text-note-close" title="Eliminar nota" aria-label="Eliminar nota">✕</button>
      <div class="gpt-text-note-editor" contenteditable="true">${noteData.html || ''}</div>
    `;

    const editor = note.querySelector('.gpt-text-note-editor');
    const closeBtn = note.querySelector('.gpt-text-note-close');
    editor.setAttribute('contenteditable', 'true');
    editor.style.pointerEvents = 'auto';
    editor.addEventListener('mousedown', (ev) => ev.stopPropagation());
    editor.addEventListener('click', (ev) => {
      ev.stopPropagation();
      editor.focus();
    });
    editor.addEventListener('blur', () => {
      const n = state.notes.find(item => item.id === noteData.id);
      if (n) n.html = editor.innerHTML;
      saveState();
    });
    closeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      state.notes = state.notes.filter(n => n.id !== noteData.id);
      note.remove();
      saveState();
    });
    makeDraggable(
      note,
      () => {
        const n = state.notes.find(item => item.id === noteData.id);
        if (!n) return;
        n.x = parseInt(note.style.left, 10) || 0;
        n.y = parseInt(note.style.top, 10) || 0;
      },
      saveState
    );
    blocksLayer.appendChild(note);
    return note;
  }

  // ─── Bloques ──────────────────────────────────────────────────────────────
  function renderAllBlocks() {
    if (!blocksLayer) return;
    blocksLayer.innerHTML = '';
    state.blocks.forEach(renderBlock);
    state.notes.forEach(renderTextNote);
    renderConnections();
    applyPendingForkUI();
  }

  function renderBlock(block) {
    if (!blocksLayer) return;

    const el = document.createElement('div');
    el.className = 'gpt-block';
    el.id = 'block-' + block.id;
    el.style.left   = block.x + 'px';
    el.style.top    = block.y + 'px';
    el.style.width  = block.w + 'px';
    el.style.height = block.h + 'px';
    if (block.minimized) el.classList.add('minimized');

    el.innerHTML = `
      <div class="gpt-block-header">
        <span class="gpt-block-title">${escapeHtml(block.userMsg)}</span>
        <div class="gpt-block-actions">
          <button class="gpt-block-btn btn-minimize" title="Minimizar">─</button>
          <button class="gpt-block-btn btn-fork" title="Bifurcar desde aquí">+</button>
        </div>
      </div>
      <div class="gpt-block-body">
        <div class="gpt-block-content${block.contentFormat === 'rich' ? ' gpt-rich-content' : ''}">${block.contentHtml || (block.gptMsg ? escapeHtml(block.gptMsg) : '<span class="gpt-generating">Generando...</span>')}</div>
      </div>
      <div class="gpt-block-resize-handle"></div>
    `;

    // Minimizar
    el.querySelector('.btn-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      block.minimized = !block.minimized;
      el.classList.toggle('minimized', block.minimized);
      saveState();
    });

    // Bifurcar
    el.querySelector('.btn-fork').addEventListener('click', (e) => {
      e.stopPropagation();
      markForkPoint(block, el);
    });

    // Resaltado / subrayado al seleccionar texto
    const blockContentEl = el.querySelector('.gpt-block-content');
    blockContentEl.addEventListener('mouseup', () => {
      if (!state.markMode) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (!blockContentEl.contains(range.startContainer) || !blockContentEl.contains(range.endContainer)) return;
      // Wrap text ranges separately so a selection across <strong>, lists or
      // paragraphs cannot throw InvalidStateError or destroy rich structure.
      const walker = document.createTreeWalker(blockContentEl, NodeFilter.SHOW_TEXT);
      const pieces = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!range.intersectsNode(node)) continue;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        if (end > start) pieces.push({ node, start, end });
      }
      if (!pieces.length) return;
      pieces.forEach(({ node, start, end }) => {
        const part = document.createRange();
        part.setStart(node, start);
        part.setEnd(node, end);
        const span = document.createElement('span');
        span.className = state.markMode === 'highlight' ? 'gpt-highlight' : 'gpt-underline';
        part.surroundContents(span);
      });
      sel.removeAllRanges();
      block.contentHtml = blockContentEl.innerHTML;
      block.annotated = true;
      saveState();
    });

    // Drag desde header
    const header = el.querySelector('.gpt-block-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('gpt-block-btn')) return;
      e.preventDefault();
      state.dragState = {
        block, el,
        startX: e.clientX, startY: e.clientY,
        origX: block.x, origY: block.y,
      };
    });

    // Resize handle
    el.querySelector('.gpt-block-resize-handle').addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.resizeState = {
        block, el,
        startX: e.clientX, startY: e.clientY,
        origW: block.w, origH: block.h,
      };
    });

    blocksLayer.appendChild(el);
  }

  function handleBlockDrag(e) {
    const { block, el, startX, startY, origX, origY } = state.dragState;
    block.x = origX + (e.clientX - startX);
    block.y = origY + (e.clientY - startY);
    el.style.left = block.x + 'px';
    el.style.top  = block.y + 'px';
    renderConnections();
  }

  function handleBlockResize(e) {
    const { block, el, startX, startY, origW, origH } = state.resizeState;
    block.w = Math.max(200, origW + (e.clientX - startX));
    block.h = Math.max(100, origH + (e.clientY - startY));
    el.style.width  = block.w + 'px';
    el.style.height = block.h + 'px';
    renderConnections();
  }

  function markForkPoint(block, el) {
    // Quitar marca anterior
    document.querySelectorAll('.gpt-block.fork-pending').forEach(b => b.classList.remove('fork-pending'));
    state.pendingParentId = block.id;
    el.classList.add('fork-pending');

    // Indicador visual en la barra de input
    showForkIndicator(block.userMsg);
    saveState();
  }

  function showForkIndicator(title) {
    let indicator = document.getElementById('gpt-fork-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'gpt-fork-indicator';
      document.body.appendChild(indicator);
    }
    indicator.innerHTML = `<span>⎇ Bifurcando desde: <strong>${escapeHtml(title.substring(0, 40))}…</strong></span><button id="gpt-fork-cancel">✕</button>`;
    indicator.classList.add('visible');
    document.getElementById('gpt-fork-cancel').addEventListener('click', cancelFork);
  }

  function cancelFork() {
    state.pendingParentId = null;
    document.querySelectorAll('.gpt-block.fork-pending').forEach(b => b.classList.remove('fork-pending'));
    const ind = document.getElementById('gpt-fork-indicator');
    if (ind) ind.classList.remove('visible');
    saveState();
  }

  function applyPendingForkUI() {
    if (!state.pendingParentId) return;
    const block = state.blocks.find((b) => b.id === state.pendingParentId);
    const blockEl = document.getElementById('block-' + state.pendingParentId);
    if (!block || !blockEl) return;
    blockEl.classList.add('fork-pending');
    showForkIndicator(block.userMsg || 'mensaje');
  }

  // ─── Conexiones SVG ───────────────────────────────────────────────────────
  function renderConnections() {
    if (!svgLayer) return;
    svgLayer.innerHTML = '';

    // Defs para la flecha
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#6366f1" opacity="0.7"/>
      </marker>
    `;
    svgLayer.appendChild(defs);

    state.connections.forEach(conn => {
      const from = state.blocks.find(b => b.id === conn.fromId);
      const to   = state.blocks.find(b => b.id === conn.toId);
      if (!from || !to) return;

      const x1 = from.x + from.w;
      const y1 = from.y + (from.minimized ? 28 : from.h / 2);
      const x2 = to.x;
      const y2 = to.y + (to.minimized ? 28 : to.h / 2);

      const cx1 = x1 + Math.abs(x2 - x1) * 0.5;
      const cx2 = x2 - Math.abs(x2 - x1) * 0.5;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`);
      path.setAttribute('stroke', '#6366f1');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.6');
      path.setAttribute('marker-end', 'url(#arrow)');
      svgLayer.appendChild(path);
    });
  }

  // Restore first, then reconcile immediately even if the DOM is already idle.
  function restoreCanvas(delay = 0) {
    const generation = ++restoreGeneration;
    clearTimeout(restoreTimer);
    stopMessageObserver();
    state.rehydrating = true;
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (!state.enabled || generation !== restoreGeneration) return;
      loadState(() => {
        try {
          injectCanvas();
          renderAllBlocks();
          state.rehydrating = false;
          startMessageObserver();
          syncMessagesToBlocks();
        } catch (err) {
          console.error('[Canvas] No se pudo iniciar el canvas:', err);
          disableCanvas();
        }
      }, generation);
    }, delay);
  }

  function enableCanvas() {
    if (state.enabled) return;
    state.enabled = true;
    state.currentChatId = getChatId();
    chrome.storage.local.set({ canvasEnabled: true });
    restoreCanvas();
  }

  function disableCanvas() {
    state.enabled = false;
    state.rehydrating = false;
    ++restoreGeneration;
    clearTimeout(restoreTimer);
    stopMessageObserver();
    removeCanvas();
    chrome.storage.local.set({ canvasEnabled: false });
  }

  // ─── Escuchar mensajes del popup ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'toggle') {
      if (state.enabled) disableCanvas();
      else enableCanvas();
    }
    if (msg.action === 'getStatus') {
      return Promise.resolve({ enabled: state.enabled });
    }
  });

  // ─── Detectar cambio de chat (SPA navigation) ─────────────────────────────
  let lastUrl = location.href;
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const chatId = getChatId();
    if (state.enabled && chatId !== state.currentChatId) {
      if (!state.rehydrating) saveState();
      state.currentChatId = chatId;
      removeCanvas();
      restoreCanvas(800);
    }
  }
  const navObserver = new MutationObserver(checkNavigation);
  window.addEventListener('popstate', checkNavigation);
  navObserver.observe(document.body, { childList: true, subtree: true });

  // ─── Auto-restore si estaba activo ────────────────────────────────────────
  chrome.storage.local.get(['canvasEnabled'], (res) => {
    if (res.canvasEnabled) {
      setTimeout(enableCanvas, 1200);
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function makeDraggable(el, onMove, onEnd) {
    let dragging = false, sx, sy, ox, oy;
    el.addEventListener('mousedown', (e) => {
      // En notas de texto: permitir escribir/seleccionar texto y pulsar cerrar.
      const targetEl = e.target instanceof Element ? e.target : null;
      if (targetEl && (targetEl.closest('.gpt-text-note-editor') || targetEl.closest('.gpt-text-note-close'))) {
        return;
      }
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = parseInt(el.style.left) || 0;
      oy = parseInt(el.style.top)  || 0;
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top  = (oy + e.clientY - sy) + 'px';
      onMove && onMove();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      onEnd && onEnd();
    });
  }

})();
