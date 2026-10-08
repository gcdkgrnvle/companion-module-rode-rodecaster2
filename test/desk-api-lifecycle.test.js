import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Exercise the real Companion lifecycle without opening USB devices or sockets.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in API lifecycle tests') }
		export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
	`,
	'@companion-module/base': `
		export class InstanceBase {}
		export const InstanceStatus = {
			Ok: 'ok', Connecting: 'connecting', Disconnected: 'disconnected', ConnectionFailure: 'connection_failure'
		}
		export const combineRgb = (r, g, b) => (r << 16) | (g << 8) | b
	`,
	'./desk-api.js': `
		export class DeskApiServer {
			constructor(device, routing, options) {
				this.device = device
				this.routing = routing
				this.options = options
				this.configurations = []
				this.stops = 0
				this.nextError = null
			}
			async configure(config, secrets) {
				this.configurations.push({ config: structuredClone(config), secrets: structuredClone(secrets) })
				await this.beforeConfigure?.()
				this.options.onError(this.nextError)
			}
			async stop() {
				this.stops++
				await this.beforeStop?.()
			}
		}
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

function instance(t) {
	const self = new RodecasterInstance({})
	self.statuses = []
	self.logs = []
	self.saved = []
	self.starts = 0
	self.stops = 0
	self.log = (level, message) => self.logs.push({ level, message })
	self.updateStatus = (status, message) => self.statuses.push({ status, message })
	self.saveConfig = (config) => self.saved.push(structuredClone(config))
	self.setVariableDefinitions = () => {}
	self.rebuildDefinitions = () => {}
	self.device.start = () => self.starts++
	self.device.stop = async () => self.stops++
	t.after(() => self.destroy())
	return self
}

test('API configuration is disabled by default and uses the Companion secret store', (t) => {
	const self = instance(t)
	const fields = Object.fromEntries(self.getConfigFields().map((field) => [field.id, field]))
	assert.equal(fields.apiEnabled.type, 'checkbox')
	assert.equal(fields.apiEnabled.default, false)
	assert.equal(fields.apiBind.type, 'textinput')
	assert.equal(fields.apiBind.default, '0.0.0.0')
	assert.equal(fields.apiPort.type, 'number')
	assert.equal(fields.apiPort.default, 8765)
	assert.equal(fields.apiPort.min, 1)
	assert.equal(fields.apiPort.max, 65535)
	assert.equal(fields.apiKey.type, 'secret-text')
	assert.equal(fields.apiKey.default, '')
	assert.strictEqual(self.api.device, self.device)
	assert.strictEqual(self.api.routing, self.routing)
})

test('initialization passes the secret separately and supports older calls without secrets', async (t) => {
	const self = instance(t)
	await self.init({ apiEnabled: true, apiBind: '127.0.0.1', apiPort: 8765 }, true, { apiKey: 'synthetic-key' })
	assert.equal(self.starts, 1)
	assert.deepEqual(self.api.configurations, [
		{
			config: { apiEnabled: true, apiBind: '127.0.0.1', apiPort: 8765 },
			secrets: { apiKey: 'synthetic-key' },
		},
	])
	assert.equal(Object.hasOwn(self.config, 'apiKey'), false)
	assert.ok(self.clockTimer)
	const old = instance(t)
	await old.init({})
	assert.deepEqual(old.api.configurations, [{ config: {}, secrets: {} }])
	assert.equal(old.starts, 1)
})

test('API setting and secret updates reconfigure the server without restarting USB', async (t) => {
	const self = instance(t)
	await self.init({ serial: 'synthetic-desk', apiEnabled: false })
	await self.configUpdated(
		{ serial: 'synthetic-desk', apiEnabled: true, apiBind: '127.0.0.1', apiPort: 8766 },
		{ apiKey: 'synthetic-first-key' },
	)
	await self.configUpdated({ ...self.config, apiPort: 8767 }, { apiKey: 'synthetic-second-key' })
	await self.configUpdated({ ...self.config, apiBind: '0.0.0.0' })
	await self.configUpdated({ ...self.config, apiEnabled: false }, {})
	assert.equal(self.starts, 1)
	assert.equal(self.stops, 0)
	assert.equal(self.api.configurations.length, 5)
	assert.equal(self.api.configurations[1].config.apiPort, 8766)
	assert.equal(self.api.configurations[2].config.apiPort, 8767)
	assert.deepEqual(self.api.configurations[2].secrets, { apiKey: 'synthetic-second-key' })
	assert.deepEqual(self.api.configurations[3].secrets, { apiKey: 'synthetic-second-key' })
	assert.equal(self.api.configurations[3].config.apiBind, '0.0.0.0')
	assert.equal(self.api.configurations[4].config.apiEnabled, false)
	assert.deepEqual(self.api.configurations[4].secrets, {})
	for (const config of self.saved) assert.equal(Object.hasOwn(config, 'apiKey'), false)
	assert.deepEqual(self.logs, [])
})

