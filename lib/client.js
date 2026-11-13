/**
 * dsh-chat-background — browser half.
 *
 * Contributes one row to the client's Settings → 通用 section:
 *
 *   不透明度 / 磨砂度   two manually typed percentage fields
 *   图片路径            a pasted Windows path ("复制文件地址"), applied on
 *                       Enter or 应用, confirmed by a dialog
 *
 * Why the browser half owns all three: both carriers freeze their injected rows
 * at boot (`ctx.webServer.collectIndexInjections()` is called once in the
 * Desktop host and shipped to the window), so nothing baked into the document
 * can change while the app runs. Opacity and frost are therefore repainted
 * through `window.__dshChatBackground` (see `lib/index.js`), and the picture
 * path is handed to the host's own control route — which writes a sidecar file
 * the media route reads *per request*, so the new picture appears immediately
 * instead of after a restart.
 *
 * Contract with the host half:
 *
 *   localStorage 'dsh-chat-background:opacity'   0..100
 *   localStorage 'dsh-chat-background:blur'      0..100  (100 = 40px)
 *   localStorage 'dsh-chat-background:image'     last accepted path, for prefill
 *   GET  /dsh-chat-bg/image   -> { ok, media, name, type, source, valid, error }
 *   POST /dsh-chat-bg/image   <- { media: '<absolute local path>' }
 *
 * The bundle is a lazy CJS factory: running it only registers the factory, and
 * the module body below runs when the shell materialises the plugin. `react` is
 * a platform seed, so it needs no `dsh.client.external` entry.
 */

