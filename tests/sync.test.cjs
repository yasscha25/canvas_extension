const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, message, tick } = require('./helpers.cjs');

const savedBlock = (extra = {}) => ({
  id: 'saved', userMsg: 'Question', gptMsg: 'Old answer', contentHtml: 'Old answer',
  annotated: false, parentId: null, x: 123, y: 87, w: 390, h: 250, minimized: false, highlights: [], ...extra,
});
const savedCanvas = blocks => ({ blocks, notes: [{ id: 'note', x: 20, y: 20, html: 'Keep this note' }], connections: [], idCounter: 4, canvasOffset: { x: -10, y: 5 }, pendingParentId: null });

test('imports both roles inside a single conversation article', async t => {
  const page = createPage(`<article data-testid="conversation-turn-1">${message('user', 'Question', 'u1')}${message('assistant', '<p>Answer</p>')}</article>`);
  t.after(page.close);
  await page.start();
  assert.deepEqual(page.text(), ['Answer']);
  assert.equal(page.errors.length, 0);
});

test('updates when streaming changes only an existing text node', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', '<p>Start</p>'));
  t.after(page.close);
  await page.start();
  page.document.querySelector('#thread .markdown p').firstChild.data = 'Complete answer';
  await tick();
  assert.deepEqual(page.text(), ['Complete answer']);
  assert.equal(page.blocks().length, 1);
});

test('detects late role attributes and answers mounted after an empty canvas', async t => {
  const page = createPage();
  t.after(page.close);
  await page.start();
  assert.equal(page.document.getElementById('gpt-canvas-empty')?.hidden, false);
  page.document.getElementById('thread').innerHTML = '<section id="user" data-turn-id="u1">Question</section><section id="assistant"><p>Late answer</p></section>';
  await tick();
  page.document.getElementById('user').setAttribute('data-turn', 'user');
  page.document.getElementById('assistant').setAttribute('data-turn', 'assistant');
  await tick();
  assert.deepEqual(page.text(), ['Late answer']);
  assert.equal(page.document.getElementById('gpt-canvas-empty').hidden, true);
});

test('immediately refreshes a saved canvas while preserving positions and notes', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', '<p><strong>Final answer</strong></p>'), { 'canvas_test-chat': savedCanvas([savedBlock()]) });
  t.after(page.close);
  await page.start();
  assert.deepEqual(page.text(), ['Final answer']);
  assert.equal(page.document.querySelector('.gpt-block-content strong').textContent, 'Final answer');
  assert.equal(page.blocks()[0].style.left, '123px');
  assert.equal(page.store['canvas_test-chat'].blocks[0].sourceId, 'message:u1');
  assert.equal(page.document.querySelector('.gpt-text-note-editor').textContent, 'Keep this note');
});

test('keeps existing highlighted HTML when refreshing its source message', async t => {
  const html = '<p><span class="gpt-highlight">Old answer</span></p>';
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Final answer'), { 'canvas_test-chat': savedCanvas([savedBlock({ annotated: true, contentHtml: html })]) });
  t.after(page.close);
  await page.start();
  assert.equal(page.document.querySelector('.gpt-block-content').innerHTML, html);
  assert.equal(page.store['canvas_test-chat'].blocks[0].gptMsg, 'Final answer');
});

test('matches IDs when the DOM loses older turns, including repeated prompts', async t => {
  const page = createPage(message('user', 'Again', 'u1') + message('assistant', 'First') + message('user', 'Again', 'u2') + message('assistant', 'Second'));
  t.after(page.close);
  await page.start();
  page.document.getElementById('thread').innerHTML = message('user', 'Again', 'u2') + message('assistant', 'Second updated');
  await tick();
  assert.deepEqual(page.text(), ['First', 'Second updated']);
  page.document.getElementById('thread').insertAdjacentHTML('beforeend', message('user', 'Again', 'u3') + message('assistant', 'Third'));
  await tick();
  assert.deepEqual(page.text(), ['First', 'Second updated', 'Third']);
});

