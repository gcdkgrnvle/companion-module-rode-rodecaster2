import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { updateActions } from '../src/actions.js'
import { DeskApiResources } from '../src/desk-api-resources.js'
import { RoutingController } from '../src/routing-presets.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { MixOutput, Source } from '../src/protocol/names.js'
import { Reassembler } from '../src/protocol/usb.js'
import { decodeChangeFrame } from '../src/protocol/change-frame.js'
import { RoutingDevice } from './helpers/routing-device.js'
import { n, nc, np, repeat } from './protocol/helpers.js'

// The real device methods and protocol encode path run against an in-memory
// transport. An accidental attempt to discover or open USB hardware fails.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node-hid') {
			const stub = `
				const forbidden = () => { throw new Error('real HID access forbidden in API resource tests') }
				export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
			`
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
})
const { RodecasterDevice } = await import('../src/device.js')
hooks.deregister()

function setup(options = {}) {
	const fixture = new RoutingDevice()
	const tree = fixture.tree
	tree.children[0].children.push(...repeat(2, 'FADER'), ...repeat(8, 'PADBUTTON'))
	tree.children.splice(2, 0, n('CHANNEL'), n('CHANNEL'))
	tree.children.push(
		np('OUTPUT', {
			outputMonLevel: V.double(0.5),
			outputMonMute: V.bool(false),
			outputBTLevel: V.double(0.25),
			outputBTMute: V.bool(false),
		}),
		np('SYSTEM', { disableAllHeadphoneOutputs: V.bool(false) }),
		np('GUI', { selectedBank: V.int(0), screenBrightness: V.int(255), activeButtonsBrightness: V.int(8) }),
		np('DUCKER', { duckerDepth: V.double(-7) }),
		np('RECORDER', { recordState: V.int(0), requestRecordState: V.int(0), requestDropMarker: V.double(0) }),
		np('ENCODER', { encoderSignal: V.binary(Buffer.alloc(10)) }),
		...repeat(4, 'EFFECTS_PARAMETERS'),
		nc(
			'SOUNDPADS',
			Array.from({ length: 64 }, (_, idx) =>
				np('PAD', {
					padIdx: V.int(idx),
					padName: V.string(`Pad ${idx + 1}`),
					padActive: V.bool(false),
					padColourIndex: V.int(3),
					padType: V.int(1),
				}),
			),
		),
	)
	const layout = Layout.fromFullSync(tree)
	for (let i = 0; i < 3; i++) {
		const channel = tree.getByPath(layout.channelPath(i))
		channel.properties.set('channelInputSource', V.int(i))
		channel.properties.set('channelOutputMute', V.bool(false))
		channel.properties.set('channelCueEnable', V.bool(false))
	}
	for (const pad of tree.children[0].children.filter((entry) => entry.type === 'PADBUTTON'))
		pad.properties.set('padButtonPressed', V.bool(false))
	for (let i = 0; i < 4; i++) {
		for (const effect of ['reverbOn', 'echoOn', 'pitchShiftOn', 'distortionOn', 'robotOn', 'voiceDisguiseOn'])
			tree.getByPath(layout.effectsPath(i)).properties.set(effect, V.bool(false))
	}
	for (const node of tree.children.filter((entry) => entry.type === 'MIX')) {
		node.properties.set('mixLinkRequest', V.binary(Buffer.alloc(0)))
		node.properties.set('mixUnlinkRequest', V.binary(Buffer.alloc(0)))
	}
	const reassembler = new Reassembler()
	const transport = {
		isOpen: true,
		device: {},
		identity: { serialNumber: 'synthetic-api-device', productId: 1 },
		writes: [],
		beforeWrite: async () => {},
		afterWrite: async () => {},
		async write(report) {
			for (const frame of reassembler.push(report)) {
				const change = decodeChangeFrame(frame)
				await this.beforeWrite(change)
				this.writes.push(change)
				await this.afterWrite(change)
			}
		},
	}
	const device = new RodecasterDevice(options, { transport })
	device.session.tree = tree
	device.session.layout = layout
	device.ready = true
	const routing = new RoutingController(device)
	const api = new DeskApiResources(device, routing)
	const request = async (method, path, body) => (await api.handle(method, path, body)).body
	return { device, transport, api, routing, request }
}

