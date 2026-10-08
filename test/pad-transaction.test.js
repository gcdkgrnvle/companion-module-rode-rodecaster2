import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { updateActions } from '../src/actions.js'
import { decodeChangeFrame, encodeFullSync, encodePropertyChanged } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { np, syntheticRoot } from './protocol/helpers.js'

// Exercise the real transport, protocol, device and Companion callbacks, while
// making discovery and opening physical hardware impossible even on regression.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node-hid') {
			const stub = `
				const forbidden = () => { throw new Error('real HID access forbidden in pad transaction tests') }
				export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
			`
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
})
const { RodecasterDevice, OPERATION_QUEUE_CAPACITY } = await import('../src/device.js')
hooks.deregister()

const deadline = { timeout: 5000 }
const connectionChanged = /connection|generation|disconnected|not connected|layout changed/i
const uncertain = /uncertain|may have|unknown/i
const bankWrite = (write) => write.name === 'selectedBank'
const pressWrite = (write) => write.name === 'padButtonPressed' && write.value === true
const releaseWrite = (write) => write.name === 'padButtonPressed' && write.value === false

function deferred() {
	let resolve
	const promise = new Promise((done) => (resolve = done))
	return { promise, resolve }
}

function hold(t) {
	const entered = deferred()
	const release = deferred()
	t.after(() => release.resolve())
	return { entered: entered.promise, release: release.resolve, begin: entered.resolve, wait: release.promise }
}

class PadTimers {
	constructor() {
		this.pending = null
		this.delays = []
	}

	holdNext(t) {
		assert.equal(this.pending, null)
		return (this.pending = hold(t))
	}

	setTimeout = (callback, delay) => {
		if (delay !== 80) return setTimeout(callback, delay)
		this.delays.push(delay)
		const gate = this.pending
		this.pending = null
		if (!gate) return setTimeout(callback, 1)
		gate.begin()
		const timer = { cancelled: false }
		void gate.wait.then(() => {
			if (!timer.cancelled) callback()
		})
		return timer
	}

	clearTimeout = (timer) => {
		if (timer && 'cancelled' in timer) timer.cancelled = true
		else clearTimeout(timer)
	}
}

class DelayedPadHid extends EventEmitter {
	constructor() {
		super()
		this.tree = syntheticRoot()
		this.tree.children
			.find((node) => node.type === 'PHYSICALINTERFACE')
			.children.push(...Array.from({ length: 8 }, () => np('PADBUTTON', { padButtonPressed: V.bool(false) })))
		this.layout = Layout.fromFullSync(this.tree)
		this.properties(this.layout.singletonPath('gui'), { selectedBank: V.int(0) })
		this.properties(this.layout.singletonPath('output'), {
			outputMonLevel: V.double(0.5),
			outputMonMute: V.bool(false),
			outputBTMute: V.bool(false),
		})
		this.properties(this.layout.singletonPath('system'), { disableAllHeadphoneOutputs: V.bool(false) })
		for (let strip = 0; strip < this.layout.channelCount; strip++) {
			this.properties(this.layout.channelPath(strip), {
				channelInputSource: V.int(strip < 2 ? strip : -1),
				channelOutputMute: V.bool(false),
				channelCueEnable: V.bool(false),
			})
		}
		this.reassembler = new Reassembler()
		this.writes = []
		this.events = []
		this.active = new Map()
		this.lastPress = new Map()
		this.pressCount = 0
		this.gates = []
		this.failures = []
		this.inFlight = 0
		this.maxInFlight = 0
	}

	get bank() {
		return this.tree.getByPath(this.layout.singletonPath('gui')).properties.get('selectedBank').value
	}

	properties(path, properties) {
		const node = this.tree.getByPath(path)
		for (const [name, value] of Object.entries(properties)) node.properties.set(name, value)
	}

	holdNext(t, match, phase = 'before') {
		const gate = { ...hold(t), match, phase }
		this.gates.push(gate)
		return gate
	}

	failNext(match, phase = 'before', count = 1) {
		this.failures.push({ match, phase, count })
	}

	async pause(request, phase) {
		const index = this.gates.findIndex((gate) => gate.phase === phase && gate.match(request))
		if (index < 0) return
		const [gate] = this.gates.splice(index, 1)
		gate.begin()
		await gate.wait
	}

	apply(change, request) {
		if (change.name === 'padButtonPressed') {
			const node = this.tree.getByPath(change.path)
			const buttons = this.tree.children[this.layout.physicalInterfaceIdx].children.filter(
				(child) => child.type === 'PADBUTTON',
			)
			const slot = buttons.indexOf(node)
			assert.ok(slot >= 0)
			if (request.value) {
				assert.equal(this.active.has(slot), false, 'a slot cannot be pressed while its previous press is held')
				const press = { slot, bank: this.bank, owner: ++this.pressCount }
				this.active.set(slot, press)
				this.lastPress.set(slot, press)
				this.events.push({ kind: 'press', ...press })
			} else {
				const press = this.active.get(slot) ?? this.lastPress.get(slot)
				this.events.push({ kind: 'release', slot, bank: this.bank, owner: press?.owner ?? null })
				this.active.delete(slot)
			}
		}
		this.properties(change.path, { [change.name]: change.value })
		request.applied = true
	}

