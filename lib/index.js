/**
 * dsh-chat-background — host half.
 *
 * Gives DSH a wallpaper: a local or remote image, or a looping video, painted
 * behind the whole shell while the shell's own base surfaces go transparent so
 * the picture shows through.
 *
 * Three surfaces, all hosted here:
 *
 *   injected rows  `webserver/index-inject` collects a table the carriers render
 *                  into index.html (Web) or apply page-side before settling
 *                  `__DSH_BOOT_READY__` (Desktop). One `style` row plus one
 *                  synchronous `script` row are on the glass during parsing, so
 *                  the wallpaper is painted on the first frame.
 *   media route    `/dsh-chat-bg/media` streams the current file with byte-range
 *                  support, so a video can be seeked and no image inflates the
 *                  document. It resolves its file **per request** (settings
 *                  file first, config second), which is what lets a new picture
 *                  appear without restarting the host.
 *   image route    `/dsh-chat-bg/image` is the small control API behind the
 *                  Settings row: `GET` reports the effective picture, `POST`
 *                  validates a pasted path and records it. Writing goes to a
 *                  sidecar JSON next to the profile — never to the user's
 *                  `cordis.patch.yml`, because a malformed patch file is fatal
 *                  at boot and a wallpaper must not be able to break startup.
 *
 * Live tuning of opacity/frost is the page's business (`lib/client.js` and the
 * injected script share one `localStorage` contract), because both carriers
 * freeze their injected rows at boot.
 *
 * Activation is deliberately forgiving: a missing or unusable `media` value
 * never fails the boot. Nothing configured injects nothing, while a picture that
 * is configured but unreadable still mounts both routes and paints an empty
 * route-backed layer, so the Settings row can repair the wallpaper without a
 * restart. A wallpaper must never be a boot risk, and it must never become
 * unrecoverable either.
 *
 * @module dsh-chat-background
 */

import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader row name. */
export const name = 'chat-background'

/** The routes and DOM ids this plugin owns. */
const ROUTE_MEDIA = '/dsh-chat-bg/media'
const ROUTE_IMAGE = '/dsh-chat-bg/image'
const MEDIA_ID = 'dsh-chat-bg'
const SCRIM_ID = 'dsh-chat-bg-scrim'

/** Sidecar state file, written beside the profile. */
const STATE_FILE_NAME = 'dsh-chat-background.json'

/** Control-request body ceiling; a Windows path is tiny. */
const MAX_CONTROL_BODY = 8192

/** Extension → MIME. Anything absent falls back to the detected kind. */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

/** Extensions treated as video for `type: auto`. */
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv'])

/** Above this, `mode: auto` refuses to inline a video (base64 costs 4/3). */
const DEFAULT_MAX_INLINE_BYTES = 24 * 1024 * 1024

const DEFAULT_POSITION = 'center'
const DEFAULT_SCRIM = 'rgba(0,0,0,.38)'

/** Document colour behind a background-less boot, so the frame is never bare. */
const PENDING_FALLBACK = '#101114'

/** The empty, route-backed layer painted when a configured picture is unreadable. */
const PENDING_MEDIA = Object.freeze({ type: 'image', absolute: '', mime: undefined, file: undefined })

/** Live-tuning contract shared with the browser half (`lib/client.js`).
 *
 * The wallpaper's opacity and frost are owned by the page, not by this host
 * half: the injected script applies whatever the Settings row last saved, so a
 * value change takes effect on the spot instead of waiting for a host restart
 * (the carriers snapshot their index injections once, at boot). Percentages are
 * the unit on both sides; `BLUR_FULL_PX` is the frost a 100% setting means.
 */
const STORE_OPACITY_KEY = 'dsh-chat-background:opacity'
const STORE_BLUR_KEY = 'dsh-chat-background:blur'
const BLUR_FULL_PX = 40
const DEFAULT_OPACITY_PCT = 50