async function rejects(api, method, path, body, statusCode = 400, message) {
	await assert.rejects(api.handle(method, path, body), (error) => {
		assert.equal(error.statusCode, statusCode)
		if (message) assert.match(error.message, message)
		return true
	})
}

test('routing API names and numeric indices resolve to canonical names and state', async () => {
	const { request } = setup()
	for (const [alias, output] of [
		['hp1', 0],
		['headphone4', 3],
		['monitor', 4],
		['rec', 5],
		['bt', 6],
		['usb1', 7],
		['chat', 8],
		['usb2', 9],
		['callme1', 10],
		['callme3', 12],
	]) {
		const state = await request('GET', `/routing/outputs/${alias}`)
		assert.equal(state.output, output)
		assert.equal(state.name, MixOutput.fromProtocol(output))
		assert.deepEqual(await request('GET', `/routing/outputs/${output}`), state)
	}
	for (const [alias, source] of [
		['mic1', 0],
		['combo4', 3],
		['usb1', 7],
		['chat', 8],
		['usb2', 9],
		['bluetooth', 10],
		['pads', 11],
		['game', 12],
		['music', 13],
		['virtuala', 14],
		['virtualb', 15],
		['callme1', 16],
		['callme3', 18],
	]) {
		const cell = await request('GET', `/routing/outputs/hp1/sources/${alias}`)
		assert.equal(cell.source, source)
		assert.equal(cell.name, Source.fromProtocol(source))
		assert.deepEqual(await request('GET', `/routing/outputs/0/sources/${source}`), cell)
		assert.equal(cell.onFader, source < 3)
	}
	assert.equal((await request('GET', '/routing')).outputs.length, 13)
	assert.equal((await request('GET', '/routing/outputs/callme1')).mode, null)
})

test('routing writes keep Custom rule, validate before changing mode and read updated cells', async () => {
	const { request, api, transport } = setup()
	assert.equal((await request('PUT', '/routing/outputs/hp1/mode', { mode: 'main' })).mode, 'main')
	await rejects(api, 'PATCH', '/routing/outputs/hp1/sources/mic1', { level: 0.1 }, 400, /select Custom/)
	const before = transport.writes.length
	for (const body of [
		{ level: 2, ensureCustom: true },
		{ state: 'mute', ensureCustom: true },
		{ level: 0.2, ensureCustom: 'yes' },
	])
		await rejects(api, 'PATCH', '/routing/outputs/hp1/sources/mic1', body)
	await rejects(api, 'PATCH', '/routing/outputs/hp1/sources/99', { level: 0.2, ensureCustom: true })
	assert.equal(transport.writes.length, before)
	const cell = await request('PATCH', '/routing/outputs/hp1/sources/mic1', {
		state: 'unlink',
		level: 0.2,
		ensureCustom: true,
	})
	assert.equal(cell.state, 'unlink')
	assert.equal(cell.level, 0.2)
	assert.equal(cell.anchor, 0.6)
	assert.equal((await request('GET', '/routing/outputs/hp1')).mode, 'custom')
	assert.equal((await request('PUT', '/routing/outputs/hp1/mode', { mode: 1 })).mode, 'mixminus')
	await rejects(api, 'PUT', '/routing/outputs/callme1/mode', { mode: 'custom' })
})

test('routing preset CRUD accepts id or name and returns current preset state', async () => {
	const { request, api } = setup()
	const saved = await api.handle('POST', '/routing/presets', { name: 'Desk mix' })
	assert.equal(saved.status, 201)
	assert.equal(saved.body.active, 'Desk mix')
	const id = saved.body.presets[0].id
	assert.deepEqual(await request('GET', '/routing/presets'), saved.body)
	await request('PATCH', '/routing/outputs/hp1/sources/mic1', { state: 'off' })
	assert.equal((await request('GET', '/routing/presets')).active, '')
	const loaded = await request('POST', '/routing/presets/Desk%20mix/load')
	assert.equal(loaded.active, 'Desk mix')
	assert.equal(loaded.outputs[0].sources[0].state, 'link')
	const renamed = await request('PATCH', `/routing/presets/${id}`, { name: 'Restored mix' })
	assert.equal(renamed.active, 'Restored mix')
	await rejects(api, 'POST', '/routing/presets', { name: 'Restored mix' }, 409)
	assert.deepEqual(await request('DELETE', '/routing/presets/Restored%20mix'), { active: '', presets: [] })
	await rejects(api, 'POST', `/routing/presets/${id}/load`, {}, 404)
})

