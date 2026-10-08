import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { RoutingController } from '../src/routing-presets.js'
import { RoutingDevice } from './helpers/routing-device.js'

// Import the actual HTTP handler without allowing USB discovery or a connection.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in routing HTTP tests') }
		export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
	`,
	'@companion-module/base': `
		export class InstanceBase {}
		export const InstanceStatus = { Ok: 'ok', Connecting: 'connecting', Disconnected: 'disconnected' }
		export const combineRgb = (r, g, b) => (r << 16) | (g << 8) | b
	`,
}
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.hasOwn(stubs, specifier))
			return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
		return nextResolve(specifier, context)
	},
})
const { RodecasterInstance } = await import('../src/main.js')
hooks.deregister()

function instance() {
	const self = new RodecasterInstance({})
	self.device = new RoutingDevice()
	self.config = { stripNames: 'Keep existing settings', unlinkedSends: '[]' }
	self.saved = []
	self.rebuilt = 0
	self.saveConfig = (config) => self.saved.push(structuredClone(config))
	self.rebuildDefinitions = () => self.rebuilt++
	self.routing = new RoutingController(self.device, {
		onPresetsChanged: (presets) => self.persistRoutingPresets(presets),
	})
	self.request = async (method, path, body) => {
		const result = await self.handleHttpRequest({ method, path, body })
		return { ...result, json: result.headers['Content-Type'] === 'application/json' ? JSON.parse(result.body) : null }
	}
	return self
}

test('routing page serves both entry points independently of readiness and connection label', async () => {
	const self = instance()
	self.device.ready = false
	for (const path of ['/', '/index.html']) {
		const response = await self.request('GET', path)
		assert.equal(response.status, 200)
		assert.match(response.headers['Content-Type'], /^text\/html/)
		assert.equal(response.headers['Cache-Control'], 'no-store')
		assert.match(response.body, /<html/)
		assert.match(response.body, /<script>/)
		assert.doesNotMatch(response.body, /<script[^>]+src=|<link[^>]+href=["']https?:/)
	}
	assert.deepEqual((await self.request('GET', '/routing')).json, { ready: false })
	assert.equal((await self.request('GET', '/missing')).status, 404)
	assert.equal((await self.request('POST', '/')).status, 404)
})

test('routing state includes every discovered output and source plus fader assignments', async () => {
	const self = instance()
	const response = await self.request('GET', '/routing')
	assert.equal(response.status, 200)
	assert.equal(response.json.ready, true)
	assert.equal(response.json.outputs.length, 13)
	for (const output of response.json.outputs) assert.equal(output.cells.length, self.device.layout.sourceCount)
	assert.equal(response.json.outputs[10].mode, null)
	assert.ok(Array.isArray(response.json.strips))
})

test('HTTP accepts JSON and pre-parsed bodies without coercing routing inputs', async () => {
	const self = instance()
	assert.equal((await self.request('POST', '/routing/mode', JSON.stringify({ output: 0, mode: 2 }))).status, 200)
	assert.equal(
		(await self.request('POST', '/routing/cell', { source: 0, output: 0, state: 'unlink', level: 0.43 })).status,
		200,
	)
	const cell = (await self.request('GET', '/routing')).json.outputs[0].cells[0]
	assert.equal(cell.level, 0.43)
	assert.equal(cell.link, false)
	for (const body of [
		{ output: '0', mode: 2 },
		{ output: 0, mode: '2' },
		{ output: 0.5, mode: 2 },
		{ output: -1, mode: 2 },
		{ output: 13, mode: 2 },
		{ output: 0, mode: 3 },
		{ output: null, mode: 2 },
		{ output: 10, mode: 2 },
		{ output: 0, mode: 2, unexpected: true },
	])
		assert.equal((await self.request('POST', '/routing/mode', body)).status, 400)
	for (const body of [
		{ source: 0, output: 0 },
		{ source: '0', output: 0, state: 'off' },
		{ source: -1, output: 0, state: 'off' },
		{ source: 19, output: 0, state: 'off' },
		{ source: 0.1, output: 0, state: 'off' },
		{ source: 0, output: 13, state: 'off' },
		{ source: 0, output: 0, state: 'linked' },
		{ source: 0, output: 0, state: null },
		{ source: 0, output: 0, level: -0.01 },
		{ source: 0, output: 0, level: 1.01 },
		{ source: 0, output: 0, level: '0.5' },
		{ source: 0, output: 0, level: null },
		{ source: 0, output: 0, level: NaN },
		{ source: 0, output: 0, level: Infinity },
		{ source: 0, output: 0, state: 'off', level: 2 },
	])
		assert.equal((await self.request('POST', '/routing/cell', body)).status, 400)
	assert.deepEqual((await self.request('GET', '/routing')).json.outputs[0].cells[0], cell)
	for (const body of ['{', 'null', '[]', 'true', '4']) {
		assert.equal((await self.request('POST', '/routing/cell', body)).status, 400)
		assert.equal((await self.request('POST', '/routing/presets', body)).status, 400)
	}
})

test('HTTP preset lifecycle persists the entire matrix and stable IDs', async () => {
	const self = instance()
	const saved = await self.request('POST', '/routing/presets', { name: '  Stream  ' })
	assert.equal(saved.status, 201)
	const { id } = saved.json.preset
	assert.deepEqual((await self.request('GET', '/routing/presets')).json, {
		presets: [{ id, name: 'Stream' }],
		active: 'Stream',
	})
	const persisted = JSON.parse(self.config.routingPresets)
	assert.equal(persisted[0].outputs.length, 13)
	assert.equal(persisted[0].outputs[12].cells.length, self.device.layout.sourceCount)
	assert.equal(self.config.stripNames, 'Keep existing settings')
	assert.equal(self.rebuilt, 1)
	assert.equal((await self.request('POST', '/routing/presets', { name: 'Stream' })).status, 409)
	assert.equal((await self.request('POST', `/routing/presets/${id}`, { name: 'Broadcast' })).status, 200)
	assert.deepEqual(self.routing.listPresets(), [{ id, name: 'Broadcast' }])
	await self.request('POST', '/routing/mode', { output: 0, mode: 2 })
	await self.request('POST', '/routing/cell', { output: 0, source: 0, level: 0.17 })
	assert.equal((await self.request('GET', '/routing/presets')).json.active, '')
	assert.equal((await self.request('POST', `/routing/presets/${id}/load`, {})).status, 200)
	assert.equal((await self.request('GET', '/routing/presets')).json.active, 'Broadcast')
	assert.equal((await self.request('DELETE', `/routing/presets/${id}`)).status, 200)
	assert.deepEqual(JSON.parse(self.config.routingPresets), [])
	assert.equal(self.rebuilt, 3)
	assert.equal((await self.request('POST', `/routing/presets/${id}/load`, {})).status, 404)
	assert.equal((await self.request('DELETE', `/routing/presets/${id}`)).status, 404)
	assert.equal((await self.request('DELETE', '/routing/presets')).status, 404)
	assert.equal((await self.request('GET', `/routing/presets/${id}/load`)).status, 404)
})

test('preset names and route bodies are validated and failed persistence is reported', async () => {
	const self = instance()
	for (const name of ['', '   ', null, 42, 'x'.repeat(81)])
		assert.equal((await self.request('POST', '/routing/presets', { name })).status, 400)
	assert.equal((await self.request('POST', '/routing/presets', { name: 'A', outputs: [] })).status, 400)
	assert.equal((await self.request('POST', '/routing/presets/%zz/load', {})).status, 400)
	self.saveConfig = () => {
		throw new Error('storage unavailable')
	}
	const failed = await self.request('POST', '/routing/presets', { name: 'Unsaved' })
	assert.equal(failed.status, 400)
	assert.match(failed.json.error, /storage unavailable/)
	assert.deepEqual(self.routing.listPresets(), [])
	assert.equal(self.config.routingPresets, undefined)
})

test('disconnected desk rejects routing mutations and preset operations', async () => {
	const self = instance()
	const { id } = await self.routing.savePreset('Saved')
	self.device.ready = false
	for (const [method, path, body] of [
		['POST', '/routing/mode', { output: 0, mode: 2 }],
		['POST', '/routing/cell', { source: 0, output: 0, state: 'off' }],
		['GET', '/routing/presets'],
		['POST', '/routing/presets', { name: 'Offline' }],
		['POST', `/routing/presets/${id}`, { name: 'Offline' }],
		['POST', `/routing/presets/${id}/load`, {}],
		['DELETE', `/routing/presets/${id}`],
	])
		assert.equal((await self.request(method, path, body)).status, 503)
	assert.equal(self.routing.listPresets()[0].name, 'Saved')
})

test('settings updates preserve presets saved since the settings form was opened', async () => {
	const self = instance()
	const { id } = await self.routing.savePreset('Keep me')
	self.applyOptions = () => {}
	self.persistBorrowed = () => {}
	self.device.borrowedList = () => []
	await self.configUpdated({ stripNames: 'Updated settings', routingPresets: '[]' })
	assert.equal(self.config.stripNames, 'Updated settings')
	assert.equal(JSON.parse(self.config.routingPresets)[0].id, id)
	assert.equal(JSON.parse(self.saved.at(-1).routingPresets)[0].id, id)
})

test('connection initialization reloads persisted routing presets without starting USB in tests', async (t) => {
	const first = instance()
	const preset = await first.routing.savePreset('Restarted')
	const restarted = new RodecasterInstance({})
	restarted.device.start = () => {}
	restarted.log = () => {}
	restarted.updateStatus = () => {}
	restarted.setVariableDefinitions = () => {}
	restarted.rebuildDefinitions = () => {}
	t.after(() => clearInterval(restarted.clockTimer))
	await restarted.init(structuredClone(first.config))
	assert.deepEqual(restarted.routing.listPresets(), [preset])
	assert.equal(restarted.routing.matchingPreset(), '')
})
