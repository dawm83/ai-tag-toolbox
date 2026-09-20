'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWdGeneral } = require('../src/modules/tag-library/wd-general-taxonomy');
const { makeBase } = require('./fixtures/tag-library.cjs');
const path = require('node:path');
let corpus;
function oldCorpus() {
  if (!corpus) {
    const result = require('../src/modules/tag-library/seed').buildUnifiedSeed({
      tags:require('../src/modules/tags').loadTagFiles({assetDir:path.resolve(__dirname,'../assets')}),
      characters:require('../assets/数据资产/角色/characters.json'), specificTags:require('../assets/数据资产/角色/specific-tags.json'), manifest:require('../assets/数据资产/角色/manifest.json')
    },{classifyModel:false});
    assert.equal(result.ok,true);corpus=result.data;
  }
  return corpus;
}

function fixture() {
  const base = makeBase();
  base.categories.push({ id:'wd_general',name:'模型通用词',order:1,source:'bundled' },{ id:'nsfw',name:'成人标签',order:2,source:'bundled' });
  base.subcategories.push({id:'model',categoryId:'wd_general',name:'默认',order:0,source:'bundled'}, {id:'adult',categoryId:'nsfw',name:'默认',order:0,source:'bundled'});
  base.tags[0].categoryId='wd_general';base.tags[0].subcategoryId='model';
  return base;
}

test('explicit model taxonomy changes exact IDs while preserving text, names, references and existing curated categories', () => {
  const base=fixture(), before=structuredClone(base);
  const groups=[{categoryId:'hair',subcategoryName:'颜色',tagIds:['blue_hair','long_hair']}];
  const result=classifyWdGeneral(base,{groups});
  assert.deepEqual(base,before);
  assert.equal(result.base.tags[0].categoryId,'hair');assert.equal(result.base.tags[0].subcategoryId,'color');
  assert.deepEqual(result.base.tags[1],before.tags[1], 'already categorized Tags keep their placement');
  for(const field of Object.keys(before.tags[0]).filter(k=>!['categoryId','subcategoryId'].includes(k)))assert.deepEqual(result.base.tags[0][field],before.tags[0][field]);
  assert.deepEqual(result.base.characterLinks,before.characterLinks);
  assert.deepEqual(classifyWdGeneral(result.base,{groups}).base,result.base);
});

test('model adult classifications mark the existing record instead of creating or rewriting Tags', () => {
  const base=fixture();
  const result=classifyWdGeneral(base,{groups:[{categoryId:'nsfw',subcategoryName:'默认',adult:true,tagIds:['blue_hair']}]});
  assert.equal(result.base.tags.length,base.tags.length);
  assert.equal(result.base.tags[0].id,'blue_hair');assert.equal(result.base.tags[0].content,'blue hair');
  assert.equal(result.base.tags[0].adult,true);assert.equal(result.base.tags[0].searchable,true);
  assert.equal(result.base.tags[0].categoryId,'nsfw');
});

test('invalid or conflicting classification targets fail instead of silently leaving entries in the model bucket', () => {
  const base=fixture();
  assert.throws(()=>classifyWdGeneral(base,{groups:[{categoryId:'hair',subcategoryName:'不存在',tagIds:['blue_hair']}]}));
  assert.throws(()=>classifyWdGeneral(base,{groups:[{categoryId:'hair',subcategoryName:'颜色',tagIds:['blue_hair','blue_hair']}]}));
  assert.throws(()=>classifyWdGeneral(base,{groups:[{categoryId:'hair',subcategoryName:'颜色',adult:true,tagIds:['blue_hair']}]}));
});