test('strip writes return mute/listen toggles, level borrow state, and restore faders', async () => {
	const { api, request, device, transport } = setup()
	const strip = await request('GET', '/strips/1')
	assert.deepEqual(strip, {
		strip: 1,
		name: 'Mic 1',
		source: { index: 0, name: 'combo1' },
		muted: false,
		listen: false,
		level: 0.6,
		levelPct: 60,
		fader: 76,
		control: 'locked',
	})
	assert.equal((await request('GET', '/strips')).strips.length, 3)
	assert.equal((await request('PUT', '/strips/1/mute', { value: 'toggle' })).muted, true)
	assert.equal((await request('PUT', '/strips/1/mute', { value: 'off' })).muted, false)
	assert.equal((await request('PUT', '/strips/1/listen', { value: 'on' })).listen, true)
	const before = transport.writes.length
	await rejects(api, 'PUT', '/strips/1/level', { level: 0.4 }, 409, /level control disabled/)
	assert.equal(transport.writes.length, before)
	device.setOptions({ levelControl: true })
	const borrowed = await request('PUT', '/strips/1/level', { level: 0.4 })
	assert.equal(borrowed.control, 'dial')
	assert.equal(borrowed.level, 0.4)
	assert.equal(device.borrowed.size, 1)
	assert.equal((await request('PUT', '/strips/1/level', { delta: 0.1 })).level, 0.5)
	assert.equal((await request('POST', '/strips/restore')).strips[0].control, 'fader')
	assert.equal(device.borrowed.size, 0)
})

test('monitor and Bluetooth setters and clamped deltas read back updated model values', async () => {
	const { request, transport } = setup()
	assert.deepEqual(await request('GET', '/monitor'), { level: 0.5, levelPct: 50, muted: false })
	assert.equal((await request('PUT', '/monitor/level', { level: 0.123 })).level, 0.12)
	assert.equal((await request('PUT', '/monitor/level', { delta: 1 })).level, 1)
	assert.equal((await request('PUT', '/monitor/mute', { value: true })).muted, true)
	assert.deepEqual(await request('GET', '/bluetooth'), { level: 0.25, levelPct: 25, muted: false })
	assert.equal((await request('PUT', '/bluetooth/level', { level: 0.75 })).level, 0.75)
	assert.equal((await request('PUT', '/bluetooth/level', { delta: -1 })).level, 0)
	assert.equal((await request('PUT', '/bluetooth/mute', { value: 'toggle' })).muted, true)
	assert.equal(transport.writes.at(-1).name, 'outputBTMute')
})

test('monitor encoder mode also updates response model without an echo', async () => {
	const { request, transport } = setup({ monitorMethod: 'encoder' })
	assert.equal((await request('PUT', '/monitor/level', { delta: 0.02 })).level, 0.52)
	assert.equal(transport.writes.length, 2)
	assert.ok(transport.writes.every((change) => change.name === 'encoderSignal'))
})

test('headphone mix mutes and all-off writes use existing recovery-aware device methods', async () => {
	const { request, device } = setup()
	assert.deepEqual(await request('GET', '/headphones'), {
		allOff: false,
		mixes: [1, 2, 3, 4].map((headphone) => ({ headphone, muted: false })),
	})
	assert.equal((await request('PUT', '/headphones/2/mute', { value: 'toggle' })).mixes[1].muted, true)
	assert.equal(device.headphoneMutes.get(2).size, 19)
	assert.equal((await request('PUT', '/headphones/2/mute', { value: 'toggle' })).mixes[1].muted, false)
	assert.equal(device.headphoneMutes.size, 0)
	assert.equal((await request('PUT', '/headphones/off', { value: true })).allOff, true)
	assert.equal((await request('PUT', '/headphones/off', { value: 'toggle' })).allOff, false)
})

