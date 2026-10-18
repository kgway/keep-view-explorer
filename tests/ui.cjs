const {compileSource}=require('./compile-source.cjs');
// Optional browser smoke test: set PLAYWRIGHT_MODULE to a Playwright installation.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function resize(page,size) {
  await page.setViewportSize(size);
  if(process.env.KEEP_VIEW_HOST_CSS) await page.evaluate(width=>document.body.classList.toggle('is-mobile',width<=500),size.width);
}
const screenshots=path.join(root,'.artifacts','ui');fs.mkdirSync(screenshots,{recursive:true});
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    await require('./date-input-browser.cjs').testDateInputs(browser);
    await require('./search-storage-browser.cjs').testSearchStorage(browser);
    const page = await browser.newPage({viewport:{width:1200,height:850},hasTouch:true});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html><body class="workspace-leaf"><div class="workspace-leaf-content" data-type="keep-view"><div id="view" class="view-content keep-view-content" style="height:810px"></div></div></body></html>');
    if(process.env.KEEP_VIEW_HOST_CSS) {
      await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_HOST_CSS,'utf8')});
      if(process.env.KEEP_VIEW_THEME_CSS) await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_THEME_CSS,'utf8')});
      await page.evaluate(()=>document.body.classList.add('theme-light'));
    }
    const dependencies=process.env.PLAYWRIGHT_MODULE?path.dirname(process.env.PLAYWRIGHT_MODULE):path.resolve('node_modules');
    await page.addScriptTag({path:path.join(dependencies,'marked/lib/marked.umd.js')});
    await page.addScriptTag({path:path.join(dependencies,'lucide/dist/umd/lucide.js')});
    await page.addStyleTag({content:':root{--background-primary:#fff;--background-secondary:#f7f7f8;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#222;--text-muted:#666;--text-faint:#888;--interactive-accent:#6958c7;--font-interface: sans-serif;--font-monospace:monospace} body{margin:12px;width:auto;font-family:sans-serif}button,input,select{font:inherit}'});
    // App styles size the workspace to the viewport; the standalone fixture's
    // outer margin must not be added to that width.
    if(process.env.KEEP_VIEW_HOST_CSS) await page.evaluate(()=>document.body.style.margin='0');
    // ItemView.contentEl also carries .view-content inside the host leaf. Keep
    // this default padding in the fixture even when app CSS is not supplied.
    await page.addStyleTag({content:'.workspace-leaf-content .view-content { padding:12px 12px 32px; overflow:auto; }'});
    await page.addStyleTag({content:'button:not(:hover){background-color:rgb(250,200,220);background-image:linear-gradient(red,blue)}'});
    const pluginStyle=await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_PLUGIN_CSS||path.join(root,'styles.css'),'utf8')});
    // Reproduce the old Dataview snippet loading after the plugin stylesheet.
    await page.addStyleTag({content:`.kv-header { margin-bottom:14px; border-bottom:1px solid #ddd; }
      .workspace-leaf:has(.kv-body-wrapper) .markdown-rendered { width:100% !important; max-width:100% !important; padding-left:0 !important; padding-right:0 !important; }
      .markdown-rendered td,.markdown-rendered th { font-size:var(--table-text-size,20px); }`});
    if(process.env.KEEP_VIEW_LEGACY_CSS) await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_LEGACY_CSS,'utf8')});
    // Reloaded host/theme styles must not restore ItemView's outer padding.
    await page.addStyleTag({content:'.workspace-leaf-content .view-content { padding:12px 12px 32px; }'});
    assert.deepEqual(await page.locator('#view').evaluate(el=>{
      const style=getComputedStyle(el);return [style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft];
    }),['0px','0px','0px','0px'],'Keep View replaces default ItemView padding; its header and cards own their spacing');
    assert.deepEqual(await page.evaluate(()=>{
      const leaf=document.createElement('div');leaf.className='workspace-leaf-content';leaf.dataset.type='unrelated-view';
      const content=document.createElement('div');content.className='view-content';leaf.append(content);document.body.append(leaf);
      const style=getComputedStyle(content),padding=[style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft];leaf.remove();return padding;
    }),['12px','12px','32px','12px'],'Other ItemViews retain their default padding');

    await page.evaluate(() => {
      Element.prototype.createEl = function(tag, options={}) {
        const el = document.createElement(tag);
        if (options.cls) el.className=options.cls;
        if (options.text !== undefined) el.textContent=options.text;
        for (const key of ['type','placeholder','title','value','style']) if (options[key] !== undefined) el.setAttribute(key,options[key]);
        this.appendChild(el); return el;
      };
      window.createEl=tag=>document.createElement(tag);
      Element.prototype.createDiv = function(options) {return this.createEl('div',options);};
      Element.prototype.createSpan = function(options) {return this.createEl('span',options);};
      Element.prototype.empty = function() {this.replaceChildren();};
      Element.prototype.addClass = function(cls) {this.classList.add(cls);};
      window.module={exports:{}};window.exports=window.module.exports;
      class MockModal {
        constructor(app) {this.app=app; this.contentEl=document.createElement('div');}
        open() {document.body.appendChild(this.contentEl);this.onOpen();window.lastOpenedModal=this;}
        close() {this.onClose();this.contentEl.remove();}
      }
      const customIcons=new Map();window.liveComponents=0;window.renderedSources=[];
      window.require = () => ({Plugin:class{},ItemView:class{},Modal:MockModal,PluginSettingTab:class{},Notice:class{},
        Component:class{load(){this.active=true;liveComponents++;}unload(){if(this.active){liveComponents--;this.active=false;}}},
        MarkdownRenderer:{render:async(app,text,el,source,component)=>{renderedSources.push(source);el.innerHTML=marked.parse(text);}},
        addIcon:(name,svg)=>customIcons.set(name,svg),
        setIcon:(el,name)=>{
          let svg;
          if(customIcons.has(name)){svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 100 100');svg.innerHTML=customIcons.get(name);}
          else {const key=name.replace(/(^|-)(\w)/g,(_,prefix,letter)=>letter.toUpperCase());svg=lucide.createElement(lucide.icons[key]);}
          svg.dataset.icon=name;el.appendChild(svg);
        },getAllTags:cache=>cache.tags});
      window.opened=[]; window.saved={};window.activeNotePath=null;window.revealed=[];
      window.exportsWritten=[];
      window.readCount=0;window.fixtureTime=Date.now();
      window.files=Array.from({length:42},(_,i)=>({path:`${i%2?'仕事/':''}メモ${i}.md`,basename:`メモ${i}`,parent:{path:i%2?'仕事':'/'},stat:{mtime:Date.now()-i*60000,ctime:Date.now()-i*86400000},i}));
      window.app={vault:{adapter:{getBasePath:()=> 'C:\\Test Vault'},getName:()=> 'Test Vault',getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(f=>f.path===path),cachedRead:async file=>{window.readCount++;return `# ${file.basename}\n`+'プラグイン化したカードの本文プレビューです。\n'.repeat(file.i%7+1); }},metadataCache:{getFileCache:file=>({tags:file.i%3?['#仕事/重要']:[],frontmatter:{created:new Date(fixtureTime-file.i*86400000).toISOString()}}),getFirstLinkpathDest:()=>null},workspace:{
        // Model a host whose default is to open tabs in the background.
        getLeaf:type=>({type,openFile:async function(file,state){await new Promise(resolve=>setTimeout(resolve,15));this.file=file;this.openState=state;opened.push(file.path);if(state?.active) activeNotePath=file.path;}}),
        revealLeaf:async leaf=>{if(!leaf.file) throw new Error('Leaf revealed before opening completed');revealed.push({path:leaf.file.path,type:leaf.type,active:leaf.openState?.active});activeNotePath=leaf.file.path;}
      }};
      app.fileManager={getNewFileParent:()=>({path:'/',children:[]})};
      app.vault.create=async(path,content)=>{exportsWritten.push({path,content});return {path};};
    });
    const modules=Object.fromEntries(fs.readdirSync(path.join(root,'lib')).filter(name=>/\.(ts|json)$/.test(name)).map(name=>['./lib/'+(name.endsWith('.json')?name:name.slice(0,-3)),name.endsWith('.json')?'module.exports='+fs.readFileSync(path.join(root,'lib',name),'utf8'):compileSource(fs.readFileSync(path.join(root,'lib',name),'utf8'))]));
    await page.evaluate(sources=>{
      const originalRequire=window.require,cache=new Map();
      window.require=id=>{id=id.replace(/\.js$/,'');
        if(id.startsWith('./') && !id.startsWith('./lib/')) id='./lib/'+id.slice(2);
        if(!Object.hasOwn(sources,id)) return originalRequire(id);
        if(!cache.has(id)) {const module={exports:{}};cache.set(id,module);new Function('require','module','exports',sources[id])(window.require,module,module.exports);}
        return cache.get(id).exports;
      };
    },modules);
    await page.evaluate(()=>require('./lib/i18n').setLanguage('ja'));
    await page.addScriptTag({content:compileSource(fs.readFileSync(path.join(root,'main.ts'),'utf8'))+'\naddIcon(TREE_ICON,TREE_ICON_SVG);window.currentSettings={...DEFAULT_SETTINGS,showDateGuidance:false};'});
    assert.deepEqual(errors,[],'Compiled plugin source loads before mounting');
    // A new ItemView can open before Obsidian attaches its content to the workspace.
    await page.evaluate(()=>{
      window.initialRoot=document.createElement('div');
      window.controller=mountKeepView(app,initialRoot,{},s=>window.saved=s,currentSettings);
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>initialRoot.querySelectorAll('.kv-card').length),0);
    await page.evaluate(()=>document.getElementById('view').appendChild(initialRoot));
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===30 && !document.body.textContent.includes('読み込み中...'),null,{timeout:4000});
    assert.equal(await page.evaluate(()=>window.readCount),30);
    if(process.env.KEEP_VIEW_COMPARE_CSS) {
      const records=[];
      const measure=()=>page.locator('.kv-header,.kv-body-wrapper,.kv-toolbar button,.kv-toolbar select').evaluateAll(elements=>elements.map(element=>{
        const bounds=element.getBoundingClientRect();
        return {label:element.getAttribute('aria-label')||element.className,box:[bounds.x,bounds.y,bounds.width,bounds.height].map(value=>Math.round(value*100)/100)};
      }));
      for(const width of [320,360,390,420,421,480,740,741,1000,1200]) {
        await resize(page,{width,height:850});await page.waitForTimeout(100);
        const after=await measure();
        await pluginStyle.evaluate(element=>{element.sheet.disabled=true;});
        const baseline=await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_COMPARE_CSS,'utf8')});
        await page.waitForTimeout(100);const before=await measure();
        await baseline.evaluate(element=>element.remove());
        await pluginStyle.evaluate(element=>{element.sheet.disabled=false;});
        assert.equal(after.length,before.length);
        for(let index=0;index<after.length;index++) {
          assert.equal(after[index].label,before[index].label);
          for(let dimension=0;dimension<4;dimension++) assert.ok(Math.abs(after[index].box[dimension]-before[index].box[dimension])<=0.25,
            'Published toolbar geometry changed at '+width+': '+JSON.stringify({before:before[index],after:after[index]}));
        }
        records.push({width,controls:after.length,geometryUnchanged:true});
      }
      fs.writeFileSync(process.env.KEEP_VIEW_COMPARE_REPORT||path.join(screenshots,'toolbar-comparison.json'),JSON.stringify(records,null,2)+'\n');
    }
    for(const [width,state,hidden] of [
      [360,{groupByFolder:true,resultTreeOpen:{'仕事':true}},false],
      [1200,{sortField:'name',folderFilters:['仕事']},true]
    ]) {
      await resize(page,{width,height:850});
      await page.evaluate(({state,hidden})=>{
        controller.dispose();
        const host=document.getElementById('view');host.empty();host.style.display=hidden?'none':'';
        window.initialRoot=document.createElement('div');
        window.controller=mountKeepView(app,initialRoot,state,s=>window.saved=s,currentSettings);
      },{state,hidden});
      await page.waitForTimeout(200);
      await page.evaluate(()=>document.getElementById('view').appendChild(initialRoot));
      if(hidden) {
        await page.waitForTimeout(200);
        await page.evaluate(()=>document.getElementById('view').style.display='');
      }
      await page.waitForFunction(()=>document.querySelector('.kv-masonry:not(.kv-layout-pending) .kv-card'),null,{timeout:4000});
      assert.ok(await page.locator('.kv-card').first().isVisible(),'Deferred opening paints without changing any controls');
      assert.equal(await page.evaluate(()=>saved.sortField),state.sortField||'mtime');
      assert.deepEqual(await page.evaluate(()=>saved.folderFilters),state.folderFilters||[]);
    }
    await page.evaluate(()=>{
      controller.dispose();document.getElementById('view').empty();
      window.initialRoot=document.createElement('div');
      window.controller=mountKeepView(app,initialRoot,{},()=>{},currentSettings);
      controller.dispose();document.getElementById('view').appendChild(initialRoot);
    });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.kv-card,.kv-header').count(),0,'Closing before attachment cancels the deferred paint');
    await page.evaluate(()=>{
      document.getElementById('view').empty();
      window.controller=mountKeepView(app,document.getElementById('view').createDiv(),{},s=>window.saved=s,currentSettings);
    });
    await page.waitForFunction(()=>document.querySelector('.kv-card-preview h1'));
    assert.equal(await page.locator('.keep-view-root').first().evaluate(el=>el.getBoundingClientRect().width),await page.locator('#view').evaluate(el=>el.clientWidth),'The plugin root uses the full content width');
    assert.equal(await page.getByRole('button',{name:'更新日時',exact:true}).getAttribute('aria-pressed'),'true','A fresh view starts with modification time');
    assert.equal(await page.evaluate(()=>saved.dateField),'mtime');
    assert.equal(await page.getByRole('button',{name:'作成日時',exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.kv-header')).position),'static');
    assert.equal(await page.getByRole('combobox',{name:'プレビュー文字数',exact:true}).inputValue(),'150');
    assert.ok(await page.locator('.kv-card-preview h1').count()>0);
    assert.deepEqual(await page.locator('.kv-segment').allTextContents(),['作成日時','更新日時','タイトル']);
    await page.getByRole('button',{name:'更新日時',exact:true}).click();
    assert.equal(await page.evaluate(()=>saved.sortField),'mtime');
    assert.equal(await page.evaluate(()=>saved.dateField),'mtime');
    await page.evaluate(()=>{controller.dispose();document.getElementById('view').empty();window.controller=mountKeepView(app,document.getElementById('view').createDiv(),saved,s=>window.saved=s,currentSettings);});
    assert.equal(await page.getByRole('button',{name:'更新日時',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'作成日時',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-card-preview h1'));
    const toolbarRows=await page.locator('.kv-toolbar > .kv-header-row').evaluateAll(rows=>rows.map(row=>{const rect=row.getBoundingClientRect();return Math.round(rect.top+rect.height/2);}));
    assert.ok(Math.max(...toolbarRows)-Math.min(...toolbarRows)<=2,'Desktop toolbar fits one row');
    for(const [width,rows] of [[1120,1],[1024,2],[900,2],[760,3],[700,3],[560,3],[500,3],[440,4]]) {
      await resize(page,{width,height:850});
      await page.waitForTimeout(120);
      const layout=await page.evaluate(()=>{
        const top=selector=>Math.round(document.querySelector(selector).getBoundingClientRect().top);
        return {primary:top('.kv-primary-tools button'),sort:top('.kv-sort-tools'),date:top('.kv-date-range'),tag:top('.kv-no-tag'),overflow:document.getElementById('view').scrollWidth>document.getElementById('view').clientWidth,rightGap:document.querySelector('.kv-toolbar').getBoundingClientRect().right-document.querySelector('.kv-no-tag').getBoundingClientRect().right};
      });
      assert.equal(layout.overflow,false,`No toolbar overflow at ${width}px`);
      const overlap=await page.locator('.kv-toolbar').evaluate(toolbar=>{
        const boxes=[...toolbar.querySelectorAll('button,input,select')].map(el=>el.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0);
        return boxes.some((a,index)=>boxes.slice(index+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
      });
      assert.equal(overlap,false,'Toolbar controls do not overlap');
      assert.ok(Math.abs(layout.rightGap)<1,`Tagless stays at the right edge at ${width}px`);
      if(!process.env.KEEP_VIEW_HOST_CSS && rows===1) assert.ok(Math.abs(layout.primary-layout.date)<=3,JSON.stringify(layout));
      if(!process.env.KEEP_VIEW_HOST_CSS && rows===2) assert.ok(Math.abs(layout.primary-layout.sort)<=3 && layout.date>layout.sort,JSON.stringify(layout));
      if(!process.env.KEEP_VIEW_HOST_CSS && rows>=3) assert.ok(layout.sort>layout.primary && layout.date>layout.sort && Math.abs(layout.tag-(rows===3?layout.primary:layout.sort))<=3,JSON.stringify(layout));
    }
    for(const width of [360,1200]) {
      await resize(page,{width,height:850});await page.waitForTimeout(150);
      const gap=await page.evaluate(()=>{
        const bottom=Math.max(...[...document.querySelectorAll('.kv-card')].map(card=>card.getBoundingClientRect().bottom));
        return document.querySelector('.kv-load-more-wrap button').getBoundingClientRect().top-bottom;
      });
      assert.ok(gap>=23,`Card-to-pagination gap at ${width}px: ${gap}`);
    }
    await resize(page,{width:1200,height:850});
    await page.waitForTimeout(150);
    const gaps=await page.evaluate(()=>{
      const rect=selector=>document.querySelector(selector).getBoundingClientRect();
      return [rect('.kv-result-actions > button').top-rect('.kv-search-panel').bottom,rect('.kv-body-wrapper').top-rect('.kv-result-actions > button').bottom];
    });
    assert.ok(Math.abs(gaps[0]-gaps[1])<1,`Desktop vertical gaps match: ${gaps}`);
    await page.evaluate(()=>{
      const preview=document.querySelector('.kv-card-preview');
      preview.innerHTML=marked.parse('本文\n\n- 箇条書き\n  - 子項目\n\n- [ ] チェック\n  - [x] 子チェック');
    });
    const listLayout=await page.locator('.kv-card-preview').first().evaluate(el=>({
      body:el.getBoundingClientRect().left,
      lists:[...el.querySelectorAll(':scope > ul')].map(list=>list.getBoundingClientRect().left+parseFloat(getComputedStyle(list).paddingLeft)),
      nested:[...el.querySelectorAll('ul ul')].map(list=>parseFloat(getComputedStyle(list).paddingLeft)),
      checks:[...el.querySelectorAll('input')].map(input=>parseFloat(getComputedStyle(input).marginLeft)),
    }));
    assert.ok(listLayout.lists.every(left=>Math.abs(left-listLayout.body-14)<1));
    assert.ok(listLayout.nested.every(indent=>indent===14));
    assert.ok(listLayout.checks.every(margin=>margin===0));
    const diagram=await page.locator('.kv-card-preview').first().evaluate(preview=>{
      const sample=document.createElement('div');
      sample.innerHTML='<div class="mermaid"><svg viewBox="0 0 400 100" width="100%"><text x="0" y="20">図の文字</text></svg></div><table><tr><td>表の文字</td></tr></table>';
      preview.appendChild(sample);preview._syncScrollbar();
      const result={body:getComputedStyle(preview).fontSize,diagram:getComputedStyle(sample.querySelector('text')).fontSize,table:getComputedStyle(sample.querySelector('td')).fontSize,width:sample.querySelector('svg').getBoundingClientRect().width};
      sample.remove();preview._syncScrollbar();return result;
    });
    assert.equal(diagram.diagram,diagram.body);assert.equal(diagram.table,diagram.body);
    assert.equal(diagram.width,400,'Diagram labels do not shrink to the card width');
    // Obsidian places the check mark absolutely inside its checkbox.
    await page.addStyleTag({content:'.kv-card-preview input[type=checkbox]{appearance:none;width:14px;height:14px;border:1px solid #888}.kv-card-preview input[type=checkbox]:checked::after{content:"";position:absolute;inset:2px;background:#6958c7}'});
    const check=await page.locator('.kv-card-preview input:checked').evaluate(el=>({position:getComputedStyle(el).position,width:el.offsetWidth,offsetParent:el.offsetParent?.className}));
    assert.equal(check.position,'relative');
    assert.equal(check.width,14);
    await page.locator('.kv-card').first().screenshot({path:path.join(screenshots,'preview-markdown.png')});
    await page.evaluate(()=>{currentSettings.previewMode='source';currentSettings.previewLengths=[75,150,300];controller.refreshSettings();});
    await page.waitForFunction(()=>document.querySelector('.kv-card-preview.is-source')?.textContent.startsWith('# メモ'));
    assert.equal(await page.getByRole('combobox',{name:'プレビュー文字数',exact:true}).locator('option').count(),3);
    await page.evaluate(()=>{currentSettings.previewMode='markdown';controller.refreshSettings();});
    await page.waitForFunction(()=>document.querySelector('.kv-card-preview h1'));
    await page.getByRole('combobox',{name:'表示密度'}).selectOption('single');
    await page.waitForFunction(()=>document.querySelector('.kv-masonry')?.dataset.columns==='1');
    await page.getByRole('combobox',{name:'表示密度'}).selectOption('normal');
    await page.waitForFunction(()=>document.querySelector('.kv-card-preview.is-scrollable'));
    await page.evaluate(()=>{window.beforeIdleCard=document.querySelector('.kv-card');controller.refresh();});
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>beforeIdleCard===document.querySelector('.kv-card')),true,'Unchanged metadata keeps the existing cards');
    await page.evaluate(()=>{document.getElementById('view').style.setProperty('display','none','important');controller.refresh(files[0]);});
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>beforeIdleCard===document.querySelector('.kv-card')),true,'Hidden views defer changed-file redraws');
    await page.evaluate(()=>{document.getElementById('view').style.removeProperty('display');document.querySelector('.keep-view-root').classList.add('kv-page-scrolling');window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>beforeIdleCard!==document.querySelector('.kv-card'));
    assert.equal(await page.locator('.kv-page-scrolling').count(),0,'Returning from idle clears stale scroll interaction state');
    await page.waitForFunction(()=>document.querySelector('.kv-masonry') && getComputedStyle(document.querySelector('.kv-masonry')).visibility!=='hidden');
    assert.ok(await page.locator('.kv-card').evaluateAll(cards=>cards.every(card=>card.style.left!=='' && card.style.top!=='' && card.getBoundingClientRect().width>0)),'Returning to a hidden view reveals only laid out cards');
    const scrolledPreview=page.locator('.kv-card-preview.is-scrollable').first();
    await scrolledPreview.locator('p').first().tap();
    await page.waitForFunction(()=>opened.length===1);
    await page.waitForFunction(()=>activeNotePath===opened.at(-1) && revealed.at(-1)?.path===activeNotePath);
    assert.deepEqual(await page.evaluate(()=>revealed.at(-1)),{path:await page.evaluate(()=>activeNotePath),type:'tab',active:true},'Card opens and reveals its tab despite a background-open preference');
    await page.evaluate(()=>opened=[]);
    await page.locator('.kv-card-title').first().dblclick();
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>opened.length),0,'Double-click selects text without opening');
    assert.ok(await page.evaluate(()=>getSelection().toString().length>0),'Title text can be selected');
    await page.evaluate(()=>getSelection().removeAllRanges());
    await page.locator('.kv-card-title').first().tap();await page.waitForTimeout(80);await page.locator('.kv-card-title').first().tap();
    await page.waitForTimeout(380);
    assert.ok(await page.evaluate(()=>getSelection().toString().length>0),'Touch double tap selects text');
    assert.equal(await page.evaluate(()=>opened.length),0,'Touch text selection does not open the card');
    await page.locator('.kv-header').dispatchEvent('pointerdown',{button:0,pointerId:1,clientX:10,clientY:10});
    assert.equal(await page.evaluate(()=>getSelection().toString()),'','Tapping outside clears card text selection');

    const textBounds=await scrolledPreview.locator('p').first().boundingBox();
    await page.mouse.move(textBounds.x+2,textBounds.y+9);await page.mouse.down();
    await page.mouse.move(textBounds.x+90,textBounds.y+9,{steps:6});await page.mouse.up();
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(()=>getSelection().toString().length>0),'Body text can be selected by dragging');
    assert.equal(await page.evaluate(()=>opened.length),0,'Dragging text never opens the note');
    await page.evaluate(()=>getSelection().removeAllRanges());

    await scrolledPreview.evaluate(el=>{el.scrollTop=30;});
    assert.ok(await scrolledPreview.evaluate(el=>el.scrollTop>0));
    await scrolledPreview.evaluate(el=>{el.scrollTop=0;el._syncScrollbar();});
    const scrollbar=page.locator('.kv-scroll-rail:not([hidden])').first();
    const thumb=await scrollbar.locator('.kv-scroll-thumb').boundingBox();
    const beforeDrag=await scrolledPreview.evaluate(el=>el.scrollTop);
    await page.mouse.move(thumb.x+2,thumb.y+thumb.height/2);
    await page.mouse.down();await page.waitForTimeout(550);
    assert.equal(await page.locator('.kv-card.is-selected').count(),0,'Dragging a scrollbar never starts selection');
    await page.mouse.move(thumb.x+2,thumb.y+thumb.height/2+20,{steps:4});
    assert.equal(await page.locator('.kv-scroll-rail.is-dragging').count(),1,'Drag color remains active while moving');
    assert.ok(await scrolledPreview.evaluate(el=>el.scrollTop)>beforeDrag);
    await page.mouse.up();assert.equal(await page.locator('.kv-scroll-rail.is-dragging').count(),0);
    const colors=await scrollbar.evaluate(el=>({thumb:getComputedStyle(el.firstChild).backgroundColor,date:getComputedStyle(el.closest('.kv-card').querySelector('.kv-card-date')).color}));
    assert.notEqual(colors.thumb,colors.date,'Scrollbar is now lighter than the date');
    await page.mouse.move(1,1);
    const resting=await scrollbar.locator('.kv-scroll-thumb').evaluate(el=>getComputedStyle(el).backgroundColor);
    await scrollbar.hover();
    const hovering=await scrollbar.locator('.kv-scroll-thumb').evaluate(el=>getComputedStyle(el).backgroundColor);
    if(await page.evaluate(()=>matchMedia('(hover: hover) and (pointer: fine)').matches)) assert.notEqual(resting,hovering,'Mouse hover highlights the scrollbar');
    await page.mouse.move(1,1);
    assert.equal(await page.locator('.kv-icon-btn[title]').count(),0);
    const mousePage=await browser.newPage({hasTouch:false});
    await mousePage.setContent('<style>:root{--text-faint:#888;--background-secondary:#f8f8f8;--text-normal:#222}</style><div class="keep-view-content"><div class="keep-view-root"><div class="kv-card" style="width:200px;height:100px"><div class="kv-scroll-rail" style="height:80px"><div class="kv-scroll-thumb" style="height:40px"></div></div></div></div></div>');
    await mousePage.addStyleTag({content:fs.readFileSync(path.join(root,'styles.css'),'utf8')});
    await mousePage.addScriptTag({content:"(()=>{const module={exports:{}};const exports=module.exports;const require=()=>({});\n"+compileSource(fs.readFileSync(path.join(root,'lib/ui.ts'),'utf8'))+"\nwindow.releaseHover=module.exports.suppressHoverTooltips(document.querySelector('.keep-view-content'));})();"});
    const mouseThumb=mousePage.locator('.kv-scroll-thumb');
    const mouseRest=await mouseThumb.evaluate(el=>getComputedStyle(el).backgroundColor);
    await mousePage.evaluate(()=>{const tip=document.createElement('div');tip.className='tooltip';tip.textContent='説明';tip.style.pointerEvents='none';document.body.appendChild(tip);});
    await mousePage.locator('.kv-scroll-rail').hover();
    assert.notEqual(await mouseThumb.evaluate(el=>getComputedStyle(el).backgroundColor),mouseRest,'Desktop pointer hover highlights the rail');
    assert.equal(await mousePage.locator('.tooltip').isVisible(),false,'Keep View suppresses visual hover tips');
    await mousePage.mouse.move(500,500);
    assert.equal(await mousePage.locator('.tooltip').isVisible(),true,'Other application hover tips are unaffected');
    await mousePage.locator('.kv-scroll-rail').hover();
    await mousePage.evaluate(()=>window.releaseHover());
    assert.equal(await mousePage.locator('.tooltip').isVisible(),true,'Disposal restores host tooltips even under the pointer');
    await mousePage.close();

    const separation=await scrollbar.evaluate(rail=>({rail:rail.getBoundingClientRect().left,body:rail.parentElement.querySelector('.kv-card-preview').getBoundingClientRect().right}));
    assert.ok(separation.rail-separation.body>=3,'Scrollbar has a separate column, even with legacy padding overrides');
    await page.evaluate(()=>{document.getElementById('view').scrollTop=20;});
    await page.waitForFunction(()=>document.querySelector('.kv-page-scrolling'));
    assert.equal(await scrolledPreview.evaluate(el=>getComputedStyle(el).overflowY),'hidden');
    await page.waitForFunction(()=>!document.querySelector('.kv-page-scrolling'));
    assert.equal(await scrolledPreview.evaluate(el=>getComputedStyle(el).overflowY),'auto');
    await page.evaluate(()=>{document.getElementById('view').scrollTop=0;});
    await page.waitForTimeout(250);
    const windowBeforeSelection=await page.locator('.kv-header').boundingBox();
    await page.locator('.kv-card-footer').first().dispatchEvent('pointerdown',{button:0,clientX:20,clientY:20});
    await page.waitForTimeout(550);
    await page.locator('.kv-card-footer').first().dispatchEvent('pointerup',{button:0});
    assert.equal(await page.locator('.kv-card.is-selected').count(),1,'Footer long press selects the card');
    assert.equal((await page.locator('.kv-header').boundingBox()).y,windowBeforeSelection.y,'Selection overlay never shifts the existing toolbar');
    const selectionStyle=await page.locator('.kv-selection-bar').evaluate(bar=>({color:getComputedStyle(bar).outlineColor,card:getComputedStyle(document.querySelector('.kv-card.is-selected')).outlineColor,count:bar.querySelector('.kv-selection-count').getBoundingClientRect().left,exit:bar.querySelector('button').getBoundingClientRect().right}));
    assert.equal(selectionStyle.color,selectionStyle.card);assert.ok(selectionStyle.count-selectionStyle.exit<20);
    await page.locator('.kv-header').dispatchEvent('pointerdown',{button:0});
    assert.equal(await page.locator('.kv-card.is-selected').count(),1,'Outside tap retains selection');
    await page.locator('.kv-card-footer').first().dispatchEvent('click'); // consume long-press click
    await page.locator('.kv-card-footer').nth(1).click();
    assert.equal(await page.locator('.kv-card.is-selected').count(),2,'Footer tap toggles in selection mode');
    await page.evaluate(()=>document.getElementById('view').scrollTop=400);
    await page.waitForTimeout(220);
    const sticky=await page.evaluate(()=>({bar:document.querySelector('.kv-selection-bar').getBoundingClientRect().top,view:document.getElementById('view').getBoundingClientRect().top}));
    assert.ok(Math.abs(sticky.bar-sticky.view)<2,'Selection toolbar stays at view top');
    await page.evaluate(()=>document.getElementById('view').scrollTop=0);
    await page.waitForTimeout(220);
    await page.locator('.kv-selection-bar').screenshot({path:path.join(screenshots,'preview-selection.png')});
    await resize(page,{width:360,height:850});
    await page.locator('.kv-selection-bar').screenshot({path:path.join(screenshots,'preview-selection-mobile.png')});
    await resize(page,{width:1200,height:850});
    await page.evaluate(()=>{
      window.bulkWrites=[];window.properties={};window.originalCache=app.metadataCache.getFileCache;
      const paths=[...document.querySelectorAll('.kv-card.is-selected')].map(el=>el.dataset.path);
      paths.forEach((path,i)=>properties[path]={tags:i?['common','partial']:['common'],created:originalCache(files.find(file=>file.path===path)).frontmatter.created});
      app.metadataCache.getFileCache=file=>({...originalCache(file),frontmatter:properties[file.path]||originalCache(file).frontmatter});
      app.fileManager.processFrontMatter=async(file,edit)=>{const fm=properties[file.path]||={};edit(fm);bulkWrites.push({path:file.path,fm:structuredClone(fm)});};
    });
    await page.getByRole('button',{name:'タグを編集',exact:true}).click();
    assert.equal(await page.locator('.kv-dropdown input[aria-label="common"]').isChecked(),true);
    assert.equal(await page.locator('.kv-dropdown input[aria-label="partial"]').isDisabled(),true);
    assert.equal(await page.locator('.kv-dropdown input[aria-label="partial"]').isChecked(),true);
    assert.equal(await page.locator('.kv-dropdown-item').filter({has:page.locator('input[aria-label="仕事"]')}).first().locator('.kv-tag-count').count(),0);
    assert.equal(await page.locator('.kv-dropdown-item').filter({has:page.locator('input[aria-label="common"]')}).locator('.kv-tag-count').textContent(),'2/2');
    assert.equal(await page.locator('.kv-dropdown-item').filter({has:page.locator('input[aria-label="partial"]')}).locator('.kv-tag-count').textContent(),'1/2');
    await page.addStyleTag({content:'input:checked::after { border-color: black !important; }'});
    assert.equal(await page.locator('input[aria-label="common"]').evaluate(el=>getComputedStyle(el.parentElement.querySelector('.kv-checkbox-mark')).borderLeftColor),'rgb(255, 255, 255)','Desktop checkmarks keep the Markdown marker color even with theme overrides');
    await page.locator('.kv-dropdown input[aria-label="common"]').click();
    await page.locator('.kv-dropdown input[aria-label="仕事"]').first().click();
    assert.equal(await page.locator('.kv-dropdown').count(),1,'Multi-select stays open');
    assert.equal(await page.evaluate(()=>bulkWrites.length),0,'Draft edits do not write');
    await page.getByRole('button',{name:'タグを編集',exact:true}).click();
    assert.equal(await page.locator('.kv-dropdown input[aria-label="common"]').isChecked(),false);
    assert.equal(await page.locator('.kv-dropdown input[aria-label="仕事"]').first().isChecked(),true);

    assert.equal(await page.locator('.kv-selection-bar .kv-icon-btn').count(),2,'Selection toolbar has exit and trash icons');
    assert.equal(await page.locator('.kv-selection-confirm').evaluate(el=>getComputedStyle(el).outlineColor),await page.locator('.kv-card.is-selected').first().evaluate(el=>getComputedStyle(el).outlineColor));
    await page.evaluate(()=>document.querySelector('[aria-label="元に戻す"]').click());
    assert.equal(await page.evaluate(()=>bulkWrites.length),0,'Draft undo does not write');
    await page.evaluate(()=>document.querySelector('[aria-label="やり直す"]').click());
    await page.getByRole('button',{name:'決定',exact:true}).click();
    await page.waitForFunction(()=>bulkWrites.length===2);
    assert.ok(await page.evaluate(()=>Object.values(properties).every(fm=>fm.tags.includes('仕事')&&!fm.tags.includes('common')&&!!fm.created)));
    assert.equal(await page.locator('.kv-card.is-selected').count(),0,'Confirm exits selection mode');
    await page.evaluate(()=>document.querySelector('[aria-label="元に戻す"]').click());
    await page.waitForFunction(()=>bulkWrites.length===4);
    assert.ok(await page.evaluate(()=>Object.values(properties).every(fm=>fm.tags.includes('common')&&!fm.tags.includes('仕事'))),'Undo restores committed tags');
    await page.evaluate(()=>document.querySelector('[aria-label="やり直す"]').click());
    await page.waitForFunction(()=>bulkWrites.length===6);
    await page.locator('.kv-card').first().click({modifiers:['Control']});
    await page.locator('.kv-card').nth(1).click();
    await page.getByRole('button',{name:'タグを編集',exact:true}).click();
    await page.locator('.kv-dropdown input[aria-label="仕事"]').first().click();
    await page.getByRole('button',{name:'選択モードを解除',exact:true}).click();
    assert.equal(await page.evaluate(()=>bulkWrites.length),6,'Exit discards uncommitted edits');
    assert.equal(await page.locator('.kv-selection-bar').isVisible(),false);
    await page.getByRole('button',{name:'元に戻す',exact:true}).click();
    assert.equal(await page.locator('.kv-card.is-selected').count(),2,'Selection undo restores selected paths');
    await page.getByRole('button',{name:'選択モードを解除',exact:true}).click();
    await page.evaluate(()=>{app.metadataCache.getFileCache=originalCache;});
    const search=async query=>{
      await page.getByRole('button',{name:'全文検索',exact:true}).click();
      await page.getByRole('searchbox',{name:'検索する文字',exact:true}).fill(query);
      await page.getByRole('button',{name:'検索',exact:true}).click();
      await page.waitForSelector('.kv-text-search-modal',{state:'detached'});
      await page.waitForFunction(()=>!document.querySelector('.kv-search-status'));
    };
    await search('メモ1');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===11);
    assert.equal(await page.locator('.kv-counter').textContent(),'11 件');
    const afterSearch=await page.evaluate(()=>readCount);
    await page.evaluate(()=>{for(let i=0;i<5;i++) controller.refresh();});
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>readCount),afterSearch,'Metadata refresh reuses search decisions');
    await page.evaluate(()=>{
      controller.dispose();document.getElementById('view').empty();window.readsBeforeReopen=readCount;
      window.controller=mountKeepView(app,document.getElementById('view').createDiv(),saved,state=>window.saved=state,currentSettings);
    });
    assert.match(await page.locator('.kv-search-status').textContent(),/検索を再開/);
    assert.equal(await page.evaluate(()=>readCount),await page.evaluate(()=>readsBeforeReopen),'Restoring a view does not start scanning notes');
    await search('メモ1');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===11);
    await page.getByRole('button',{name:'タグなし',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===3);
    await page.getByRole('button',{name:'パス出力',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-export-modal textarea')?.value.startsWith('{'));
    const searchedExport=JSON.parse(await page.locator('.kv-export-modal textarea').inputValue());
    assert.equal(searchedExport.count,3);assert.equal(searchedExport.filters.textQuery,'メモ1');
    await page.evaluate(()=>document.querySelector('.kv-export-modal').remove());
    await page.evaluate(()=>{window.scopedReads=[];window.readBeforeScope=app.vault.cachedRead;app.vault.cachedRead=async file=>{scopedReads.push(file.i);return readBeforeScope(file);};});
    await search('一致しない語句');
    assert.equal(await page.locator('.kv-card').count(),0);
    assert.ok(await page.evaluate(()=>scopedReads.length===14 && scopedReads.every(i=>i%3===0)),'Only metadata-filtered candidates are read');
    await page.evaluate(()=>{app.vault.cachedRead=readBeforeScope;});
    await page.getByRole('button',{name:'全文検索',exact:true}).tap();
    await page.getByRole('button',{name:'クリア',exact:true}).tap();
    await page.waitForFunction(()=>saved.textQuery==='' && document.querySelectorAll('.kv-card').length===14);
    await page.getByRole('button',{name:'タグなし',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===30);
    await page.evaluate(()=>{
      window.originalRead=app.vault.cachedRead;
      app.vault.cachedRead=async file=>(await originalRead(file))+(file.i===41?'\n'+'長'.repeat(500)+'末尾だけの検索語':'');
      files[41].stat.mtime++;controller.refresh(files[41]);
    });
    await search('末尾だけの検索語');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===1);
    assert.equal(await page.locator('.kv-card').getAttribute('data-path'),'仕事/メモ41.md');
    await page.evaluate(()=>{app.vault.cachedRead=async file=>{if(file.i===0) throw Error('read failed');return originalRead(file);};files[0].stat.mtime++;controller.refresh(files[0]);});
    await search('本文');
    assert.equal(await page.getByRole('button',{name:'パス出力',exact:true}).isDisabled(),true);
    assert.match(await page.locator('.kv-search-error').textContent(),/1 件/);
    await page.evaluate(()=>{app.vault.cachedRead=originalRead;controller.refresh(files[0]);});
    await search('本文');
    assert.equal(await page.getByRole('button',{name:'パス出力',exact:true}).isDisabled(),false);
    const beforeChange=await page.evaluate(()=>readCount);
    await page.evaluate(()=>{files[41].stat.mtime++;controller.refresh(files[41]);});
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(()=>readCount))-beforeChange,1,'Only the edited candidate is searched again');
    await search('');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===30);
    assert.equal(await page.getByRole('button',{name:'フォルダ',exact:true}).textContent(),'');
    await page.getByRole('button',{name:'ツリー表示',exact:true}).click();
    assert.equal(await page.locator('.kv-card').count(),21,'Root notes are displayed without a synthetic folder');
    assert.equal(await page.locator('.kv-result-folder').count(),1);
    await page.evaluate(()=>{window.lookupBeforeCreate=app.vault.getAbstractFileByPath;app.vault.getAbstractFileByPath=path=>path==='仕事'?{path:'仕事',children:[]}:lookupBeforeCreate(path);});
    await page.locator('.kv-result-folder-heading').first().screenshot({path:path.join(screenshots,'preview-folder-create.png')});
    const folderAppearance=await page.evaluate(()=>{
      const plus=getComputedStyle(document.querySelector('.kv-folder-create'));
      return {background:getComputedStyle(document.querySelector('.kv-result-folder')).backgroundColor,card:getComputedStyle(document.querySelector('.kv-card')).backgroundColor,base:getComputedStyle(document.querySelector('.kv-header')).backgroundColor,width:plus.width,border:plus.borderTopWidth,transform:plus.transform};
    });
    assert.equal(folderAppearance.background,folderAppearance.base);
    assert.equal(folderAppearance.width,'24px');assert.equal(folderAppearance.border,'0px');assert.equal(folderAppearance.transform,'none');
    await page.getByRole('button',{name:'仕事 に新規ノート',exact:true}).tap();
    await page.waitForFunction(()=>activeNotePath==='仕事/無題.md' && revealed.at(-1)?.path===activeNotePath);
    assert.equal(await page.evaluate(()=>revealed.at(-1).active),true,'Folder creation opens the note in the foreground');
    assert.equal(await page.evaluate(()=>exportsWritten.at(-1).path),'仕事/無題.md');
    assert.equal(await page.locator('.kv-result-folder').first().getAttribute('aria-expanded'),'false','Creating a note does not toggle the folder');
    await page.evaluate(()=>{app.vault.getAbstractFileByPath=lookupBeforeCreate;});
    assert.equal(await page.getByRole('button',{name:'すべて展開',exact:true}).count(),1);
    await page.getByRole('button',{name:'すべて展開',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===42);
    await page.getByRole('button',{name:'すべて折りたたむ',exact:true}).click();
    assert.equal(await page.locator('.kv-card').count(),21);
    await page.locator('.kv-result-folder').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===42);
    await page.getByRole('button',{name:'すべて折りたたむ',exact:true}).click();
    assert.equal(await page.locator('.kv-card').count(),21);
    await page.locator('.kv-result-folder').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===42);
    await page.evaluate(()=>{
      window.originalFiles=[...files];window.originalNestedPath=files[1].path;
      files[1].path='仕事/子フォルダ/メモ1.md';files[1].parent={path:'仕事/子フォルダ'};
      files.push(...Array.from({length:40},(_,i)=>({path:`仕事/追加${i}.md`,basename:`追加${i}`,parent:{path:'仕事'},stat:{mtime:Date.now(),ctime:Date.now()},i:i+42})));
      controller.refresh();
    });
    await page.waitForFunction(()=>document.querySelector('.kv-result-count') && [...document.querySelectorAll('.kv-result-count')].some(el=>el.textContent==='61'));
    await page.getByRole('button',{name:'すべて折りたたむ',exact:true}).click();
    await page.locator('[data-folder="仕事"]:not([data-direct]) > .kv-result-folder-heading > .kv-result-folder').click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===51);
    assert.equal(await page.locator('.kv-card').count(),51,'Direct notes follow subfolders without a synthetic folder');
    assert.equal(await page.locator('[data-direct]').count(),0);
    assert.equal(await page.locator('[data-folder="仕事/子フォルダ"] > .kv-result-folder-heading > .kv-result-folder').count(),1);
    await page.locator('[data-folder="仕事/子フォルダ"] > .kv-result-folder-heading > .kv-result-folder').click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===52);
    assert.equal(await page.locator('.kv-card').count(),52,'Leaf folder shows cards directly');
    const moreCenter=await page.locator('.kv-folder-more > button').evaluate(button=>Math.abs((button.getBoundingClientRect().left+button.getBoundingClientRect().right)-(button.parentElement.getBoundingClientRect().left+button.parentElement.getBoundingClientRect().right)));
    assert.ok(moreCenter>=6 && moreCenter<=10,'Folder pagination shifts only four pixels to the right');
    await page.locator('.kv-folder-more > button').click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===82);
    await page.getByRole('button',{name:'すべて折りたたむ',exact:true}).click();
    assert.equal(await page.locator('.kv-card').count(),21);
    const folderRow=page.locator('[data-folder="仕事"] > .kv-result-folder-heading > .kv-result-folder');
    await folderRow.dispatchEvent('pointerdown',{button:0,clientX:20,clientY:20});await page.waitForTimeout(550);await folderRow.dispatchEvent('pointerup',{button:0});
    assert.equal(await page.locator('.kv-selection-count').textContent(),'61 件選択','Folder selection includes descendants and paginated notes');
    assert.equal(await folderRow.getAttribute('aria-pressed'),'true');
    await page.evaluate(()=>{
      window.filesBeforeMove=files.map(file=>({file,path:file.path,parent:file.parent}));window.originalLookup=app.vault.getAbstractFileByPath;
      const folders=[{path:'/',children:[]},{path:'仕事',children:[]},{path:'仕事/子フォルダ',children:[]},{path:'移動先',children:[]}];
      folders[1].children=[...files.filter(file=>file.parent.path==='仕事'),folders[2]];folders[2].children=files.filter(file=>file.parent.path==='仕事/子フォルダ');
      app.vault.getAllLoadedFiles=()=>[...files,...folders];
      app.vault.getAbstractFileByPath=path=>originalLookup(path)||folders.find(folder=>folder.path===path);
      window.movedFiles=[];
      app.fileManager.renameFile=async(file,target)=>{movedFiles.push({from:file.path,to:target});const old=file.path;for(const child of [...files,...folders].filter(child=>child!==file && child.path.startsWith(old+'/'))) {child.path=target+child.path.slice(old.length);child.parent={path:child.path.split('/').slice(0,-1).join('/')};}file.path=target;file.parent={path:target.split('/').slice(0,-1).join('/')};};
    });
    await page.getByRole('button',{name:'フォルダを移動',exact:true}).click();
    assert.equal(await page.locator('.kv-move-folder[data-destination="仕事"] .kv-move-count').textContent(),'60/61');
    assert.equal(await page.locator('.kv-dropdown').evaluate(el=>el.textContent.includes('現在')),false);
    assert.equal(await page.getByRole('button',{name:'決定',exact:true}).isVisible(),false);
    await page.locator('.kv-move-folder[data-destination="移動先"]').click();
    assert.equal(await page.locator('.kv-move-folder[data-destination="移動先"] input').getAttribute('type'),'checkbox');
    const checkSize=await page.locator('.kv-move-folder[data-destination="移動先"] input').evaluate(el=>{
      const box=getComputedStyle(el),mark=getComputedStyle(el.parentElement.querySelector('.kv-checkbox-mark'));
      return [box.width,box.height,mark.width,mark.height,mark.top,mark.left];
    });
    assert.deepEqual(checkSize,['16px','16px','8px','5px','4px','4px'],'Shared check mark fits within its checkbox');
    await page.locator('.kv-dropdown').screenshot({path:path.join(screenshots,'preview-move-checkbox.png')});
    await page.locator('.kv-move-folder[data-destination="移動先"] input').click();
    assert.equal(await page.getByRole('button',{name:'決定',exact:true}).isVisible(),false,'Clicking the selected destination clears it');
    await page.locator('.kv-move-folder[data-destination="移動先"]').click();

    assert.equal(await page.evaluate(()=>movedFiles.length),0,'Choosing a destination does not move files');
    await page.evaluate(()=>window.writesBeforeCombined=bulkWrites.length);
    await page.getByRole('button',{name:'タグを編集',exact:true}).click();
    await page.locator('.kv-dropdown input[aria-label="仕事"]').first().click();
    await page.getByRole('button',{name:'フォルダを移動',exact:true}).click();
    assert.equal(await page.locator('.kv-move-folder[data-destination="移動先"] input').isChecked(),true,'Destination draft survives switching menus');
    assert.equal(await page.evaluate(()=>bulkWrites.length===writesBeforeCombined && movedFiles.length===0),true);
    await resize(page,{width:320,height:850});
    const confirmRow=await page.locator('.kv-selection-bar').evaluate(bar=>({move:bar.querySelector('.kv-selection-move').getBoundingClientRect().top,confirm:bar.querySelector('.kv-selection-confirm').getBoundingClientRect().top}));
    assert.ok(Math.abs(confirmRow.move-confirmRow.confirm)<2,'Confirm remains next to move on mobile '+JSON.stringify(await page.locator('.kv-selection-bar').evaluate(bar=>({width:bar.clientWidth,gap:getComputedStyle(bar).gap,children:[...bar.children].map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,margin:getComputedStyle(el).marginLeft,padding:getComputedStyle(el).padding}))}))));
    await page.locator('.kv-selection-bar').screenshot({path:path.join(screenshots,'preview-selection-confirm-mobile.png')});
    await resize(page,{width:1200,height:850});
    await page.getByRole('button',{name:'決定',exact:true}).click();
    await page.waitForFunction(()=>movedFiles.length===1 && document.querySelector('.kv-selection-bar').hidden);
    assert.equal(await page.evaluate(()=>files.some(file=>file.path==='移動先/仕事/子フォルダ/メモ1.md')),true,'Folder movement preserves nested paths');
    assert.deepEqual(await page.evaluate(()=>movedFiles),[{from:'仕事',to:'移動先/仕事'}]);
    assert.equal(await page.evaluate(()=>bulkWrites.length-writesBeforeCombined),61,'Confirm applies tags and moves together');
    assert.equal(await page.locator('.kv-selection-bar').isVisible(),false);
    await page.evaluate(()=>{for(const entry of filesBeforeMove){entry.file.path=entry.path;entry.file.parent=entry.parent;}app.vault.getAbstractFileByPath=originalLookup;delete app.vault.getAllLoadedFiles;});
    await page.evaluate(()=>{files=originalFiles;files[1].path=originalNestedPath;files[1].parent={path:'仕事'};controller.refresh();});
    await page.waitForFunction(()=>[...document.querySelectorAll('.kv-result-count')].every(el=>el.textContent==='21'));

    await page.getByRole('button',{name:'ツリー表示',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===30);
    await page.evaluate(()=>{document.getElementById('view').scrollTop=500;});
    await page.waitForFunction(()=>document.querySelector('.kv-header').getBoundingClientRect().bottom<100);
    await page.evaluate(()=>{document.getElementById('view').scrollTop=0;});
    await page.getByRole('button',{name:'フォルダ',exact:true}).click();
    await page.getByRole('checkbox',{name:'すべて',exact:true}).check();
    assert.deepEqual((await page.evaluate(()=>saved.folderFilters)).sort(),['','仕事']);
    assert.equal(await page.getByRole('checkbox',{name:'(ルート)',exact:true}).isChecked(),true);
    await page.getByRole('checkbox',{name:'仕事',exact:true}).uncheck();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===21);
    await page.getByRole('checkbox',{name:'すべて',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>saved.folderFilters),[]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===30);
    await page.getByRole('button',{name:'パス出力',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-export-modal textarea')?.value.startsWith('{'));
    const initialExport=JSON.parse(await page.locator('.kv-export-modal textarea').inputValue());
    assert.equal(initialExport.count,42);
    assert.equal(initialExport.paths[0],'メモ0.md');
    assert.equal(Object.hasOwn(initialExport,'vaultRoot'),false);
    assert.equal(await page.getByRole('checkbox',{name:'Vault の絶対パスを含める'}).isChecked(),false);
    await page.getByRole('checkbox',{name:'Vault の絶対パスを含める'}).check();
    assert.equal(JSON.parse(await page.locator('.kv-export-modal textarea').inputValue()).vaultRoot,'C:\\Test Vault');
    await page.getByRole('checkbox',{name:'Vault の絶対パスを含める'}).uncheck();
    await page.getByRole('button',{name:'Vault に保存',exact:true}).click();
    assert.equal(await page.evaluate(()=>JSON.parse(exportsWritten.at(-1).content).paths.length),42);
    await page.locator('.kv-export-modal select').selectOption('txt');
    assert.equal((await page.locator('.kv-export-modal textarea').inputValue()).split('\n').length,42);
    await page.getByRole('checkbox',{name:'Vault の絶対パスを含める'}).check();
    assert.ok((await page.locator('.kv-export-modal textarea').inputValue()).startsWith('C:\\Test Vault\\メモ0.md'));
    await page.evaluate(()=>document.querySelector('.kv-export-modal').remove());
    await page.getByRole('button',{name:'さらに表示',exact:false}).scrollIntoViewIfNeeded();
    const scrollBeforeMore=await page.evaluate(()=>document.getElementById('view').scrollTop);
    await page.evaluate(()=>{window.firstCardBeforeMore=document.querySelector('.kv-card');window.firstPreviewBeforeMore=document.querySelector('.kv-card-preview');});
    await page.getByRole('button',{name:'さらに表示',exact:false}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===42);
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(()=>document.getElementById('view').scrollTop)>=scrollBeforeMore-2,'Load more retains scroll position');
    assert.ok(await page.evaluate(()=>firstCardBeforeMore===document.querySelector('.kv-card') && firstPreviewBeforeMore===document.querySelector('.kv-card-preview')),'Load more preserves existing rendered cards');
    await page.evaluate(()=>document.getElementById('view').scrollTop=0);
    await page.locator('.kv-formula-input').fill('#仕事 AND NOT #完了');
    await page.locator('.kv-formula-input').press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===28);
    await page.waitForFunction(()=>!document.body.textContent.includes('読み込み中...'));
    // Markdown rendering and ResizeObserver settle asynchronously after data loads.
    await page.waitForFunction(()=>{
      const grid=document.querySelector('.kv-masonry');if(!grid) return false;
      const cards=[...grid.querySelectorAll('.kv-card')];
      const columns=Number(grid.dataset.columns);if(!columns) return false;
      const lefts=[...new Set(cards.map(card=>parseFloat(card.style.left)))].sort((a,b)=>a-b);
      const bottoms=Array(columns).fill(0);
      return cards.every(card=>{
        const top=parseFloat(card.style.top);const column=lefts.indexOf(parseFloat(card.style.left));
        if(column<0 || Math.abs(top-Math.min(...bottoms))>1.1) return false;
        bottoms[column]=top+card.getBoundingClientRect().height+12;return true;
      });
    });
    const layout=await page.evaluate(()=>{
      const grid=document.querySelector('.kv-masonry');
      const cards=[...grid.querySelectorAll('.kv-card')];
      return {columns:Number(grid.dataset.columns),cards:cards.map(el=>({left:parseFloat(el.style.left),top:parseFloat(el.style.top),height:el.offsetHeight}))};
    });
    const bottoms=Array(layout.columns).fill(0);
    const lefts=[...new Set(layout.cards.map(c=>c.left))].sort((a,b)=>a-b);
    for(const card of layout.cards) {
      const minimum=Math.min(...bottoms);
      assert.ok(Math.abs(card.top-minimum)<1.1,`card top ${card.top} should be ${minimum}`);
      const column=lefts.indexOf(card.left);bottoms[column]=card.top+card.height+12;
    }
    await page.screenshot({path:path.join(screenshots,'preview.png')});
    await page.getByRole('button',{name:'タグなし',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===0);
    await page.locator('.kv-formula-input').fill('NOT #完了');
    await page.locator('.kv-formula-input').press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===14);
    const openedBeforeCard=await page.evaluate(()=>opened.length);
    await page.locator('.kv-card').first().tap();
    await page.waitForFunction(count=>opened.length===count+1,openedBeforeCard);
    await page.waitForFunction(()=>activeNotePath===opened.at(-1) && revealed.at(-1)?.path===activeNotePath);
    assert.equal(await page.evaluate(()=>revealed.at(-1).active),true,'Mobile card tap explicitly activates its tab');
    await page.getByRole('button',{name:'フォルダ',exact:true}).click();
    await page.waitForSelector('.kv-dropdown');
    await page.evaluate(()=>controller.dispose());
    assert.equal(await page.locator('.kv-dropdown').count(),0);
    await page.evaluate(()=> { document.getElementById('view').empty();window.controller=mountKeepView(app,document.getElementById('view').createDiv(),saved,s=>window.saved=s); });
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===14);
    await resize(page,{width:360,height:850});
    await page.getByRole('combobox',{name:'表示密度'}).focus();
    assert.ok(await page.getByRole('combobox',{name:'表示密度'}).evaluate(el=>{
      const style=getComputedStyle(el);
      const probe=document.createElement('div');probe.style.color=style.getPropertyValue('--kv-card-border');document.body.appendChild(probe);
      const border=getComputedStyle(probe).color;probe.remove();
      return style.borderTopColor===border && style.boxShadow==='none' && style.outlineStyle==='none';
    }),'Closed touch picker has no lingering selection frame');
    await page.waitForFunction(()=>document.querySelector('.kv-masonry')?.dataset.columns==='1');
    const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow,false);
    await page.evaluate(()=>document.getElementById('view').scrollTop=0);
    for(const width of [320,360]) {
      await resize(page,{width,height:850});
      await page.getByLabel('開始日',{exact:true}).fill('2020-01-01');
      await page.getByLabel('終了日',{exact:true}).fill('2030-01-01');
      const bounds=await page.evaluate(()=>{
        const rect=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
        return {primary:[...document.querySelectorAll('.kv-primary-tools button,.kv-primary-tools select')].map(rect),
          dates:[...document.querySelector('.kv-date-range').children].map(rect),
          sort:rect(document.querySelector('.kv-toolbar')),tag:rect(document.querySelector('.kv-no-tag')),
          overflow:document.getElementById('view').scrollWidth>document.getElementById('view').clientWidth};
      });
      assert.ok(Math.max(...bounds.primary.map(r=>r.top))-Math.min(...bounds.primary.map(r=>r.top))<3,`First row at ${width}px`);
      assert.ok(bounds.primary[1].left-bounds.primary[0].right<=6,'Undo and redo stay adjacent');
      assert.ok(Math.max(...bounds.dates.map(r=>r.top))<Math.min(...bounds.dates.map(r=>r.bottom)),`Date controls share a row at ${width}px`);
      assert.ok(Math.abs(bounds.tag.right-bounds.sort.right)<1,JSON.stringify({width,bounds}));
      assert.equal(bounds.overflow,false);
      const mobileButtons=await page.evaluate(()=>[...document.querySelectorAll('.kv-primary-tools button,.kv-view-actions button')].map(el=>({label:el.getAttribute('aria-label'),x:el.getBoundingClientRect().left,y:el.getBoundingClientRect().top,width:el.offsetWidth,height:el.offsetHeight})));
      assert.ok(mobileButtons.every(b=>b.width===36 && b.height===36));
      assert.ok(Math.max(...mobileButtons.map(b=>b.y))-Math.min(...mobileButtons.map(b=>b.y))<1);
      assert.ok(mobileButtons.find(b=>b.label==='ツリー表示').x<mobileButtons.find(b=>b.label==='フォルダ').x);
      assert.ok(mobileButtons.find(b=>b.label==='フォルダ').x<mobileButtons.find(b=>b.label==='全文検索').x);
      assert.equal(await page.locator('.kv-segmented').evaluate(el=>el.offsetHeight),36);
      assert.ok(await page.locator('.kv-segment').evaluateAll(buttons=>buttons.every(button=>{
        const r=button.getBoundingClientRect(),p=button.parentElement.getBoundingClientRect();
        return r.height===30 && r.top>=p.top && r.bottom<=p.bottom && getComputedStyle(button).whiteSpace==='nowrap';
      })),'Segments fit within their 36px frame');
      const sortBounds=await page.locator('.kv-sort-tools').boundingBox();
      const orderBounds=await page.locator('.kv-sort-tools > button').boundingBox();
      assert.ok(orderBounds.x+orderBounds.width<=bounds.tag.left,'Sort and tagless do not overlap');
      assert.equal(await page.locator('.kv-date-range span').textContent(),'–');
      await page.getByRole('button',{name:'期間を解除',exact:true}).click();
    }
    await page.screenshot({path:path.join(screenshots,'preview-mobile.png')});
    // Test the page's real taps before the lower-level CDP drag session changes
    // Chromium's touch-emulation state (even ordinary buttons then lose clicks).
    await page.evaluate(()=>document.getElementById('view').scrollTop=0);
    await page.getByRole('button',{name:'新規ノート',exact:true}).tap();
    await page.waitForFunction(()=>exportsWritten.at(-1)?.path==='無題.md');
    await page.waitForFunction(()=>activeNotePath==='無題.md' && revealed.at(-1)?.path===activeNotePath);
    assert.equal(await page.evaluate(()=>revealed.at(-1).active),true,'Mobile toolbar creation opens the note in the foreground');
    assert.match(await page.evaluate(()=>exportsWritten.at(-1).content),/"created": "/);
    const mobileRail=page.locator('.kv-scroll-rail:not([hidden])').first();
    await mobileRail.scrollIntoViewIfNeeded();await page.waitForTimeout(250);
    await mobileRail.evaluate(el=>{const preview=el.previousElementSibling;preview.scrollTop=0;preview._syncScrollbar();});
    const mobileThumb=await mobileRail.locator('.kv-scroll-thumb').boundingBox();
    const touch=await page.context().newCDPSession(page);
    const point={x:mobileThumb.x+2,y:mobileThumb.y+mobileThumb.height/2};
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y+16}]});
    assert.equal(await page.locator('.kv-scroll-rail.is-dragging').count(),1);
    assert.ok(await mobileRail.evaluate(el=>el.previousElementSibling.scrollTop)>0,'Touch drag scrolls preview');
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await page.locator('.kv-scroll-rail.is-dragging').count(),0);
    await touch.detach();
    await page.evaluate(()=>document.getElementById('view').scrollTop=1e9);
    const bottomGap=await page.evaluate(()=>{
      const sc=document.getElementById('view');
      const button=sc.querySelector('.kv-load-more-wrap button');
      return sc.getBoundingClientRect().bottom-button.getBoundingClientRect().bottom;
    });
    assert.ok(bottomGap>=128,`Expected mobile bottom clearance >=128px, got ${bottomGap}`);
    await page.evaluate(()=>{
      const originalMatchMedia=window.matchMedia.bind(window);
      window.matchMedia=query=>query==='(pointer: coarse)'?{matches:true}:originalMatchMedia(query);
      const viewport=new EventTarget(); Object.assign(viewport,{offsetLeft:0,offsetTop:0,width:360,height:850});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
      const sc=document.getElementById('view');sc.scrollTop=0;
    });
    await page.locator('.kv-tag-selected').first().click();
    await page.waitForSelector('.kv-dropdown');
    assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('kv-dropdown-search')),false);
    const before=await page.evaluate(()=>({anchor:document.querySelector('.kv-tag-selected').getBoundingClientRect().bottom,popup:document.querySelector('.kv-dropdown').getBoundingClientRect().top}));
    await page.evaluate(()=>{document.getElementById('view').scrollTop=25;});
    await page.waitForFunction(()=> Math.abs(document.querySelector('.kv-dropdown').getBoundingClientRect().top-document.querySelector('.kv-tag-selected').getBoundingClientRect().bottom-4)<2);
    const after=await page.evaluate(()=>({anchor:document.querySelector('.kv-tag-selected').getBoundingClientRect().bottom,popup:document.querySelector('.kv-dropdown').getBoundingClientRect().top}));
    assert.ok(after.anchor<before.anchor);
    assert.ok(Math.abs((after.anchor-before.anchor)-(after.popup-before.popup))<2);
    await page.locator('.kv-dropdown-search').focus();
    await page.evaluate(()=>{window.visualViewport.height=420;window.visualViewport.dispatchEvent(new Event('resize'));});
    const popupBounds=await page.locator('.kv-dropdown').boundingBox();
    assert.ok(popupBounds && popupBounds.y>=0 && popupBounds.y+popupBounds.height<=420,JSON.stringify(await page.evaluate(()=>({popup:document.querySelector('.kv-dropdown')?.outerHTML,anchor:document.querySelector('.kv-tag-selected')?.getBoundingClientRect().toJSON(),scroll:document.getElementById('view').scrollTop}))));
    await page.locator('.kv-dropdown-search').focus();
    await page.evaluate(()=>{window.visualViewport.height=210;window.visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>{
      const popup=document.querySelector('.kv-dropdown');const input=document.querySelector('.kv-dropdown-search');
      if(!popup || !input || getComputedStyle(popup).visibility==='hidden') return false;
      const bounds=input.getBoundingClientRect();return bounds.top>=0 && bounds.bottom<=210;
    },null,{timeout:3000}).catch(async error=>{console.error(await page.evaluate(()=>({popup:document.querySelector('.kv-dropdown')?.outerHTML,anchor:document.querySelector('.kv-tag-selected')?.getBoundingClientRect().toJSON(),input:document.querySelector('.kv-dropdown-search')?.getBoundingClientRect().toJSON(),active:document.activeElement?.outerHTML,scroll:document.getElementById('view').scrollTop})));throw error;});
    const keyboardPopup=await page.locator('.kv-dropdown').boundingBox();
    assert.ok(keyboardPopup && keyboardPopup.y>=0 && keyboardPopup.y+keyboardPopup.height<=210,JSON.stringify(await page.evaluate(()=>({popup:document.querySelector('.kv-dropdown')?.outerHTML,anchor:document.querySelector('.kv-tag-selected')?.getBoundingClientRect().toJSON(),active:document.activeElement?.outerHTML,scroll:document.getElementById('view').scrollTop}))));
    await page.evaluate(()=>{document.getElementById('view').scrollTop=550;});
    await page.waitForFunction(()=>document.querySelector('.kv-dropdown')?.style.visibility==='hidden',null,{timeout:3000}).catch(async error=>{console.error(await page.evaluate(()=>({popup:document.querySelector('.kv-dropdown')?.outerHTML,anchor:document.querySelector('.kv-tag-selected')?.getBoundingClientRect().toJSON(),active:document.activeElement?.outerHTML,scroll:document.getElementById('view').scrollTop})));throw error;});
    await page.evaluate(()=>controller.dispose());
    assert.equal(await page.evaluate(()=>liveComponents),0);
    await page.evaluate(()=>{
      window.deleteFiles=['alpha.md','Notes/beta.md','gamma.md'].map((path,i)=>({path,basename:path.split('/').pop().replace('.md',''),parent:{path:i===1?'Notes':'/'},stat:{mtime:Date.now(),ctime:Date.now()},i}));
      window.trashed=[];window.deleteSettings={...DEFAULT_SETTINGS};
      const deleteApp={vault:{getMarkdownFiles:()=>deleteFiles,getAbstractFileByPath:path=>deleteFiles.find(file=>file.path===path),cachedRead:async file=>`# ${file.basename}\n\n削除前に確認する本文。`},fileManager:{trashFile:async file=>{trashed.push({path:file.path,viaFileManager:true});deleteFiles=deleteFiles.filter(item=>item!==file);}},metadataCache:{getFileCache:()=>({tags:[],frontmatter:{created:new Date().toISOString()}}),getFirstLinkpathDest:()=>null},workspace:{getLeaf:()=>({openFile(){}})}};
      document.getElementById('view').empty();window.deleteController=mountKeepView(deleteApp,document.getElementById('view').createDiv(),{},()=>{},deleteSettings);
    });
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===3);
    await page.locator('.kv-card[data-path="alpha.md"]').click({modifiers:['Control']});
    await page.locator('.kv-card[data-path="Notes/beta.md"]').click();
    await page.getByRole('button',{name:'ノートを削除',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-delete-modal .kv-card-preview p').length===2);
    assert.equal(await page.evaluate(()=>trashed.length),0,'Opening delete confirmation does not delete');
    assert.equal(await page.getByRole('button',{name:'さらにプレビューを表示（残り 0 件）',exact:true}).isVisible(),false);
    assert.deepEqual(await page.locator('.kv-delete-path').allTextContents(),['alpha.md','Notes/beta.md']);
    await page.locator('.kv-delete-modal').screenshot({path:path.join(screenshots,'preview-delete-mobile.png')});
    await page.getByRole('button',{name:'キャンセル',exact:true}).click();
    assert.equal(await page.evaluate(()=>trashed.length),0);
    assert.equal(await page.locator('.kv-card.is-selected').count(),2,'Cancel preserves selection');
    await page.getByRole('button',{name:'ノートを削除',exact:true}).click();
    await page.getByRole('button',{name:'2 件を削除',exact:true}).click();
    await page.waitForFunction(()=>trashed.length===2 && !document.querySelector('.kv-delete-modal'));
    assert.equal(await page.locator('.kv-card').count(),1);
    assert.ok(await page.evaluate(()=>trashed.every(item=>item.viaFileManager===true)));
    await page.evaluate(()=>deleteSettings.confirmDelete=false);
    await page.locator('.kv-card').click({modifiers:['Control']});
    await page.getByRole('button',{name:'ノートを削除',exact:true}).click();
    await page.waitForFunction(()=>trashed.length===3);
    assert.equal(await page.locator('.kv-delete-modal').count(),0,'Only explicit opt-out skips confirmation');
    await page.evaluate(()=>deleteController.dispose());
    assert.equal(await page.evaluate(()=>liveComponents),0,'Deletion previews release render components');
    await page.evaluate(()=>{
      const files=['Notes/one.md','Notes/two.md','Other/three.md'].map((path,i)=>({path,basename:path.split('/').pop().slice(0,-3),parent:{path:path.split('/')[0]},stat:{mtime:1,size:30,ctime:1},i}));
      const disk=new Map(),paths=new Map();window.indexNoteReads=0;window.indexWrites=0;
      window.indexStorage={read:async id=>disk.get(id)||null,paths:async id=>paths.get(id)||[],write:async(id,bytes,names)=>{indexWrites++;disk.set(id,bytes);paths.set(id,names);},clear:async()=>{disk.clear();paths.clear();},close(){}};
      window.indexApp={vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>{indexNoteReads++;return ['買い物 needle','別の本文','その他'][file.i];},adapter:{exists:async path=>disk.has(path),mkdir:async path=>disk.set(path,null),readBinary:async path=>disk.get(path),writeBinary:async(path,data)=>disk.set(path,data)}},metadataCache:{getFileCache:()=>({tags:[],frontmatter:{created:new Date().toISOString()}}),getFirstLinkpathDest:()=>null},workspace:{getLeaf:()=>({openFile(){}})}};
      window.indexSaved={textQuery:'needle'};
      window.mountIndexed=()=>{
        document.getElementById('view').empty();
        window.indexController=mountKeepView(indexApp,document.getElementById('view').createDiv(),indexSaved,state=>window.indexSaved=state,currentSettings,new SearchIndex(indexApp,'cache',{storage:indexStorage}));
      };
      mountIndexed();
    });
    assert.equal(await page.evaluate(()=>indexNoteReads),0,'Persisted search remains idle until requested');
    await search('needle');
    assert.equal(await page.locator('.kv-card').count(),1);
    await page.evaluate(()=>{indexController.dispose();mountIndexed();window.indexNoteReads=0;});
    await search('absent');
    assert.equal(await page.locator('.kv-card').count(),0);
    assert.equal(await page.evaluate(()=>indexNoteReads),0,'Reopened production index searches saved bodies without note reads');
    await search('買');
    assert.equal(await page.locator('.kv-card').count(),1);
    const writesBeforeRefresh=await page.evaluate(()=>indexWrites);
    await page.evaluate(()=>indexController.refresh(indexApp.vault.getMarkdownFiles()[0]));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>indexWrites),writesBeforeRefresh,'Note events do not update saved search bodies');
    await search('買');
    assert.ok(await page.evaluate(before=>indexWrites>before,writesBeforeRefresh),'An explicit repeat search commits invalidated bodies');
    await page.getByRole('button',{name:'ツリー表示',exact:true}).click();
    await page.addStyleTag({content:'body.is-mobile button { border: none; }'});
    await page.evaluate(()=>document.body.classList.add('is-mobile'));
    for(const width of [320,360,1200]) {
      await resize(page,{width,height:850});
      const folder=await page.locator('.kv-result-folder').evaluate(el=>{
        const style=getComputedStyle(el);return {border:style.borderTopWidth,borderStyle:style.borderTopStyle,background:style.backgroundColor,base:getComputedStyle(el.closest('.keep-view-root')).getPropertyValue('--kv-bg').trim()};
      });
      assert.equal(folder.border,'1px');assert.equal(folder.borderStyle,'solid');
      assert.equal(folder.background,'rgb(255, 255, 255)');
      if(width===360) await page.locator('.keep-view-root').screenshot({path:path.join(screenshots,'preview-tree-mobile.png')});
    }
    await page.evaluate(()=>indexController.dispose());
    for(const progressWidth of [1000,360,320]) {
    await resize(page,{width:progressWidth,height:850});
    await page.evaluate(()=>{
      window.advanceSearch=null;
      const files=['A/0.md','A/1.md','B/2.md','B/3.md','4.md','5.md'].map((path,i)=>({path,basename:String(i),parent:{path:path.includes('/')?path[0]:'/'},stat:{mtime:1,size:30,ctime:1},i}));
      const app={vault:{getName:()=> 'Progress test',getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>'needle 本文です。\n'.repeat(file.i+1)},metadataCache:{getFileCache:()=>({tags:[],frontmatter:{created:'2026-01-01T00:00:00Z'}}),getFirstLinkpathDest:()=>null},workspace:{getLeaf:()=>({openFile(){}})}};
      const controlledIndex={search:async(query,candidates,{onProgress,cancelled})=>{
        const matches=new Set(),settled=new Set();
        window.progressFiles=candidates.map(file=>file.path);
        window.advanceSearch=indices=>{for(const i of indices) {matches.add(candidates[i].path);settled.add(candidates[i].path);}onProgress(settled.size,candidates.length,{matches,settled});};
        await new Promise(resolve=>window.finishSearch=()=>{advanceSearch(candidates.map((_,i)=>i));resolve();});
        return {matches,errors:[],cancelled:cancelled()};
      },invalidate(){}};
      document.getElementById('view').empty();
      window.progressController=mountKeepView(app,document.getElementById('view').createDiv(),{textQuery:'needle',sortField:'name',sortOrder:'asc',resultTreeOpen:{A:true,B:true}},()=>{},currentSettings,controlledIndex);
    });
    await page.getByRole('button',{name:'全文検索',exact:true}).click();
    await page.getByRole('button',{name:'検索',exact:true}).click();
    await page.waitForFunction(()=>typeof advanceSearch==='function');
    await page.evaluate(()=>advanceSearch([5]));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.kv-card').count(),0,'A late hit waits for preceding candidates to settle');
    await page.evaluate(()=>advanceSearch([0,1]));
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===2);
    assert.equal(await page.getByRole('button',{name:'パス出力',exact:true}).isDisabled(),true);
    const partialPositions=await page.locator('.kv-card').evaluateAll(cards=>cards.map(card=>({path:card.dataset.path,left:card.style.left,top:card.style.top,y:card.getBoundingClientRect().top})));
    const statusTop=await page.locator('.kv-search-status-slot').evaluate(el=>el.getBoundingClientRect().top);
    const assertActionRow=async()=>{
      const layout=await page.evaluate(()=>{
        const row=document.querySelector('.kv-result-actions');
        const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};};
        return {status:rect(row.querySelector('.kv-search-status-slot')),left:rect(row.querySelector('.kv-collapse-all')||row.firstElementChild),right:rect(row.querySelector('.kv-output-actions')),row:rect(row),body:rect(document.querySelector('.kv-body-wrapper')),nextIsBody:row.nextElementSibling.matches('.kv-body-wrapper')};
      });
      assert.ok(layout.status.left>=layout.left.right && layout.status.right<=layout.right.left,'Search status stays between action buttons');
      assert.ok(layout.status.top>=layout.left.top && layout.status.bottom<=layout.left.bottom,'Search status fits the existing action row height');
      assert.equal(layout.row.height,layout.left.height+32,'Search status adds no extra row height');
      assert.ok(layout.nextIsBody && layout.body.top-layout.row.bottom<=4,'Cards immediately follow the action row without a separate status slot');
    };
    await assertActionRow();
    await page.evaluate(()=>{window.firstProgressCard=document.querySelector('.kv-card');advanceSearch([2,3]);});
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===4);
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(()=>document.querySelector('.kv-card')===firstProgressCard),true,'Progress appends without remounting cards');
    assert.equal(await page.locator('.kv-search-status-slot').evaluate(el=>el.getBoundingClientRect().top),statusTop);
    await assertActionRow();
    await page.screenshot({path:path.join(screenshots,`preview-search-status-${progressWidth}.png`)});
    await page.evaluate(()=>finishSearch());
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===6 && !document.querySelector('.kv-search-status'));
    assert.equal(await page.evaluate(()=>document.querySelector('.kv-card')===firstProgressCard),true,'Completion keeps the same cards mounted');
    assert.deepEqual(await page.locator('.kv-card').evaluateAll(cards=>cards.slice(0,2).map(card=>({path:card.dataset.path,left:card.style.left,top:card.style.top,y:card.getBoundingClientRect().top}))),partialPositions);
    await page.evaluate(()=>progressController.refresh());
    await page.waitForTimeout(250);
    assert.deepEqual(await page.locator('.kv-card').evaluateAll(cards=>cards.slice(0,2).map(card=>({path:card.dataset.path,left:card.style.left,top:card.style.top,y:card.getBoundingClientRect().top}))),partialPositions,'Incremental positions match an ordinary completed render');
    await page.evaluate(()=>{window.advanceSearch=null;});
    await page.getByRole('button',{name:'ツリー表示',exact:true}).click();
    await page.getByRole('button',{name:'全文検索',exact:true}).click();
    await page.getByRole('button',{name:'検索',exact:true}).click();
    await page.waitForFunction(()=>typeof advanceSearch==='function');
    await page.evaluate(()=>advanceSearch([0]));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.kv-result-folder').count(),0,'A partial tree branch waits until its folder is complete');
    await page.evaluate(()=>advanceSearch([1]));
    await page.waitForFunction(()=>document.querySelectorAll('.kv-result-folder').length===1 && document.querySelectorAll('.kv-card').length===2);
    const branchTop=await page.locator('.kv-result-branch').first().evaluate(el=>el.getBoundingClientRect().top);
    await assertActionRow();
    await page.evaluate(()=>{window.firstTreeCard=document.querySelector('.kv-card');advanceSearch([2,3]);});
    await page.waitForFunction(()=>document.querySelectorAll('.kv-result-folder').length===2);
    await page.evaluate(()=>finishSearch());
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===6 && !document.querySelector('.kv-search-status'));
    assert.equal(await page.evaluate(()=>document.querySelector('.kv-card')===firstTreeCard),true);
    assert.equal(await page.locator('.kv-result-branch').first().evaluate(el=>el.getBoundingClientRect().top),branchTop);
    await page.screenshot({path:path.join(screenshots,`preview-progressive-search-${progressWidth}.png`)});
    await page.evaluate(()=>{window.advanceSearch=null;});
    await page.getByRole('button',{name:'全文検索',exact:true}).click();
    await page.getByRole('button',{name:'検索',exact:true}).click();
    await page.waitForFunction(()=>typeof advanceSearch==='function');
    await page.evaluate(()=>{
      advanceSearch([0,1]);
      document.querySelector('[aria-label="全文検索"]').click();
      [...document.querySelectorAll('.kv-text-search-modal button')].find(button=>button.textContent==='クリア').click();
      finishSearch();
    });
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===6 && !document.querySelector('.kv-search-status-slot'));
    await page.waitForTimeout(100);
    const oldColumns=await page.locator('.kv-masonry').evaluateAll(grids=>grids.map(grid=>grid.dataset.columns));
    await resize(page,{width:progressWidth===1000?360:1000,height:850});
    await page.waitForTimeout(100);
    assert.notDeepEqual(await page.locator('.kv-masonry').evaluateAll(grids=>grids.map(grid=>grid.dataset.columns)),oldColumns,'Cancelled paints must not disconnect the replacement view layouts');
    await page.evaluate(()=>progressController.dispose());
    }
    await page.evaluate(()=>{
      document.body.classList.remove('is-mobile');
      const files=['root.md','Parent/a.md','Parent/Child/b.md','Parent/Other/c.md'].map(path=>({path,basename:path.split('/').pop(),parent:{path:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'/'},stat:{mtime:1,ctime:1,size:1}}));
      const app={vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async()=> '本文'},metadataCache:{getFileCache:()=>({tags:['#🧑🏽‍💻/café'],frontmatter:{}})},workspace:{getLeaf:()=>({openFile(){}})}};
      window.folderController=mountKeepView(app,document.getElementById('view').createDiv(),{},state=>window.folderState=state,currentSettings);
    });
    await page.getByRole('button',{name:'フォルダ',exact:true}).click();
    await page.getByRole('checkbox',{name:'すべて',exact:true}).check();
    await page.locator('.kv-dropdown-item').filter({has:page.getByRole('checkbox',{name:'Parent',exact:true})}).locator('.kv-dropdown-toggle').click();
    await page.getByRole('checkbox',{name:'Child',exact:true}).waitFor();
    const leaf=page.locator('.kv-dropdown-item').filter({has:page.getByRole('checkbox',{name:'Child',exact:true})});
    assert.equal(await leaf.locator('.kv-dropdown-toggle,[role=button]').count(),0,'Leaf folders have no disclosure control');
    assert.equal(await leaf.locator('.kv-dropdown-spacer').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
    await page.getByRole('checkbox',{name:'Child',exact:true}).uncheck();
    assert.deepEqual((await page.evaluate(()=>folderState.folderFilters)).sort(),['','Parent','Parent/Other']);
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===3);
    await page.getByRole('checkbox',{name:'すべて',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>folderState.folderFilters),[]);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===4);
    assert.equal(await page.locator('.kv-result-actions [data-icon="square-pen"]').count(),1);
    const corners=await page.locator('.kv-icon-btn,.kv-primary-tools select,.kv-segment').evaluateAll(els=>els.map(el=>getComputedStyle(el).borderRadius));
    assert.ok(corners.every(radius=>radius==='6px'));
    assert.equal(await page.locator('.kv-add-btn [data-icon="plus"]').count(),1);
    await page.evaluate(()=>folderController.dispose());
    await page.evaluate(()=>{window.cacheDeletes=0;window.cacheModal=new CacheDeleteModal(app,async()=>{cacheDeletes++;});cacheModal.open();});
    assert.equal(await page.evaluate(()=>cacheDeletes),0);
    await page.getByRole('button',{name:'キャンセル',exact:true}).click();
    assert.equal(await page.evaluate(()=>cacheDeletes),0);
    await page.evaluate(()=>cacheModal.open());
    await page.getByRole('button',{name:'削除する',exact:true}).click();
    await page.waitForFunction(()=>cacheDeletes===1 && !document.querySelector('.kv-cache-delete-modal'));
    await page.evaluate(()=>{
      window.migrationWrites=0;window.migrationProperties={};
      const file={basename:'2026-02-09T15_46_51.388+09_00',path:'Keep/2026-02-09T15_46_51.388+09_00.md'};
      const migrationApp={vault:{getMarkdownFiles:()=>[file]},metadataCache:{getFileCache:()=>({frontmatter:migrationProperties})},fileManager:{processFrontMatter:async(f,change)=>{migrationWrites++;change(migrationProperties);}}};
      window.migrationModal=new MigrationModal(migrationApp,'created');migrationModal.open();
    });
    await page.getByRole('textbox',{name:'日時プロパティ名',exact:true}).fill('imported');
    await page.getByRole('textbox',{name:'対象フォルダ',exact:true}).fill('Keep');
    await page.getByRole('button',{name:'対象を確認',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-migration-modal textarea')?.value.includes('ready'));
    assert.equal(await page.evaluate(()=>migrationWrites),0);
    await page.getByRole('button',{name:'確認した対象に適用',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-migration-modal textarea')?.value.includes('written'));
    assert.equal(await page.evaluate(()=>migrationProperties.imported),'2026-02-09T15:46:51.388+09:00');
    assert.equal(await page.evaluate(()=>migrationWrites),1);
    await page.evaluate(()=>migrationModal.close());
    const checkNotControls=async(language,width)=>{
      const assertAdd=async button=>{
        assert.equal(await button.textContent(),language==='ja'?'追加':'Add');
        const bounds=await button.evaluate(el=>{
          const s=getComputedStyle(el),r=el.getBoundingClientRect();
          return {width:r.width,height:r.height,padding:s.padding,radius:s.borderRadius,inside:[...el.children].every(child=>{const c=child.getBoundingClientRect();return c.left>=r.left && c.right<=r.right && c.top>=r.top && c.bottom<=r.bottom;})};
        });
        assert.deepEqual(bounds,{width:56,height:44,padding:'1px 4px',radius:'6px',inside:true},'Short Add label fits without changing the shared button shape');
      };
      await page.locator('.kv-add-btn').first().click();
      await page.locator('.kv-add-row .kv-node-type-not').click();
      const not=page.locator('.kv-tree-area .kv-node-not').first();
      const add=not.locator(':scope > .kv-add-row > .kv-add-btn');
      await assertAdd(add);
      assert.equal(await add.getAttribute('aria-label'),language==='ja'?'NOTの対象を追加':'Add NOT target');
      await page.locator('.kv-tree-area').screenshot({path:path.join(screenshots,`not-empty-${language}-${width}.png`)});
      await add.click();await not.locator(':scope > .kv-add-row .kv-node-type-tag').click();
      assert.equal(await add.count(),0,'A filled NOT has no extraneous disabled Add button');
      assert.equal(await page.locator('.kv-add-btn:disabled').count(),0);
      await page.locator('.kv-tree-area').screenshot({path:path.join(screenshots,`not-filled-${language}-${width}.png`)});
      await not.locator(':scope > .kv-node-tag > .kv-node-row > .is-remove').click();
      await assertAdd(add);
      await add.click();await not.locator(':scope > .kv-add-row .kv-node-type-and').click();
      assert.equal(await add.count(),0);
      await assertAdd(not.locator(':scope > .kv-node-and > .kv-add-row > .kv-add-btn'));
      await not.locator(':scope > .kv-node-row > .is-remove').click();
      // Exercise a saved root NOT directly, independently of the type popup.
      const mountRoot=async type=>page.evaluate(type=>{
        languageController.dispose();document.getElementById('view').empty();window.scrollTo(0,0);
        languageController=mountKeepView(app,document.getElementById('view').createDiv(),{groupByFolder:true,resultTreeOpen:{'仕事':true},searchTree:{type,id:'root',children:[]}},()=>{},currentSettings);
      },type);
      await mountRoot('not');
      const rootNot=page.locator('.kv-tree-area > .kv-node-not');
      const rootAdd=rootNot.locator(':scope > .kv-add-row > .kv-add-btn');
      await assertAdd(rootAdd);
      await rootAdd.click();await rootNot.locator(':scope > .kv-add-row .kv-node-type-tag').click();
      assert.equal(await rootAdd.count(),0,'Root NOT follows the same one-child behavior');
      await rootNot.locator(':scope > .kv-node-tag > .kv-node-row > .is-remove').click();
      await assertAdd(rootAdd);
      await mountRoot('and');
      await assertAdd(page.locator('.kv-add-btn').first());
    };
    for(const width of [1200,360,320]) {
      await resize(page,{width,height:850});
      await page.evaluate(width=>{
        require('./lib/i18n').setLanguage('en');document.body.classList.toggle('is-mobile',width<500);
        document.getElementById('view').empty();document.getElementById('view').scrollTop=0;window.scrollTo(0,0);
        window.languageController=mountKeepView(app,document.getElementById('view').createDiv(),{groupByFolder:true,resultTreeOpen:{'仕事':true}},()=>{},currentSettings);
      },width);
      await page.waitForFunction(()=>document.querySelector('.kv-card'));
      assert.equal(await page.locator('.keep-view-root[lang=en]:has(.kv-header)').count(),1);
      assert.deepEqual(await page.locator('.kv-segment').allTextContents(),['Created','Modified','Title']);
      assert.equal(await page.getByRole('combobox',{name:'Card density'}).inputValue(),'normal');
      assert.equal(await page.getByRole('combobox',{name:'Preview length'}).locator('option:checked').textContent(),'150 chars');
      const labelSizes=await page.locator('.kv-primary-tools select').evaluateAll(els=>els.map(el=>{
        const style=getComputedStyle(el),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;
        return {label:el.selectedOptions[0].textContent,required:Math.max(...[...el.options].map(option=>context.measureText(option.textContent).width))+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight),available:el.clientWidth,font:style.font};
      }));
      assert.ok(labelSizes.every(label=>label.required<=label.available),JSON.stringify({width,labelSizes}));
      assert.equal(await page.locator('.kv-segment').evaluateAll(els=>els.every(el=>getComputedStyle(el).fontWeight==='400')),true);
      const folderStyle=await page.locator('.kv-result-folder-heading').first().evaluate(el=>{
        const icon=el.querySelector('.kv-folder-create'),chevron=el.querySelector('.kv-dropdown-toggle svg');
        return {border:getComputedStyle(icon).borderWidth,iconWidth:icon.querySelector('svg').getBoundingClientRect().width,chevronWidth:chevron.getBoundingClientRect().width,countColor:getComputedStyle(el.querySelector('.kv-result-count')).color,summaryColor:getComputedStyle(document.querySelector('.kv-output-actions .kv-counter')).color};
      });
      assert.equal(folderStyle.border,'0px');assert.equal(folderStyle.iconWidth,18);assert.equal(folderStyle.chevronWidth,28);
      assert.equal(folderStyle.countColor,folderStyle.summaryColor);
      await page.locator('.kv-result-folder > .kv-dropdown-toggle').first().hover();
      assert.equal(await page.locator('.kv-result-folder > .kv-dropdown-toggle').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','Tree disclosure has no separate hover box');
      await page.mouse.move(0,0);
      assert.equal(await page.evaluate(()=>document.getElementById('view').scrollWidth>document.getElementById('view').clientWidth),false);
      await page.screenshot({path:path.join(screenshots,`preview-english-${width}.png`)});
      await page.getByRole('button',{name:'Folders',exact:true}).click();
      const folderMenu=await page.locator('.kv-dropdown').boundingBox();
      await page.getByRole('checkbox',{name:'All',exact:true}).click();
      await page.waitForTimeout(100);
      const checkedMenu=await page.locator('.kv-dropdown').boundingBox();
      assert.ok(Math.abs(folderMenu.x-checkedMenu.x)<1 && Math.abs(folderMenu.width-checkedMenu.width)<1,'Folder menu keeps a stable width and horizontal anchor when toggling filters');
      await page.getByRole('checkbox',{name:'All',exact:true}).click();await page.keyboard.press('Escape');
      assert.equal(await page.locator('.kv-output-actions [data-icon="log-out"]').count(),1);
      await page.locator('.kv-add-btn').first().click();
      const typeSizes=await page.locator('.kv-add-row .kv-node-type').evaluateAll(els=>els.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
      assert.equal(typeSizes.length,4);assert.ok(typeSizes.every(size=>size.width===typeSizes[0].width && size.height===typeSizes[0].height));
      assert.deepEqual(await page.locator('.kv-add-btn').first().evaluate(el=>{const s=getComputedStyle(el);return {width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,padding:s.padding,border:s.borderWidth,radius:s.borderRadius,font:s.fontSize,line:s.lineHeight};}),{width:56,height:44,padding:'1px 4px',border:'1px',radius:'6px',font:'11px',line:'normal'},'Tag Add has identical geometry on desktop and mobile');
      await page.locator('.kv-add-btn').first().click();
      await checkNotControls('en',width);
      const englishSizes=await page.locator('.kv-segment,.kv-primary-tools select').evaluateAll(els=>els.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
      const segmentWidths=await page.locator('.kv-segment').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width));
      assert.equal(new Set(segmentWidths).size,1,'All three sort segments have the same width');
      await page.evaluate(()=>{require('./lib/i18n').setLanguage('ja');languageController.refreshSettings();});
      await page.waitForFunction(()=>document.querySelector('.kv-header')?.closest('.keep-view-root').lang==='ja');
      assert.deepEqual(await page.locator('.kv-segment,.kv-primary-tools select').evaluateAll(els=>els.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))),englishSizes,'Japanese and English use identical control dimensions');
      assert.equal(await page.locator('.kv-preview-select').evaluate(el=>getComputedStyle(el).fontSize),'12px','Preview labels keep normal text size whenever they fit');
      await checkNotControls('ja',width);
      await page.screenshot({path:path.join(screenshots,`preview-japanese-${width}.png`)});
      await page.evaluate(()=>languageController.dispose());
    }
    for(const width of [1200,360]) {
    await resize(page,{width,height:850});
    await page.evaluate(width=>{
      require('./lib/i18n').setLanguage('ja');document.body.classList.toggle('is-mobile',width<500);document.getElementById('view').empty();window.scrollTo(0,0);
      window.largeTreeReads=0;
      const files=Array.from({length:3000},(_,i)=>{
        const folder='Folder'+String(Math.floor(i/30)).padStart(3,'0');
        return {path:folder+'/'+i+'.md',basename:String(i),parent:{path:folder},stat:{mtime:1,ctime:1,size:4}};
      });
      files.push(...Array.from({length:45},(_,i)=>({path:'Folder099/'+(3000+i)+'.md',basename:String(3000+i),parent:{path:'Folder099'},stat:{mtime:1,ctime:1,size:4}})));
      const app={vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async()=>{largeTreeReads++;return 'Preview body';}},metadataCache:{getFileCache:()=>({tags:[],frontmatter:{}})},workspace:{getLeaf:()=>({openFile(){}})}};
      window.largeTreeController=mountKeepView(app,document.getElementById('view').createDiv(),{groupByFolder:true},()=>{},currentSettings);
    },width);
    assert.equal(await page.evaluate(()=>largeTreeReads),0);
    await page.getByRole('button',{name:'すべて展開',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length>=30);
    assert.equal(await page.locator('.kv-result-folder[aria-expanded=true]').count(),100);
    assert.ok(await page.evaluate(()=>largeTreeReads<180),'Expanding 3,000 notes reads only folders near the viewport');
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(()=>largeTreeReads<300),'Ahead-of-scroll prefetch stays bounded instead of loading the whole tree');
    await page.locator('[data-folder=Folder099] > .kv-result-folder-heading').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-path="Folder099/2999.md"] .kv-card-preview')?.textContent.trim()==='Preview body');
    const more=page.locator('[data-folder=Folder099] .kv-folder-more > button');
    await more.click();
    await page.waitForFunction(()=>document.querySelector('[data-folder=Folder099] .kv-folder-more > button')?.textContent.includes('15'));
    assert.equal(await more.evaluate(el=>document.activeElement===el),false,'Show more releases focus after appending');
    assert.equal(await more.evaluate(el=>el.classList.contains('kv-hover-released')),true,'Show more releases hover after appending');
    assert.equal(await more.evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.kv-header').evaluate(el=>getComputedStyle(el).backgroundColor),'Pagination keeps the page background after tapping');
    await page.getByRole('button',{name:'すべて折りたたむ',exact:true}).click();
    assert.equal(await page.locator('.kv-card').count(),0);
    await page.waitForTimeout(100);
    const readsAfterCollapse=await page.evaluate(()=>largeTreeReads);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>largeTreeReads),readsAfterCollapse,'Collapsed folders do not keep loading queued previews');
    await page.evaluate(()=>largeTreeController.dispose());
    }
    await page.evaluate(()=>{
      document.getElementById('view').empty();document.getElementById('view').scrollTop=0;
      const file={path:'Parent/Child/note.md',basename:'note',parent:{path:'Parent/Child'},stat:{mtime:1,ctime:1,size:4}};
      const app={vault:{getMarkdownFiles:()=>[file],getAbstractFileByPath:path=>path===file.path?file:null,cachedRead:async()=> 'Body'},metadataCache:{getFileCache:()=>({tags:['#Project/Sub/Topic'],frontmatter:{tags:['Project/Sub/Topic']}})},workspace:{getLeaf:()=>({openFile(){}})}};
      window.nestedController=mountKeepView(app,document.getElementById('view').createDiv(),{},()=>{},currentSettings);
    });
    await page.locator('.kv-card-footer').dispatchEvent('pointerdown',{button:0,pointerId:1,clientX:20,clientY:20});await page.waitForTimeout(550);
    await page.locator('.kv-card-footer').dispatchEvent('pointerup',{button:0,pointerId:1});
    await page.getByRole('button',{name:'タグを編集',exact:true}).click();
    assert.equal(await page.getByRole('checkbox',{name:'Project/Sub/Topic',exact:true}).isVisible(),true,'Existing nested tags are revealed immediately');
    assert.ok(await page.locator('.kv-tag-count').evaluateAll(els=>els.every(el=>getComputedStyle(el).fontWeight==='400')));
    await page.getByRole('button',{name:'フォルダを移動',exact:true}).click();
    assert.equal(await page.locator('.kv-move-folder[data-destination="Parent/Child"]').isVisible(),true,'Current nested folders are revealed immediately');
    assert.equal(await page.locator('.kv-move-count').evaluate(el=>getComputedStyle(el).fontWeight),'400');
    await page.evaluate(()=>nestedController.dispose());
    await page.evaluate(samples=>{
      document.getElementById('view').empty();
      window.guideSamples=samples;window.guideWrites=0;window.guideSaved=null;window.guideShown=new Set();
      window.guideFiles=samples.map((sample,i)=>({path:sample.path,basename:sample.path.split('/').at(-1).slice(0,-3),parent:{path:sample.path.includes('/')?sample.path.split('/').slice(0,-1).join('/'):'/'},stat:{mtime:fixtureTime,ctime:fixtureTime,size:sample.content.length},i}));
      window.guideMetadata=Object.fromEntries(samples.map(sample=>[sample.path,{frontmatter:{...sample.frontmatter},tags:['#date-sample']}]));
      app.vault.getMarkdownFiles=()=>guideFiles;
      app.vault.getAbstractFileByPath=path=>guideFiles.find(file=>file.path===path);
      app.vault.cachedRead=async file=>{readCount++;return guideSamples.find(sample=>sample.path===file.path).content;};
      app.metadataCache.getFileCache=file=>guideMetadata[file.path];
      app.fileManager.processFrontMatter=async(file,edit)=>{guideWrites++;edit(guideMetadata[file.path].frontmatter);guideController.refresh(file);};
      window.guideSettings={...DEFAULT_SETTINGS,language:'ja'};
      require('./lib/i18n').setLanguage('ja');
      window.guideRoot=document.createElement('div');
      window.guideController=mountKeepView(app,guideRoot,{},()=>{},guideSettings,null,{dateGuidanceShown:guideShown,onHideDateGuidance:()=>window.guideSaved={...guideSettings}});
    },require('./date-guidance-fixture.cjs'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.kv-date-guidance-modal').count(),0,'No popup before the view is attached');
    assert.equal(await page.evaluate(()=>guideShown.size),0);
    await page.evaluate(()=>document.getElementById('view').appendChild(guideRoot));
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===7);
    assert.equal(await page.locator('.kv-date-guidance-modal').count(),0,'Fresh modification-time views do not prompt about creation properties');
    assert.equal(await page.evaluate(()=>guideShown.size),0);
    await page.getByRole('button',{name:'作成日時',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.kv-date-guidance-modal'));
    assert.match(await page.locator('.kv-date-guidance-modal').textContent(),/6 件/);
    assert.match(await page.locator('.kv-date-guidance-modal').textContent(),/未設定 3 件・空欄または無効 3 件/);
    assert.match(await page.locator('.kv-date-guidance-modal').textContent(),/未設定ノートが 1 件/);
    assert.equal(await page.evaluate(()=>guideWrites),0,'Guidance only reads existing metadata and filenames');
    await page.locator('.kv-date-guidance-modal').getByRole('button',{name:'閉じる',exact:true}).click();
    const creationFallbackDay=await page.evaluate(()=>{const d=new Date(fixtureTime);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');});
    await page.getByLabel('開始日',{exact:true}).fill(creationFallbackDay);
    await page.getByLabel('終了日',{exact:true}).fill(creationFallbackDay);
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===6);
    assert.equal(await page.evaluate(()=>guideWrites),0,'Date filtering uses file creation time without writing properties');
    await page.getByRole('button',{name:'期間を解除',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===7);
    await page.evaluate(()=>guideController.refreshSettings());await page.waitForTimeout(250);
    assert.equal(await page.locator('.kv-date-guidance-modal').count(),0,'A normal dismissal does not repeat during this session');
    await page.evaluate(()=>{
      guideController.dispose();document.getElementById('view').empty();
      window.guideController=mountKeepView(app,document.getElementById('view').createDiv(),{sortField:'property',dateField:'property'},()=>{},guideSettings,null,{dateGuidanceShown:guideShown});
    });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.kv-date-guidance-modal').count(),0,'Another view shares the already-shown session state');
    await page.evaluate(()=>{
      guideController.dispose();document.getElementById('view').empty();guideShown.clear();
      window.guideController=mountKeepView(app,document.getElementById('view').createDiv(),{sortField:'property',dateField:'property'},()=>{},guideSettings,null,{dateGuidanceShown:guideShown,onHideDateGuidance:()=>window.guideSaved={...guideSettings}});
    });
    await page.waitForFunction(()=>document.querySelector('.kv-date-guidance-modal'));
    await page.locator('.kv-date-guidance-modal').getByRole('button',{name:'移行ツールを開く',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'確認した対象に適用',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'対象を確認',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.kv-migration-modal button').disabled);
    const migrationPreview=JSON.parse(await page.getByRole('textbox',{name:'日時の変換結果',exact:true}).inputValue());
    assert.equal(migrationPreview.rows.filter(row=>row.status==='ready').length,1);
    assert.equal(await page.evaluate(()=>guideWrites),0,'Migration preview still does not write');
    await page.getByRole('button',{name:'確認した対象に適用',exact:true}).click();
    await page.waitForFunction(()=>guideWrites===1);
    assert.equal(await page.evaluate(()=>guideMetadata['Preserved/2026-02-10T08_00_00.000Z.md'].frontmatter.created),null,'Existing empty dates are preserved');
    await page.evaluate(()=>{lastOpenedModal.close();guideShown.clear();guideController.refreshSettings();});
    await page.waitForFunction(()=>document.querySelector('.kv-date-guidance-modal')?.textContent.includes('5 件'));
    await page.getByRole('checkbox',{name:'今後表示しない',exact:true}).check();
    assert.equal(await page.evaluate(()=>guideSettings.showDateGuidance),true,'The opt-out is saved on closing');
    await page.locator('.kv-date-guidance-modal').getByRole('button',{name:'閉じる',exact:true}).click();
    assert.equal(await page.evaluate(()=>guideSaved.showDateGuidance),false);
    await page.evaluate(()=>{
      guideController.dispose();document.getElementById('view').empty();
      window.guideSettings=require('./lib/saved-data').readSettings(guideSaved,DEFAULT_SETTINGS);
      window.guideController=mountKeepView(app,document.getElementById('view').createDiv(),{sortField:'property',dateField:'property'},()=>{},guideSettings);
    });
    await page.waitForFunction(()=>document.querySelectorAll('.kv-card').length===7);await page.waitForTimeout(200);
    assert.equal(await page.locator('.kv-date-guidance-modal').count(),0,'Opt-out persists across a settings round-trip and new session');
    await page.evaluate(()=>{guideSettings.showDateGuidance=true;guideController.refreshSettings();});
    await page.waitForFunction(()=>document.querySelector('.kv-date-guidance-modal'));
    await page.evaluate(()=>guideController.dispose());
    const hoverPage=await browser.newPage({viewport:{width:1200,height:850}});
    await hoverPage.setContent('<style>:root{--background-primary:#fff;--background-secondary:#f7f7f8;--background-modifier-border:#ddd;--text-normal:#222;--text-muted:#666;--interactive-accent:#6958c7}button:hover{box-shadow:0 5px 10px red;transform:translateY(-2px)}</style><div class="keep-view-root"><div class="kv-controls"><button class="kv-segment is-active">Selected</button><button class="kv-segment">Unselected</button></div><button class="kv-btn">Clear</button><button class="kv-btn kv-icon-btn is-active">Tree</button><button class="kv-add-btn kv-btn">Add</button><button class="kv-load-more-btn">More</button><button class="kv-result-folder">Folder</button><select><option>150 chars</option></select><div class="kv-dropdown-item" role="button">Dropdown</div><button class="kv-node-type kv-node-type-and">AND</button><div class="kv-card">Card</div></div><div class="kv-settings"><button>Reset</button></div><div class="kv-text-search-modal"><button>Search</button></div>');
    await hoverPage.addStyleTag({content:fs.readFileSync(path.join(root,'styles.css'),'utf8')});
    const inactiveColor=async()=>hoverPage.locator('.kv-segment:not(.is-active)').evaluate(el=>getComputedStyle(el).backgroundColor);
    await hoverPage.locator('.kv-segment:not(.is-active)').hover();const mutedHoverColor=await inactiveColor();
    for(const control of await hoverPage.locator('button:not(.kv-segment):not(.kv-add-btn):not(.is-active):not(.kv-node-type):not(.kv-settings *),select,[role=button]').all()) {
      assert.equal(await control.evaluate(el=>getComputedStyle(el).boxShadow),'none','Controls never have shadows at rest');
      await control.hover();
      const style=await control.evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,shadow:s.boxShadow,transform:s.transform,transition:s.transitionDuration};});
      assert.deepEqual({shadow:style.shadow,transform:style.transform,transition:style.transition},{shadow:'none',transform:'none',transition:'0s'},'Controls stay still without shadow');
      if(await control.evaluate(el=>!!el.closest('.kv-text-search-modal'))) assert.equal(style.background,mutedHoverColor);
      else assert.equal(style.background,'rgb(247, 247, 248)');
    }
    await hoverPage.mouse.move(0,0);
    const selectedHoverControl=hoverPage.locator('.kv-segment.is-active'),inactive=hoverPage.locator('.kv-segment:not(.is-active)');
    const selectedHoverBackground=await selectedHoverControl.evaluate(el=>getComputedStyle(el).backgroundColor);
    await selectedHoverControl.hover();assert.equal(await selectedHoverControl.evaluate(el=>getComputedStyle(el).backgroundColor),selectedHoverBackground);
    assert.equal(await selectedHoverControl.evaluate(el=>getComputedStyle(el).boxShadow),'none');
    await inactive.hover();assert.notEqual(await inactive.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(247, 247, 248)');
    const moreControl=hoverPage.locator('.kv-load-more-btn');await moreControl.hover();
    await moreControl.evaluate(el=>el.classList.add('kv-hover-released'));
    assert.equal(await moreControl.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    const addControl=hoverPage.locator('.kv-add-btn');await hoverPage.mouse.move(0,0);
    const addBackground=await addControl.evaluate(el=>getComputedStyle(el).backgroundColor);
    await addControl.hover();await hoverPage.waitForTimeout(220);
    assert.equal(await addControl.evaluate(el=>getComputedStyle(el).backgroundColor),addBackground);
    assert.notEqual(await addControl.evaluate(el=>getComputedStyle(el).boxShadow),'none');
    assert.equal(await addControl.evaluate(el=>getComputedStyle(el).transform),'none');
    const coloredControl=hoverPage.locator('.kv-btn.is-active');await hoverPage.mouse.move(0,0);
    const coloredBefore=await coloredControl.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
    await coloredControl.hover();const coloredAfter=await coloredControl.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
    assert.notEqual(coloredAfter.bg,coloredBefore.bg);assert.notEqual(coloredAfter.bg,'rgb(247, 247, 248)');assert.equal(coloredAfter.color,coloredBefore.color);
    await hoverPage.evaluate(()=>{const popup=document.createElement('div');popup.className='keep-view-root kv-dropdown';for(const cls of ['kv-dropdown-item','kv-dropdown-item is-selected']){const row=document.createElement('div');row.className=cls;const check=document.createElement('input');check.type='checkbox';check.checked=true;check.className='kv-dropdown-checkbox';const wrapper=document.createElement('span');wrapper.className='kv-checkbox-control';const mark=document.createElement('span');mark.className='kv-checkbox-mark';wrapper.append(check,mark);row.append(wrapper);popup.append(row);}document.body.append(popup);});
    await hoverPage.addStyleTag({content:'.kv-dropdown-item:not(.is-selected) input::after{display:none;transform-origin:0 0;margin:3px;padding:2px} .kv-dropdown-item:not(.is-selected) input{max-width:12px;padding:2px}'});
    const checkGeometry=await hoverPage.locator('.kv-dropdown-checkbox').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el.parentElement.querySelector('.kv-checkbox-mark'));return {box:[el.getBoundingClientRect().width,el.getBoundingClientRect().height],mark:[s.display,s.width,s.height,s.top,s.left,s.margin,s.padding,s.transform,s.transformOrigin]};}));
    assert.deepEqual(checkGeometry[0],checkGeometry[1],'Shared checkbox geometry survives parent selection and theme rules');
    await hoverPage.close();

    await resize(page,{width:1200,height:850});
    await page.evaluate(()=>{
      controller.dispose();document.body.replaceChildren();
      const host=document.body.createDiv({cls:'keep-view-content'});host.style.height='810px';
      window.dragSaved={};
      window.controller=mountKeepView(app,host,{
        searchTree:{type:'and',id:'root',children:[{type:'tag',id:'drag-a',tag:'a'},{type:'tag',id:'drag-b',tag:'b'}]}
      },state=>window.dragSaved=state,{...DEFAULT_SETTINGS,showDateGuidance:false});
    });
    const dragHandle=await page.locator('.kv-drag-handle').nth(1).boundingBox();
    const dropLine=await page.locator('.kv-tree-area > .kv-node > .kv-drop-line').first().boundingBox();
    await page.mouse.move(dragHandle.x+dragHandle.width/2,dragHandle.y+dragHandle.height/2);
    await page.mouse.down();await page.mouse.move(dropLine.x+dropLine.width/2,dropLine.y+dropLine.height/2,{steps:8});
    assert.equal(await page.locator('.kv-drop-line.is-visible').count(),1,'Tag drag highlights the nearest insertion target');
    await page.mouse.up();await page.waitForFunction(()=>dragSaved.searchTree.children[0].id==='drag-b');
    assert.equal(await page.locator('.kv-drag-ghost').count(),0);assert.equal(await page.locator('.kv-node-row.is-dragging').count(),0);

    await page.evaluate(()=>{
      document.body.replaceChildren();
      const section=document.createElement('div');
      section.style.cssText='display:flex;gap:28px;align-items:center;padding:24px;background:#fff;color:#555;width:max-content';
      section.id='icon-preview';
      for(const size of [24,32,100]) {
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));
        svg.innerHTML=KEEP_VIEW_ICON_SVG;section.appendChild(svg);
      }
      document.body.appendChild(section);
    });
    await page.locator('#icon-preview').screenshot({path:path.join(screenshots,'icon-preview.png')});
    assert.deepEqual(errors,[]);
    console.log('Browser smoke test passed: sticky selection, draft/commit undo and redo, partial tags, responsive toolbar, equal gaps, scrollbar, search, tree, export and cleanup.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