/** Clamp a numeric config value, falling back when it is not a number. */
function num(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Collapse whitespace so a config value cannot open a CSS declaration. */
function cssToken(value, fallback) {
  const text = String(value ?? '').trim()
  if (text === '' || /[;{}<>]/.test(text)) return fallback
  return text
}

/** One of `allowed`, or the fallback. */
function oneOf(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase()
  return allowed.includes(text) ? text : fallback
}

/** JSON for embedding inside a `<script>` body, with `<` made inert. */
function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/** Read a service/value without throwing when it is absent. */
function serviceOf(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ paths --- */

/**
 * The absolute local path behind a pasted value.
 *
 * Windows' "复制文件地址" produces a double-quoted path, and a browser's
 * "copy link" produces `file:///C:/...`; both are accepted, along with a bare
 * path and either slash direction. Curly quotes are tolerated because they are
 * what you get when a path is pasted through a word processor.
 *
 * @param raw - the pasted text.
 * @returns the candidate path, or `''` when nothing was pasted.
 */
function toLocalPath(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''
  text = text.replace(/^[\s"'\u201c\u201d\u2018\u2019]+/u, '').replace(/[\s"'\u201c\u201d\u2018\u2019]+$/u, '')
  if (/^file:\/\//iu.test(text)) {
    try {
      text = fileURLToPath(text)
    } catch {
      return ''
    }
  }
  return text.trim()
}

/** `image` / `video` for a supported extension, else `undefined`. */
function kindOfPath(file) {
  const ext = extname(file).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  return MIME[ext] === undefined ? undefined : 'image'
}

/** MIME for a path, falling back to the kind's default container. */
function mimeOfPath(file, type) {
  return MIME[extname(file).toLowerCase()] ?? (type === 'video' ? 'video/mp4' : 'image/png')
}

/**
 * Validate one candidate picture path.
 * @param raw - the pasted value.
 * @returns `{ ok: true, file, type, mime, size }` or `{ ok: false, error }`.
 */
function inspectMediaPath(raw) {
  const text = toLocalPath(raw)
  if (text === '') return { ok: false, error: '没有填路径' }
  if (!isAbsolute(text)) return { ok: false, error: `需要绝对路径，收到的是：${text}` }
  const file = resolvePath(text)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { ok: false, error: `找不到这个文件：${file}` }
  }
  if (!stat.isFile()) return { ok: false, error: `这不是一个文件：${file}` }
  const type = kindOfPath(file)
  if (type === undefined) {
    const ext = extname(file)
    return { ok: false, error: `不是支持的图片/视频格式：${ext === '' ? '（没有扩展名）' : ext}` }
  }
  return { ok: true, file, type, mime: mimeOfPath(file, type), size: stat.size }
}

/* ------------------------------------------------------------------ state --- */

/** Where the sidecar lives: the profile directory, or this package as a fallback. */
function stateFilePath(ctx) {
  const profile = serviceOf(ctx, 'profileContext')
  const candidates = [
    profile?.dir,
    profile?.profileDir,
    process.env.DSH_PROFILE_DIR,
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? join(process.env.DSH_HOME, 'profiles', typeof profile?.name === 'string' && profile.name !== '' ? profile.name : 'desktop')
      : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return join(candidate, STATE_FILE_NAME)
  }
  return join(dirname(fileURLToPath(import.meta.url)), STATE_FILE_NAME)
}

/** The sidecar's contents; `{}` when absent or unreadable. */
function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Merge into the sidecar, replacing it atomically. */
function writeState(file, patch) {
  const next = { ...readState(file), ...patch, updatedAt: new Date().toISOString() }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return next
}

/** The path the settings file currently asks for, or the config's. */
function requestedMedia(config, state) {
  const fromState = typeof state.media === 'string' ? state.media.trim() : ''
  if (fromState !== '') return { raw: fromState, source: 'setting' }
  const fromConfig = String(config.media ?? '').trim()
  return { raw: fromConfig, source: fromConfig === '' ? 'none' : 'config' }
}

/* ------------------------------------------------------------------- media --- */

/**
 * Classify the boot media and load whatever the chosen mode needs.
 * @param raw - a file path or an `http(s)`/`data:` URL.
 * @param config - the resolved plugin config.
 * @returns the media descriptor, or `undefined` when nothing usable is set.
 */
function loadMedia(raw, config) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined

  const declared = oneOf(config.type, ['auto', 'image', 'video'], 'auto')

  // Remote and inline URLs need no file access; the page loads them directly.
  if (/^(?:https?:|data:|blob:)/iu.test(text)) {
    const looksVideo = /\bvideo\b|\.(?:mp4|webm|ogv|mov|m4v|mkv)(?:[?#]|$)/iu.test(text)
    const type = declared === 'auto' ? (looksVideo ? 'video' : 'image') : declared
    return { type, absolute: text, mime: undefined, file: undefined }
  }

  const file = resolvePath(text)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`not a file: ${file}`)

  const type = declared === 'auto' ? (kindOfPath(file) ?? 'image') : declared
  const mime = mimeOfPath(file, type)
  const maxInline = num(config.maxInlineBytes, DEFAULT_MAX_INLINE_BYTES, 0, Number.MAX_SAFE_INTEGER)

  const requested = oneOf(config.mode, ['auto', 'inline', 'route'], 'auto')
  let mode = requested
  if (mode === 'auto') mode = type === 'image' ? 'inline' : 'route'
  // An image the user forced onto the route is still fine, but an oversized
  // inline video would land in every document; fall back to the route instead.
  if (mode === 'inline' && type === 'video' && maxInline > 0 && stat.size > maxInline) mode = 'route'

  if (mode === 'inline') {
    const data = readFileSync(file).toString('base64')
    return { type, absolute: `data:${mime};base64,${data}`, mime, file, size: stat.size }
  }
  return { type, absolute: '', mime, file, size: stat.size }
}

/**
 * The file the media route serves right now.
 *
 * Re-read per request on purpose: the settings row can point the wallpaper at a
 * new file while the host keeps running, and this is the read that makes the new
 * picture appear without a restart.
 *
 * @param config - the resolved plugin config.
 * @param stateFile - the sidecar path.
 * @param fallback - the descriptor chosen at activation, used when the sidecar
 *   points at something unusable so the wallpaper never goes blank over a typo.
 * @returns a servable descriptor, or `undefined`.
 */
function liveMedia(config, stateFile, fallback) {
  const { source, raw } = requestedMedia(config, readState(stateFile))
  if (source === 'setting') {
    const inspected = inspectMediaPath(raw)
    if (inspected.ok) return { file: inspected.file, mime: inspected.mime, type: inspected.type }
  }
  if (fallback?.file !== undefined) {
    return { file: fallback.file, mime: mimeOfPath(fallback.file, fallback.type), type: fallback.type }
  }
  return undefined
}

/* --------------------------------------------------------------- injection --- */

/** The `style` row: the media layer, the scrim, and the made-transparent shell. */
function styleRow(media, config) {
  const opacity = num(config.opacity, 1, 0, 1)
  const dim = num(config.dim, 0.38, 0, 1)
  const fit = oneOf(config.fit, ['cover', 'contain', 'fill', 'none', 'scale-down'], 'cover')
  const position = cssToken(config.position, DEFAULT_POSITION)
  const scrim = cssToken(config.scrim, DEFAULT_SCRIM)
  const transparent = config.transparentSurfaces !== false
  const fallback = cssToken(config.fallback, '')

  // Opacity and frost are the Settings row's to own; the rule below only carries
  // the configured value as a first-paint default until the injected script
  // replaces it with whatever the user last saved.
  const layer = [
    'position:fixed',
    'inset:0',
    'z-index:-1',
    'pointer-events:none',
    `opacity:${opacity}`,
    'background-repeat:no-repeat',
    `background-size:${fit}`,
    `background-position:${position}`,
  ].join(';')

  const video = [
    'position:fixed',
    'inset:0',
    'z-index:-1',
    'pointer-events:none',
    'width:100%',
    'height:100%',
    `object-fit:${fit}`,
    `object-position:${position}`,
    `opacity:${opacity}`,
  ].join(';')

  const rules = [
    `#${MEDIA_ID}{${media.type === 'video' ? video : layer}}`,
    `#${SCRIM_ID}{position:fixed;inset:0;z-index:-1;pointer-events:none;background:${scrim};opacity:${dim}}`,
  ]
  if (transparent) {
    // --dsw-alias-bg-base paints the app frame and centre column;
    // --dsw-specific-sidebar-fill paints the sidebar and the Windows caption
    // strip. Both are declared on `body` (and on `body[data-ds-dark-theme]`),
    // so the overrides need the same reach and `!important` to win over the
    // theme bundle, which is injected after this row.
    rules.push(
      'html,body{background-color:transparent !important}',
      'body,body[data-ds-dark-theme]{--dsw-alias-bg-base:transparent !important;--dsw-specific-sidebar-fill:transparent !important}',
    )
  }
  if (fallback !== '') rules.push(`html{background-color:${fallback} !important}`)

  return { kind: 'style', text: rules.join('\n') }
}

/** The `script` row. Builds the media layer and the scrim, then starts playback.
 *
 * Both elements are created here rather than shipped as a raw `html` row: the
 * Web carrier renders rows into index.html text, while the Desktop carrier
 * hands the same table to a page-side interpreter, and creating the nodes from
 * one synchronous script runs identically on both. The row is inserted right
 * after the opening `<body>` tag, so the elements exist before the shell's own
 * scripts and the wallpaper is painted on the first frame.
 *
 * The script also owns the live surface: it applies the saved opacity and frost
 * and publishes `window.__dshChatBackground` for the Settings row to drive —
 * including `mediaUrl()`, so a newly chosen picture can be repainted from the
 * media route without reloading anything.
 */
function scriptRow(media, config) {
  const payload = scriptJson({
    type: media.type,
    // An absolute source (data: or http(s):) is carrier-independent; otherwise
    // the page resolves the streaming route. Only a document served over the
    // loopback origin itself may use the route path verbatim — every other
    // carrier (`file:` in a packaged window, or the Desktop's `dsh-app:` app
    // scheme) must be handed the absolute loopback origin, because a relative
    // path there resolves against the document's scheme rather than the server.
    absolute: media.absolute,
    path: ROUTE_MEDIA,
    base: config.loopbackBase ?? '',
    routeAvailable: config.routeAvailable === true,
    mediaId: MEDIA_ID,
    scrimId: SCRIM_ID,
    opacityKey: STORE_OPACITY_KEY,
    blurKey: STORE_BLUR_KEY,
    blurFullPx: BLUR_FULL_PX,
    defOpacity: Math.round(num(config.opacity, DEFAULT_OPACITY_PCT / 100, 0, 1) * 100),
    defBlur: Math.round(num(config.blur, 0, 0, 400) / (BLUR_FULL_PX / 100)),
  })
  const text = `(function(){var c=${payload};var host=document.body||document.documentElement;` +
    `var sameOrigin=location.protocol==="http:"||location.protocol==="https:";` +
    `var routeUrl=function(){return sameOrigin?c.path:(c.base?c.base+c.path:c.path)};` +
    `var mediaUrl=function(){return c.absolute||routeUrl()};` +
    `var el=document.getElementById(c.mediaId);if(!el){` +
    `var src=mediaUrl();if(!src)return;` +
    `if(c.type==="video"){el=document.createElement("video");el.muted=true;el.loop=true;el.autoplay=true;` +
    `el.setAttribute("playsinline","");el.setAttribute("muted","");el.setAttribute("preload","auto");` +
    `el.setAttribute("disablepictureinpicture","")}` +
    `else{el=document.createElement("div")}` +
    `el.id=c.mediaId;el.setAttribute("aria-hidden","true");` +
    `var scrim=document.createElement("div");scrim.id=c.scrimId;scrim.setAttribute("aria-hidden","true");` +
    `host.insertBefore(scrim,host.firstChild);host.insertBefore(el,scrim);` +
    `if(c.type==="video"){el.src=src;var go=function(){var p=el.play();if(p&&p.catch)p.catch(function(){})};` +
    `go();document.addEventListener("pointerdown",go,{once:true});document.addEventListener("keydown",go,{once:true})}` +
    `else{el.style.backgroundImage='url("'+src.replace(/"/g,"%22")+'")'}}` +
    // --- live tuning + live picture swap -------------------------------------
    `var clamp=function(v,f){var n=parseFloat(v);if(!isFinite(n))return f;return Math.min(100,Math.max(0,Math.round(n)))};` +
    `var read=function(key,fallback){try{var raw=window.localStorage.getItem(key);` +
    `return raw===null?fallback:clamp(raw,fallback)}catch(e){return fallback}};` +
    `var values=function(){return{opacity:read(c.opacityKey,c.defOpacity),blur:read(c.blurKey,c.defBlur)}};` +
    `var apply=function(){var v=values();var px=v.blur/100*c.blurFullPx;` +
    `el.style.opacity=String(v.opacity/100);` +
    `el.style.filter=px>0?"blur("+px+"px)":"none";` +
    `el.style.transform=px>0?"scale(1.06)":"none";return v};` +
    `var write=function(key,value){try{window.localStorage.setItem(key,String(clamp(value,0)))}catch(e){}};` +
    // Repaint from the media route itself, bypassing any cache. The route is
    // addressed directly rather than through `mediaUrl()`: when the boot media
    // was inlined, `mediaUrl()` is the old data URI and would repaint the very
    // picture the user just replaced.
    `var repaint=function(){if(!c.routeAvailable)return false;` +
    `var url=routeUrl();if(!url)return false;` +
    `url=url+(url.indexOf("?")<0?"?":"&")+"v="+Date.now();` +
    `if(c.type==="video"){el.src=url;var p=el.play();if(p&&p.catch)p.catch(function(){})}` +
    `else{el.style.backgroundImage='url("'+url.replace(/"/g,"%22")+'")'}return true};` +
    `window.__dshChatBackground={apply:apply,read:values,write:write,repaint:repaint,mediaUrl:mediaUrl,` +
    `keys:{opacity:c.opacityKey,blur:c.blurKey},blurFullPx:c.blurFullPx,element:el,type:c.type,` +
    `routeAvailable:c.routeAvailable,base:c.base,path:c.path};` +
    `apply();` +
    // The Desktop carrier may apply this row before <body> exists; retry briefly
    // so a late layer still receives the saved values.
    `if(!document.body){var tries=0;var timer=window.setInterval(function(){` +
    `if(document.body||++tries>20){window.clearInterval(timer);apply()}},50)}` +
    `})()`
  return { kind: 'script', placement: 'body', text }
}

/* ------------------------------------------------------------------ stream --- */

/** Parse one `Range: bytes=` header against a known size. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  let start
  let end
  if (rawStart === '') {
    const length = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(length) || length <= 0) return undefined
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  end = Math.min(end, size - 1)
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end }
}

/** Stream one file, honouring `Range` so `<video>` can seek. */
function serveFile(file, mime, req, res) {
  let size
  try {
    size = statSync(file).size
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('media gone')
    return
  }
  const headers = {
    'content-type': mime ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const range = req.headers?.range === undefined ? undefined : parseRange(req.headers.range, size)
  if (range?.unsatisfiable === true) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = end - start + 1
  const status = range === undefined ? 200 : 206
  res.writeHead(status, {
    ...headers,
    'content-length': String(length),
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/* ----------------------------------------------------------------- control --- */

/** Origins allowed to drive the control route: this app's own documents. */
function originAllowed(ctx, origin) {
  if (origin === 'null') return true
  if (origin === 'dsh-app://app') return true
  const port = serviceOf(ctx, 'webServer')?.port
  if (typeof port === 'number') {
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true
  }
  return false
}

/** Read a request body up to `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The image control route.
 *
 * Loopback-bound, and further restricted to this app's own document origins, so
 * an unrelated page in the user's browser cannot repoint the wallpaper and then
 * read the bytes back through the media route. CORS is echoed only to those
 * origins.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param stateFile - the sidecar path.
 * @param bootMedia - the descriptor chosen at activation.
 * @returns the route handler.
 */
function imageHandler(ctx, config, stateFile, bootMedia) {
  return async (req, res) => {
    const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined
    if (origin !== undefined && !originAllowed(ctx, origin)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `拒绝来自该来源的请求：${origin}` }))
      return
    }
    const cors = origin === undefined
      ? {}
      : { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin' }
    const json = (status, payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(text)), ...cors })
      res.end(text)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    if (req.method === 'GET') {
      const { raw, source } = requestedMedia(config, readState(stateFile))
      const inspected = inspectMediaPath(raw)
      json(200, {
        ok: true,
        media: inspected.ok ? inspected.file : raw,
        name: inspected.ok ? basename(inspected.file) : '',
        type: inspected.ok ? inspected.type : (bootMedia?.type ?? 'image'),
        source,
        valid: inspected.ok,
        // No picture chosen yet is not an error worth showing; a configured one
        // that cannot be read is, because that is what the row must fix.
        error: inspected.ok || source === 'none' ? undefined : inspected.error,
        stateFile,
      })
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST, OPTIONS', ...cors })
      res.end()
      return
    }

    let body
    try {
      body = await readBody(req, MAX_CONTROL_BODY)
    } catch (error) {
      json(413, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let requested = body
    try {
      const parsed = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.media === 'string') requested = parsed.media
    } catch {
      /* a bare path body is fine too */
    }

    const inspected = inspectMediaPath(requested)
    if (!inspected.ok) {
      json(400, { ok: false, error: inspected.error, stateFile })
      return
    }
    try {
      writeState(stateFile, { media: inspected.file })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn(`chat-background: could not write ${stateFile} — ${message}`)
      json(500, { ok: false, error: `无法写入设置文件：${message}`, stateFile })
      return
    }
    ctx.logger?.info?.(`chat-background: background picture set to ${inspected.file}`)
    json(200, {
      ok: true,
      media: inspected.file,
      name: basename(inspected.file),
      type: inspected.type,
      size: inspected.size,
      stateFile,
    })
  }
}

/* ------------------------------------------------------------------- mount --- */

/**
 * Mount the wallpaper.
 *
 * @param ctx - the plugin context; `ctx.webServer` is required for both routes.
 * @param config - the row config from `cordis.patch.yml` (or the state file's
 *   picture when one was chosen from Settings).
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const logger = ctx.logger
  const stateFile = stateFilePath(ctx)
  const { raw, source } = requestedMedia(settings, readState(stateFile))

  let media
  let bootFailure
  try {
    media = loadMedia(raw, settings)
  } catch (error) {
    bootFailure = error instanceof Error ? error.message : String(error)
    logger?.warn(`chat-background: ignoring the ${source === 'setting' ? 'saved' : 'configured'} media — ${bootFailure}`)
  }
  const unconfigured = media === undefined && bootFailure === undefined
  if (unconfigured) {
    logger?.warn('chat-background: no media configured — set config.media, or pick a picture in Settings → 通用')
  }

  // A picture that moved between two boots must not take the plugin's own repair
  // route down with it: both routes mount no matter what the boot picture turned
  // out to be, and the control route re-reads the sidecar per request, so the
  // Settings row can always replace a lost picture. Only the injected layer
  // depends on the outcome — nothing configured injects nothing (the stock look
  // stays), while a configured-but-unreadable picture injects an empty
  // route-backed layer over a dark fallback, so the next picture chosen in
  // Settings shows up through the shell that is already transparent, without a
  // restart. The fallback matters because an emptied document would otherwise
  // show the raw window colour behind the transparent frame.
  const injectMedia = media ?? (unconfigured ? undefined : PENDING_MEDIA)
  const injectSettings = injectMedia === PENDING_MEDIA
    ? { ...settings, fallback: cssToken(settings.fallback, '') === '' ? PENDING_FALLBACK : settings.fallback }
    : settings

  // Both routes are services, so they are reached through `ctx.inject`: the
  // callback runs as soon as the server is up (and again if it is replaced),
  // which keeps this plugin correct whether it activates before or after the
  // HTTP carrier, and inert on compositions that have none.
  let routeReady = false
  ctx.inject(['webServer'], (child) => {
    const disposers = []
    try {
      disposers.push(child.webServer.register({
        kind: 'exact',
        path: ROUTE_MEDIA,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const current = liveMedia(settings, stateFile, media)
          if (current === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('no local picture')
            return
          }
          serveFile(current.file, current.mime, req, res)
        },
      }))
      disposers.push(child.webServer.register({
        kind: 'exact',
        path: ROUTE_IMAGE,
        handler: imageHandler(ctx, settings, stateFile, media),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn(`chat-background: could not register the background routes — ${message}`)
      for (const dispose of disposers) dispose()
      return
    }
    routeReady = true
    child.effect(() => () => {
      routeReady = false
      for (const dispose of disposers) dispose()
    })
    logger?.info?.(`chat-background: media route armed at ${ROUTE_MEDIA}, control at ${ROUTE_IMAGE}`)
  })

  if (injectMedia !== undefined) {
    ctx.on('webserver/index-inject', (table) => {
      // Read the live port per render: rows are collected fresh for every index
      // response, so a replaced server needs no re-registration to be picked up.
      const server = serviceOf(ctx, 'webServer')
      const loopbackBase = routeReady && typeof server?.port === 'number' ? `http://127.0.0.1:${server.port}` : ''
      table.push(styleRow(injectMedia, injectSettings))
      table.push(scriptRow(injectMedia, { ...injectSettings, loopbackBase, routeAvailable: routeReady }))
    })
  }

  if (media === undefined) {
    const recovery = injectMedia === undefined ? 'nothing injected until a picture is chosen' : 'empty layer injected for live repair'
    logger?.info?.(`chat-background: no usable picture at boot — ${recovery}; state file ${stateFile}`)
  } else {
    const where = media.absolute === '' ? `route ${ROUTE_MEDIA}` : media.absolute.slice(0, 48)
    logger?.info?.(`chat-background: ${media.type} background active from ${source} (${where}); state file ${stateFile}`)
  }
}
