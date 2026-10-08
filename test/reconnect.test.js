import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { encodeChildMoved, encodeFullSync } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { HANDSHAKE_PAUSE_MS, modeNormalReport, sessionOpenReport } from '../src/protocol/session.js'
import { encodeReports, REPORT_ID_IN } from '../src/protocol/usb.js'
import { syntheticRoot } from './protocol/helpers.js'

// The real lifecycle and protocol run against an injected native HID backend.
// Even an accidental use of the default backend cannot access a physical desk.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node-hid') {
			const stub = `
				const forbidden = () => { throw new Error('real HID access forbidden in reconnect tests') }
				export default { setDriverType() {}, devices: forbidden, HIDAsync: { open: forbidden } }
			`
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
})
const { RodecasterDevice } = await import('../src/device.js')
const { HidTransport } = await import('../src/hid-transport.js')
hooks.deregister()

const RECONNECT_MS = 3000
const READY_TIMEOUT_MS = 8000
const identity = { serialNumber: 'synthetic-reconnect-serial', productId: 1 }
const flush = () => new Promise((resolve) => setImmediate(resolve))

class FakeTimers {
	now = 0
	pending = new Set()
	history = []

	setTimeout = (callback, delay) => {
		const timer = { callback, at: this.now + delay, delay }
		this.pending.add(timer)
		this.history.push(timer)
		return timer
	}

	clearTimeout = (timer) => {
		this.pending.delete(timer)
	}

	async advance(ms) {
		const target = this.now + ms
		for (;;) {
			const next = [...this.pending].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
			if (!next) break
			this.now = next.at
			this.pending.delete(next)
			next.callback()
			await flush()
		}
		this.now = target
		await flush()
	}

	get delays() {
		return [...this.pending].map((timer) => timer.at - this.now).sort((a, b) => a - b)
	}
}

class FakeHid extends EventEmitter {
	tree = syntheticRoot()
	writes = []
	closeCalls = 0
	beforeWrite = async () => {}
	beforeClose = async () => {}

	async getDeviceInfo() {
		return { ...identity }
	}

	async write(report) {
		this.writes.push(Buffer.from(report))
		await this.beforeWrite(report, this.writes.length)
	}

	async close() {
		this.closeCalls++
		await this.beforeClose()
	}

	frame(body) {
		for (const report of encodeReports(body, REPORT_ID_IN)) this.emit('data', report)
	}

	fullSync() {
		this.frame(encodeFullSync(this.tree))
	}

	invalidate() {
		this.frame(encodeChildMoved([], 0, 1))
	}
}

class FakeBackend {
	opened = []
	openCalls = []
	beforeOpen = async () => {}
	makeDevice = () => new FakeHid()

	devices = () => [
		{
			path: 'synthetic-reconnect-device',
			serialNumber: 'synthetic-reconnect-serial',
			product: 'Synthetic RODECaster',
			productId: 1,
			vendorId: 0x19f7,
			interface: 9,
		},
	]

	HIDAsync = {
		open: async (path) => {
			this.openCalls.push(path)
			const device = this.makeDevice()
			this.opened.push(device)
			await this.beforeOpen(device, this.openCalls.length)
			return device
		},
	}
}

function fixture(t) {
	const backend = new FakeBackend()
	const timers = new FakeTimers()
	const transport = new HidTransport(backend)
	const device = new RodecasterDevice({}, { transport, timers })
	const gates = []
	const statuses = []
	device.on('status', (state) => statuses.push(state))
	t.after(async () => {
		for (const gate of gates) gate.resolve()
		await flush()
		await device.stop()
		assert.equal(timers.pending.size, 0, 'cleanup leaves no lifecycle timers')
	})
	return {
		backend,
		timers,
		transport,
		device,
		statuses,
		gate() {
			const gate = Promise.withResolvers()
			gates.push(gate)
			return gate
		},
	}
}

async function begin(h) {
	h.device.start()
	await flush()
	assert.equal(h.backend.openCalls.length, 1)
	const hid = h.backend.opened[0]
	assert.deepEqual(hid.writes, [modeNormalReport()])
	return hid
}

async function ready(h) {
	const hid = await begin(h)
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	assert.deepEqual(hid.writes, [modeNormalReport(), sessionOpenReport()])
	hid.fullSync()
	await flush()
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	return hid
}