test('recorder requests update state and clock without an echo, marker preserves state', async () => {
	const { request, device, transport } = setup()
	let now = 1000
	device.clock.now = () => now
	assert.deepEqual(await request('GET', '/recorder'), { state: 'stopped', elapsedMs: 0 })
	assert.deepEqual(await request('POST', '/recorder/record'), { state: 'recording', elapsedMs: 0 })
	now += 1234
	assert.deepEqual(await request('POST', '/recorder/pause'), { state: 'paused', elapsedMs: 1234 })
	now += 1000
	assert.deepEqual(await request('POST', '/recorder/marker'), { state: 'paused', elapsedMs: 1234 })
	assert.equal(transport.writes.at(-1).name, 'requestDropMarker')
	assert.equal((await request('POST', '/recorder/record')).state, 'recording')
	now += 500
	assert.deepEqual(await request('GET', '/recorder'), { state: 'recording', elapsedMs: 1734 })
	assert.deepEqual(await request('POST', '/recorder/stop'), { state: 'stopped', elapsedMs: 0 })
})

test('pads expose the current bank, bank deltas wrap and press returns that bank state', async () => {
	const { request, transport } = setup()
	assert.equal((await request('GET', '/pads')).pads[0].name, 'Pad 1')
	assert.equal((await request('PUT', '/pads/bank', { delta: -1 })).bank, 8)
	assert.equal((await request('PUT', '/pads/bank', { delta: 1 })).bank, 1)
	assert.equal((await request('PUT', '/pads/bank', { bank: 3 })).pads[0].name, 'Pad 17')
	const pressed = await request('POST', '/pads/8/press', { bank: 2 })
	assert.equal(pressed.bank, 2)
	assert.equal(pressed.pads[7].slot, 8)
	assert.equal(pressed.pads[7].name, 'Pad 16')
	assert.deepEqual(
		transport.writes.slice(-3).map((change) => [change.name, change.value.value]),
		[
			['selectedBank', 1],
			['padButtonPressed', true],
			['padButtonPressed', false],
		],
	)
	await request('POST', '/pads/1/press')
	assert.equal((await request('GET', '/pads')).bank, 2)
})

test('all voice effects, On suffixes and megaphone alias update the same slot model', async () => {
	const { request } = setup()
	assert.equal((await request('GET', '/fx')).slots.length, 4)
	for (const effect of ['reverb', 'echo', 'pitchShift', 'distortion', 'robot', 'voiceDisguise']) {
		assert.equal((await request('PUT', `/fx/1/${effect}`, { value: true }))[effect], true)
		assert.equal((await request('PUT', `/fx/1/${effect}On`, { value: 'toggle' }))[effect], false)
	}
	assert.equal((await request('PUT', '/fx/4/megaphone', { value: 'on' })).distortion, true)
})

test('panic preserves original mute state and returns the recovery state', async () => {
	const { request } = setup()
	await request('PUT', '/strips/2/mute', { value: true })
	assert.deepEqual(await request('GET', '/panic'), { active: false })
	assert.deepEqual(await request('PUT', '/panic', { value: 'toggle' }), { active: true })
	assert.equal((await request('GET', '/monitor')).muted, true)
	assert.deepEqual(await request('PUT', '/panic', { value: false }), { active: false })
	assert.equal((await request('GET', '/strips/1')).muted, false)
	assert.equal((await request('GET', '/strips/2')).muted, true)
	assert.equal((await request('GET', '/monitor')).muted, false)
})

test('display and ducker writes return model values with percent conversion', async () => {
	const { request } = setup()
	assert.deepEqual(await request('PUT', '/display/screen-brightness', { pct: 50 }), {
		screenBrightness: 128,
		buttonBrightness: 8,
	})
	assert.deepEqual(await request('PUT', '/display/button-brightness', { value: 0 }), {
		screenBrightness: 128,
		buttonBrightness: 0,
	})
	assert.deepEqual(await request('PUT', '/ducker/depth', { value: -23.5 }), { depth: -23.5 })
})

test('state includes every resource in the same shape as its individual read', async () => {
	const { request } = setup()
	const state = await request('GET', '/state')
	for (const path of ['routing', 'strips', 'monitor', 'headphones', 'bluetooth', 'recorder', 'pads', 'fx', 'panic'])
		assert.deepEqual(state[path], await request('GET', `/${path}`))
	assert.deepEqual(state.presets, await request('GET', '/routing/presets'))
	assert.deepEqual(state.display, { screenBrightness: 255, buttonBrightness: 8 })
	assert.deepEqual(state.ducker, { depth: -7 })
})

