import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { updateActions } from '../src/actions.js'
import { formatMixLevel, parseMixLevel } from '../src/model.js'
import { decodeChangeFrame, encodeFullSync, encodePropertyChanged } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { setCellLevel, setCellState, setMode } from '../src/routing.js'
import { np, repeat, syntheticRoot } from './protocol/helpers.js'

// Keep production device, transport, protocol and callbacks. Hardware discovery
// and opening a real HID handle are forbidden even if a lifecycle test regresses.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node-hid') {
			const stub = `
				const forbidden = () => { throw new Error('real HID access forbidden in operation ordering tests') }
				export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
			`
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
		}
		if (specifier === '@companion-module/base') {
			const stub = `
				export class InstanceBase {}
				export const InstanceStatus = { Ok: 'ok', Connecting: 'connecting', Disconnected: 'disconnected' }
				export const combineRgb = (r, g, b) => (r << 16) | (g << 8) | b
			`
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
})
const { RodecasterDevice, OPERATION_QUEUE_CAPACITY, PANIC_QUEUE_CAPACITY } = await import('../src/device.js')
const { RodecasterInstance } = await import('../src/main.js')
hooks.deregister()

const deadline = { timeout: 3000 }
const connectionChanged = /connection|generation|disconnected|not connected|layout changed/i

function deferred() {
	let resolve
	const promise = new Promise((done) => (resolve = done))
	return { promise, resolve }
}

class DelayedHid extends EventEmitter {
	constructor() {
		super()
		this.tree = syntheticRoot()
		const mixEnd = this.tree.children.findIndex((node) => node.type === 'INPUTSOURCE')
		this.tree.children.splice(mixEnd, 0, ...repeat(26, 'MIX'))
		this.tree.children.push(np('ENCODER', { encoderSignal: V.binary(Buffer.alloc(10)) }))
		this.tree.children.push(...Array.from({ length: 13 }, () => np('MIXMINUSES', { outputMixMinus: V.int(0) })))
		this.layout = Layout.fromFullSync(this.tree)
		for (let strip = 0; strip < this.layout.channelCount; strip++) {
			this.properties(this.layout.channelPath(strip), {
				channelInputSource: V.int(strip),
				channelOutputMute: V.bool(false),
				channelCueEnable: V.bool(false),
			})
			this.properties(this.layout.faderPath(strip), { faderLevel: V.int(64) })
		}
		for (let source = 0; source < this.layout.sourceCount; source++) {
			for (let mix = 0; mix < this.layout.mixCountPerSource; mix++) {
				this.properties(this.layout.mixCellPath(source, mix), {
					mixMute: V.bool(false),
					mixDisabled: V.bool(false),
					mixLink: V.bool(mix === 0),
					mixLinkRequest: V.double(0),
					mixUnlinkRequest: V.double(0),
					mixLevelWithAnchor: V.string(formatMixLevel(0.5, 0.5)),
				})
			}
		}
		this.properties(this.layout.singletonPath('output'), {
			outputMonLevel: V.double(0.5),
			outputBTLevel: V.double(0.5),
			outputMonMute: V.bool(false),
			outputBTMute: V.bool(false),
		})
		this.properties(this.layout.singletonPath('system'), { disableAllHeadphoneOutputs: V.bool(false) })
		this.properties(this.layout.singletonPath('gui'), {
			screenBrightness: V.int(100),
			activeButtonsBrightness: V.int(50),
			selectedBank: V.int(0),
		})
		this.properties(this.layout.singletonPath('ducker'), { duckerDepth: V.double(-20) })
		this.properties(this.layout.singletonPath('recorder'), {
			recordState: V.int(1),
			requestRecordState: V.int(1),
		})
		for (let slot = 0; slot < this.layout.effectsCount; slot++) {
			this.properties(this.layout.effectsPath(slot), { reverbOn: V.bool(false) })
		}
		this.reassembler = new Reassembler()
		this.writes = []
		this.inFlight = 0
		this.maxInFlight = 0
		this.pendingGate = null
		this.failNext = false
		this.emitRecordFeedback = true
		this.emitEncoderFeedback = true
		this.feedback = () => {}
	}

	properties(path, properties) {
		const node = this.tree.getByPath(path)
		for (const [name, value] of Object.entries(properties)) node.properties.set(name, value)
	}

