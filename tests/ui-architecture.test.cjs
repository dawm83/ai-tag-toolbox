'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

test('content factories require one shared library and contain no legacy storage branch', () => {
  for (const [name, factory] of [['tags', 'createTags'], ['favorites', 'createFavorites'], ['characters', 'createCharacters']]) {
    const source = fs.readFileSync(path.join(root, 'src/modules', name + '.js'), 'utf8');
    assert.doesNotMatch(source, /rewrite_custom_tags|favorites_shelf_v1|rewrite_character_edits_v1|options\.library\)\s*return/);
    assert.throws(() => require('../src/modules/' + name)[factory](), /统一标签库/);
  }
});

test('view modules do not acquire repository, filesystem or legacy storage authority', () => {
  const viewFiles = fs.readdirSync(path.join(root, 'src/views')).filter(file => file.endsWith('.js')).map(file => path.join(root, 'src/views', file));
  for (const filename of [...viewFiles, path.join(root, 'src/app-view.js')]) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /require\s*\(\s*['"](?:node:|(?:fs|path)['"]|[^'"]*(?:tag-library\/repository|modules\/storage))/);
    assert.doesNotMatch(source, /rewrite_custom_tags|favorites_shelf_v1|rewrite_character_edits_v1/);
  }
});
test('view factories load as browser scripts before the app composer', () => {
  const context = vm.createContext({});
  for (const name of ['settings', 'comfy', 'prompt', 'agent-status', 'call-monitor']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/views', `${name}-view.js`), 'utf8'), context);
  }
  for (const name of ['settings', 'comfy', 'prompt', 'agentStatus', 'callMonitor']) assert.ok(context.AppViews[name]);
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.ok(html.indexOf('views/settings-view.js') < html.indexOf('src="app-view.js"'));
});
test('the app composes views and has no old prompt modes or renderer persistence access', () => {
  const app = fs.readFileSync(path.join(root, 'src/app-view.js'), 'utf8');
  const entry = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.doesNotMatch(app + entry, /modules\.storage|talkMode|tkDraw/);
  assert.match(app, /viewFactories\.settings/);
  assert.match(app, /viewFactories\.comfy/);
  assert.match(app, /viewFactories\.prompt/);
  assert.match(app, /viewFactories\.agentStatus/);
});

test('medium desktop header centers every navigation row on one axis', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'app.css'), 'utf8');
  const marker = '/* V1.4.210：非最大化窗口导航居中。';
  const start = css.lastIndexOf(marker);
  assert.ok(start >= 0, 'the non-maximized navigation override should be present');
  const override = css.slice(start);
  assert.match(override, /@media\s*\(min-width:861px\)\s*and\s*\(max-width:1500px\)\s*\{[\s\S]*?header\s*\{[\s\S]*?grid-template-columns\s*:\s*minmax\(0,1fr\)/);
  assert.match(override, /\.header-side-left\s*\{[\s\S]*?justify-content\s*:\s*center/);
  assert.match(override, /\.header-trailing\s*\{[\s\S]*?justify-content\s*:\s*center/);
  assert.match(override, /header\s+\.header-workspace\s*\{[\s\S]*?grid-row\s*:\s*2[\s\S]*?justify-self\s*:\s*center/);
  assert.match(override, /header\s+\.header-workspace\s+#aiCfgBtns\s*\{[\s\S]*?justify-content\s*:\s*center/);
  assert.match(override, /\.header-left\s*\{[\s\S]*?position\s*:\s*absolute[\s\S]*?left\s*:\s*0/);
  assert.match(override, /\.header-leading\s*\{[\s\S]*?margin-inline\s*:\s*auto/);
  assert.match(css, /@media\s*\(min-width:1501px\)/, 'wide desktop rules should remain separate');
});

test('generation UI consumes dotted state-machine events and keeps stable candidate tracks', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app-view.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'app.css'), 'utf8');
  assert.match(app, /candidate\.ready/);
  assert.match(app, /candidate\.evaluated/);
  assert.match(app, /generation\.needs_input/);
  assert.match(css, /\.draw-round-track\s*\{[^}]*display\s*:\s*flex[^}]*overflow-x\s*:\s*auto/);
  assert.match(css, /\.draw-candidate\s*\{[^}]*flex\s*:\s*0 0/);
});

test('tool trace renders runtime failures from the trace envelope', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app-view.js'), 'utf8');
  assert.match(app, /call\.ok\s*===\s*false\s*\|\|\s*call\.error/);
});

test('text selection and final prompt controls remain usable in the conversation UI', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app-view.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'app.css'), 'utf8');
  const theme = fs.readFileSync(path.join(root, 'src', 'workspace-theme.css'), 'utf8');
  assert.match(app, /draw-final-copy/);
  assert.match(app, /draw-final-prompt/);
  assert.match(css, /\.talkin textarea[^}]*cursor:text/);
  assert.match(css, /\.genout[^}]*user-select:text/);
  assert.match(theme, /::selection\s*\{[^}]*background/);
});

test('preload exposes the scoped final-selection command', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.match(preload, /selectGenerationFinal:\s*assistant\.selectGenerationFinal/);
  assert.doesNotMatch(preload, /generation:\s*assistant\.generation/);
});

test('new generation controls replace the old strategy selector', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="generationStrategy"|id="generationAutoSelect"/);
  for (const id of ['imagesPerRound', 'maxAutoRounds', 'generationAutoRun']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="talkComfyDebug"[^>]*title=/);
});