test('invalid indices and bodies fail before any device write', async () => {
	const { api, transport } = setup({ levelControl: true })
	const cases = [
		['GET', '/routing/outputs/13'],
		['GET', '/routing/outputs/nope'],
		['GET', '/routing/outputs/0/sources/19'],
		['GET', '/routing/outputs/constructor'],
		['GET', '/routing/outputs/__proto__'],
		['GET', '/routing/outputs/toString'],
		['GET', '/routing/outputs/hp1/sources/constructor'],
		['POST', '/routing/presets/%zz/load'],
		['GET', '/strips/0'],
		['GET', '/strips/4'],
		['GET', '/strips/1.5'],
		['PUT', '/routing/outputs/0/mode', { mode: '2' }],
		['PUT', '/strips/1/mute', { value: 1 }],
		['PUT', '/strips/1/listen', {}],
		['PUT', '/strips/1/mute', []],
		['PUT', '/strips/1/level', { level: '0.5' }],
		['PUT', '/strips/1/level', { level: 0.5, delta: 0.1 }],
		['PUT', '/strips/1/level', { level: NaN }],
		['PUT', '/monitor/level', { delta: Infinity }],
		['PUT', '/bluetooth/level', { level: -0.1 }],
		['PUT', '/monitor/mute', { value: null }],
		['PUT', '/headphones/5/mute', { value: true }],
		['PUT', '/headphones/off', { value: 'yes' }],
		['POST', '/pads/9/press'],
		['POST', '/pads/1/press', { bank: 0 }],
		['PUT', '/pads/bank', { delta: 0.5 }],
		['PUT', '/pads/bank', { bank: 1, delta: 1 }],
		['PUT', '/fx/0/reverb', { value: true }],
		['PUT', '/fx/5/reverb', { value: true }],
		['PUT', '/fx/1/unknown', { value: true }],
		['PUT', '/display/screen-brightness', { value: 256 }],
		['PUT', '/display/button-brightness', { value: 1.5 }],
		['PUT', '/display/screen-brightness', { pct: 101 }],
		['PUT', '/display/screen-brightness', { value: 1, pct: 1 }],
		['PUT', '/ducker/depth', { value: -61 }],
		['PUT', '/panic', { value: 'toggle', typo: true }],
		['POST', '/recorder/record', { typo: true }],
	]
	for (const [method, path, body] of cases) await rejects(api, method, path, body)
	assert.equal(transport.writes.length, 0)
})

test('offline resources are 503 while unknown paths and unsupported methods remain 404', async () => {
	const { api, device } = setup()
	device.ready = false
	for (const path of [
		'/state',
		'/routing',
		'/routing/presets',
		'/strips',
		'/monitor',
		'/headphones',
		'/bluetooth',
		'/recorder',
		'/pads',
		'/fx',
		'/panic',
	])
		await rejects(api, 'GET', path, undefined, 503, /^desk disconnected$/)
	await rejects(api, 'GET', '/unknown', undefined, 404)
	await rejects(api, 'POST', '/monitor', undefined, 404)
})

test('concurrent toggles and deltas resolve from the preceding write and snapshot its result', async () => {
	const { api } = setup()
	const toggles = await Promise.all(
		Array.from({ length: 4 }, () => api.handle('PUT', '/headphones/1/mute', { value: 'toggle' })),
	)
	assert.deepEqual(
		toggles.map((result) => result.body.mixes[0].muted),
		[true, false, true, false],
	)
	const levels = await Promise.all(Array.from({ length: 4 }, () => api.handle('PUT', '/monitor/level', { delta: 0.1 })))
	assert.deepEqual(
		levels.map((result) => result.body.level),
		[0.6, 0.7, 0.8, 0.9],
	)
})

test('failed API operations do not poison the queue', async () => {
	const { api, request } = setup()
	await rejects(api, 'PUT', '/monitor/level', { level: 2 })
	assert.equal((await request('PUT', '/monitor/level', { level: 0.8 })).level, 0.8)
})

