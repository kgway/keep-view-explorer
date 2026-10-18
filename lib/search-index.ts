import type {App, TFile} from "obsidian";
import type {Bucket, CacheEntry, CachedMatch, ProgressCallback, SearchResult} from "./types";

import {encodeBucket,decodeBucket} from "./search-codec";
import {IndexedDBSearchStorage} from './search-storage';
import type {SearchStorage} from './search-storage';
const BUCKETS=8,LEGACY_BUCKETS=64;

const normalize=(value: unknown)=>String(value).normalize('NFC').toLowerCase();

const hash=(value: string)=>{
  let result=2166136261;
  for(let i=0;i<value.length;i++) result=Math.imul(result^value.charCodeAt(i),16777619);
  return result>>>0;
};

const bucketFor=(path: string)=>hash(path)%BUCKETS;

class SearchIndex {
  declare app: App;
  declare directory: string;
  declare yieldTask: () => Promise<void>;
  declare memoryLimit: number;
  declare buckets: Map<number, Bucket>;
  declare invalidated: Map<string, number>;
  declare revision: number;
  declare tail: Promise<unknown>;
  declare query: string;
  declare results: Map<string, CachedMatch>;
  private storage:SearchStorage;
  private storageAvailable=true;
  private closed=false;

  static supported() {return IndexedDBSearchStorage.supported() && typeof CompressionStream!=='undefined' && typeof DecompressionStream!=='undefined';}

  constructor(app: App,directory: string,{yieldTask=()=>new Promise((resolve)=>(typeof window==='undefined'?setTimeout:window.setTimeout)(resolve,0)),memoryLimit=12*1024*1024,storage=new IndexedDBSearchStorage(app)}: {yieldTask?:()=>Promise<void>,memoryLimit?:number,storage?:SearchStorage}={}) {
    this.app=app;this.directory=directory;this.yieldTask=yieldTask;this.memoryLimit=memoryLimit;
    this.buckets= (new Map() as Map<number,Bucket>);this.invalidated= (new Map() as Map<string,number>);this.revision=0;this.tail= (Promise.resolve());
    this.query='';this.results= (new Map() as Map<string,CachedMatch>);
    this.storage=storage;
  }

  invalidate(path: string) {this.invalidated.set(path,++this.revision);this.results.delete(path);}

  private present(path:string) {
    const file=this.app.vault.getAbstractFileByPath(path);
    return !!file && 'stat' in file;
  }

  search(query: string,files: TFile[],{cancelled=()=>false,onProgress=()=>{}}: {cancelled?:()=>boolean,onProgress?:ProgressCallback}={}) {
    const result=this.tail.then(()=>this.run(query,files,{cancelled,onProgress}));
    this.tail=result.catch(()=>{});
    return result;
  }
  clear() {
    const work=this.tail.then(async()=>{
      const outcomes=await Promise.allSettled([this.storage.clear(),this.removeLegacy()]);
      this.buckets.clear();this.invalidated.clear();this.results.clear();this.query='';
      for(const outcome of outcomes) if(outcome.status==='rejected') throw outcome.reason as unknown;
    });
    this.tail=work.catch(()=>{});
    return work;
  }

  close() {this.closed=true;this.storage.close();this.buckets.clear();this.results.clear();this.invalidated.clear();}

  private async removeLegacy() {
    const adapter=this.app.vault.adapter;
    if(!await adapter.exists(this.directory)) return;
    const names=new Set([...Array.from({length:LEGACY_BUCKETS},(_,id)=>`${this.directory}/${id}.gz`),...Array.from({length:BUCKETS},(_,id)=>`${this.directory}/bucket-${id}.gz`)]);
    const listing=await adapter.list(this.directory);
    for(const path of listing.files) if(names.has(path)) await adapter.remove(path);
  }

  async load(id: number): Promise<Bucket> {
    if(this.buckets.has(id)) {
      const bucket=this.buckets.get(id)!;this.buckets.delete(id);this.buckets.set(id,bucket);return bucket;
    }
    const bucket= ({entries:new Map(),dirty:false,bytes:0} as Bucket);
    let bytes:Uint8Array|null=null;
    try {if(this.storageAvailable) bytes=await this.storage.read(id);} catch {this.storageAvailable=false;}
    try {
      if(bytes) {
        const data=await decodeBucket(bytes);
        bucket.dirty=data.legacy;
        for(const [path,entry] of data.entries) {
          if(typeof path!=='string' || bucketFor(path)!==id || typeof entry.text!=='string' || !Number.isFinite(entry.mtime) || !Number.isFinite(entry.size)) throw Error('Invalid search cache');
          const {mtime,size,text}=entry;
          bucket.entries.set(path,{mtime,size,text,epoch:0});bucket.bytes+=text.length*2+path.length*2+128;
        }
      }
    } catch {bucket.entries.clear();bucket.bytes=0;bucket.dirty=true;}
    this.buckets.set(id,bucket);return bucket;
  }

