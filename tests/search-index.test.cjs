const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SearchIndex,bucketFor}=require('./load-source.cjs').loadSource('../lib/search-index');
const {CardSearch}=require('./load-source.cjs').loadSource('../lib/card-search');
const {decodeBucket}=require('./load-source.cjs').loadSource('../lib/search-codec');

function fixture(texts) {
  const files=texts.map((text,i)=>({path:`${i}.md`,basename:`note${i}`,stat:{mtime:1,size:text.length}}));
  const disk=new Map(),metadata=new Map(),legacy=new Map(),reads=[],writes=[],loads=[],removed=[];
  const storage={
    read:async id=>{loads.push(id);return disk.get(id)||null;},
    paths:async id=>metadata.get(id)||[],
    write:async(id,bytes,paths)=>{writes.push(id);disk.set(id,bytes.slice());metadata.set(id,[...paths]);},
    clear:async()=>{disk.clear();metadata.clear();},close(){}
  };
  const adapter={exists:async path=>legacy.has(path)||[...legacy.keys()].some(key=>key.startsWith(path+'/')),list:async path=>({files:[...legacy.keys()].filter(key=>key.startsWith(path+'/')),folders:[]}),remove:async path=>{removed.push(path);legacy.delete(path);},writeBinary:async()=>{throw Error('Vault cache writes are forbidden');}};
  const app={vault:{adapter,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>{reads.push(file.path);return texts[files.indexOf(file)];}}};
  const open=options=>new SearchIndex(app,'cache',{yieldTask:async()=>{},storage,...options});
  return {app,files,texts,disk,metadata,legacy,reads,writes,loads,removed,storage,open};
}

test('persisted index is lazy and supports literal Japanese, punctuation, NFC and unchanged cache reuse',async()=>{
  const f=fixture(['買い物メモ [x] a b','cafe\u0301 😀','---\ncreated: today\n---\n本文']);
  let index=f.open();assert.equal(f.disk.size,0);assert.equal(f.reads.length,0);
  await index.search('買',f.files);assert.equal(f.reads.length,3);
  f.reads.length=f.writes.length=0;index=f.open();
  const engine=new CardSearch(f.app,{index});
  for(const [query,expected] of [['買',[0]],['い物',[0]],['[x]',[0]],['a b',[0]],['CAFÉ',[1]],['😀',[1]],['created',[2]],['note2',[2]],['absent',[]]]) {
    assert.deepEqual([...(await engine.search(query,f.files,{updateCache:true})).matches].sort(),expected.map(i=>`${i}.md`));
  }
  assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
});

test('passive searches and invalidation never open, update or clean persistent storage',async()=>{
  const f=fixture(['hit','miss']),index=f.open(),engine=new CardSearch(f.app,{index});
  f.legacy.set('cache/0.gz','old');
  await engine.search('hit',f.files);
  assert.equal(f.disk.size,0);assert.equal(f.loads.length,0);assert.equal(f.removed.length,0);
  await engine.search('hit',f.files,{updateCache:true});
  const before=f.writes.length;f.texts[0]='new';engine.invalidate('0.md');
  assert.equal((await engine.search('new',f.files)).matches.size,1);
  assert.equal(f.writes.length,before);
  assert.equal((await decodeBucket(f.disk.get(bucketFor('0.md')))).entries.find(([path])=>path==='0.md')[1].text,'hit');
  await engine.search('new',f.files,{updateCache:true});
  assert.ok(f.writes.length>before);
});

test('only candidates are indexed; same-time and same-size edits update their own bucket on explicit search',async()=>{
  const f=fixture(['one','two','three']),index=f.open();await index.search('one',f.files.slice(0,2));
  assert.deepEqual(f.reads.sort(),['0.md','1.md']);
  f.reads.length=f.writes.length=0;f.texts[1]='new';index.invalidate('1.md');
  assert.equal(f.writes.length,0);
  assert.deepEqual([...(await index.search('new',f.files.slice(0,2))).matches],['1.md']);
  assert.deepEqual(f.reads,['1.md']);assert.deepEqual(f.writes,[bucketFor('1.md')]);
  f.reads.length=0;await f.open().search('new',f.files.slice(0,2));assert.equal(f.reads.length,0);
});

test('corrupt compressed bodies are rebuilt and quota failures preserve results and can be retried',async()=>{
  const f=fixture(['hit']);await f.open().search('hit',f.files);
  f.disk.set(bucketFor('0.md'),new Uint8Array([1,2,3]));
  assert.equal((await f.open().search('hit',f.files)).matches.size,1);assert.equal(f.reads.length,2);
  const write=f.storage.write;f.storage.write=async()=>{throw Error('full');};
  f.files[0].stat.mtime++;const index=f.open();
  const failed=await index.search('hit',f.files);assert.equal(failed.storageError,true);assert.equal(failed.matches.size,1);
  f.storage.write=write;assert.equal((await index.search('hit',f.files)).storageError,false);
  f.reads.length=0;await f.open().search('hit',f.files);assert.equal(f.reads.length,0);
});