test('queued work cannot cross a reconnect even when the desk becomes ready again', async () => {
	const { api, device, transport } = setup()
	let entered
	const started = new Promise((resolve) => {
		entered = resolve
	})
	let release
	transport.beforeWrite = async () => {
		entered()
		await new Promise((resolve) => {
			release = resolve
		})
	}
	const first = api.handle('PUT', '/monitor/mute', { value: true })
	await started
	const queued = api.handle('PUT', '/bluetooth/mute', { value: true })
	device.connectionGeneration++
	release()
	for (const promise of [first, queued]) await assert.rejects(promise, { statusCode: 503 })
	assert.equal(transport.writes.length, 1)
	assert.equal(device.bluetoothMuted, false)
})

test('recorder and encoder failures never publish optimistic success state', async () => {
	for (const encoder of [false, true]) {
		const { api, device, transport } = setup({ monitorMethod: encoder ? 'encoder' : 'property' })
		transport.beforeWrite = async () => {
			throw new Error('synthetic transport failure')
		}
		await assert.rejects(
			api.handle(
				encoder ? 'PUT' : 'POST',
				encoder ? '/monitor/level' : '/recorder/record',
				encoder ? { level: 0.52 } : {},
			),
			/synthetic transport failure/,
		)
		assert.equal(device.monitorLevel, 0.5)
		assert.equal(device.recordState, 0)
		assert.equal(device.recordElapsedSeconds, 0)
	}
})

test('pad release cannot be sent to a replacement connection during its press delay', async () => {
	const { api, device, transport } = setup()
	transport.afterWrite = async (change) => {
		if (change.name === 'padButtonPressed' && change.value.value) {
			setTimeout(() => device.connectionGeneration++, 0)
		}
	}
	await assert.rejects(api.handle('POST', '/pads/1/press'), { statusCode: 503 })
	assert.equal(transport.writes.length, 1)
	assert.equal(transport.writes[0].value.value, true)
})

test('encoder and recorder operations stop on replaced connections without updating success state', async () => {
	for (const encoder of [false, true]) {
		const { api, device, transport } = setup({ monitorMethod: encoder ? 'encoder' : 'property' })
		transport.afterWrite = async () => {
			device.connectionGeneration++
		}
		await assert.rejects(
			api.handle(
				encoder ? 'PUT' : 'POST',
				encoder ? '/monitor/level' : '/recorder/record',
				encoder ? { level: 0.52 } : {},
			),
			{ statusCode: 503 },
		)
		assert.equal(transport.writes.length, 1)
		assert.equal(device.monitorLevel, 0.5)
		assert.equal(device.recordState, 0)
		assert.equal(device.recordElapsedSeconds, 0)
	}
})

test('master-only sources are not marked as assigned to a fader', async () => {
	const { device, request } = setup()
	device.tree.children.splice(4, 0, np('CHANNEL', { channelInputSource: V.int(18) }))
	device.session.layout = Layout.fromFullSync(device.tree)
	const cell = await request('GET', '/routing/outputs/hp1/sources/callme3')
	assert.equal(cell.onFader, false)
})

test('API headphone toggle resolves after an overlapping Companion mute has completed', async () => {
	const { device, transport, api } = setup()
	let entered
	const started = new Promise((resolve) => {
		entered = resolve
	})
	let release
	const held = new Promise((resolve) => {
		release = resolve
	})
	let first = true
	transport.beforeWrite = async () => {
		if (!first) return
		first = false
		entered()
		await held
	}
	const companion = device.setHeadphoneMixMute(1, true)
	await started
	const toggle = api.handle('PUT', '/headphones/1/mute', { value: 'toggle' })
	await new Promise(setImmediate)
	release()
	await companion
	assert.equal((await toggle).body.mixes[0].muted, false)
	assert.equal(transport.writes.length, 38)
	assert.equal(device.headphoneMutes.size, 0)
})

test('API panic toggle resolves after an overlapping Companion release has completed', async () => {
	const { device, transport, api } = setup()
	await device.panic()
	let entered
	const started = new Promise((resolve) => {
		entered = resolve
	})
	let release
	const held = new Promise((resolve) => {
		release = resolve
	})
	let first = true
	transport.beforeWrite = async () => {
		if (!first) return
		first = false
		entered()
		await held
	}
	const companion = device.releasePanic()
	await started
	const toggle = api.handle('PUT', '/panic', { value: 'toggle' })
	await new Promise(setImmediate)
	release()
	await companion
	assert.equal((await toggle).body.active, true)
	assert.equal(device.monitorMuted, true)
	assert.equal(device.headphonesOff, true)
	assert.equal(transport.writes.length, 18)
})