	async write(report) {
		this.inFlight++
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
		try {
			for (const body of this.reassembler.push(report)) {
				const change = decodeChangeFrame(body)
				assert.equal(change?.type, 'propertyChanged')
				const request = {
					path: change.path,
					name: change.name,
					value: change.value.value,
					applied: false,
					acknowledged: false,
				}
				this.writes.push(request)
				const failure = this.failures.find((item) => item.count && item.match(request))
				if (failure) failure.count--
				await this.pause(request, 'before')
				await Promise.resolve()
				if (failure?.phase === 'before') throw new Error('synthetic HID write failure before application')
				this.apply(change, request)
				await this.pause(request, 'after')
				if (failure?.phase === 'after') throw new Error('synthetic HID write failure after application')
				request.acknowledged = true
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
		path: 'synthetic-pad-device',
		serialNumber: 'synthetic-pad-serial',
		product: 'Synthetic RODECaster',
		productId: 1,
	}
	for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
	assert.equal(device.ready, true)
}

function start(t) {
	const hid = new DelayedPadHid()
	const timers = new PadTimers()
	const device = new RodecasterDevice({}, { timers })
	const deviceLogs = []
	const logs = []
	device.on('log', (level, message) => {
		deviceLogs.push({ level, message })
		if (uncertain.test(message)) logs.push({ level, message })
	})
	attach(device, hid)
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
	return { device, hid, timers, logs, deviceLogs, call }
}

function writes(hid) {
	return hid.writes.map(({ name, value }) => [name, value])
}

function assertGestures(hid, intended) {
	assert.deepEqual(
		hid.events,
		intended.flatMap(([slot, bank], index) => [
			{ kind: 'press', slot, bank, owner: index + 1 },
			{ kind: 'release', slot, bank, owner: index + 1 },
		]),
	)
	assert.equal(hid.active.size, 0)
	assert.equal(hid.maxInFlight, 1)
}

for (const slots of [
	[0, 1],
	[0, 0],
]) {
	test(
		`delayed simultaneous slots ${slots.join('/')} retain their distinct requested banks through release`,
		deadline,
		async (t) => {
			const { hid, call, logs } = start(t)
			const gate = hid.holdNext(t, bankWrite)
			const first = call('pad_press', { slot: slots[0], bank: 2 })
			const second = call('pad_press', { slot: slots[1], bank: 5 })
			await gate.entered
			assert.deepEqual(writes(hid), [['selectedBank', 2]])
			gate.release()
			await Promise.all([first, second])
			assertGestures(hid, [
				[slots[0], 2],
				[slots[1], 5],
			])
			assert.deepEqual(writes(hid), [
				['selectedBank', 2],
				['padButtonPressed', true],
				['padButtonPressed', false],
				['selectedBank', 5],
				['padButtonPressed', true],
				['padButtonPressed', false],
			])
			assert.deepEqual(logs, [])
		},
	)
}

test(
	'same-bank same-slot overlap retains separate presses and releases throughout the timed hold',
	deadline,
	async (t) => {
		const { device, hid, timers } = start(t)
		const gate = timers.holdNext(t)
		const first = device.pressPad(3, 0)
		await gate.entered
		const second = device.pressPad(3, 0)
		await new Promise((resolve) => setImmediate(resolve))
		assert.deepEqual(writes(hid), [['padButtonPressed', true]])
		gate.release()
		await Promise.all([first, second])
		assertGestures(hid, [
			[3, 0],
			[3, 0],
		])
		assert.deepEqual(timers.delays, [80, 80])
	},
)

test(
	'explicit, next and previous bank actions wait for release and read their bank at execution',
	deadline,
	async (t) => {
		const { device, hid, timers, call, logs } = start(t)
		const gate = timers.holdNext(t)
		const first = call('pad_press', { slot: 0, bank: 6 })
		await gate.entered
		const queued = [
			call('pad_bank', { bank: 'next' }),
			call('pad_bank', { bank: 'next' }),
			call('pad_bank', { bank: 'prev' }),
			call('pad_bank', { bank: 2 }),
			call('pad_press', { slot: 1, bank: -1 }),
			call('pad_bank', { bank: 'prev' }),
			call('pad_press', { slot: 2, bank: -1 }),
		]
		assert.deepEqual(writes(hid), [
			['selectedBank', 6],
			['padButtonPressed', true],
		])
		gate.release()
		await Promise.all([first, ...queued])
		assertGestures(hid, [
			[0, 6],
			[1, 2],
			[2, 1],
		])
		assert.deepEqual(
			hid.writes.filter(bankWrite).map((write) => write.value),
			[6, 7, 0, 7, 2, 1],
		)
		assert.equal(device.padBank, 1)
		assert.deepEqual(logs, [])
	},
)

test(
	'pad gestures use the existing operation order alongside absolute and relative monitor writes',
	deadline,
	async (t) => {
		const { device, hid } = start(t)
		const gate = hid.holdNext(t, (write) => write.name === 'outputMonLevel')
		const first = device.setMonitorLevel(0.4)
		await gate.entered
		const queued = [device.pressPad(1, 3), device.stepMonitorLevel(0.1), device.setPadBank(6), device.pressPad(2)]
		gate.release()
		await Promise.all([first, ...queued])
		assertGestures(hid, [
			[1, 3],
			[2, 6],
		])
		assert.deepEqual(writes(hid), [
			['outputMonLevel', 0.4],
			['selectedBank', 3],
			['padButtonPressed', true],
			['padButtonPressed', false],
			['outputMonLevel', 0.5],
			['selectedBank', 6],
			['padButtonPressed', true],
			['padButtonPressed', false],
		])
	},
)

for (const phase of ['before', 'after']) {
	test(
		`press failure ${phase} application reports uncertainty, releases once and never replays its trigger`,
		deadline,
		async (t) => {
			const { device, hid } = start(t)
			hid.failNext(pressWrite, phase)
			const failed = assert.rejects(device.pressPad(0, 2), uncertain)
			const next = device.pressPad(1, 5)
			await Promise.all([failed, next])
			assert.deepEqual(writes(hid), [
				['selectedBank', 2],
				['padButtonPressed', true],
				['padButtonPressed', false],
				['selectedBank', 5],
				['padButtonPressed', true],
				['padButtonPressed', false],
			])
			assert.deepEqual(
				hid.events.filter((event) => event.kind === 'press').map(({ slot, bank }) => [slot, bank]),
				phase === 'after'
					? [
							[0, 2],
							[1, 5],
						]
					: [[1, 5]],
			)
			assert.equal(hid.active.size, 0)
			assert.equal(hid.maxInFlight, 1)
		},
	)

	test(
		`release failure ${phase} application blocks new triggers and bank changes until release is acknowledged`,
		deadline,
		async (t) => {
			const { device, hid, call, logs } = start(t)
			hid.failNext(releaseWrite, phase, 3)
			await assert.rejects(device.pressPad(0, 2), /release|uncertain/i)
			await assert.rejects(device.pressPad(1, 5), /release|uncertain/i)
			await call('pad_bank', { bank: 'next' })
			assert.equal(logs.length, 1)
			assert.match(logs[0].message, /release|uncertain/i)
			assert.equal(hid.writes.filter(pressWrite).length, 1, 'failed releases must not replay or admit a trigger')
			assert.deepEqual(
				hid.writes.filter(bankWrite).map((write) => write.value),
				[2],
			)
			await device.stepMonitorLevel(0.1)
			await device.setPadBank(5)
			await device.pressPad(1)
			assert.deepEqual(writes(hid), [
				['selectedBank', 2],
				['padButtonPressed', true],
				['padButtonPressed', false],
				['padButtonPressed', false],
				['padButtonPressed', false],
				['outputMonLevel', 0.6],
				['padButtonPressed', false],
				['selectedBank', 5],
				['padButtonPressed', true],
				['padButtonPressed', false],
			])
			assert.equal(hid.writes[6].acknowledged, true, 'recovery release must acknowledge before another bank/trigger')
			assert.deepEqual(
				hid.events.filter((event) => event.kind === 'press').map(({ slot, bank }) => [slot, bank]),
				[
					[0, 2],
					[1, 5],
				],
			)
			assert.equal(hid.active.size, 0)
		},
	)

	test(
		`uncertain bank write ${phase} application blocks current/relative use until an absolute bank is confirmed`,
		deadline,
		async (t) => {
			const { device, hid } = start(t)
			hid.failNext(bankWrite, phase)
			await assert.rejects(device.pressPad(0, 3), /bank|uncertain|synthetic HID/i)
			await assert.rejects(device.pressPad(0), /bank|uncertain/i)
			await assert.rejects(device.stepPadBank(1), /bank|uncertain/i)
			assert.equal(hid.writes.filter(pressWrite).length, 0)
			await device.pressPad(1, 0)
			assert.deepEqual(writes(hid), [
				['selectedBank', 3],
				['selectedBank', 0],
				['padButtonPressed', true],
				['padButtonPressed', false],
			])
			assertGestures(hid, [[1, 0]])
		},
	)
}

test(
	'failed press and failed best-effort release remain observable through the action callback',
	deadline,
	async (t) => {
		const { device, hid, call, logs } = start(t)
		hid.failNext(pressWrite, 'after')
		hid.failNext(releaseWrite)
		await call('pad_press', { slot: 2, bank: 4 })
		assert.equal(logs.length, 1)
		assert.match(logs[0].message, uncertain)
		assert.match(logs[0].message, /release/i)
		assert.equal(hid.writes.filter(pressWrite).length, 1)
		await device.pressPad(2, 4)
		assert.deepEqual(writes(hid), [
			['selectedBank', 4],
			['padButtonPressed', true],
			['padButtonPressed', false],
			['padButtonPressed', false],
			['padButtonPressed', true],
			['padButtonPressed', false],
		])
		assertGestures(hid, [
			[2, 4],
			[2, 4],
		])
	},
)

test(
	'queued trigger waits for the recovery release acknowledgement after the original gesture rejects',
	deadline,
	async (t) => {
		const { device, hid } = start(t)
		hid.failNext(releaseWrite, 'after')
		const first = assert.rejects(device.pressPad(0, 2), /release.*uncertain/i)
		await first
		const recovery = hid.holdNext(t, releaseWrite, 'after')
		const next = device.pressPad(0, 5)
		await recovery.entered
		assert.deepEqual(writes(hid), [
			['selectedBank', 2],
			['padButtonPressed', true],
			['padButtonPressed', false],
			['padButtonPressed', false],
		])
		assert.equal(hid.writes.at(-1).acknowledged, false)
		assert.equal(hid.writes.filter(pressWrite).length, 1)
		recovery.release()
		await next
		assert.deepEqual(hid.events, [
			{ kind: 'press', slot: 0, bank: 2, owner: 1 },
			{ kind: 'release', slot: 0, bank: 2, owner: 1 },
			{ kind: 'release', slot: 0, bank: 2, owner: 1 },
			{ kind: 'press', slot: 0, bank: 5, owner: 2 },
			{ kind: 'release', slot: 0, bank: 5, owner: 2 },
		])
		assert.equal(hid.active.size, 0)
	},
)

test(
	'invalid bank and slot requests reject without writes or poisoning the following current-bank gesture',
	deadline,
	async (t) => {
		const { device, hid } = start(t)
		for (const bank of [Number.NaN, 1.5]) {
			await assert.rejects(device.setPadBank(bank), /integer/i)
			await assert.rejects(device.pressPad(0, bank), /integer/i)
		}
		await assert.rejects(device.pressPad(8, 4), /no pad button/i)
		assert.deepEqual(hid.writes, [])
		await device.pressPad(0)
		assertGestures(hid, [[0, 0]])
		assert.deepEqual(writes(hid), [
			['padButtonPressed', true],
			['padButtonPressed', false],
		])
	},
)

test(
	'full normal queue rejects pad/bank callbacks observably while panic keeps its reserved priority',
	deadline,
	async (t) => {
		const { device, hid, timers, call, logs } = start(t)
		assert.ok(Number.isInteger(OPERATION_QUEUE_CAPACITY) && OPERATION_QUEUE_CAPACITY > 0)
		const gate = timers.holdNext(t)
		const active = device.pressPad(0, 2)
		await gate.entered
		const queued = Array.from({ length: OPERATION_QUEUE_CAPACITY }, (_, index) => device.setPadBank(index % 8))
		await assert.rejects(device.pressPad(1, 6), /queue.*full/i)
		await call('pad_press', { slot: 1, bank: 6 })
		await call('pad_bank', { bank: 'next' })
		const panic = device.panic()
		const release = device.releasePanic()
		assert.equal(logs.length, 2)
		for (const entry of logs) assert.match(entry.message, /queue.*full/i)
		assert.deepEqual(writes(hid), [
			['selectedBank', 2],
			['padButtonPressed', true],
		])
		gate.release()
		await Promise.all([active, ...queued, panic, release])
		const panicNames = [
			'channelOutputMute',
			'channelOutputMute',
			'outputMonMute',
			'outputBTMute',
			'disableAllHeadphoneOutputs',
		]
		assert.deepEqual(writes(hid).slice(2, 13), [
			['padButtonPressed', false],
			...panicNames.map((name) => [name, true]),
			...panicNames.map((name) => [name, false]),
		])
		assert.deepEqual(
			hid.writes.filter(bankWrite).map((write) => write.value),
			[2, ...queued.map((_, index) => index % 8)],
		)
		assert.equal(device.panicActive, false)
		await device.pressPad(1, 6)
		assertGestures(hid, [
			[0, 2],
			[1, 6],
		])
	},
)

for (const phase of ['selection', 'press before', 'press after', 'delay', 'release before', 'release after']) {
	test(
		`disconnect during ${phase} cancels queued work and never sends the old gesture to a replacement`,
		deadline,
		async (t) => {
			const { device, hid, timers, call, logs } = start(t)
			const gate =
				phase === 'delay'
					? timers.holdNext(t)
					: hid.holdNext(
							t,
							phase === 'selection' ? bankWrite : phase.startsWith('press') ? pressWrite : releaseWrite,
							phase.endsWith('after') ? 'after' : 'before',
						)
			const active = assert.rejects(device.pressPad(0, 2), /connection|layout changed|uncertain|release/i)
			await gate.entered
			const queued = assert.rejects(device.pressPad(1, 5), connectionChanged)
			const bank = call('pad_bank', { bank: 'next' })
			await device.onClosed(new Error('synthetic disconnect'))
			await assert.rejects(device.pressPad(1, 5), connectionChanged)
			const replacement = new DelayedPadHid()
			attach(device, replacement)
			const freshMonitor = device.stepMonitorLevel(0.1)
			assert.deepEqual(replacement.writes, [])
			gate.release()
			await Promise.all([active, queued, bank, freshMonitor])
			assert.deepEqual(writes(replacement), [['outputMonLevel', 0.6]])
			assert.ok(
				logs.some(({ message }) => connectionChanged.test(message)),
				'cancelled bank callback must be observable',
			)
			assert.equal(logs.length, phase === 'selection' ? 1 : 2)
			assert.equal(uncertaintyLogs(logs).length, phase === 'selection' ? 0 : 1)
			assert.ok(
				hid.events.every((event) => event.bank === 2),
				'old-handle events keep the original bank',
			)
			if (phase === 'selection') assert.equal(hid.writes.filter(pressWrite).length, 0)
			assert.equal(replacement.writes.filter(releaseWrite).length, 0, 'synced released buttons need no release')
			await device.setPadBank(5)
			await device.pressPad(1)
			assertGestures(replacement, [[1, 5]])
			await device.panic()
			assert.equal(device.panicActive, true)
		},
	)
}

test(
	'a generation change rejects pad work until a full sync safely reconciles the same handle',
	deadline,
	async (t) => {
		const { device, hid, timers } = start(t)
		const gate = timers.holdNext(t)
		const active = assert.rejects(device.pressPad(0, 2), /connection|uncertain|release/i)
		await gate.entered
		const queued = assert.rejects(device.pressPad(1, 5), connectionChanged)
		device.connectionGeneration++
		gate.release()
		await Promise.all([active, queued])
		await assert.rejects(device.pressPad(1, 5), /release|original|uncertain/i)
		assert.deepEqual(writes(hid), [
			['selectedBank', 2],
			['padButtonPressed', true],
		])
		await device.stepMonitorLevel(0.1)
		assert.equal(hid.writes.at(-1).name, 'outputMonLevel')
		attach(device, hid)
		await device.pressPad(1, 5)
		assertGestures(hid, [
			[0, 2],
			[1, 5],
		])
	},
)

test(
	'a replacement full sync cancels queued gestures and reconciles the synced pressed button',
	deadline,
	async (t) => {
		const { device, hid, timers } = start(t)
		const gate = timers.holdNext(t)
		const active = assert.rejects(device.pressPad(0, 2), /connection|layout|uncertain|release/i)
		await gate.entered
		const queued = assert.rejects(device.pressPad(1, 5), connectionChanged)
		const bank = assert.rejects(device.stepPadBank(1), connectionChanged)
		attach(device, hid)
		gate.release()
		await Promise.all([active, queued, bank])
		await device.stepMonitorLevel(0.1)
		assert.deepEqual(writes(hid), [
			['selectedBank', 2],
			['padButtonPressed', true],
			['padButtonPressed', false],
			['outputMonLevel', 0.6],
		])
		await device.pressPad(1, 5)
		assertGestures(hid, [
			[0, 2],
			[1, 5],
		])
	},
)

function buttonPath(hid, slot) {
	const index = hid.tree.children[hid.layout.physicalInterfaceIdx].children
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.type === 'PADBUTTON')[slot].index
	return [hid.layout.physicalInterfaceIdx, index]
}

function deskChange(device, hid, path, name, value) {
	hid.properties(path, { [name]: value })
	for (const report of encodeReports(encodePropertyChanged(path, name, value), REPORT_ID_IN)) device.onReport(report)
}

function uncertaintyLogs(logs) {
	return logs.filter(({ message }) => uncertain.test(message))
}

async function settled(device) {
	await device.queueOperation(async (guard) => guard())
}

test('a desk-side bank change during the hold releases the original physical button', deadline, async (t) => {
	const { device, hid, timers } = start(t)
	const gate = timers.holdNext(t)
	const first = device.pressPad(3, 2)
	await gate.entered
	deskChange(device, hid, hid.layout.singletonPath('gui'), 'selectedBank', V.int(6))
	const next = device.pressPad(3)
	gate.release()
	await Promise.all([first, next])
	assert.deepEqual(hid.events, [
		{ kind: 'press', slot: 3, bank: 2, owner: 1 },
		{ kind: 'release', slot: 3, bank: 6, owner: 1 },
		{ kind: 'press', slot: 3, bank: 6, owner: 2 },
		{ kind: 'release', slot: 3, bank: 6, owner: 2 },
	])
	for (const write of hid.writes.filter((write) => pressWrite(write) || releaseWrite(write))) {
		assert.deepEqual(write.path, buttonPath(hid, 3))
	}
	assert.deepEqual(
		hid.writes.filter(bankWrite).map(({ value }) => value),
		[2],
	)
	assert.equal(hid.active.size, 0)
})

for (const failed of ['press', 'release']) {
	for (const pressed of [false, true]) {
		test(
			`reconnect after uncertain ${failed} reconciles a synced ${pressed ? 'pressed' : 'released'} button without replay`,
			deadline,
			async (t) => {
				const { device, hid, deviceLogs } = start(t)
				if (failed === 'press') hid.failNext(pressWrite, 'after')
				hid.failNext(releaseWrite, 'before')
				await assert.rejects(device.pressPad(2, 4), uncertain)
				assert.equal(hid.writes.filter(pressWrite).length, 1)
				assert.equal(uncertaintyLogs(deviceLogs).length, 1, 'report one warning for the uncertain gesture')
				await device.onClosed(new Error('synthetic reconnect'))
				const replacement = new DelayedPadHid()
				replacement.properties(replacement.layout.singletonPath('gui'), { selectedBank: V.int(6) })
				replacement.properties(buttonPath(replacement, 2), { padButtonPressed: V.bool(pressed) })
				attach(device, replacement)
				await settled(device)
				assert.deepEqual(writes(replacement), pressed ? [['padButtonPressed', false]] : [])
				if (pressed) assert.deepEqual(replacement.writes[0].path, buttonPath(replacement, 2))
				assert.equal(device.padBank, 6)
				assert.equal(uncertaintyLogs(deviceLogs).length, 1, 'reconciliation must not repeat uncertainty reporting')
				attach(device, replacement)
				await settled(device)
				assert.equal(replacement.writes.length, Number(pressed), 'repeated sync must not repeat the recovered release')
				await device.stepPadBank(1)
				await device.pressPad(2)
				assert.deepEqual(
					replacement.events.filter(({ kind }) => kind === 'press').map(({ slot, bank }) => [slot, bank]),
					[[2, 7]],
				)
				assert.equal(replacement.writes.filter(pressWrite).length, 1, 'only the new requested trigger may be sent')
				assert.equal(uncertaintyLogs(deviceLogs).length, 1)
				assert.equal(replacement.active.size, 0)
			},
		)
	}
}

for (const phase of ['before', 'after']) {
	test(
		`full sync after release failure ${phase} application re-derives bank and physical button state`,
		deadline,
		async (t) => {
			const { device, hid, deviceLogs } = start(t)
			hid.failNext(releaseWrite, phase)
			await assert.rejects(device.pressPad(4, 1), uncertain)
			const writesBeforeSync = hid.writes.length
			hid.properties(hid.layout.singletonPath('gui'), { selectedBank: V.int(4) })
			attach(device, hid)
			await settled(device)
			assert.deepEqual(writes(hid).slice(writesBeforeSync), phase === 'before' ? [['padButtonPressed', false]] : [])
			assert.equal(hid.writes.filter(pressWrite).length, 1, 'sync recovery never triggers the old gesture')
			assert.equal(device.padBank, 4)
			assert.equal(uncertaintyLogs(deviceLogs).length, 1)
			attach(device, hid)
			await settled(device)
			assert.equal(hid.writes.length, writesBeforeSync + Number(phase === 'before'))
			await device.stepPadBank(-1)
			await device.pressPad(4)
			assert.deepEqual(
				hid.events.filter(({ kind }) => kind === 'press').map(({ slot, bank }) => [slot, bank]),
				[
					[4, 1],
					[4, 3],
				],
			)
			assert.equal(hid.active.size, 0)
			assert.equal(uncertaintyLogs(deviceLogs).length, 1)
		},
	)
}

test('failed reconciliation retries only release and reports the original uncertainty once', deadline, async (t) => {
	const { device, hid, deviceLogs } = start(t)
	hid.failNext(releaseWrite, 'before', 3)
	await assert.rejects(device.pressPad(1, 2), uncertain)
	attach(device, hid)
	await settled(device)
	await assert.rejects(device.pressPad(2, 4), /release|uncertain/i)
	assert.equal(hid.writes.filter(pressWrite).length, 1)
	assert.equal(hid.writes.filter(bankWrite).length, 1)
	assert.equal(hid.writes.filter(releaseWrite).length, 3)
	assert.equal(uncertaintyLogs(deviceLogs).length, 1)
	await device.pressPad(2, 4)
	assert.equal(hid.writes.filter(releaseWrite).length, 5)
	assert.deepEqual(
		hid.events.filter(({ kind }) => kind === 'press').map(({ slot, bank }) => [slot, bank]),
		[
			[1, 2],
			[2, 4],
		],
	)
	assert.equal(hid.active.size, 0)
	assert.equal(uncertaintyLogs(deviceLogs).length, 1)
})

test('stale reconciliation cannot clear pending state belonging to a newer full sync', deadline, async (t) => {
	const { device, hid, deviceLogs } = start(t)
	hid.failNext(releaseWrite)
	await assert.rejects(device.pressPad(0, 2), uncertain)
	await device.onClosed(new Error('first synthetic disconnect'))
	const middle = new DelayedPadHid()
	middle.properties(buttonPath(middle, 0), { padButtonPressed: V.bool(true) })
	const gate = middle.holdNext(t, releaseWrite, 'after')
	attach(device, middle)
	await gate.entered
	const cancelled = assert.rejects(device.pressPad(3, 4), connectionChanged)
	await device.onClosed(new Error('second synthetic disconnect'))
	const replacement = new DelayedPadHid()
	replacement.properties(replacement.layout.singletonPath('gui'), { selectedBank: V.int(6) })
	replacement.tree.children[replacement.layout.physicalInterfaceIdx].children.unshift(np('SPACER', {}))
	replacement.layout = Layout.fromFullSync(replacement.tree)
	replacement.properties(buttonPath(replacement, 0), { padButtonPressed: V.bool(true) })
	attach(device, replacement)
	assert.deepEqual(replacement.writes, [])
	gate.release()
	await cancelled
	await settled(device)
	assert.deepEqual(writes(middle), [['padButtonPressed', false]])
	assert.deepEqual(writes(replacement), [['padButtonPressed', false]])
	assert.deepEqual(
		replacement.writes[0].path,
		buttonPath(replacement, 0),
		'release uses the newly synced physical path',
	)
	assert.equal(replacement.writes[0].acknowledged, true)
	assert.equal(uncertaintyLogs(deviceLogs).length, 1, 'stale callbacks cannot introduce another warning')
	attach(device, replacement)
	await settled(device)
	assert.equal(replacement.writes.length, 1)
	await device.pressPad(0)
	assert.deepEqual(
		replacement.events.filter(({ kind }) => kind === 'press').map(({ slot, bank }) => [slot, bank]),
		[[0, 6]],
	)
	assert.equal(replacement.active.size, 0)
})

test('full sync clears uncertain bank selection before current and relative bank actions', deadline, async (t) => {
	const { device, hid } = start(t)
	hid.failNext(bankWrite, 'after')
	await assert.rejects(device.setPadBank(4), /bank|uncertain|synthetic HID/i)
	await assert.rejects(device.pressPad(0), /bank|uncertain/i)
	attach(device, hid)
	await device.stepPadBank(1)
	await device.pressPad(0)
	assert.deepEqual(
		hid.writes.filter(bankWrite).map(({ value }) => value),
		[4, 5],
	)
	assertGestures(hid, [[0, 5]])
})

test('a sync before an old press applies on the same handle requires a later settled snapshot', deadline, async (t) => {
	const { device, hid, deviceLogs } = start(t)
	const gate = hid.holdNext(t, pressWrite, 'before')
	const active = assert.rejects(device.pressPad(0, 2), /connection|layout|uncertain|release/i)
	await gate.entered
	attach(device, hid)
	gate.release()
	await active
	await settled(device)
	assert.equal(hid.active.size, 1, 'the delayed old write really reached the physical button after the snapshot')
	await assert.rejects(device.pressPad(0, 5), /sync|release|uncertain|unknown/i)
	await assert.rejects(device.stepPadBank(1), /sync|release|uncertain|unknown/i)
	assert.equal(hid.writes.filter(pressWrite).length, 1)
	assert.equal(hid.writes.filter(bankWrite).length, 1)
	assert.equal(uncertaintyLogs(deviceLogs).length, 1)
	attach(device, hid)
	await device.pressPad(0, 5)
	assertGestures(hid, [
		[0, 2],
		[0, 5],
	])
	assert.equal(uncertaintyLogs(deviceLogs).length, 1)
})

test('a synced unknown pending button stays blocked until a later known snapshot', deadline, async (t) => {
	const { device, hid, deviceLogs } = start(t)
	hid.failNext(releaseWrite)
	await assert.rejects(device.pressPad(0, 2), uncertain)
	hid.tree.getByPath(buttonPath(hid, 0)).properties.delete('padButtonPressed')
	attach(device, hid)
	await settled(device)
	await assert.rejects(device.pressPad(1, 4), /release|uncertain|unknown|button/i)
	await assert.rejects(device.setPadBank(4), /release|uncertain|unknown|button/i)
	assert.equal(hid.writes.filter(pressWrite).length, 1)
	assert.equal(hid.writes.filter(bankWrite).length, 1)
	await device.stepMonitorLevel(0.1)
	await device.panic()
	assert.equal(device.panicActive, true, 'unknown pad state cannot consume panic capacity')
	hid.properties(buttonPath(hid, 0), { padButtonPressed: V.bool(true) })
	attach(device, hid)
	await device.pressPad(1, 4)
	assertGestures(hid, [
		[0, 2],
		[1, 4],
	])
	assert.equal(uncertaintyLogs(deviceLogs).length, 1)
})

test('full-sync recovery retains panic priority ahead of normal pad work', deadline, async (t) => {
	const { device, hid, timers } = start(t)
	const gate = timers.holdNext(t)
	const active = assert.rejects(device.pressPad(0, 2), /connection|layout|uncertain|release/i)
	await gate.entered
	attach(device, hid)
	const next = device.pressPad(1, 5)
	const panic = device.panic()
	assert.deepEqual(writes(hid), [
		['selectedBank', 2],
		['padButtonPressed', true],
	])
	gate.release()
	await Promise.all([active, next, panic])
	const panicNames = [
		'channelOutputMute',
		'channelOutputMute',
		'outputMonMute',
		'outputBTMute',
		'disableAllHeadphoneOutputs',
	]
	assert.deepEqual(writes(hid).slice(2, 8), [...panicNames.map((name) => [name, true]), ['padButtonPressed', false]])
	assertGestures(hid, [
		[0, 2],
		[1, 5],
	])
	assert.equal(device.panicActive, true)
})

test('ready callbacks cannot bypass reconciliation before triggering another pad', deadline, async (t) => {
	const { device, hid } = start(t)
	hid.failNext(releaseWrite)
	await assert.rejects(device.pressPad(2, 4), uncertain)
	let gesture
	device.once('status', (state) => {
		assert.equal(state, 'ready')
		gesture = device.pressPad(2, 4)
	})
	attach(device, hid)
	assert.ok(gesture)
	await gesture
	assert.deepEqual(writes(hid), [
		['selectedBank', 4],
		['padButtonPressed', true],
		['padButtonPressed', false],
		['padButtonPressed', false],
		['padButtonPressed', true],
		['padButtonPressed', false],
	])
	assertGestures(hid, [
		[2, 4],
		[2, 4],
	])
})

for (const event of ['log', 'update']) {
	test(`a reentrant ${event} listener cannot let an old release clear newly synced recovery`, deadline, async (t) => {
		const { device, hid, deviceLogs } = start(t)
		const replacement = new DelayedPadHid()
		replacement.properties(replacement.layout.singletonPath('gui'), { selectedBank: V.int(6) })
		replacement.properties(buttonPath(replacement, 2), { padButtonPressed: V.bool(true) })
		let reconciled = false
		const listener = (level, message) => {
			if (event === 'log' ? !uncertain.test(message) : level !== 'pads' || !device.padRelease?.reported) return
			device.off(event, listener)
			device.connectionGeneration++
			attach(device, replacement)
			reconciled = true
		}
		device.on(event, listener)
		t.after(() => device.off(event, listener))
		hid.failNext(pressWrite, 'after')
		await assert.rejects(device.pressPad(2, 4), uncertain)
		assert.equal(reconciled, true)
		await settled(device)
		assert.deepEqual(writes(hid), [
			['selectedBank', 4],
			['padButtonPressed', true],
			['padButtonPressed', false],
		])
		assert.deepEqual(
			writes(replacement),
			[['padButtonPressed', false]],
			'newly synced pressed button must still be released once',
		)
		assert.deepEqual(replacement.writes[0].path, buttonPath(replacement, 2))
		assert.equal(replacement.writes[0].acknowledged, true)
		assert.equal(uncertaintyLogs(deviceLogs).length, 1)
		await device.pressPad(2)
		assert.deepEqual(
			replacement.events.filter(({ kind }) => kind === 'press').map(({ slot, bank }) => [slot, bank]),
			[[2, 6]],
		)
		assert.equal(replacement.active.size, 0)
	})
}

for (const value of [V.undefined(), V.unknown(0x7f, [1]), V.string('false'), V.int(0)]) {
	test(`a synced ${value.type} physical button value cannot certify an uncertain release`, deadline, async (t) => {
		const { device, hid, deviceLogs } = start(t)
		hid.failNext(releaseWrite)
		await assert.rejects(device.pressPad(0, 2), uncertain)
		hid.properties(buttonPath(hid, 0), { padButtonPressed: value })
		attach(device, hid)
		await settled(device)
		const before = hid.writes.length
		await assert.rejects(device.pressPad(1, 4), /release|uncertain|unknown|button/i)
		await assert.rejects(device.stepPadBank(1), /release|uncertain|unknown|button/i)
		assert.equal(hid.writes.length, before, 'unknown physical state must not release, switch bank, or trigger')
		hid.properties(buttonPath(hid, 0), { padButtonPressed: V.bool(true) })
		attach(device, hid)
		await device.pressPad(1, 4)
		assertGestures(hid, [
			[0, 2],
			[1, 4],
		])
		assert.equal(uncertaintyLogs(deviceLogs).length, 1)
	})
}

for (const value of [null, V.undefined(), V.unknown(0x7f, [1]), V.bool(false), V.string('0'), V.double(0)]) {
	test(
		`a synced ${value?.type ?? 'missing'} bank value blocks current and relative selection until reconciled`,
		deadline,
		async (t) => {
			const { device, hid } = start(t)
			const gui = hid.layout.singletonPath('gui')
			const corruptBank = () => {
				if (value === null) hid.tree.getByPath(gui).properties.delete('selectedBank')
				else hid.properties(gui, { selectedBank: value })
				attach(device, hid)
			}
			corruptBank()
			await settled(device)
			await assert.rejects(device.pressPad(0), /bank|uncertain/i)
			await assert.rejects(device.stepPadBank(1), /bank|uncertain/i)
			assert.deepEqual(hid.writes, [])
			hid.properties(gui, { selectedBank: V.int(3) })
			attach(device, hid)
			await device.stepPadBank(1)
			await device.pressPad(0)
			assertGestures(hid, [[0, 4]])
			if (value !== null) {
				corruptBank()
				await device.setPadBank(6)
				await device.pressPad(1)
				assertGestures(hid, [
					[0, 4],
					[1, 6],
				])
			}
		},
	)
}

test(
	'a desk bank change after selection rejects the pinned trigger before it can sound the wrong bank',
	deadline,
	async (t) => {
		const { device, hid } = start(t)
		let changed = false
		const listener = (area) => {
			if (area !== 'pads' || device.padBank !== 2) return
			device.off('update', listener)
			changed = true
			deskChange(device, hid, hid.layout.singletonPath('gui'), 'selectedBank', V.int(6))
		}
		device.on('update', listener)
		t.after(() => device.off('update', listener))
		await assert.rejects(device.pressPad(0, 2), /bank|changed/i)
		assert.equal(changed, true)
		assert.deepEqual(writes(hid), [['selectedBank', 2]])
		assert.equal(hid.writes.filter(pressWrite).length, 0)
		await device.pressPad(0)
		assertGestures(hid, [[0, 6]])
	},
)
