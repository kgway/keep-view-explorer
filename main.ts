import type {ContentEntry, FolderNode, Page, PathExport, ResultFolder, SavedState, Settings, Snapshot, TagDraft, TagNode, ViewState} from "./lib/types";
import type {App, SettingGroup, TAbstractFile, TFile, WorkspaceLeaf} from "obsidian";
import {t as msg,setLanguage,getLocale} from "./lib/i18n";
import {Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, getAllTags, getLanguage, setIcon, addIcon, MarkdownRenderer, Component, requireApiVersion} from "obsidian";
import {CardSearch,normalizeSearch} from "./lib/card-search";
import {formatPathExport} from "./lib/path-export";
import {SearchIndex} from "./lib/search-index";
import {noteTags,restoreTagChanges,editNoteTags,moveSelection,trashSelectedNotes,validTimeZone,localIsoTimestamp,createNote} from "./lib/note-operations";
import {openNoteInForeground} from "./lib/note-opening";
import {iconButton,folderDropdownRow,dropdownCheckbox,disclosureIcon,animateDisclosure,suppressHoverTooltips} from "./lib/ui";
import {record,isFile,isFolder,clone,errorMessage,dictionary} from "./lib/value-guards";
import {readState,readSettings} from "./lib/saved-data";
import {DateGuidance} from "./lib/date-guidance";
type Token = {type:string,value?:string};
type ParsedNode = {node:TagNode,pos:number};
type Popup = HTMLDivElement & {_anchor?:HTMLElement,_reposition?:()=>void,_cleanup?:()=>void,_isFolderDropdown?:boolean};
type SearchState = {key:string|null,ready:boolean,matches:Set<string>,errors:string[],waiting?:boolean,files?:Set<string>,completed?:number,total?:number,slow?:boolean,repaint?:()=>void};
type CardBody = HTMLElement & {_treeGroups?:Set<string>,_appendCards?:(pages:Page[])=>void};
type SettingRow = {name:string,desc?:string,render:(setting:Setting,group:SettingGroup|null)=>void};
const VIEW_TYPE = 'keep-view';
const KEEP_VIEW_ICON = 'keep-view-note-bulb';
const KEEP_VIEW_ICON_SVG = `<g fill="none" stroke="currentColor" stroke-width="6.25" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 5h64a13 13 0 0 1 13 13v58L76 95H18A13 13 0 0 1 5 82V18A13 13 0 0 1 18 5Z"/>
  <path d="M76 95V82a6 6 0 0 1 6-6h13"/>
  <path d="M41 67v-6c0-6-10-10-10-20a19 19 0 0 1 38 0c0 10-10 14-10 20v6Z"/>
  <path d="M42 76h16l-3 5H45Z" fill="currentColor" stroke="none" style="fill:currentColor !important;stroke:none !important"/>
</g>`;
const TREE_ICON='keep-view-tree';
const EXPORT_ICON='log-out';
const TREE_ICON_SVG='<g fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 14v58q0 6 6 6h20M22 34h26"/><rect x="48" y="22" width="38" height="24" rx="5"/><rect x="48" y="66" width="38" height="24" rx="5"/></g>';

const DEFAULT_SETTINGS: Settings = {dateProperty:'created',creationTimeZone:'',previewLengths:[50,100,150,200,400],previewMode:'markdown',confirmDelete:true,fastSearch:true,showDateGuidance:true,language:'auto'};

function markdownBody(raw: string) {
  const leadingBlankLines=/^(?:[ \t]*\r?\n)+/;
  return raw.replace(/^\uFEFF/,'').replace(leadingBlankLines,'')
    .replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/,'').replace(leadingBlankLines,'');
}

function previewLengths(value: unknown): number[]|null {
  const values=Array.isArray(value)? (value as unknown[]):String(value).split(/[,、，\s]+/).filter(Boolean).map(Number);
  if(!values.length || values.length>20 || values.some((n)=>typeof n!=='number'||!Number.isInteger(n)||n<1||n>10000)) return null;
  return [...new Set(values.filter( (n: unknown): n is number=>typeof n==='number'))].sort((a,b)=>a-b);
}

// BEGIN MIGRATION HELPERS — also packaged as a standalone Obsidian user script.

function parseIsoTimestamp(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!match) return null;
  const [, y, m, d, h='00', min='00', sec='00', , zone] = match;
  const year=Number(y), month=Number(m), day=Number(d);
  const leap = year%4===0 && (year%100!==0 || year%400===0);
  const days = [31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (month<1 || month>12 || day<1 || day>days[month-1] || +h>23 || +min>59 || +sec>59) return null;
  if (zone && zone!=='Z' && (+zone.slice(1,3)>23 || +zone.slice(4)>59)) return null;
  // Date-only ISO values are local midnight, matching the date range controls.
  const ms = Date.parse(text.length===10 ? text+'T00:00:00' : text);
  return Number.isFinite(ms) ? ms : null;
}

function timestampFromFilename(basename: string) {
  const match = basename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})[_:](\d{2})[_:](\d{2})(\.\d{1,9})?(Z|[+-]\d{2}[_:]\d{2})$/);
  if (!match) return null;
  const [,date,hour,minute,second,fraction='',zone] = match;
  const iso = `${date}T${hour}:${minute}:${second}${fraction}${zone.replace('_',':')}`;
  return parseIsoTimestamp(iso) === null ? null : iso;
}

function validatePropertyName(property: unknown): property is string {
  return typeof property==='string' && property.trim().length>0 && !/[\r\n\0]/.test(property) && !['__proto__','constructor','prototype'].includes(property.trim());
}

function normalizeFolderScope(folder: unknown) {
  const clean = String(folder || '').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  if (clean.split('/').some((part) => part==='.' || part==='..')) throw new Error(msg("フォルダには Vault 内の相対パスを指定してください"));
  return clean;
}

/** Default is a read-only preview. Runs inside Obsidian with its public APIs. */
async function migrateCreated(app: App, {property='created', folder='', apply=false, paths=null, cancelled=()=>false}: {property?:string,folder?:string,apply?:boolean,paths?:string[]|null,cancelled?:()=>boolean}={}) {
  if (!validatePropertyName(property)) throw new Error(msg("有効なプロパティ名を指定してください"));
  property = property.trim();
  folder = normalizeFolderScope(folder);
  const allowed = paths ? new Set(paths) : null;

  const report: {property:string,folder:string,applied:boolean,rows:{path:string,value:string|null,status:string,error?:string}[],cancelled?:boolean} = {property, folder, applied:apply, rows:[]};
  const files = app.vault.getMarkdownFiles().filter((file) => (!folder || file.path.startsWith(folder+'/')) && (!allowed || allowed.has(file.path))).sort((a,b)=>a.path.localeCompare(b.path));
  for (const file of files) {
    if (cancelled()) { report.cancelled=true; break; }
    const iso = timestampFromFilename(file.basename);

    const row: {path:string,value:string|null,status:string,error?:string} = {path:file.path, value:iso, status:'unrecognized'};
    report.rows.push(row);
    if (!iso) continue;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm && Object.prototype.hasOwnProperty.call(fm, property)) { row.status='existing'; continue; }
    row.status='ready';
    if (!apply) continue;
    try {
      // Recheck the current frontmatter atomically; metadata cache may be stale.
      await app.fileManager.processFrontMatter(file, (current) => {
        if (Object.prototype.hasOwnProperty.call(current,property)) row.status='existing';
        else { Object.defineProperty(current, property, {value:iso,writable:true,enumerable:true,configurable:true}); row.status='written'; }
      });
    } catch (error) { row.status='error'; row.error=error instanceof Error?error.message:String(error); }
  }
  return report;
}
// END MIGRATION HELPERS

function masonryPositions(heights: number[], columns: number, gap: number) {
  const bottoms = Array.from({length:columns},()=>0);
  const positions = heights.map((height) => {
    const top = Math.min(...bottoms);
    const column = bottoms.indexOf(top);
    bottoms[column] = top + height + gap;
    return {column, top};
  });
  return {positions, height:Math.max(0,...bottoms)- (heights.length ? gap : 0)};
}

function makePathExport(app: App, pages: Page[], filters: Record<string,unknown>, property: string): PathExport {
  return {schema:'keep-view-paths/v1', exportedAt:new Date().toISOString(), vault:app.vault.getName(),
    pathBase:'vault-relative', count:pages.length,
    filters:{...filters, dateProperty:property, dateRangeTimezone:Intl.DateTimeFormat().resolvedOptions().timeZone},
    paths:pages.map((page)=>page.file.path)};
}

function resultFolderTree(pages: Page[]) {

  const root: ResultFolder={path:'',name:msg("(ルート)"),pages:[],children:new Map(),count:0};
  for (const page of pages) {
    let node=root; node.count++;
    for (const part of page.file.folder.split('/').filter(Boolean)) {
      if (!node.children.has(part)) node.children.set(part,{path:node.path?node.path+'/'+part:part,name:part,pages:[],children:new Map(),count:0});
      node=node.children.get(part)!; node.count++;
    }
    node.pages.push(page);
  }
  return root;
}

function mountKeepView(app: App, container: HTMLElement, saved: Partial<SavedState>, persist: (state:SavedState)=>void, settings: Settings = DEFAULT_SETTINGS, searchIndex: SearchIndex|null = null, callbacks: {onHideDateGuidance?:()=>void,dateGuidanceShown?:Set<string>} = {}) {
const document =  (container.ownerDocument as Document & {caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node,offset:number}|null});
const window =  (document.defaultView as NonNullable<Document['defaultView']>);
const AbortController = window.AbortController;
const lifetime = new AbortController();
const releaseTooltips=suppressHoverTooltips(container);
let disposed = false, revision = 0;
 let dragCleanup: (()=>void)|null=null;
 let exportModal: PathExportModal|null=null;
 let searchModal: TextSearchModal|null=null;
 let deleteModal: DeleteNotesModal|null=null;
 let dateMigrationModal: MigrationModal|null=null;
const dateGuidance=new DateGuidance();
const dateGuidanceShown=callbacks.dateGuidanceShown || new Set( ([] as string[]));
 let dateGuidanceModal: CreationDateModal|null=null;
const cardSearch=new CardSearch(app,{index:searchIndex,yieldTask:()=>new Promise((resolve)=>window.setTimeout(resolve,0))});

let searchState: SearchState={key:null,ready:true,matches:new Set(),errors:[]};
let searchActivated=false;
let updateSearchCache=false;
let deferTreeCards=false;let treeCardTimer: number|null=null;
const treeCardQueue= ([] as (()=>boolean)[]);

const scheduleTreeCards=(task: ()=>boolean)=>{
  treeCardQueue.push(task);
  if(treeCardTimer!==null) return;
  const next=()=>{
    treeCardTimer=null;if(disposed) {treeCardQueue.length=0;return;}
    while(treeCardQueue.length) {if(treeCardQueue.shift()!()) break;}
    if(treeCardQueue.length) treeCardTimer=setTimeout(next,16);
  };
  treeCardTimer=setTimeout(next,0);
};
// Clear only this view's text selection; leave dragging and copy gestures intact.

let selectionTap: {id:number,x:number,y:number,at:number,anchor:Node|null,focus:Node|null,start:number,end:number}|null=null;
document.addEventListener?.('pointerdown',(event)=>{
  selectionTap=null;if(event.button!==0) return;
  const selected=window.getSelection?.();
  if(!selected || selected.isCollapsed || !container.contains(selected.anchorNode)) return;
  const range=selected.getRangeAt(0);
  const inside=[...range.getClientRects()].some((rect)=>event.clientX>=rect.left-12 && event.clientX<=rect.right+12 && event.clientY>=rect.top-12 && event.clientY<=rect.bottom+12);
  if(!inside) {selected.removeAllRanges();return;}
  selectionTap={id:event.pointerId,x:event.clientX,y:event.clientY,at:Date.now(),anchor:selected.anchorNode,focus:selected.focusNode,start:selected.anchorOffset,end:selected.focusOffset};
},{capture:true,signal:lifetime.signal});
document.addEventListener?.('pointerup',(event)=>{
  const tap=selectionTap;selectionTap=null;
  if(!tap || tap.id!==event.pointerId || Date.now()-tap.at>=450 || Math.hypot(event.clientX-tap.x,event.clientY-tap.y)>8) return;
  const selected=window.getSelection();
  if(!selected) return;
  if(selected.anchorNode===tap.anchor && selected.focusNode===tap.focus && selected.anchorOffset===tap.start && selected.focusOffset===tap.end) selected.removeAllRanges();
},{capture:true,signal:lifetime.signal});
const selectedPaths=new Set( ([] as string[]));
const selectedFolders=new Set( ([] as string[]));
 let selectionBar: HTMLElement|null=null;
 let tagDraft: TagDraft|null=null;
 let moveDraft: string|null=null;
let selectionMode=false,selectionBusy=false;
const draftDirty=()=>{const draft=tagDraft;return draft && (draft.checked.length!==draft.common.length || draft.checked.some((tag)=>!draft.common.includes(tag)));};
const updateSelection=()=>{
  for(const card of container.querySelectorAll<HTMLElement>('.kv-card')) {
    const selected=selectedPaths.has(card.dataset.path!);card.classList.toggle('is-selected',selected);
    card.setAttribute('aria-label',`${card.dataset.path}${selected?msg("（選択中）"):''}`);
  }
  for(const row of container.querySelectorAll<HTMLButtonElement & {_selectionPaths?:string[]}>('.kv-result-folder')) {
    const paths=row._selectionPaths||[],count=paths.filter((path)=>selectedPaths.has(path)).length;
    row.classList.toggle('is-selected',count>0 && count===paths.length);
    row.classList.toggle('is-partial',count>0 && count<paths.length);
    row.setAttribute('aria-pressed',count===0?'false':count===paths.length?'true':'mixed');
  }
  if(!selectionBar) return;
  const controls=container.querySelector<HTMLElement>('.kv-controls');
  if(controls) controls.inert=selectionBusy;
  selectionBar.hidden=!selectionMode;
   (selectionBar.querySelector('.kv-selection-count') as HTMLElement).textContent=msg("{0} 件選択", [selectedPaths.size]);
  const edit= (selectionBar.querySelector('.kv-selection-edit') as HTMLButtonElement);
  edit.disabled=selectionBusy || !selectedPaths.size;
  selectionBar.querySelector('button')!.disabled=selectionBusy;
   (selectionBar.querySelector('.kv-selection-move') as HTMLButtonElement).disabled=selectionBusy || !selectedPaths.size;
   (selectionBar.querySelector('.kv-selection-delete') as HTMLButtonElement).disabled=selectionBusy || !selectedPaths.size;
  const confirm= (selectionBar.querySelector('.kv-selection-confirm') as HTMLButtonElement);
  confirm.hidden=!draftDirty() && moveDraft===null;confirm.disabled=selectionBusy || !selectedPaths.size;
  for(const [selector,stack] of  ([['.kv-undo',S.undoStack],['.kv-redo',S.redoStack]] as [string,Snapshot[]][])) {
    for(const button of container.querySelectorAll<HTMLButtonElement>(selector)) button.disabled=selectionBusy || !stack.length;
  }
};

const toggleSelection=(path: string)=>{
  if(selectionBusy) return;
  pushUndo();tagDraft=null;moveDraft=null;closePopup();
  if(selectedPaths.has(path)) selectedPaths.delete(path);else selectedPaths.add(path);
  for(const folder of selectedFolders) if(path.startsWith(folder+'/')) selectedFolders.delete(folder);
  selectionMode=selectedPaths.size>0;
  updateSelection();
};

const toggleFolderSelection=(folder: string)=>{
  const paths=app.vault.getMarkdownFiles().filter((file)=>file.path.startsWith(folder+'/')).map((file)=>file.path);
  if(selectionBusy || !paths.length) return;
  pushUndo();tagDraft=null;moveDraft=null;closePopup();
  const remove=paths.every((path)=>selectedPaths.has(path));
  for(const existing of selectedFolders) if(existing===folder || existing.startsWith(folder+'/') || folder.startsWith(existing+'/')) selectedFolders.delete(existing);
  if(!remove) selectedFolders.add(folder);
  for(const path of paths) {if(remove) selectedPaths.delete(path);else selectedPaths.add(path);}
  selectionMode=selectedPaths.size>0;updateSelection();
};