test('unavailable storage searches source notes without writing cache files into the vault',async()=>{
  const f=fixture(['needle']);f.storage.paths=async()=>{throw Error('blocked');};
  const result=await f.open().search('needle',f.files);
  assert.equal(result.matches.size,1);assert.equal(result.storageError,true);assert.equal(f.writes.length,0);assert.equal(f.legacy.size,0);
});

test('changes during reads and failed reads cannot become cached false results',async()=>{
  const f=fixture(['hit']),read=f.app.vault.cachedRead,index=f.open();
  f.app.vault.cachedRead=async file=>{file.stat.mtime++;return 'hit';};
  assert.deepEqual((await index.search('hit',f.files)).errors,['0.md']);
  f.app.vault.cachedRead=read;assert.equal((await index.search('hit',f.files)).matches.size,1);
});

test('cancellation persists completed work and a fresh instance resumes without rereading it',async()=>{
  const f=fixture(Array(100).fill('hit'));let stop=false;
  const result=await f.open().search('hit',f.files,{cancelled:()=>stop,onProgress:completed=>{if(completed) stop=true;}});
  assert.equal(result.cancelled,true);assert.ok(f.reads.length>0 && f.reads.length<100);
  const done=new Set(f.reads);f.reads.length=0;
  assert.equal((await f.open().search('hit',f.files)).matches.size,100);
  assert.ok(f.reads.every(path=>!done.has(path)));
});

test('explicit search prunes deleted and renamed paths even outside its filtered candidates',async()=>{
  const f=fixture(['hit','hit','hit']);await f.open().search('hit',f.files);
  f.files[0].path='renamed.md';f.files[0].basename='renamed';f.files.splice(1,1);
  const index=f.open();await index.search('hit',f.files.slice(-1));
  const paths=[];for(const bytes of f.disk.values()) paths.push(...(await decodeBucket(bytes)).entries.map(([path])=>path));
  assert.ok(!paths.includes('0.md') && !paths.includes('1.md'));assert.ok(paths.includes('2.md'));
  assert.deepEqual([...(await index.search('hit',f.files)).matches].sort(),['2.md','renamed.md']);
});

test('two views share serialized updates without losing either candidate set',async()=>{
  const f=fixture(['hit','hit']),index=f.open();
  await Promise.all([index.search('hit',[f.files[0]]),index.search('hit',[f.files[1]])]);
  f.reads.length=0;assert.equal((await f.open().search('hit',f.files)).matches.size,2);assert.equal(f.reads.length,0);
});

test('legacy caches are discarded only on explicit search; unrelated files and original notes are preserved',async()=>{
  const f=fixture(['needle']);f.legacy.set('cache/0.gz','old');f.legacy.set('cache/bucket-0.gz','old');
  f.legacy.set('cache/README.md','unrelated');f.legacy.set('note.md','source');
  const index=f.open();assert.equal(f.removed.length,0);
  await index.search('needle',f.files);
  assert.equal(f.removed.length,2);assert.equal(f.reads.length,1);
  assert.equal(f.legacy.get('cache/README.md'),'unrelated');assert.equal(f.legacy.get('note.md'),'source');
  f.legacy.set('cache/1.gz','resynced');await index.search('needle',f.files);assert.equal(f.legacy.has('cache/1.gz'),false);
});

test('cache deletion waits for writes and clears both stored and retained data without rebuilding',async()=>{
  const f=fixture(['needle','other']),index=f.open();
  const searching=index.search('needle',f.files),clearing=index.clear();await searching;await clearing;
  assert.equal(f.disk.size,0);assert.equal(f.metadata.size,0);assert.equal(index.buckets.size,0);assert.equal(index.results.size,0);
  const engine=new CardSearch(f.app,{index});await engine.search('needle',f.files);
  assert.equal(f.disk.size,0);
  await engine.search('needle',f.files,{updateCache:true});assert.ok(f.disk.size>0);
});

test('a failed legacy-file deletion still clears IndexedDB, reports failure, and can be retried',async()=>{
  const f=fixture(['needle']),index=f.open();await index.search('needle',f.files);
  f.legacy.set('cache/1.gz','old');f.app.vault.adapter.remove=async()=>{throw Error('denied');};
  await assert.rejects(index.clear(),/denied/);assert.equal(f.disk.size,0);assert.equal(index.buckets.size,0);
  f.app.vault.adapter.remove=async path=>f.legacy.delete(path);await index.clear();assert.equal(f.legacy.size,0);
});

test('progress reports exact hits and settled misses before completion',async()=>{
  const f=fixture(['hit','miss','hit','miss','hit']),reports=[];
  const result=await f.open().search('hit',f.files,{onProgress:(count,total,partial)=>reports.push({count,total,matches:[...partial.matches],settled:[...partial.settled]})});
  assert.ok(reports.some(report=>report.count>0 && report.count<5));
  for(const report of reports) {assert.equal(report.count,report.settled.length);assert.ok(report.matches.every(path=>result.matches.has(path)));}
  assert.equal(reports.at(-1).settled.length,5);
});
