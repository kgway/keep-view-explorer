import type {App} from 'obsidian';

const NAMESPACE_KEY='keep-view-search-cache-id';
const PREFIX='keep-view/search-cache/';
const MAX_BUCKET_BYTES=8*1024*1024;

function checkBucket(id:number) {
  if(!Number.isInteger(id) || id<0 || id>=8) throw new Error('Invalid search cache bucket ID');
}

export interface SearchStorage {
  read(id:number):Promise<Uint8Array|null>;
  paths(id:number):Promise<string[]>;
  write(id:number,bytes:Uint8Array,paths:string[]):Promise<void>;
  clear():Promise<void>;
  close():void;
}

function requestValue(request:IDBRequest):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result as unknown);
    request.onerror=()=>reject(request.error || new Error('Search cache request failed'));
  });
}

function committed(transaction:IDBTransaction):Promise<void> {
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onabort=()=>reject(transaction.error || new Error('Search cache transaction aborted'));
    transaction.onerror=()=>{};
  });
}

export class IndexedDBSearchStorage implements SearchStorage {
  private connection:Promise<IDBDatabase>|null=null;
  private database:IDBDatabase|null=null;
  private closed=false;

  constructor(private app:App) {}

  static supported() {
    try {return typeof indexedDB!=='undefined';} catch {return false;}
  }

  private name(create:boolean):string|null {
    const stored:unknown=this.app.loadLocalStorage(NAMESPACE_KEY);
    if(typeof stored==='string' && /^[a-f0-9]{32}$/.test(stored)) return PREFIX+stored;
    if(!create) return null;
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    const id=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
    this.app.saveLocalStorage(NAMESPACE_KEY,id);
    // Read the shared vault-local value back before selecting a database.
    const saved:unknown=this.app.loadLocalStorage(NAMESPACE_KEY);
    if(saved!==id) throw new Error('Search cache namespace could not be saved');
    return PREFIX+id;
  }

  private open():Promise<IDBDatabase> {
    if(this.closed) return Promise.reject(new Error('Search cache is closed'));
    if(this.connection) return this.connection;
    const opening=new Promise<IDBDatabase>((resolve,reject)=>{
      const name=this.name(true);
      if(!name) throw new Error('Search cache namespace unavailable');
      const request=indexedDB.open(name,1);
      let expired=false;
      const timer=window.setTimeout(()=>{expired=true;reject(new Error('Search cache open timed out'));},3000);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('buckets');db.createObjectStore('paths');
      };
      request.onerror=()=>{window.clearTimeout(timer);reject(request.error || new Error('Search cache open failed'));};
      request.onblocked=()=>{window.clearTimeout(timer);expired=true;reject(new Error('Search cache open blocked'));};
      request.onsuccess=()=>{
        window.clearTimeout(timer);
        const db=request.result;
        if(expired || this.closed) {db.close();reject(new Error('Search cache is closed'));return;}
        this.database=db;
        db.onversionchange=()=>{db.close();this.database=null;this.connection=null;};
        db.onclose=()=>{this.database=null;this.connection=null;};
        resolve(db);
      };
    });
    this.connection=opening.catch((error:unknown)=>{this.connection=null;throw error;});
    return this.connection;
  }

  async read(id:number):Promise<Uint8Array|null> {
    checkBucket(id);
    const db=await this.open();
    const value=await requestValue(db.transaction('buckets','readonly').objectStore('buckets').get(id));
    if(value===undefined) return null;
    if(!(value instanceof ArrayBuffer) || value.byteLength>MAX_BUCKET_BYTES) throw new Error('Invalid search cache bucket');
    return new Uint8Array(value);
  }

  async paths(id:number):Promise<string[]> {
    checkBucket(id);
    const db=await this.open();
    const value=await requestValue(db.transaction('paths','readonly').objectStore('paths').get(id));
    if(value===undefined) return [];
    if(!Array.isArray(value) || !value.every((path:unknown)=>typeof path==='string')) throw new Error('Invalid search cache paths');
    return value as string[];
  }

  async write(id:number,bytes:Uint8Array,paths:string[]):Promise<void> {
    checkBucket(id);
    if(bytes.byteLength>MAX_BUCKET_BYTES) throw new Error('Search cache capacity exceeded');
    const db=await this.open();
    const transaction=db.transaction(['buckets','paths'],'readwrite');
    const done=committed(transaction);
    try {
      transaction.objectStore('buckets').put(bytes.slice().buffer,id);
      transaction.objectStore('paths').put(paths,id);
    } catch(error:unknown) {
      transaction.abort();await done.catch(()=>{});throw error;
    }
    await done;
  }

  async clear():Promise<void> {
    const name=this.name(false);
    if(!name) return;
    const db=await this.open();
    const transaction=db.transaction(['buckets','paths'],'readwrite');
    const done=committed(transaction);
    transaction.objectStore('buckets').clear();transaction.objectStore('paths').clear();
    await done;
  }

  close() {this.closed=true;this.database?.close();this.database=null;this.connection=null;}
}