const openMoveDropdown=(anchor: HTMLElement)=>{
  if(selectionBusy || !selectedPaths.size) return;
  const paths=[...selectedPaths],counts= (new Map() as Map<string,number>);
  for(const path of paths) {const folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';counts.set(folder,(counts.get(folder)||0)+1);}
  let target=moveDraft,query='';const expanded=new Set( ([] as string[]));
  const folders=new Set(['']);
  for(const file of app.vault.getAllLoadedFiles?.()||app.vault.getMarkdownFiles()) {
    const folder=isFolder(file)?file.path:file.path.split('/').slice(0,-1).join('/');
    let prefix='';for(const part of folder.split('/').filter(Boolean)) {prefix=prefix?prefix+'/'+part:part;folders.add(prefix);}
  }
  const sorted=[...folders].sort((a,b)=>a.localeCompare(b));
  for(const folder of counts.keys()) {let current=folder;while(current) {expanded.add(current);current=current.split('/').slice(0,-1).join('/');}}
  if(target) {let current=target;while(current) {expanded.add(current);current=current.split('/').slice(0,-1).join('/');}}
  openPopup(anchor,(popup)=>{
    const search=popup.createEl('input',{cls:'kv-dropdown-search',type:'search',placeholder:msg("フォルダを検索...")});
    const list=popup.createDiv(),summary=popup.createDiv({cls:'kv-move-current'});
    const rebuild=()=>{
      list.empty();
      for(const folder of sorted) {
        const parent=folder.split('/').slice(0,-1).join('/');
        const ancestors=parent.split('/').filter(Boolean).map((_,index)=>parent.split('/').slice(0,index+1).join('/'));
        if(query?!folder.toLocaleLowerCase().includes(query):ancestors.some((path)=>!expanded.has(path))) continue;
        const children=!!folder && sorted.some((path)=>path.startsWith(folder+'/'));
        const {item:row,toggle:arrow}=folderDropdownRow(list,{name:folder?folder.split('/').pop()!:msg("(ルート)"),selected:target===folder,depth:folder?folder.split('/').length-1:0,children,open:expanded.has(folder)});
        row.classList.add('kv-move-folder');row.dataset.destination=folder;
        const count=counts.get(folder)||0;
        if(children) arrow.onclick=(event)=>{event.stopPropagation();animateDisclosure(arrow,!arrow.classList.contains('is-open'),(open)=>{if(open) expanded.add(folder);else expanded.delete(folder);rebuild();});};
        if(count) row.createSpan({cls:'kv-move-count',text:msg("{0}/{1}", [count, paths.length])});
        const invalid=[...selectedFolders].some((source)=>folder===source || folder.startsWith(source+'/'));
        if(invalid) {row.classList.add('is-partial');row.setAttribute('aria-disabled','true');row.querySelector('input')!.disabled=true;}
        row.onclick=()=>{if(invalid) return;pushUndo();target=target===folder?null:folder;moveDraft=target;rebuild();updateSelection();};
      }
      summary.textContent=(target===null?'':msg("移動先: {0}", [target||msg("Vault 直下")]))+(selectedFolders.size?msg("（選択フォルダは添付ファイルを含め階層ごと移動）"):'');
    };
    search.oninput=()=>{query=search.value.trim().toLocaleLowerCase();rebuild();};
    rebuild();
  },{minWidth:'240px'});
};
const exitSelection=()=>{
  if(selectionBusy) return;
  pushUndo();selectionMode=false;selectedPaths.clear();selectedFolders.clear();tagDraft=null;moveDraft=null;closePopup();updateSelection();
};
const prepareTagDraft=()=>{
  const counts= (new Map() as Map<string,number>);
  for(const path of selectedPaths) {
    const file=app.vault.getAbstractFileByPath(path);
    for(const tag of noteTags(isFile(file)?app.metadataCache.getFileCache(file)?.frontmatter:null)) counts.set(tag,(counts.get(tag)||0)+1);
  }
  const common=[...counts.keys()].filter((tag)=>counts.get(tag)===selectedPaths.size);
  return {common,partial:[...counts.keys()].filter((tag)=>counts.get(tag)!<selectedPaths.size),checked:[...common],counts:Object.fromEntries(counts),total:selectedPaths.size};
};
const deleteSelection=()=>{
  if(selectionBusy || !selectedPaths.size) return;
  closePopup();
  const targets=[...selectedPaths].map((path)=>{const file=app.vault.getAbstractFileByPath(path);return {path,file:isFile(file)?file:null};});
  const perform=async()=>{
    selectionBusy=true;updateSelection();
    try {
      const report=await trashSelectedNotes(app,targets);
      for(const path of report.deleted) selectedPaths.delete(path);
      selectedFolders.clear();
      tagDraft=null;moveDraft=null;selectionMode=selectedPaths.size>0;
      revision++;pagesCache=null;S.tagCache=null;
      new Notice(msg("{0} 件を削除しました{1}", [report.deleted.length, report.errors.length?msg("。{0} 件は削除できませんでした", [report.errors.length]):'']));
      return report;
    } finally {selectionBusy=false;if(!disposed) render();}
  };
  if(settings.confirmDelete===false) {void perform();return;}
  selectionBusy=true;updateSelection();
  deleteModal=new DeleteNotesModal(app,targets,settings.previewMode,perform,()=>{
    deleteModal=null;if(disposed) return;selectionBusy=false;updateSelection();
  });deleteModal.open();
};
const confirmSelection=async()=>{
  if(selectionBusy || !selectedPaths.size || (!draftDirty() && moveDraft===null)) return;
  const before=takeSnap(),paths=[...selectedPaths],destination=moveDraft;
  const draft=tagDraft;
  const add=draft && draftDirty()?draft.checked.filter((tag)=>!draft.common.includes(tag)):[];
  const remove=draft && draftDirty()?draft.common.filter((tag)=>!draft.checked.includes(tag)):[];
  selectionBusy=true;closePopup();updateSelection();
  try {
    const tags=add.length||remove.length?await editNoteTags(app,paths,add,remove):{changed:0,errors:[],changes:[]};

    let moves: {moved:{from:string,to:string}[],errors:string[],folders?:{from:string,to:string}[]}={moved:[],errors:[]};
    if(destination!==null) {
      try {moves=await moveSelection(app,paths,[...selectedFolders],destination);} catch {moves.errors=paths;}
    }
    const mapping=new Map(moves.moved.map((entry)=>[entry.from,entry.to]));

    const remap=(path: string)=>mapping.get(path)||path;
    // Tag history follows renamed notes; moving files itself is not a history action.
    before._tagChanges=tags.changes;
    for(const snapshot of [before,...S.undoStack,...S.redoStack]) {
      if(snapshot._selection) snapshot._selection.paths=snapshot._selection.paths.map(remap);
      if(snapshot._selection?.folders) snapshot._selection.folders=snapshot._selection.folders.map((path)=>{const folder=moves.folders?.find((entry)=>path===entry.from || path.startsWith(entry.from+'/'));return folder?folder.to+path.slice(folder.from.length):path;});
      for(const change of snapshot._tagChanges||[]) change.path=remap(change.path);
    }
    if(tags.changes.length) {S.undoStack.push(before);if(S.undoStack.length>UNDO_MAX) S.undoStack.shift();S.redoStack=[];}
    const errors=new Set([...tags.errors,...moves.errors]).size;
    const numbered=moves.moved.filter((entry)=>entry.from.split('/').pop()!==entry.to.split('/').pop()).length;
    new Notice(msg("タグ変更 {0} 件・移動 {1} 件{2}{3}", [tags.changed, moves.moved.length, numbered?msg("（同名の {0} 件に連番を付与）", [numbered]):'', errors?msg("。{0} 件で適用できない変更がありました", [errors]):'']));
    const failedFolders=[...selectedFolders].filter((folder)=>moves.errors.includes(folder));
    const failedPaths=paths.filter((path)=>tags.errors.includes(path) || moves.errors.includes(path) || failedFolders.some((folder)=>path.startsWith(folder+'/'))).map(remap);
    selectedPaths.clear();failedPaths.forEach((path)=>selectedPaths.add(path));
    selectedFolders.clear();failedFolders.forEach((folder)=>selectedFolders.add(folder));
    selectionMode=selectedPaths.size>0;tagDraft=null;moveDraft=null;
    revision++;pagesCache=null;S.tagCache=null;
  } finally {selectionBusy=false;if(!disposed) render();}
};
const editSelectionTags=()=>{
  if(selectionBusy || !selectedPaths.size) return;
  tagDraft=tagDraft||prepareTagDraft();
  const selected=new Set(tagDraft.checked);
  openTagDropdown( (selectionBar!.querySelector('.kv-selection-edit') as HTMLButtonElement),'',()=>{},{onMultiSelect:(checked)=>{
    tagDraft!.checked=checked;updateSelection();
  },selected,disabled:new Set(tagDraft.partial),extraTags:[...tagDraft.common,...tagDraft.partial],counts:tagDraft.counts,total:tagDraft.total,beforeChange:pushUndo});
};
 let pageScrollTimer: number|undefined;
document.addEventListener?.('scroll',(event)=>{
  const target=event.target;
  if(target!==document && !(target instanceof window.Element && target!==container && target.contains(container))) return;
  container.classList.add('kv-page-scrolling');clearTimeout(pageScrollTimer);
  pageScrollTimer=setTimeout(()=>container.classList.remove('kv-page-scrolling'),180);
},{capture:true,passive:true,signal:lifetime.signal});
const layouts = new Set( ([] as (()=>void)[]));

let pagesCache: Page[]|null = null;
const timers = new Set( ([] as number[]));

const setTimeout = (fn: ()=>void, delay: number) => { const id = window.setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, delay); timers.add(id); return id; };

const clearTimeout = (id: number|undefined|null) => { window.clearTimeout(id ?? undefined); if(id!=null) timers.delete(id); };

