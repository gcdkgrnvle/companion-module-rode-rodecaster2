import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { DeskApiServer, MAX_BODY_BYTES, authorized } from '../src/desk-api.js'
import { RoutingController } from '../src/routing-presets.js'
import { RoutingDevice } from './helpers/routing-device.js'

const testKey = 'test-only-desk-api-credential'

async function freePort() {
	const server = createServer()
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const port = server.address().port
	await new Promise((resolve) => server.close(resolve))
	return port
}

async function setup(t, enabled = true) {
	const device = new RoutingDevice()
	const logs = []
	const errors = []
	const server = new DeskApiServer(device, new RoutingController(device), {
		log: (level, message) => logs.push({ level, message }),
		onError: (message) => errors.push(message),
	})
	t.after(() => server.stop())
	const config = { apiEnabled: enabled, apiBind: '127.0.0.1', apiPort: await freePort() }
	if (enabled) await server.configure(config, { apiKey: testKey })
	return { device, server, config, logs, errors }
}

function call(port, path, { method = 'GET', headers = {}, body, raw, chunks, auth = true } = {}) {
	return new Promise((resolve, reject) => {
		const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body))
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				method,
				agent: false,
				headers: {
					...(auth ? { Authorization: `Bearer ${testKey}` } : {}),
					...(payload !== undefined
						? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
						: {}),
					...headers,
				},
			},
			(res) => {
				const buffers = []
				res.on('data', (chunk) => buffers.push(chunk))
				res.on('error', reject)
				res.on('end', () => {
					const text = Buffer.concat(buffers).toString()
					resolve({
						status: res.statusCode,
						headers: res.headers,
						text,
						body: res.headers['content-type'] === 'application/json' ? JSON.parse(text) : null,
					})
				})
			},
		)
		req.on('error', reject)
		if (chunks) for (const chunk of chunks) req.write(chunk)
		req.end(payload)
	})
}

test('authentication hashes both credentials before fixed-length timing-safe comparisons', (t) => {
	const compare = crypto.timingSafeEqual
	const lengths = []
	t.mock.method(crypto, 'timingSafeEqual', (a, b) => {
		lengths.push([a.length, b.length])
		return compare(a, b)
	})
	const expected = crypto.createHash('sha256').update(testKey).digest()
	for (const value of ['', 'x', testKey, 'x'.repeat(1000), '☃'.repeat(1000)]) {
		assert.equal(authorized({ authorization: `Bearer ${value}` }, expected), value === testKey)
		assert.equal(authorized({ 'x-api-key': value }, expected), value === testKey)
	}
	assert.equal(authorized({}, expected), false)
	assert.equal(lengths.length, 22)
	assert.ok(lengths.every(([a, b]) => a === 32 && b === 32))
})

test('HTTP requires either supported key header and never authenticates a query parameter', async (t) => {
	const { config, device } = await setup(t)
	for (const headers of [
		{},
		{ Authorization: 'Bearer wrong' },
		{ 'X-API-Key': 'wrong' },
		{ Authorization: 'Basic x' },
	]) {
		const result = await call(config.apiPort, '/api/v1/routing', { auth: false, headers })
		assert.equal(result.status, 401)
		assert.deepEqual(result.body, { error: 'unauthorized' })
		assert.equal(result.headers['www-authenticate'], 'Bearer')
	}
	for (const headers of [
		{ Authorization: `Bearer ${testKey}` },
		{ authorization: `bearer ${testKey}` },
		{ 'X-API-Key': testKey },
		{ 'x-api-key': testKey, Authorization: 'Bearer wrong' },
	]) {
		const result = await call(config.apiPort, '/api/v1/routing', { auth: false, headers })
		assert.equal(result.status, 200)
		assert.equal(result.headers['content-type'], 'application/json')
		assert.equal(result.headers['access-control-allow-origin'], undefined)
	}
	for (const name of ['key', 'apiKey', 'api_key', 'access_token'])
		assert.equal((await call(config.apiPort, `/api/v1/routing?${name}=${testKey}`, { auth: false })).status, 401)
	assert.equal(device.writes.length, 0)
})

