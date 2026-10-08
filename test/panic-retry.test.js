import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { decodeChangeFrame, encodeFullSync } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { ProtocolSession } from '../src/protocol/session.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { syntheticRoot } from './protocol/helpers.js'

// Exercise real device/protocol writes without allowing USB discovery or access.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'node-hid') {
			const stub = `
				const forbidden = () => { throw new Error('real HID access forbidden in panic tests') }
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

const allAudible = () => ({ strips: [false, false, false], monMute: false, btMute: false, phonesOff: false })
const allMuted = () => ({ strips: [true, true, true], monMute: true, btMute: true, phonesOff: true })
const failure = /synthetic HID write failure/

function targets(layout) {
	return [
		...[0, 1, 2].map((i) => ({ path: layout.channelPath(i), name: 'channelOutputMute' })),
		{ path: layout.singletonPath('output'), name: 'outputMonMute' },
		{ path: layout.singletonPath('output'), name: 'outputBTMute' },
		{ path: layout.singletonPath('system'), name: 'disableAllHeadphoneOutputs' },
	]
}

function values(state) {
	return [...state.strips, state.monMute, state.btMute, state.phonesOff]
}

function stateOf(tree, layout) {
	const state = targets(layout).map(({ path, name }) => tree.getByPath(path).properties.get(name).value)
	return { strips: state.slice(0, 3), monMute: state[3], btMute: state[4], phonesOff: state[5] }
}

function snapshotState(device) {
	const { strips, monMute, btMute, phonesOff } = device.panicSnapshot
	return { strips, monMute, btMute, phonesOff }
}

class FakeHid extends EventEmitter {
	constructor(original = allAudible()) {
		super()
		this.tree = syntheticRoot()
		this.layout = Layout.fromFullSync(this.tree)
		for (let i = 0; i < 3; i++) {
			this.tree.getByPath(this.layout.channelPath(i)).properties.set('channelInputSource', V.int(i))
		}
		targets(this.layout).forEach(({ path, name }, index) => {
			this.tree.getByPath(path).properties.set(name, V.bool(values(original)[index]))
		})
		this.reassembler = new Reassembler()
		this.writes = []
		this.beforeWrite = async () => {}
		this.afterWrite = async () => {}
	}

	get state() {
		return stateOf(this.tree, this.layout)
	}

	async write(report) {
		for (const body of this.reassembler.push(report)) {
			const change = decodeChangeFrame(body)
			assert.equal(change?.type, 'propertyChanged')
			assert.equal(change.value.type, 'bool')
			const request = { path: change.path, name: change.name, value: change.value.value }
			this.writes.push(request)
			await this.beforeWrite(request)
			this.tree.getByPath(change.path).properties.set(change.name, change.value)
			await this.afterWrite(request)
		}
	}

	async close() {}
}

function start(t, hid = new FakeHid()) {
	const device = new RodecasterDevice()
	device.transport.device = hid
	device.transport.info = {
		path: 'synthetic-panic-device',
		serialNumber: 'synthetic-panic-serial',
		product: 'Synthetic RODECaster',
		productId: 1,
	}
	for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
	assert.equal(device.ready, true)
	const updates = []
	device.on('update', (area) => updates.push({ area, active: device.panicActive }))
	t.after(() => {
		device.clearTimers()
		device.transport.device = null
	})
	return { device, hid, updates }
}

function requests(hid, value, from = 0, to = 6) {
	return targets(hid.layout)
		.slice(from, to)
		.map((target) => ({ ...target, value }))
}

function failAt(hid, boundary, afterApply) {
	const target = targets(hid.layout)[boundary]
	const reject = async (request) => {
		if (request.name === target.name && request.path.join('/') === target.path.join('/')) {
			throw new Error('synthetic HID write failure')
		}
	}
	hid[afterApply ? 'afterWrite' : 'beforeWrite'] = reject
	return () => {
		hid.beforeWrite = async () => {}
		hid.afterWrite = async () => {}
	}
}

function assertPending(device, snapshot, original = allAudible()) {
	assert.equal(device.panicSnapshot, snapshot, 'retain the same original snapshot until restoration completes')
	assert.deepEqual(snapshotState(device), original)
	assert.equal(device.panicActive, true, 'an incomplete operation must remain visibly active')
}

function assertRestored(device, hid, original = allAudible()) {
	assert.deepEqual(hid.state, original, 'the physical fake must return to its original state')
	assert.deepEqual(stateOf(device.tree, device.layout), original, 'the acknowledged local state must also match')
	assert.equal(device.panicSnapshot, null)
	assert.equal(device.panicActive, false)
}

for (const afterApply of [false, true]) {
	const timing = afterApply ? 'after applying the write' : 'before applying the write'
	for (let boundary = 0; boundary < 6; boundary++) {
		test(`panic retries only pending writes after failure at mute ${boundary + 1} ${timing}`, async (t) => {
			const { device, hid, updates } = start(t)
			const recover = failAt(hid, boundary, afterApply)
			await assert.rejects(device.panic(), failure)
			const snapshot = device.panicSnapshot
			assertPending(device, snapshot)
			assert.ok(
				updates.some(({ active }) => active),
				'failed activation must refresh panic feedback',
			)
			await assert.rejects(device.panic(), failure)
			assertPending(device, snapshot)
			assert.deepEqual(hid.writes, [
				...requests(hid, true, 0, boundary + 1),
				...requests(hid, true, boundary, boundary + 1),
			])
			recover()
			await device.panic()
			assertPending(device, snapshot)
			assert.deepEqual(hid.state, allMuted())
			assert.deepEqual(hid.writes, [
				...requests(hid, true, 0, boundary + 1),
				...requests(hid, true, boundary, boundary + 1),
				...requests(hid, true, boundary),
			])
			const mutedWrites = hid.writes.length
			await device.panic()
			assert.equal(hid.writes.length, mutedWrites, 'successful activation is idempotent')
			await device.releasePanic()
			assertRestored(device, hid)
			assert.deepEqual(hid.writes.slice(mutedWrites), requests(hid, false))
		})

		test(`release retries only pending writes after failure at restore ${boundary + 1} ${timing}`, async (t) => {
			const { device, hid, updates } = start(t)
			await device.panic()
			const snapshot = device.panicSnapshot
			const recover = failAt(hid, boundary, afterApply)
			updates.length = 0
			await assert.rejects(device.releasePanic(), failure)
			assertPending(device, snapshot)
			assert.ok(
				updates.some(({ active }) => active),
				'failed restoration must refresh panic feedback',
			)
			await assert.rejects(device.releasePanic(), failure)
			assertPending(device, snapshot)
			assert.deepEqual(hid.writes.slice(6), [
				...requests(hid, false, 0, boundary + 1),
				...requests(hid, false, boundary, boundary + 1),
			])
			recover()
			await device.releasePanic()
			assertRestored(device, hid)
			assert.deepEqual(hid.writes.slice(6), [
				...requests(hid, false, 0, boundary + 1),
				...requests(hid, false, boundary, boundary + 1),
				...requests(hid, false, boundary),
			])
			const restoredWrites = hid.writes.length
			await device.releasePanic()
			assert.equal(hid.writes.length, restoredWrites, 'successful release is idempotent')
			assert.equal(updates.at(-1).active, false)
		})

		test(`release after partial activation restores only attempted mute writes through ${boundary + 1} ${timing}`, async (t) => {
			const { device, hid } = start(t)
			const recover = failAt(hid, boundary, afterApply)
			await assert.rejects(device.panic(), failure)
			const snapshot = device.panicSnapshot
			assertPending(device, snapshot)
			recover()
			await device.releasePanic()
			assertRestored(device, hid)
			assert.deepEqual(hid.writes, [...requests(hid, true, 0, boundary + 1), ...requests(hid, false, 0, boundary + 1)])
		})
	}
}

test('all combinations of initially muted outputs stay muted without unnecessary writes', async (t) => {
	for (let mask = 0; mask < 64; mask++) {
		await t.test(`initial mute mask ${mask}`, async (t) => {
			const muted = Array.from({ length: 6 }, (_, index) => !!(mask & (1 << index)))
			const original = { strips: muted.slice(0, 3), monMute: muted[3], btMute: muted[4], phonesOff: muted[5] }
			const { device, hid } = start(t, new FakeHid(original))
			await device.releasePanic()
			assert.deepEqual(hid.writes, [])
			await device.panic()
			const snapshot = device.panicSnapshot
			assertPending(device, snapshot, original)
			assert.deepEqual(hid.state, allMuted())
			await device.panic()
			await device.releasePanic()
			await device.releasePanic()
			assertRestored(device, hid, original)
			const changed = targets(hid.layout).filter((_, index) => !muted[index])
			assert.deepEqual(hid.writes, [
				...changed.map((target) => ({ ...target, value: true })),
				...changed.map((target) => ({ ...target, value: false })),
			])
		})
	}
})

test('unassigned strips are never muted or restored', async (t) => {
	const hid = new FakeHid()
	hid.tree.getByPath(hid.layout.channelPath(1)).properties.set('channelInputSource', V.int(-1))
	const { device } = start(t, hid)
	await device.panic()
	await device.releasePanic()
	assertRestored(device, hid)
	assert.deepEqual(hid.writes, [
		...requests(hid, true).filter((_, index) => index !== 1),
		...requests(hid, false).filter((_, index) => index !== 1),
	])
})

test('reactivation after a failed release remutes pending outputs without recapturing the snapshot', async (t) => {
	const original = { strips: [false, true, false], monMute: false, btMute: true, phonesOff: false }
	const { device, hid } = start(t, new FakeHid(original))
	await device.panic()
	const snapshot = device.panicSnapshot
	const recover = failAt(hid, 3, true)
	await assert.rejects(device.releasePanic(), failure)
	assertPending(device, snapshot, original)
	recover()
	const offset = hid.writes.length
	await device.panic()
	assertPending(device, snapshot, original)
	assert.deepEqual(hid.state, allMuted())
	assert.deepEqual(hid.writes.slice(offset), [...requests(hid, true, 0, 1), ...requests(hid, true, 2, 4)])
	await device.releasePanic()
	assertRestored(device, hid, original)
})

test('overlapping activation and release requests run in FIFO order', { timeout: 5000 }, async (t) => {
	const { device, hid } = start(t)
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	hid.beforeWrite = async () => {
		entered.resolve()
		await resume.promise
	}
	const first = device.panic()
	await entered.promise
	const snapshot = device.panicSnapshot
	const second = device.panic()
	const release = device.releasePanic()
	const releaseAgain = device.releasePanic()
	await new Promise((resolve) => setImmediate(resolve))
	assertPending(device, snapshot)
	assert.deepEqual(hid.writes, requests(hid, true, 0, 1), 'queued calls must not start writes')
	resume.resolve()
	await Promise.all([first, second, release, releaseAgain])
	assertRestored(device, hid)
	assert.deepEqual(hid.writes, [...requests(hid, true), ...requests(hid, false)])
})

test(
	'an overlapping release repairs a rejected activation and the queue remains usable',
	{ timeout: 5000 },
	async (t) => {
		const { device, hid } = start(t)
		const entered = Promise.withResolvers()
		const resume = Promise.withResolvers()
		t.after(() => resume.resolve())
		hid.afterWrite = async ({ value }) => {
			if (!value) return
			entered.resolve()
			await resume.promise
			throw new Error('synthetic HID write failure')
		}
		const activation = assert.rejects(device.panic(), failure)
		await entered.promise
		const release = device.releasePanic()
		await new Promise((resolve) => setImmediate(resolve))
		assert.deepEqual(hid.writes, requests(hid, true, 0, 1))
		resume.resolve()
		await activation
		await release
		assertRestored(device, hid)
		assert.deepEqual(hid.writes, [...requests(hid, true, 0, 1), ...requests(hid, false, 0, 1)])
		hid.afterWrite = async () => {}
		await device.panic()
		await device.releasePanic()
		assertRestored(device, hid)
	},
)

test(
	'activation queued during restoration captures only the completed restored state',
	{ timeout: 5000 },
	async (t) => {
		const { device, hid } = start(t)
		await device.panic()
		const originalSnapshot = device.panicSnapshot
		const entered = Promise.withResolvers()
		const resume = Promise.withResolvers()
		t.after(() => resume.resolve())
		hid.beforeWrite = async ({ value }) => {
			if (value) return
			entered.resolve()
			await resume.promise
		}
		const release = device.releasePanic()
		await entered.promise
		const activation = device.panic()
		await new Promise((resolve) => setImmediate(resolve))
		assertPending(device, originalSnapshot)
		assert.deepEqual(hid.writes.slice(6), requests(hid, false, 0, 1))
		resume.resolve()
		await Promise.all([release, activation])
		assert.notEqual(device.panicSnapshot, originalSnapshot)
		assert.deepEqual(snapshotState(device), allAudible())
		assert.deepEqual(hid.writes, [...requests(hid, true), ...requests(hid, false), ...requests(hid, true)])
		await device.releasePanic()
		assertRestored(device, hid)
	},
)

const identityChanges = {
	'not ready': (device) => {
		device.ready = false
	},
	'closed HID handle': (device) => {
		device.transport.device = null
	},
	'replaced HID handle': (device) => {
		device.transport.device = new FakeHid()
	},
	'replaced transport with the same handle': (device) => {
		const replacement = new HidTransport()
		replacement.device = device.transport.device
		replacement.info = device.transport.info
		device.transport = replacement
	},
	'replaced session with the same tree': (device) => {
		device.session = Object.assign(new ProtocolSession(), {
			tree: device.tree,
			layout: device.layout,
			capabilities: device.capabilities,
		})
	},
	'replaced tree': (device) => {
		device.session.tree = new FakeHid().tree
	},
	'replaced layout': (device) => {
		device.session.layout = Layout.fromFullSync(device.tree)
	},
	'changed serial': (device) => {
		device.transport.info.serialNumber = 'different-synthetic-serial'
	},
	'changed device path': (device) => {
		device.transport.info.path = 'different-synthetic-path'
	},
	'changed product': (device) => {
		device.transport.info.productId++
	},
	'lost connection metadata': (device) => {
		device.transport.info = null
	},
	'reassigned strip source': (device) => {
		device.tree.getByPath(device.layout.channelPath(0)).properties.set('channelInputSource', V.int(1))
	},
	'closed connection even if its old references reappear': (device) => {
		const { tree, layout, capabilities } = device.session
		device.onClosed()
		Object.assign(device.session, { tree, layout, capabilities })
		device.ready = true
	},
}

for (const [description, changeIdentity] of Object.entries(identityChanges)) {
	test(`pending panic never replays after ${description}`, async (t) => {
		const { device, hid } = start(t)
		const recover = failAt(hid, 1, true)
		await assert.rejects(device.panic(), failure)
		const snapshot = device.panicSnapshot
		recover()
		const writes = hid.writes.slice()
		changeIdentity(device)
		await assert.rejects(device.panic(), /connect|identit|chang|original|source|session|layout/i)
		assertPending(device, snapshot)
		await assert.rejects(device.releasePanic(), /connect|identit|chang|original|source|session|layout/i)
		assertPending(device, snapshot)
		assert.deepEqual(hid.writes, writes)
		if (device.transport.device && device.transport.device !== hid) {
			assert.deepEqual(device.transport.device.writes, [], 'a replacement device must receive no recovery writes')
		}
	})
}

test('a new full sync never inherits a previous panic restore', async (t) => {
	const { device, hid } = start(t)
	await device.panic()
	const snapshot = device.panicSnapshot
	for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
	await assert.rejects(device.panic())
	await assert.rejects(device.releasePanic())
	assertPending(device, snapshot)
	assert.deepEqual(hid.writes, requests(hid, true))
})

for (const restoring of [false, true]) {
	const operation = restoring ? 'restore' : 'mute'
	test(
		`closing during a held ${operation} invalidates even identical restored connection references`,
		{ timeout: 5000 },
		async (t) => {
			const { device, hid } = start(t)
			if (restoring) await device.panic()
			const entered = Promise.withResolvers()
			const resume = Promise.withResolvers()
			t.after(() => resume.resolve())
			hid.beforeWrite = async () => {
				entered.resolve()
				await resume.promise
			}
			const pending = assert.rejects(restoring ? device.releasePanic() : device.panic())
			await entered.promise
			const snapshot = device.panicSnapshot
			const { tree, layout, capabilities } = device.session
			device.onClosed()
			Object.assign(device.session, { tree, layout, capabilities })
			device.ready = true
			resume.resolve()
			await pending
			assertPending(device, snapshot)
			const completedWrites = hid.writes.slice()
			await assert.rejects(device.panic())
			await assert.rejects(device.releasePanic())
			assertPending(device, snapshot)
			assert.deepEqual(hid.writes, completedWrites, 'the prior generation must never receive recovery writes')
			assert.deepEqual(hid.writes, [...(restoring ? requests(hid, true) : []), ...requests(hid, !restoring, 0, 1)])
		},
	)
}

test('a connection replaced during an in-flight mute receives no later writes', { timeout: 5000 }, async (t) => {
	const { device, hid } = start(t)
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	hid.beforeWrite = async () => {
		entered.resolve()
		await resume.promise
	}
	const activation = assert.rejects(device.panic(), /connect|identit|chang|original|session/i)
	await entered.promise
	const snapshot = device.panicSnapshot
	const replacement = new FakeHid()
	device.transport.device = replacement
	resume.resolve()
	await activation
	await assert.rejects(device.releasePanic())
	assertPending(device, snapshot)
	assert.deepEqual(hid.writes, requests(hid, true, 0, 1))
	assert.deepEqual(replacement.writes, [])
	assert.deepEqual(replacement.state, allAudible())
})

test(
	'a connection replaced during the last restore does not discard unresolved state',
	{ timeout: 5000 },
	async (t) => {
		const { device, hid } = start(t)
		await device.panic()
		const snapshot = device.panicSnapshot
		const entered = Promise.withResolvers()
		const resume = Promise.withResolvers()
		t.after(() => resume.resolve())
		hid.beforeWrite = async ({ name, value }) => {
			if (name !== 'disableAllHeadphoneOutputs' || value) return
			entered.resolve()
			await resume.promise
		}
		const release = assert.rejects(device.releasePanic(), /connect|identit|chang|original|session/i)
		await entered.promise
		const replacement = new FakeHid()
		device.transport.device = replacement
		resume.resolve()
		await release
		assertPending(device, snapshot)
		await assert.rejects(device.releasePanic())
		assert.deepEqual(replacement.writes, [])
	},
)

test('activation without a connected, synchronized desk rejects without inventing a snapshot', async (t) => {
	for (const unavailable of ['not ready', 'closed HID handle', 'missing tree', 'missing layout']) {
		await t.test(unavailable, async (t) => {
			const { device, hid } = start(t)
			if (unavailable === 'missing tree') device.session.tree = null
			else if (unavailable === 'missing layout') device.session.layout = null
			else identityChanges[unavailable](device)
			await assert.rejects(device.panic())
			assert.equal(device.panicSnapshot, null)
			assert.equal(device.panicActive, false)
			assert.deepEqual(hid.writes, [])
		})
	}
})

test('unknown original mute state rejects before any writes', async (t) => {
	for (let missing = 0; missing < 6; missing++) {
		await t.test(`missing mute property ${missing + 1}`, async (t) => {
			const hid = new FakeHid()
			const { path, name } = targets(hid.layout)[missing]
			hid.tree.getByPath(path).properties.delete(name)
			const { device } = start(t, hid)
			await assert.rejects(device.panic())
			assert.equal(device.panicSnapshot, null)
			assert.equal(device.panicActive, false)
			assert.deepEqual(hid.writes, [])
		})
	}
})