test('API secrets cannot enter regular config or persisted routing and repair state', async (t) => {
	const self = instance(t)
	await self.init({ apiKey: 'synthetic-misplaced-key' }, false, { apiKey: 'synthetic-secret' })
	self.persistRoutingPresets([])
	await self.configUpdated(
		{ ...self.config, apiKey: 'synthetic-misplaced-key', routingPresets: 'invalid' },
		{
			apiKey: 'synthetic-next-secret',
		},
	)
	self.persistHeadphoneMutes([{ headphone: 1, sources: [0] }])
	assert.ok(self.saved.length >= 3)
	for (const config of self.saved) {
		assert.equal(Object.hasOwn(config, 'apiKey'), false)
		assert.doesNotMatch(JSON.stringify(config), /synthetic-.*(?:key|secret)/)
	}
	for (const { config } of self.api.configurations) assert.equal(Object.hasOwn(config, 'apiKey'), false)
	assert.deepEqual(self.logs, [])
})

test('serial changes still restart USB while preserving API lifecycle updates', async (t) => {
	const self = instance(t)
	await self.init({ serial: 'synthetic-first-desk' })
	await self.configUpdated({ serial: 'synthetic-second-desk' })
	assert.equal(self.starts, 2)
	assert.equal(self.stops, 1)
	assert.equal(self.api.configurations.length, 2)
	assert.equal(self.device.options.serial, 'synthetic-second-desk')
})

test('API errors remain visible through desk status changes and recover to its latest status', async (t) => {
	const self = instance(t)
	self.api.nextError = 'HTTP API: EADDRINUSE'
	await self.init({ apiEnabled: true }, false, { apiKey: 'synthetic-key' })
	assert.deepEqual(self.statuses.at(-1), { status: 'connection_failure', message: 'HTTP API: EADDRINUSE' })
	self.device.emit('status', 'ready')
	assert.deepEqual(self.statuses.at(-1), { status: 'connection_failure', message: 'HTTP API: EADDRINUSE' })
	self.device.emit('status', 'disconnected', 'USB unplugged')
	assert.deepEqual(self.statuses.at(-1), { status: 'connection_failure', message: 'HTTP API: EADDRINUSE' })
	self.api.nextError = null
	await self.configUpdated({ apiEnabled: false })
	assert.deepEqual(self.statuses.at(-1), { status: 'disconnected', message: 'USB unplugged' })
	self.device.emit('status', 'connecting')
	assert.deepEqual(self.statuses.at(-1), { status: 'connecting', message: undefined })
	self.device.emit('status', 'ready')
	assert.deepEqual(self.statuses.at(-1), { status: 'ok', message: undefined })
	self.api.options.onError('HTTP API requires a key')
	assert.equal(self.statuses.at(-1).status, 'connection_failure')
	self.api.options.onError(null)
	assert.equal(self.statuses.at(-1).status, 'ok')
	self.api.options.log('warn', 'HTTP API listen failed')
	assert.deepEqual(self.logs, [{ level: 'warn', message: 'HTTP API listen failed' }])
})

test('initialization and settings await API configuration, and destroy stops API before USB', async (t) => {
	const self = instance(t)
	let release
	self.api.beforeConfigure = () => new Promise((resolve) => (release = resolve))
	const initializing = self.init({})
	assert.equal(self.clockTimer, null)
	release()
	await initializing
	let updated = false
	const updating = self.configUpdated({}).then(() => (updated = true))
	await Promise.resolve()
	assert.equal(updated, false)
	release()
	await updating
	self.api.beforeStop = () => new Promise((resolve) => (release = resolve))
	const destroying = self.destroy()
	assert.equal(self.api.stops, 1)
	assert.equal(self.clockTimer, null)
	assert.equal(self.stops, 0)
	release()
	await destroying
	assert.equal(self.stops, 1)
	self.api.beforeStop = undefined
})
