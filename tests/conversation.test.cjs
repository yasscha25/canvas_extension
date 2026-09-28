const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, message } = require('./helpers.cjs');

test('reads role messages in document order, including several assistant chunks', t => {
  const page = createPage(message('assistant', 'Orphan') + message('user', 'First', 'u1') + message('assistant', '<p>Part one</p>') + message('assistant', '<p>Part two</p>') + message('user', 'Second', 'u2') + message('assistant', 'Last'));
  t.after(page.close);
  assert.deepEqual(page.getTurns().map(({ userMsg, gptMsg }) => [userMsg, gptMsg]), [['First', 'Part one\n\nPart two'], ['Second', 'Last']]);
});

test('detects data-turn wrappers without old articles or author-role attributes', t => {
  const page = createPage('<section data-turn="user" data-turn-id="u1"><div class="whitespace-pre-wrap">Question</div></section><section data-turn="assistant"><div class="prose"><p>Answer</p></div></section>');
  t.after(page.close);
  assert.equal(page.getTurns()[0].gptMsg, 'Answer');
  assert.equal(page.getTurns()[0].sourceId, 'turn:u1');
});

test('supports both roles inside one article and ignores nested duplicate wrappers', t => {
  const page = createPage(`<article data-testid="conversation-turn-1"><section data-turn="user">${message('user', 'Question', 'u1')}</section><section data-turn="assistant">${message('assistant', 'Answer')}</section></article>`);
  t.after(page.close);
  assert.equal(page.getTurns().length, 1);
  assert.equal(page.getTurns()[0].gptMsg, 'Answer');
});

test('retains legacy article-only detection and a pending user prompt', t => {
  const page = createPage('<article data-testid="conversation-turn-1"><div class="whitespace-pre-wrap">Question</div></article><article data-testid="conversation-turn-2"><p>Answer</p><button>Copy</button></article><article data-testid="conversation-turn-3">Pending</article>');
  t.after(page.close);
  assert.deepEqual(page.getTurns().map(t => [t.userMsg, t.gptMsg]), [['Question', 'Answer'], ['Pending', '']]);
});

test('preserves lists, tables, links and code, but drops controls and active HTML', t => {
  const page = createPage(message('user', 'Format', 'u1') + message('assistant', `<h2>Heading</h2><ul><li><strong>Bold</strong></li></ul><table><tbody><tr><td>Cell</td></tr></tbody></table><pre><div>JS<button>Copy</button></div><code>a &lt; b\n  indented</code></pre><a href="https://example.com" onclick="alert(1)">Safe</a><a href="javascript:alert(1)">Unsafe</a><img src="x" onerror="alert(1)" alt="Image"><script>alert(1)</script><svg><text>icon</text></svg><span class="sr-only">Screen label</span><button>Feedback</button>`));
  t.after(page.close);
  const turn = page.getTurns()[0];
  assert.match(turn.gptHtml, /<h2>Heading<\/h2>/);
  assert.match(turn.gptHtml, /<ul><li><strong>Bold/);
  assert.match(turn.gptHtml, /<table>/);
  assert.match(turn.gptHtml, /<pre><code>a &lt; b\n  indented<\/code><\/pre>/);
  assert.match(turn.gptHtml, /rel="noopener noreferrer"/);
  assert.doesNotMatch(turn.gptHtml, /onclick|onerror|javascript:|<script|<svg|<button|data-message/);
  assert.doesNotMatch(turn.gptMsg, /Copy|Feedback|Screen label|alert\(1\)|icon/);
});

test('reads hidden native layout, excluding canvas copies and hidden alternatives', t => {
  const page = createPage(`<div style="visibility:hidden">${message('user', 'Question', 'u1')}${message('assistant', '<p>A</p><p>B</p>')}</div><div hidden>${message('user', 'Old version')}${message('assistant', 'Old answer')}</div><div id="gpt-canvas-root">${message('user', 'Copied prompt')}${message('assistant', 'Copied answer')}</div>`);
  t.after(page.close);
  assert.equal(page.getTurns().length, 1);
  assert.equal(page.getTurns()[0].gptMsg, 'A\n\nB');
});

test('represents attachment-only prompts instead of dropping the answer', t => {
  const page = createPage('<section data-testid="user-message" data-message-id="image"><img alt="Diagram"></section><section data-testid="assistant-message"><p>Description</p></section>');
  t.after(page.close);
  assert.deepEqual(page.getTurns().map(t => [t.userMsg, t.gptMsg]), [['Diagram', 'Description']]);
});