window.__ModuleLoader__.load({
	id: 'dsh-chat-background',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')

		/** Percentage field bounds; the host half maps 100% frost to 40px. */
		const MIN_PCT = 0
		const MAX_PCT = 100
		const FALLBACK_OPACITY_PCT = 50
		const FALLBACK_BLUR_PCT = 0
		const OPACITY_KEY = 'dsh-chat-background:opacity'
		const BLUR_KEY = 'dsh-chat-background:blur'
		const IMAGE_KEY = 'dsh-chat-background:image'
		const ROW_STYLE_ID = 'dsh-chat-background-row-style'
		const DIALOG_ID = 'dsh-chat-background-dialog'
		const IMAGE_PATH = '/dsh-chat-bg/image'

		/* ------------------------------------------------------------ fetch --- */

		/**
		 * Fetch through the page's own `fetch`, which the carriers may replace
		 * with their IPC bridge; bound to its scope because `fetch` throws on an
		 * illegal invocation.
		 *
		 * @param input - URL.
		 * @param init - optional request init.
		 */
		function doFetch(input, init) {
			const scope = typeof window === 'undefined' ? globalThis : window
			const fn = typeof scope.fetch === 'function' ? scope.fetch : undefined
			if (fn === undefined) return Promise.reject(new Error('这个页面没有 fetch'))
			return fn.call(scope, input, init)
		}

		/** The injected script's live surface, when the host half is present. */
		function surface() {
			const api = window.__dshChatBackground
			return api !== undefined && typeof api.apply === 'function' ? api : undefined
		}

		/**
		 * Candidate URLs for the control route.
		 *
		 * The document-relative form is right for both carriers: an `http(s)`
		 * document resolves it against the loopback server, and the Desktop's
		 * `dsh-app://app` document resolves it through the shell's own protocol
		 * handler. The absolute loopback origin is the fallback for a carrier that
		 * does not proxy unknown paths.
		 *
		 * @returns distinct URLs to try in order.
		 */
		function controlUrls() {
			const urls = [IMAGE_PATH]
			const api = surface()
			if (api !== undefined && typeof api.base === 'string' && api.base !== '') {
				urls.push(`${api.base}${IMAGE_PATH}`)
			}
			return urls
		}

		/** POST the picture path, trying each candidate URL in order. */
		async function postPicture(path) {
			let lastError
			for (const url of controlUrls()) {
				let response
				try {
					response = await doFetch(url, {
						method: 'POST',
						// A CORS-safelisted content type keeps this a simple request,
						// so the Desktop carrier needs no preflight.
						headers: { 'content-type': 'text/plain;charset=UTF-8' },
						body: JSON.stringify({ media: path }),
					})
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error)
					continue
				}
				let payload
				try {
					payload = await response.json()
				} catch {
					payload = undefined
				}
				if (payload === undefined || payload === null || typeof payload !== 'object') {
					lastError = `宿主返回了无法解析的响应（HTTP ${response.status}）`
					continue
				}
				return payload
			}
			return { ok: false, error: `无法访问宿主的背景接口：${lastError ?? '未知原因'}` }
		}

		/** GET the effective picture, or `undefined` when the route is unreachable. */
		async function getPicture() {
			for (const url of controlUrls()) {
				try {
					const response = await doFetch(url, { method: 'GET' })
					const payload = await response.json()
					if (payload !== null && typeof payload === 'object') return payload
				} catch {
					/* try the next candidate */
				}
			}
			return undefined
		}

		/* ------------------------------------------------------------ style --- */

		/** One-time styles for the row, the fields and the dialogs. */
		function ensureRowStyle() {
			if (document.getElementById(ROW_STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = ROW_STYLE_ID
			style.textContent = [
				'.dshbg-row{display:flex;flex-direction:column;gap:10px;padding:4px 0}',
				'.dshbg-line{display:flex;align-items:center;justify-content:space-between;gap:24px}',
				'.dshbg-text{min-width:0}',
				'.dshbg-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
				'.dshbg-desc{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#8b8f96));font-size:12px;line-height:18px;margin-top:2px}',
				'.dshbg-ctrl{display:flex;align-items:center;gap:20px;flex:none}',
				'.dshbg-field{display:flex;align-items:center;gap:6px}',
				'.dshbg-label{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#8b8f96));font-size:12px;white-space:nowrap}',
				'.dshbg-input{width:52px;padding:4px 8px;text-align:right;font:inherit;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;outline:none;appearance:textfield;-moz-appearance:textfield}',
				'.dshbg-input::-webkit-outer-spin-button,.dshbg-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
				'.dshbg-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}',
				'.dshbg-unit{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#7f8287));font-size:12px}',
				'.dshbg-pic{display:flex;align-items:center;gap:8px}',
				'.dshbg-path{flex:1;width:auto;min-width:0;text-align:left;font-size:12px;padding:5px 9px}',
				'.dshbg-path::placeholder{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#7f8287))}',
				'.dshbg-btn{flex:none;padding:5px 14px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;cursor:default}',
				'.dshbg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.24))}',
				'.dshbg-btn[disabled]{opacity:.5}',
				'.dshbg-note{color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#8b8f96));font-size:12px;line-height:18px;margin-top:4px;word-break:break-all}',
				'.dshbg-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);-webkit-app-region:no-drag}',
				'.dshbg-panel{min-width:320px;max-width:min(560px,92vw);padding:20px 22px 16px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#232325);color:var(--dsw-alias-label-primary);box-shadow:0 3px 8px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.18),0 0 0 .5px var(--dsw-alias-border-l3,rgba(255,255,255,.12))}',
				'.dshbg-panel-title{font-size:14px;line-height:20px;font-weight:500}',
				'.dshbg-panel-body{font-size:13px;line-height:20px;margin-top:8px;word-break:break-word}',
				'.dshbg-panel-detail{font-size:11px;line-height:16px;margin-top:8px;word-break:break-all;white-space:pre-wrap;color:var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-secondary,#8b8f96))}',
				'.dshbg-panel-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}',
			].join('\n')
			document.head.appendChild(style)
		}

		/* ----------------------------------------------------------- dialog --- */

		/**
		 * Show one modal message. Built from plain DOM rather than a shared
		 * primitive so a failed lookup can never take the Settings page down with
		 * it; the palette comes from the same `--dsw-*` tokens the row uses.
		 *
		 * @param options - title, body, optional detail, optional confirm label.
		 */
		function showDialog({ title, body, detail, confirmLabel = '确定' }) {
			ensureRowStyle()
			const previous = document.getElementById(DIALOG_ID)
			if (previous !== null) previous.remove()

			const overlay = document.createElement('div')
			overlay.id = DIALOG_ID
			overlay.className = 'dshbg-overlay'
			const panel = document.createElement('div')
			panel.className = 'dshbg-panel'
			panel.setAttribute('role', 'dialog')
			panel.setAttribute('aria-modal', 'true')

			const heading = document.createElement('div')
			heading.className = 'dshbg-panel-title'
			heading.textContent = title
			const text = document.createElement('div')
			text.className = 'dshbg-panel-body'
			text.textContent = body
			panel.append(heading, text)
			if (typeof detail === 'string' && detail !== '') {
				const extra = document.createElement('div')
				extra.className = 'dshbg-panel-detail'
				extra.textContent = detail
				panel.append(extra)
			}
			const actions = document.createElement('div')
			actions.className = 'dshbg-panel-actions'
			const confirm = document.createElement('button')
			confirm.type = 'button'
			confirm.className = 'dshbg-btn'
			confirm.textContent = confirmLabel
			actions.append(confirm)
			panel.append(actions)
			overlay.append(panel)

			const close = () => {
				overlay.remove()
				document.removeEventListener('keydown', onKey)
			}
			const onKey = (event) => {
				if (event.key === 'Escape') close()
			}
			confirm.addEventListener('click', close)
			overlay.addEventListener('click', (event) => {
				if (event.target === overlay) close()
			})
			document.addEventListener('keydown', onKey)

			const host = document.body ?? document.documentElement
			host.append(overlay)
			if (typeof confirm.focus === 'function') confirm.focus()
		}

		/* ------------------------------------------------------- percentage --- */

		/** Clamp typed input to a whole percentage, falling back on nonsense. */
		function clampPct(value, fallback) {
			const parsed = Number.parseInt(String(value ?? '').trim(), 10)
			if (!Number.isFinite(parsed)) return fallback
			return Math.min(MAX_PCT, Math.max(MIN_PCT, parsed))
		}

		/** Read one saved percentage, falling back to the injected default. */
		function readPct(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key)
				return raw === null ? fallback : clampPct(raw, fallback)
			} catch {
				return fallback
			}
		}

		/** Persist one percentage. */
		function writePct(key, value) {
			try {
				window.localStorage.setItem(key, String(value))
			} catch {
				/* a locked-down document keeps the value in memory only */
			}
		}

		/** Read one string from storage. */
		function readStored(key) {
			try {
				return window.localStorage.getItem(key) ?? ''
			} catch {
				return ''
			}
		}

		/** Persist one string. */
		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value)
			} catch {
				/* ignore */
			}
		}

		/** Current values: the injected script's, or the same keys read directly. */
		function readValues() {
			const api = surface()
			if (api !== undefined && typeof api.read === 'function') {
				try {
					const values = api.read()
					return {
						opacity: clampPct(values?.opacity, FALLBACK_OPACITY_PCT),
						blur: clampPct(values?.blur, FALLBACK_BLUR_PCT),
					}
				} catch {
					/* fall through to the direct read */
				}
			}
			return {
				opacity: readPct(OPACITY_KEY, FALLBACK_OPACITY_PCT),
				blur: readPct(BLUR_KEY, FALLBACK_BLUR_PCT),
			}
		}

		/**
		 * Repaint the wallpaper layer. Prefers the injected script's applier, so
		 * the two halves cannot drift; otherwise writes the same two inline
		 * declarations against `#dsh-chat-bg` itself.
		 */
		function applyValues() {
			const api = surface()
			if (api !== undefined) {
				try {
					return api.apply()
				} catch {
					/* fall through */
				}
			}
			const el = document.getElementById('dsh-chat-bg')
			if (el === null) return undefined
			const values = readValues()
			const px = (values.blur / 100) * 40
			el.style.opacity = String(values.opacity / 100)
			el.style.filter = px > 0 ? `blur(${px}px)` : 'none'
			el.style.transform = px > 0 ? 'scale(1.06)' : 'none'
			return values
		}

		/**
		 * One field's text state and its commit path.
		 *
		 * The field keeps what was typed, so it can be cleared mid-edit; a draft
		 * that parses to nothing writes nothing. Out-of-range digits snap the text
		 * to the clamped value, so typing `300` shows `100` rather than claiming a
		 * number the wallpaper is not using.
		 *
		 * @param key - storage key for this field.
		 * @param initial - saved percentage to start from.
		 */
		function useDraft(key, initial) {
			const [text, setText] = React.useState(String(initial))
			const commit = React.useCallback((raw) => {
				const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
				if (!Number.isFinite(parsed)) {
					setText(String(raw ?? ''))
					return
				}
				const next = Math.min(MAX_PCT, Math.max(MIN_PCT, parsed))
				setText(next === parsed ? String(raw) : String(next))
				writePct(key, next)
				applyValues()
			}, [key])
			const resync = React.useCallback(() => {
				const values = readValues()
				setText(String(key === OPACITY_KEY ? values.opacity : values.blur))
			}, [key])
			return [text, commit, resync]
		}

		/**
		 * One labelled percentage field.
		 * @param label - the visible field name.
		 * @param draft - current typed text.
		 * @param onInput - receives the raw input value.
		 * @param onBlur - normalises the field when focus leaves it.
		 */
		function Field(label, draft, onInput, onBlur) {
			return React.createElement(
				'div',
				{ className: 'dshbg-field' },
				React.createElement('span', { className: 'dshbg-label' }, label),
				React.createElement('input', {
					className: 'dshbg-input',
					type: 'number',
					inputMode: 'numeric',
					min: MIN_PCT,
					max: MAX_PCT,
					step: 1,
					value: draft,
					'aria-label': label,
					onChange: (event) => onInput(event.target.value),
					onBlur: () => onBlur(),
				}),
				React.createElement('span', { className: 'dshbg-unit' }, '%'),
			)
		}

		/* -------------------------------------------------------------- row --- */

		/** The Settings row: two live percentages plus the picture path. */
		function ChatBackgroundRow() {
			const initial = readValues()
			const [opacity, setOpacity, resyncOpacity] = useDraft(OPACITY_KEY, initial.opacity)
			const [blur, setBlur, resyncBlur] = useDraft(BLUR_KEY, initial.blur)
			const [path, setPath] = React.useState(readStored(IMAGE_KEY))
			const [note, setNote] = React.useState('')
			const [busy, setBusy] = React.useState(false)

			React.useEffect(() => {
				ensureRowStyle()
				let live = true
				void getPicture().then((status) => {
					if (!live || status === undefined) return
					if (status.valid === true && typeof status.media === 'string') {
						setPath(status.media)
						writeStored(IMAGE_KEY, status.media)
						const from = status.source === 'setting' ? '设置里选的' : '配置文件里的'
						setNote(`当前：${typeof status.name === 'string' && status.name !== '' ? status.name : status.media}（${from}）`)
						return
					}
					setNote(typeof status.error === 'string' ? `当前背景不是本地文件：${status.error}` : '')
				})
				return () => {
					live = false
				}
			}, [])

			/**
			 * Hand the pasted path to the host, then report what happened.
			 *
			 * A same-kind picture is repainted from the media route on the spot; a
			 * kind change (image ↔ video) cannot reuse the layer built at boot, so
			 * that one asks for a restart.
			 */
			const applyPicture = React.useCallback(async () => {
				const wanted = String(path ?? '').trim()
				if (wanted === '') {
					showDialog({ title: '没有填路径', body: '把图片的完整路径粘贴到输入框里再点「应用」。' })
					return
				}
				setBusy(true)
				try {
					const result = await postPicture(wanted)
					if (result.ok !== true) {
						showDialog({
							title: '没能换上这张图',
							body: String(result.error ?? '宿主没有接受这个路径。'),
							detail: '路径可以这样拿：在文件上右键 → 复制文件地址（带引号也能识别）。',
						})
						return
					}
					writeStored(IMAGE_KEY, result.media)
					setPath(result.media)
					setNote(`当前：${result.name}`)

					const api = surface()
					const sameKind = api === undefined || result.type === api.type
					const repainted = sameKind && api?.routeAvailable === true && api.repaint?.() === true
					if (repainted) {
						showDialog({
							title: '已换上这张图',
							body: `背景已立即换成「${result.name}」。`,
							detail: `${result.media}\n已保存，下次启动 DSH 也用它。`,
						})
						return
					}
					showDialog({
						title: '已保存，需要重启',
						body: sameKind
							? `「${result.name}」已保存，重启 DSH 后生效。`
							: `「${result.name}」已保存。新素材的类型和当前背景不同（图片 ↔ 视频），要重启 DSH 才能生效。`,
						detail: result.media,
					})
				} finally {
					setBusy(false)
				}
			}, [path])

			return React.createElement(
				'div',
				{ className: 'dshbg-row' },
				React.createElement(
					'div',
					{ className: 'dshbg-line' },
					React.createElement(
						'div',
						{ className: 'dshbg-text' },
						React.createElement('div', { className: 'dshbg-title' }, '聊天背景'),
						React.createElement('div', { className: 'dshbg-desc' }, '不透明度与磨砂度改完立即生效；磨砂度 100% 约等于 40px 模糊。'),
						note === '' ? null : React.createElement('div', { className: 'dshbg-note' }, note),
					),
					React.createElement(
						'div',
						{ className: 'dshbg-ctrl' },
						Field('不透明度', opacity, setOpacity, resyncOpacity),
						Field('磨砂度', blur, setBlur, resyncBlur),
					),
				),
				React.createElement(
					'div',
					{ className: 'dshbg-pic' },
					React.createElement('input', {
						className: 'dshbg-input dshbg-path',
						type: 'text',
						spellCheck: false,
						value: path,
						placeholder: '图片或视频的完整路径（右键 → 复制文件地址），回车即应用',
						'aria-label': '背景图片路径',
						onChange: (event) => setPath(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') void applyPicture()
						},
					}),
					React.createElement(
						'button',
						{ className: 'dshbg-btn', type: 'button', disabled: busy, onClick: () => void applyPicture() },
						busy ? '应用中…' : '应用',
					),
				),
			)
		}

		/** Required services: the client UI slot registry. */
		const inject = ['slots']

		/**
		 * Register the row. `settings.general.item` is the 通用 section's list
		 * slot; `order` keeps it below the official appearance rows.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// Repaint once on activation: a late-mounting layer, or a document the
			// injected script could not reach yet, still gets the saved values. The
			// row styles go in now too, so the row never renders unstyled.
			applyValues()
			ensureRowStyle()
			ctx.slots.inject('settings.general.item', () =>
				ctx.slots.register({ name: 'settings.general.item', id: 'chat-background', order: 25 }, ChatBackgroundRow),
			)
		}

		exports.name = 'chat-background'
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})