const getPages = (): Page[] => pagesCache || (pagesCache = app.vault.getMarkdownFiles().map((file) => {
  const cache = app.metadataCache.getFileCache(file);
  const tags = new Set( ([] as string[]));
  for (const tag of (cache ? getAllTags(cache) || [] : [])) {
    const parts = tag.replace(/^#/, '').split('/');
    for (let i = 1; i <= parts.length; i++) tags.add('#' + parts.slice(0, i).join('/'));
  }
  const frontmatter=record(cache?.frontmatter);
  return {file:{path:file.path, name:file.basename, folder:file.parent?.path === '/' ? '' : file.parent?.path || '', tags:[...tags], mtime:file.stat.mtime, ctime:file.stat.ctime, property:parseIsoTimestamp(frontmatter[settings.dateProperty]),...(settings.showDateGuidance!==false && !dateGuidanceShown.has(settings.dateProperty)?{propertyPresent:Object.hasOwn(frontmatter,settings.dateProperty),metadataReady:cache!==null && cache!==undefined}:{})}};
}));
const refreshLater = () => scheduleRefresh();
let renderedPagesKey: string|null=null;let pendingRefresh=false,forceRefresh=false;
const scheduleRefresh = (() => { let timer: number|undefined=0; return () => { clearTimeout(timer); timer = setTimeout(()=>{
  if(document.hidden || container.clientWidth===0 || container.isConnected===false) {pendingRefresh=true;return;}
  pendingRefresh=false;
  if(forceRefresh || JSON.stringify(getPages())!==renderedPagesKey) {forceRefresh=false;render();}
},150); }; })();
const resumeView=()=>{
  dragCleanup?.();dragCleanup=null;container.classList?.remove('kv-page-scrolling');
  container.querySelectorAll?.('.kv-scroll-rail.is-dragging').forEach((el)=>el.dispatchEvent(new window.Event('pointercancel')));
  if(pendingRefresh) refreshLater();
};
document.addEventListener?.('visibilitychange',()=>{if(!document.hidden) resumeView();},{signal:lifetime.signal});
window.addEventListener?.('focus',resumeView,{signal:lifetime.signal});
const takeSaved = () => deepClone({searchTree:S.searchTree,formula:S.formula,textQuery:S.textQuery,dateField:S.dateField,sortField:S.sortField,sortOrder:S.sortOrder,dateFrom:S.dateFrom,dateTo:S.dateTo,noTagOnly:S.noTagOnly,density:S.density,previewChars:S.previewChars,folderFilters:S.folderFilters,groupByFolder:S.groupByFolder,folderGroupState:S.folderGroupState,tagGroupState:S.tagGroupState});
const PAGE_SIZE     = 30;
const PREVIEW_CHARS = 150;
const UNDO_MAX      = 50;

// 非同期競合防止：レンダリングのシーケンス番号

const S: ViewState = {
    searchTree      : { type: 'and', id: 'root', children: [] },
    formula         : '',
    formulaError    : '',
    dateField       : 'mtime',
    sortField       : 'mtime', // 'property'|'mtime'|'name'
    sortOrder       : 'desc',
    dateFrom        : '',
    dateTo          : '',
    noTagOnly       : false,
    density         : 'normal',
    previewChars    : PREVIEW_CHARS,
    groupByFolder   : false,
    folderFilters   : [],
    folderGroupState: {},
    tagGroupState   : {},
    resultTreeOpen  : {},
    resultTreeLimits: {},
    limit           : PAGE_SIZE,
    textQuery       : '',
    tagCache        : null,
    tagRevision     : null,
    contentCache    : {},
    undoStack       : [],
    redoStack       : [],
};
Object.assign(S, readState(saved));
if(typeof S.textQuery!=='string') S.textQuery='';
S.textQuery=S.textQuery.trim();
if(S.previewChars===120 && !settings.previewLengths?.includes(120)) S.previewChars=150;
if (!['property','mtime'].includes(S.dateField)) S.dateField='mtime';
if (!['property','mtime','name'].includes(S.sortField)) S.sortField='mtime';
if (!Array.isArray(S.folderFilters)) S.folderFilters = [];
if (!S.searchTree || !S.searchTree.type) S.searchTree = { type:'and', id:'root', children:[] };
if (!S.searchTree.id) S.searchTree.id = 'root';

const debounce = (fn: ()=>void, ms: number) => { let t: number|undefined=0; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const genId    = () => Math.random().toString(36).slice(2, 8);

// structuredClone with fallback
const deepClone = clone;

const toMs = (val: unknown) => {
  if (val==null) return NaN;
  const object=record(val);
  if (typeof object.toMillis === 'function') {const result= (object.toMillis as ()=>unknown).call(val);return typeof result==='number'?result:NaN;}
  if (typeof val==='object') {const result=val.valueOf();return typeof result==='number'?result:NaN;}
  if (typeof val === 'number') return val;
  return new Date(String(val)).getTime();
};

const relDate = (val: unknown) => {
  const ms = toMs(val);
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return msg("未来");
  const m = Math.floor(diff / 60000);
  if (m < 1)   return msg("たった今");
  if (m < 60)  return msg("{0}分前", [m]);
  const h = Math.floor(m / 60);
  if (h < 24)  return msg("{0}時間前", [h]);
  const d = Math.floor(h / 24);
  if (d < 30)  return msg("{0}日前", [d]);
  const mo = Math.floor(d / 30);
  if (mo < 12) return msg("{0}ヶ月前", [mo]);
  return msg("{0}年前", [Math.floor(mo / 12)]);
};

const stripContent = (raw: string) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/!\[\[[^\]]+\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,  (_: string, target: string, alias: string) => alias || target).replace(/[#*`>_~]/g, '').trim();

const extractThumb = (raw: string) => { const wiki = raw.match(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/); const md = raw.match(/!\[[^\]]*\]\(<?([^>\s)]+)>?(?:\s+"[^"]*")?\)/); return wiki ? wiki[1] : md ? md[1] : null; };

const findById = (tree: TagNode, id: string): {node:TagNode,parentArr:TagNode[]|null}|null => {
  if (tree.id === id) return { node: tree, parentArr: null };

const search = (node: TagNode, parentArr: TagNode[]): {node:TagNode,parentArr:TagNode[]}|null => {
    if (node.id === id) return { node, parentArr };
    for (const child of (node.children || [])) {
      const r = search(child, node.children!);
      if (r) return r;
    }
    return null;
  };
  for (const child of (tree.children || [])) {
    const r = search(child, tree.children!);
    if (r) return r;
  }
  return null;
};

const addNode = (parentId: string|null, newNode: TagNode) => {
  const parent = findById(S.searchTree, parentId || S.searchTree.id)?.node;
  if (!parent?.children || (parent.type === 'not' && parent.children.length)) return;
  pushUndo();
  if (parentId === null || parentId === 'root' || parentId === S.searchTree.id) {
    S.searchTree.children!.push(newNode);
  } else {
    const found = findById(S.searchTree, parentId);
    if (found && found.node.children !== undefined) {
      found.node.children.push(newNode);
    }
  }
  syncFormulaFromTree();
  render();
};

const removeNode = (id: string) => {
  pushUndo();
  const found = findById(S.searchTree, id);
  if (found && found.parentArr) {
    const idx = found.parentArr.indexOf(found.node);
    if (idx !== -1) found.parentArr.splice(idx, 1);
  }
  syncFormulaFromTree();
  render();
};

const updateNodeTag = (id: string, tag: string) => {
  pushUndo();
  const found = findById(S.searchTree, id);
  if (found) found.node.tag = tag;
  syncFormulaFromTree();
  render();
};

const changeType = (id: string, newType: string) => {
  pushUndo();
  const found = findById(S.searchTree, id);
  if (!found) return;
  const node = found.node;
  if (newType === 'tag') {
    node.type = 'tag'; node.tag = ''; delete node.children;
  } else if (node.type === 'tag') {
    node.type = newType; node.children = []; delete node.tag;
  } else {
    node.type = newType;
    if (newType === 'not' && (node.children||[]).length > 1) node.children = [node.children![0]];
  }
  syncFormulaFromTree();
  render();
};

// ノードをルートの上または下に並列配置

const moveToRootLevel = (nodeId: string, position: string) => {
  // position: 'before' | 'after'
  pushUndo();
  const found = findById(S.searchTree, nodeId);
  if (!found || !found.parentArr) return;

  const node = deepClone(found.node);

  // 元の位置から削除
  const srcIdx = found.parentArr.indexOf(found.node);
  if (srcIdx !== -1) found.parentArr.splice(srcIdx, 1);

  // 元のルートを新しいANDで包む
  const oldRoot = deepClone(S.searchTree);
  const newRoot = {
    type: 'and',
    id: genId(),
    children: position === 'before'
      ? [node, oldRoot]
      : [oldRoot, node],
  };
  S.searchTree = newRoot;
  syncFormulaFromTree();
  render();
};

// 通常のノード移動

const moveNode = (nodeId: string, destParentId: string|null, destIndex: number) => {
  const source = findById(S.searchTree, nodeId);
  const destination = findById(S.searchTree, destParentId || S.searchTree.id);
  if (!source?.parentArr || !destination?.node.children || findById(source.node, destination.node.id)) return;
  if (destination.node.type === 'not' && destination.node.children.length && !destination.node.children.some((n) => n.id === nodeId)) return;
  pushUndo();
  const src = findById(S.searchTree, nodeId);
  if (!src || !src.parentArr) return;

  const node = deepClone(src.node);
  const srcIdx = src.parentArr.indexOf(src.node);
  if (srcIdx !== -1) src.parentArr.splice(srcIdx, 1);

  let destArr;
  if (destParentId === null || destParentId === S.searchTree.id) {
    destArr = S.searchTree.children!;
  } else {
    const destFound = findById(S.searchTree, destParentId);
    if (!destFound) return;
    destArr = destFound.node.children;
    if (!destArr) return;
  }

  let idx = destIndex;
  if (destArr === src.parentArr && srcIdx < idx) idx--;
  destArr.splice(Math.max(0, idx), 0, node);

  syncFormulaFromTree();
  render();
};

const SNAP_KEYS =  (['searchTree','formula','textQuery','dateField','sortField','sortOrder','dateFrom','dateTo','noTagOnly','density','previewChars','folderFilters','groupByFolder'] as const);

const takeSnap = (): Snapshot => {
  const s= (takeSaved() as Snapshot);
  s._selection={mode:selectionMode,paths:[...selectedPaths],folders:[...selectedFolders],draft:deepClone(tagDraft),destination:moveDraft};return s;
};

const applySnap = (s: Snapshot) => {
  Object.assign(S,Object.fromEntries(SNAP_KEYS.filter((k)=>s[k]!==undefined).map((k)=>[k,s[k]])));S.formulaError='';
  if(s._selection) {
    selectionMode=s._selection.mode;selectedPaths.clear();s._selection.paths.forEach((path)=>selectedPaths.add(path));
    selectedFolders.clear();(s._selection.folders||[]).forEach((path)=>selectedFolders.add(path));
    tagDraft=deepClone(s._selection.draft);moveDraft=s._selection.destination??null;
  }
};
const pushUndo = () => {S.undoStack.push(takeSnap());if(S.undoStack.length>UNDO_MAX) S.undoStack.shift();S.redoStack=[];};

const travelHistory = (from: Snapshot[],to: Snapshot[]) => {
  if(selectionBusy || !from.length) return;
  const snapshot=from.pop()!,inverse=takeSnap();
  if(!snapshot._tagChanges) {to.push(inverse);applySnap(snapshot);render();return;}
  selectionBusy=true;closePopup();updateSelection();
  return restoreTagChanges(app,snapshot._tagChanges).then((report)=>{
    if(report.inverse.length) {inverse._tagChanges=report.inverse;to.push(inverse);applySnap(snapshot);}
    if(report.errors.length) new Notice(msg("{0} 件はタグの変更・削除などにより戻せませんでした", [report.errors.length]));
    revision++;pagesCache=null;S.tagCache=null;
  }).finally(()=>{selectionBusy=false;if(!disposed) render();});
};
const doUndo = () => travelHistory(S.undoStack,S.redoStack);
const doRedo = () => travelHistory(S.redoStack,S.undoStack);

const refreshTagCache = () => {
  const rev = revision;
  if (S.tagRevision === rev && S.tagCache) return;
   const counts: Record<string,number> = dictionary();
  getPages().forEach((p) => {
    (p.file.tags || []).forEach((t) => {
      const tag = String(t).replace(/^#/, '');
      counts[tag] = (counts[tag] ?? 0) + 1;
    });
  });
  S.tagCache = counts; S.tagRevision = rev;
};

const buildFolderTree = () => {
   const root: Record<string,FolderNode> = dictionary();
  getPages().forEach((p) => {
    const parts = p.file.folder.split('/').filter(Boolean);
    let node = root; let path = '';
    parts.forEach((part) => {
      path = path ? path+'/'+part : part;
      if (!node[part]) node[part] = { name:part, path, children:dictionary() };
      node = node[part].children;
    });
  });
  return root;
};

const nodeToFormula = (node: TagNode, isRoot: boolean): string => {
  if (!node) return '';
  const t = node.type;
  if (t === 'tag') return node.tag ? '#' + node.tag.replace(/^#/,'') : '';
  if (t === 'not') {
    const child = (node.children||[])[0]; if (!child) return '';
    const inner = nodeToFormula(child, false); if (!inner) return '';
    return 'NOT ' + (child.type==='and'||child.type==='or' ? '('+inner+')' : inner);
  }
  if (t === 'and') {
    const parts = (node.children||[]).map((c)=>nodeToFormula(c,false)).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return isRoot ? parts.join(' AND ') : '(' + parts.join(' AND ') + ')';
  }
  if (t === 'or') {
    const parts = (node.children||[]).map((c)=>nodeToFormula(c,false)).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return isRoot ? parts.join(' OR ') : '(' + parts.join(' OR ') + ')';
  }
  return '';
};

const treeToFormula   = () => nodeToFormula(S.searchTree, true);
const syncFormulaFromTree = () => { S.formula = treeToFormula(); S.formulaError = ''; };

const tokenize = (str: string): Token[] => {
  const t=[]; let i=0;
  while(i<str.length){
    if(/\s/.test(str[i])){i++;continue;}
    if(str[i]==='('){t.push({type:'LPAREN'});i++;continue;}
    if(str[i]===')'){t.push({type:'RPAREN'});i++;continue;}
    if(str.slice(i,i+3).toUpperCase()==='AND'&&(!str[i+3]||/[\s(]/.test(str[i+3]))){t.push({type:'AND'});i+=3;continue;}
    if(str.slice(i,i+2).toUpperCase()==='OR' &&(!str[i+2]||/[\s(]/.test(str[i+2]))){t.push({type:'OR' });i+=2;continue;}
    if(str.slice(i,i+3).toUpperCase()==='NOT'&&(!str[i+3]||/[\s(]/.test(str[i+3]))){t.push({type:'NOT'});i+=3;continue;}
    const m=str.slice(i).match(/^#?[^\s()#]+/u);
    if(m){t.push({type:'TAG',value:m[0].replace(/^#/,'')});i+=m[0].length;continue;}
    throw new Error(msg("不明な文字: {0}", [str[i]]));
  }
  return t;
};

const ensureId = (node: TagNode): TagNode => { if(!node.id) node.id=genId(); if(node.children) node.children=node.children.map(ensureId); return node; };

const parseFormula = (input: string): TagNode => {
  const str = input.trim();
  if (!str) return { type:'and', id:'root', children:[] };
  const tokens = tokenize(str);
  const result = parseOr(tokens, 0);
  if (result.pos < tokens.length) throw new Error(msg("式の形式が正しくありません"));
  return result.node.type === 'tag'
    ? { type:'and', id:'root', children:[ensureId(result.node)] }
    : ensureId(result.node);
};

const parseOr=(t: Token[],p: number): ParsedNode=>{let{node:l,pos:p2}=parseAnd(t,p);while(p2<t.length&&t[p2].type==='OR'){p2++;const{node:r,pos:p3}=parseAnd(t,p2);p2=p3;l=l.type==='or'?{type:'or',id:genId(),children:[...l.children!,r]}:{type:'or',id:genId(),children:[l,r]};}return{node:l,pos:p2};};

const parseAnd=(t: Token[],p: number): ParsedNode=>{let{node:l,pos:p2}=parseNot(t,p);while(p2<t.length&&t[p2].type==='AND'){p2++;const{node:r,pos:p3}=parseNot(t,p2);p2=p3;l=l.type==='and'?{type:'and',id:genId(),children:[...l.children!,r]}:{type:'and',id:genId(),children:[l,r]};}return{node:l,pos:p2};};

const parseNot=(t: Token[],p: number): ParsedNode=>{if(p<t.length&&t[p].type==='NOT'){const{node:c,pos:p2}=parseNot(t,p+1);return{node:{type:'not',id:genId(),children:[c]},pos:p2};}return parsePrimary(t,p);};

const parsePrimary=(t: Token[],p: number): ParsedNode=>{if(p>=t.length)throw new Error(msg("式が不完全です"));if(t[p].type==='LPAREN'){const{node,pos:p2}=parseOr(t,p+1);if(p2>=t.length||t[p2].type!=='RPAREN')throw new Error(msg(") が不足しています"));return{node,pos:p2+1};}if(t[p].type==='TAG')return{node:{type:'tag',id:genId(),tag:t[p].value},pos:p+1};throw new Error(msg("予期しないトークン: {0}", [t[p].type]));};

const syncTreeFromFormula = (str: string) => {
  try { S.searchTree=parseFormula(str); S.formulaError=''; }
  catch(e) { S.formulaError=errorMessage(e); }
};

const evalNode = (node: TagNode, tags: string[]): boolean => {
  if (!node) return true;
  const t = node.type;
  if (t==='and') return (node.children||[]).every((c)=>evalNode(c,tags));
  if (t==='tag') { const tag=(node.tag||'').replace(/^#/,'').toLowerCase(); return tags.some((pt)=>pt.replace(/^#/,'').toLowerCase()===tag); }
  if (t==='not') return !(node.children||[]).some((c)=>evalNode(c,tags));
  if (t==='or')  return (node.children||[]).some((c)=>evalNode(c,tags));
  return true;
};

const getContent = (p: Page): ContentEntry => {
  const key = p.file.path + '::' + p.file.mtime;
  if (S.contentCache[key]) return S.contentCache[key];
  const entry =  ({summary:'', thumb:null, loading:true,promise:Promise.resolve()} as ContentEntry);
  S.contentCache[key] = entry;
  const file = app.vault.getAbstractFileByPath(p.file.path);
  entry.promise = (isFile(file) ? app.vault.cachedRead(file) : Promise.resolve('')).then((raw) => {
    entry.summary = stripContent(raw); entry.markdown = markdownBody(raw); entry.thumb = extractThumb(raw);
  }).catch(() => { entry.summary = msg("プレビューを読み込めませんでした"); }).finally(() => { entry.loading = false; });
  return entry;
};

let _activePopup: Popup|null    = null;

let _activeAbortCtrl: AbortController|null = null;

const closePopup = () => {
  _activePopup?._cleanup?.();
  if (_activePopup) { _activePopup.remove(); _activePopup = null; }
  if (_activeAbortCtrl) { _activeAbortCtrl.abort(); _activeAbortCtrl = null; }
};

const openPopup = (anchorEl: HTMLElement, buildFn: (popup:Popup)=>void, opts: {minWidth?:string}={}): Popup => {
  closePopup();
  const popup =  ((anchorEl.closest('.modal') || document.body).createDiv({cls:'keep-view-root kv-dropdown'}) as Popup);
  if (opts.minWidth) popup.style.minWidth = opts.minWidth;
  _activePopup = popup;
  buildFn(popup);
  const popupWidth=Math.max(parseFloat(opts.minWidth || '220'),Math.min(320,popup.getBoundingClientRect().width));
  popup._anchor = anchorEl;
  const ctrl = new AbortController();
  _activeAbortCtrl = ctrl;
  const position = () => {
    const anchor = popup._anchor;
    if (!anchor?.isConnected) { closePopup(); return; }
    const rect = anchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || window.innerWidth);
    const bottom = top + (viewport?.height || window.innerHeight);
    // A scrolled-away anchor must not leave a floating menu on the screen.
    let visibleTop = top, visibleBottom = bottom;
    for (let parent=anchor.parentElement; parent; parent=parent.parentElement) {
      if (/(auto|scroll|hidden)/.test(window.getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect();
        visibleTop = Math.max(visibleTop,bounds.top); visibleBottom = Math.min(visibleBottom,bounds.bottom);
      }
    }
    popup.style.visibility = rect.bottom<=visibleTop || rect.top>=visibleBottom ? 'hidden' : '';
    const below = Math.max(0,bottom-rect.bottom-8), above = Math.max(0,rect.top-top-8);
    const upward = below < Math.min(240,popup.scrollHeight) && above > below;
    popup.style.maxHeight = Math.min(340,Math.max(0,bottom-top-16),upward?above:below)+'px';
    popup.style.minWidth = Math.min(parseFloat(opts.minWidth || '220'),right-left-16)+'px';
    popup.style.maxWidth = Math.min(320,right-left-16)+'px';
    popup.style.width=Math.min(popupWidth,right-left-16)+'px';
    popup.style.left = Math.max(left+8,Math.min(rect.left,right-popup.offsetWidth-8))+'px';
    let popupTop=upward ? rect.top-popup.offsetHeight-4 : rect.bottom+4;
    if(popup.contains(document.activeElement)) popupTop=Math.max(top+8,Math.min(popupTop,bottom-popup.offsetHeight-8));
    popup.style.top = popupTop+'px';
  };
  popup._reposition = position;
  const popupObserver = new window.ResizeObserver(position);
  popupObserver.observe(popup);
  const releaseTooltips=suppressHoverTooltips(popup);
  popup._cleanup = () => {popupObserver.disconnect();releaseTooltips();};
  const viewportResized = () => {
    // When the keyboard covers the anchor, scroll the note view enough to keep
    // both the button and a usable part of its menu above the keyboard.
    if (popup.contains(document.activeElement) || popup._anchor===document.activeElement) {
      const viewport=window.visualViewport;
      const top=viewport?.offsetTop || 0;
      const bottom=top+(viewport?.height || window.innerHeight);
      const rect=popup._anchor?.getBoundingClientRect();
      const scroller=getScrollContainer();
      if (rect && scroller) {
        if (rect.bottom>bottom-100) scroller.scrollTop+=rect.bottom-(bottom-100);
        else if (rect.top<top+8) scroller.scrollTop+=rect.top-(top+8);
      }
    }
    position();
    const input=popup.querySelector('.kv-dropdown-search');
    if(input===document.activeElement) popup.scrollTop=0;
  };
  document.addEventListener('scroll', position, {capture:true,signal:ctrl.signal});
  window.addEventListener('resize', viewportResized, {signal:ctrl.signal});
  window.visualViewport?.addEventListener('resize',viewportResized,{signal:ctrl.signal});
  window.visualViewport?.addEventListener('scroll',viewportResized,{signal:ctrl.signal});
  popup.addEventListener('focusin',()=>{
    viewportResized();
  },{signal:ctrl.signal});
  document.addEventListener('keydown', (e) => { if (e.key==='Escape') { closePopup(); popup._anchor?.focus(); } }, {signal:ctrl.signal});
  position();
  setTimeout(() => {
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof window.Node && !popup.contains(e.target) && !popup._anchor?.contains(e.target)) closePopup();
    }, { signal: ctrl.signal });
  }, 0);

  return popup;
};

const openTagDropdown = (anchorEl: HTMLElement, currentTag: string|undefined, onSelect: (tag:string)=>void, options: {selected?:Set<string>,disabled?:Set<string>,extraTags?:string[],counts?:Record<string,number>,total?:number,beforeChange?:()=>void,apply?:()=>void,onMultiSelect?:(tags:string[])=>void}={}) => {
  if(options.selected) {
    const tags=new Set([...options.selected,...(options.disabled||[]),...Object.keys(options.counts||{}).filter((tag)=>options.counts![tag]>0)]);
    for(const tag of tags) {const parts=tag.split('/');for(let i=1;i<=parts.length;i++) S.tagGroupState[parts.slice(0,i).join('/')]=true;}
  }
  openPopup(anchorEl, (popup) => {
    const searchInput = popup.createEl('input', {cls:'kv-dropdown-search', type:'text', placeholder:msg("タグを検索...")});
    const listEl = popup.createDiv();
     let applyButton: HTMLButtonElement|null=null;

    const choose=(tag: string)=>{
      if(options.disabled?.has(tag)) return;
      options.beforeChange?.();
      if(options.selected) {
        if(options.selected.has(tag)) options.selected.delete(tag);else options.selected.add(tag);
        options.onMultiSelect?.([...options.selected]);renderList(searchInput.value);
        if(applyButton) applyButton.disabled=!options.selected.size;
      } else {onSelect(tag);closePopup();}
    };

    const mark=(row: HTMLElement,tag: string)=>{
      if(!options.selected) return;
      const check=dropdownCheckbox(row,{label:tag,checked:options.selected.has(tag)});
      check.disabled=options.disabled?.has(tag)||false;
      if(check.disabled) check.checked=true;
      row.classList.toggle('is-partial',check.disabled);
      check.setAttribute('aria-label',tag);check.onclick=(event)=>{event.stopPropagation();choose(tag);};
      row.classList.toggle('is-selected',check.checked);
      const count=options.counts && Object.hasOwn(options.counts,tag)?options.counts[tag]:0;
      if(count>0) row.createSpan({cls:'kv-tag-count',text:msg("{0}/{1}", [count, options.total])});
    };

    const renderTagNode = (container: HTMLElement, prefix: string, depth: number, filterText: string) => {
      const all = [...new Set([...Object.keys(S.tagCache||{}),...(options.extraTags||[])])].sort();
       const groups: Record<string,string[]> = dictionary(); const leaves =  ([] as string[]);
      all.forEach((tag) => {
        if (filterText && !tag.toLowerCase().includes(filterText.toLowerCase())) return;
        if (prefix) {
          if (!tag.startsWith(prefix+'/')) return;
          const rel = tag.slice(prefix.length+1);
          if (rel.includes('/')) { const g=prefix+'/'+rel.split('/')[0]; if(!groups[g]) groups[g]=[]; groups[g].push(tag); }
          else leaves.push(tag);
        } else {
          if (tag.includes('/')) { const g=tag.split('/')[0]; if(!groups[g]) groups[g]=[]; groups[g].push(tag); }
          else leaves.push(tag);
        }
      });

      Object.keys(groups).sort().forEach((groupPath) => {
        const isOpen = S.tagGroupState[groupPath] ?? false;
        const row = container.createDiv({cls:'kv-dropdown-item is-group'});
        mark(row,groupPath);
        for(let i=0;i<depth;i++) row.createSpan({cls:'kv-dropdown-indent'});
        const toggle = disclosureIcon(row,isOpen);
        const label = row.createSpan({text:groupPath.split('/').pop()+'/'});
        label.onclick = (e) => { e.stopPropagation(); choose(groupPath); };
        toggle.onclick = (e) => {
          e.stopPropagation();
          animateDisclosure(toggle,!toggle.classList.contains('is-open'),(open)=>{S.tagGroupState[groupPath]=open;listEl.empty();renderTagNode(listEl,'',0,filterText);});
        };
        // グループ行クリックでもトグル（トグルボタンの判定を広げる）
        row.onclick = (e) => {
          if (e.target === toggle) return;
          e.stopPropagation();
          animateDisclosure(toggle,!toggle.classList.contains('is-open'),(open)=>{S.tagGroupState[groupPath]=open;listEl.empty();renderTagNode(listEl,'',0,filterText);});
        };
        if (isOpen || filterText) renderTagNode(container, groupPath, depth+1, filterText);
      });

      leaves.forEach((tag) => {
        const row = container.createDiv({cls:'kv-dropdown-item'});
        mark(row,tag);
        for(let i=0;i<depth;i++) row.createSpan({cls:'kv-dropdown-indent'});
        row.createSpan({text:'#'+tag});
        row.onclick = (e) => { e.stopPropagation(); choose(tag); };
      });

      if (!Object.keys(groups).length && !leaves.length) {
        const el = container.createDiv({cls:'kv-dropdown-item', text:msg("該当するタグなし")});
        el.classList.add('kv-empty-tag');
      }
    };

    const renderList = (filter: string) => { listEl.empty(); renderTagNode(listEl,'',0,filter); };
    renderList('');
    if(options.apply) {
      applyButton=popup.createEl('button',{cls:'kv-btn kv-tag-apply',text:msg("追加する")});
      applyButton.disabled=true;applyButton.onclick=options.apply;
    }
    searchInput.oninput = debounce(()=>renderList(searchInput.value), 150);
    // Opening a tag menu on touch screens should not summon the keyboard.
    if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(()=>searchInput.focus({preventScroll:true}), 30);
  });
};

const openFolderDropdown = (anchorEl: HTMLElement) => {

  let popupEl: Popup|null = null;

  const rebuild = () => { if (!popupEl) return; popupEl.empty(); buildContent(popupEl); };

  const buildContent = (container: HTMLElement) => {
    const folderTree = buildFolderTree();

    // 全フォルダパスを収集（再帰）

    const getAllPaths = (nodeObj: FolderNode): string[] => {
      const paths = [nodeObj.path];
      Object.values(nodeObj.children).forEach((child) => paths.push(...getAllPaths(child)));
      return paths;
    };
    const allPaths = ['',...Object.values(folderTree).flatMap((n) => getAllPaths(n))];
    const allSelected = allPaths.every((p) => S.folderFilters.includes(p));

    // すべて選択/解除
    const allRow = container.createDiv({cls:'kv-dropdown-item'+(S.folderFilters.length===0?' is-selected':'')});
    dropdownCheckbox(allRow,{label:msg("すべて"),checked:allSelected});
    allRow.createSpan({text:msg("すべて")});
    allRow.onclick = (e) => {
      e.stopPropagation();
      pushUndo();
      S.folderFilters = S.folderFilters.length?[]:allPaths;
      S.limit=PAGE_SIZE; rebuild(); render();
    };

    const {item:rootRow} = folderDropdownRow(container,{name:msg("(ルート)"),selected:S.folderFilters.includes('')});
    rootRow.onclick = (e) => { e.stopPropagation(); pushUndo(); S.folderFilters = S.folderFilters.includes('') ? S.folderFilters.filter((p) => p !== '') : [...S.folderFilters, '']; S.limit=PAGE_SIZE; rebuild(); render(); };

    const renderFolderNode = (nodeObj: FolderNode, depth: number) => {
      const hasChildren = Object.keys(nodeObj.children).length > 0;
      const isOpen = S.folderGroupState[nodeObj.path] ?? false;
      const isSelected = S.folderFilters.includes(nodeObj.path);
      // 子パスを全取得
      const childPaths = hasChildren
        ? Object.values(nodeObj.children).flatMap((c) => getAllPaths(c))
        : [];

      const {item,toggle}=folderDropdownRow(container,{name:nodeObj.name,selected:isSelected,depth,children:hasChildren,open:isOpen});

      if(hasChildren) toggle.onclick = (e) => { e.stopPropagation();animateDisclosure(toggle,!toggle.classList.contains('is-open'),(open)=>{S.folderGroupState[nodeObj.path]=open;rebuild();}); };

      item.onclick = (e) => {
        e.stopPropagation();
        if (hasChildren && e.target === toggle) return;
        pushUndo();
        const idx = S.folderFilters.indexOf(nodeObj.path);
        if (idx !== -1) {
          // 解除：自身と子孫を全解除
          S.folderFilters = S.folderFilters.filter((p) =>
            p !== nodeObj.path && !childPaths.includes(p)
          );
        } else {
          // 選択：自身と子孫を全選択
          const toAdd = [nodeObj.path, ...childPaths].filter((p) => !S.folderFilters.includes(p));
          S.folderFilters.push(...toAdd);
        }
        S.limit=PAGE_SIZE; rebuild(); render();
      };

      if (hasChildren && isOpen) {
        Object.values(nodeObj.children)
          .sort((a,b)=>a.name.localeCompare(b.name))
          .forEach((child)=>renderFolderNode(child, depth+1));
      }
    };

    Object.values(folderTree)
      .sort((a,b)=>a.name.localeCompare(b.name))
      .forEach((node)=>renderFolderNode(node, 0));
  };

  popupEl = openPopup(anchorEl, buildContent, {minWidth:'240px'});
  popupEl._isFolderDropdown = true;
};

const openTypePopup = (anchorEl: HTMLElement, nodeId: string|null, currentType: string, isRoot: boolean) => {
  openPopup(anchorEl, (popup) => {
    popup.classList.add('kv-type-popup');
    [{type:'tag',label:'TAG',cls:'kv-node-type-tag'},{type:'and',label:'AND',cls:'kv-node-type-and'},
     {type:'or',label:'OR',cls:'kv-node-type-or'},{type:'not',label:'NOT',cls:'kv-node-type-not'}]
    .forEach(({type,label,cls}) => {
      if (type===currentType) return;
      if (isRoot && type==='tag') return;
      popup.createSpan({cls:`kv-node-type ${cls}`,text:msg(label)})
        .onclick = (e) => {
          e.stopPropagation();
          closePopup();
          if (isRoot) changeType(S.searchTree.id, type);
          else changeType(nodeId!, type);
        };
    });
  });
};

// zones: { lineEl, parentId, index, isRootLevel }
type DropZone = {lineEl:HTMLElement,parentId:string|null,index:number,isRootLevel:boolean};
const _zones =  ([] as DropZone[]);
const clearZones = () => { _zones.length = 0; };

const registerZone = (lineEl: HTMLElement, parentId: string|null, index: number, isRootLevel: boolean=false) => {
  _zones.push({lineEl, parentId, index, isRootLevel});
};

let _activeLine: HTMLElement|null = null;
const clearHighlight = () => { if(_activeLine){_activeLine.classList.remove('is-visible');_activeLine=null;} };

const getNearestZone = (clientY: number): DropZone|null => {
   let best: DropZone|null=null;let bestDist=Infinity;
  _zones.forEach((z)=>{
    const r = z.lineEl.getBoundingClientRect();
    const cy = r.top + r.height/2;
    const dist = Math.abs(clientY-cy);
    if(dist<bestDist){bestDist=dist;best=z;}
  });
  return bestDist < 60 ? best : null;
};

const setupDragHandle = (handleEl: HTMLElement, nodeId: string) => {
  handleEl.addEventListener('pointerdown', (e) => {
    if (e.button!==0) return;
    e.preventDefault(); e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);
    const row = handleEl.closest('.kv-node-row')!;

    const srcFound = findById(S.searchTree, nodeId);
    if (!srcFound) return;

    const ghost = document.body.createDiv({cls:'kv-drag-ghost'});
    ghost.textContent = srcFound.node.type==='tag' ? ('#'+(srcFound.node.tag||'?')) : msg(srcFound.node.type.toUpperCase());
    document.body.appendChild(ghost);

    const upd = (cx: number,cy: number) => { ghost.style.left=(cx+12)+'px'; ghost.style.top=(cy-10)+'px'; };
    upd(e.clientX, e.clientY);
    row.classList.add('is-dragging');

    const onMove = (e: PointerEvent) => {
      upd(e.clientX, e.clientY);
      clearHighlight();
      const z = getNearestZone(e.clientY);
      if (z) { z.lineEl.classList.add('is-visible'); _activeLine=z.lineEl; }
    };

    const onUp = (e: PointerEvent) => {
      dragCleanup?.();
      dragCleanup = null;
      if (e.type !== 'pointerup') return;
      const zone = getNearestZone(e.clientY);
      if (!zone) return;

      if (zone.isRootLevel) {
        // ルートの外側ゾーン → ルートと並列配置
        moveToRootLevel(nodeId, zone.index === 0 ? 'before' : 'after');
      } else {
        moveNode(nodeId, zone.parentId, zone.index);
      }
    };
    dragCleanup = () => {
      ghost.remove(); clearHighlight(); row.classList.remove('is-dragging');
      handleEl.removeEventListener('pointermove', onMove); handleEl.removeEventListener('pointerup', onUp); handleEl.removeEventListener('pointercancel', onUp);handleEl.removeEventListener('lostpointercapture',onUp);
      if(handleEl.hasPointerCapture(e.pointerId)) handleEl.releasePointerCapture(e.pointerId);
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup',   onUp);
    handleEl.addEventListener('pointercancel', onUp);
    handleEl.addEventListener('lostpointercapture', onUp);
  });
};

window.addEventListener?.('blur',()=>{dragCleanup?.();dragCleanup=null;container.querySelectorAll('.kv-scroll-rail.is-dragging').forEach((el)=>el.dispatchEvent(new window.Event('pointercancel')));},{signal:lifetime.signal});

const renderAddBtn = (container: HTMLElement, parentId: string|null, parentType: string) => {
  const addRow = container.createDiv({cls:'kv-add-row'});
  const indCls = parentType ? `kv-add-indicator-${parentType}` : 'kv-add-indicator-root';
  addRow.createSpan({cls:`kv-add-indicator ${indCls}`});
  const addBtn = addRow.createEl('button', {cls:'kv-node-btn kv-add-btn'});
  setIcon(addBtn.createSpan(),'plus');
  addBtn.createSpan({text:msg('追加')});
  if(parentType==='not') addBtn.setAttribute('aria-label',msg('NOTの対象を追加'));

  let menuEl: HTMLElement|null = null;
  addBtn.onclick = (e) => {
    e.stopPropagation();
    if (menuEl) { menuEl.remove(); menuEl=null; return; }
    menuEl = addRow.createDiv({cls:'kv-node-add-menu'});
    [{type:'tag',label:'TAG',cls:'kv-node-type-tag'},{type:'and',label:'AND',cls:'kv-node-type-and'},
     {type:'or',label:'OR',cls:'kv-node-type-or'},{type:'not',label:'NOT',cls:'kv-node-type-not'}]
    .forEach(({type,label,cls}) => {
      menuEl!.createSpan({cls:`kv-node-type ${cls}`,text:label})
        .onclick = (e) => {
          e.stopPropagation();
          const n =  ({type, id:genId()} as TagNode);
          if (type==='tag') n.tag=''; else n.children=[];
          addNode(parentId, n);
        };
    });
    setTimeout(()=>{ document.addEventListener('click',function h(){if(menuEl){menuEl.remove();menuEl=null;}document.removeEventListener('click',h);}, {signal:lifetime.signal}); },0);
  };
};

const renderTreeNode = (container: HTMLElement, node: TagNode, parentId: string|null, insertIndex: number) => {
  const dl = container.createDiv({cls:'kv-drop-line'});
  registerZone(dl, parentId, insertIndex);

  const nodeEl = container.createDiv({cls:`kv-node kv-node-${node.type}`});
  const row = nodeEl.createDiv({cls:'kv-node-row'});

  const nodeId = node.id;
  const handle = row.createSpan({cls:'kv-drag-handle', text:'⠿'});
  setupDragHandle(handle, nodeId);

  const badge = row.createSpan({cls:`kv-node-type kv-node-type-${node.type}`, text:msg(node.type.toUpperCase())});
  badge.onclick = (e) => { e.stopPropagation(); openTypePopup(badge, nodeId, node.type, false); };

  if (node.type === 'tag') {
    const tagBtn = row.createDiv({
      cls: 'kv-tag-selected' + (!node.tag ? ' is-empty' : ''),
      text: node.tag ? '#'+node.tag : msg("タグを選択"),
    });
    tagBtn.onclick = (e) => {
      e.stopPropagation();
      openTagDropdown(tagBtn, node.tag || '', (tag) => updateNodeTag(nodeId, tag));
    };
  }

  row.createEl('button', {cls:'kv-node-btn is-remove', text:'✕'})
    .onclick = () => removeNode(nodeId);

  if (node.type !== 'tag') {
    const children = node.children || [];
    const isNot = node.type === 'not';

    children.forEach((child, i) => renderTreeNode(nodeEl, child, nodeId, i));

    const dlEnd = nodeEl.createDiv({cls:'kv-drop-line'});
    registerZone(dlEnd, nodeId, children.length);

    // NOT accepts one child; once set, there is no further add action.
    if (!isNot || children.length === 0) {
      renderAddBtn(nodeEl, nodeId, node.type);
    }
  }
};

const renderRootTree = (container: HTMLElement) => {
  clearZones();

  // ルート上のドロップゾーン
  const rootDropBefore = container.createDiv({cls:'kv-root-drop-zone'});
  const lineBefore = rootDropBefore.createDiv({cls:'kv-drop-line'});
  registerZone(lineBefore, null, 0, true);

  // ルートバッジ（左端固定・シンプルに）
  const rootRow = container.createDiv({cls:'kv-node-row kv-root-node-row'});
  const rootBadge = rootRow.createSpan({cls:`kv-node-type kv-node-type-${S.searchTree.type}`, text:msg(S.searchTree.type.toUpperCase())});
  rootBadge.onclick = (e) => { e.stopPropagation(); openTypePopup(rootBadge, null, S.searchTree.type, true); };

  // ルート直下ノード（左端から始まる）
  const rootChildren = container.createDiv({cls:`kv-node kv-node-${S.searchTree.type}`});
  const children = S.searchTree.children!;
  children.forEach((child, i) => {
    const dl = rootChildren.createDiv({cls:'kv-drop-line'});
    registerZone(dl, S.searchTree.id, i);
    renderTreeNode(rootChildren, child, S.searchTree.id, i);
  });
  const dlEnd = rootChildren.createDiv({cls:'kv-drop-line'});
  registerZone(dlEnd, S.searchTree.id, children.length);
  if (S.searchTree.type !== 'not' || !children.length) renderAddBtn(rootChildren, S.searchTree.id, S.searchTree.type);

  // ルート下のドロップゾーン
  const rootDropAfter = container.createDiv({cls:'kv-root-drop-zone'});
  const lineAfter = rootDropAfter.createDiv({cls:'kv-drop-line'});
  registerZone(lineAfter, null, 1, true);
};

// コンテナ幅から列数を計算
// 標準: 1列あたり約220px（カード幅を広く）
const getColCount = (width = container.clientWidth) => {
  if (S.density === 'single') return 1;
  if (width <= 380) return 1;
  if (width <= 600) return 2;
  const containerWidth = width || window.innerWidth;
  const availWidth = Math.max(300, containerWidth - 32);
  const baseCount = Math.max(1, Math.floor(availWidth / 220));
  if (S.density === 'compact') return baseCount + 1;
  if (S.density === 'wide')    return Math.max(1, baseCount - 1);
  return baseCount;
};

// Cards observe their own available width. Rebuilding the header here would
// destroy a focused dropdown during viewport/keyboard transitions.

let previewMeasureContext: CanvasRenderingContext2D|null|undefined;
const fitPreviewLabels=()=>{
  previewMeasureContext??=window.createEl('canvas').getContext('2d');
  if(!previewMeasureContext) return;
  for(const select of container.querySelectorAll<HTMLSelectElement>('.kv-preview-select')) {
    const style=window.getComputedStyle(select),context=previewMeasureContext;
    context.font='12px '+style.fontFamily;
    const available=select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    const required=context.measureText(select.selectedOptions[0].textContent || '').width;
    select.style.fontSize=Math.min(12,Math.max(9,Math.floor(12*available/Math.max(1,required))))+'px';
  }
};
const observer = new window.ResizeObserver(() => {_activePopup?._reposition?.();fitPreviewLabels();if(pendingRefresh && container.clientWidth>0) refreshLater();});
observer.observe(container);

const buildMasonry = (container: HTMLElement, pages: Page[]) => {
  const masonry = container.createDiv({cls:`kv-masonry density-${S.density}`});
  masonry.classList.add('kv-layout-pending');
  const cards =  ([] as HTMLDivElement[]);
  const components= ([] as Component[]);
  const contentObservers= ([] as MutationObserver[]);
  let stopped=false;

  const addCard = (p: Page) => {
    const content = getContent(p);
    const tags = (p.file.tags||[]).map((t)=>String(t));

    const card = masonry.createDiv({cls:'kv-card'});
    cards.push(card);
    card.dataset.path = p.file.path;
    card.tabIndex = 0; card.setAttribute('role', 'link');
     let pressTimer: number|null=null;
     let openTimer: number|null=null;
     let pressOrigin: {x:number,y:number}|null=null;
     let lastTap: {at:number,x:number,y:number}|null=null;
    let suppressClick=false,textSelectionAtDown=false;

    const scrollbarTarget=(event: Event)=>event.target instanceof window.Element?event.target.closest('.kv-scroll-rail'):null;
    const hasTextSelection=()=>{const selection=window.getSelection();return selection && !selection.isCollapsed && (card.contains(selection.anchorNode)||card.contains(selection.focusNode));};
    const cancelOpen=()=>{if(openTimer!==null) clearTimeout(openTimer);openTimer=null;};
    const openCard=()=>{
      cancelOpen();
      if(!card.isConnected || selectionMode || hasTextSelection()) return;
      const file=app.vault.getAbstractFileByPath(p.file.path);
      if(isFile(file)) openNoteInForeground(app,file).catch((error)=>new Notice(msg("ノートを開けませんでした: {0}", [errorMessage(error)])));
    };

    const cancelPress=()=>{if(pressTimer!==null) clearTimeout(pressTimer);pressTimer=null;};
    card.onpointerdown=(event)=>{
      cancelOpen();textSelectionAtDown=!!hasTextSelection();
      if(event.button!==0 || (event.target instanceof window.Element && event.target.closest('a,button,input,textarea,select'))) return;
      if(scrollbarTarget(event)) {cancelPress();return;}
      if(container.classList.contains('kv-page-scrolling')) return;
      suppressClick=false;pressOrigin={x:event.clientX,y:event.clientY};
      pressTimer=setTimeout(()=>{pressTimer=null;if(card.isConnected && !textSelectionAtDown) {suppressClick=true;if(hasTextSelection()) window.getSelection()?.removeAllRanges();toggleSelection(p.file.path);}},500);
    };
    card.onpointermove=(event)=>{if(pressOrigin && Math.hypot(event.clientX-pressOrigin.x,event.clientY-pressOrigin.y)>8) {cancelPress();cancelOpen();suppressClick=true;}};
    card.onpointerup=()=>{cancelPress();pressOrigin=null;};card.onpointercancel=()=>{cancelPress();cancelOpen();suppressClick=true;};card.onpointerleave=cancelPress;
    card.oncontextmenu=(event)=>{if(textSelectionAtDown && hasTextSelection()){cancelPress();cancelOpen();return;}event.preventDefault();cancelPress();cancelOpen();if(hasTextSelection()) window.getSelection()?.removeAllRanges();if(!suppressClick && !scrollbarTarget(event)) toggleSelection(p.file.path);suppressClick=true;};
    card.onkeydown = (event)=>{
      if(event.target!==card) return;
      if(event.key===' ') {event.preventDefault();toggleSelection(p.file.path);}
      else if(event.key==='Enter') card.click();
    };
    card.onclick = (event) => {
      if(scrollbarTarget(event)) return;
      if((event.target instanceof window.Element && event.target.closest('a,button,input,textarea,select'))) return;
      if(suppressClick) {suppressClick=false;return;}
      if(hasTextSelection()) return;
      if(selectionMode || event.ctrlKey || event.metaKey) {toggleSelection(p.file.path);return;}
      const repeated=lastTap && Date.now()-lastTap.at<320 && Math.hypot(event.clientX-lastTap.x,event.clientY-lastTap.y)<24;
      if(event.detail>=2 || repeated) {lastTap=null;selectText(event);return;}
      lastTap={at:Date.now(),x:event.clientX,y:event.clientY};
      if(event.detail===0) openCard();else openTimer=setTimeout(openCard,320);
    };

    const selectText=(event: MouseEvent)=>{
      cancelOpen();cancelPress();
      if(selectionMode || !(event.target instanceof window.Element) || !event.target.closest('.kv-card-title,.kv-card-preview') || event.target.closest('a,button,input')) return;
      if(hasTextSelection()) return;
      const caret=document.caretPositionFromPoint?.(event.clientX,event.clientY);
      const legacy=caret?null:document.caretRangeFromPoint?.(event.clientX,event.clientY);
      const node=caret?.offsetNode||legacy?.startContainer,offset=caret?.offset??legacy?.startOffset;
      if(!node || node.nodeType!==3 || !card.contains(node)) return;
      const index=Math.max(0,Math.min(offset!,node.textContent!.length-1));
      const segment=[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(node.textContent!)].find((part)=>part.index<=index && index<part.index+part.segment.length);
      if(!segment) return;
      const range=document.createRange();range.setStart(node,segment.index);range.setEnd(node,segment.index+segment.segment.length);
      const selection=window.getSelection();if(selection) {selection.removeAllRanges();selection.addRange(range);}
    };
    card.ondblclick=selectText;

    const updateThumb=()=>{if (content.thumb && settings.previewMode==='source' && !card.querySelector('.kv-card-thumb')) {
      const target = app.metadataCache.getFirstLinkpathDest(content.thumb, p.file.path);
      const src = target && /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(target.path) ? app.vault.getResourcePath(target) : null;
      const img = card.createEl('img', {cls:'kv-card-thumb'});
      if (src) img.src = src; else img.remove();
      img.onerror = () => img.remove();
      card.prepend(img);
    }};
    updateThumb();

    const body = card.createDiv({cls:'kv-card-body'});
    body.createDiv({cls:'kv-card-title', text:p.file.name});
    if (S.density !== 'compact') {
      const wrap=body.createDiv({cls:'kv-preview-wrap'});
      const preview= (wrap.createDiv({cls:'kv-card-preview'}) as HTMLDivElement & {_syncScrollbar?:()=>void});
      preview.id='kv-preview-'+genId();
      const rail=wrap.createDiv({cls:'kv-scroll-rail'});
      const thumb=rail.createDiv({cls:'kv-scroll-thumb'});
      rail.tabIndex=0;rail.setAttribute('role','scrollbar');rail.setAttribute('aria-label',msg("本文をスクロール"));rail.setAttribute('aria-orientation','vertical');
      rail.setAttribute('aria-controls',preview.id);
      rail.setAttribute('aria-valuemin','0');
       let drag: {y:number,top:number,ratio:number}|null=null;
      const syncScrollbar=()=>{
        for(const input of preview.querySelectorAll('li > input[type=checkbox],li > p > input[type=checkbox]')) input.closest('li')?.classList.add('kv-task-item');
        for(const element of preview.querySelectorAll('[title]')) element.removeAttribute('title');
        // Keep diagram coordinates at their rendered size instead of shrinking
        // every label to fit a narrow card. The diagram can scroll horizontally.
        for(const svg of preview.querySelectorAll<SVGSVGElement>('.mermaid svg')) {
          const bounds=svg.viewBox?.baseVal;
          if(bounds?.width>0 && bounds.height>0) {
            svg.style.width=bounds.width+'px';svg.style.height=bounds.height+'px';svg.classList.add('kv-measured-svg');
          }
        }
        const height=preview.clientHeight,range=Math.max(0,preview.scrollHeight-height);
        rail.hidden=range<=1;rail.style.height=height+'px';
        const size=Math.min(height,Math.max(24,height*height/Math.max(1,preview.scrollHeight)));
        thumb.style.height=size+'px';thumb.style.transform=`translateY(${range?preview.scrollTop/range*(height-size):0}px)`;
        rail.setAttribute('aria-valuemax',String(Math.round(range)));rail.setAttribute('aria-valuenow',String(Math.round(preview.scrollTop)));
      };
      const contentObserver=new window.MutationObserver(()=>requestLayout());
      contentObserver.observe(preview,{childList:true,subtree:true});contentObservers.push(contentObserver);
      preview._syncScrollbar=syncScrollbar;preview.addEventListener('scroll',()=>{cancelPress();cancelOpen();syncScrollbar();},{passive:true});
      const endDrag=()=>{drag=null;rail.classList.remove('is-dragging');};
      rail.onpointerdown=(event)=>{
        if(event.button!==0 || container.classList.contains('kv-page-scrolling')) return;
        event.preventDefault();event.stopPropagation();
        const range=preview.scrollHeight-preview.clientHeight,travel=rail.clientHeight-thumb.offsetHeight;
        if(travel<=0) return;
        if(event.target!==thumb) preview.scrollTop=(event.clientY-rail.getBoundingClientRect().top-thumb.offsetHeight/2)/travel*range;
        drag={y:event.clientY,top:preview.scrollTop,ratio:range/travel};
        rail.setPointerCapture(event.pointerId);rail.classList.add('is-dragging');syncScrollbar();
      };
      rail.onpointermove=(event)=>{if(drag) {event.preventDefault();preview.scrollTop=drag.top+(event.clientY-drag.y)*drag.ratio;syncScrollbar();}};
      rail.onpointerup=(event)=>{endDrag();if(rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);};
      rail.onpointercancel=endDrag;rail.onlostpointercapture=endDrag;
      rail.onkeydown=(event)=>{
        const delta=event.key==='ArrowDown'?24:event.key==='ArrowUp'?-24:event.key==='PageDown'?preview.clientHeight:event.key==='PageUp'?-preview.clientHeight:0;
        if(delta) {event.preventDefault();event.stopPropagation();preview.scrollTop+=delta;syncScrollbar();}
      };
      preview.style.maxHeight=Math.max(100,Math.min(320,Math.ceil(S.previewChars/25)*22))+'px';
      preview.tabIndex=0;preview.setAttribute('aria-label',msg("ノート本文プレビュー"));
      const updatePreview=()=>{
        if(stopped) return;
        updateThumb();
        const text=markdownBody(content.markdown ?? content.summary);preview.empty();
        if(settings.previewMode==='source') {preview.textContent=text;preview.classList.add('is-source');}
        else if(text) {
          preview.classList.add('markdown-rendered');
          const component=new Component();component.load();components.push(component);
          Promise.resolve().then(()=>{if(!stopped) return MarkdownRenderer.render(app,text,preview,p.file.path,component);})
            .catch(()=>{if(!stopped) preview.textContent=text;})
            .finally(()=>{if(stopped) component.unload();else requestLayout();});
        }
        requestLayout();
      };
      if(content.loading) {preview.textContent=msg("読み込み中...");content.promise.then(updatePreview).catch(()=>{if(!stopped) {preview.textContent=msg("プレビューを読み込めませんでした");requestLayout();}});}
      else updatePreview();
    }

    const footer = card.createDiv({cls:'kv-card-footer'});
    tags.forEach((t) => {
      const clean = t.replace(/^#/,'');
      footer.createSpan({cls:'kv-card-tag', text:'#'+clean})
        .onclick = (e) => {
          e.stopPropagation();
          if(suppressClick) {suppressClick=false;return;}
          if(selectionMode) {toggleSelection(p.file.path);return;}
          const exists = S.searchTree.children!.some((c)=>c.type==='tag'&&c.tag===clean);
          if (!exists) addNode(S.searchTree.id, {type:'tag', id:genId(), tag:clean});
          else { S.limit=PAGE_SIZE; render(); }
        };
    });
    const dateField = S.sortField === 'name' ? S.dateField : S.sortField;
    const date = dateField==='mtime'?p.file.mtime:p.file.property;
    footer.createSpan({cls:'kv-card-date', text:date===null?msg("日時なし"):relDate(date), });
  };

  let frame: number|null = null;
  const layout = () => {
    frame = null;
    if (stopped || !masonry.isConnected) return;
    if(!masonry.clientWidth) {masonry.classList.add('kv-layout-pending');return;}
    const columns = getColCount(masonry.clientWidth+32);
    const gap = parseFloat(window.getComputedStyle(masonry).getPropertyValue('--kv-card-gap')) || 12;
    const width = Math.max(1,(masonry.clientWidth-gap*(columns-1))/columns);
    for (const card of cards) card.style.width = width+'px';
    for(const card of cards) {const preview=card.querySelector<HTMLElement & {_syncScrollbar?:()=>void}>('.kv-card-preview');if(preview) {preview.classList.toggle('is-scrollable',preview.scrollHeight>preview.clientHeight+1);preview._syncScrollbar?.();}}
    const {positions,height} = masonryPositions(cards.map((card)=>card.getBoundingClientRect().height),columns,gap);
    cards.forEach((card,index) => {
      const {column,top} = positions[index];
      card.style.left = column*(width+gap)+'px'; card.style.top = top+'px';
    });
    masonry.style.height = height+'px';
    masonry.dataset.columns = String(columns);
    masonry.classList.remove('kv-layout-pending');
  };
  const requestLayout = () => { if (frame===null && !stopped) frame=window.requestAnimationFrame(layout); };
  // ResizeObserver runs before paint, including when a hidden tab reappears.
  const cardObserver = new window.ResizeObserver(()=>{if(frame!==null) window.cancelAnimationFrame(frame);layout();});
  cardObserver.observe(masonry);
  const cleanup = () => { stopped=true; contentObservers.forEach((observer)=>observer.disconnect()); components.forEach((component)=>component.unload()); cardObserver.disconnect(); if (frame!==null) window.cancelAnimationFrame(frame); };
  layouts.add(cleanup);

  const append=(items: Page[])=>{
    const start=cards.length;items.forEach(addCard);
    cards.slice(start).forEach((card)=>cardObserver.observe(card));layout();
  };
  append(pages);updateSelection();return {append};
};

const dateValue = (page: Page,field: string) => field==='mtime'?page.file.mtime:(page.file.property??page.file.ctime);

const sortArr = (arr: Page[]) => {
  const dir = S.sortOrder==='asc' ? 1 : -1;
  if (S.sortField === 'name') {
    return [...arr].sort((a,b) => dir * a.file.name.localeCompare(b.file.name, undefined, {sensitivity:'base'}));
  }
  return [...arr].sort((a,b) => {
    const first=dateValue(a,S.sortField), second=dateValue(b,S.sortField);
    return dir*(toMs(first)-toMs(second)) || a.file.path.localeCompare(b.file.path);
  });
};

const candidatePages = () => {
  let pages = getPages();
  if (S.folderFilters.length) pages = pages.filter((p)=>S.folderFilters.includes(p.file.folder));
  if (S.searchTree.children!.length) pages = pages.filter((p)=>evalNode(S.searchTree,p.file.tags));
  if (S.dateFrom || S.dateTo) {
    const from = S.dateFrom ? new Date(S.dateFrom+'T00:00:00').getTime() : -Infinity;
    const to = S.dateTo ? new Date(S.dateTo+'T23:59:59.999').getTime() : Infinity;
    pages = pages.filter((p)=>{const date=dateValue(p,S.dateField);return date>=from && date<=to;});
  }
  if (S.noTagOnly) pages = pages.filter((p)=>!p.file.tags.length);
  return pages;
};
const filteredPages = () => sortArr(candidatePages().filter((page)=>!S.textQuery || searchState.matches.has(page.file.path)));

const topFolder=(path: string)=>path.includes('/')?path.split('/')[0]:'';

const ensureSearch=()=>{
  const query=normalizeSearch(S.textQuery.trim());
  if(query && !searchActivated) {searchState.ready=false;searchState.waiting=true;return;}
  const ordered=sortArr(candidatePages());
  if(S.groupByFolder) ordered.sort((a,b)=>{
    const left=topFolder(a.file.path),right=topFolder(b.file.path);
    return left===right?0:!left?1:!right?-1:left.localeCompare(right);
  });
  const files=query?ordered.map((page)=>app.vault.getAbstractFileByPath(page.file.path)).filter(isFile):[];
  const key=JSON.stringify([query,S.groupByFolder,files.map((file)=>[file.path,file.stat.mtime,file.stat.size])]);
  if(searchState.key===key) return;
  cardSearch.cancel();
  const run=searchState= ({key,ready:!query,matches:new Set(),errors:[],files:new Set(files.map((file)=>file.path)),completed:0,total:files.length,slow:false} as SearchState);
  if(!query) {cardSearch.clear();return;}
  const updateProgress=()=>{
    if(disposed || searchState!==run || run.ready) return;
    const status=container.querySelector('.kv-search-status');
    if(status) {
      status.firstElementChild!.textContent=msg("検索中… {0} / {1} 件", [run.completed, run.total]);
      status.lastElementChild!.textContent=run.slow?msg("初回・更新時は時間がかかる場合があります"):'';
    }
  };
  const slowTimer=setTimeout(()=>{run.slow=true;updateProgress();},600);
  let prefix=0,released=0;
  const updateCache=updateSearchCache;updateSearchCache=false;
  cardSearch.search(query,files,{updateCache,onProgress:(completed,total,partial)=>{
    if(disposed || searchState!==run) return;
    run.completed=completed;updateProgress();
    if(partial) {
      const previousMatches=run.matches.size;
      while(prefix<files.length && partial.settled.has(files[prefix].path)) prefix++;
      let end=prefix;
      // Tree branches are released only when their whole top-level folder is settled.
      if(S.groupByFolder && end<files.length) while(end>released && topFolder(files[end-1].path)===topFolder(files[prefix].path)) end--;
      for(;released<end;released++) if(partial.matches.has(files[released].path)) run.matches.add(files[released].path);
      if(run.matches.size!==previousMatches && (S.groupByFolder || previousMatches<S.limit)) run.repaint?.();
    }
  }}).then((result)=>{
    if(disposed || searchState!==run || result.cancelled) return;
    if(result.storageError) new Notice(msg("検索データを保存できませんでした。今回の検索結果は表示できますが、次回は再作成する場合があります。"));
    run.ready=true;run.matches=result.matches;run.errors=result.errors;run.repaint?.();
  }).catch(()=>{
    if(!disposed && searchState===run) {run.ready=true;run.errors=files.map((file)=>file.path);run.repaint?.();}
  }).finally(()=>clearTimeout(slowTimer));
};

const createAndOpenNote=async(button: HTMLButtonElement,folder: string|null)=>{
  if(button.disabled) return;
  button.disabled=true;
  try {
    const file=await createNote(app,settings.dateProperty,folder,settings.creationTimeZone || '');
    await openNoteInForeground(app,file);
  } catch(error) {new Notice(msg("ノートを作成できませんでした: {0}", [errorMessage(error)]));}
  finally {button.disabled=false;}
};

const trimContentCache=(visible: Page[])=>{
  const activeKeys=new Set(visible.map((page)=>page.file.path+'::'+page.file.mtime));
  const cached=Object.keys(S.contentCache);
  let excess=cached.length-Math.max(500,activeKeys.size);
  for(const key of cached) {
    if(excess<=0) break;
    if(!activeKeys.has(key) && !S.contentCache[key].loading) {delete S.contentCache[key];excess--;}
  }
};
const treeFolderPaths = () => {

  const collect=(node: ResultFolder): string[]=>[...node.children.values()].flatMap((child)=>[child.path,...collect(child)]);
  return collect(resultFolderTree(filteredPages()));
};
const updateTreeAction = () => {
  const button=container.querySelector<HTMLButtonElement>('.kv-collapse-all');if(!button) return;
  const paths=treeFolderPaths(),open=paths.some((path)=>S.resultTreeOpen[path]===true);
  button.empty();setIcon(button,open?'chevrons-down-up':'chevrons-up-down');
  button.setAttribute('aria-label',msg(open?'すべて折りたたむ':'すべて展開'));button.disabled=!paths.length;
};

const renderCards = (bodyEl: CardBody, pages: Page[], appendGroups: boolean=false) => {
  const finishScroll=preserveScroll(bodyEl);
  if(!appendGroups) {
    for (const cleanup of layouts) cleanup();
    layouts.clear(); bodyEl.empty();bodyEl._treeGroups=new Set();
  }
  const visible= ([] as Page[]);

  const showCards=(parent: HTMLElement,items: Page[])=>{visible.push(...items);return buildMasonry(parent,items);};
  if (!pages.length) bodyEl.createDiv({cls:'kv-empty',text:msg("該当するメモが見つかりません")});
  else if (S.groupByFolder) {
    const tree=resultFolderTree(pages);
    const nodes=[...tree.children.values()];
    const redraw=()=>renderCards(bodyEl,filteredPages());

    const drawNotes=(parent: HTMLElement,node: ResultFolder)=>{
      if(!node.pages.length) return;
      const limit=S.resultTreeLimits[node.path]||PAGE_SIZE;
      const notes=parent.createDiv({cls:'kv-direct-notes'});
       let grid: ReturnType<typeof buildMasonry>|null=null;
      if(node.pages.length>limit) {
        const wrap=notes.createDiv({cls:'kv-folder-more'});
        const more=wrap.createEl('button',{cls:'kv-load-more-btn',text:msg("さらに表示 (残り {0} 件)", [node.pages.length-limit])});
        more.onclick=()=>{if(grid) return appendMore(more,node.pages,S.resultTreeLimits[node.path]||PAGE_SIZE,grid.append,(value)=>{S.resultTreeLimits[node.path]=value;});};
        more.disabled=true;
      }
      const mount=()=>{
        const pagination=notes.querySelector('.kv-folder-more');
        grid=showCards(notes,node.pages.slice(0,limit));
        if(pagination) {notes.appendChild(pagination); (pagination.firstElementChild as HTMLButtonElement).disabled=false;}
        notes.style.removeProperty('min-height');
      };
      if(deferTreeCards && window.IntersectionObserver) {
        const columns=getColCount(bodyEl.clientWidth+32);
        notes.style.minHeight=(Math.ceil(Math.min(limit,node.pages.length)/columns)*180)+'px';
        let active=true,queued=false;
        const observer=new window.IntersectionObserver((entries)=>{
          if(queued || !entries.some((entry)=>entry.isIntersecting)) return;
          queued=true;observer.disconnect();
          scheduleTreeCards(()=>{if(!active || !notes.isConnected) return false;mount();return true;});
        },{rootMargin:'1200px'});
        observer.observe(notes);
        layouts.add(()=>{active=false;observer.disconnect();});
      } else mount();
    };

    const nodePaths=(node: ResultFolder): string[]=>[...node.pages.map((page)=>page.file.path),...[...node.children.values()].flatMap(nodePaths)];

    const drawNode=(parent: HTMLElement,node: ResultFolder)=>{
      const branch=parent.createDiv({cls:'kv-result-branch'});
      const key=node.path;
      branch.dataset.folder=node.path;
      const open=S.resultTreeOpen[key]===true;
      const heading=branch.createDiv({cls:'kv-result-folder-heading'});
      const toggle= (heading.createEl('button',{cls:'kv-result-folder'}) as HTMLButtonElement & {_selectionPaths?:string[]});
      toggle.setAttribute('aria-expanded',String(open));
      const arrow=disclosureIcon(toggle,open);
      toggle.createSpan({cls:'kv-result-folder-name',text:node.name});toggle.createSpan({cls:'kv-result-count',text:String(node.count)});
      const add=iconButton(heading,'square-pen',msg("{0} に新規ノート", [node.name]));add.classList.add('kv-folder-create');
      add.onclick=()=>createAndOpenNote(add,node.path);
      toggle._selectionPaths=nodePaths(node);
       let press: number|null=null;
       let origin: {x:number,y:number}|null=null;let suppress=false;
      const cancel=()=>{if(press!==null) clearTimeout(press);press=null;};
      const expand=()=>{if(selectionBusy) return;animateDisclosure(arrow,!arrow.classList.contains('is-open'),(value)=>{S.resultTreeOpen[key]=value;redraw();});};
      arrow.onclick=(event)=>{event.stopPropagation();if(suppress) {suppress=false;return;}expand();};
      toggle.onpointerdown=(event)=>{
        if(event.button!==0 || (event.target instanceof window.Element && event.target.closest('.kv-result-folder > span:first-child'))) return;
        suppress=false;origin={x:event.clientX,y:event.clientY};
        press=setTimeout(()=>{press=null;if(toggle.isConnected){suppress=true;toggleFolderSelection(node.path);}},500);
      };
      toggle.onpointermove=(event)=>{if(origin && Math.hypot(event.clientX-origin.x,event.clientY-origin.y)>8) cancel();};
      toggle.onpointerup=cancel;toggle.onpointercancel=cancel;toggle.onpointerleave=cancel;
      toggle.oncontextmenu=(event)=>{event.preventDefault();cancel();if(!suppress) toggleFolderSelection(node.path);suppress=true;};
      toggle.onclick=(event)=>{if(suppress){suppress=false;return;}if(selectionMode || event.ctrlKey || event.metaKey) toggleFolderSelection(node.path);else expand();};
      if(!open) return;
      const content=branch.createDiv({cls:'kv-result-children'});
      [...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name)).forEach((child)=>drawNode(content,child));
      drawNotes(content,node);
    };
    nodes.sort((a,b)=>a.path.localeCompare(b.path)).forEach((node)=>{
      if(bodyEl._treeGroups!.has(node.path)) return;
      drawNode(bodyEl,node);bodyEl._treeGroups!.add(node.path);
    });
    if(tree.pages.length && !bodyEl._treeGroups!.has('')) {drawNotes(bodyEl,tree);bodyEl._treeGroups!.add('');}
    updateSelection();
  } else bodyEl._appendCards=showCards(bodyEl,pages.slice(0,S.limit)).append;
  trimContentCache(visible);
  updateTreeAction();
  finishScroll();
};

// Leave the existing cards mounted while reading and appending the next batch.

const appendMore=async(button: HTMLButtonElement,pages: Page[],limit: number,append: (pages:Page[])=>void,setLimit: (value:number)=>void)=>{
  button.disabled=true;
  const next=pages.slice(limit,limit+PAGE_SIZE);
  await Promise.all(next.map(getContent).filter((entry)=>entry.loading).map((entry)=>entry.promise));
  if(disposed || !button.isConnected) return;
  append(next);setLimit(limit+next.length);
  button.blur();
  button.classList.add('kv-hover-released');
  const resumeHover=()=>{
    button.classList.remove('kv-hover-released');
    for(const type of ['pointermove','pointerdown']) button.removeEventListener(type,resumeHover);
  };
  for(const type of ['pointermove','pointerdown']) button.addEventListener(type,resumeHover);
  const remaining=pages.length-limit-next.length;
  if(remaining) {button.textContent=msg("さらに表示 (残り {0} 件)", [remaining]);button.disabled=false;}
  else button.remove();
};

const getScrollContainer = () => {
  let el: HTMLElement|null = container;
  while (el) {
    if (el.scrollHeight > el.clientHeight+2) {
      const s = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflow+s.overflowY)) return el;
    }
    el = el.parentElement;
  }
  return null;
};

// Replacing cards temporarily collapses the scroll height. Reserve it until
// asynchronous previews and their measured layout settle; never lock scrolling.
const scrollGuards=new WeakMap();

const preserveScroll = (element: HTMLElement) => {
  const scroller=getScrollContainer(), top=scroller?.scrollTop;
  const token={};scrollGuards.set(element,token);
  element.style.minHeight=element.getBoundingClientRect().height+'px';
  return ()=>{
    if(scroller) scroller.scrollTop=top!;
    const loading=Object.values(S.contentCache).filter((entry)=>entry.loading).map((entry)=>entry.promise);
    const release=()=>{if(disposed) return;setTimeout(()=>{
      if(scrollGuards.get(element)===token) element.style.removeProperty('min-height');
    },100);};
    Promise.all(loading).then(release,release);
  };
};

const render = () => {
  if (disposed) return;
  const finishScroll=preserveScroll(container);
  dragCleanup?.(); dragCleanup=null;
  refreshTagCache();
  // フォルダドロップダウンは閉じない（選択中も維持）
  if (_activePopup && !_activePopup._isFolderDropdown) closePopup();

  const root = container;
  const oldInput=root.querySelector<HTMLInputElement>('.kv-formula-input');
  const focused = document.activeElement === oldInput;
  const draft = oldInput?.value;
  const selection = oldInput ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
  root.empty();
  for(const cleanup of layouts) cleanup();
  layouts.clear();
  root.className = 'keep-view-root';
  root.setAttribute('lang',getLocale());
  renderedPagesKey=JSON.stringify(getPages());

  const header = root.createDiv({cls:'kv-header kv-controls'});
  const toolbar = header.createDiv({cls:'kv-toolbar'});

  /* ===== 行1: Undo/Redo | 密標準広 | プレビュー文字数 ===== */
  const row1 = toolbar.createDiv({cls:'kv-header-row kv-primary-tools'});

  const undoBtn = iconButton(row1,'undo-2',msg("元に戻す"));
  undoBtn.classList.add('kv-undo');
  if (!S.undoStack.length) undoBtn.disabled = true;
  undoBtn.onclick = doUndo;
  const redoBtn = iconButton(row1,'redo-2',msg("やり直す"));
  redoBtn.classList.add('kv-redo');
  if (!S.redoStack.length) redoBtn.disabled = true;
  redoBtn.onclick = doRedo;

  row1.createDiv({cls:'kv-sep'});

  const density=row1.createEl('select',{cls:'kv-input kv-density-select'});
  density.setAttribute('aria-label',msg("表示密度"));
  for(const [value,text] of [['compact',msg("密")],['normal',msg("標準")],['wide',msg("広")],['single',msg("縦一列")]]) density.createEl('option',{value,text});
  density.value=S.density;
  density.onchange=()=>{pushUndo();S.density=density.value;render();};

  const pvSel = row1.createEl('select', {cls:'kv-input kv-preview-select'});
  pvSel.setAttribute('aria-label',msg("プレビュー文字数"));
  const pvOptions = previewLengths(settings.previewLengths) || DEFAULT_SETTINGS.previewLengths;
  // S.previewCharsに最も近いオプションを選択
  const closestPv = pvOptions.reduce((prev, curr) =>
    Math.abs(curr - S.previewChars) < Math.abs(prev - S.previewChars) ? curr : prev
  );
  pvOptions.forEach((v) => {
    const o = pvSel.createEl('option', {value:String(v), text:msg("{0}字", [v])});
    if (v === closestPv) o.selected = true;
  });
  // 初期値を実際の選択値に同期
  if (closestPv !== S.previewChars) S.previewChars = closestPv;
  pvSel.onchange = () => { pushUndo(); S.previewChars=Number(pvSel.value); render(); };

  /* ===== 行2(モバイル) / 行1の続き(PC) ===== */
  const row2 = toolbar.createDiv({cls:'kv-view-actions'});

  const folderBtn = iconButton(row2,'folder',msg("フォルダ"),S.folderFilters.length>0);
  folderBtn.title=S.folderFilters.length?msg("フォルダ（{0} 選択中）", [S.folderFilters.length]):msg("フォルダ");
  folderBtn.onclick = (e) => { e.stopPropagation(); openFolderDropdown(folderBtn); };
  if (_activePopup?._isFolderDropdown) { _activePopup._anchor=folderBtn; _activePopup._reposition?.(); }

  const treeButton=iconButton(row1,TREE_ICON,msg("ツリー表示"),S.groupByFolder);
  treeButton.setAttribute('aria-pressed',String(S.groupByFolder));
  treeButton.onclick=()=>{pushUndo();S.groupByFolder=!S.groupByFolder;render();};
  const searchButton=iconButton(row2,'search',msg("全文検索"),!!S.textQuery);
  searchButton.title=S.textQuery?msg("全文検索: {0}", [S.textQuery]):msg("全文検索");
  searchButton.onclick=()=>{
    searchModal?.close();
    searchModal=new TextSearchModal(app,S.textQuery,(value)=>{
      pushUndo();S.textQuery=value;S.limit=PAGE_SIZE;searchActivated=true;updateSearchCache=!!value;searchState.key=null;render();
    });
    searchModal.open();
  };

  const actions=root.createDiv({cls:'kv-result-actions'});
  const newNoteButton=iconButton(actions,'square-pen',msg("新規ノート"));
  newNoteButton.onclick=()=>createAndOpenNote(newNoteButton,S.folderFilters.length===1?S.folderFilters[0]:null);
  if(S.groupByFolder) {
    const collapse=iconButton(actions,'chevrons-down-up',msg("すべて折りたたむ"));collapse.classList.add('kv-collapse-all');
    collapse.onclick=()=>{
      const paths=treeFolderPaths(),open=paths.some((path)=>S.resultTreeOpen[path]===true);
      const pages=filteredPages();deferTreeCards=!open && pages.length>120;
      S.resultTreeOpen=open?{}:Object.fromEntries(paths.map((path)=>[path,true]));renderCards(bodyEl,pages);
    };
  }
  actions.classList.toggle('has-search',!!S.textQuery);
  const statusSlot=S.textQuery?actions.createDiv({cls:'kv-search-status-slot'}):null;
  const outputActions=actions.createDiv({cls:'kv-output-actions'});
  const counter = outputActions.createSpan({cls:'kv-counter', text:''});
  const exportButton = iconButton(outputActions,EXPORT_ICON,msg("パス出力"));
  exportButton.onclick = () => {
    exportModal?.close();
    exportModal = new PathExportModal(app, makePathExport(app, filteredPages(), {
      formula:treeToFormula(), textQuery:S.textQuery, noTagOnly:S.noTagOnly, folders:[...S.folderFilters],
      dateField:S.dateField,dateFrom:S.dateFrom,dateTo:S.dateTo,sortField:S.sortField,sortOrder:S.sortOrder,
    },settings.dateProperty));
    exportModal.open();
  };
  const selectionOverlay=root.createDiv({cls:'kv-selection-overlay'});root.prepend(selectionOverlay);
  selectionBar=selectionOverlay.createDiv({cls:'kv-selection-bar'});
  selectionBar.setAttribute('role','toolbar');selectionBar.setAttribute('aria-label',msg("選択操作"));
  iconButton(selectionBar,'x',msg("選択モードを解除")).onclick=exitSelection;
  selectionBar.createSpan({cls:'kv-selection-count'});
  const selectionActions=selectionBar.createDiv({cls:'kv-selection-actions'});
  selectionActions.createEl('button',{cls:'kv-btn kv-selection-edit',text:msg("タグを編集")}).onclick=editSelectionTags;
  const move=selectionActions.createEl('button',{cls:'kv-btn kv-selection-move',text:msg("フォルダを移動")});
  move.onclick=()=>openMoveDropdown(move);
  selectionActions.createEl('button',{cls:'kv-btn kv-selection-confirm',text:msg("決定")}).onclick=confirmSelection;
  const deleteButton=iconButton(selectionBar,'trash-2',msg("ノートを削除"));deleteButton.classList.add('kv-selection-delete');deleteButton.onclick=deleteSelection;
  updateSelection();

  /* ===== 行3: ソート ===== */
  const row3 = toolbar.createDiv({cls:'kv-header-row kv-sort-tools'});
  const segments=row3.createDiv({cls:'kv-segmented'});
  segments.setAttribute('role','group');segments.setAttribute('aria-label',msg("並び替え基準"));

  // ソートフィールド（更新日・作成日・タイトル）
  [['property',msg("作成日時")],['mtime',msg("更新日時")],['name',msg("タイトル")]].forEach(([key,label]) => {
    const button=segments.createEl('button', {
      cls: 'kv-segment'+(S.sortField===key?' is-active':''),
      text: label,
    });
    button.setAttribute('aria-pressed',String(S.sortField===key));
    button.onclick = () => {
      pushUndo();
      S.sortField = key;
      // 日付フィールドも同期（タイトル以外）
      if (key !== 'name') S.dateField = key;
      S.limit=PAGE_SIZE; render();
    };
  });

  iconButton(row3,S.sortOrder==='desc'?'arrow-down-wide-narrow':'arrow-up-wide-narrow',S.sortOrder==='desc'?msg("降順（クリックで昇順）"):msg("昇順（クリックで降順）"))
    .onclick = () => { pushUndo(); S.sortOrder=S.sortOrder==='desc'?'asc':'desc'; S.limit=PAGE_SIZE; render(); };

  /* ===== 行4(モバイル) / 行3の続き(PC): 期間指定 ===== */
  const row4 = toolbar.createDiv({cls:'kv-header-row kv-date-range'});

  const dfFrom = row4.createEl('input', {cls:'kv-input', type:'date'});
  dfFrom.setAttribute('aria-label',msg("開始日"));
  dfFrom.title = S.dateField==='mtime' ? msg("更新日時: ファイルの更新日時（端末のタイムゾーン）") : msg("作成日時: {0}（端末のタイムゾーン）", [settings.dateProperty]);
  dfFrom.value = S.dateFrom;
  dfFrom.onchange = () => { pushUndo(); S.dateFrom=dfFrom.value; S.limit=PAGE_SIZE; render(); };
  row4.createSpan({text:'–'});
  const dfTo = row4.createEl('input', {cls:'kv-input', type:'date'});
  dfTo.setAttribute('aria-label',msg("終了日"));
  dfTo.title = dfFrom.title;
  dfTo.value = S.dateTo;
  dfTo.onchange = () => { pushUndo(); S.dateTo=dfTo.value; S.limit=PAGE_SIZE; render(); };
  if (S.dateFrom || S.dateTo) {
    iconButton(row4,'x',msg("期間を解除"))
      .onclick = () => { pushUndo(); S.dateFrom=''; S.dateTo=''; S.limit=PAGE_SIZE; render(); };
  }

  /* ===== 行5(モバイル) / 行4の続き(PC): タグなし ===== */
  const row5 = row3;
  row5.createEl('button', {
    cls: 'kv-btn kv-no-tag'+(S.noTagOnly?' is-active':''),
    text: msg("タグなし"),
  }).onclick = () => { pushUndo(); S.noTagOnly=!S.noTagOnly; S.limit=PAGE_SIZE; render(); };
  // Grid areas put these controls in the requested order at each pane width.
  toolbar.appendChild(row2);
  toolbar.appendChild(row3.querySelector('.kv-no-tag')!);

  /* ===== 検索パネル ===== */
  const panel = header.createDiv({cls:'kv-search-panel'});

  const formulaInput = panel.createEl('input', {
    cls: 'kv-formula-input'+(S.formulaError?' is-error':''),
    type: 'text',
    placeholder: msg("例: #仕事 AND NOT #完了 AND (#重要 OR #緊急)"),
  });
  formulaInput.value = focused ? draft! : S.formula;
  if (focused && selection) { formulaInput.focus(); formulaInput.setSelectionRange(selection[0],selection[1]); }

  const applyFormula = () => {
    const val = formulaInput.value;
    if (val === S.formula && !S.formulaError) return;
    pushUndo(); S.formula=val; syncTreeFromFormula(val); S.limit=PAGE_SIZE; render();
  };
  formulaInput.addEventListener('blur', applyFormula);
  formulaInput.addEventListener('keydown', (e) => { if(e.key==='Enter'){e.preventDefault();applyFormula();} });

  const openSuggest = (query: string, anchorEl: HTMLElement) => {
    const allTags = Object.keys(S.tagCache||{}).sort();
    const candidates = allTags.filter((t) => t.toLowerCase().startsWith(query.toLowerCase())).slice(0, 12);
    if (!candidates.length) { closePopup(); return; }
    openPopup(anchorEl, (popup) => {
    candidates.forEach((tag) => {
      const item = popup.createDiv({cls:'kv-dropdown-item'});
      item.createSpan({text:'#'+tag});
      item.onpointerdown = (e) => {
        e.preventDefault();
        const val  = formulaInput.value;
        const pos  = formulaInput.selectionStart!;
        const before = val.slice(0, pos);
        const match = before.match(/#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f\-/]*)$/);
        if (match) {
          const start = pos - match[0].length;
          const newVal = val.slice(0, start) + '#'+tag + val.slice(pos);
          formulaInput.value = newVal;
          formulaInput.selectionStart = formulaInput.selectionEnd = start + tag.length + 1;
        }
        closePopup();
      };
    });
    },{minWidth:'180px'});
  };

  formulaInput.addEventListener('input', () => {
    const val  = formulaInput.value;
    const pos  = formulaInput.selectionStart!;
    const before = val.slice(0, pos);
    const match = before.match(/#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f\-/]*)$/);
    if (!match) { closePopup(); return; }
    openSuggest(match[1], formulaInput);
  });

  formulaInput.addEventListener('blur', () => setTimeout(closePopup, 150));

  // ツリーエリア
  const treeArea = panel.createDiv({cls:'kv-tree-area'});
  renderRootTree(treeArea);

  if (S.formulaError || S.searchTree.children!.length > 0) {
    const footer = panel.createDiv({cls:'kv-search-footer'});
    if (S.formulaError) footer.createSpan({cls:'kv-search-error', text:'⚠ '+S.formulaError});
    footer.createEl('button', {cls:'kv-btn', text:msg("クリア")})
      .onclick = () => { pushUndo(); S.searchTree={type:'and',id:'root',children:[]}; S.formula=''; S.formulaError=''; S.limit=PAGE_SIZE; render(); };
  }

  /* ===== クエリ実行 ===== */
  ensureSearch();
  const pages = filteredPages();
  const searching=!!S.textQuery && !searchState.ready;
  counter.textContent = searching?'':msg("{0} 件", [pages.length]);
  exportButton.disabled = !!S.formulaError || searching || (!!S.textQuery && searchState.errors.length>0);
  if (S.dateField==='property' || S.sortField==='property') {
    const missing = getPages().filter((page)=>page.file.property===null).length;
    counter.title = msg("{0}: Vault 全体で {1} 件が未設定または無効。並び替えと期間指定にはファイル作成日時を使います。", [settings.dateProperty, missing]);
  }
   let status: HTMLElement|null=null;
  if(searching) {
    status=statusSlot!.createDiv({cls:'kv-search-status'});status.setAttribute('role','status');
    status.createDiv({text:searchState.waiting?msg("全文検索ボタンから検索を再開してください"):msg("検索中… {0} / {1} 件", [searchState.completed, searchState.total])});
    status.createDiv({cls:'kv-search-hint',text:searchState.slow?msg("初回・更新時は時間がかかる場合があります"):''});
  }
  const bodyEl= (root.createDiv({cls:'kv-body-wrapper'}) as CardBody);
  const pagWrap=root.createDiv({cls:'kv-load-more-wrap kv-body-wrapper'});
  const run=searchState;
  let shown=0,treeStarted=false,painting=false,again=false;let paintTimer: number|null=null;
  const canPaint=()=>{
    if(disposed || searchState!==run) return false;
    // ItemView.onOpen can run before its content joins the workspace DOM.
    if(!bodyEl.isConnected) {
      if(container.contains(bodyEl)) {pendingRefresh=true;forceRefresh=true;}
      return false;
    }
    return true;
  };
  const paintResults=async()=>{
    if(!canPaint()) return;
    if(painting) {again=true;return;}
    painting=true;
    try {
      do {
        again=false;
        if(!canPaint()) return;
        const current=filteredPages();
        if(S.textQuery && !S.groupByFolder) {
          const next=current.slice(shown,S.limit);
          await Promise.all(next.map(getContent).filter((entry)=>entry.loading).map((entry)=>entry.promise));
          if(!canPaint()) return;
          if(next.length) {
            if(!bodyEl._appendCards) bodyEl._appendCards=buildMasonry(bodyEl,[]).append;
            bodyEl._appendCards(next);shown+=next.length;
            trimContentCache(current.slice(0,S.limit));
            updateSelection();
          }
        } else if(current.length!==shown || (!S.textQuery && !treeStarted)) {
          renderCards(bodyEl,current,treeStarted && S.groupByFolder);shown=current.length;treeStarted=true;
        }
        if(!canPaint()) return;
        const pending=!!S.textQuery && !run.ready;
        counter.textContent=pending?'':msg("{0} 件", [current.length]);
        exportButton.disabled=!!S.formulaError || pending || (!!S.textQuery && run.errors.length>0);
        if(!pending) {
          status?.remove();status=null;
          if(!current.length && !bodyEl.querySelector('.kv-empty')) renderCards(bodyEl,[]);
          if(S.textQuery && run.errors.length && !bodyEl.querySelector('.kv-search-error')) bodyEl.createDiv({cls:'kv-search-error',text:msg("{0} 件を読み込めませんでした。全文検索を開き直して検索すると再試行します。", [run.errors.length])});
          if(!pagWrap.hasChildNodes()) {
            if(!S.groupByFolder && current.length>S.limit) {
              const more=pagWrap.createEl('button',{cls:'kv-load-more-btn',text:msg("さらに表示 (残り {0} 件)", [current.length-S.limit])});
              more.onclick=()=>appendMore(more,current,S.limit,bodyEl._appendCards!,(value)=>{S.limit=value;});
            }
            if(current.length) iconButton(pagWrap,'arrow-up',msg("トップへ戻る")).onclick=()=>{
              const sc=getScrollContainer();if(sc) sc.scrollTo({top:0,behavior:'smooth'});else window.scrollTo({top:0,behavior:'smooth'});
            };
          }
        }
      } while(again);
    } finally {painting=false;}
  };
  run.repaint=()=>{
    if(paintTimer!==null) return;
    paintTimer=setTimeout(()=>{paintTimer=null;void paintResults();},32);
  };
  void paintResults();

  // Obsidian's accessible tooltip replaces the browser's native title popup.
  for(const element of root.querySelectorAll('[title]')) {
    const description=element.getAttribute('title')!;
    element.setAttribute(element.hasAttribute('aria-label')?'aria-description':'aria-label',description);
    element.removeAttribute('title');
  }
  const guidanceProperty=settings.dateProperty;
  const dateInfo=dateGuidance.read(settings.showDateGuidance!==false && !dateGuidanceShown.has(settings.dateProperty) && (S.dateField==='property' || S.sortField==='property'),settings.dateProperty,getPages,timestampFromFilename);
  if(dateInfo) setTimeout(()=>{
    if(disposed || settings.showDateGuidance===false || settings.dateProperty!==guidanceProperty || dateGuidanceShown.has(guidanceProperty) || (S.dateField!=='property' && S.sortField!=='property')) return;
    if(document.hidden || !root.isConnected || root.clientWidth===0) {pendingRefresh=true;forceRefresh=true;return;}
    dateGuidanceShown.add(guidanceProperty);
    dateGuidanceModal=new CreationDateModal(app,guidanceProperty,dateInfo,()=>{
      settings.showDateGuidance=false;callbacks.onHideDateGuidance?.();
    },()=>{
      if(disposed) return;
      dateMigrationModal?.close();dateMigrationModal=new MigrationModal(app,guidanceProperty);dateMigrationModal.open();
    });
    dateGuidanceModal.open();
  },0);
  persist(takeSaved());
  fitPreviewLabels();
  finishScroll();
};

render();
return {

  setSearchIndex(index: SearchIndex|null,{pause=false}: {pause?:boolean}={}) {if(cardSearch.index===index && !pause) return;cardSearch.clear();cardSearch.index=index;if(pause) {searchActivated=false;updateSearchCache=false;}searchState.key=null;forceRefresh=true;refreshLater();},

  refresh(file?: TAbstractFile) { if(file?.path) {forceRefresh=file.path.toLowerCase().endsWith('.md') || forceRefresh;cardSearch.invalidate(file.path);if(searchState.files?.has(file.path)) {cardSearch.cancel();searchState.key=null;}} revision++; pagesCache=null; S.tagCache = null; refreshLater(); },
  refreshSettings() {forceRefresh=true;revision++;pagesCache=null;S.tagCache=null;refreshLater();},
  dispose() { disposed = true; cardSearch.dispose();observer.disconnect(); for (const cleanup of layouts) cleanup(); layouts.clear(); closePopup(); exportModal?.close(); searchModal?.close(); deleteModal?.close(); dateGuidanceModal?.close(); dateMigrationModal?.close(); dragCleanup?.(); for (const timer of timers) window.clearTimeout(timer); timers.clear(); lifetime.abort(); releaseTooltips(); persist(takeSaved()); container.empty(); },
};

}

class KeepViewModal extends Modal {
  tooltipCleanup=()=>{};
  prepareSurface() {this.contentEl.addClass('keep-view-root');this.tooltipCleanup();this.tooltipCleanup=suppressHoverTooltips(this.modalEl || this.contentEl);}
}

class DeleteNotesModal extends KeepViewModal {
  declare targets: { path: string; file: TFile|null; }[];
  declare mode: string;
  declare apply: () => Promise<unknown>;
  declare onDismiss: () => void;
  declare components: Component[];
  declare offset: number;
  declare closed: boolean;
  declare busy: boolean;

  constructor(app: App,targets: {path:string,file:TFile|null}[],mode: string,apply: ()=>Promise<unknown>,onDismiss: ()=>void) {super(app);this.targets=targets;this.mode=mode;this.apply=apply;this.onDismiss=onDismiss;this.components= ([] as Component[]);this.offset=0;this.closed=false;this.busy=false;}
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl;root.addClass('kv-delete-modal');this.modalEl?.addClass('kv-delete-dialog');
    root.createEl('h2',{text:msg("{0} 件のノートを削除しますか？", [this.targets.length])});
    root.createEl('p',{text:msg("対象のノートをObsidianの削除設定に従って削除します。未確定のタグ編集・フォルダ移動は適用しません。")});
    const previews=root.createDiv({cls:'keep-view-root kv-delete-preview'});
    const more=root.createEl('button',{cls:'kv-btn',text:msg("さらにプレビューを表示")});
    const actions=root.createDiv({cls:'kv-modal-actions'});
    const cancel=actions.createEl('button',{text:msg("キャンセル")});
    const confirm=actions.createEl('button',{cls:'kv-delete-confirm',text:msg("{0} 件を削除", [this.targets.length])});
    cancel.onclick=()=>this.close();cancel.focus();
    const append=async()=>{
      more.disabled=true;confirm.disabled=true;
      const batch=this.targets.slice(this.offset,this.offset+30);this.offset+=batch.length;
      await Promise.all(batch.map(async (target)=>{
        const card=previews.createDiv({cls:'kv-card'});card.dataset.path=target.path;
        const body=card.createDiv({cls:'kv-card-body'});
        body.createDiv({cls:'kv-card-title',text:target.file?.basename||target.path.split('/').pop()});
        body.createDiv({cls:'kv-delete-path',text:target.path});
        const preview=body.createDiv({cls:'kv-card-preview',text:msg("読み込み中...")});
        try {
          if(!target.file || this.app.vault.getAbstractFileByPath(target.path)!==target.file) throw Error('missing');
          const text=markdownBody(await this.app.vault.cachedRead(target.file));if(this.closed) return;
          preview.empty();
          if(this.mode==='source') {preview.classList.add('is-source');preview.textContent=text;}
          else {preview.classList.add('markdown-rendered');const component=new Component();component.load();this.components.push(component);await MarkdownRenderer.render(this.app,text,preview,target.path,component);if(this.closed) component.unload();}
          if(!text) preview.textContent=msg("本文なし");
        } catch {if(!this.closed) preview.textContent=msg("プレビューを読み込めませんでした");}
      }));
      if(this.closed) return;
      more.hidden=this.offset>=this.targets.length;more.disabled=false;confirm.disabled=false;
      more.textContent=msg("さらにプレビューを表示（残り {0} 件）", [this.targets.length-this.offset]);
    };
    more.onclick=append;
    confirm.onclick=async()=>{
      if(this.busy || confirm.disabled) return;
      this.busy=true;confirm.disabled=true;cancel.disabled=true;more.disabled=true;
      try {await this.apply();} finally {this.busy=false;this.close();}
    };
    void append();
  }
  close() {if(!this.busy) super.close();}
  onClose() {this.tooltipCleanup();this.closed=true;for(const component of this.components) component.unload();this.components=[];this.contentEl.empty();this.onDismiss();}
}

class TextSearchModal extends KeepViewModal {
  declare query: string;
  declare apply: (value: string) => void | Promise<void>;

  constructor(app: App,query: string,apply: (value:string)=>void|Promise<void>) {super(app);this.query=query;this.apply=apply;}
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl;root.addClass('kv-text-search-modal');
    this.modalEl?.addClass('kv-text-search-dialog');
    root.createEl('h2',{text:msg("全文検索")});
    const form=root.createEl('form');
    const input=form.createEl('input',{type:'search',value:this.query,placeholder:msg("検索する文字")});
    input.setAttribute('aria-label',msg("検索する文字"));
    // Keep actions outside the form: clearing must never also submit its old value.
    const actions=root.createDiv({cls:'kv-modal-actions'});
    let committed=false;

    const commit=async (value: string)=>{if(committed) return;committed=true;try {await this.apply(value);this.close();} catch(error) {committed=false;new Notice(errorMessage(error) || msg("検索を開けませんでした"));}};
    const search=actions.createEl('button',{text:msg("検索")});search.type='button';
    const clear=actions.createEl('button',{text:msg("クリア")});clear.type='button';
    // Do not move focus before the tap completes: a closing mobile keyboard can
    // otherwise move the button out from under the user's finger.
    for(const button of [search,clear]) button.onpointerdown=(event)=>event.preventDefault();
    search.onclick=()=>{void commit(input.value.trim());};
    clear.onclick=()=>{input.value='';void commit('');};
    form.onsubmit=(event)=>{event.preventDefault();void commit(input.value.trim());};
    input.focus();input.select();
  }
  onClose() {this.tooltipCleanup();this.contentEl.empty();}
}

class PathExportModal extends KeepViewModal {
  declare payload: PathExport;
  declare previewTimer: number;

  constructor(app: App, payload: PathExport) { super(app); this.payload=payload; }
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl; root.addClass('kv-export-modal');
    this.modalEl?.addClass('kv-export-dialog');this.containerEl?.addClass('kv-export-container');
    const heading=root.createEl('h2',{text:msg("検索結果のパス（{0} 件）", [this.payload.count])});heading.tabIndex=0;
    root.createEl('p',{text:msg("未表示分も含む全件です。JSON には Vault 名・検索条件・並び順を含めます。パスは Vault ルートからの相対パスです。")});
    const format=root.createEl('select',{cls:'dropdown kv-export-format'});
    format.setAttribute('aria-label',msg("出力形式"));
    format.createEl('option',{value:'json',text:msg("JSON（推奨）")});
    format.createEl('option',{value:'txt',text:msg("パス一覧（1行1ファイル）")});
    const absoluteLabel=root.createEl('label',{cls:'kv-export-absolute'});
    const absolute=absoluteLabel.createEl('input',{type:'checkbox'});
    absoluteLabel.createSpan({text:msg("Vault の絶対パスを含める")});
    const adapter=this.app.vault.adapter;
    const getBasePath='getBasePath' in adapter && typeof adapter.getBasePath==='function'?()=>{const value= (adapter.getBasePath as ()=>unknown).call(adapter);return typeof value==='string'?value:null;}:null;
    absolute.disabled=!getBasePath;
    if(absolute.disabled) root.createEl('p',{cls:'kv-export-note',text:msg("この端末では Vault の絶対パスを取得できません。")});
    const preview=root.createEl('textarea'); preview.readOnly=true;
    preview.setAttribute('aria-label',msg("出力するパス"));
    const update=()=>{
      preview.value=formatPathExport(this.payload,format.value,absolute.checked?getBasePath?.():null);
      preview.scrollTop=0;
    };
    format.onchange=update;
    absolute.onchange=update;
    heading.focus({preventScroll:true});
    this.previewTimer=root.ownerDocument.defaultView!.setTimeout(update,0);
    const actions=root.createDiv({cls:'kv-modal-actions'});
    actions.createEl('button',{text:msg("コピー")}).onclick=async()=>{
      try { await root.ownerDocument.defaultView!.navigator.clipboard.writeText(preview.value); new Notice(msg("パスをコピーしました")); }
      catch { preview.focus(); preview.select(); new Notice(msg("コピーできませんでした。選択されたテキストを手動でコピーしてください")); }
    };
    const save=actions.createEl('button',{text:msg("Vault に保存")});
    save.onclick=async()=>{
      save.disabled=true;
      const filename=`keep-view-paths-${new Date().toISOString().replace(/[:.]/g,'-')}.${format.value}`;
      try { await this.app.vault.create(filename,preview.value+'\n'); new Notice(msg("{0} に保存しました", [filename])); }
      catch(error) { new Notice(msg("保存できませんでした: {0}", [errorMessage(error)])); }
      finally {save.disabled=false;}
    };
  }
  onClose() {this.tooltipCleanup();this.contentEl.ownerDocument.defaultView!.clearTimeout(this.previewTimer);this.contentEl.empty();}
}

class CacheDeleteModal extends KeepViewModal {
  declare apply: () => Promise<void>;
  declare busy: boolean;

  constructor(app: App,apply: ()=>Promise<void>) {super(app);this.apply=apply;this.busy=false;}
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl;root.addClass('kv-cache-delete-modal');
    root.createEl('h2',{text:msg('全文検索のキャッシュを削除しますか？')});
    root.createEl('p',{text:msg('この端末の検索キャッシュと旧キャッシュファイルを削除します。ノートや設定は残り、検索ボタンを押すまで再作成しません。')});
    const actions=root.createDiv({cls:'kv-modal-actions'});
    const cancel=actions.createEl('button',{text:msg('キャンセル')});cancel.onclick=()=>this.close();
    const confirm=actions.createEl('button',{text:msg('削除する')});
    confirm.onclick=async()=>{
      if(this.busy) return;
      this.busy=true;confirm.disabled=true;cancel.disabled=true;
      try {await this.apply();new Notice(msg('検索キャッシュを削除しました'));this.close();}
      catch {new Notice(msg('検索キャッシュを削除できませんでした'));}
      finally {this.busy=false;confirm.disabled=false;cancel.disabled=false;}
    };
    cancel.focus({preventScroll:true});
  }
  onClose() {this.tooltipCleanup();this.contentEl.empty();}
}

class CreationDateModal extends KeepViewModal {
  declare property: string;
  declare summary: { missing: number; invalid: number; importable: number; };
  declare onHide: () => void;
  declare onImport: () => void;

   optOut: HTMLInputElement|null=null;
  closed=false;

  constructor(app: App,property: string,summary: {missing:number,invalid:number,importable:number},onHide: ()=>void,onImport: ()=>void) {super(app);this.property=property;this.summary=summary;this.onHide=onHide;this.onImport=onImport;}
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl;root.addClass('kv-date-guidance-modal');this.modalEl?.addClass('kv-date-guidance-dialog');
    root.createEl('h2',{text:msg("作成日時について")});
    root.createEl('p',{text:msg("{0} が未設定・無効のノート: {1} 件",[this.property,this.summary.missing+this.summary.invalid])});
    root.createEl('p',{text:msg("未設定 {0} 件・空欄または無効 {1} 件（Vault 全体）",[this.summary.missing,this.summary.invalid])});
    root.createEl('p',{text:msg("未設定・無効のノートはファイルの作成日時を使い、ほかのノートと混ぜて並べ、期間指定にも含めます。プロパティの書き換えは行いません。")});
    root.createEl('p',{text:msg("別のプロパティに日時を保存している場合は、設定の「日時プロパティ」を変更できます。「更新日時」ではファイルの更新日時を使います。")});
    if(this.summary.importable) root.createEl('p',{text:msg("ファイル名に対応形式の日時がある未設定ノートが {0} 件あります。Google Keep などから移行したノートなら、移行ツールで対象と保存先を確認してから取り込めます。",[this.summary.importable])});
    if(this.summary.invalid) root.createEl('p',{text:msg("既存プロパティは、空欄や無効な値でも移行ツールでは上書きしません。")});
    const label=root.createEl('label',{cls:'kv-date-guidance-opt-out'});
    this.optOut=dropdownCheckbox(label,{label:msg("今後表示しない")});label.createSpan({text:msg("今後表示しない")});
    const actions=root.createDiv({cls:'kv-modal-actions'});
    actions.createEl('button',{text:msg("閉じる")}).onclick=()=>this.close();
    if(this.summary.importable) actions.createEl('button',{text:msg("移行ツールを開く")}).onclick=()=>{this.close();this.onImport();};
  }
  onClose() {
    if(this.closed) return;this.closed=true;
    const hide=this.optOut?.checked;this.tooltipCleanup();this.contentEl.empty();
    if(hide) this.onHide();
  }
}

class MigrationModal extends KeepViewModal {
  declare property: string;
  declare runId: number;

  constructor(app: App, property: string) { super(app); this.property=property; this.runId=0; }
  onOpen() {
    this.prepareSurface();
    const root=this.contentEl; root.addClass('kv-migration-modal');
    root.createEl('h2',{text:msg("Google Keep から日時を取り込む")});
    root.createEl('p',{text:msg("Importer などで Google Keep から Vault に取り込んだ Markdown ノートが対象です。ファイル名に日時が残っている場合に取り込めます。例: 2026-02-09T15_46_51.388+09_00.md。日時を含まない名前や、この形式に一致しないファイルは取り込めません。")});
    root.createEl('p',{text:msg("ファイル名の日時とタイムゾーンをそのまま ISO 8601 に変換します。既存プロパティ（空欄も含む）は上書きしません。")});
    root.createEl('label',{text:msg("日時プロパティ名")});
    const property=root.createEl('input',{type:'text',value:this.property});
    property.setAttribute('aria-label',msg("日時プロパティ名"));
    root.createEl('label',{text:msg("対象フォルダ（Vault 内相対パス・空欄は全体）")});
    const folder=root.createEl('input',{type:'text',placeholder:msg("例: Google Keep")});
    folder.setAttribute('aria-label',msg("対象フォルダ"));
    const actions=root.createDiv({cls:'kv-modal-actions'});
    const scan=actions.createEl('button',{text:msg("対象を確認")});
    const apply=actions.createEl('button',{text:msg("確認した対象に適用")}); apply.disabled=true;
    const status=root.createEl('p');
    const preview=root.createEl('textarea'); preview.readOnly=true;
    preview.setAttribute('aria-label',msg("日時の変換結果"));
     let plan: {property:string,folder:string,paths:string[]}|null=null;let busy=false;
    const invalidate=()=>{plan=null;apply.disabled=true;status.textContent=msg("条件を変更しました。対象を再確認してください。");};
    property.oninput=invalidate; folder.oninput=invalidate;

    const show=(report: Awaited<ReturnType<typeof migrateCreated>>)=>{

      const count=(key: string)=>report.rows.filter((row)=>row.status===key).length;
      status.textContent=msg("対象 {0} / 書き込み {1} / 既存 {2} / 日時を判別できない {3} / エラー {4}{5}", [count('ready'), count('written'), count('existing'), count('unrecognized'), count('error'), report.cancelled?msg("（中断）"):'']);
      preview.value=JSON.stringify(report,null,2);
    };

    const run=async (writing: boolean)=>{
      if (busy || (writing && !plan)) return;
      busy=true; scan.disabled=true; apply.disabled=true; property.disabled=true; folder.disabled=true;
      const runId=++this.runId;
      try {
        const options=writing?{...plan,apply:true}:{property:property.value,folder:folder.value};
        const report=await migrateCreated(this.app,{...options,cancelled:()=>this.runId!==runId});
        if (this.runId!==runId) return;
        show(report);
        plan=writing?null:{property:report.property,folder:report.folder,paths:report.rows.filter((row)=>row.status==='ready').map((row)=>row.path)};
      } catch(error) {status.textContent=errorMessage(error);plan=null;}
      finally {busy=false;scan.disabled=false;property.disabled=false;folder.disabled=false;apply.disabled=!plan?.paths.length;}
    };
    scan.onclick=()=>run(false); apply.onclick=()=>run(true);
  }
  onClose() {this.tooltipCleanup();this.runId++;this.contentEl.empty();}
}

class KeepViewSettings extends PluginSettingTab {
  declare plugin: KeepViewPlugin;

  constructor(app: App, plugin: KeepViewPlugin) {super(app,plugin);this.plugin=plugin;}
   dateInfo: Setting|null=null;
  dateDescription() {return msg("タイムゾーン（空欄は端末設定）。例: Asia/Tokyo、UTC、America/New_York\n保存先: {0} / {1} / ISO 8601\n保存例: {2}",[this.plugin.settings.dateProperty,this.plugin.settings.creationTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,localIsoTimestamp(new Date(),this.plugin.settings.creationTimeZone || '')]);}
  redisplay() {
    if(typeof requireApiVersion==='function') {
      if(requireApiVersion('1.13.0')) {this.update();return;}
    }
    this.renderLegacySettings();
  }

  getSettingDefinitions(): SettingRow[] {
    const updateDateInfo=()=>this.dateInfo?.setDesc(this.dateDescription());
    return [
    {name:msg('言語'),render:(setting)=>{setting.addDropdown((dropdown)=>dropdown
      .addOption('en','English').addOption('ja','日本語')
      .setValue(getLocale()).onChange((value)=>{this.plugin.settings.language=value;this.plugin.saveSettings();this.redisplay();}))}},
    {name:msg("プレビュー文字数"),render:(setting)=>{setting.addText((text)=>{
      const defaults=DEFAULT_SETTINGS.previewLengths.join(', ');
      const current=(this.plugin.settings.previewLengths||DEFAULT_SETTINGS.previewLengths).join(', ');
      text.setValue(current===defaults?'':current);
      text.inputEl.placeholder=defaults;
      text.inputEl.addEventListener('change',()=>{
        const value=text.getValue().trim();
        const values=value?previewLengths(value):[...DEFAULT_SETTINGS.previewLengths];
        if(!values) {new Notice(msg("1〜10000の整数をカンマで区切って入力してください"));return;}
        this.plugin.settings.previewLengths=values;this.plugin.saveSettings();
      });
    });}},
    {name:msg("プレビュー表示"),render:(setting)=>{setting.addDropdown((dropdown)=>dropdown
      .addOption('markdown',msg('Markdown')).addOption('source',msg("ソース"))
      .setValue(this.plugin.settings.previewMode)
      .onChange((value)=>{this.plugin.settings.previewMode=value;this.plugin.saveSettings();}))}},
    {name:msg("ノート削除時に確認する"),render:(setting)=>{setting.addToggle((toggle)=>toggle
      .setValue(this.plugin.settings.confirmDelete!==false)
      .onChange((value)=>{this.plugin.settings.confirmDelete=value;this.plugin.saveSettings();}))}},
    {name:msg("新規ノートの作成日時"),desc:this.dateDescription(),render:(setting)=>{this.dateInfo=setting;setting.addText((text)=>{
      text.setValue(this.plugin.settings.creationTimeZone || '');
      text.inputEl.placeholder=msg("端末のタイムゾーン");
      text.inputEl.addEventListener('change',()=>{
        const zone=text.getValue().trim();
        if(!validTimeZone(zone)) {new Notice(msg("有効なタイムゾーン名を入力してください"));text.setValue(this.plugin.settings.creationTimeZone || '');return;}
        this.plugin.settings.creationTimeZone=zone;this.plugin.saveSettings();updateDateInfo();
      });
    });}},
    {name:msg("日時プロパティ"),desc:msg("ISO 8601 の日時を読むプロパティ名。空欄は created を使います。作成日時の検索・並び替えに使用します。未設定・無効はファイル作成日時でほかのノートと混ぜて並べ、期間指定にも含めます。"),render:(setting)=>{setting.addText((text)=>{
        text.setValue(this.plugin.settings.dateProperty===DEFAULT_SETTINGS.dateProperty?'':this.plugin.settings.dateProperty);
        text.inputEl.placeholder=DEFAULT_SETTINGS.dateProperty;
        text.inputEl.addEventListener('change',()=>{
          const property=text.getValue().trim() || DEFAULT_SETTINGS.dateProperty;
          if (!validatePropertyName(property)) {new Notice(msg("有効なプロパティ名を指定してください"));text.setValue(this.plugin.settings.dateProperty===DEFAULT_SETTINGS.dateProperty?'':this.plugin.settings.dateProperty);return;}
          this.plugin.settings.dateProperty=property;this.plugin.saveSettings();updateDateInfo();
        });
      });}},
    {name:msg("作成日時の案内"),desc:msg("日時プロパティが未設定・無効のとき、起動中に一度だけ案内します。オフにすると、案内用の追加確認も省きます。移行ツールは引き続き手動で開けます。"),render:(setting)=>{setting.addToggle((toggle)=>toggle.setValue(this.plugin.settings.showDateGuidance!==false).onChange((value)=>{this.plugin.settings.showDateGuidance=value;if(value) this.plugin.dateGuidanceShown?.clear();this.plugin.saveSettings();}));}},
    {name:msg("検索キャッシュを端末に保存"),desc:msg("検索実行時だけ、この端末の IndexedDB に本文を圧縮して保存します。Vault 同期の対象外で、暗号化はされません。オフにすると保存済みキャッシュも削除します。"),render:(setting)=>{setting.addToggle((toggle)=>toggle.setValue(this.plugin.settings.fastSearch!==false)
        .onChange(async(value)=>{await this.plugin.setSearchCacheEnabled(value);}))}},
    {name:msg("検索キャッシュ"),render:(setting)=>{setting.addButton((button)=>button.setButtonText(msg("削除する")).onClick(()=>this.plugin.confirmClearSearchCache()))}},
    {name:msg("Google Keep から日時を取り込む"),desc:msg("Importer などで Vault に取り込んだ Markdown ノートのファイル名から日時を取り込みます。対象フォルダと変換内容を確認してから適用できます。"),render:(setting)=>{setting.addButton((button)=>button.setButtonText(msg("移行ツールを開く")).onClick(()=>this.plugin.openMigration()))}},
    ];
  }
  display() {this.renderLegacySettings();}
  renderLegacySettings() {
    this.containerEl.empty();this.containerEl.classList?.add('kv-settings');
    this.plugin.syncAppLanguage?.(false);
    for(const definition of this.getSettingDefinitions()) {
      const setting=new Setting(this.containerEl).setName(definition.name);
      if(definition.desc) setting.setDesc(definition.desc);
      definition.render(setting,null);
    }
  }
}

class KeepView extends ItemView {
  declare plugin: KeepViewPlugin;

  controller: ReturnType<typeof mountKeepView>|null=null;

  constructor(leaf: WorkspaceLeaf, plugin: KeepViewPlugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return msg('Keep View'); }
  getIcon() { return KEEP_VIEW_ICON; }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('keep-view-content');
    const root = this.contentEl.createDiv();
    this.controller = mountKeepView(this.app, root, this.plugin.saved, (state) => this.plugin.saveState(state), this.plugin.settings, this.plugin.getSearchIndex(),{onHideDateGuidance:()=>this.plugin.saveSettings(),dateGuidanceShown:this.plugin.dateGuidanceShown});
    const refresh = () => this.controller?.refresh();
    this.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.registerEvent(this.app.metadataCache.on('resolved', refresh));
    this.registerEvent(this.app.vault.on('create', (file)=>this.controller?.refresh(file)));
    this.registerEvent(this.app.vault.on('delete', (file)=>this.controller?.refresh(file)));
    this.registerEvent(this.app.vault.on('modify', (file)=>this.controller?.refresh(file)));
    this.registerEvent(this.app.vault.on('rename',(file)=>this.controller?.refresh(file)));
  }
  async onClose() { this.controller?.dispose(); this.controller = null; }
}

class KeepViewPlugin extends Plugin {
   dateGuidanceShown: Set<string>=new Set();

  saved: Partial<SavedState>={};

  settings: Settings={...DEFAULT_SETTINGS};

  searchIndex: SearchIndex|null=null;

  settingsTab: KeepViewSettings|null=null;

  migrationModal: MigrationModal|null=null;

  cacheDeleteModal: CacheDeleteModal|null=null;

  lastSaved: string|null=null;
  saveQueue=Promise.resolve();
  async onload() {
    addIcon(KEEP_VIEW_ICON, KEEP_VIEW_ICON_SVG);
    addIcon(TREE_ICON,TREE_ICON_SVG);
    const data = record(await this.loadData());
    this.saved = readState(data.state);
    this.settings = readSettings(data.settings,DEFAULT_SETTINGS);
    if(!['auto','en','ja'].includes(this.settings.language)) this.settings.language='auto';
    const appLanguage=getLanguage?.() || 'en';
    if(this.settings.obsidianLanguage && this.settings.obsidianLanguage!==appLanguage) this.settings.language='auto';
    this.settings.obsidianLanguage=appLanguage;
    setLanguage(this.settings.language==='auto'?appLanguage:this.settings.language);
    this.settings.confirmDelete=this.settings.confirmDelete!==false;
    this.settings.fastSearch=this.settings.fastSearch!==false;
    if(!validTimeZone(this.settings.creationTimeZone)) this.settings.creationTimeZone='';
    this.settings.previewLengths=previewLengths(this.settings.previewLengths)||DEFAULT_SETTINGS.previewLengths;
    if(!['markdown','source'].includes(this.settings.previewMode)) this.settings.previewMode='markdown';
    if (!validatePropertyName(this.settings.dateProperty)) this.settings.dateProperty='created';
    this.saveQueue = Promise.resolve();
    this.registerView(VIEW_TYPE, (leaf) => new KeepView(leaf, this));
    const ribbon=this.addRibbonIcon(KEEP_VIEW_ICON, msg('Keep View'), () => this.activate());
    ribbon?.removeAttribute('title');
    this.addCommand({id:'open', name:msg('Open Keep View'), callback:() => this.activate()});
    this.addCommand({id:'import-created',name:msg("Google Keep から日時を取り込む"),callback:()=>this.openMigration()});
    this.settingsTab=new KeepViewSettings(this.app,this);
    this.addSettingTab(this.settingsTab);
    // Remember the host language across reloads, including before any user edits.
    if(typeof this.saveData==='function') this.queueSave();
    if(typeof window!=='undefined') {
      this.registerInterval?.(window.setInterval(()=>this.syncAppLanguage(),1000));
      this.registerDomEvent?.(window,'focus',()=>this.syncAppLanguage());
    }
  }
  syncAppLanguage(refreshTab=true) {
    const appLanguage=getLanguage?.() || 'en';
    if(appLanguage===this.settings.obsidianLanguage) return;
    this.settings.obsidianLanguage=appLanguage;
    this.settings.language='auto';
    this.saveSettings();
    if(refreshTab && this.settingsTab?.containerEl?.isConnected) this.settingsTab.redisplay();
  }

  saveState(state: SavedState) {
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSaved) return;
    this.lastSaved = serialized;
    this.saved = clone(state);
    this.queueSave();
  }
  getSearchIndex() {
    if(this.settings.fastSearch===false || !SearchIndex.supported()) return null;
    if(!this.searchIndex) {
      const directory=this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      this.searchIndex=new SearchIndex(this.app,`${directory}/search-cache-v1`);
      const index=this.searchIndex;
      this.registerEvent(this.app.vault.on('create',(file)=>index.invalidate(file.path)));
      this.registerEvent(this.app.vault.on('modify',(file)=>index.invalidate(file.path)));
      this.registerEvent(this.app.vault.on('delete',(file)=>index.invalidate(file.path)));
      this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{index.invalidate(file.path);index.invalidate(oldPath);}));
    }
    return this.searchIndex;
  }
  queueSave() {
    const snapshot=clone({state:this.saved,settings:this.settings});
    this.saveQueue=this.saveQueue.then(()=>this.saveData(snapshot)).catch((error)=>{this.lastSaved=null;console.error('Keep View Explorer: save failed',error);new Notice(msg("Keep View の設定を保存できませんでした"));});
  }
  saveSettings() {
    setLanguage(this.settings.language==='auto'?(getLanguage?.() || 'en'):this.settings.language || getLanguage?.() || 'en');
    this.queueSave();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      (leaf.view instanceof KeepView?leaf.view.controller:null)?.setSearchIndex(this.getSearchIndex());
      (leaf.view instanceof KeepView?leaf.view.controller:null)?.refreshSettings();
    }
  }
  async setSearchCacheEnabled(value:boolean) {
    this.settings.fastSearch=value;this.saveSettings();
    if(!value) {
      try {await this.clearSearchCache();new Notice(msg("検索キャッシュを削除しました"));}
      catch {new Notice(msg("検索キャッシュを削除できませんでした"));}
    }
  }
  async clearSearchCache() {
    const controllers=this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf)=>(leaf.view instanceof KeepView?leaf.view.controller:null)).filter((controller): controller is NonNullable<typeof controller>=>controller!==null);
    for(const controller of controllers) controller.setSearchIndex(null,{pause:true});
    const directory=this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const temporary=!this.searchIndex;
    const index=this.searchIndex || new SearchIndex(this.app,`${directory}/search-cache-v1`);
    try {await index.clear();}
    finally {if(temporary) index.close();for(const controller of controllers) controller.setSearchIndex(this.getSearchIndex());}
  }
  confirmClearSearchCache() {
    this.cacheDeleteModal?.close();
    this.cacheDeleteModal=new CacheDeleteModal(this.app,()=>this.clearSearchCache());
    this.cacheDeleteModal.open();
  }
  openMigration() {this.migrationModal?.close();this.migrationModal=new MigrationModal(this.app,this.settings.dateProperty);this.migrationModal.open();}
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({type:VIEW_TYPE, active:true}); }
    await this.app.workspace.revealLeaf(leaf);
  }
  onunload() { this.migrationModal?.close();this.cacheDeleteModal?.close();this.searchIndex?.close(); }
}
export default KeepViewPlugin;
