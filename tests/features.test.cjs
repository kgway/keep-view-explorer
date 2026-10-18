const {compileSource}=require('./compile-source.cjs');
const {installModules}=require('./module-loader.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function runSource(code,context) {return vm.runInNewContext(compileSource(code),context);}
const source = fs.readFileSync(require('node:path').join(__dirname,'..','main.ts'),'utf8');
const sandbox={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{}}),Date,console};
runSource(source+"\nconst {moveSelectedNotes}=require('./lib/note-operations');\n"+'module.exports={parseIsoTimestamp,timestampFromFilename,migrateCreated,masonryPositions,makePathExport,resultFolderTree,markdownBody,previewLengths,createNote,localIsoTimestamp,editNoteTags,restoreTagChanges,moveSelectedNotes,moveSelection,trashSelectedNotes,DEFAULT_SETTINGS};',installModules(sandbox));
const {parseIsoTimestamp:parse,timestampFromFilename:fromName,migrateCreated,masonryPositions,makePathExport}=sandbox.module.exports;

test('result tree includes all pages, nested folders and root notes in sorted input order',()=>{
  const pages=Array.from({length:80},(_,i)=>({file:{path:`Work/Sub/${i}.md`,folder:'Work/Sub'}}));
  pages.push({file:{path:'root.md',folder:''}});
  const tree=sandbox.module.exports.resultFolderTree(pages);
  assert.equal(tree.count,81);assert.equal(tree.pages[0].file.path,'root.md');
  assert.equal(tree.children.get('Work').count,80);
  assert.equal(tree.children.get('Work').children.get('Sub').pages.length,80);
  assert.equal(tree.children.get('Work').children.get('Sub').pages[79].file.path,'Work/Sub/79.md');
});

test('bulk tag edits preserve unrelated properties and existing tags; failures are isolated',async()=>{
  const properties={a:{tags:['keep','remove'],created:'date'},b:{tags:'keep, old'},c:{tags:{invalid:true}}};
  const app={vault:{getAbstractFileByPath:path=>properties[path]?{path}:null},fileManager:{processFrontMatter:async(file,edit)=>edit(properties[file.path])}};
  const report=await sandbox.module.exports.editNoteTags(app,['a','b','c','gone'],['keep','new/sub'],['remove']);
  assert.equal(report.changed,2);assert.deepEqual(Array.from(report.errors),['c','gone']);
  assert.deepEqual(Array.from(properties.a.tags),['keep','new/sub']);assert.equal(properties.a.created,'date');
  assert.deepEqual(Array.from(properties.b.tags),['keep','old','new/sub']);
  assert.deepEqual(properties.c.tags,{invalid:true});
});
test('plugin registers the folded-note bulb for both ribbon and tab',async()=>{
  const icons=new Map();
  class Plugin {
    async loadData(){return null;}
    registerView(type,factory){this.viewFactory=factory;}
    addRibbonIcon(icon,label){this.ribbonIcon=icon;this.ribbonLabel=label;}
    addCommand(command){if(command.id==='open') this.openCommand=command.name;}
    addSettingTab(){}
  }
  const context={module:{exports:{}},require:()=>({Plugin,ItemView:class{},Modal:class{},PluginSettingTab:class{},addIcon:(id,svg)=>icons.set(id,svg)}),console};
  runSource(source,installModules(context));
  const plugin=new context.module.exports();await plugin.onload();
  assert.equal(plugin.ribbonLabel,'Keep View Explorer');
  assert.equal(plugin.openCommand,'Open Keep View Explorer');
  assert.equal(plugin.ribbonIcon,'keep-view-note-bulb');
  assert.equal(plugin.viewFactory({}).getIcon(),plugin.ribbonIcon);
  assert.ok(icons.get(plugin.ribbonIcon).includes('<path'));
  assert.ok(icons.has('keep-view-tree'));assert.equal(icons.has('keep-view-export'),false);
});