async function retryOnce(h, old) {
	assert.equal(old.closeCalls, 1, 'the failed native handle is closed exactly once')
	assert.equal(h.transport.isOpen, false)
	assert.equal(h.device.ready, false)
	assert.equal(h.device.tree, null)
	assert.deepEqual(h.timers.delays, [RECONNECT_MS], 'only one retry remains scheduled')
	await h.timers.advance(RECONNECT_MS - 1)
	assert.equal(h.backend.openCalls.length, 1)
	await h.timers.advance(1)
	assert.equal(h.backend.openCalls.length, 2, 'retry performs a new native open')
	const next = h.backend.opened[1]
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	assert.deepEqual(next.writes, [modeNormalReport(), sessionOpenReport()])
	next.fullSync()
	await flush()
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
	assert.equal(h.backend.openCalls.length, 2)
	assert.equal(next.closeCalls, 0)
	return next
}

for (const failedWrite of [1, 2]) {
	test(`handshake write ${failedWrite} rejection closes without a HID error and retries once`, async (t) => {
		const h = fixture(t)
		const old = new FakeHid()
		old.beforeWrite = async (_report, count) => {
			if (count === failedWrite) throw new Error('synthetic handshake rejection')
		}
		h.backend.makeDevice = () => (h.backend.opened.length === 0 ? old : new FakeHid())
		await begin(h)
		if (failedWrite === 2) await h.timers.advance(HANDSHAKE_PAUSE_MS)
		assert.equal(h.statuses.filter((state) => state === 'disconnected').length, 1)
		await retryOnce(h, old)
	})
}

test('the initial full-sync deadline includes the handshake pause', async (t) => {
	const h = fixture(t)
	const old = await begin(h)
	await h.timers.advance(READY_TIMEOUT_MS - 1)
	assert.equal(old.closeCalls, 0)
	assert.equal(h.device.ready, false)
	await h.timers.advance(1)
	await retryOnce(h, old)
})

for (const pendingWrite of [1, 2]) {
	test(`a hanging handshake write ${pendingWrite} is bounded by the initial deadline`, async (t) => {
		const h = fixture(t)
		const gate = h.gate()
		const old = new FakeHid()
		old.beforeWrite = async (_report, count) => {
			if (count === pendingWrite) await gate.promise
		}
		h.backend.makeDevice = () => (h.backend.opened.length === 0 ? old : new FakeHid())
		await begin(h)
		await h.timers.advance(READY_TIMEOUT_MS)
		const next = await retryOnce(h, old)
		const generation = h.device.connectionGeneration
		gate.reject(new Error('late handshake rejection'))
		await flush()
		assert.equal(h.device.connectionGeneration, generation)
		assert.equal(h.device.ready, true)
		assert.equal(next.closeCalls, 0)
		assert.equal(h.timers.pending.size, 0)
	})
}

test('an early full sync clears the deadline before the session-open write settles', async (t) => {
	const h = fixture(t)
	const gate = h.gate()
	const hid = await begin(h)
	hid.beforeWrite = async (_report, count) => {
		if (count === 2) {
			hid.fullSync()
			await gate.promise
		}
	}
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	gate.resolve()
	await flush()
	assert.equal(h.timers.pending.size, 0, 'late handshake completion must not rearm the deadline')
	await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
	assert.equal(h.backend.openCalls.length, 1)
	assert.equal(hid.closeCalls, 0)
})

test('rejected resync writes immediately close and retry without a HID error', async (t) => {
	const h = fixture(t)
	const old = await ready(h)
	old.beforeWrite = async () => {
		throw new Error('synthetic resync rejection')
	}
	old.invalidate()
	await flush()
	assert.deepEqual(old.writes.at(-1), sessionOpenReport())
	await retryOnce(h, old)
})

for (const hanging of [false, true]) {
	test(`${hanging ? 'hanging' : 'silent'} resync recovers within its deadline`, async (t) => {
		const h = fixture(t)
		const old = await ready(h)
		const gate = h.gate()
		if (hanging) old.beforeWrite = () => gate.promise
		old.invalidate()
		await flush()
		assert.equal(h.device.ready, false)
		assert.equal(h.device.tree, null)
		assert.deepEqual(h.timers.delays, [READY_TIMEOUT_MS])
		await h.timers.advance(READY_TIMEOUT_MS - 1)
		assert.equal(old.closeCalls, 0)
		await h.timers.advance(1)
		const next = await retryOnce(h, old)
		if (hanging) gate.reject(new Error('late resync rejection'))
		else gate.resolve()
		await flush()
		assert.equal(h.device.ready, true)
		assert.equal(next.closeCalls, 0)
		assert.equal(h.timers.pending.size, 0)
	})
}

