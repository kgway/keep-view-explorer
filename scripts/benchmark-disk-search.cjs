const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {SearchIndex}=require('../tests/load-source.cjs').loadSource('../lib/search-index');
const {CardSearch}=require('../tests/load-source.cjs').loadSource('../lib/card-search');
const {files,texts}=require('./search-fixture.cjs').createSearchFixture();

(async()=>{
  const base=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'keep-view-search-'));
  try {
    await fs.mkdir(path.join(root,'notes'));
    let next=0;
    await Promise.all(Array.from({length:16},async()=>{
      while(next<files.length) {const i=next++;await fs.writeFile(path.join(root,files[i].path),texts[i]);}
    }));
    let reads=0;
    const byPath=new Map(files.map(file=>[file.path,file]));
    const app={vault:{
      getAbstractFileByPath:p=>byPath.get(p),
      cachedRead:async file=>{reads++;return fs.readFile(path.join(root,file.path),'utf8');},
      adapter:{
        exists:async p=>{try {await fs.access(path.join(root,p));return true;} catch {return false;}},
        mkdir:p=>fs.mkdir(path.join(root,p)),
        readBinary:async p=>new Uint8Array(await fs.readFile(path.join(root,p))).buffer,
        writeBinary:(p,data)=>fs.writeFile(path.join(root,p),new Uint8Array(data))
      }
    }};
    // Compare the cache algorithm with a synthetic filesystem store; actual
    // IndexedDB behavior is checked separately in the browser tests.
    await fs.mkdir(path.join(root,'benchmark-store'));
    const metadata=new Map();
    const storage={read:async id=>{try{return new Uint8Array(await fs.readFile(path.join(root,'benchmark-store',`${id}.gz`)));}catch(error){if(error.code==='ENOENT')return null;throw error;}},paths:async id=>metadata.get(id)||[],write:async(id,bytes,paths)=>{await fs.writeFile(path.join(root,'benchmark-store',`${id}.gz`),bytes);metadata.set(id,paths);},clear:async()=>{},close(){}};
    await new SearchIndex(app,'cache',{storage}).search('特殊検索語はるかぜ',files);
    const rows=[];
    for(const query of ['特殊検索語はるかぜ','会議']) {
      let expected=null;
      for(let round=0;round<3;round++) for(const mode of ['direct','saved-index']) {
        global.gc?.();
        const engine=new CardSearch(app,mode==='direct'?{}:{index:new SearchIndex(app,'cache',{storage})});
        reads=0;const start=performance.now();const result=await engine.search(query,files,{updateCache:mode!=='direct'});
        const ms=performance.now()-start,paths=[...result.matches].sort();
        if(expected && JSON.stringify(paths)!==JSON.stringify(expected)) throw Error('Search mismatch');
        expected=paths;rows.push({query,round,mode,ms,noteReads:reads,hits:paths.length});
      }
    }
    const report={notes:files.length,sourceBytes:texts.reduce((n,t)=>n+Buffer.byteLength(t),0),rows,note:'Synthetic filesystem backend, not production IndexedDB. Temporary local files and warm OS caches; each search engine starts empty. This is not a mobile or Obsidian measurement.'};
    await fs.mkdir('.artifacts/benchmarks',{recursive:true});
    await fs.writeFile('.artifacts/benchmarks/disk-search-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  } finally {
    if(path.dirname(path.resolve(root))!==base || !path.basename(root).startsWith('keep-view-search-')) throw Error('Unsafe temporary path');
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
