// 1) アプリ本体のキャッシュ（PWA）  2) __preview__/* を IndexedDB から配信
const MIME={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml',txt:'text/plain',md:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',xml:'application/xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',wasm:'application/wasm'}
const hook=off=>{
  const PV='/__preview__/'
  const rel=u=>{try{const x=new URL(u,location.href);const i=x.pathname.indexOf(PV);return i>=0?decodeURIComponent(x.pathname.slice(i+PV.length)):x.host+x.pathname}catch(e){return String(u||'')}}
  const fmt=x=>{try{return typeof x==='string'?x:x instanceof Error?(x.stack||String(x)):(JSON.stringify(x)??String(x))}catch(e){return String(x)}}
  const send=(l,t,f,n,c)=>{if(f===rel(location.href)&&n>0)n=Math.max(1,n-off);try{parent.postMessage({__con:{l,t,f,n,c}},'*')}catch(e){}}
  function __mbc_where(){const st=(new Error().stack||'').split('\n');for(const ln of st){if(ln.indexOf('__mbc_')>=0)continue;const m=/(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(ln);if(m&&m[1].indexOf(PV)>=0)return[rel(m[1]),+m[2],+m[3]]}return[rel(location.href),0,0]}
  for(const l of['log','info','warn','error','debug']){const o=console[l];console[l]=function __mbc_log(...a){const w=__mbc_where();send(l,a.map(fmt).join(' '),w[0],w[1],w[2]);o.apply(console,a)}}
  addEventListener('error',e=>{
    const t=e.target
    if(t&&t!==window&&(t.src||t.href)){send('error','読み込めません: '+rel(t.src||t.href)+' (<'+t.tagName.toLowerCase()+'>)',rel(location.href),0,0);return}
    send('error',(e.message||'Error'),e.filename?rel(e.filename):rel(location.href),e.lineno||0,e.colno||0)
  },true)
  addEventListener('unhandledrejection',e=>{const r=e.reason;const m=r&&r.stack?/(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(r.stack):null;send('error','Unhandled: '+((r&&r.stack)||r),m?rel(m[1]):rel(location.href),m?+m[2]:0,m?+m[3]:0)})
}
// 注入した改行数(=ユーザーのHTMLの行番号のずれ)をフックへ渡して補正する
const HOOK=`<script>(${hook})(${(String(hook).match(/\n/g)||[]).length+0})<\/script>`
let dbp
const db=()=>dbp||(dbp=new Promise((res,rej)=>{const r=indexedDB.open('madobakocode',1);r.onupgradeneeded=()=>{r.result.createObjectStore('fs',{keyPath:'path'});r.result.createObjectStore('kv')};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))
const getFile=async p=>{const d=await db();return new Promise(res=>{const r=d.transaction('fs').objectStore('fs').get(p);r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)})}
const normalizePath=p=>{const a=[];for(const x of p.split('/')){if(!x||x==='.'){continue}if(x==='..'){a.pop();continue}a.push(x)}return a.join('/')||'index.html'}
self.addEventListener('install',()=>self.skipWaiting())
self.addEventListener('activate',e=>e.waitUntil(clients.claim()))
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url)
  if(u.origin!==location.origin||e.request.method!=='GET')return
  const i=u.pathname.indexOf('/__preview__/')
  if(i>=0)return e.respondWith(preview(e.request,normalizePath(decodeURIComponent(u.pathname.slice(i+13)))))
  e.respondWith(appFetch(e.request))
})
async function appFetch(r){
  const c=await caches.open('app')
  const hit=await c.match(r,{ignoreSearch:true})
  const net=fetch(r).then(x=>{if(x.ok)c.put(r,x.clone());return x}).catch(()=>null)
  return hit||(await net)||Response.error()
}
async function preview(req,path){
  const f=await getFile(path)
  if(!f||f.dir)return new Response(`<!doctype html><meta charset="utf-8"><title>404 Not Found</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#151a1b;color:#e0e3e3;font:16px system-ui,sans-serif}main{text-align:center}h1{font-size:64px;margin:0;color:#8bd5c7}p{color:#aab4b4}</style><main><h1>404</h1><p>ファイルが見つかりません</p><p>${path}</p></main>`,{status:404,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})
  const ext=path.split('.').pop().toLowerCase()
  let type=MIME[ext]||(f.data&&f.data.type)||'application/octet-stream'
  if(/^text\/|json|svg|xml/.test(type))type+='; charset=utf-8'
  const h={'content-type':type,'cache-control':'no-store','accept-ranges':'bytes'}
  if(ext==='html'||ext==='htm'){
    let t=typeof f.data==='string'?f.data:await f.data.text()
    const m=/<head[^>]*>/i.exec(t)||/<html[^>]*>/i.exec(t)||/^\s*<!doctype[^>]*>/i.exec(t)
    const i=m?m.index+m[0].length:0
    return new Response(t.slice(0,i)+HOOK+t.slice(i),{headers:h})
  }
  const blob=f.data instanceof Blob?f.data:new Blob([f.data||''])
  const rg=/bytes=(\d*)-(\d*)/.exec(req.headers.get('range')||'')
  if(rg){
    const n=blob.size
    const s=rg[1]===''?Math.max(0,n-+rg[2]):+rg[1]
    const en=rg[1]===''||rg[2]===''?n-1:Math.min(+rg[2],n-1)
    if(s>=n)return new Response(null,{status:416,headers:{'content-range':'bytes */'+n}})
    return new Response(blob.slice(s,en+1),{status:206,headers:{...h,'content-range':`bytes ${s}-${en}/${n}`,'content-length':String(en-s+1)}})
  }
  return new Response(blob,{headers:{...h,'content-length':String(blob.size)}})
}
