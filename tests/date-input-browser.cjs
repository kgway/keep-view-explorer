const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

async function dateInputBoxes(page) {
  const session=await page.context().newCDPSession(page);
  try {
    const {root}=await session.send('DOM.getDocument',{depth:-1,pierce:true});
    const inputs=[];
    function walk(node) {
      const attrs=Object.fromEntries((node.attributes||[]).reduce((rows,value,i,values)=>i%2?rows:[...rows,[value,values[i+1]]],[]));
      if(node.nodeName==='INPUT' && ['date','datetime-local'].includes(attrs.type) && attrs['data-test']) inputs.push({node,label:attrs['data-test']});
      for(const child of [...node.children||[],...node.shadowRoots||[]]) walk(child);
    }
    walk(root);
    const boxes=[];
    for(const {node,label} of inputs) {
      const parts={};
      async function collect(child) {
        const attrs=child.attributes||[],pseudo=attrs[attrs.indexOf('pseudo')+1];
        if(['-webkit-datetime-edit-fields-wrapper','-webkit-calendar-picker-indicator'].includes(pseudo)) {
          try {
            const {model}=await session.send('DOM.getBoxModel',{nodeId:child.nodeId});
            parts[pseudo]={left:Math.min(...model.content.filter((_,i)=>i%2===0)),right:Math.max(...model.content.filter((_,i)=>i%2===0))};
          } catch(error) {
            if(pseudo!=='-webkit-calendar-picker-indicator'||!String(error).includes('Could not compute box model'))throw error;
            parts[pseudo]=null;
          }
        }
        for(const nested of [...child.children||[],...child.shadowRoots||[]]) await collect(nested);
      }
      await collect(node);
      boxes.push({label,...parts});
    }
    return boxes;
  } finally {await session.detach();}
}