test('repeated structural changes do not extend the resync deadline', async (t) => {
	const h = fixture(t)
	const old = await ready(h)
	old.invalidate()
	await flush()
	await h.timers.advance(READY_TIMEOUT_MS - 1)
	old.invalidate()
	old.invalidate()
	await flush()
	assert.deepEqual(h.timers.delays, [1])
	await h.timers.advance(1)
	await retryOnce(h, old)
})

test('successful resync cancels recovery and ignores the cancelled deadline callback', async (t) => {
	const h = fixture(t)
	const hid = await ready(h)
	hid.invalidate()
	await flush()
	const [deadline] = h.timers.pending
	await h.timers.advance(READY_TIMEOUT_MS - 1)
	hid.fullSync()
	await flush()
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	deadline.callback()
	await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
	assert.equal(hid.closeCalls, 0)
	assert.equal(h.backend.openCalls.length, 1)
	assert.equal(h.device.ready, true)
})

for (const phase of ['open', 'first write', 'pause', 'second write', 'initial sync', 'resync', 'retry']) {
	test(`stop during ${phase} clears timers and prevents all late work from reopening`, async (t) => {
		const h = fixture(t)
		const gate = h.gate()
		const old = new FakeHid()
		h.backend.makeDevice = () => old
		if (phase === 'open') h.backend.beforeOpen = () => gate.promise
		if (phase === 'first write' || phase === 'second write') {
			old.beforeWrite = async (_report, count) => {
				if (count === (phase === 'first write' ? 1 : 2)) await gate.promise
			}
		}
		h.device.start()
		await flush()
		if (['second write', 'initial sync', 'resync', 'retry'].includes(phase)) {
			await h.timers.advance(HANDSHAKE_PAUSE_MS)
		}
		if (phase === 'resync') {
			old.fullSync()
			old.beforeWrite = () => gate.promise
			old.invalidate()
			await flush()
		}
		if (phase === 'retry') {
			old.emit('error', new Error('synthetic disconnect'))
			await flush()
		}
		const saved = [...h.timers.history]
		const writes = old.writes.length
		const stopping = h.device.stop()
		await flush()
		assert.equal(h.timers.pending.size, 0)
		gate.resolve()
		await stopping
		await h.device.stop()
		for (const timer of saved) timer.callback()
		old.fullSync()
		await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
		assert.equal(h.backend.openCalls.length, 1)
		assert.equal(old.closeCalls, 1)
		assert.equal(old.writes.length, writes)
		assert.equal(h.transport.isOpen, false)
		assert.equal(h.device.running, false)
		assert.equal(h.device.ready, false)
		assert.equal(h.device.tree, null)
		assert.equal(h.timers.pending.size, 0)
	})
}

test('restart waits for stop to finish closing and old timer callbacks cannot cancel new recovery', async (t) => {
	const h = fixture(t)
	const old = await begin(h)
	const saved = [...h.timers.history]
	const gate = h.gate()
	old.beforeClose = () => gate.promise
	const stopping = h.device.stop()
	await flush()
	h.device.start()
	h.device.start()
	await flush()
	assert.equal(h.backend.openCalls.length, 1, 'new open waits for the old handle to close')
	gate.resolve()
	await stopping
	await flush()
	assert.equal(h.backend.openCalls.length, 2)
	const current = h.backend.opened[1]
	const generation = h.device.connectionGeneration
	const pending = [...h.timers.pending]
	for (const timer of saved) timer.callback()
	await flush()
	assert.equal(h.device.connectionGeneration, generation)
	assert.deepEqual([...h.timers.pending], pending)
	assert.equal(current.closeCalls, 0)
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	current.fullSync()
	await flush()
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	assert.equal(old.closeCalls, 1)
})

