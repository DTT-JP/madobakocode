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

type F = { path: string; dir?: boolean; data?: string | Blob }
const TEXT = new Set('html htm css js mjs json svg txt md csv xml'.split(' '))
const MT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }
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
const put = (f: F) => { files.set(f.path, f); return req(S('fs', 'readwrite').put(f)) }
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

// ---------- state ----------
let mode: 'edit' | 'pv' = 'edit', cur = '', last = '', previewPath = 'index.html', fs = false, drawer = false, consoleBeforeFullscreen = false
let open = new Set<string>(), sel = new Set<string>()
let focus: 'tree' | 'editor' = 'tree'
let clip: { p: string[]; cut: boolean } | null = null
let dirty = false, timer: any = 0, binUrl = ''
const saveUI = () => req(S('kv', 'readwrite').put({ mode, cur, open: [...open] }, 'ui'))

// ---------- DOM ----------
const B = (a: string, t: string, c = '', l = t) => `<button data-a="${a}" class="${c}" title="${l}" aria-label="${l}"><span class="material-symbols-rounded">${t}</span><span class="nav-label">${l}</span></button>`
$('#app').innerHTML = `<nav id="ic"><div id="nav-brand"><img src="icon.svg" alt=""><span>MadoBakoCode</span></div><div id="nav-head">${B('pv', 'visibility', '', 'プレビュー') + B('ed', 'edit', '', 'エディター') + B('dr', 'menu', 'nw', 'ファイル')}<hr></div><div id="nav-middle"><div id="nav-scroll">
${[['add', 'add', 'ファイルを追加'], ['html', 'html', 'HTMLファイルを追加'], ['css', 'css', 'CSSファイルを追加'], ['js', 'javascript', 'JSファイルを追加'], ['dir', 'create_new_folder', 'フォルダを追加'], ['up', 'upload_file', 'ファイルをインポート'], ['ren', 'drive_file_rename_outline', '名前を変更'], ['del', 'delete', '削除'], ['a', 'select_all', 'すべて選択'], ['ua', 'deselect', 'すべて選択解除'], ['x', 'content_cut', '切り取り'], ['c', 'content_copy', 'コピー'], ['v', 'content_paste', '貼り付け']].map(([a, t, l]) => B(a, t, 'eb', l)).join('')}
${[['rl', 'refresh', '再読み込み'], ['co', 'terminal', 'コンソール'], ['fs', 'fullscreen', '全画面']].map(([a, t, l]) => B(a, t, 'pvb', l)).join('')}</div><div id="nav-scrollbar"><div id="nav-thumb"></div></div></div>
<div id="nav-foot"><hr>${B('imp', 'folder_zip', '', 'ZIPを読み込む') + B('exp', 'file_save', '', 'ZIPを書き出す') + B('rst', 'restart_alt', '', 'すべてリセット')}</div></nav>
<aside id="side"><div id="hd">FILES <span id="use"></span></div><div id="tree-area"><div id="tree" data-p="" data-d="1"></div><div id="tree-scrollbar"><div id="tree-thumb"></div></div></div></aside>
<main><div id="filebar"><span id="file-path"></span><span id="file-size"></span></div><div id="empty-guide">ファイルを選んで表示</div><div id="ed"></div><div id="bin"></div><div id="pv"><div id="previewbar"><span class="material-symbols-rounded">route</span><input id="preview-path" value="/index.html" aria-label="プレビューするファイルのパス"><button data-a="pgo" aria-label="このパスをプレビュー"><span class="material-symbols-rounded">arrow_forward</span></button></div><iframe id="ifr" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock" allow="autoplay; fullscreen; clipboard-write"></iframe>
<div id="con" hidden><div id="ch">CONSOLE<button data-a="cclr">Clear</button><button data-a="co" aria-label="コンソールを閉じる"><span class="material-symbols-rounded">expand_more</span></button></div><div id="cl"></div><input id="ci" placeholder="> JavaScript" autocapitalize="off" autocorrect="off"></div></div></main>
<button id="back" data-a="fs" aria-label="全画面を終了"><span class="back-label">全画面終了</span><span class="material-symbols-rounded">close</span></button><input type="file" id="upl" multiple hidden><input type="file" id="zin" accept=".zip,application/zip" hidden>
<dialog id="dlg"><form method="dialog"><h2 id="dlg-title"></h2><p id="dlg-message"></p><input id="dlg-input" autocomplete="off"><div><button value="cancel" id="dlg-cancel">キャンセル</button><button value="ok" id="dlg-ok">OK</button></div></form></dialog>`
const tree = $('#tree'), ed = $('#ed'), bin = $('#bin'), ifr = $('#ifr') as HTMLIFrameElement, con = $('#con'), cl = $('#cl')
const filePathEl = $('#file-path'), fileSizeEl = $('#file-size'), previewPathEl = $('#preview-path') as HTMLInputElement
const emptyGuide = $('#empty-guide'), navScroll = $('#nav-scroll'), navBar = $('#nav-scrollbar'), navThumb = $('#nav-thumb'), treeArea = $('#tree-area'), treeThumb = $('#tree-thumb'), treeBar = $('#tree-scrollbar')
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
  const f = files.get(cur), n = !f ? 0 : typeof f.data === 'string' ? new Blob([f.data]).size : f.data?.size || 0
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
  const blob = f.data as Blob, t = MT[ext(cur)] || blob.type
  binUrl = URL.createObjectURL(blob.type === t ? blob : blob.slice(0, blob.size, t))
  const k = t.split('/')[0]
  bin.innerHTML = k === 'image' ? `<img src="${binUrl}">` : k === 'audio' ? `<audio src="${binUrl}" controls></audio>` : k === 'video' ? `<video src="${binUrl}" controls playsinline></video>` : `<div>${esc(base(cur))}<br>${(blob.size / 1024) | 0} KB（プレビュー非対応）</div>`
}
function updateNavScrollbar() {
  const max = navScroll.scrollHeight - navScroll.clientHeight
  const ratio = navScroll.clientHeight / navScroll.scrollHeight
  navBar.hidden = max <= 0
  if (max > 0) {
    navThumb.style.height = `${Math.max(28, navScroll.clientHeight * ratio)}px`
    navThumb.style.transform = `translateY(${(navScroll.clientHeight - navScroll.clientHeight * ratio) * navScroll.scrollTop / max}px)`
  }
}
navScroll.addEventListener('scroll', updateNavScrollbar)
let navDrag = { y: 0, top: 0 }
navThumb.addEventListener('pointerdown', (e) => { navDrag = { y: e.clientY, top: navScroll.scrollTop }; navThumb.setPointerCapture(e.pointerId) })
navThumb.addEventListener('pointermove', (e) => { if (navThumb.hasPointerCapture(e.pointerId)) navScroll.scrollTop = navDrag.top + (e.clientY - navDrag.y) * navScroll.scrollHeight / navScroll.clientHeight })
navThumb.addEventListener('pointerup', (e) => navThumb.releasePointerCapture(e.pointerId))
function updateTreeScrollbar() {
  const max = tree.scrollHeight - tree.clientHeight
  const ratio = tree.clientHeight / tree.scrollHeight
  treeBar.hidden = max <= 0
  if (max > 0) {
    treeThumb.style.height = `${Math.max(28, tree.clientHeight * ratio)}px`
    treeThumb.style.transform = `translateY(${(tree.clientHeight - tree.clientHeight * ratio) * tree.scrollTop / max}px)`
  }
}
tree.addEventListener('scroll', updateTreeScrollbar)
let treeDrag = { y: 0, top: 0 }
treeThumb.addEventListener('pointerdown', (e) => { treeDrag = { y: e.clientY, top: tree.scrollTop }; treeThumb.setPointerCapture(e.pointerId) })
treeThumb.addEventListener('pointermove', (e) => { if (treeThumb.hasPointerCapture(e.pointerId)) tree.scrollTop = treeDrag.top + (e.clientY - treeDrag.y) * tree.scrollHeight / tree.clientHeight })
treeThumb.addEventListener('pointerup', (e) => treeThumb.releasePointerCapture(e.pointerId))
addEventListener('resize', () => { updateNavScrollbar(); updateTreeScrollbar() })
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
    out.push(`<div class="row${f.path === cur ? ' cur' : ''}${sel.has(f.path) ? ' sel' : ''}" data-p="${esc(f.path)}" data-d="${f.dir ? 1 : 0}" style="padding-left:${6 + depth * 14}px"><span class="h material-symbols-rounded">drag_indicator</span>${sel.size ? `<input type="checkbox" ${sel.has(f.path) ? 'checked' : ''}>` : ''}<span>${f.dir ? `<span class="material-symbols-rounded fold">${open.has(f.path) ? 'keyboard_arrow_down' : 'chevron_right'}</span>` : ''}${esc(base(f.path))}</span></div>`)
    if (f.dir && open.has(f.path)) rows(f.path, depth + 1, out)
  }
}
function renderTree() { const o: string[] = []; rows('', 0, o); tree.innerHTML = o.join(''); useSize(); requestAnimationFrame(() => { updateNavScrollbar(); updateTreeScrollbar() }) }
function useSize() {
  let n = 0; files.forEach((f) => { n += typeof f.data === 'string' ? f.data.length : f.data ? f.data.size : 0 })
  $('#use').textContent = (n / 1048576).toFixed(1) + ' MB'
}
function render() {
  document.body.className = (mode === 'pv' ? 'm-pv' : 'm-edit') + (fs ? ' fs' : '') + (drawer ? ' dr' : '')
  document.querySelectorAll('[data-a=pv]').forEach((b) => b.classList.toggle('on', mode === 'pv'))
  document.querySelectorAll('[data-a=ed]').forEach((b) => b.classList.toggle('on', mode === 'edit'))
  renderTree()
}
const toggle = (p: string) => { sel.has(p) ? sel.delete(p) : sel.add(p); renderTree() }