test('health and self-contained docs are public; OpenAPI requires authentication even when disconnected', async (t) => {
	const { config, device } = await setup(t)
	assert.deepEqual((await call(config.apiPort, '/api/v1/health', { auth: false })).body, { ok: true, connected: true })
	device.ready = false
	assert.deepEqual((await call(config.apiPort, '/api/v1/health', { auth: false })).body, { ok: true, connected: false })
	const docs = await call(config.apiPort, '/api/v1/docs', { auth: false })
	assert.equal(docs.status, 200)
	assert.match(docs.headers['content-type'], /^text\/html/)
	assert.match(docs.text, /\$RODE_API_KEY/)
	assert.doesNotMatch(docs.text, /<(?:script|link)[^>]+(?:src|href)=["']https?:/)
	assert.equal((await call(config.apiPort, '/api/v1/openapi.json', { auth: false })).status, 401)
	const spec = await call(config.apiPort, '/api/v1/openapi.json')
	assert.equal(spec.status, 200)
	assert.equal(spec.body.openapi, '3.1.0')
	assert.equal((await call(config.apiPort, '/api/v1/docs', { method: 'POST', auth: false })).status, 401)
	assert.equal((await call(config.apiPort, '/api/v1/health', { method: 'POST' })).status, 404)
})

test('only /api/v1 resources are served, unknown routes are JSON 404 even disconnected', async (t) => {
	const { config, device } = await setup(t)
	for (const connected of [true, false]) {
		device.ready = connected
		for (const path of ['/', '/index.html', '/routing', '/api/v2/state', '/api/v1/missing', '/api/v1/../routing']) {
			const result = await call(config.apiPort, path)
			assert.equal(result.status, 404, path)
			assert.deepEqual(result.body, { error: 'not found' })
		}
	}
	const offline = await call(config.apiPort, '/api/v1/routing')
	assert.equal(offline.status, 503)
	assert.deepEqual(offline.body, { error: 'desk disconnected' })
})

test('HTTP writes return current model state and validate JSON bodies before any device writes', async (t) => {
	const { config, device } = await setup(t)
	const path = '/api/v1/routing/outputs/hp1/sources/mic1'
	const changed = await call(config.apiPort, path, { method: 'PATCH', body: { state: 'unlink', level: 0.42 } })
	assert.equal(changed.status, 200)
	assert.equal(changed.body.source, 0)
	assert.equal(changed.body.name, 'combo1')
	assert.equal(changed.body.state, 'unlink')
	assert.equal(changed.body.level, 0.42)
	assert.deepEqual((await call(config.apiPort, path)).body, changed.body)
	const count = device.writes.length
	for (const raw of ['{', 'null', '[]', 'true', '4']) {
		const result = await call(config.apiPort, path, { method: 'PATCH', raw })
		assert.equal(result.status, 400)
		assert.equal(typeof result.body.error, 'string')
	}
	assert.equal(
		(await call(config.apiPort, path, { method: 'PATCH', raw: '{}', headers: { 'Content-Type': 'text/plain' } }))
			.status,
		400,
	)
	assert.equal((await call(config.apiPort, path, { method: 'PATCH', body: { level: 3 } })).status, 400)
	assert.equal((await call(config.apiPort, '/api/v1/routing/presets/%zz/load', { method: 'POST' })).status, 400)
	assert.equal(device.writes.length, count)
})

test('64 KB limit includes content-length and chunked bodies, but permits exactly 64 KB', async (t) => {
	const { config, device } = await setup(t)
	const path = '/api/v1/routing/outputs/hp1/mode'
	const exact = '{"mode":"custom"}'.padEnd(MAX_BODY_BYTES, ' ')
	assert.equal((await call(config.apiPort, path, { method: 'PUT', raw: exact })).status, 200)
	for (const options of [
		{ raw: exact + ' ' },
		{ chunks: [exact.slice(0, 50000), exact.slice(50000), ' '], headers: { 'Content-Type': 'application/json' } },
	]) {
		const result = await call(config.apiPort, path, { method: 'PUT', ...options })
		assert.equal(result.status, 413)
		assert.match(result.body.error, /64 KB/)
	}
	assert.equal(device.writes.length, 0)
	assert.equal((await call(config.apiPort, '/api/v1/routing')).status, 200)
})

test('disabled listener and missing key never start, config errors are reported without secret values', async (t) => {
	const { server, config, logs } = await setup(t, false)
	await server.configure({ ...config, apiEnabled: false }, { apiKey: testKey })
	assert.equal(server.address, null)
	await server.configure({ ...config, apiEnabled: true }, {})
	assert.equal(server.address, null)
	assert.match(server.error, /requires an API key/)
	assert.equal(logs.at(-1).level, 'warn')
	for (const changes of [{ apiPort: 0 }, { apiPort: 65536 }, { apiPort: '8765' }, { apiBind: '' }]) {
		await server.configure({ ...config, apiEnabled: true, ...changes }, { apiKey: testKey })
		assert.equal(server.address, null)
		assert.equal(typeof server.error, 'string')
	}
	assert.ok(logs.every(({ message }) => !message.includes(testKey)))
})

test('configuration changes restart the listener, rotate its key, and disable it; identical config is stable', async (t) => {
	const { server, config } = await setup(t)
	const original = server.server
	await server.configure(config, { apiKey: testKey })
	assert.equal(server.server, original)
	const secondKey = 'another-test-only-credential'
	await server.configure(config, { apiKey: secondKey })
	assert.notEqual(server.server, original)
	assert.equal((await call(config.apiPort, '/api/v1/routing')).status, 401)
	assert.equal(
		(await call(config.apiPort, '/api/v1/routing', { auth: false, headers: { 'X-API-Key': secondKey } })).status,
		200,
	)
	const next = { ...config, apiPort: await freePort() }
	await server.configure(next, { apiKey: testKey })
	assert.equal(server.address.port, next.apiPort)
	await assert.rejects(call(config.apiPort, '/api/v1/health'), { code: 'ECONNREFUSED' })
	await server.configure({ ...next, apiBind: '0.0.0.0' }, { apiKey: testKey })
	assert.equal(server.address.address, '0.0.0.0')
	assert.equal((await call(next.apiPort, '/api/v1/health')).status, 200)
	await server.configure({ ...next, apiEnabled: false }, { apiKey: testKey })
	assert.equal(server.address, null)
	assert.equal(server.error, null)
	await assert.rejects(call(next.apiPort, '/api/v1/health'), { code: 'ECONNREFUSED' })
})

test('listen failure is logged and reported, does not throw, and can recover on the same config', async (t) => {
	const { server, config, logs, errors } = await setup(t, false)
	const occupied = createServer()
	t.after(() => new Promise((resolve) => occupied.close(resolve)))
	await new Promise((resolve) => occupied.listen(config.apiPort, '127.0.0.1', resolve))
	const enabled = { ...config, apiEnabled: true }
	await server.configure(enabled, { apiKey: testKey })
	assert.equal(server.address, null)
	assert.match(server.error, /EADDRINUSE/)
	assert.match(logs.at(-1).message, /EADDRINUSE/)
	assert.equal(errors.at(-1), server.error)
	await new Promise((resolve) => occupied.close(resolve))
	await server.configure(enabled, { apiKey: testKey })
	assert.equal(server.error, null)
	assert.equal(server.address.port, config.apiPort)
	assert.equal((await call(config.apiPort, '/api/v1/health')).status, 200)
})

test('concurrent configuration and stop requests complete in order without leaking listeners', async (t) => {
	const { server, config } = await setup(t, false)
	const enabled = { ...config, apiEnabled: true }
	await Promise.all([
		server.configure(enabled, { apiKey: testKey }),
		server.configure({ ...enabled, apiEnabled: false }, { apiKey: testKey }),
		server.configure(enabled, { apiKey: testKey }),
		server.stop(),
	])
	assert.equal(server.address, null)
	await assert.rejects(call(config.apiPort, '/api/v1/health'), { code: 'ECONNREFUSED' })
	await server.configure(enabled, { apiKey: testKey })
	assert.equal((await call(config.apiPort, '/api/v1/health')).status, 200)
})

test('an error after listening can recover when the unchanged configuration is applied again', async (t) => {
	const { server, config } = await setup(t)
	server.server.emit('error', Object.assign(new Error('synthetic accept failure'), { code: 'EMFILE' }))
	assert.match(server.error, /EMFILE/)
	assert.equal((await call(config.apiPort, '/api/v1/routing')).status, 503)
	await server.configure(config, { apiKey: testKey })
	assert.equal(server.error, null)
	assert.equal((await call(config.apiPort, '/api/v1/routing')).status, 200)
})

test('shutdown cancels an incomplete request body without waiting for the client or writing to the desk', async (t) => {
	const { server, config, device } = await setup(t)
	const socket = connect(config.apiPort, '127.0.0.1')
	t.after(() => socket.destroy())
	await new Promise((resolve, reject) => {
		socket.once('error', reject)
		socket.once('connect', resolve)
	})
	const received = new Promise((resolve) => server.server.once('request', resolve))
	socket.write(
		`PUT /api/v1/routing/outputs/0/mode HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${testKey}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`,
	)
	await received
	await server.stop()
	assert.equal(server.address, null)
	assert.equal(server.requests.size, 0)
	assert.equal(device.writes.length, 0)
})

test('unexpected request failures return JSON without exposing internal messages or keys', async (t) => {
	const { server, config, logs } = await setup(t)
	server.resources.handle = async () => {
		throw new Error(testKey)
	}
	const result = await call(config.apiPort, '/api/v1/routing')
	assert.equal(result.status, 500)
	assert.deepEqual(result.body, { error: 'internal server error' })
	assert.ok(logs.every(({ message }) => !message.includes(testKey)))
})

test('?return=state answers a successful call with the whole desk state and leaves errors alone', async (t) => {
	const { config, server } = await setup(t)
	server.resources.state = () => ({ routing: server.resources.routingState(), strips: { strips: [] }, sentinel: true })
	const plain = await call(config.apiPort, '/api/v1/routing')
	assert.equal(plain.status, 200)
	assert.equal(plain.body.sentinel, undefined)
	const full = await call(config.apiPort, '/api/v1/routing?return=state')
	assert.equal(full.status, 200)
	assert.equal(full.body.sentinel, true)
	assert.deepEqual(full.body.routing, plain.body)
	const bad = await call(config.apiPort, '/api/v1/routing/outputs/99?return=state')
	assert.ok(bad.status >= 400)
	assert.ok('error' in bad.body)
})
