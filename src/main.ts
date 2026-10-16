import JSZip from 'jszip'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { deleteCharForward, selectAll } from '@codemirror/commands'
import './style.css'

type Bin = Blob | ArrayBuffer
type F = { path: string; dir?: boolean; data?: string | Bin }
const TEXT = new Set('html htm css js mjs json svg txt md csv tsv xml'.split(' '))
const CODE_EXT = 'html htm css js mjs wasm json csv tsv txt md xml'.split(' ')
const VERSION = '2026.10.16.3'
const ICON = { code: 'description', file: 'insert_drive_file', dir: 'folder' } as const
const MT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', wasm: 'application/wasm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }
const SEED = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My App</title>
</head>
<body>
<h1>Hello</h1>
<button onclick="console.log('clicked')">Click</button>
</body>
</html>
`

// ---------- helpers ----------
const $ = (s: string) => document.querySelector(s) as HTMLElement
const ext = (p: string) => { const n = base(p), i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase() }
const base = (p: string) => p.split('/').pop()!
const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const join = (d: string, n: string) => (d ? d + '/' + n : n)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const isText = (p: string) => TEXT.has(ext(p))
// WebKit(プライベート/一時セッション)はIndexedDBにBlob/Fileを保存できないため、バイナリはArrayBufferで保持する
const mimeOf = (p: string, d?: Bin) => MT[ext(p)] || (d instanceof Blob ? d.type : '') || 'application/octet-stream'
const sizeOf = (d?: string | Bin) => typeof d === 'string' ? new Blob([d]).size : d instanceof Blob ? d.size : d ? d.byteLength : 0
const toBlob = (d: Bin, type: string) => d instanceof Blob ? (d.type === type ? d : d.slice(0, d.size, type)) : new Blob([d], { type })

// ---------- IndexedDB ----------
let db: IDBDatabase
const req = (r: IDBRequest) => new Promise<any>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const S = (n: string, m: IDBTransactionMode = 'readonly') => db.transaction(n, m).objectStore(n)
const openDB = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('madobakocode', 1)
  r.onupgradeneeded = () => { r.result.createObjectStore('fs', { keyPath: 'path' }); r.result.createObjectStore('kv') }
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})
const files = new Map<string, F>()
const put = async (f: F) => { files.set(f.path, f); if (f.data instanceof Blob) f.data = await f.data.arrayBuffer(); return req(S('fs', 'readwrite').put(f)) }
const drop = (p: string) => { files.delete(p); return req(S('fs', 'readwrite').delete(p)) }
const under = (p: string) => [...files.keys()].filter((k) => k === p || k.startsWith(p + '/'))
const top = (ps: string[]) => ps.filter((p) => !ps.some((q) => q !== p && p.startsWith(q + '/')))
const uniq = (p: string) => {
  if (!files.has(p)) return p
  const d = parent(p), n = base(p), i = n.lastIndexOf('.')
  const [a, b] = i > 0 ? [n.slice(0, i), n.slice(i)] : [n, '']
  for (let k = 2; ; k++) { const q = join(d, a + k + b); if (!files.has(q)) return q }
}
const mkdirs = async (p: string): Promise<void> => { const d = parent(p); if (!d || files.has(d)) return; await mkdirs(d); await put({ path: d, dir: true }) }

const kind = (p: string): 'code' | 'file' | 'dir' => { const f = files.get(p); return f?.dir ? 'dir' : typeof f?.data === 'string' ? 'code' : 'file' }

// ---------- state ----------
let mode: 'edit' | 'pv' = 'edit', cur = '', last = '', previewPath = 'index.html', fs = false, drawer = false, consoleBeforeFullscreen = false
let open = new Set<string>(), sel = new Set<string>()
let focus: 'tree' | 'editor' = 'tree'
let clip: { p: string[]; cut: boolean } | null = null
let dirty = false, timer: any = 0, binUrl = ''
const saveUI = () => req(S('kv', 'readwrite').put({ mode, cur, open: [...open] }, 'ui'))

// ---------- DOM ----------
const B = (a: string, t: string, c = '', l = t) => `<button data-a="${a}" class="${c}" title="${l}" aria-label="${l}"><span class="material-symbols-rounded">${t}</span><span class="nav-label">${l}</span></button>`
const TB = (a: string, t: string, l: string) => `<button data-a="${a}" title="${l}" aria-label="${l}"><span class="material-symbols-rounded">${t}</span><span class="tl">${l}</span></button>`
$('#app').innerHTML = `<nav id="ic"><div id="nav-brand"><img src="icon.svg" alt=""><span>MadoBakoCode</span></div><div id="nav-head">${B('pv', 'visibility', '', 'プレビュー') + B('ed', 'edit', '', 'エディター') + B('dr', 'menu', 'nw', 'ファイル')}<hr></div><div id="nav-middle"><div id="nav-scroll">
${[['del', 'delete', '削除'], ['a', 'select_all', 'すべて選択'], ['ua', 'deselect', 'すべて選択解除'], ['x', 'content_cut', '切り取り'], ['c', 'content_copy', 'コピー'], ['v', 'content_paste', '貼り付け']].map(([a, t, l]) => B(a, t, 'eb', l)).join('')}
${[['rl', 'refresh', '再読み込み'], ['co', 'terminal', 'コンソール'], ['fs', 'fullscreen', '全画面']].map(([a, t, l]) => B(a, t, 'pvb', l)).join('')}</div><div id="nav-scrollbar"><div id="nav-thumb"></div></div></div>
<div id="nav-foot"><hr>${B('imp', 'folder_zip', '', 'ZIPを読み込む') + B('exp', 'file_save', '', 'ZIPを書き出す') + B('rst', 'restart_alt', '', 'すべてリセット')}<div id="ver">V ${VERSION}</div></div></nav>
<aside id="side"><div id="hd">FILES <span id="use"></span></div><div id="tb">${TB('add', 'code', 'コードを追加') + TB('dir', 'create_new_folder', 'フォルダを追加') + TB('up', 'upload_file', 'ファイルを追加') + TB('ren', 'drive_file_rename_outline', '名前を変更')}</div><div id="tree-area"><div id="tree" data-p="" data-d="1"></div><div id="tree-scrollbar"><div id="tree-thumb"></div></div></div></aside>
<main><div id="filebar"><span id="file-path"></span><span id="file-size"></span></div><div id="empty-guide">ファイルを選んで表示</div><div id="ed"></div><div id="bin"></div><div id="pv"><div id="previewbar"><button data-a="rl" id="pb-rl" title="再読み込み" aria-label="再読み込み"><span class="material-symbols-rounded">refresh</span></button><span class="material-symbols-rounded">route</span><input id="preview-path" value="/index.html" aria-label="プレビューするファイルのパス"><button data-a="pgo" aria-label="このパスをプレビュー"><span class="material-symbols-rounded">arrow_forward</span></button><button data-a="fs" id="pb-fs" title="全画面" aria-label="全画面"><span class="material-symbols-rounded" id="pb-fs-ic">fullscreen</span></button></div><iframe id="ifr" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock" allow="autoplay; fullscreen; clipboard-write"></iframe>
<div id="con" hidden><div id="ch">CONSOLE<span id="cc"></span><button data-a="cclr">Clear</button><button data-a="co" aria-label="コンソールを閉じる"><span class="material-symbols-rounded">expand_more</span></button></div><div id="cl"></div><input id="ci" placeholder="> JavaScript" autocapitalize="off" autocorrect="off"></div></div></main>
<div id="ghost" hidden></div><div id="drop-line" hidden></div>
<input type="file" id="upl" multiple hidden><input type="file" id="zin" accept=".zip,application/zip" hidden>
<dialog id="dlg"><form method="dialog"><h2 id="dlg-title"></h2><p id="dlg-message"></p><input id="dlg-input" autocomplete="off"><div class="acts"><button value="cancel" id="dlg-cancel">キャンセル</button><button value="ok" id="dlg-ok">OK</button></div></form></dialog>
<dialog id="cdlg"><form method="dialog" id="cform"><h2>コードを追加</h2>
<div id="c-main"><p>ファイル名を入力するか、下のボタンで作成します<br>使える拡張子: ${CODE_EXT.join(' ')}</p><input id="c-name" placeholder="例: a.txt / sub/b.js" autocomplete="off" autocapitalize="off" autocorrect="off"><div id="c-quick"><button type="button" data-q="html">HTML</button><button type="button" data-q="css">CSS</button><button type="button" data-q="js">JS</button></div></div>
<div id="c-html" hidden><p>HTMLの中身を選んでください</p><label><input type="radio" name="hs" value="empty" checked>空っぽ</label><label><input type="radio" name="hs" value="seed">最初のページを入れる</label></div>
<div class="acts"><button type="button" id="c-cancel">キャンセル</button><button type="submit" id="c-ok">作成</button></div></form></dialog>`
const tree = $('#tree'), ed = $('#ed'), bin = $('#bin'), ifr = $('#ifr') as HTMLIFrameElement, con = $('#con'), cl = $('#cl')
const filePathEl = $('#file-path'), fileSizeEl = $('#file-size'), previewPathEl = $('#preview-path') as HTMLInputElement
const emptyGuide = $('#empty-guide'), navScroll = $('#nav-scroll'), navBar = $('#nav-scrollbar'), navThumb = $('#nav-thumb'), treeArea = $('#tree-area'), treeThumb = $('#tree-thumb'), treeBar = $('#tree-scrollbar')
const ghost = $('#ghost'), dropLine = $('#drop-line'), ccEl = $('#cc'), tbar = $('#tb')
const ci = $('#ci') as HTMLInputElement, upl = $('#upl') as HTMLInputElement, zin = $('#zin') as HTMLInputElement
const dlg = $('#dlg') as HTMLDialogElement, dlgTitle = $('#dlg-title'), dlgMessage = $('#dlg-message'), dlgInput = $('#dlg-input') as HTMLInputElement
function dialog(message: string, title = '確認', input = false, value = ''): Promise<string | null> {
  dlgTitle.textContent = title; dlgMessage.textContent = message; dlgInput.hidden = !input; dlgInput.value = value
  dlg.showModal(); if (input) setTimeout(() => dlgInput.focus(), 0)
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? (input ? dlgInput.value : 'ok') : null), { once: true }))
}
const ask = (message: string, title = '確認') => dialog(message, title).then((v) => v !== null)
const promptInApp = (message: string, value = '', title = '入力') => dialog(message, title, true, value).then((v) => typeof v === 'string' ? v : null)

// ---------- editor ----------
const lang = (p: string): any => ({ html: html(), htm: html(), svg: html(), xml: html(), css: css(), js: javascript(), mjs: javascript(), json: json(), md: markdown() } as any)[ext(p)] || []
const upd = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return
  dirty = true; clearTimeout(timer); timer = setTimeout(flush, 500)
})
const view = new EditorView({ parent: ed, state: EditorState.create({ doc: '', extensions: [basicSetup] }) })
view.dom.addEventListener('focusin', () => (focus = 'editor'))
function flush() {
  clearTimeout(timer)
  if (!dirty || !cur) return
  dirty = false
  const f = files.get(cur)
  if (f && typeof f.data === 'string') { f.data = view.state.doc.toString(); put(f); useSize(); updateFilebar() }
}
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`
function updateFilebar() {
  const f = files.get(cur), n = sizeOf(f?.data)
  filePathEl.textContent = f && !f.dir ? '/' + cur : ''
  fileSizeEl.textContent = f && !f.dir ? formatBytes(n) : ''
}
function loadView() {
  const f = files.get(cur)
  updateFilebar()
  emptyGuide.hidden = !!(f && !f.dir)
  if (binUrl) { URL.revokeObjectURL(binUrl); binUrl = '' }
  bin.innerHTML = ''; dirty = false
  if (!f || f.dir) { ed.hidden = true; bin.hidden = true; return }
  if (typeof f.data === 'string') {
    view.setState(EditorState.create({ doc: f.data, extensions: [basicSetup, lang(cur), EditorView.lineWrapping, upd] }))
    ed.hidden = false; bin.hidden = true; return
  }
  ed.hidden = true; bin.hidden = false
  const t = mimeOf(cur, f.data as Bin)
  binUrl = URL.createObjectURL(toBlob(f.data as Bin, t))
  const k = t.split('/')[0]
  bin.innerHTML = k === 'image' ? `<img src="${binUrl}">` : k === 'audio' ? `<audio src="${binUrl}" controls></audio>` : k === 'video' ? `<video src="${binUrl}" controls playsinline></video>` : `<div>${esc(base(cur))}<br>${(sizeOf(f.data) / 1024) | 0} KB（プレビュー非対応）</div>`
}
function updateScrollbar(scroll: HTMLElement, bar: HTMLElement, thumb: HTMLElement) {
  const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
  const height = Math.min(scroll.clientHeight, Math.max(28, scroll.clientHeight * scroll.clientHeight / Math.max(scroll.scrollHeight, 1)))
  const travel = Math.max(0, bar.clientHeight - height)
  bar.hidden = max === 0
  if (max > 0) {
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${Math.min(travel, Math.max(0, travel * scroll.scrollTop / max))}px)`
  }
}
function updateNavScrollbar() { updateScrollbar(navScroll, navBar, navThumb) }
navScroll.addEventListener('scroll', updateNavScrollbar)
let navDrag = { y: 0, top: 0 }
navThumb.addEventListener('pointerdown', (e) => { navDrag = { y: e.clientY, top: navScroll.scrollTop }; navThumb.setPointerCapture(e.pointerId) })
navThumb.addEventListener('pointermove', (e) => { if (navThumb.hasPointerCapture(e.pointerId)) navScroll.scrollTop = navDrag.top + (e.clientY - navDrag.y) * (navScroll.scrollHeight - navScroll.clientHeight) / Math.max(1, navBar.clientHeight - navThumb.clientHeight) })
navThumb.addEventListener('pointerup', (e) => navThumb.releasePointerCapture(e.pointerId))
function updateTreeScrollbar() { updateScrollbar(tree, treeBar, treeThumb) }
tree.addEventListener('scroll', updateTreeScrollbar)
let treeDrag = { y: 0, top: 0 }
treeThumb.addEventListener('pointerdown', (e) => { treeDrag = { y: e.clientY, top: tree.scrollTop }; treeThumb.setPointerCapture(e.pointerId) })
treeThumb.addEventListener('pointermove', (e) => { if (treeThumb.hasPointerCapture(e.pointerId)) tree.scrollTop = treeDrag.top + (e.clientY - treeDrag.y) * (tree.scrollHeight - tree.clientHeight) / Math.max(1, treeBar.clientHeight - treeThumb.clientHeight) })
treeThumb.addEventListener('pointerup', (e) => treeThumb.releasePointerCapture(e.pointerId))
addEventListener('resize', () => { updateNavScrollbar(); updateTreeScrollbar(); fitToolbar() })
function select(p: string) { flush(); cur = p; loadView(); saveUI() }

// ---------- tree ----------
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
const sorted = (d: string) => [...files.values()].filter((f) => parent(f.path) === d).sort((a, b) => {
  if (!d) { if (a.path === 'index.html') return -1; if (b.path === 'index.html') return 1 }
  if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1
  const order = (p: string) => ({ html: 0, htm: 0, css: 1, js: 2, mjs: 2 }[ext(p)] ?? 3)
  return a.dir ? naturalCompare(base(a.path), base(b.path)) : order(a.path) - order(b.path) || naturalCompare(ext(a.path), ext(b.path)) || naturalCompare(base(a.path), base(b.path))
})
function rows(d: string, depth: number, out: string[]) {
  for (const f of sorted(d)) {
    const k = kind(f.path), on = f.path === cur || sel.has(f.path)
    out.push(`<div class="row${on ? ' cur' : ''}${sel.has(f.path) ? ' sel' : ''}" data-p="${esc(f.path)}" data-d="${f.dir ? 1 : 0}" style="padding-left:${8 + depth * 14}px">${sel.size ? `<input type="checkbox" ${sel.has(f.path) ? 'checked' : ''}>` : ''}<span class="ico material-symbols-rounded">${ICON[k]}</span><span class="nm">${esc(base(f.path))}</span>${f.dir ? `<span class="fold material-symbols-rounded">${open.has(f.path) ? 'expand_more' : 'chevron_right'}</span>` : ''}</div>`)
    if (f.dir && open.has(f.path)) rows(f.path, depth + 1, out)
  }
}
function renderTree() { const o: string[] = []; rows('', 0, o); tree.innerHTML = o.join(''); useSize(); requestAnimationFrame(() => { updateNavScrollbar(); updateTreeScrollbar() }) }
function useSize() {
  let n = 0; files.forEach((f) => { n += sizeOf(f.data) })
  $('#use').textContent = (n / 1048576).toFixed(1) + ' MB'
}
function render() {
  document.body.className = (mode === 'pv' ? 'm-pv' : 'm-edit') + (fs ? ' fs' : '') + (drawer ? ' dr' : '')
  $('#pb-fs-ic').textContent = fs ? 'fullscreen_exit' : 'fullscreen'
  $('#pb-fs').title = fs ? '全画面を終了' : '全画面'; $('#pb-fs').setAttribute('aria-label', fs ? '全画面を終了' : '全画面')
  document.querySelectorAll('[data-a=pv]').forEach((b) => b.classList.toggle('on', mode === 'pv'))
  document.querySelectorAll('[data-a=ed]').forEach((b) => b.classList.toggle('on', mode === 'edit'))
  renderTree(); fitToolbar()
}
// ファイル一覧のツールバー下端を、左アイコン列の区切り線(hr)の位置に合わせる
function fitToolbar() {
  const hr = document.querySelector('#nav-head hr') as HTMLElement
  const h = hr.getBoundingClientRect().bottom - $('#hd').getBoundingClientRect().bottom
  if (h > 0) tbar.style.height = h + 'px'
}
const toggle = (p: string) => { sel.has(p) ? sel.delete(p) : sel.add(p); renderTree() }

let dr: any = null, lp: any = 0, skip = false
const dragLabel = (ps: string[]) => `<span class="material-symbols-rounded">${ICON[kind(ps[0])]}</span><span>${esc(base(ps[0]))}${ps.length > 1 ? ` 他${ps.length - 1}個` : ''}</span>`
function dropTarget(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el || !treeArea.contains(el) || el.closest('#tree-scrollbar')) return null
  const r = el.closest('.row') as HTMLElement | null
  const dir = r ? (r.dataset.d === '1' ? r.dataset.p! : parent(r.dataset.p!)) : ''
  return { dir, ok: (dr.ps as string[]).every((p) => dir !== p && !dir.startsWith(p + '/')) }
}
// 移動先フォルダ(=中身の範囲)を線で囲む。ルートはファイル一覧全体
function showDropLine(t: { dir: string; ok: boolean } | null) {
  if (!t) { dropLine.hidden = true; return }
  const area = treeArea.getBoundingClientRect(), all = [...tree.querySelectorAll('.row')] as HTMLElement[]
  let top = area.top, bottom = area.bottom
  if (t.dir) {
    const head = all.find((r) => r.dataset.p === t.dir)!, kids = all.filter((r) => r.dataset.p!.startsWith(t.dir + '/'))
    top = head.getBoundingClientRect().top; bottom = (kids.length ? kids[kids.length - 1] : head).getBoundingClientRect().bottom
  }
  top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom)
  Object.assign(dropLine.style, { left: area.left + 1 + 'px', top: top + 'px', width: area.width - 2 + 'px', height: Math.max(0, bottom - top) + 'px' })
  dropLine.className = t.ok ? '' : 'ng'; dropLine.hidden = false
}
function updateDrag() {
  ghost.style.transform = `translate(${dr.cx + 14}px,${dr.cy + 14}px)`
  dr.target = dropTarget(dr.cx, dr.cy); showDropLine(dr.target)
}
function autoScroll() {
  if (!dr?.on) return
  const a = tree.getBoundingClientRect()
  if (dr.cy < a.top + 40) tree.scrollTop -= 10; else if (dr.cy > a.bottom - 40) tree.scrollTop += 10
  updateDrag(); dr.raf = requestAnimationFrame(autoScroll)
}
function endDrag() {
  if (dr?.raf) cancelAnimationFrame(dr.raf)
  ghost.hidden = true; dropLine.hidden = true
  document.body.classList.remove('drag')
  document.querySelectorAll('.lift,.grab').forEach((x) => x.classList.remove('lift', 'grab'))
}
async function moveInto(ps: string[], dir: string) {
  flush(); const bad: string[] = []
  for (const p of ps) {
    const n = join(dir, base(p))
    if (n === p) continue
    if (files.has(n)) { bad.push(base(p)); continue }
    await mv(p, n)
  }
  if (dir) open.add(dir)
  sel.clear(); saveUI(); render(); updateFilebar()
  if (bad.length) dialog('同名のものがあるため移動できませんでした\n' + bad.map((b) => `「${b}」`).join('\n'), '移動できません')
}
tree.addEventListener('pointerdown', (e) => {
  focus = 'tree'; skip = false
  if (e.button > 0) return
  const t = e.target as HTMLElement, r = t.closest('.row') as HTMLElement
  if (!r || t.closest('.fold')) return
  const touch = e.pointerType === 'touch'
  dr = { p: r.dataset.p!, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, on: false, long: false, touch }
  lp = setTimeout(() => { if (dr && !dr.on) { dr.long = true; r.classList.add('grab') } }, touch ? 350 : 500)
})
// タッチは長押し後だけドラッグ(それ以外はスクロール)。ドラッグ中はスクロールを止める
tree.addEventListener('touchmove', (e) => { if (dr && (dr.long || dr.on)) e.preventDefault() }, { passive: false })
tree.addEventListener('contextmenu', (e) => e.preventDefault())
addEventListener('pointermove', (e) => {
  if (!dr) return
  dr.cx = e.clientX; dr.cy = e.clientY
  if (!dr.on) {
    if (Math.hypot(e.clientX - dr.x, e.clientY - dr.y) <= 8) return
    if (dr.touch && !dr.long) { clearTimeout(lp); dr = null; return }
    clearTimeout(lp); dr.on = true
    dr.ps = sel.has(dr.p) ? top([...sel]) : [dr.p]
    ghost.innerHTML = dragLabel(dr.ps); ghost.hidden = false
    document.body.classList.add('drag')
    document.querySelectorAll('.grab').forEach((x) => x.classList.remove('grab'))
    for (const r of tree.querySelectorAll('.row') as any) if (dr.ps.includes(r.dataset.p)) r.classList.add('lift')
    dr.raf = requestAnimationFrame(autoScroll)
  }
  updateDrag()
})
addEventListener('pointerup', async () => {
  clearTimeout(lp)
  const d = dr; dr = null
  if (!d) return
  if (d.on) { skip = true; endDrag(); if (d.target?.ok) await moveInto(d.ps, d.target.dir) }
  else if (d.long) { skip = true; endDrag(); toggle(d.p) }
})
addEventListener('pointercancel', () => { clearTimeout(lp); if (dr?.on) endDrag(); dr = null })
tree.addEventListener('click', (e) => {
  if (skip) { skip = false; return }
  const t = e.target as HTMLElement, r = t.closest('.row') as HTMLElement
  if (!r) return
  const p = r.dataset.p!
  last = p
  if (t.closest('.fold')) { open.has(p) ? open.delete(p) : open.add(p); saveUI(); renderTree(); return }
  if (sel.size || e.ctrlKey || e.metaKey || e.shiftKey) return toggle(p)
  if (r.dataset.d === '1') { select(p); renderTree() }
  else { select(p); drawer = false; render() }
})

// ---------- file operations ----------
async function mv(o: string, n: string) {
  if (o === n || files.has(n) || n.startsWith(o + '/')) return
  for (const k of under(o)) { const f = files.get(k)!; await drop(k); await put({ ...f, path: n + k.slice(o.length) }) }
  const m = (x: string) => (x === o || x.startsWith(o + '/') ? n + x.slice(o.length) : x)
  cur = m(cur); open = new Set([...open].map(m)); last = m(last)
}
async function cp(s: string, d: string) {
  if (d === s || d.startsWith(s + '/')) return
  const t = uniq(join(d, base(s)))
  for (const k of under(s)) await put({ ...files.get(k)!, path: t + k.slice(s.length) })
}
const targets = () => (sel.size ? [...sel] : cur ? [cur] : [])
const destDir = () => { const t = [...sel][0] ?? (last || cur); if (!t) return ''; return files.get(t)?.dir ? t : parent(t) }
async function make(path: string, data = '') {
  if (files.has(path)) return dialog('同名のファイルがあります', '追加できません')
  if (!CODE_EXT.includes(ext(path))) return dialog(`使える拡張子は次のとおりです\n${CODE_EXT.join(' ')}`, '追加できません')
  flush(); await mkdirs(path); await put({ path, data: ext(path) === 'wasm' ? new ArrayBuffer(0) : data })
  const d = parent(path); if (d) open.add(d)
  select(path); render()
}
const countKinds = (c: { code: number; file: number; dir: number }) => [c.code && `コード${c.code}個`, c.file && `ファイル${c.file}個`, c.dir && `フォルダ${c.dir}個`].filter(Boolean).join('、')
function deleteMessage(ts: string[]) {
  const g = { code: [] as string[], file: [] as string[], dir: [] as string[] }, inner = { code: 0, file: 0, dir: 0 }
  for (const t of ts) {
    g[kind(t)].push(base(t))
    if (files.get(t)?.dir) for (const k of under(t)) if (k !== t) inner[kind(k)]++
  }
  const total = inner.code + inner.file + inner.dir
  if (ts.length === 1) {
    const n = base(ts[0]), k = kind(ts[0])
    if (k === 'dir') return total ? `フォルダ「${n}」とその中身 ${total}個を削除していいですか？\n内訳: ${countKinds(inner)}` : `フォルダ「${n}」を削除していいですか？`
    return `${k === 'code' ? 'コード' : 'ファイル'}「${n}」を削除していいですか？`
  }
  const part = (n: string[], one: string, many: string) => n.length === 0 ? '' : n.length === 1 ? `${one}「${n[0]}」` : `「${n[0]}」他${n.length - 1}個の${many}`
  return [part(g.code, 'コード', 'コードファイル'), part(g.file, 'ファイル', 'ファイル'), part(g.dir, 'フォルダ', 'フォルダ'), total ? `フォルダの中身: ${countKinds(inner)}` : '', '上記を削除していいですか？'].filter(Boolean).join('\n')
}
async function removeTargets() {
  const ts = top(targets())
  if (!ts.length || !(await ask(deleteMessage(ts), '削除の確認'))) return
  for (const t of ts) for (const k of under(t)) { if (k === cur) { cur = ''; dirty = false }; await drop(k) }
  sel.clear(); loadView(); saveUI(); render()
}
async function paste() {
  if (!clip) return
  const d = destDir(); flush()
  for (const p of clip.p) { if (!files.has(p)) continue; clip.cut ? await mv(p, uniq(join(d, base(p)))) : await cp(p, d) }
  if (clip.cut) clip = null
  if (d) open.add(d)
  sel.clear(); saveUI(); render()
}
function kb(k: string) {
  if (focus === 'editor' && mode === 'edit' && !ed.hidden) {
    view.focus()
    const s = view.state.selection.main, txt = view.state.sliceDoc(s.from, s.to)
    if (k === 'a') selectAll(view)
    else if (k === 'c') navigator.clipboard.writeText(txt)
    else if (k === 'x') { navigator.clipboard.writeText(txt); view.dispatch(view.state.replaceSelection('')) }
    else if (k === 'del') {
      if (s.empty) deleteCharForward(view)
      else ask(`コード「${base(cur)}」の中の${s.from === 0 && s.to === view.state.doc.length ? '全て' : '一部'}のテキストを削除していいですか？`, '削除の確認').then((ok) => { if (ok) { view.dispatch(view.state.replaceSelection('')); view.focus() } })
    }
    else navigator.clipboard.readText().then((x) => view.dispatch(view.state.replaceSelection(x)), () => dialog('クリップボードの読み取りが許可されませんでした', '貼り付けできません'))
    return
  }
  if (k === 'a') { sel = new Set(files.keys()); renderTree() }
  else if (k === 'c' || k === 'x') clip = { p: top(targets()), cut: k === 'x' }
  else if (k === 'v') paste()
  else removeTargets()
}

// ---------- preview / console ----------
const normalizedPreviewPath = () => {
  const raw = (previewPathEl.value || previewPath).trim()
  const parts: string[] = raw.startsWith('/') ? [] : previewPath.split('/').slice(0, -1)
  for (const part of raw.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { parts.pop(); continue }
    parts.push(part)
  }
  return parts.join('/') || 'index.html'
}
const previewUrl = () => new URL('__preview__/' + normalizedPreviewPath().split('/').map(encodeURIComponent).join('/'), document.baseURI).href + '?t=' + Date.now()
function reload() { flush(); previewPath = normalizedPreviewPath(); previewPathEl.value = '/' + previewPath; clearConsole(); ifr.src = previewUrl() }
function goPreview() { previewPath = normalizedPreviewPath(); reload() }
// 同じ内容(レベル・文面・ファイル・行)が連続したら1行にまとめて回数を出す
let lastLine: { key: string; el: HTMLElement; n: number } | null = null, errN = 0, warnN = 0
function summary() { ccEl.textContent = (errN ? ` エラー ${errN}` : '') + (warnN ? ` 警告 ${warnN}` : '') }
function clearConsole() { cl.innerHTML = ''; lastLine = null; errN = 0; warnN = 0; summary() }
function line(l: string, t: string, f = '', n = 0, c = 0) {
  if (l === 'error') errN++; else if (l === 'warn') warnN++
  summary()
  const key = [l, t, f, n, c].join('\0')
  if (lastLine?.key === key) {
    lastLine.n++
    const b = lastLine.el.querySelector('.lc') as HTMLElement
    b.textContent = String(lastLine.n); b.hidden = false
  } else {
    const d = document.createElement('div'); d.className = 'l ' + l
    const b = document.createElement('span'); b.className = 'lc'; b.hidden = true; b.textContent = '1'
    const m = document.createElement('span'); m.className = 'lm'; m.textContent = t
    d.append(b, m)
    if (f) {
      const a = document.createElement('a'); a.className = 'ls'; a.textContent = n ? `${f}:${n}` : f; a.title = a.textContent
      if (files.has(f)) { a.dataset.f = f; a.dataset.n = String(n) } else a.classList.add('ext')
      d.append(a)
    }
    cl.append(d); lastLine = { key, el: d, n: 1 }
  }
  cl.scrollTop = 1e9
  if (l === 'error' && con.hidden) $('[data-a=co]').classList.add('bad')
}
async function jump(f: string, n: number) {
  await setMode('edit'); select(f); render()
  if (n > 0 && typeof files.get(f)?.data === 'string') {
    const pos = view.state.doc.line(Math.min(n, view.state.doc.lines)).from
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); view.focus()
  }
}
cl.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest('.ls[data-f]') as HTMLElement; if (a) jump(a.dataset.f!, +a.dataset.n!) })
addEventListener('message', (e) => {
  const m = e.data?.__con
  if (e.source === ifr.contentWindow && m) line(m.l, m.t, m.f, m.n, m.c)
})
ci.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !ci.value.trim()) return
  const v = ci.value; ci.value = ''; line('in', '> ' + v)
  try { const r = (ifr.contentWindow as any).eval(v); line('log', typeof r === 'string' ? r : JSON.stringify(r) ?? String(r)) } catch (x: any) { line('error', String(x)) }
})
previewPathEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goPreview() } })
async function setMode(m: 'edit' | 'pv') {
  flush()
  if (m === 'pv' && !navigator.serviceWorker) { dialog('この環境ではプレビューできません', 'プレビューできません'); return }
  mode = m; fs = false; saveUI(); render()
  if (m === 'pv') { await navigator.serviceWorker.ready; reload() }
}

// ---------- コードを追加 ----------
const cdlg = $('#cdlg') as HTMLDialogElement, cName = $('#c-name') as HTMLInputElement
function codeDialog(): Promise<{ name: string; seed: boolean } | null> {
  const dest = destDir(); let res: { name: string; seed: boolean } | null = null, step: 'main' | 'html' = 'main'
  const view_ = (st: 'main' | 'html') => { step = st; $('#c-main').hidden = st !== 'main'; $('#c-html').hidden = st !== 'html' }
  view_('main'); cName.value = ''; (cdlg.querySelector('input[value=empty]') as HTMLInputElement).checked = true
  cdlg.showModal(); setTimeout(() => cName.focus(), 0)
  const finish = (r: typeof res) => { res = r; cdlg.close() }
  const onClick = (e: Event) => {
    const t = e.target as HTMLElement, q = t.closest('[data-q]') as HTMLElement
    if (q) {
      if (q.dataset.q === 'html') view_('html')
      else finish({ name: uniq(join(dest, q.dataset.q === 'css' ? 'main.css' : 'script.js')), seed: false })
    } else if (t.closest('#c-cancel')) finish(null)
  }
  const onSubmit = (e: Event) => {
    e.preventDefault()
    if (step === 'html') finish({ name: uniq(join(dest, 'index.html')), seed: (cdlg.querySelector('input[name=hs]:checked') as HTMLInputElement).value === 'seed' })
    else if (cName.value.trim()) finish({ name: join(dest, cName.value.trim().replace(/^\/+/, '')), seed: false })
  }
  cdlg.addEventListener('click', onClick); $('#cform').addEventListener('submit', onSubmit)
  return new Promise((resolve) => cdlg.addEventListener('close', () => { cdlg.removeEventListener('click', onClick); $('#cform').removeEventListener('submit', onSubmit); resolve(res) }, { once: true }))
}

// ---------- export / import ----------
const download = (b: Blob, n: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = n; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 6e4) }
zin.addEventListener('change', async () => {
  const z = zin.files![0]; zin.value = ''
  if (!z || !(await ask('現在の内容をすべて置き換えます。よろしいですか？', 'ZIP読み込みの確認'))) return
  try {
    const zip = await JSZip.loadAsync(z)
    const es = Object.values(zip.files).filter((e) => !e.name.startsWith('__MACOSX/') && !e.name.endsWith('.DS_Store'))
    await req(S('fs', 'readwrite').clear()); files.clear(); cur = ''; last = ''; open.clear(); sel.clear(); dirty = false
    for (const e of es) {
      const p = e.name.replace(/\/$/, '')
      if (!p) continue
      await mkdirs(p)
      if (e.dir) await put({ path: p, dir: true })
      else if (isText(p)) await put({ path: p, data: await e.async('string') })
      else await put({ path: p, data: await e.async('arraybuffer') })
    }
    loadView(); saveUI(); render()
  } catch (x) { dialog('ZIPを読み込めませんでした: ' + x, '読み込みエラー') }
})
upl.addEventListener('change', async () => {
  const d = destDir()
  const list = Array.from(upl.files ?? [])
  upl.value = ''
  try {
    for (const f of list) {
      if (f.size > 50e6 && !(await ask(`${f.name} は ${(f.size / 1e6) | 0}MB あります。追加しますか？`, '大きなファイル'))) continue
      const p = uniq(join(d, f.name)); await mkdirs(p)
      await put({ path: p, data: isText(p) ? await f.text() : await f.arrayBuffer() })
    }
  } catch (x) {
    dialog('ファイルを追加できませんでした\n' + x, 'エラー')
  } finally {
    if (d) open.add(d); render()
  }
})

// ---------- actions ----------
const A: Record<string, () => any> = {
  pv: () => setMode('pv'), ed: () => setMode('edit'), dr: () => { drawer = !drawer; render() },
  add: async () => { const r = await codeDialog(); if (r) return make(r.name, r.seed ? SEED : '') },
  dir: async () => { const n = await promptInApp('フォルダ名', '', 'フォルダを追加'); if (!n?.trim()) return; const p = join(destDir(), n.trim().replace(/^\/|\/$/g, '')); if (files.has(p)) return dialog('同名のフォルダがあります', '追加できません'); await mkdirs(p + '/x'); await put({ path: p, dir: true }); open.add(p); saveUI(); render() },
  up: () => upl.click(),
  ren: async () => {
    const t = targets(); if (t.length !== 1) return dialog('名前を変更するファイルを1つ選んでください', '名前を変更できません')
    const n = await promptInApp('新しい名前', base(t[0]), '名前を変更'); if (!n?.trim() || n.includes('/')) return
    flush(); await mv(t[0], join(parent(t[0]), n.trim())); sel.clear(); saveUI(); render()
  },
  del: () => kb('del'), a: () => kb('a'), ua: () => { sel.clear(); renderTree() }, x: () => kb('x'), c: () => kb('c'), v: () => kb('v'),
  rl: reload,
  co: () => { con.hidden = !con.hidden; $('[data-a=co]').classList.remove('bad') }, pgo: goPreview,
  cclr: clearConsole,
  fs: () => { if (!fs) { consoleBeforeFullscreen = !con.hidden; con.hidden = true } else con.hidden = !consoleBeforeFullscreen; fs = !fs; render() },
  imp: () => zin.click(),
  exp: async () => {
    flush(); const zip = new JSZip()
    files.forEach((f) => { f.dir ? zip.folder(f.path) : zip.file(f.path, f.data as any) })
    download(await zip.generateAsync({ type: 'blob' }), 'madobakocode.zip')
  },
  rst: async () => {
    if (!(await ask('すべてのファイルを削除し、初期状態に戻します。よろしいですか？', 'リセットの確認'))) return
    await req(S('fs', 'readwrite').clear()); files.clear(); await put({ path: 'index.html', data: SEED })
    cur = ''; last = ''; open.clear(); sel.clear(); dirty = false; loadView(); saveUI(); render()
  },
}
// エディター内の Delete: 選択範囲があるときは CodeMirror より先に横取りして確認する(無選択の1文字削除は CodeMirror に任せる)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' || e.ctrlKey || e.metaKey || dlg.open || !(e.target as HTMLElement).closest?.('.cm-editor')) return
  if (view.state.selection.main.empty) return
  e.preventDefault(); e.stopPropagation(); focus = 'editor'; kb('del')
}, true)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dlg.open) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  const key = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (['a', 'c', 'x', 'v'].includes(key)) { e.preventDefault(); kb(key) }
  } else if (e.key === 'Delete') { if ((e.target as HTMLElement).closest?.('.cm-editor')) return; e.preventDefault(); kb('del') }
})
document.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('[data-a]')) e.preventDefault() })
document.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement; if (b) A[b.dataset.a!]?.() })
addEventListener('pagehide', () => { flush(); saveUI() })
document.addEventListener('visibilitychange', () => { if (document.hidden) { flush(); saveUI() } })

// ---------- boot ----------
;(async () => {
  db = await openDB()
  for (const f of await req(S('fs').getAll())) files.set(f.path, f)
  if (!files.has('index.html')) await put({ path: 'index.html', data: SEED })
  const u = await req(S('kv').get('ui'))
  if (u) { cur = files.has(u.cur) ? u.cur : ''; open = new Set(u.open || []); mode = u.mode || 'edit' }
  navigator.storage?.persist?.()
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href).then(() => navigator.serviceWorker.ready).then(async () => {
      const c = await caches.open('app')
      const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.startsWith(location.origin) && !n.includes('__preview__'))
      await c.addAll([...new Set([location.href, new URL('manifest.webmanifest', document.baseURI).href, new URL('icon.svg', document.baseURI).href, ...urls])]).catch(() => {})
    }).catch(() => {})
  }
  loadView(); render()
  if (mode === 'pv') { const m = mode; mode = 'edit'; setMode(m) }
})()
