/** A separate, authenticated LAN listener; never exposes Companion's admin UI. */
import { createServer } from 'node:http'
import crypto from 'node:crypto'
import { DeskApiResources } from './desk-api-resources.js'
import { apiDocsHtml, openApiDocument } from './desk-api-docs.js'

export const MAX_BODY_BYTES = 64 * 1024

function apiError(statusCode, message) {
	return Object.assign(new Error(message), { statusCode })
}

function digest(value) {
	return crypto.createHash('sha256').update(value).digest()
}

/** Both comparisons always use fixed-size hashes, including absent/wrong-length keys. */
export function authorized(headers, keyHash) {
	const authorization = typeof headers.authorization === 'string' ? headers.authorization : ''
	const bearer = /^Bearer[ \t]+(.+)$/i.exec(authorization)?.[1] ?? ''
	const apiKey = typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : ''
	const bearerMatches = crypto.timingSafeEqual(digest(bearer), keyHash)
	const headerMatches = crypto.timingSafeEqual(digest(apiKey), keyHash)
	return (bearer.length > 0 && bearerMatches) || (apiKey.length > 0 && headerMatches)
}

function json(res, status, body) {
	if (res.destroyed || res.writableEnded) return
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
	})
	res.end(JSON.stringify(body))
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		const finish = (error, body) => {
			req.off('data', data)
			req.off('end', end)
			req.off('aborted', aborted)
			if (error) {
				req.resume()
				reject(error)
			} else resolve(body)
		}
		const data = (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) finish(apiError(413, 'request body exceeds 64 KB'))
			else chunks.push(chunk)
		}
		const aborted = () => finish(apiError(400, 'request aborted'))
		const end = () => {
			if (size === 0) return finish(null, {})
			if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
				return finish(apiError(400, 'Content-Type must be application/json'))
			let body
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			} catch {
				return finish(apiError(400, 'invalid JSON body'))
			}
			if (!body || typeof body !== 'object' || Array.isArray(body))
				return finish(apiError(400, 'body must be a JSON object'))
			finish(null, body)
		}
		req.on('data', data)
		req.once('end', end)
		req.once('aborted', aborted)
		req.once('error', aborted)
		if (Number(req.headers['content-length']) > MAX_BODY_BYTES) finish(apiError(413, 'request body exceeds 64 KB'))
	})
}

export class DeskApiServer {
	constructor(device, routing, { log = () => {}, onError = () => {} } = {}) {
		this.device = device
		this.resources = new DeskApiResources(device, routing)
		this.log = log
		this.onError = onError
		this.server = null
		this.error = null
		this.settings = null
		this.listener = null
		this.lifecycle = Promise.resolve()
		this.requests = new Set()
	}

	get address() {
		return this.server?.address() ?? null
	}

	/** Configuration and shutdown cannot race each other or leave an old listener behind. */
	configure(config = {}, secrets = {}) {
		const enabled = Boolean(config.apiEnabled)
		const bind = config.apiBind ?? '0.0.0.0'
		const port = config.apiPort ?? 8765
		const key = typeof secrets?.apiKey === 'string' ? secrets.apiKey : ''
		const keyHash = digest(key)
		const settings = JSON.stringify([enabled, bind, port, keyHash.toString('hex')])
		return this.enqueue(async () => {
			if (settings === this.settings && this.server?.listening && this.listener?.active && !this.error) return
			await this.close()
			this.settings = settings
			this.reportError(null)
			if (!enabled) return
			if (!key.trim()) return this.reportError('HTTP API requires an API key; listener not started', 'warn')
			if (typeof bind !== 'string' || !bind.trim()) return this.reportError('HTTP API bind address is required')
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				return this.reportError('HTTP API port must be an integer from 1 to 65535')
			const listener = { active: true }
			const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
				const request = this.handle(req, res, keyHash, listener)
				this.requests.add(request)
				void request.finally(() => this.requests.delete(request))
			})
			this.server = server
			this.listener = listener
			server.on('clientError', (error, socket) => {
				if (!socket.writable) return
				const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400
				const body = JSON.stringify({ error: status === 431 ? 'headers too large' : 'invalid HTTP request' })
				socket.end(
					`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
				)
			})
			await new Promise((resolve) => {
				server.on('error', (error) => {
					listener.active = false
					// Do not log arbitrary messages or configuration: either can contain credentials.
					const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'listen error'
					this.reportError(`HTTP API could not listen (${code})`)
					resolve()
				})
				try {
					server.listen(port, bind, resolve)
				} catch {
					listener.active = false
					this.reportError('HTTP API could not listen (invalid address or port)')
					resolve()
				}
			})
		})
	}

	reportError(message, level = 'error') {
		this.error = message
		if (message) this.log(level, message)
		this.onError(message)
	}

	enqueue(operation) {
		const result = this.lifecycle.then(operation)
		this.lifecycle = result.catch(() => {})
		return result
	}

	stop() {
		return this.enqueue(async () => {
			await this.close()
			this.settings = null
			this.reportError(null)
		})
	}

	async close() {
		if (this.listener) this.listener.active = false
		const server = this.server
		this.server = null
		this.listener = null
		if (server) {
			await new Promise((resolve) => {
				server.close(resolve)
				// Includes incomplete bodies; stopping must not wait for an idle client.
				server.closeAllConnections()
			})
		}
		await Promise.allSettled([...this.requests])
	}

	async handle(req, res, keyHash, listener) {
		try {
			const path = (req.url ?? '').split('?')[0]
			const publicRead = req.method === 'GET' && ['/api/v1/health', '/api/v1/docs'].includes(path)
			if (!publicRead && !authorized(req.headers, keyHash)) {
				req.resume()
				return json(res, 401, { error: 'unauthorized' })
			}
			const body = await readBody(req)
			if (!listener.active) return json(res, 503, { error: 'API listener stopped' })
			if (req.method === 'GET' && path === '/api/v1/health')
				return json(res, 200, { ok: true, connected: Boolean(this.device.ready) })
			if (req.method === 'GET' && path === '/api/v1/docs') {
				res.writeHead(200, {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'no-store',
					'X-Content-Type-Options': 'nosniff',
				})
				return res.end(apiDocsHtml)
			}
			if (req.method === 'GET' && path === '/api/v1/openapi.json') return json(res, 200, openApiDocument)
			if (!path.startsWith('/api/v1/')) return json(res, 404, { error: 'not found' })
			const result = await this.resources.handle(req.method, path.slice('/api/v1'.length), body)
			// ?return=state answers a successful call with the whole desk state, so a
			// client (e.g. one Companion variable) can refresh every button at once.
			const wantsState = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('return') === 'state'
			if (wantsState && result.status < 300) return json(res, result.status, this.resources.state())
			json(res, result.status, result.body)
		} catch (error) {
			const status = Number.isInteger(error.statusCode) ? error.statusCode : 500
			if (status >= 500 && status !== 503) this.log('error', 'HTTP API request failed')
			json(res, status, { error: status === 500 ? 'internal server error' : error.message })
		}
	}
}