test('repeated HID errors close once and stale native callbacks cannot affect a replacement', async (t) => {
	const h = fixture(t)
	const old = await ready(h)
	const oldError = old.listeners('error')[0]
	const oldData = old.listeners('data')[0]
	const oldClose = h.transport.listeners('close')[0]
	oldError(new Error('synthetic disconnect'))
	oldError(new Error('duplicate synthetic disconnect'))
	await flush()
	assert.equal(h.statuses.filter((state) => state === 'disconnected').length, 1)
	const next = await retryOnce(h, old)
	const tree = h.device.tree
	const generation = h.device.connectionGeneration
	const statuses = [...h.statuses]
	oldError(new Error('late old error'))
	oldClose(new Error('late old close'))
	for (const report of encodeReports(encodeChildMoved([], 0, 1), REPORT_ID_IN)) oldData(report)
	for (const report of encodeReports(encodeFullSync(syntheticRoot()), REPORT_ID_IN)) oldData(report)
	await flush()
	assert.equal(h.device.connectionGeneration, generation)
	assert.equal(h.device.tree, tree)
	assert.equal(h.device.ready, true)
	assert.deepEqual(h.statuses, statuses)
	assert.equal(h.timers.pending.size, 0)
	assert.equal(next.closeCalls, 0)
	assert.equal(old.closeCalls, 1)
})

test('a late retry callback cannot create a second handshake on the current handle', async (t) => {
	const h = fixture(t)
	const old = await ready(h)
	old.emit('error', new Error('synthetic disconnect'))
	await flush()
	const [retry] = h.timers.pending
	await h.timers.advance(RECONNECT_MS)
	const next = h.backend.opened[1]
	const generation = h.device.connectionGeneration
	const pending = [...h.timers.pending]
	retry.callback()
	await flush()
	assert.equal(h.backend.openCalls.length, 2)
	assert.equal(h.device.connectionGeneration, generation)
	assert.deepEqual([...h.timers.pending], pending)
	assert.deepEqual(next.writes, [modeNormalReport()])
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	next.fullSync()
	await flush()
	assert.equal(h.device.ready, true)
})

for (const outcome of ['resolve', 'reject']) {
	test(`a pending old handshake ${outcome} after stop/restart cannot alter the new connection`, async (t) => {
		const h = fixture(t)
		const gate = h.gate()
		const old = new FakeHid()
		old.beforeWrite = () => gate.promise
		h.backend.makeDevice = () => (h.backend.opened.length === 0 ? old : new FakeHid())
		await begin(h)
		await h.device.stop()
		h.device.start()
		await flush()
		const next = h.backend.opened[1]
		await h.timers.advance(HANDSHAKE_PAUSE_MS)
		next.fullSync()
		await flush()
		const tree = h.device.tree
		const generation = h.device.connectionGeneration
		gate[outcome](new Error('late old handshake failure'))
		await flush()
		assert.equal(h.device.tree, tree)
		assert.equal(h.device.connectionGeneration, generation)
		assert.equal(h.device.ready, true)
		assert.equal(h.timers.pending.size, 0)
		assert.equal(next.closeCalls, 0)
		assert.equal(old.writes.length, 1)
	})
}

test('late native open completion is closed and cannot replace a restarted connection', async (t) => {
	const h = fixture(t)
	const gate = h.gate()
	h.backend.beforeOpen = async (_device, count) => {
		if (count === 1) await gate.promise
	}
	h.device.start()
	await flush()
	const old = h.backend.opened[0]
	const stopping = h.device.stop()
	h.device.start()
	gate.resolve()
	await stopping
	await flush()
	assert.equal(h.backend.openCalls.length, 2)
	assert.equal(old.closeCalls, 1)
	assert.equal(old.writes.length, 0)
	const next = h.backend.opened[1]
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	next.fullSync()
	await flush()
	assert.equal(h.transport.device, next)
	assert.equal(h.device.ready, true)
	assert.equal(next.closeCalls, 0)
	assert.equal(h.timers.pending.size, 0)
})

test('transport closes once during pending native close and ignores old completion after reopen', async (t) => {
	const backend = new FakeBackend()
	const transport = new HidTransport(backend)
	await transport.open()
	const old = backend.opened[0]
	const gate = Promise.withResolvers()
	t.after(async () => {
		gate.resolve()
		await transport.close()
	})
	old.beforeClose = () => gate.promise
	const firstClose = transport.close()
	const secondClose = transport.close()
	assert.equal(transport.isOpen, false)
	await flush()
	assert.equal(old.closeCalls, 1)
	await transport.open()
	const next = backend.opened[1]
	gate.resolve()
	await Promise.all([firstClose, secondClose])
	assert.equal(transport.device, next)
	assert.equal(next.closeCalls, 0)
	await transport.close()
	assert.equal(next.closeCalls, 1)
})