async function testDateInputs(browser) {
  const records=[];
  const pluginCss=fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');
  const snippetCss=process.env.KEEP_VIEW_DATE_SNIPPET?fs.readFileSync(process.env.KEEP_VIEW_DATE_SNIPPET,'utf8'):null;
  function checkGap(box,label) {
    const text=box['-webkit-datetime-edit-fields-wrapper'],icon=box['-webkit-calendar-picker-indicator'];
    assert.ok(text && icon,'The native date text and picker must remain visible');
    assert.ok(Math.abs(text.left-icon.right-8)<0.5,'Expected the standard 8px property-label gap: '+JSON.stringify({label,box}));
  }
  for(const locale of ['en-US','ja-JP']) {
    const context=await browser.newContext({locale,hasTouch:true});
    const page=await context.newPage();
    try {
      for(const width of [320,360,390,420,740,1200]) for(const filled of [false,true]) {
        await page.setViewportSize({width,height:360});
        await page.setContent(`<body class="is-mobile is-android"><div class="keep-view-content"><div class="keep-view-root"><div class="kv-controls"><div class="kv-toolbar"><div class="kv-date-range"><input class="kv-input" type="date" data-test="from" aria-label="Start" value="${filled?'2026-10-17':''}"><span>–</span><input class="kv-input" type="date" data-test="to" aria-label="End" value="${filled?'2026-12-31':''}"><button>×</button></div></div></div></div></div><input type="date" id="unrelated" value="2026-10-17">`);
        // Reproduce the host's absolute calendar icon without its desktop-only
        // leading padding. Android WebView now exposes this native indicator.
        await page.addStyleTag({content:':root{--icon-size:18px;--size-4-1:4px;--background-primary:#fff;--text-normal:#222}body{margin:0;font-family:sans-serif}input[type=date]{position:relative;padding:3px}input[type=date]::-webkit-calendar-picker-indicator{position:absolute;left:4px;right:auto}button{box-sizing:border-box}'});
        await page.addStyleTag({content:fs.readFileSync(process.env.KEEP_VIEW_DATE_CSS||path.join(__dirname,'../styles.css'),'utf8')});
        const boxes=await dateInputBoxes(page);
        assert.equal(boxes.length,2);
        for(const box of boxes) {
          checkGap(box,{locale,width,filled});
        }
        assert.equal(await page.locator('#unrelated').evaluate(el=>getComputedStyle(el).paddingLeft),'3px','Other Obsidian date inputs keep their own styles');
        await page.getByLabel('Start',{exact:true}).fill('2026-10-20');
        assert.equal(await page.getByLabel('Start',{exact:true}).inputValue(),'2026-10-20');
        records.push({locale,width,filled,boxes});
      }
      for(const type of ['date','datetime-local']) for(const width of [320,360,390,420,740,1200]) for(const filled of [false,true]) for(const fontSize of [16,24]) {
        await page.setViewportSize({width,height:240});
        const value=filled?(type==='date'?'2026-10-17':'2026-10-17T14:30'):'';
        await page.setContent(`<body class="is-mobile is-android"><input class="metadata-input-text" type="${type}" data-test="property" value="${value}"></body>`);
        await page.addStyleTag({content:':root{--icon-size:18px;--size-4-2:8px}body{margin:0}input{position:relative;box-sizing:border-box;width:100%;padding:3px;font-size:'+fontSize+'px}input::-webkit-calendar-picker-indicator{position:absolute;left:4px;right:auto}'});
        await page.addStyleTag({content:pluginCss});
        const before=(await dateInputBoxes(page))[0];
        assert.ok(before['-webkit-calendar-picker-indicator'].right>before['-webkit-datetime-edit-fields-wrapper'].left,'The plugin must not alter native note properties globally');
        if(!snippetCss)continue;
        await page.addStyleTag({content:snippetCss});
        const box=(await dateInputBoxes(page))[0];
        checkGap(box,{locale,width,filled,type,fontSize,propertySnippet:true});
        records.push({locale,width,filled,type,fontSize,propertySnippet:true,boxes:[box]});
      }
      // The standalone snippet must also repair old plugin inputs and generic
      // native controls. A simulated host fix must not add another icon slot.
      for(const type of ['date','datetime-local']) for(const fontSize of [12,16,24]) for(const hostFixed of [false,true]) {
        await page.setContent(`<body class="is-android"><div class="kv-controls"><div class="kv-date-range"><input class="kv-input" type="${type}" data-test="old-plugin" value="${type==='date'?'2026-10-17':'2026-10-17T14:30'}"></div></div><input type="${type}" ${snippetCss?'data-test="generic"':''}><input id="disabled" type="${type}" disabled><input id="readonly" type="${type}" readonly></body>`);
        await page.addStyleTag({content:`:root{--size-4-1:4px;--size-4-2:8px}input{position:relative;padding:3px;font-size:${fontSize}px}input::-webkit-calendar-picker-indicator{position:absolute;left:4px;right:auto}.kv-controls .kv-date-range input[type=date]{padding:5px 3px}${hostFixed?'body.is-android input[type=date],body.is-android input[type=datetime-local]{padding-inline-start:48px}body.is-android input::-webkit-calendar-picker-indicator{left:auto;right:4px}':''}`});
        if(snippetCss)await page.addStyleTag({content:snippetCss});
        const oldBoxes=await dateInputBoxes(page);
        if(snippetCss)for(const box of oldBoxes)checkGap(box,{locale,type,fontSize,hostFixed,standalone:true});
        assert.deepEqual(await page.locator('#disabled,#readonly').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).paddingLeft)),hostFixed?['48px','48px']:['3px','3px'],'Disabled and read-only controls retain their host padding');
        // Keep View uses date inputs; the datetime case is for snippet coverage.
        if(!snippetCss && type!=='date')continue;
        await page.addStyleTag({content:pluginCss});
        const bothBoxes=await dateInputBoxes(page);
        for(const box of bothBoxes) checkGap(box,{locale,type,fontSize,hostFixed,combined:true});
        records.push({locale,type,fontSize,hostFixed,standaloneAndCombined:true,boxes:bothBoxes});
      }
      for(const platform of ['is-ios','is-desktop']) {
        await page.setContent(`<body class="${platform}"><input type="date" style="padding:3px"><input type="datetime-local" style="padding:3px"></body>`);
        await page.addStyleTag({content:snippetCss||pluginCss});
        assert.deepEqual(await page.locator('input').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).paddingLeft)),['3px','3px'],'The snippet is Android only');
      }
      for(const mode of ['flow','hidden','right'])for(const order of ['none','before','after'])for(const fontSize of [12,24]) {
        await page.setContent('<body class="is-android"><div class="kv-controls"><div class="kv-date-range"><input type="date" data-test="standard" value="2026-10-18"></div></div></body>');
        await page.addStyleTag({content:`input{box-sizing:border-box;width:100%;position:relative;padding:3px}input::-webkit-calendar-picker-indicator{position:${mode==='flow'?'static':'absolute'};left:${mode==='right'?'auto':'4px'};right:${mode==='right'?'4px':'auto'};${mode==='hidden'?'display:none':''}}`});
        const legacySnippet='body.is-android input[type=date]:not(:disabled):not([readonly]){padding-inline-start:calc(4px + 1em + 8px)}body.is-android input[type=date]:not(:disabled):not([readonly])::-webkit-calendar-picker-indicator{position:absolute;left:4px;right:auto;width:1em;height:1em;margin:0;padding:0}';
        const optional=snippetCss||legacySnippet;
        if(order==='before')await page.addStyleTag({content:optional});
        await page.addStyleTag({content:pluginCss});
        if(order==='after')await page.addStyleTag({content:optional});
        await page.locator('[data-test]').evaluate((el,size)=>el.style.fontSize=size+'px',fontSize);
        const box=(await dateInputBoxes(page))[0];
        if(mode==='hidden') {
          assert.equal(box['-webkit-calendar-picker-indicator'],null);
          const bounds=await page.locator('[data-test]').boundingBox();
          assert.ok(box['-webkit-datetime-edit-fields-wrapper'].left-bounds.x<10,'A hidden indicator leaves no reserved icon slot');
        } else checkGap(box,{mode,order,fontSize});
        records.push({locale,mode,order,fontSize,standardPlugin:true,boxes:[box]});
      }
    } finally {await context.close();}
  }
  if(process.env.KEEP_VIEW_DATE_REPORT) fs.writeFileSync(process.env.KEEP_VIEW_DATE_REPORT,JSON.stringify(records,null,2)+'\n');
  console.log('Native Android date-input layout checks passed in '+records.length+' locale/width/value combinations.');
}
module.exports={testDateInputs,dateInputBoxes};