test('queued API panic cannot create a snapshot on a replacement connection', async () => {
	const { device, transport, api } = setup()
	let release
	device.panicQueue = new Promise((resolve) => {
		release = resolve
	})
	const toggle = api.handle('PUT', '/panic', { value: 'toggle' })
	await new Promise(setImmediate)
	device.connectionGeneration++
	release()
	await assert.rejects(toggle, { statusCode: 503 })
	assert.equal(device.panicActive, false)
	assert.equal(transport.writes.length, 0)
})

test('partial encoder failures retain acknowledged ticks for the next level delta', async () => {
	const { api, device, transport, request } = setup({ monitorMethod: 'encoder' })
	const updates = []
	device.on('update', (area) => {
		if (area === 'monitor') updates.push(device.monitorLevel)
	})
	let attempts = 0
	transport.beforeWrite = async () => {
		if (++attempts === 3) throw new Error('synthetic third tick failure')
	}
	await assert.rejects(api.handle('PUT', '/monitor/level', { level: 0.55 }), /synthetic third tick failure/)
	assert.equal(transport.writes.length, 2)
	assert.equal(device.monitorLevel, 0.52)
	assert.deepEqual(updates, [0.51, 0.52])
	transport.beforeWrite = async () => {}
	assert.equal((await request('PUT', '/monitor/level', { delta: 0.01 })).level, 0.53)
	assert.equal(transport.writes.length, 3)
})

test('a desk level push during an encoder write does not count the tick twice', async () => {
	const { device, transport, request } = setup({ monitorMethod: 'encoder' })
	transport.afterWrite = async () => {
		device.tree.getByPath(device.outputPath).properties.set('outputMonLevel', V.double(0.51))
	}
	assert.equal((await request('PUT', '/monitor/level', { delta: 0.01 })).level, 0.51)
	assert.equal(transport.writes.length, 1)
})

test('Companion headphone action toggle resolves after an overlapping API mute', async () => {
	const { device, transport, api, routing } = setup()
	let actions
	const logs = []
	updateActions({
		device,
		routing,
		setActionDefinitions: (definitions) => {
			actions = definitions
		},
		log: (...entry) => logs.push(entry),
	})
	let entered
	const started = new Promise((resolve) => {
		entered = resolve
	})
	let release
	const held = new Promise((resolve) => {
		release = resolve
	})
	let first = true
	transport.beforeWrite = async () => {
		if (!first) return
		first = false
		entered()
		await held
	}
	const http = api.handle('PUT', '/headphones/1/mute', { value: true })
	await started
	const toggle = actions.headphone_mix_mute.callback({ options: { headphone: 1, mode: 'toggle' } })
	await new Promise(setImmediate)
	release()
	await http
	await toggle
	assert.equal(device.headphoneMixMuted(1), false)
	assert.equal(transport.writes.length, 38)
	assert.equal(device.headphoneMutes.size, 0)
	assert.deepEqual(logs, [])
})

test('Companion panic action toggle resolves after an overlapping API release', async () => {
	const { device, transport, api, routing } = setup()
	let actions
	const logs = []
	updateActions({
		device,
		routing,
		setActionDefinitions: (definitions) => {
			actions = definitions
		},
		log: (...entry) => logs.push(entry),
	})
	await device.panic()
	let entered
	const started = new Promise((resolve) => {
		entered = resolve
	})
	let release
	const held = new Promise((resolve) => {
		release = resolve
	})
	let first = true
	transport.beforeWrite = async () => {
		if (!first) return
		first = false
		entered()
		await held
	}
	const http = api.handle('PUT', '/panic', { value: false })
	await started
	const toggle = actions.panic.callback({ options: { mode: 'toggle' } })
	await new Promise(setImmediate)
	release()
	await http
	await toggle
	assert.equal(device.panicActive, true)
	assert.equal(device.monitorMuted, true)
	assert.equal(device.headphonesOff, true)
	assert.equal(transport.writes.length, 18)
	assert.deepEqual(logs, [])
})