test('language defaults follow the app and saved choices follow later host changes',async()=>{
  for(const [appLanguage,preference,expected,previous] of [['ja','auto','ja'],['en','auto','en'],['de','auto','en'],['en','ja','ja'],['ja','en','en'],['ja','en','ja','en'],['en','ja','en','ja'],['en','ja','ja','en']]) {
    class Plugin {
      async loadData(){return {settings:{language:preference,obsidianLanguage:previous}};}
      registerView(){} addRibbonIcon(){} addCommand(){} addSettingTab(){}
    }
    const context={module:{exports:{}},require:()=>({Plugin,ItemView:class{},Modal:class{},PluginSettingTab:class{},addIcon(){},getLanguage:()=>appLanguage}),console};
    runSource(source,installModules(context));
    const plugin=new context.module.exports();await plugin.onload();
    assert.equal(context.require('./lib/i18n').getLocale(),expected);
  }
});

test('language changes persist across reloads and refresh open views only when the host changes',async()=>{
  let appLanguage='ja',data=null,saves=0,refreshes=0,tabRefreshes=0;
  class Plugin {
    constructor(){this.app={workspace:{getLeavesOfType:()=>[{view:Object.assign(Object.create(context.module.exports.ViewForTest.prototype),{controller:{setSearchIndex(){},refreshSettings(){refreshes++;}}})}]}};}
    async loadData(){return data;}
    async saveData(value){data=value;saves++;}
    registerView(){} addRibbonIcon(){} addCommand(){} addSettingTab(){}
  }
  const context={module:{exports:{}},require:()=>({Plugin,ItemView:class{},Modal:class{},PluginSettingTab:class{},addIcon(){},getLanguage:()=>appLanguage}),console};
  runSource(source,installModules(context));
  runSource('module.exports.ViewForTest=KeepView;',context);
  const locale=()=>context.require('./lib/i18n').getLocale();
  let plugin=new context.module.exports();await plugin.onload();await plugin.saveQueue;
  assert.equal(locale(),'ja');assert.equal(data.settings.obsidianLanguage,'ja');
  plugin.settings.language='en';plugin.saveSettings();await plugin.saveQueue;
  assert.equal(locale(),'en');
  plugin=new context.module.exports();await plugin.onload();await plugin.saveQueue;
  assert.equal(locale(),'en','Manual language survives a reload while the host is unchanged');
  const before=saves;plugin.syncAppLanguage();await plugin.saveQueue;
  assert.equal(saves,before,'Unchanged host language does not write settings');
  appLanguage='en';plugin.syncAppLanguage();await plugin.saveQueue;
  assert.equal(plugin.settings.language,'auto');assert.equal(locale(),'en');
  plugin.settings.language='ja';plugin.saveSettings();await plugin.saveQueue;
  plugin.settingsTab={containerEl:{isConnected:true},redisplay(){tabRefreshes++;}};
  const oldRefreshes=refreshes;
  appLanguage='de';plugin.syncAppLanguage();await plugin.saveQueue;
  assert.equal(locale(),'en');assert.equal(tabRefreshes,1);assert.equal(refreshes,oldRefreshes+1);
  assert.equal(data.settings.obsidianLanguage,'de');
  plugin.settings.language='en';plugin.saveSettings();await plugin.saveQueue;
  appLanguage='ja';plugin=new context.module.exports();await plugin.onload();await plugin.saveQueue;
  assert.equal(locale(),'ja','A host language change while closed also resets the language');
});

test('preview omits frontmatter and any leading blank lines without stripping Markdown',()=>{
  const {markdownBody}=sandbox.module.exports;
  assert.equal(markdownBody('\uFEFF\n\n---\ncreated: test\n---\n\n\n# Heading\n**Bold**'),'# Heading\n**Bold**');
  assert.equal(markdownBody('\n\n\r\nText'),'Text');
  assert.equal(markdownBody('\n \n    code'),'    code');
});
test('custom preview lengths are validated and normalized',()=>{
  const {previewLengths}=sandbox.module.exports;
  assert.deepEqual(Array.from(previewLengths('300, 75, 150, 75')),[75,150,300]);
  for(const bad of ['','abc','0,20','10.5','10001']) assert.equal(previewLengths(bad),null);
});