test('concurrent native open calls share a handle and a late cancelled open cannot replace it', async (t) => {
	const backend = new FakeBackend()
	const transport = new HidTransport(backend)
	const gate = Promise.withResolvers()
	backend.beforeOpen = async (_device, count) => {
		if (count === 1) await gate.promise
	}
	t.after(async () => {
		gate.resolve()
		await transport.close()
	})
	const first = transport.open()
	const concurrent = transport.open()
	assert.equal(backend.openCalls.length, 1)
	const cancelled = assert.rejects(first, /cancelled/)
	const concurrentlyCancelled = assert.rejects(concurrent, /cancelled/)
	await transport.close()
	await transport.open()
	const next = backend.opened[1]
	assert.equal(transport.device, next)
	gate.resolve()
	await Promise.all([cancelled, concurrentlyCancelled])
	assert.equal(backend.opened[0].closeCalls, 1)
	assert.equal(transport.device, next)
	assert.equal(next.closeCalls, 0)
})

test('a close listener can immediately reopen without old error cleanup closing its new handle', async (t) => {
	const backend = new FakeBackend()
	const transport = new HidTransport(backend)
	t.after(() => transport.close())
	await transport.open()
	const old = backend.opened[0]
	let reopened
	let closeEvents = 0
	transport.on('close', () => {
		closeEvents++
		assert.equal(transport.isOpen, false, 'the failing handle is detached before close listeners run')
		reopened = transport.open()
	})
	old.emit('error', new Error('synthetic native error'))
	await reopened
	await flush()
	const next = backend.opened[1]
	assert.equal(transport.device, next)
	assert.equal(old.closeCalls, 1)
	assert.equal(next.closeCalls, 0)
	old.emit('error', new Error('late repeated native error'))
	await flush()
	assert.equal(closeEvents, 1)
	assert.equal(backend.openCalls.length, 2)
	assert.equal(transport.device, next)
	assert.equal(next.closeCalls, 0)
})

function repairHid() {
	const hid = new FakeHid()
	for (const node of hid.tree.children.filter((node) => node.type === 'MIX')) {
		node.properties.set('mixLink', V.bool(false))
		node.properties.set('mixLinkRequest', V.string(''))
	}
	return hid
}

test('a stale successful repair cannot retire pending repair or update the new full sync', async (t) => {
	const h = fixture(t)
	const gate = h.gate()
	const old = repairHid()
	old.beforeWrite = async (_report, count) => {
		if (count > 2) await gate.promise
	}
	const next = repairHid()
	next.beforeWrite = async (_report, count) => {
		if (count > 2) throw new Error('synthetic replacement repair failure')
	}
	h.backend.makeDevice = () => (h.backend.opened.length === 0 ? old : next)
	const pending = [{ source: 0, mixes: [0, 1], identity }]
	h.device.setPendingRepair(pending)
	await ready(h)
	assert.equal(old.writes.length, 3, 'the first repair write is pending')
	old.emit('error', new Error('synthetic disconnect'))
	await flush()
	await retryOnce(h, old)
	const tree = h.device.tree
	const newWrites = next.writes.length
	assert.deepEqual(h.device.pendingRepair, pending)
	gate.resolve()
	await flush()
	assert.equal(h.device.tree, tree)
	assert.deepEqual(h.device.pendingRepair, pending)
	assert.equal(old.writes.length, 3, 'the stale repair stops after its first awaited write')
	assert.equal(next.writes.length, newWrites, 'the old repair does not continue on the replacement')
	assert.equal(h.device.propBool(h.device.layout.mixCellPath(0, 0), 'mixLink'), false)
})

test('a stale borrowed-send release cannot delete current borrowing or update the replacement tree', async (t) => {
	const h = fixture(t)
	h.backend.makeDevice = repairHid
	const old = await ready(h)
	const borrowed = { source: 0, mixes: [0, 1], anchor: 0.5, identity }
	h.device.borrowed.set(0, borrowed)
	const gate = h.gate()
	old.beforeWrite = () => gate.promise
	const release = h.device.releaseStrip(0)
	const rejected = assert.rejects(release, /desk connection or layout changed/)
	await flush()
	assert.equal(old.writes.length, 3)
	old.emit('error', new Error('synthetic disconnect'))
	await flush()
	const next = await retryOnce(h, old)
	const tree = h.device.tree
	gate.resolve()
	await rejected
	assert.equal(h.device.borrowed.get(0), borrowed)
	assert.equal(h.device.tree, tree)
	assert.equal(next.writes.length, 2)
	assert.equal(h.device.propBool(h.device.layout.mixCellPath(0, 0), 'mixLink'), false)
})