	holdNext(t) {
		assert.equal(this.pendingGate, null)
		const entered = deferred()
		const release = deferred()
		this.pendingGate = { entered, release }
		t.after(() => release.resolve())
		return { entered: entered.promise, release: release.resolve }
	}

	async write(report) {
		this.inFlight++
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
		try {
			for (const body of this.reassembler.push(report)) {
				const change = decodeChangeFrame(body)
				assert.equal(change?.type, 'propertyChanged')
				const request = { path: change.path, name: change.name, value: change.value.value }
				this.writes.push(request)
				const gate = this.pendingGate
				this.pendingGate = null
				if (gate) {
					gate.entered.resolve()
					await gate.release.promise
				}
				// Always yield, including writes after the manually released first one.
				await Promise.resolve()
				if (this.failNext) {
					this.failNext = false
					throw new Error('synthetic HID write failure')
				}
				this.properties(change.path, { [change.name]: change.value })
				// These requests change a separate desk property. Deliver the desk's
				// resulting feedback through the real input protocol, not a setter stub.
				if (change.name === 'requestRecordState' && this.emitRecordFeedback) {
					this.feedback(change.path, 'recordState', V.int(request.value))
				}
				if (change.name === 'encoderSignal' && this.emitEncoderFeedback) {
					const path = this.layout.singletonPath('output')
					const current = this.tree.getByPath(path).properties.get('outputMonLevel').value
					this.feedback(path, 'outputMonLevel', V.double(current + request.value.readInt32LE(3) / 100))
				}
			}
		} finally {
			this.inFlight--
		}
	}

	async close() {}
}

function attach(device, hid) {
	device.transport.device = hid
	device.transport.info = {
		path: 'synthetic-operation-device',
		serialNumber: 'synthetic-operation-serial',
		product: 'Synthetic RODECaster',
		productId: 1,
	}
	hid.feedback = (path, name, value) => {
		hid.properties(path, { [name]: value })
		if (device.transport.device !== hid) return
		for (const report of encodeReports(encodePropertyChanged(path, name, value), REPORT_ID_IN)) device.onReport(report)
	}
	for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
	assert.equal(device.ready, true)
}

function start(t, options = {}) {
	const hid = new DelayedHid()
	const device = new RodecasterDevice({ levelControl: true, ...options })
	attach(device, hid)
	const logs = []
	let actions
	updateActions({
		device,
		setActionDefinitions: (definitions) => (actions = definitions),
		log: (level, message) => logs.push({ level, message }),
	})
	t.after(() => {
		device.clearTimers()
		device.transport.device = null
	})
	const call = (id, options) => actions[id].callback({ options })
	return { device, hid, logs, call }
}

async function overlap(t, hid, operations) {
	const gate = hid.holdNext(t)
	const result = Promise.all(operations.map((operation) => operation()))
	await gate.entered
	assert.equal(hid.writes.length, 1, 'later operations must not start while the first HID write is pending')
	assert.equal(hid.maxInFlight, 1)
	gate.release()
	await result
	assert.equal(hid.maxInFlight, 1, 'complete operations run with one HID write in flight')
}