test('settings use blank defaults, two language choices, toggles and the requested order',()=>{
  const rows=[];
  class Setting {
    constructor(){this.buttons=[];rows.push(this);}
    setName(value){this.name=value;return this;}
    setDesc(value){this.desc=value;return this;}
    addText(callback){const handlers={};const text={inputEl:{addEventListener(name,fn){handlers[name]=fn;}},setValue(value){this.value=value;return this;},getValue(){return this.value;},change(value){this.value=value;handlers.change();}};callback(text);this.text=text;return this;}
    addDropdown(callback){const dropdown={options:[],addOption(value){this.options.push(value);return this;},setValue(value){this.value=value;return this;},onChange(fn){this.change=fn;return this;}};callback(dropdown);this.dropdown=dropdown;return this;}
    addToggle(callback){const toggle={setValue(value){this.value=value;return this;},onChange(fn){this.change=fn;return this;}};callback(toggle);this.toggle=toggle;return this;}
    addButton(callback){const button={setButtonText(value){this.text=value;return this;},onClick(fn){this.click=fn;return this;}};callback(button);this.buttons.push(button);return this;}
  }
  const context={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Notice:class{},Setting}),Date,console};
  runSource(source+'\nmodule.exports=KeepViewSettings;',installModules(context));
  const settings={dateProperty:'imported',previewLengths:[90],previewMode:'source',creationTimeZone:'UTC'};
  let saves=0;const tab=new context.module.exports({}, {settings,saveSettings(){saves++;},async setSearchCacheEnabled(value){settings.fastSearch=value;saves++;}});
  const definitions=tab.getSettingDefinitions();
  assert.equal(rows.length,0,'Indexing settings does not render controls');
  assert.equal(definitions.length,10);assert.equal(new Set(definitions.map(item=>item.name)).size,10);
  assert.ok(definitions.every(item=>typeof item.name==='string' && typeof item.render==='function'));
  tab.containerEl={empty(){rows.length=0;}};tab.display();
  const row=name=>rows.find(item=>item.name===name);
  assert.match(row('新規ノートの作成日時').desc,/保存先: imported/);
  assert.match(row('新規ノートの作成日時').desc,/[+-]\d{2}:\d{2}/);
  assert.deepEqual(Array.from(row('言語').dropdown.options),['en','ja']);
  assert.deepEqual(rows.map(item=>item.name),['言語','プレビュー文字数','プレビュー表示','ノート削除時に確認する','新規ノートの作成日時','日時プロパティ','作成日時の案内','検索キャッシュを端末に保存','検索キャッシュ','Google Keep から日時を取り込む']);
  for(const name of ['プレビュー文字数','新規ノートの作成日時','日時プロパティ']) assert.equal(row(name).buttons.length,0);
  row('プレビュー文字数').text.change(' ');
  assert.deepEqual(Array.from(settings.previewLengths),[50,100,150,200,400]);
  assert.equal(settings.dateProperty,'imported');assert.equal(settings.previewMode,'source');
  row('日時プロパティ').text.change('');
  assert.equal(settings.dateProperty,'created');
  assert.match(row('新規ノートの作成日時').desc,/保存先: created/);
  assert.equal(row('設定を初期値に戻す'),undefined);
  assert.equal(row('プレビュー表示').buttons.length,0);
  assert.equal(row('ノート削除時に確認する').toggle.value,true);
  row('ノート削除時に確認する').toggle.change(false);assert.equal(settings.confirmDelete,false);
  assert.equal(row('検索キャッシュを端末に保存').toggle.value,true);
  assert.match(row('検索キャッシュを端末に保存').desc,/暗号化はされません/);
  row('検索キャッシュを端末に保存').toggle.change(false);assert.equal(settings.fastSearch,false);
  row('新規ノートの作成日時').text.change('');
  assert.equal(settings.creationTimeZone,'');
  assert.equal(settings.previewMode,'source');assert.equal(tab.plugin.settings,settings);assert.equal(saves,5);
  tab.display();
  assert.equal(row('プレビュー文字数').text.value,'');assert.equal(row('プレビュー文字数').text.inputEl.placeholder,'50, 100, 150, 200, 400');
  assert.equal(row('日時プロパティ').text.value,'');assert.equal(row('日時プロパティ').text.inputEl.placeholder,'created');
  assert.equal(row('新規ノートの作成日時').text.value,'');
  row('プレビュー文字数').text.change('bad');assert.deepEqual(Array.from(settings.previewLengths),[50,100,150,200,400]);
  row('日時プロパティ').text.change('__proto__');assert.equal(settings.dateProperty,'created');
  assert.equal(saves,5,'Invalid input never replaces the effective defaults');
  row('プレビュー文字数').text.change('300, 75, 75');assert.deepEqual(Array.from(settings.previewLengths),[75,300]);
  row('日時プロパティ').text.change('imported');assert.equal(settings.dateProperty,'imported');
  row('新規ノートの作成日時').text.change('Asia/Tokyo');assert.equal(settings.creationTimeZone,'Asia/Tokyo');
  assert.equal(row('作成日時の案内').toggle.value,true);
  row('作成日時の案内').toggle.change(false);assert.equal(settings.showDateGuidance,false);
  row('作成日時の案内').toggle.change(true);assert.equal(settings.showDateGuidance,true);
});