let dr: any = null, lp: any = 0, skip = false
tree.addEventListener('pointerdown', (e) => {
  focus = 'tree'; skip = false
  const t = e.target as HTMLElement, r = t.closest('.row') as HTMLElement
  if (!r) return
  const p = r.dataset.p!
  dr = { p, x: e.clientX, y: e.clientY, on: false, ok: e.pointerType !== 'touch' || !!t.closest('.h') }
  lp = setTimeout(() => { if (dr && !dr.on) { skip = true; toggle(p) } }, 500)
})
addEventListener('pointermove', (e) => {
  if (!dr || !dr.ok) return
  if (!dr.on && Math.hypot(e.clientX - dr.x, e.clientY - dr.y) > 8) { dr.on = true; clearTimeout(lp); document.body.classList.add('drag') }
  if (dr.on) {
    document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'))
    ;(document.elementFromPoint(e.clientX, e.clientY) as HTMLElement)?.closest('.row[data-d="1"]')?.classList.add('over')
  }
})
addEventListener('pointerup', (e) => {
  clearTimeout(lp)
  if (dr?.on) {
    skip = true
    const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement)?.closest('[data-d="1"]') as HTMLElement
    if (t) {
      const d = t.dataset.p!, ps = sel.has(dr.p) ? top([...sel]) : [dr.p]
      flush(); open.add(d)
      ;(async () => { for (const p of ps) await mv(p, join(d, base(p))); sel.clear(); saveUI(); render() })()
    }
  }
  document.body.classList.remove('drag'); dr = null
})
addEventListener('pointercancel', () => { clearTimeout(lp); dr = null; document.body.classList.remove('drag') })
tree.addEventListener('click', (e) => {
  if (skip) { skip = false; return }
  const r = (e.target as HTMLElement).closest('.row') as HTMLElement
  if (!r) return
  const p = r.dataset.p!
  last = p
  if (sel.size || e.ctrlKey || e.metaKey || e.shiftKey) return toggle(p)
  if (r.dataset.d === '1') { open.has(p) ? open.delete(p) : open.add(p); saveUI(); renderTree() }
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
const destDir = () => { const t = [...sel][0] ?? last; if (!t) return ''; return files.get(t)?.dir ? t : parent(t) }
async function make(path: string, data = '') {
  if (files.has(path)) return dialog('同名のファイルがあります', '追加できません')
  if (!isText(path)) return dialog('テキスト系の拡張子のみ作成できます。画像等はアップロードしてください', '追加できません')
  flush(); await mkdirs(path); await put({ path, data })
  const d = parent(path); if (d) open.add(d)
  select(path); render()
}
async function removeTargets() {
  const ts = top(targets())
  if (!ts.length || !(await ask(`${ts.length} 件を削除します。よろしいですか？`, '削除の確認'))) return
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
    else if (k === 'del') deleteCharForward(view)
    else navigator.clipboard.readText().then((x) => view.dispatch(view.state.replaceSelection(x)), () => dialog('クリップボードの読み取りが許可されませんでした', '貼り付けできません'))
    return
  }
  if (k === 'a') { sel = new Set(files.keys()); renderTree() }
  else if (k === 'c' || k === 'x') clip = { p: top(targets()), cut: k === 'x' }
  else if (k === 'v') paste()
  else removeTargets()
}

// ---------- preview / console ----------
const normalizedPreviewPath = () => (previewPathEl.value || previewPath).replace(/^\/+/, '').trim() || 'index.html'
const previewUrl = () => new URL('__preview__/' + normalizedPreviewPath().split('/').map(encodeURIComponent).join('/'), document.baseURI).href + '?t=' + Date.now()
function reload() { flush(); previewPath = normalizedPreviewPath(); previewPathEl.value = '/' + previewPath; cl.innerHTML = ''; ifr.src = previewUrl() }
function goPreview() { previewPath = normalizedPreviewPath(); reload() }
function line(l: string, t: string) {
  const d = document.createElement('div'); d.className = 'l ' + l; d.textContent = t; cl.append(d); cl.scrollTop = 1e9
  if (l === 'error' && con.hidden) $('[data-a=co]').classList.add('bad')
}
addEventListener('message', (e) => {
  if (e.source === ifr.contentWindow && e.data?.__con) line(e.data.__con[0], e.data.__con[1])
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
      else { const b = await e.async('blob'); await put({ path: p, data: b.slice(0, b.size, MT[ext(p)] || 'application/octet-stream') }) }
    }
    loadView(); saveUI(); render()
  } catch (x) { dialog('ZIPを読み込めませんでした: ' + x, '読み込みエラー') }
})
upl.addEventListener('change', async () => {
  const d = destDir()
  for (const f of [...upl.files!]) {
    if (f.size > 50e6 && !(await ask(`${f.name} は ${(f.size / 1e6) | 0}MB あります。追加しますか？`, '大きなファイル'))) continue
    const p = uniq(join(d, f.name)); await mkdirs(p)
    await put({ path: p, data: isText(p) ? await f.text() : f })
  }
  upl.value = ''; if (d) open.add(d); render()
})

// ---------- actions ----------
const A: Record<string, () => any> = {
  pv: () => setMode('pv'), ed: () => setMode('edit'), dr: () => { drawer = !drawer; render() },
  add: async () => { const n = await promptInApp('ファイル名（例: a.txt / sub/b.js）', '', 'ファイルを追加'); if (n?.trim()) return make(join(destDir(), n.trim())) },
  html: () => make(uniq('index.html'), SEED),
  js: () => make(uniq('script.js')), css: () => make(uniq('main.css')),
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
  cclr: () => { cl.innerHTML = '' },
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dlg.open) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  const key = e.key.toLowerCase()
  if (e.ctrlKey || e.metaKey) {
    if (['a', 'c', 'x', 'v'].includes(key)) { e.preventDefault(); kb(key) }
  } else if (e.key === 'Delete') { e.preventDefault(); kb('del') }
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