test('the complete WD general bucket is classified without changing a single prompt byte or reference', () => {
  const before=oldCorpus(),result=classifyWdGeneral(before), byId=new Map(result.base.tags.map(row=>[row.id,row]));
  const mapped=require('../assets/数据资产/标签/wd-general-taxonomy.json').groups.flatMap(group=>group.tagIds);
  assert.deepEqual(new Set(mapped),new Set(before.tags.filter(row=>row.categoryId==='wd_general').map(row=>row.id)));
  assert.equal(result.changes.length,before.tags.filter(row=>row.categoryId==='wd_general').length);
  assert.equal(result.base.tags.filter(row=>row.categoryId==='wd_general').length,0);
  assert.equal(result.base.tags.length,before.tags.length);
  for(const tag of before.tags){
    const actual=byId.get(tag.id);
    for(const key of Object.keys(tag).filter(key=>!['categoryId','subcategoryId','adult'].includes(key))) assert.deepEqual(actual[key],tag[key],`${tag.id}.${key}`);
    if(actual.adult!==tag.adult){assert.equal(tag.categoryId,'wd_general');assert.equal(actual.categoryId,'nsfw');assert.equal(actual.adult,true);}
    if(tag.categoryId!=='wd_general')assert.deepEqual(actual,tag);
  }
  assert.deepEqual(result.base.characterLinks,before.characterLinks);
  assert.equal(require('../src/modules/tag-library/schema').validateBase(result.base).ok,true);
  const examples={
    airplane:['scene','城市交通'],bullpup:['other','武器配件'],recorder:['accessory','乐器'],egasumi:['outfit','纹样'],
    white_camisole:['outfit','上衣'],blue_scrunchie:['accessory','发饰'],black_hanfu:['outfit','中式'],
    'crane_(animal)':['animal','鸟类'],on_bench:['pose','摆位'],fever:['expression','表情'],strong_zero:['food','饮品'],
    '2026':['time_weather','时间'],spiked_pauldrons:['outfit','盔甲'],sidelighting:['atmosphere','光影氛围'],
    joystick:['accessory','手持道具'],black_streaks:['hair','颜色'],onmyouji:['character','角色类型']
  };
  for(const [id,[category,name]]of Object.entries(examples)){
    assert.equal(byId.get(id).categoryId,category,id);
    assert.equal(result.base.subcategories.find(s=>s.id===byId.get(id).subcategoryId).name,name,id);
  }
  assert.equal(byId.get('orgasm').adult,true);assert.equal(byId.get('pregnant').adult,false);
});

test('V1.4.331 users upgrade in one durable save while names, manual taxonomy, favorites and adult choices survive', async () => {
  const {emptyUserDocument,createMemoryRepository}=require('./fixtures/tag-library.cjs');
  const {createTagLibrary}=require('../src/modules/tag-library/library');
  const {loadBundledBase}=require('../src/modules/tag-library');
  const previous=oldCorpus(), loaded=loadBundledBase();assert.equal(loaded.ok,true);
  assert.notEqual(loaded.data.fingerprint,previous.fingerprint);
  const document=emptyUserDocument(previous), original=previous.tags.find(t=>t.id==='airplane');
  document.tagOverrides=[{tagId:'airplane',patch:{displayName:'我的飞机',subcategoryId:original.subcategoryId,note:'保留'},revision:2,updatedAt:42},{tagId:'orgasm',patch:{adult:false},revision:1,updatedAt:1}];
  document.memberships=[{id:'kept-favorite',tagId:'airplane',groupId:'daily',order:0,pinned:false}];
  document.selection=[{kind:'tag',tagId:'airplane'}];
  const repository=createMemoryRepository(document), library=createTagLibrary({base:loaded.data,baseUpdates:loaded.baseUpdates,repository});
  assert.equal((await library.ready()).ok,true);
  assert.equal(library.getTag('airplane').displayName,'我的飞机');assert.equal(library.getTag('airplane').categoryId,'wd_general');assert.equal(library.getTag('airplane').subcategoryId,original.subcategoryId);
  assert.equal(library.getTag('airship').categoryId,'scene');assert.equal(library.getTag('orgasm').adult,false);
  assert.equal(library.getMemberships('airplane')[0].id,'kept-favorite');assert.equal(library.selected({includeAdult:true})[0].tagIds[0],'airplane');
  assert.equal(repository.saveCount,1);
  const adapter=require('../src/modules/tags').createTags({library});assert.ok(adapter.categories().some(c=>c.id==='wd_general'),'manual placements remain reachable');adapter.dispose();
  const again=createTagLibrary({base:loaded.data,baseUpdates:loaded.baseUpdates,repository});assert.equal((await again.ready()).ok,true);assert.equal(repository.saveCount,1);
});

test('fresh users browse meaningful categories and adult-classified records follow the adult filter', async () => {
  const {loadBundledBase,createTagLibrary}=require('../src/modules/tag-library');
  const {createMemoryRepository}=require('./fixtures/tag-library.cjs');
  const loaded=loadBundledBase(), library=createTagLibrary({base:loaded.data,baseUpdates:loaded.baseUpdates,repository:createMemoryRepository(null)});
  assert.equal((await library.ready()).ok,true);
  const tags=require('../src/modules/tags').createTags({library});
  assert.equal(tags.categories().some(c=>c.id==='wd_general'),false);
  assert.equal(tags.search('orgasm',{precision:'exact'}).some(t=>t.id==='orgasm'),false);
  tags.setAdult(true);assert.equal(tags.search('orgasm',{precision:'exact'}).some(t=>t.id==='orgasm'),true);
  tags.dispose();
});
