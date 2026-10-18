const {performance}=require('node:perf_hooks');
const {normalizeSearch}=require('../tests/load-source.cjs').loadSource('../lib/card-search');
const {writeFileSync,mkdirSync}=require('node:fs');

const {texts,files,count}=require('./search-fixture.cjs').createSearchFixture();
const byPath=new Map(files.map(file=>[file.path,file]));
let reads=0;
const app={vault:{getAbstractFileByPath:path=>byPath.get(path),cachedRead:async file=>{reads++;return texts[file.index];}}};

const {SearchIndex}=require('../tests/load-source.cjs').loadSource('../lib/search-index');
const disk=new Map();let loads=0,writes=0;
app.vault.adapter={exists:async path=>disk.has(path),mkdir:async path=>disk.set(path,null),readBinary:async path=>{loads++;return disk.get(path);},writeBinary:async(path,data)=>{writes++;disk.set(path,data);}};
const paths=new Map();
const storage={read:async id=>{loads++;const bytes=disk.get(id);return bytes?new Uint8Array(bytes):null;},paths:async id=>paths.get(id)||[],write:async(id,bytes,names)=>{writes++;disk.set(id,bytes);paths.set(id,names);},clear:async()=>{disk.clear();paths.clear();},close(){}};
const open=()=>new SearchIndex(app,'cache',{storage,yieldTask:()=>new Promise(resolve=>setImmediate(resolve))});
(async()=>{
  const scenarios=[],queries=['特殊検索語はるかぜ','会','会議','確認123','存在しない語句'];
  const index=open();
  reads=loads=writes=0;let start=performance.now();await index.search(queries[0],files);
  const first={ms:performance.now()-start,noteReads:reads,indexReads:loads,indexWrites:writes};
  const restored=open();
  for(const query of queries) {
    reads=loads=writes=0;start=performance.now();const result=await restored.search(query,files);const ms=performance.now()-start;
    const expected=files.filter(file=>normalizeSearch(file.basename).includes(query)||normalizeSearch(texts[file.index]).includes(query));
    if(expected.length!==result.matches.size || expected.some(file=>!result.matches.has(file.path))) throw Error('Search mismatch');
    scenarios.push({query,ms,hits:result.matches.size,noteReads:reads,indexReads:loads,indexWrites:writes});
  }
  reads=loads=writes=0;start=performance.now();await restored.search(queries.at(-1),files);
  const repeat={ms:performance.now()-start,noteReads:reads,indexReads:loads,indexWrites:writes};
  texts[0]+=' updated';files[0].stat.mtime++;files[0].stat.size=Buffer.byteLength(texts[0]);
  reads=loads=writes=0;start=performance.now();await restored.search(queries.at(-1),files);
  const update={ms:performance.now()-start,noteReads:reads,indexReads:loads,indexWrites:writes};
  const report={fixture:{notes:count,utf8Bytes:texts.reduce((n,text)=>n+Buffer.byteLength(text),0)},compressedBytes:[...disk.values()].reduce((n,data)=>n+(data?.byteLength||0),0),first,restored:scenarios,repeat,update,note:'Synthetic in-memory storage, including compression and yielding. Timings exclude device I/O and are not mobile measurements. No user data.'};
  mkdirSync('.artifacts/benchmarks',{recursive:true});
  writeFileSync('.artifacts/benchmarks/search-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
