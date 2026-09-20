'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHarness } = require('./fixtures/tag-library.cjs');
const fs = require('node:fs');
const editorPath = '../src/views/tag-editor-view';
function factory() { assert.ok(fs.existsSync(require('node:path').join(__dirname, editorPath + '.js')), 'shared editor exists'); return require(editorPath).createTagEditorView; }
const placement = { kind: 'favorite', page: { id: 'home' }, group: { id: 'daily' } };
async function setup(t, options = {}) {
  const h = options.harness || createHarness(); await h.ready;
  const dom = new JSDOM('<body><button id="origin">Origin</button></body>');
  const document = dom.window.document; document.querySelector('#origin').focus();
  const editor = factory()({ document, catalog: options.catalog || h.library, getLocale: () => 'en-US', confirmDiscard: async () => 'discard', ...options });
  const field = key => document.querySelector(`[data-tag-field="${key}"]`);
  const input = (key, value) => { const node = field(key); if (typeof value === 'boolean') node.checked = value; else node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  t.after(() => { editor.dispose(); dom.window.close(); });
  return { ...h, dom, document, editor, field, input };
}
test('new prefilled opaque bundle cancellation writes no tags or placement', async t => {
  const h = await setup(t); const count = h.library.listTags({ scope:'all', includeAdult:true }).total;
  await h.editor.open({ initialValues: { kind:'bundle', content:'  A, (b:1.2)\r\nc\nd  ' }, placement: { kind:'favorite', page:{create:{name:'Draft page'}}, group:{create:{name:'Draft group'}} } });
  assert.equal(h.editor.isDirty(), false); h.input('note', 'draft');
  await h.editor.requestClose();
  assert.equal(h.library.listTags({ scope:'all', includeAdult:true }).total, count); assert.equal(h.repository.saveCount, 0); assert.equal(h.library.getMemberships().length, 0);
  assert.equal(h.document.activeElement.id, 'origin');
});
test('seven fields save, clear and preserve untouched CRLF content and aliases', async t => {
  const h = await setup(t); const original = '  A\r\nB\nC\r\n  ';
  await h.editor.open({initialValues:{kind:'bundle',content:original,aliases:['two words',' literal, phrase '],displayName:'Name'}, placement});
  h.input('note', '<img src=x onerror=alert(1)>'); h.input('adult', true); h.input('searchable', false);
  const saved = await h.editor.save(); assert.equal(saved.ok, true); const id = saved.data.tagId;
  await h.editor.open({tagId:id, initialValues:{content:'must not override'}}); h.input('displayName',''); h.input('note','');
  assert.equal((await h.editor.save()).ok,true);
  const reloaded = await h.reload(); const tag = reloaded.getTag(id);
  assert.equal(tag.content,original); assert.deepEqual(tag.aliases,['two words',' literal, phrase ']); assert.equal(tag.displayName,''); assert.equal(tag.note,''); assert.equal(tag.adult,true); assert.equal(tag.searchable,false);
  await h.editor.open({tagId:id}); h.input('aliases','long phrase\nother phrase'); h.input('content','new\ntext'); await h.editor.save();
  assert.deepEqual(h.library.getTag(id).aliases,['long phrase','other phrase']); assert.equal(h.library.getTag(id).content,'new\ntext'); assert.equal(h.document.querySelector('img'),null);
});
test('failure preserves draft; same retry uses same operation and changed retry uses a new operation', async t => {
  const h = await setup(t); const calls=[]; const catalog = { ...h.library, execute: (c,o) => { calls.push({c,o}); return h.library.execute(c,o); } }; await h.editor.dispose();
  const reopened = await setup(t, { catalog, harness: h });
  await reopened.editor.open({initialValues:{content:'fresh'},placement}); h.controls.failNextSave(); assert.equal((await reopened.editor.save()).error.code,'STORAGE_WRITE_FAILED');
  assert.equal(reopened.field('content').value,'fresh'); assert.equal((await reopened.editor.save()).ok,true); assert.equal(calls[0].o.operationId,calls[1].o.operationId);
  await reopened.editor.open({initialValues:{content:'another'}}); h.controls.failNextSave(); await reopened.editor.save(); reopened.input('content','changed'); assert.equal((await reopened.editor.save()).ok,true); assert.notEqual(calls[2].o.operationId,calls[3].o.operationId);
});
test('pending double save commits once and freezes draft controls', async t => {
  const h=await setup(t); await h.editor.open({initialValues:{content:'one'},placement}); const delay=h.controls.delayNextSave(); const a=h.editor.save(); const b=h.editor.save(); await delay.started;
  assert.equal(h.field('content').disabled,true); assert.equal(await h.editor.requestClose(),false); delay.release(); assert.deepEqual(await a, await b); assert.equal(h.repository.saveCount,1);
});
test('concurrent revision conflict retains draft and focuses explicit reload', async t => {
  const h=await setup(t); await h.editor.open({tagId:'blue_hair'}); h.input('note','my draft'); await h.library.execute({type:'saveTag',tagId:'long_hair',patch:{note:'other'}},{operationId:'outside'});
  assert.equal((await h.editor.save()).error.code,'REVISION_CONFLICT'); assert.equal(h.field('note').value,'my draft'); assert.match(h.document.querySelector('[data-tag-error]').textContent,/reload/i);
});
test('dirty switching honors stay, save and discard; shared reference note is plain text', async t => {
  let answer='stay'; const h=await setup(t,{confirmDiscard:async()=>answer}); await h.editor.open({tagId:'blue_hair'}); assert.match(h.document.querySelector('[data-tag-shared]').textContent,/2/); h.input('note','mine');
  assert.equal(await h.editor.open({tagId:'long_hair'}),false); assert.equal(h.field('note').value,'mine'); answer='save'; assert.equal(await h.editor.open({tagId:'long_hair'}),true); assert.equal(h.library.getTag('blue_hair').note,'mine');
  h.input('note','discarded'); answer='discard'; await h.editor.requestClose(); assert.equal(h.library.getTag('long_hair').note,'');
});
test('duplicate offers explicit independent or existing reference with canonical metadata', async t => {
  const h=await setup(t); await h.editor.open({initialValues:{content:'blue hair',displayName:'stale'},placement}); const fail=await h.editor.save(); assert.equal(fail.error.code,'DUPLICATE_CONTENT'); assert.deepEqual(fail.error.existingTagIds,['blue_hair']);
  h.document.querySelector('[data-tag-reference="blue_hair"]').click(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.library.getMemberships('blue_hair').length,1); assert.equal(h.library.getTag('blue_hair').displayName,'蓝发');
  await h.editor.open({initialValues:{content:'blue hair'},placement}); await h.editor.save(); h.document.querySelector('[data-tag-independent]').click(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.library.listTags({scope:'all',includeAdult:true}).items.filter(x=>x.content==='blue hair').length,2);
});
test('existing duplicate independent preserves tag identity and all relationships', async t => {
  const h=await setup(t); await h.editor.open({tagId:'blue_hair'}); h.input('content','long hair'); await h.editor.save(); assert.equal(h.document.querySelector('[data-tag-reference]'),null); h.document.querySelector('[data-tag-independent]').click(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.library.getTag('blue_hair').content,'long hair'); assert.ok(h.library.getCharacterLinks('alice').generalTagIds.includes('blue_hair'));
});
test('child modal owns Escape/focus and cancels without closing or clearing parent draft', async t => {
  const h=await setup(t); await h.editor.open({tagId:'blue_hair'}); h.input('note','draft'); h.document.querySelector('[data-tag-location]').click();
  const child=h.document.querySelector('[data-tag-location-overlay]'); assert.equal(child.hidden,false); h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(child.hidden,true); assert.equal(h.document.querySelector('[data-tag-editor-overlay]').hidden,false); assert.equal(h.field('note').value,'draft'); assert.ok(h.document.activeElement.matches('[data-tag-location]'));
});
test('keyboard IME suppresses save, Ctrl Enter saves and focus is trapped', async t => {
  const h=await setup(t); await h.editor.open({initialValues:{content:'keyboard'}}); const node=h.field('content'); node.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true})); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.repository.saveCount,0);
  h.document.querySelector('#origin').focus(); assert.ok(h.document.querySelector('[data-tag-editor-overlay]').contains(h.document.activeElement)); node.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.repository.saveCount,1);
});
test('restore explicitly commits only restore after discarding dirty draft', async t => {
  const h=await setup(t); await h.library.execute({type:'saveTag',tagId:'blue_hair',patch:{note:'override'}},{operationId:'setup'}); await h.editor.open({tagId:'blue_hair'}); h.input('note','unsaved'); h.document.querySelector('[data-tag-restore]').click(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.library.getTag('blue_hair').note,''); assert.equal(h.repository.saveCount,2);
});
test('placement-only edit is dirty, memberships require selection, taxonomy retains favorites',async t=>{
 const h=await setup(t); await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement},{operationId:'fav'});
 await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement:{kind:'favorite',page:{id:'home'},group:{create:{name:'Second'}}}},{operationId:'fav2'});
 await h.editor.open({tagId:'blue_hair'}); const select=h.document.querySelector('[data-tag-membership]'); assert.ok(select); assert.equal(select.value,''); assert.match(h.document.querySelector('[data-tag-taxonomy-summary]').textContent,/头发/);
 select.value=h.library.getMemberships('blue_hair')[0].id; select.dispatchEvent(new h.dom.window.Event('change',{bubbles:true})); h.document.querySelector('[data-tag-taxonomy]').click();
 h.document.querySelector('[data-location-parent]').value='hair'; h.document.querySelector('[data-location-parent]').dispatchEvent(new h.dom.window.Event('change',{bubbles:true})); h.document.querySelector('[data-location-child]').value='shape'; h.document.querySelector('[data-location-confirm]').click(); await new Promise(r=>setImmediate(r)); assert.equal(h.editor.isDirty(),true); assert.equal((await h.editor.save()).ok,true); assert.equal(h.library.getTag('blue_hair').subcategoryId,'shape'); assert.equal(h.library.getMemberships('blue_hair').length,2);
});
test('default dirty guard is an accessible three choice modal and real checkbox controls',async t=>{
 const h=await setup(t,{confirmDiscard:undefined}); await h.editor.open({initialValues:{content:'default guard'}}); assert.equal(h.field('adult').tagName,'INPUT'); assert.equal(h.field('adult').type,'checkbox'); h.input('note','dirty'); const closing=h.editor.requestClose(); const modal=h.document.querySelector('[data-tag-discard-overlay]'); assert.equal(modal.hidden,false); h.document.querySelector('[data-tag-stay]').click(); assert.equal(await closing,false); assert.equal(h.editor.isDirty(),true);
});
test('duplicate inspect is available without favorite placement and protects dirty edits',async t=>{
 const h=await setup(t,{confirmDiscard:async()=> 'stay'}); await h.editor.open({initialValues:{content:'fresh'}}); h.input('content','blue hair'); await h.editor.save(); h.document.querySelector('[data-tag-inspect="blue_hair"]').click(); await new Promise(r=>setImmediate(r)); assert.equal(h.field('content').value,'blue hair'); assert.equal(h.field('displayName').value,'');
});
test('invalid prefill rejected without write; new prefill is copied; checkbox and locale refresh',async t=>{
 const h=await setup(t); assert.equal(await h.editor.open({initialValues:{aliases:'invalid'}}),false); assert.equal(h.repository.saveCount,0); const initial={content:'new',aliases:['two words']}; await h.editor.open({initialValues:initial}); initial.aliases.push('mutated'); const result=await h.editor.save(); assert.deepEqual(h.library.getTag(result.data.tagId).aliases,['two words']);
});
test('child owns focus continuously; stale child result cannot change reopened editor',async t=>{
 const h=await setup(t); await h.editor.open({tagId:'blue_hair'}); h.document.querySelector('[data-tag-location]').click(); const overlay=h.document.querySelector('[data-tag-location-overlay]'); assert.ok(overlay.contains(h.document.activeElement)); assert.equal(await h.editor.open({tagId:'long_hair'}),false); h.document.querySelector('[data-location-cancel]').click(); await new Promise(r=>setImmediate(r)); assert.equal(await h.editor.open({tagId:'long_hair'}),true);
});
test('reload requires discard and restore save choice does not silently restore after save',async t=>{
 let answer='save'; const h=await setup(t,{confirmDiscard:async()=>answer}); await h.editor.open({tagId:'blue_hair'}); h.input('note','keep'); h.document.querySelector('[data-tag-restore]').click(); await new Promise(r=>setImmediate(r)); assert.equal(h.library.getTag('blue_hair').note,'keep');
 await h.editor.open({tagId:'blue_hair'}); h.input('note','draft'); await h.library.execute({type:'saveTag',tagId:'long_hair',patch:{note:'external'}},{operationId:'ext'}); await h.editor.save(); answer='discard'; h.document.querySelector('[data-tag-reload]').click(); await new Promise(r=>setImmediate(r)); assert.equal(h.field('note').value,'keep'); assert.equal(h.editor.isDirty(),false);
});
test('external single picker created after editor owns Escape, focus, and remains reusable after editor disposal',async t=>{
 const {createTagLocationView}=require('../src/views/tag-location-view');let actual;const injected={choose:input=>actual.choose(input)};
 const h=await setup(t,{locationView:injected}); actual=createTagLocationView({document:h.document,catalog:h.library,getLocale:()=> 'en-US'});t.after(()=>actual.dispose());
 await h.editor.open({initialValues:{content:'external'}});h.field('adult').click();assert.equal(h.field('adult').checked,true);h.document.querySelector('[data-tag-location]').click();
 const child=h.document.querySelector('[data-tag-location-overlay]');assert.equal(h.document.querySelectorAll('[data-tag-location-overlay]').length,1);assert.ok(child.contains(h.document.activeElement));h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(r=>setImmediate(r));assert.equal(h.document.querySelector('[data-tag-editor-overlay]').hidden,false);assert.equal(h.editor.isDirty(),true);
 h.editor.dispose();const pending=actual.choose({kind:'taxonomy'});h.document.querySelector('[data-location-cancel]').click();assert.equal(await pending,null);
});
test('exact membership move rejects duplicate destination with draft retained',async t=>{
 const h=await setup(t);const a=await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement},{operationId:'a'});await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement:{kind:'favorite',page:{id:'home'},group:{create:{name:'Second'}}}},{operationId:'b'});const destination=h.library.getFavoriteGroups('home').find(x=>x.name==='Second');
 await h.editor.open({tagId:'blue_hair',membershipId:a.data.membershipId,placement:{kind:'favorite',page:{id:'home'},group:{id:destination.id}}});h.input('note','retained');assert.equal((await h.editor.save()).error.code,'DUPLICATE_MEMBERSHIP');assert.equal(h.field('note').value,'retained');assert.equal(h.library.getTag('blue_hair').note,'');assert.equal(h.library.getMemberships().find(x=>x.id===a.data.membershipId).groupId,'daily');
});
test('late external picker and delayed confirmation cannot revive disposed editor',async t=>{
 let resolve;const h=await setup(t,{locationView:{choose:()=>new Promise(r=>{resolve=r;})}});await h.editor.open({initialValues:{content:'late'}});h.document.querySelector('[data-tag-location]').click();h.editor.dispose();resolve(placement);await new Promise(r=>setImmediate(r));assert.equal(h.document.querySelector('[data-tag-editor-overlay]'),null);assert.equal(h.repository.saveCount,0);
});
test('initial locale keys match both packs and switching locale refreshes all editor captions',async t=>{
 let locale='en-US';const h=await setup(t,{getLocale:()=>locale});await h.editor.open({initialValues:{content:'locale'}});assert.match(h.document.querySelector('[data-tag-location]').textContent,/Choose/);await h.editor.requestClose();locale='zh-CN';await h.editor.open({initialValues:{content:'locale'}});assert.equal(h.document.querySelector('[data-tag-location]').textContent,'选择位置');
 const {messages}=require('../src/views/tag-location-view');for(const [file,index] of [['../locales/zh-CN.json',0],['../locales/en-US.json',1]]){const pack=require(file);for(const [section,entries]of Object.entries(messages))for(const [key,words]of Object.entries(entries))assert.equal(pack.ui[section][key],words[index]);}
});
test('incoming favorite destination cannot bypass exact membership selection',async t=>{
 const h=await setup(t);const a=await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement},{operationId:'a'});await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement:{kind:'favorite',page:{id:'home'},group:{create:{name:'second'}}}},{operationId:'b'});
 const before=h.repository.saveCount;await h.editor.open({tagId:'blue_hair',placement:{kind:'favorite',page:{create:{name:'new-page'}},group:{create:{name:'new-group'}}}});
 assert.equal((await h.editor.save()).ok,false);assert.equal(h.repository.saveCount,before);assert.equal(h.library.getFavoritePages().length,1);assert.equal(h.library.getMemberships('blue_hair').length,2);
 const select=h.document.querySelector('[data-tag-membership]');select.value=a.data.membershipId;select.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));h.input('note','exact');assert.equal((await h.editor.save()).ok,true);assert.equal(h.library.getMemberships('blue_hair').length,2);
});
test('single existing membership binds incoming favorite destination while taxonomy remains separate',async t=>{
 const h=await setup(t);const a=await h.library.execute({type:'favoriteTag',tagId:'blue_hair',placement},{operationId:'a'});await h.editor.open({tagId:'blue_hair',placement:{kind:'favorite',page:{id:'home'},group:{create:{name:'moved'}}}});assert.equal((await h.editor.save()).ok,true);const rows=h.library.getMemberships('blue_hair');assert.equal(rows.length,1);assert.equal(rows[0].id,a.data.membershipId);assert.notEqual(rows[0].groupId,'daily');
 await h.editor.open({tagId:'blue_hair',membershipId:a.data.membershipId,placement:{kind:'taxonomy',category:{id:'hair'},subcategory:{id:'shape'}}});assert.equal((await h.editor.save()).ok,true);assert.equal(h.library.getTag('blue_hair').subcategoryId,'shape');assert.equal(h.library.getMemberships('blue_hair')[0].groupId,rows[0].groupId);
});