test('does not erase a captured answer during a transient empty render', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Keep answer'));
  t.after(page.close);
  await page.start();
  page.document.querySelector('#thread .markdown').textContent = '';
  await tick();
  assert.deepEqual(page.text(), ['Keep answer']);
});

test('reinjects the canvas after the native container is replaced', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Before'));
  t.after(page.close);
  await page.start();
  page.document.querySelector('main').innerHTML = `<div id="thread">${message('user', 'Question', 'u1')}${message('assistant', 'After')}</div><form><div id="prompt-textarea" contenteditable="true"></div></form>`;
  await tick();
  assert.equal(page.document.querySelectorAll('#gpt-canvas-root').length, 1);
  assert.deepEqual(page.text(), ['After']);
  assert.equal(page.errors.length, 0);
});

test('does not rescan or save on its own canvas mutations', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Answer'));
  t.after(page.close);
  await page.start();
  await tick();
  const writes = page.writes.length;
  page.document.querySelector('.gpt-block-content').textContent = 'Canvas-only edit';
  await tick();
  assert.deepEqual(page.text(), ['Canvas-only edit']);
  assert.equal(page.writes.length, writes);
});

test('scrolls long block content without panning the entire canvas', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Answer'));
  t.after(page.close);
  await page.start();
  const event = new page.window.WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
  page.document.querySelector('.gpt-block-content').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(page.store['canvas_test-chat'].canvasOffset.y, 0);
});

test('highlights a selection crossing rich elements without breaking markup', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', '<p>Plain <strong>bold</strong> tail</p>'));
  t.after(page.close);
  await page.start();
  page.document.getElementById('tool-highlight').click();
  const paragraph = page.document.querySelector('.gpt-block-content p');
  assert.ok(paragraph);
  const range = page.document.createRange();
  range.setStart(paragraph.firstChild, 0);
  range.setEnd(paragraph.querySelector('strong').firstChild, 2);
  page.window.getSelection().addRange(range);
  paragraph.dispatchEvent(new page.window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(page.document.querySelectorAll('.gpt-highlight').length, 2);
  assert.equal(paragraph.querySelector('strong').textContent, 'bold');
  assert.equal(page.store['canvas_test-chat'].blocks[0].annotated, true);
  assert.equal(page.errors.length, 0);
});

test('restores native visibility and cancels a pending restore when disabled', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'Answer'));
  t.after(page.close);
  await page.start();
  page.toggle();
  assert.equal(page.document.getElementById('gpt-canvas-root'), null);
  assert.equal(page.document.getElementById('thread').style.visibility, '');
  page.toggle();
  page.toggle();
  await tick();
  assert.equal(page.document.getElementById('gpt-canvas-root'), null);
  assert.equal(page.errors.length, 0);
});

test('switches SPA chats without carrying messages or stale delayed callbacks', async t => {
  const page = createPage(message('user', 'Question', 'u1') + message('assistant', 'First chat'));
  t.after(page.close);
  await page.start();
  page.window.history.pushState({}, '', '/c/second-chat');
  page.document.getElementById('thread').innerHTML = message('user', 'Second', 'u2') + message('assistant', 'Second chat');
  await tick(30);
  page.window.history.pushState({}, '', '/c/third-chat');
  page.document.getElementById('thread').innerHTML = message('user', 'Third', 'u3') + message('assistant', 'Third chat');
  await tick(900);
  assert.deepEqual(page.text(), ['Third chat']);
  assert.equal(page.store['canvas_test-chat'].blocks[0].gptMsg, 'First chat');
  assert.equal(page.store['canvas_third-chat'].blocks[0].gptMsg, 'Third chat');
  assert.equal(page.store['canvas_second-chat'], undefined);
  assert.equal(page.errors.length, 0);
});