function near(actual, expected) {
	assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, received ${actual}`)
}

for (const kind of ['strip', 'monitor']) {
	for (const deltas of [
		[0.1, 0.1],
		[0.1, -0.1],
	]) {
		test(`${kind}: overlapping ${deltas.join(', ')} steps preserve every input`, deadline, async (t) => {
			const { device, hid } = start(t)
			const step = (delta) => (kind === 'strip' ? device.stepStripLevel(0, delta) : device.stepMonitorLevel(delta))
			await overlap(
				t,
				hid,
				deltas.map((delta) => () => step(delta)),
			)
			const expected = 0.5 + deltas[0] + deltas[1]
			near(kind === 'strip' ? device.strip(0).level : device.monitorLevel, expected)
			const levels = hid.writes.filter(
				(write) => write.name === (kind === 'strip' ? 'mixLevelWithAnchor' : 'outputMonLevel'),
			)
			assert.equal(levels.length, 2)
			near(kind === 'strip' ? parseMixLevel(levels[0].value).level : levels[0].value, 0.6)
			near(kind === 'strip' ? parseMixLevel(levels[1].value).level : levels[1].value, expected)
		})
	}

	test(`${kind}: absolute setters and relative steps retain invocation order`, deadline, async (t) => {
		const { device, hid } = start(t)
		const set = (level) => (kind === 'strip' ? device.setStripLevel(0, level) : device.setMonitorLevel(level))
		const step = (delta) => (kind === 'strip' ? device.stepStripLevel(0, delta) : device.stepMonitorLevel(delta))
		await overlap(t, hid, [() => set(0.8), () => step(0.1), () => set(0.2), () => step(0.1)])
		near(kind === 'strip' ? device.strip(0).level : device.monitorLevel, 0.3)
		const levels = hid.writes
			.filter((write) => write.name === (kind === 'strip' ? 'mixLevelWithAnchor' : 'outputMonLevel'))
			.map((write) => (kind === 'strip' ? parseMixLevel(write.value).level : write.value))
		assert.equal(levels.length, 4)
		levels.forEach((value, index) => near(value, [0.8, 0.9, 0.2, 0.3][index]))
	})
}

const toggles = [
	{ id: 'strip_mute', options: { strip: 0 }, name: 'channelOutputMute', get: (dev) => dev.strip(0).muted },
	{ id: 'strip_cue', options: { strip: 0 }, name: 'channelCueEnable', get: (dev) => dev.strip(0).cued },
	{ id: 'monitor_mute', options: {}, name: 'outputMonMute', get: (dev) => dev.monitorMuted },
	{ id: 'headphones_off', options: {}, name: 'disableAllHeadphoneOutputs', get: (dev) => dev.headphonesOff },
	{ id: 'fx', options: { slot: 0, effect: 'reverbOn' }, name: 'reverbOn', get: (dev) => dev.fxOn(0, 'reverbOn') },
]

for (const { id, options, name, get } of toggles) {
	test(`${id}: two concurrent Companion toggles restore the starting value`, deadline, async (t) => {
		const { device, hid, logs, call } = start(t)
		await overlap(t, hid, [
			() => call(id, { ...options, mode: 'toggle' }),
			() => call(id, { ...options, mode: 'toggle' }),
		])
		assert.equal(get(device), false)
		assert.deepEqual(
			hid.writes.map((write) => [write.name, write.value]),
			[
				[name, true],
				[name, false],
			],
		)
		assert.deepEqual(logs, [])
	})

	test(`${id}: absolute on/off remains absolute alongside queued toggles`, deadline, async (t) => {
		const { device, hid, logs, call } = start(t)
		const modes = ['on', 'on', 'off', 'off', 'toggle', 'toggle']
		await overlap(
			t,
			hid,
			modes.map((mode) => () => call(id, { ...options, mode })),
		)
		assert.equal(get(device), false)
		assert.deepEqual(
			hid.writes.map((write) => write.value),
			[true, true, false, false, true, false],
		)
		assert.deepEqual(logs, [])
	})
}

const relativeActions = [
	{ id: 'strip_level_step', options: { strip: 0, delta: 12.7 }, get: (dev) => dev.strip(0).level, expected: 0.7 },
	{ id: 'monitor_level_step', options: { delta: 10 }, get: (dev) => dev.monitorLevel, expected: 0.7 },
	{ id: 'bluetooth_level_step', options: { delta: 10 }, get: (dev) => dev.bluetoothLevel, expected: 0.7 },
	{ id: 'screen_brightness', options: { op: 'step', value: 10 }, get: (dev) => dev.screenBrightness, expected: 120 },
	{ id: 'buttons_brightness', options: { op: 'step', value: 10 }, get: (dev) => dev.buttonsBrightness, expected: 70 },
	{ id: 'ducker_depth', options: { op: 'step', value: -5 }, get: (dev) => dev.duckerDepth, expected: -30 },
]

for (const { id, options, get, expected } of relativeActions) {
	test(`${id}: concurrent relative Companion actions compute from completed writes`, deadline, async (t) => {
		const { device, hid, logs, call } = start(t)
		await overlap(t, hid, [() => call(id, options), () => call(id, options)])
		near(get(device), expected)
		assert.deepEqual(logs, [])
	})
}

for (const [id, property, set, step, expected] of [
	['screen_brightness', 'screenBrightness', 180, 5, 190],
	['buttons_brightness', 'buttonsBrightness', 100, 5, 110],
	['ducker_depth', 'duckerDepth', -30, -5, -40],
]) {
	test(`${id}: absolute Companion value precedes relative actions`, deadline, async (t) => {
		const { device, hid, logs, call } = start(t)
		await overlap(t, hid, [
			() => call(id, { op: 'set', value: set }),
			() => call(id, { op: 'step', value: step }),
			() => call(id, { op: 'step', value: step }),
		])
		near(device[property], expected)
		assert.deepEqual(logs, [])
	})
}

test('Bluetooth absolute device setter shares ordering with Companion relative actions', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	await overlap(t, hid, [
		() => device.setBluetoothLevel(0.2),
		() => call('bluetooth_level_step', { delta: 10 }),
		() => call('bluetooth_level_step', { delta: -10 }),
	])
	near(device.bluetoothLevel, 0.2)
	assert.deepEqual(logs, [])
})

test('record toggles use the feedback from the preceding completed request', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	await overlap(t, hid, [() => call('record', { mode: 'toggle' }), () => call('record', { mode: 'toggle' })])
	assert.equal(device.recordState, 1)
	assert.deepEqual(
		hid.writes.map((write) => write.value),
		[2, 1],
	)
	assert.deepEqual(logs, [])
})

test(
	'record toggles preserve requests without desk feedback and retain absolute record/pause/stop behavior',
	deadline,
	async (t) => {
		const { device, hid, logs, call } = start(t)
		hid.feedback(device.recorderPath, 'recordState', V.int(2))
		hid.emitRecordFeedback = false
		await overlap(
			t,
			hid,
			['toggle', 'toggle', 'pause', 'pause', 'record', 'stop', 'toggle', 'toggle'].map(
				(mode) => () => call('record', { mode }),
			),
		)
		assert.deepEqual(
			hid.writes.map((write) => write.value),
			[1, 2, 1, 1, 2, 0, 2, 1],
		)
		assert.equal(device.recordState, 2, 'requested state must not replace actual recorder feedback')
		assert.deepEqual(logs, [])
	},
)

test('delayed recorder feedback cannot roll back a newer completed toggle request', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	hid.feedback(device.recorderPath, 'recordState', V.int(2))
	hid.emitRecordFeedback = false
	await overlap(t, hid, [() => call('record', { mode: 'toggle' }), () => call('record', { mode: 'toggle' })])
	hid.feedback(device.recorderPath, 'recordState', V.int(1))
	await call('record', { mode: 'toggle' })
	hid.feedback(device.recorderPath, 'recordState', V.int(2))
	await call('record', { mode: 'toggle' })
	assert.deepEqual(
		hid.writes.map((write) => write.value),
		[1, 2, 1, 2],
	)
	assert.equal(device.recordState, 2)
	assert.deepEqual(logs, [])
})

test('recorder error feedback received during a write remains visible when it completes', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	hid.emitRecordFeedback = false
	const gate = hid.holdNext(t)
	const request = call('record', { mode: 'record' })
	await gate.entered
	hid.feedback(device.recorderPath, 'recordState', V.int(3))
	gate.release()
	await request
	assert.equal(device.recordState, 3)
	assert.equal(device.recordToggleState, 3, 'an acknowledged write cannot conceal a newer recorder error')
	await call('record', { mode: 'toggle' })
	assert.deepEqual(
		hid.writes.map((write) => write.value),
		[2, 2],
	)
	assert.deepEqual(logs, [])
})

test(
	'pad bank next/previous and absolute selection share ordering without sequencing pad gestures',
	deadline,
	async (t) => {
		const { device, hid, logs, call } = start(t)
		await overlap(
			t,
			hid,
			['next', 'next', 'prev', 7, 'next', 'prev'].map((bank) => () => call('pad_bank', { bank })),
		)
		assert.equal(device.padBank, 7)
		assert.deepEqual(
			hid.writes.map((write) => write.value),
			[1, 2, 1, 7, 0, 7],
		)
		assert.deepEqual(logs, [])
	},
)

test('headphone set/toggle and dial operations use the same operation order', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	await overlap(t, hid, [
		() => device.setHeadphoneMixMute(1, true),
		() => device.stepMonitorLevel(0.1),
		() => call('headphone_mix_mute', { headphone: 1, mode: 'toggle' }),
		() => call('bluetooth_level_step', { delta: 10 }),
		() => call('headphone_mix_mute', { headphone: 1, mode: 'on' }),
		() => call('headphone_mix_mute', { headphone: 1, mode: 'toggle' }),
	])
	assert.equal(device.headphoneMixMuted(1), false)
	assert.deepEqual(device.headphoneMuteList(), [])
	near(device.monitorLevel, 0.6)
	near(device.bluetoothLevel, 0.6)
	const bus = (value) => Array.from({ length: hid.layout.sourceCount }, () => ['mixMute', value])
	assert.deepEqual(
		hid.writes.map((write) => [write.name, write.value]),
		[...bus(true), ['outputMonLevel', 0.6], ...bus(false), ['outputBTLevel', 0.6], ...bus(true), ...bus(false)],
	)
	assert.deepEqual(logs, [])
})

test(
	'two headphone Companion toggles restore the starting bus and absolute on/off remains idempotent',
	deadline,
	async (t) => {
		const { device, hid, logs, call } = start(t)
		await overlap(
			t,
			hid,
			['toggle', 'toggle', 'on', 'on', 'off', 'off'].map(
				(mode) => () => call('headphone_mix_mute', { headphone: 2, mode }),
			),
		)
		assert.equal(device.headphoneMixMuted(2), false)
		assert.deepEqual(device.headphoneMuteList(), [])
		assert.deepEqual(
			hid.writes.map((write) => write.value),
			[true, false, true, false].flatMap((value) => Array(hid.layout.sourceCount).fill(value)),
		)
		assert.deepEqual(logs, [])
	},
)

test('normal queue overflow rejects explicitly and later capacity is reusable', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	assert.ok(Number.isInteger(OPERATION_QUEUE_CAPACITY) && OPERATION_QUEUE_CAPACITY > 0)
	const gate = hid.holdNext(t)
	const active = device.setMonitorLevel(0.5)
	await gate.entered
	const queued = Array.from({ length: OPERATION_QUEUE_CAPACITY }, (_, index) =>
		device.stepMonitorLevel(index % 2 === 0 ? 0.01 : -0.01),
	)
	const completed = Promise.all([active, ...queued])
	await assert.rejects(device.stepMonitorLevel(0.1), /queue.*full/i)
	await call('monitor_level_step', { delta: 10 })
	assert.equal(logs.length, 1)
	assert.match(logs[0].message, /queue.*full/i)
	assert.equal(hid.writes.length, 1)
	gate.release()
	await completed
	assert.equal(hid.writes.length, OPERATION_QUEUE_CAPACITY + 1)
	near(device.monitorLevel, 0.5 + (OPERATION_QUEUE_CAPACITY % 2) * 0.01)
	await device.stepMonitorLevel(0.1)
	near(device.monitorLevel, 0.6 + (OPERATION_QUEUE_CAPACITY % 2) * 0.01)
	assert.equal(hid.maxInFlight, 1)
})

test('a failed delayed write rejects its operation and allows the next valid step', deadline, async (t) => {
	const { device, hid } = start(t)
	const gate = hid.holdNext(t)
	hid.failNext = true
	const failed = assert.rejects(device.stepMonitorLevel(0.1), /synthetic HID write failure/)
	const next = device.stepMonitorLevel(0.1)
	await gate.entered
	assert.equal(hid.writes.length, 1)
	gate.release()
	await Promise.all([failed, next])
	near(device.monitorLevel, 0.6)
	assert.deepEqual(
		hid.writes.map((write) => write.value),
		[0.6, 0.6],
	)
	await device.stepMonitorLevel(0.1)
	near(device.monitorLevel, 0.7)
	assert.equal(hid.maxInFlight, 1)
})

test('an invalid operation releases the queue for unrelated valid work', deadline, async (t) => {
	const { device, hid } = start(t, { levelControl: false })
	await Promise.all([
		assert.rejects(device.stepStripLevel(0, 0.1), /level control is locked/),
		device.stepMonitorLevel(0.1),
	])
	near(device.monitorLevel, 0.6)
	assert.deepEqual(
		hid.writes.map((write) => write.name),
		['outputMonLevel'],
	)
})

test(
	'disconnect rejects active and queued work before a replacement connection can receive it',
	deadline,
	async (t) => {
		const { device, hid, logs, call } = start(t)
		const gate = hid.holdNext(t)
		const active = assert.rejects(device.setHeadphoneMixMute(1, true), connectionChanged)
		await gate.entered
		const queued = assert.rejects(device.stepMonitorLevel(0.1), connectionChanged)
		const action = call('bluetooth_level_step', { delta: 10 })
		await device.onClosed(new Error('synthetic disconnect'))
		await assert.rejects(device.setMonitorMute(true), connectionChanged)
		const replacement = new DelayedHid()
		attach(device, replacement)
		const fresh = device.stepMonitorLevel(0.1)
		assert.deepEqual(replacement.writes, [])
		gate.release()
		await Promise.all([active, queued, action, fresh])
		assert.equal(hid.writes.length, 1, 'the old multi-write operation stops after its pending old-handle write')
		assert.deepEqual(
			replacement.writes.map((write) => [write.name, write.value]),
			[['outputMonLevel', 0.6]],
		)
		assert.equal(logs.length, 1)
		assert.match(logs[0].message, connectionChanged)
		assert.equal(device.headphoneMixMuted(1), false)
		near(device.bluetoothLevel, 0.5)
		near(device.monitorLevel, 0.6)
	},
)

test('a generation change rejects queued reads even when the handle and tree are unchanged', deadline, async (t) => {
	const { device, hid } = start(t)
	const gate = hid.holdNext(t)
	const active = assert.rejects(device.stepMonitorLevel(0.1), connectionChanged)
	await gate.entered
	let reads = 0
	const queued = assert.rejects(
		device.setBluetoothLevel(() => {
			reads++
			return device.bluetoothLevel + 0.1
		}),
		connectionChanged,
	)
	device.connectionGeneration++
	gate.release()
	await Promise.all([active, queued])
	assert.equal(reads, 0)
	assert.equal(hid.writes.length, 1)
	near(device.bluetoothLevel, 0.5)
	await device.stepMonitorLevel(0.1)
	near(device.monitorLevel, 0.6)
})

test('queued strip borrow, step and restore helpers complete without nested queue deadlock', deadline, async (t) => {
	const { device, hid } = start(t)
	await overlap(t, hid, [
		() => device.borrowStrip(0),
		() => device.stepStripLevel(0, 0.1),
		() => device.setStripLevel(1, 0.7),
		() => device.restoreFaders(),
	])
	assert.equal(device.borrowed.size, 0)
	assert.deepEqual(
		hid.writes.map((write) => write.name),
		[
			'mixUnlinkRequest',
			'mixLevelWithAnchor',
			'mixUnlinkRequest',
			'mixLevelWithAnchor',
			'mixLinkRequest',
			'mixLinkRequest',
		],
	)
	assert.equal(device.propBool(device.layout.mixCellPath(0, 0), 'mixLink'), true)
	assert.equal(device.propBool(device.layout.mixCellPath(1, 0), 'mixLink'), true)
})

test('shutdown rejects new normal and panic operations while restoring a borrowed fader', deadline, async (t) => {
	const { device, hid } = start(t)
	await device.borrowStrip(0)
	const gate = hid.holdNext(t)
	const stopping = device.stop()
	await gate.entered
	await assert.rejects(device.stepMonitorLevel(0.1), connectionChanged)
	await assert.rejects(device.panic(), connectionChanged)
	assert.deepEqual(
		hid.writes.map((write) => write.name),
		['mixUnlinkRequest', 'mixLinkRequest'],
	)
	gate.release()
	await stopping
	assert.equal(device.ready, false)
	assert.equal(device.transport.isOpen, false)
	assert.equal(hid.maxInFlight, 1)
})

test('monitor encoder helpers complete with feedback before the following relative target', deadline, async (t) => {
	const { device, hid } = start(t, { monitorMethod: 'encoder' })
	await overlap(t, hid, [() => device.stepMonitorLevel(0.1), () => device.stepMonitorLevel(-0.1)])
	near(device.monitorLevel, 0.5)
	assert.equal(hid.writes.length, 20)
	assert.deepEqual(
		hid.writes.map((write) => write.value.readInt32LE(3)),
		[...Array(10).fill(1), ...Array(10).fill(-1)],
	)
	assert.deepEqual(
		hid.writes.map((write) => write.value[9]),
		Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 2 : 3)),
	)
})

for (const second of [0.1, -0.1]) {
	test(
		`encoder relative ticks preserve ${second > 0 ? 'same' : 'opposite'} direction steps without desk feedback`,
		deadline,
		async (t) => {
			const { device, hid } = start(t, { monitorMethod: 'encoder' })
			hid.emitEncoderFeedback = false
			await overlap(t, hid, [() => device.stepMonitorLevel(0.1), () => device.stepMonitorLevel(second)])
			assert.deepEqual(
				hid.writes.map((write) => write.value.readInt32LE(3)),
				[...Array(10).fill(1), ...Array(10).fill(Math.sign(second))],
			)
			near(device.monitorLevel, 0.5, 'the observed monitor property stays unchanged until actual feedback')
		},
	)
}

test(
	'encoder absolute setters account for preceding completed relative ticks without desk feedback',
	deadline,
	async (t) => {
		const { device, hid } = start(t, { monitorMethod: 'encoder' })
		hid.emitEncoderFeedback = false
		await overlap(t, hid, [() => device.stepMonitorLevel(0.1), () => device.setMonitorLevel(0.5)])
		assert.deepEqual(
			hid.writes.map((write) => write.value.readInt32LE(3)),
			[...Array(10).fill(1), ...Array(10).fill(-1)],
		)
		near(device.monitorLevel, 0.5)
	},
)

test(
	'repeated encoder absolute setters do not repeat already completed ticks without desk feedback',
	deadline,
	async (t) => {
		const { device, hid } = start(t, { monitorMethod: 'encoder' })
		hid.emitEncoderFeedback = false
		await overlap(t, hid, [() => device.setMonitorLevel(0.6), () => device.setMonitorLevel(0.6)])
		assert.deepEqual(
			hid.writes.map((write) => write.value.readInt32LE(3)),
			Array(10).fill(1),
		)
		near(device.monitorLevel, 0.5)
	},
)

test('routing cell level reads the anchor after the preceding queued write completes', deadline, async (t) => {
	const { device, hid } = start(t)
	const path = device.layout.mixCellPath(0, 0)
	await overlap(t, hid, [
		() => device.queueOperation(() => device.write(path, 'mixLevelWithAnchor', V.string(formatMixLevel(0.4, 0.8)))),
		() => setCellLevel(device, 0, 0, 0.9),
		() => device.stepMonitorLevel(0.1),
	])
	assert.deepEqual(parseMixLevel(device.propString(path, 'mixLevelWithAnchor')), { level: 0.9, anchor: 0.8 })
	assert.deepEqual(
		hid.writes.map((write) => write.name),
		['mixLevelWithAnchor', 'mixLevelWithAnchor', 'outputMonLevel'],
	)
	assert.deepEqual(parseMixLevel(hid.writes[1].value), { level: 0.9, anchor: 0.8 })
})

test('routing HTTP callback accepts parsed and string bodies and shares queued anchor reads', deadline, async (t) => {
	const { device, hid } = start(t)
	const instance = new RodecasterInstance({})
	instance.device = device
	const path = device.layout.mixCellPath(0, 0)
	const responses = []
	await overlap(t, hid, [
		() => device.queueOperation(() => device.write(path, 'mixLevelWithAnchor', V.string(formatMixLevel(0.4, 0.8)))),
		async () =>
			responses.push(
				await instance.handleHttpRequest({
					method: 'POST',
					path: '/routing/cell',
					body: { source: 0, output: 0, level: 0.9 },
				}),
			),
		async () =>
			responses.push(
				await instance.handleHttpRequest({
					method: 'POST',
					path: '/routing/mode',
					body: JSON.stringify({ output: 0, mode: 2 }),
				}),
			),
	])
	assert.deepEqual(
		responses.map((response) => [response.status, JSON.parse(response.body)]),
		[
			[200, { ok: true }],
			[200, { ok: true }],
		],
	)
	const response = await instance.handleHttpRequest({ method: 'GET', path: '/routing' })
	assert.equal(response.status, 200)
	const state = JSON.parse(response.body)
	assert.equal(state.outputs[0].mode, 2)
	near(state.outputs[0].cells[0].level, 0.9)
	near(state.outputs[0].cells[0].anchor, 0.8)
	assert.deepEqual(
		hid.writes.map((write) => write.name),
		['mixLevelWithAnchor', 'mixLevelWithAnchor', 'outputMixMinus'],
	)
})

test('routing mode and multi-write cell state share ordering with headphone callbacks', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	await overlap(t, hid, [
		() => setCellState(device, 0, 0, 'off'),
		() => call('headphone_mix_mute', { headphone: 1, mode: 'on' }),
		() => setMode(device, 0, 2),
		() => setCellState(device, 0, 0, 'link'),
	])
	assert.deepEqual(
		hid.writes.map((write) => [write.name, write.value]),
		[
			['mixDisabled', true],
			['mixMute', true],
			...Array.from({ length: hid.layout.sourceCount - 1 }, () => ['mixMute', true]),
			['outputMixMinus', 2],
			['mixDisabled', false],
			['mixMute', false],
			['mixLinkRequest', Buffer.from([1, 1, 2, 1, 1, 2])],
		],
	)
	assert.equal(device.propBool(device.layout.mixCellPath(0, 0), 'mixLink'), true)
	assert.deepEqual(logs, [])
})

for (const kind of ['routing', 'encoder']) {
	test(
		`${kind}: disconnect stops a multi-write operation before it can write to a replacement`,
		deadline,
		async (t) => {
			const { device, hid } = start(t, { monitorMethod: 'encoder' })
			const gate = hid.holdNext(t)
			const active = assert.rejects(
				kind === 'routing' ? setCellState(device, 0, 0, 'off') : device.stepMonitorLevel(0.1),
				connectionChanged,
			)
			await gate.entered
			await device.onClosed(new Error('synthetic disconnect'))
			const replacement = new DelayedHid()
			attach(device, replacement)
			gate.release()
			await active
			assert.equal(hid.writes.length, 1)
			assert.deepEqual(replacement.writes, [])
			assert.equal(device.propBool(device.layout.mixCellPath(0, 0), 'mixMute'), false)
			near(device.monitorLevel, 0.5)
		},
	)
}

test('panic takes its reserved capacity and runs before a full dial backlog', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	const gate = hid.holdNext(t)
	const active = device.stepMonitorLevel(0.01)
	await gate.entered
	const backlog = Array.from({ length: OPERATION_QUEUE_CAPACITY }, (_, index) =>
		device.stepMonitorLevel(index % 2 === 0 ? 0.01 : -0.01),
	)
	await assert.rejects(device.stepMonitorLevel(0.1), /queue.*full/i)
	const panic = call('panic', { mode: 'on' })
	const release = call('panic', { mode: 'off' })
	const result = Promise.all([active, ...backlog, panic, release])
	assert.equal(hid.writes.length, 1, 'panic waits only for the one active operation')
	gate.release()
	await result
	const panicNames = [
		'channelOutputMute',
		'channelOutputMute',
		'channelOutputMute',
		'outputMonMute',
		'outputBTMute',
		'disableAllHeadphoneOutputs',
	]
	assert.deepEqual(
		hid.writes.slice(1, 7).map((write) => [write.name, write.value]),
		panicNames.map((name) => [name, true]),
	)
	assert.deepEqual(
		hid.writes.slice(7, 13).map((write) => [write.name, write.value]),
		panicNames.map((name) => [name, false]),
	)
	assert.ok(hid.writes.slice(13).every((write) => write.name === 'outputMonLevel'))
	assert.equal(hid.writes.length, OPERATION_QUEUE_CAPACITY + 13)
	assert.equal(device.panicActive, false)
	assert.equal(hid.maxInFlight, 1)
	assert.deepEqual(logs, [])
})

test('panic priority queue has a finite bound and preserves toggle order', deadline, async (t) => {
	const { device, hid, logs, call } = start(t)
	assert.ok(Number.isInteger(PANIC_QUEUE_CAPACITY) && PANIC_QUEUE_CAPACITY > 0)
	const gate = hid.holdNext(t)
	const active = device.stepMonitorLevel(0.01)
	await gate.entered
	const priority = Array.from({ length: PANIC_QUEUE_CAPACITY }, () => call('panic', { mode: 'toggle' }))
	await assert.rejects(device.panic(), /queue.*full/i)
	const result = Promise.all([active, ...priority])
	gate.release()
	await result
	assert.equal(device.panicActive, PANIC_QUEUE_CAPACITY % 2 === 1)
	assert.equal(hid.writes.length, 1 + PANIC_QUEUE_CAPACITY * 6)
	for (let index = 0; index < PANIC_QUEUE_CAPACITY; index++) {
		assert.ok(hid.writes.slice(1 + index * 6, 7 + index * 6).every((write) => write.value === (index % 2 === 0)))
	}
	assert.equal(hid.maxInFlight, 1)
	assert.deepEqual(logs, [])
})
