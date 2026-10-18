const assert=require('node:assert/strict');
const path=require('node:path');
const esbuild=require('esbuild');

async function testSearchStorage(browser) {
  const context=await browser.newContext();
  await context.route('http://keep-view.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Search cache fixture</title>'}));
  const page=await context.newPage();
  try {
    await page.goto('http://keep-view.test/');
    for(const [entry,globalName] of [['search-storage','CacheStorageSource'],['search-index','CacheIndexSource'],['card-search','CacheSearchSource']]) {
      const output=esbuild.buildSync({entryPoints:[path.join(__dirname,'../lib',entry+'.ts')],bundle:true,write:false,format:'iife',globalName,platform:'browser',target:'es2022'});
      await page.addScriptTag({content:output.outputFiles[0].text});
    }
    const result=await page.evaluate(async()=>{
      const check=(condition,message)=>{if(!condition) throw Error(message);};
      const sentinel=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('omnisearch/cache/synthetic-other-vault',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('sentinel');
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      await new Promise((resolve,reject)=>{const tx=sentinel.transaction('sentinel','readwrite');tx.objectStore('sentinel').put('keep','value');tx.oncomplete=resolve;tx.onabort=reject;});
      const localA=new Map(),localB=new Map(),legacy=new Map([['cache/0.gz','old'],['cache/bucket-1.gz','old'],['cache/data.json','settings']]);
      const sources=['買い物 😀 [x] a b','other'];
      const files=sources.map((text,i)=>({i,path:`${i}.md`,basename:`note${i}`,stat:{mtime:1,size:text.length}}));
      let legacyWrites=0,noteReads=0;
      const makeApp=local=>({
        loadLocalStorage:key=>local.get(key)||null,saveLocalStorage:(key,value)=>local.set(key,value),
        vault:{getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>{noteReads++;return sources[file.i];},
          adapter:{exists:async path=>legacy.has(path)||[...legacy.keys()].some(key=>key.startsWith(path+'/')),list:async path=>({files:[...legacy.keys()].filter(key=>key.startsWith(path+'/')),folders:[]}),remove:async path=>legacy.delete(path),writeBinary:async()=>{legacyWrites++;}}}
      });
      const app=makeApp(localA),storage=new CacheStorageSource.IndexedDBSearchStorage(app);
      const index=new CacheIndexSource.SearchIndex(app,'cache',{storage,yieldTask:async()=>{}});
      const engine=new CacheSearchSource.CardSearch(app,{index});
      check(localA.size===0,'Constructing the plugin must not allocate a namespace');
      await engine.search('買',files);
      check(localA.size===0 && legacy.has('cache/0.gz'),'Passive search must not open or clean the cache');
      check((await engine.search('買',files,{updateCache:true})).matches.has('0.md'),'Explicit search must find Japanese text');
      check(legacy.size===1 && legacy.has('cache/data.json'),'Only recognized legacy files may be deleted');
      check(legacyWrites===0,'No cache files may be written to the vault');
      const names=(await indexedDB.databases()).map(db=>db.name);
      const nameA=names.find(name=>name.startsWith('keep-view/search-cache/'));
      check(/^keep-view\/search-cache\/[a-f0-9]{32}$/.test(nameA),'Database name must use an opaque identifier');
      const id=CacheIndexSource.bucketFor('0.md');
      const bytes=await storage.read(id);
      const sameStore=new CacheStorageSource.IndexedDBSearchStorage(app);
      check((await sameStore.read(id)).byteLength===bytes.byteLength,'Reopening must reuse the namespace and committed data');
      sameStore.close();
      const other=new CacheStorageSource.IndexedDBSearchStorage(makeApp(localB));
      check(await other.read(id)===null,'Different vaults must not share cache content');
      const saved=noteReads;await index.search('😀',files);check(noteReads===saved,'Unchanged notes must be restored from IndexedDB');
      sources[0]='different';files[0].stat.mtime++;engine.invalidate('0.md');
      await engine.search('different',files);
      check((await storage.read(id)).every((byte,i)=>byte===bytes[i]),'Editing and passive searching must leave stored content unchanged');
      await engine.search('different',files,{updateCache:true});
      check(!(await storage.read(id)).every((byte,i)=>byte===bytes[i]),'An explicit search must update modified text');
      // Abort after requests have been queued; no partial content/path update may commit.
      const originalTransaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(...args){const tx=originalTransaction.apply(this,args);if(args[1]==='readwrite') queueMicrotask(()=>tx.abort());return tx;};
      let aborted=false;
      try {await storage.write(7,new Uint8Array([1,2,3]),['abort.md']);} catch {aborted=true;}
      finally {IDBDatabase.prototype.transaction=originalTransaction;}
      check(aborted && (await storage.paths(7)).every(path=>path!=='abort.md'),'Aborted transactions must reject and roll back both stores');
      let capacity=false;try {await storage.write(0,new Uint8Array(8*1024*1024+1),[]);} catch {capacity=true;}
      check(capacity,'Oversized cache buckets must not be persisted');
      const removedPath=files[0].path;files.shift();
      await index.search('other',files);
      check(!(await storage.paths(id)).includes(removedPath),'Deleted paths must be pruned outside the candidate set');
      await index.clear();
      check(await storage.read(id)===null && (await storage.paths(id)).length===0,'Clearing must remove bodies and path metadata');
      await engine.search('other',files);
      check(await storage.read(id)===null,'Passive searches must not rebuild a cleared cache');
      const sentinelValue=await new Promise((resolve,reject)=>{const request=sentinel.transaction('sentinel').objectStore('sentinel').get('value');request.onsuccess=()=>resolve(request.result);request.onerror=reject;});
      check(sentinelValue==='keep','Omnisearch databases must remain untouched');
      index.close();other.close();sentinel.close();
      // A blocked storage API must still return source-note matches.
      const nativeIndexedDB=indexedDB;
      Object.defineProperty(window,'indexedDB',{configurable:true,value:{open(){throw new DOMException('denied','SecurityError');}}});
      try {
        const fallback=new CacheIndexSource.SearchIndex(app,'cache',{yieldTask:async()=>{}});
        const result=await fallback.search('other',files);
        check(result.storageError && result.matches.size===1 && legacyWrites===0,'Storage failure must preserve search without a vault-file fallback');
        fallback.close();
      } finally {Object.defineProperty(window,'indexedDB',{configurable:true,value:nativeIndexedDB});}
      return {vaultIsolation:true,omnisearchUntouched:true,lazy:true,explicitWritesOnly:true,atomicRollback:true,capacity:true,legacyCleanup:true,deletedPathsPruned:true,clearDoesNotRebuild:true,storageFailureFallback:true};
    });
    assert.ok(Object.values(result).every(Boolean));
    console.log('Real IndexedDB checks passed: '+Object.keys(result).join(', '));
  } finally {await context.close();}
}
module.exports={testSearchStorage};