test('settings refresh uses the declarative host API only on supported versions',()=>{
  let supported=false,updates=0,fallbacks=0;
  class PluginSettingTab {update(){updates++;}}
  const context={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},Modal:class{},PluginSettingTab,requireApiVersion:()=>supported}),console};
  runSource(source+'\nmodule.exports=KeepViewSettings;',installModules(context));
  const tab=new context.module.exports({},{});tab.renderLegacySettings=()=>fallbacks++;
  tab.display();assert.equal(fallbacks,1,'Older hosts still invoke the legacy renderer');fallbacks=0;
  tab.redisplay();assert.equal(fallbacks,1);assert.equal(updates,0);
  supported=true;tab.redisplay();assert.equal(fallbacks,1);assert.equal(updates,1);
});

test('standalone migration helpers handle write errors without plugin module globals',async()=>{
  const helpers=source.split('// BEGIN MIGRATION HELPERS')[1].split('\n').slice(1).join('\n').split('// END MIGRATION HELPERS')[0];
  const context={module:{exports:{}},msg:key=>key};
  runSource(helpers+'\nmodule.exports=migrateCreated;',context);
  const file={path:'Notes/2026-01-01T12_00_00Z.md',basename:'2026-01-01T12_00_00Z'};
  const app={vault:{getMarkdownFiles:()=>[file]},metadataCache:{getFileCache:()=>({})},fileManager:{processFrontMatter:async()=>{throw Error('write failed');}}};
  const result=await context.module.exports(app,{apply:true});
  assert.equal(result.rows[0].status,'error');assert.match(result.rows[0].error,/write failed/);
});
test('new note respects selected folder, avoids overwrites and writes creation property',async()=>{
  const {createNote}=sandbox.module.exports;
  const folder={path:'Notes',children:[]};let created;
  const app={vault:{getAbstractFileByPath:path=>path==='Notes'?folder:path==='Notes/無題.md'?{}:null,create:async(path,content)=>{created={path,content};return created;}},fileManager:{getNewFileParent:()=>folder}};
  const file=await createNote(app,'imported','Notes','Asia/Tokyo');
  assert.match(file.content,/\+09:00"/);
  assert.equal(file.path,'Notes/無題 1.md');assert.match(file.content,/^---\n"imported": "\d{4}-/);
  assert.equal(sandbox.module.exports.markdownBody(file.content),'');
  assert.ok(file.content.endsWith('---\n'),'No extra body newline after frontmatter');
});

test('new creation timestamps express the local offset without changing the instant',()=>{
  for(const [minutes,suffix] of [[-540,'+09:00'],[-330,'+05:30'],[210,'-03:30'],[0,'+00:00']]) {
    const date=new Date('2026-09-21T00:12:34.567Z');date.getTimezoneOffset=()=>minutes;
    const value=sandbox.module.exports.localIsoTimestamp(date);
    assert.ok(value.endsWith(suffix));assert.equal(Date.parse(value),date.getTime());
  }
});

test('configured creation timezone handles fractional offsets and daylight saving',()=>{
  const format=sandbox.module.exports.localIsoTimestamp;
  assert.equal(format(new Date('2026-09-21T00:00:00.123Z'),'Asia/Tokyo'),'2026-09-21T09:00:00.123+09:00');
  assert.equal(format(new Date('2026-09-21T00:00:00Z'),'Asia/Kathmandu'),'2026-09-21T05:45:00.000+05:45');
  assert.ok(format(new Date('2026-01-21T00:00:00Z'),'America/New_York').endsWith('-05:00'));
  assert.ok(format(new Date('2026-07-21T00:00:00Z'),'America/New_York').endsWith('-04:00'));
  assert.equal(format(new Date('2026-09-21T00:00:00Z'),'UTC'),'2026-09-21T00:00:00.000+00:00');
});

test('Keep filenames retain fractional seconds and original UTC offset',()=>{
  assert.equal(fromName('2026-02-09T15_46_51.388+09_00'),'2026-02-09T15:46:51.388+09:00');
  assert.equal(fromName('2026-02-09T15_46_51-05_30'),'2026-02-09T15:46:51-05:30');
  assert.equal(fromName('2026-02-09T15_46_51Z'),'2026-02-09T15:46:51Z');
  assert.equal(fromName('2026-02-09T15:46:51+09:00'),'2026-02-09T15:46:51+09:00');
  for(const invalid of ['2026-02-09T15_46_51','2026-02-30T15_46_51Z','2026-02-09T24_00_00Z','note-2026-02-09T15_46_51Z','2026-02-09T15_46_51Z extra']) assert.equal(fromName(invalid),null,invalid);
});
test('ISO dates validate calendar and offset, rejecting ambiguous values',()=>{
  assert.equal(parse('2026-02-09T15:46:51.388+09:00'),Date.parse('2026-02-09T06:46:51.388Z'));
  assert.equal(parse('2024-02-29T00:00:00Z'),Date.parse('2024-02-29T00:00:00Z'));
  assert.equal(parse('1970-01-01T00:00:00Z'),0);
  assert.equal(parse('2026-02-09'),new Date('2026-02-09T00:00:00').getTime());
  assert.equal(parse('2026-02-09T15:46'),new Date('2026-02-09T15:46').getTime());
  for(const invalid of [null,'','02/09/2026',123456,{},'2025-02-29','2026-01-01T12:60Z','2026-01-01T12:00+24:00']) assert.equal(parse(invalid),null);
});

function migrationFixture() {
  const names=['2026-02-09T15_46_51.388+09_00','2025-01-01T00_00_00Z','normal','2024-02-29T12_00_00Z'];
  const files=names.map((basename,i)=>({basename,path:`Keep/${basename}.md`,i}));
  files.push({basename:names[0],path:`KeepOther/${names[0]}.md`,i:4});
  const properties=[{tags:['仕事']},{created:''},{},{},{}];
  let writes=0;
  const app={vault:{getMarkdownFiles:()=>files},metadataCache:{getFileCache:f=>({frontmatter:properties[f.i]})},fileManager:{processFrontMatter:async(f,change)=>{writes++;change(properties[f.i]);}}};
  return {app,files,properties,get writes(){return writes;}};
}
test('migration preview writes nothing, scopes folder, preserves existing empty values',async()=>{
  const fixture=migrationFixture();
  const report=await migrateCreated(fixture.app,{folder:'Keep'});
  assert.equal(fixture.writes,0);assert.equal(report.rows.length,4);
  assert.equal(report.rows.filter(r=>r.status==='ready').length,2);
  assert.equal(report.rows.filter(r=>r.status==='existing').length,1);
  assert.equal(report.rows.filter(r=>r.status==='unrecognized').length,1);
});
test('migration applies only preview paths, is idempotent and preserves unrelated properties',async()=>{
  const fixture=migrationFixture();
  const preview=await migrateCreated(fixture.app,{folder:'Keep'});
  const options={folder:'Keep',paths:preview.rows.filter(r=>r.status==='ready').map(r=>r.path),apply:true};
  const report=await migrateCreated(fixture.app,options);
  assert.equal(report.rows.filter(r=>r.status==='written').length,2);
  assert.equal(fixture.properties[0].created,'2026-02-09T15:46:51.388+09:00');
  assert.deepEqual(fixture.properties[0].tags,['仕事']);
  assert.equal(fixture.properties[4].created,undefined);
  await migrateCreated(fixture.app,options);assert.equal(fixture.writes,2);
});
test('migration checks live frontmatter and records per-file failures',async()=>{
  const fixture=migrationFixture();
  fixture.app.fileManager.processFrontMatter=async(file,change)=>{
    if(file.i===0) {fixture.properties[0].imported='user value';change(fixture.properties[0]);}
    else throw Error('read only');
  };
  const report=await migrateCreated(fixture.app,{property:'imported',folder:'Keep',apply:true});
  assert.equal(fixture.properties[0].imported,'user value');
  assert.equal(report.rows.find(r=>r.path===fixture.files[0].path).status,'existing');
  assert.equal(report.rows.filter(r=>r.status==='error').length,2);
});
test('migration rejects invalid configuration and honours cancellation',async()=>{
  const fixture=migrationFixture();
  for (const property of ['','__proto__','a\nb']) await assert.rejects(migrateCreated(fixture.app,{property}));
  await assert.rejects(migrateCreated(fixture.app,{folder:'Keep/../Private'}));
  const report=await migrateCreated(fixture.app,{apply:true,cancelled:()=>true});
  assert.equal(report.cancelled,true);assert.equal(fixture.writes,0);
});
test('masonry puts each next card at the highest available position',()=>{
  const result=masonryPositions([300,80,150,100,220,90],3,12);
  assert.deepEqual(JSON.parse(JSON.stringify(result.positions)),[
    {column:0,top:0},{column:1,top:0},{column:2,top:0},{column:1,top:92},{column:2,top:162},{column:1,top:204},
  ]);
  assert.equal(result.height,382);
  assert.equal(masonryPositions([],1,12).height,0);
});
test('JSON export keeps every path verbatim, in query order, without pagination',()=>{
  const paths=Array.from({length:81},(_,i)=>`Keep/日本語 ${i} # [a].md`);
  const app={vault:{getName:()=> 'My Vault',adapter:{getBasePath:()=> 'C:/Vault'}}};
  const output=makePathExport(app,paths.map(path=>({file:{path}})),{formula:'#仕事',sortOrder:'desc'},'imported');
  assert.equal(output.count,81);assert.equal(Object.hasOwn(output,'vaultRoot'),false);assert.equal(output.filters.dateProperty,'imported');
  assert.deepEqual(JSON.parse(JSON.stringify(output)).paths,paths);
});

test('tag history restores exact original properties, supports redo, and protects external edits',async()=>{
  const properties={a:{tags:'old, common',created:'keep'},b:{created:'keep'},c:{tags:['common']}};
  const app={vault:{getAbstractFileByPath:path=>properties[path]?{path}:null},fileManager:{processFrontMatter:async(file,edit)=>edit(properties[file.path])}};
  const report=await sandbox.module.exports.editNoteTags(app,['a','b','c'],['new'],['common']);
  properties.c.tags=['external'];
  const undo=await sandbox.module.exports.restoreTagChanges(app,report.changes);
  assert.deepEqual(Array.from(undo.errors),['c']);assert.equal(undo.inverse.length,2);
  assert.equal(properties.a.tags,'old, common');assert.equal(Object.hasOwn(properties.b,'tags'),false);
  assert.deepEqual(properties.c.tags,['external']);assert.equal(properties.a.created,'keep');
  const redo=await sandbox.module.exports.restoreTagChanges(app,undo.inverse);
  assert.equal(redo.errors.length,0);assert.deepEqual(Array.from(properties.a.tags),['old','new']);
  assert.deepEqual(Array.from(properties.b.tags),['new']);
});

test('moving selected notes skips same-folder notes and numbers collisions without overwriting',async()=>{
  const items=new Map([['/',{children:[]}],['Dest',{children:[]}],...['a.md','X/b.md','Y/b.md','Dest/c.md','X/c.md','X/d.md','X/fail.md'].map(path=>[path,{path}])]);
  const app={vault:{getAbstractFileByPath:path=>items.get(path)},fileManager:{renameFile:async(file,target)=>{if(file.path.endsWith('fail.md')) throw Error('failed');items.delete(file.path);file.path=target;items.set(target,file);}}};
  const report=await sandbox.module.exports.moveSelectedNotes(app,['a.md','X/b.md','Y/b.md','Dest/c.md','X/c.md','X/d.md','X/fail.md'],'Dest');
  assert.equal(report.moved.length,5);assert.equal(report.skipped.length,1);assert.equal(report.errors.length,1);
  assert.ok(items.has('Dest/a.md')&&items.has('Dest/d.md')&&items.has('Dest/b.md')&&items.has('Dest/b 1.md')&&items.has('Dest/c 1.md'));
  assert.equal(items.get('Dest/c.md').path,'Dest/c.md');
  await assert.rejects(()=>sandbox.module.exports.moveSelectedNotes(app,['Dest/a.md'],'Missing'));
  const root=await sandbox.module.exports.moveSelectedNotes(app,['Dest/a.md'],'');assert.equal(root.moved[0].to,'a.md');
});

test('moves recover destination races and recognize completed renames after hook errors',async()=>{
  const a={path:'a.md'},b={path:'b.md'};
  const items=new Map([['Dest',{children:[]}],['a.md',a],['b.md',b]]);
  const app={vault:{getAbstractFileByPath:path=>items.get(path)},fileManager:{renameFile:async(file,target)=>{
    if(target==='Dest/a.md') {items.set(target,{path:target});throw Error('collision');}
    items.delete(file.path);file.path=target;items.set(target,file);
    if(file===b) throw Error('link hook failed after rename');
  }}};
  const result=await sandbox.module.exports.moveSelectedNotes(app,['a.md','b.md'],'Dest');
  assert.equal(result.errors.length,0);assert.equal(result.moved.length,2);
  assert.equal(items.get('Dest/a 1.md'),a);assert.equal(items.get('Dest/b.md'),b);
  assert.notEqual(items.get('Dest/a.md'),a);
});

test('folder moves preserve nested folders, attachments and empty folders with one rename',async()=>{
  const note={path:'A/sub/n.md'},image={path:'A/image.png'},empty={path:'A/empty',children:[]};
  const sub={path:'A/sub',children:[note]},folder={path:'A',children:[sub,image,empty]},loose={path:'loose.md'};
  const items=new Map([folder,sub,note,image,empty,loose,{path:'Dest',children:[]}].map(item=>[item.path,item]));
  const calls=[];
  const app={vault:{getAbstractFileByPath:path=>items.get(path)},fileManager:{renameFile:async(file,target)=>{
    const old=file.path;calls.push([old,target]);
    for(const [path,item] of [...items]) if(path===old || path.startsWith(old+'/')) {items.delete(path);item.path=target+path.slice(old.length);items.set(item.path,item);}
  }}};
  const result=await sandbox.module.exports.moveSelection(app,['A/sub/n.md','loose.md'],['A','A/sub'],'Dest');
  assert.equal(result.errors.length,0);assert.deepEqual(calls,[['A','Dest/A'],['loose.md','Dest/loose.md']]);
  assert.equal(items.get('Dest/A/sub/n.md'),note);assert.equal(items.get('Dest/A/image.png'),image);assert.equal(items.get('Dest/A/empty'),empty);
  assert.ok(result.moved.some(entry=>entry.from==='A/sub/n.md' && entry.to==='Dest/A/sub/n.md'));
});

test('invalid or conflicting folder moves never flatten descendants or overwrite folders',async()=>{
  for(const destination of ['A','A/sub','Dest']) {
    const note={path:'A/n.md'},folder={path:'A',children:[note]};
    const items=new Map([folder,note,{path:'A/sub',children:[]},{path:'Dest',children:[]},{path:'Dest/A',children:[]}].map(item=>[item.path,item]));
    let calls=0;
    const app={vault:{getAbstractFileByPath:path=>items.get(path)},fileManager:{renameFile:async()=>{calls++;}}};
    const result=await sandbox.module.exports.moveSelection(app,['A/n.md'],['A'],destination);
    assert.equal(calls,0);assert.deepEqual(Array.from(result.errors),['A']);assert.equal(items.get('A/n.md'),note);
  }
});

test('failed folder rename does not retry contained notes individually',async()=>{
  const note={path:'A/n.md'},folder={path:'A',children:[note]},dest={path:'Dest',children:[]};
  const calls=[],items=new Map([note,folder,dest].map(item=>[item.path,item]));
  const app={vault:{getAbstractFileByPath:path=>items.get(path)},fileManager:{renameFile:async(file)=>{calls.push(file.path);throw Error('locked');}}};
  const result=await sandbox.module.exports.moveSelection(app,['A/n.md'],['A'],'Dest');
  assert.deepEqual(calls,['A']);assert.deepEqual(Array.from(result.errors),['A']);
});

test('deletion defaults to confirmation and only trashes the exact reviewed Markdown files',async()=>{
  assert.equal(sandbox.module.exports.DEFAULT_SETTINGS.confirmDelete,true);
  const a={path:'a.md'},b={path:'b.md'},c={path:'c.md'},folder={path:'folder.md',children:[]};
  const files=new Map([['a.md',a],['b.md',{path:'b.md'}],['c.md',c],['folder.md',folder]]),trashed=[];
  const app={vault:{getAbstractFileByPath:path=>files.get(path)},fileManager:{trashFile:async file=>{if(file===c) throw Error('permission');trashed.push({file});files.delete(file.path);}}};
  const report=await sandbox.module.exports.trashSelectedNotes(app,[{path:'a.md',file:a},{path:'b.md',file:b},{path:'c.md',file:c},{path:'folder.md',file:folder},{path:'missing.md',file:null}]);
  assert.deepEqual(Array.from(report.deleted),['a.md']);assert.equal(report.errors.length,4);
  assert.equal(trashed.length,1);assert.equal(trashed[0].file,a);assert.ok(files.has('b.md')&&files.has('folder.md'));
});

test('fast search can be disabled without loading storage, and cache deletion pauses every open view',async()=>{
  const context={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{}}),Date,console,CompressionStream,DecompressionStream,indexedDB:{}};
  runSource(source,installModules(context));
  const plugin=new context.module.exports();plugin.settings={fastSearch:false};plugin.manifest={dir:'plugins/keep-view'};
  runSource('module.exports.ViewForTest=KeepView;',context);
  const changes=[],events=[],disk=new Map();
  const controllers=[0,1].map(id=>({setSearchIndex(index,options){changes.push({id,index,options});}}));
  plugin.app={loadLocalStorage:()=>null,vault:{on:(event,callback)=>{events.push(event);return callback;},adapter:{exists:async path=>disk.has(path)||[...disk.keys()].some(key=>key.startsWith(path+'/')),list:async path=>({files:[...disk.keys()].filter(key=>key.startsWith(path+'/')),folders:[]}),remove:async path=>disk.delete(path)}},workspace:{getLeavesOfType:()=>controllers.map(controller=>({view:Object.assign(Object.create(context.module.exports.ViewForTest.prototype),{controller})}))}};
  plugin.registerEvent=()=>{};
  assert.equal(plugin.getSearchIndex(),null);assert.equal(plugin.searchIndex,null);assert.equal(events.length,0);
  plugin.settings.fastSearch=true;const index=plugin.getSearchIndex();assert.ok(index);assert.equal(events.length,4);
  disk.set('plugins/keep-view/search-cache-v1/2.gz',new Uint8Array());disk.set('plugins/keep-view/data.json','keep');
  await plugin.clearSearchCache();
  assert.equal(disk.has('plugins/keep-view/search-cache-v1/2.gz'),false);assert.equal(disk.get('plugins/keep-view/data.json'),'keep');
  assert.equal(changes.length,4);assert.ok(changes.slice(0,2).every(change=>change.index===null && change.options.pause));
  assert.ok(changes.slice(2).every(change=>change.index===index));
  plugin.settings.fastSearch=false;assert.equal(plugin.getSearchIndex(),null);assert.equal(events.length,4);
});

test('turning persistence off saves the choice and waits for deletion; enabling it does not build a cache',async()=>{
  const notices=[];
  const context={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Notice:class{constructor(text){notices.push(text);}}}),Date,console};
  runSource(source,installModules(context));
  const plugin=new context.module.exports();plugin.settings={fastSearch:true};
  let saves=0,clears=0,finish;
  plugin.saveSettings=()=>saves++;
  plugin.clearSearchCache=()=>{clears++;return new Promise(resolve=>finish=resolve);};
  const disabling=plugin.setSearchCacheEnabled(false);
  assert.equal(plugin.settings.fastSearch,false);assert.equal(saves,1);assert.equal(clears,1);assert.equal(notices.length,0);
  finish();await disabling;assert.equal(notices.length,1);
  await plugin.setSearchCacheEnabled(true);assert.equal(plugin.settings.fastSearch,true);assert.equal(clears,1);
  plugin.clearSearchCache=async()=>{throw Error('blocked');};
  await plugin.setSearchCacheEnabled(false);assert.equal(plugin.settings.fastSearch,false);
  assert.match(notices.at(-1),/できません/);
});
