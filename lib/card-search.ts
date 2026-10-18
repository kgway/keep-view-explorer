import type {App, TFile} from "obsidian";
import type {SearchIndex} from "./search-index";
import type {CachedMatch, ProgressCallback, SearchResult} from "./types";


const normalizeSearch=(value: unknown)=>String(value).normalize('NFC').toLowerCase();

class CardSearch {
  declare index: SearchIndex|null;
  declare app: App;
  declare limit: number;
  declare yieldTask: () => Promise<void>;
  declare query: string;
  declare cache: Map<string, CachedMatch>;
  declare generation: number;
  declare tail: Promise<unknown>;

  constructor(app: App,{index=null,limit=10000,yieldTask=()=>new Promise((resolve)=>(typeof window==='undefined'?setTimeout:window.setTimeout)(resolve,0))}: {index?:SearchIndex|null,limit?:number,yieldTask?:()=>Promise<void>}={}) {
    this.index=index;
    this.app=app;this.limit=limit;this.yieldTask=yieldTask;
    this.query='';this.cache= (new Map() as Map<string,CachedMatch>);this.generation=0;this.tail= (Promise.resolve());
  }
  cancel() {this.generation++;}

  invalidate(path: string) {this.cache.delete(path);this.index?.invalidate(path);}
  clear() {this.cancel();this.cache.clear();this.query='';}
  dispose() {this.clear();}

  search(value: string,files: TFile[],{onProgress=()=>{},updateCache=false}: {onProgress?:ProgressCallback,updateCache?:boolean}={}): Promise<SearchResult> {
    const query=normalizeSearch(value.trim()),generation=++this.generation;
    const cancelled=()=>generation!==this.generation;
    const work=async()=>{
      const matches=new Set( ([] as string[])),settled=new Set( ([] as string[])),errors= ([] as string[]);
      if(cancelled()) return {matches,errors,cancelled:true};
      if(this.index && updateCache) return this.index.search(query,files,{cancelled,onProgress});
      if(query!==this.query) {this.query=query;this.cache.clear();}
      let next=0,completed=0;
      await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{
        let started=Date.now();
        while(next<files.length && !cancelled()) {
          const file=files[next++],path=file.path,mtime=file.stat.mtime,size=file.stat.size;
          const cached=this.cache.get(path);
          let match;
          try {
            if(cached && cached.file===file && cached.mtime===mtime && cached.size===size) match=cached.match;
            else {
              // Do not keep note text: only the result for the current query is cached.
              match=normalizeSearch(file.basename).includes(query);
              if(!match) match=normalizeSearch(await this.app.vault.cachedRead(file)).includes(query);
              if(cancelled()) break;
              if(file.path!==path || file.stat.mtime!==mtime || file.stat.size!==size || this.app.vault.getAbstractFileByPath(path)!==file) throw Error('Note changed during search');
              const oldest=this.cache.keys().next();
              const oldestPath= (oldest.value as unknown);
              if(this.cache.size>=this.limit && typeof oldestPath==='string') this.cache.delete(oldestPath);
              if(this.limit>0) this.cache.set(path,{file,mtime,size,match});
            }
            if(match) matches.add(path);
          } catch {this.cache.delete(path);errors.push(path);}
          completed++;
          settled.add(path);
          if(Date.now()-started>=8) {onProgress(completed,files.length,{matches,settled});await this.yieldTask();started=Date.now();}
        }
      }));
      if(!cancelled()) onProgress(completed,files.length,{matches,settled});
      return {matches,errors,cancelled:cancelled()};
    };
    const result=this.tail.then(work);
    this.tail=result.catch(()=>{});
    return result;
  }
}

export {CardSearch,normalizeSearch};