test('the initial deadline also recovers a pending native open without adopting its late handle', async (t) => {
	const h = fixture(t)
	const gate = h.gate()
	h.backend.beforeOpen = async (_device, count) => {
		if (count === 1) await gate.promise
	}
	h.device.start()
	await flush()
	const old = h.backend.opened[0]
	await h.timers.advance(READY_TIMEOUT_MS)
	assert.equal(h.transport.isOpen, false)
	assert.deepEqual(h.timers.delays, [RECONNECT_MS])
	await h.timers.advance(RECONNECT_MS)
	assert.equal(h.backend.openCalls.length, 2)
	const next = h.backend.opened[1]
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	next.fullSync()
	await flush()
	const generation = h.device.connectionGeneration
	gate.resolve()
	await flush()
	assert.equal(old.closeCalls, 1)
	assert.equal(old.writes.length, 0)
	assert.equal(h.transport.device, next)
	assert.equal(h.device.connectionGeneration, generation)
	assert.equal(h.device.ready, true)
	assert.equal(next.closeCalls, 0)
	assert.equal(h.timers.pending.size, 0)
})

test('an early full sync cannot hide a later handshake write failure', async (t) => {
	const h = fixture(t)
	const old = await begin(h)
	old.beforeWrite = async () => {
		old.fullSync()
		throw new Error('handshake failed after early full sync')
	}
	await h.timers.advance(HANDSHAKE_PAUSE_MS)
	await retryOnce(h, old)
})

test('resync full sync before its write settles clears the deadline permanently', async (t) => {
	const h = fixture(t)
	const hid = await ready(h)
	const gate = h.gate()
	hid.beforeWrite = async () => {
		hid.fullSync()
		await gate.promise
	}
	hid.invalidate()
	await flush()
	assert.equal(h.device.ready, true)
	assert.equal(h.timers.pending.size, 0)
	gate.resolve()
	await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
	assert.equal(h.backend.openCalls.length, 1)
	assert.equal(hid.closeCalls, 0)
	assert.equal(h.timers.pending.size, 0)
})

for (const resyncAgain of [false, true]) {
	test(`a superseded resync rejection preserves ${resyncAgain ? 'new recovery' : 'successful full sync'}`, async (t) => {
		const h = fixture(t)
		const hid = await ready(h)
		const gate = h.gate()
		hid.beforeWrite = async (_report, count) => {
			if (count === 3) await gate.promise
		}
		hid.invalidate()
		await flush()
		hid.fullSync()
		await flush()
		assert.equal(h.device.ready, true)
		if (resyncAgain) {
			hid.invalidate()
			await flush()
			assert.equal(h.device.ready, false)
			assert.deepEqual(h.timers.delays, [READY_TIMEOUT_MS])
		}
		const pending = [...h.timers.pending]
		const generation = h.device.connectionGeneration
		gate.reject(new Error('superseded resync write rejected'))
		await flush()
		assert.equal(h.device.connectionGeneration, generation)
		assert.equal(h.device.ready, !resyncAgain)
		assert.deepEqual([...h.timers.pending], pending)
		assert.equal(hid.closeCalls, 0)
		if (resyncAgain) hid.fullSync()
		await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
		assert.equal(h.backend.openCalls.length, 1)
		assert.equal(h.device.ready, true)
		assert.equal(h.timers.pending.size, 0)
	})
}

test('stop supersedes a restart requested while native close is pending', async (t) => {
	const h = fixture(t)
	const old = await ready(h)
	const gate = h.gate()
	old.beforeClose = () => gate.promise
	const first = h.device.stop()
	h.device.start()
	const second = h.device.stop()
	gate.resolve()
	await Promise.all([first, second])
	await h.timers.advance(READY_TIMEOUT_MS + RECONNECT_MS)
	assert.equal(h.backend.openCalls.length, 1)
	assert.equal(old.closeCalls, 1)
	assert.equal(h.device.running, false)
	assert.equal(h.device.ready, false)
	assert.equal(h.timers.pending.size, 0)
	h.device.start()
	await flush()
	assert.equal(h.backend.openCalls.length, 2)
})