  async prune(cancelled: ()=>boolean) {
    for(let id=0;id<BUCKETS;id++) {
      if(cancelled()) return;
      const paths=await this.storage.paths(id);
      if(!paths.some(path=>!this.present(path))) continue;
      const bucket=await this.load(id);
      for(const path of bucket.entries.keys()) if(!this.present(path)) {bucket.entries.delete(path);this.results.delete(path);this.invalidated.delete(path);}
      bucket.dirty=true;
      await this.save(id,bucket);
      bucket.bytes=[...bucket.entries].reduce((sum,[path,entry])=>sum+entry.text.length*2+path.length*2+128,0);
      this.trim();
    }
  }
  trim() {
    let bytes=[...this.buckets.values()].reduce((sum,bucket)=>sum+bucket.bytes,0);
    for(const [id,bucket] of this.buckets) {
      if(bytes<=this.memoryLimit) break;
      bytes-=bucket.bytes;this.buckets.delete(id);
    }
  }

  async save(id: number,bucket: Bucket) {
    if(!bucket.dirty) return;
    const entries=[...bucket.entries].map(([path,{epoch,...entry}])=> ([path,entry] as [string,CacheEntry]));
    const epochs=new Map([...bucket.entries].map(([path,entry])=>[path,entry.epoch]));
    if(!this.storageAvailable || this.closed) throw new Error('Search cache unavailable');
    await this.yieldTask();
    const compressed=await encodeBucket(entries);
    await this.storage.write(id,compressed,entries.map(([path])=>path));
    for(const [path,epoch] of epochs) if((this.invalidated.get(path)||0)===epoch) {
      this.invalidated.delete(path);bucket.entries.get(path)!.epoch=0;
    }
    bucket.dirty=false;
  }

  async run(query: string,files: TFile[],{cancelled,onProgress}: {cancelled:()=>boolean,onProgress:ProgressCallback}): Promise<SearchResult> {
    const matches=new Set( ([] as string[])),settled=new Set( ([] as string[])),errors= ([] as string[]),groups= (new Map() as Map<number,TFile[]>);let completed=0,storageError=false;
    if(this.closed || cancelled()) return {matches,errors,cancelled:true};
    this.storageAvailable=true;
    try {await this.prune(cancelled);} catch {this.storageAvailable=false;storageError=true;}
    try {if(this.storageAvailable && !cancelled()) await this.removeLegacy();} catch {storageError=true;}
    const report=()=>{if(!cancelled()) onProgress(completed,files.length,{matches,settled});};
    if(query!==this.query) {this.query=query;this.results.clear();}
    for(const file of files) {
      const cached=this.results.get(file.path);
      if(cached && cached.file===file && cached.mtime===file.stat.mtime && cached.size===file.stat.size) {
        if(cached.match) matches.add(file.path);
        settled.add(file.path);
        completed++;continue;
      }
      const id=bucketFor(file.path);
      if(!groups.has(id)) groups.set(id,[]);
      groups.get(id)!.push(file);
    }
    report();
    let started=Date.now();
    for(const [id,candidates] of groups) {
      if(cancelled()) break;
      const bucket=await this.load(id);
      for(const path of bucket.entries.keys()) if(!this.present(path)) {bucket.entries.delete(path);this.invalidated.delete(path);bucket.dirty=true;}
      for(const file of candidates) {
        if(cancelled()) break;
        const path=file.path,mtime=file.stat.mtime,size=file.stat.size,epoch=this.invalidated.get(path)||0;
        try {
          let entry=bucket.entries.get(path);
          if(!entry || entry.mtime!==mtime || entry.size!==size || entry.epoch!==epoch) {
            const text=normalize(await this.app.vault.cachedRead(file));
            if(file.path!==path || file.stat.mtime!==mtime || file.stat.size!==size || (this.invalidated.get(path)||0)!==epoch || this.app.vault.getAbstractFileByPath(path)!==file) throw Error('Note changed during indexing');
            entry={mtime,size,text,epoch};bucket.entries.set(path,entry);bucket.dirty=true;
          }
          const match=normalize(file.basename).includes(query) || entry.text.includes(query);
          if(match) matches.add(path);
          const oldest=this.results.keys().next();
          const oldestPath= (oldest.value as unknown);
          if(this.results.size>=10000 && typeof oldestPath==='string') this.results.delete(oldestPath);
          this.results.set(path,{file,mtime,size,match});
        } catch {bucket.entries.delete(path);bucket.dirty=true;errors.push(path);}
        completed++;
        settled.add(path);
        if(Date.now()-started>=8) {report();await this.yieldTask();started=Date.now();}
      }
      try {await this.save(id,bucket);} catch {
        storageError=true;
        for(const path of bucket.entries.keys()) this.results.delete(path);
      }
      bucket.bytes=[...bucket.entries].reduce((sum,[path,entry])=>sum+entry.text.length*2+path.length*2+128,0);
      this.trim();report();
      if(Date.now()-started>=8) {await this.yieldTask();started=Date.now();}
    }
    report();
    return {matches,errors,storageError:storageError || !this.storageAvailable,cancelled:cancelled() || this.closed};
  }
}

export {SearchIndex,bucketFor};
