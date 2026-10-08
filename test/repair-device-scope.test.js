import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatMixLevel } from '../src/model.js'
import { decodeChangeFrame, encodeFullSync } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { HANDSHAKE_PAUSE_MS, modeNormalReport, sessionOpenReport } from '../src/protocol/session.js'
import { releaseValue } from '../src/protocol/trigger.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { syntheticRoot } from './protocol/helpers.js'

// Exercise the production instance, transport, device and protocol together.
// Native HID and Companion are replaced, so no test can reach real hardware.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in device-scope tests') }
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
		if (Object.hasOwn(stubs, specifier)) {
			return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
		}
		return nextResolve(specifier, context)
	},
})
const { RodecasterInstance } = await import('../src/main.js')
const { RodecasterDevice } = await import('../src/device.js')
const { HidTransport } = await import('../src/hid-transport.js')
hooks.deregister()

const RECONNECT_MS = 3000
const flush = () => new Promise((resolve) => setImmediate(resolve))
const identityA = { serialNumber: 'synthetic-desk-A', productId: 1 }
const identityB = { serialNumber: 'synthetic-desk-B', productId: 1 }

class FakeTimers {
	now = 0
	pending = new Set()

	setTimeout = (callback, delay) => {
		const timer = { callback, at: this.now + delay }
		this.pending.add(timer)
		return timer
	}

	clearTimeout = (timer) => this.pending.delete(timer)

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
}

class FakeDesk {
	constructor(identity) {
		this.identity = { ...identity }
		this.info = {
			path: `synthetic-path-${identity.serialNumber}-${identity.productId}`,
			product: 'Synthetic RODECaster',
			vendorId: 0x19f7,
			interface: 9,
			...identity,
		}
		this.tree = syntheticRoot()
		this.layout = Layout.fromFullSync(this.tree)
		for (let strip = 0; strip < this.layout.channelCount; strip++) {
			this.tree.getByPath(this.layout.channelPath(strip)).properties.set('channelInputSource', V.int(strip))
		}
		for (const node of this.tree.children.filter((node) => node.type === 'MIX')) {
			node.properties = new Map([
				['mixLink', V.bool(false)],
				['mixDisabled', V.bool(false)],
				['mixLinkRequest', releaseValue()],
				['mixUnlinkRequest', releaseValue()],
				['mixLevelWithAnchor', V.string(formatMixLevel(0.5, 0.5))],
			])
		}
		this.writes = []
		this.beforeWrite = async () => {}
	}

	cell(source, mix) {
		return this.tree.getByPath(this.layout.mixCellPath(source, mix))
	}

	link(source, mixes) {
		for (const mix of mixes) this.cell(source, mix).properties.set('mixLink', V.bool(true))
	}

	linked(source, mix) {
		return this.cell(source, mix).properties.get('mixLink').value
	}

	get repairs() {
		return this.writes.filter(({ name }) => name === 'mixLinkRequest')
	}
}

class FakeHid extends EventEmitter {
	constructor(desk) {
		super()
		this.desk = desk
		this.reassembler = new Reassembler()
		this.closeCalls = 0
	}

	async getDeviceInfo() {
		return { ...this.desk.info }
	}

	async write(report) {
		const bytes = Buffer.from(report)
		if (bytes.equals(modeNormalReport()) || bytes.equals(sessionOpenReport())) return
		for (const body of this.reassembler.push(bytes)) {
			const change = decodeChangeFrame(body)
			assert.equal(change?.type, 'propertyChanged')
			const cell = this.desk.layout.mixCellFromPath(change.path)
			const request = { ...cell, name: change.name }
			this.desk.writes.push(request)
			await this.desk.beforeWrite(request)
			const node = this.desk.tree.getByPath(change.path)
			node.properties.set(change.name, change.value)
			if (change.name === 'mixLinkRequest') node.properties.set('mixLink', V.bool(true))
			if (change.name === 'mixUnlinkRequest') node.properties.set('mixLink', V.bool(false))
		}
	}

	async close() {
		this.closeCalls++
	}

	fullSync() {
		for (const report of encodeReports(encodeFullSync(this.desk.tree), REPORT_ID_IN)) this.emit('data', report)
	}
}

class FakeBackend {
	constructor(...desks) {
		this.attached = desks
		this.opened = []
	}

	devices = () => this.attached.map((desk) => ({ ...desk.info }))
	openDesk = (path) => this.attached.find((desk) => desk.info.path === path)
	prepareHandle = () => {}
	HIDAsync = {
		open: async (path) => {
			const desk = this.openDesk(path)
			assert.ok(desk, 'only a synthetic desk may be opened')
			const handle = new FakeHid(desk)
			this.prepareHandle(handle)
			this.opened.push(handle)
			return handle
		},
	}
}

function journal(t, entries = [], config = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'rode-repair-device-scope-'))
	const path = join(dir, 'config.json')
	writeFileSync(
		path,
		JSON.stringify({ serial: '', levelControl: true, ...config, unlinkedSends: JSON.stringify(entries) }),
	)
	t.after(() => {
		unlinkSync(path)
		rmdirSync(dir)
	})
	return {
		read: () => JSON.parse(readFileSync(path, 'utf8')),
		entries: () => JSON.parse(JSON.parse(readFileSync(path, 'utf8')).unlinkedSends),
		save: (config) => writeFileSync(path, JSON.stringify(config)),
	}
}

async function start(t, disk, backend) {
	const instance = new RodecasterInstance({})
	const timers = new FakeTimers()
	const transport = new HidTransport(backend)
	const device = (instance.device = new RodecasterDevice({}, { transport, timers }))
	const logs = []
	const statuses = []
	device.on('status', (state, message) => statuses.push({ state, message }))
	instance.log = (level, message) => logs.push({ level, message })
	for (const method of [
		'updateStatus',
		'setVariableDefinitions',
		'setVariableValues',
		'setActionDefinitions',
		'setFeedbackDefinitions',
		'setPresetDefinitions',
		'checkAllFeedbacks',
		'checkFeedbacks',
	]) {
		instance[method] = () => {}
	}
	instance.saveConfig = disk.save
	let repair
	const repairOnStart = device.repairOnStart.bind(device)
	device.repairOnStart = () => (repair = repairOnStart())
	const crash = async () => {
		// Simulate process loss without the orderly-stop fader restoration.
		device.ready = false
		await instance.destroy()
		assert.equal(timers.pending.size, 0)
	}
	t.after(crash)
	await instance.init(disk.read())
	await flush()
	const sync = async () => {
		backend.opened.at(-1).fullSync()
		await repair
		assert.equal(device.ready, true)
	}
	const ready = async () => {
		await timers.advance(HANDSHAKE_PAUSE_MS)
		await sync()
	}
	const disconnect = async () => {
		transport.device.emit('error', new Error('synthetic unplug'))
		await flush()
		assert.equal(device.ready, false)
		assert.equal(transport.identity, null)
	}
	const reconnect = async (...desks) => {
		backend.attached = desks
		await disconnect()
		await timers.advance(RECONNECT_MS)
		await ready()
	}
	return { instance, device, transport, timers, logs, statuses, ready, sync, crash, disconnect, reconnect }
}

function assertDeferred(app) {
	assert.ok(
		app.logs.some(({ level, message }) => level === 'warn' && /manual|review|original|matching desk/i.test(message)),
		'unmatched recovery must explain safe handling through the existing warning log',
	)
}

test('auto-discovery captures the opened identity before unlinking and repairs only when desk A returns', async (t) => {
	const a = new FakeDesk(identityA)
	const b = new FakeDesk(identityB)
	a.link(0, [0, 1])
	assert.deepEqual(a.layout.mixCellPath(0, 1), b.layout.mixCellPath(0, 1), 'both desks have identical topology')
	const disk = journal(t)
	const app = await start(t, disk, new FakeBackend(a, b))
	await app.ready()
	const pending = [{ source: 0, mixes: [0, 1], identity: identityA }]
	a.beforeWrite = async () => assert.deepEqual(disk.entries(), pending, 'identity is durable before any unlink write')
	await app.device.borrowStrip(0)
	a.beforeWrite = async () => {}
	assert.deepEqual(app.transport.identity, identityA)
	assert.equal(app.instance.config.serial, '', 'automatic selection does not become a configured serial')
	await app.reconnect(b)
	assert.deepEqual(app.transport.identity, identityB)
	assert.deepEqual(b.writes, [], 'a replacement desk receives no recovery property writes')
	assert.equal(b.linked(0, 0), false, 'the replacement desk keeps its deliberately unlinked send')
	assert.equal(b.linked(0, 1), false)
	assert.equal(app.device.borrowed.size, 0, 'old desk borrowing does not become active on the replacement')
	assert.deepEqual(app.device.pendingRepair, pending)
	assert.deepEqual(disk.entries(), pending)
	assertDeferred(app)

	await app.reconnect(a)
	assert.deepEqual(a.repairs, [
		{ source: 0, mix: 0, name: 'mixLinkRequest' },
		{ source: 0, mix: 1, name: 'mixLinkRequest' },
	])
	assert.equal(a.linked(0, 0), true)
	assert.equal(a.linked(0, 1), true)
	assert.deepEqual(disk.entries(), [])
	await app.device.repairOnStart()
	await app.sync()
	assert.equal(a.repairs.length, 2, 'each recovered send is repaired exactly once')
})

test('identity survives disk reload, failed repair, another desk and a later successful retry', async (t) => {
	const a = new FakeDesk(identityA)
	const b = new FakeDesk(identityB)
	a.link(0, [0, 1])
	const disk = journal(t)
	const first = await start(t, disk, new FakeBackend(a))
	await first.ready()
	await first.device.borrowStrip(0)
	const pending = [{ source: 0, mixes: [0, 1], identity: identityA }]
	await first.crash()
	a.beforeWrite = async ({ mix }) => {
		if (mix === 1) throw new Error('synthetic repair failure')
	}
	const retry = await start(t, disk, new FakeBackend(a))
	await retry.ready()
	assert.deepEqual(disk.entries(), pending, 'partial recovery retains the original desk identity')
	assert.equal(a.linked(0, 0), true)
	assert.equal(a.linked(0, 1), false)
	await retry.crash()
	const otherDesk = await start(t, disk, new FakeBackend(b))
	await otherDesk.ready()
	assert.deepEqual(b.writes, [])
	assert.deepEqual(disk.entries(), pending)
	assertDeferred(otherDesk)
	await otherDesk.crash()
	a.beforeWrite = async () => {}
	const final = await start(t, disk, new FakeBackend(a))
	await final.ready()
	assert.deepEqual(
		a.repairs.map(({ mix }) => mix),
		[0, 1, 1],
		'successful sends are skipped on a later identity-safe retry',
	)
	assert.deepEqual(disk.entries(), [])
	await final.device.repairOnStart()
	assert.equal(a.repairs.length, 3)
})

test('explicit serial changes retain unresolved records even when updated settings omit or stale the journal', async (t) => {
	const pending = [{ source: 0, mixes: [0], identity: identityA }]
	const disk = journal(t, pending, { serial: identityA.serialNumber })
	const a = new FakeDesk(identityA)
	const b = new FakeDesk(identityB)
	a.beforeWrite = async () => {
		throw new Error('synthetic repair failure')
	}
	const backend = new FakeBackend(a, b)
	const app = await start(t, disk, backend)
	await app.ready()
	assert.deepEqual(disk.entries(), pending)
	await app.instance.configUpdated({ serial: identityB.serialNumber, levelControl: true, unlinkedSends: '[]' })
	await flush()
	await app.ready()
	assert.deepEqual(app.transport.identity, identityB)
	assert.deepEqual(b.writes, [])
	assert.deepEqual(disk.entries(), pending)
	assert.deepEqual(JSON.parse(app.instance.config.unlinkedSends), pending)

	b.link(0, [0])
	await app.sync()
	await app.device.borrowStrip(0)
	const own = { source: 0, mixes: [0], identity: identityB }
	assert.deepEqual(disk.entries(), [...pending, own], 'B borrowing preserves the unresolved A journal')
	await app.device.repairOnStart()
	assert.equal(b.linked(0, 0), false, 'A repair must not take over an overlapping B borrow')
	assert.deepEqual(disk.entries(), [...pending, own])
	await app.device.releaseStrip(0)
	assert.deepEqual(disk.entries(), pending)
	a.beforeWrite = async () => {}
	await app.instance.configUpdated({ serial: identityA.serialNumber, levelControl: true })
	await flush()
	await app.ready()
	assert.deepEqual(disk.entries(), [])
	assert.equal(a.linked(0, 0), true)
	assert.deepEqual(b.repairs, [{ source: 0, mix: 0, name: 'mixLinkRequest' }])
})

test('settings changes preserve recovery on disk immediately while no desk is available', async (t) => {
	const legacy = { strip: 1, source: 1, mixes: [0] }
	const pending = [{ source: 0, mixes: [0], identity: identityA }, legacy]
	const disk = journal(t, pending, { serial: identityA.serialNumber })
	const backend = new FakeBackend()
	const app = await start(t, disk, backend)
	assert.equal(app.device.ready, false)
	await app.instance.configUpdated({ serial: identityB.serialNumber, levelControl: true, unlinkedSends: '[]' })
	assert.deepEqual(disk.entries(), pending, 'a stale journal in settings is replaced before any desk reconnects')
	assert.deepEqual(JSON.parse(app.instance.config.unlinkedSends), pending)
	await app.instance.configUpdated({ serial: identityB.serialNumber, levelControl: true, stripNames: 'Renamed' })
	assert.deepEqual(disk.entries(), pending, 'omitting the journal in settings must not erase it')
	assert.equal(disk.read().stripNames, 'Renamed')
	assert.equal(backend.opened.length, 0)
	await app.crash()
	const restart = await start(t, disk, backend)
	assert.deepEqual(restart.device.pendingRepair, pending)
	assert.equal(backend.opened.length, 0)
})

test('the opened handle identity overrides stale discovery and configured serial metadata', async (t) => {
	const pending = [{ source: 0, mixes: [0], identity: identityA }]
	const disk = journal(t, pending, { serial: identityA.serialNumber })
	const advertised = new FakeDesk(identityA)
	const actual = new FakeDesk(identityB)
	actual.link(1, [0])
	const backend = new FakeBackend(advertised)
	backend.openDesk = () => actual
	const app = await start(t, disk, backend)
	await app.ready()
	assert.deepEqual(app.transport.identity, identityB)
	assert.deepEqual(actual.writes, [], 'a device replacing the discovered path cannot inherit its predecessor journal')
	assert.deepEqual(disk.entries(), pending)
	await app.device.borrowStrip(1)
	assert.deepEqual(disk.entries(), [...pending, { source: 1, mixes: [0], identity: identityB }])
	assertDeferred(app)
})

test('matching serial numbers on different models do not authorize repair', async (t) => {
	const pending = [{ source: 0, mixes: [0], identity: identityA }]
	const disk = journal(t, pending)
	const original = new FakeDesk(identityA)
	const otherModel = new FakeDesk({ ...identityA, productId: 2 })
	const app = await start(t, disk, new FakeBackend(otherModel))
	await app.ready()
	assert.deepEqual(otherModel.writes, [])
	assert.deepEqual(disk.entries(), pending)
	assertDeferred(app)
	await app.reconnect(original)
	assert.equal(original.repairs.length, 1)
	assert.deepEqual(disk.entries(), [])
})

test('a foreign journal remains pending even when all replacement desk sends are already linked', async (t) => {
	const pending = [{ source: 0, mixes: [0, 1], identity: identityA }]
	const disk = journal(t, pending)
	const b = new FakeDesk(identityB)
	b.link(0, [0, 1])
	const app = await start(t, disk, new FakeBackend(b))
	await app.ready()
	await app.device.repairOnStart()
	assert.deepEqual(b.writes, [])
	assert.deepEqual(app.device.pendingRepair, pending)
	assert.deepEqual(disk.entries(), pending, 'the replacement desk state cannot retire another desk recovery')
	assertDeferred(app)
})

for (const identity of [
	{ serialNumber: '', productId: 1 },
	{ serialNumber: '  ', productId: 1 },
	{ productId: 1 },
	{ serialNumber: identityA.serialNumber },
]) {
	test(`incomplete recorded identity ${JSON.stringify(identity)} remains unassigned`, async (t) => {
		const pending = [{ source: 0, mixes: [0], identity }]
		const disk = journal(t, pending)
		const desk = new FakeDesk(identityA)
		const app = await start(t, disk, new FakeBackend(desk))
		await app.ready()
		await app.device.repairOnStart()
		assert.deepEqual(desk.writes, [])
		assert.deepEqual(app.device.pendingRepair, pending)
		assert.deepEqual(disk.entries(), pending)
		assertDeferred(app)
	})
}

test('an unknown opened serial is journaled without being assigned and never authorizes later repair', async (t) => {
	const unknown = new FakeDesk({ serialNumber: '', productId: 1 })
	unknown.link(0, [0])
	const disk = journal(t)
	const first = await start(t, disk, new FakeBackend(unknown))
	await first.ready()
	const pending = [{ source: 0, mixes: [0], identity: { serialNumber: '', productId: 1 } }]
	unknown.beforeWrite = async () => assert.deepEqual(disk.entries(), pending)
	await first.device.borrowStrip(0)
	unknown.beforeWrite = async () => {}
	await assert.rejects(first.device.releaseStrip(0), /identity/)
	assert.deepEqual(unknown.repairs, [], 'an explicit release cannot relink sends without a known identity')
	assert.deepEqual(disk.entries(), pending)
	await first.crash()
	const restart = await start(t, disk, new FakeBackend(unknown))
	await restart.ready()
	assert.deepEqual(unknown.repairs, [], 'two unknown identities must never match')
	assert.deepEqual(disk.entries(), pending)
	assertDeferred(restart)
	const known = new FakeDesk(identityA)
	await restart.reconnect(known)
	assert.deepEqual(known.writes, [])
	assert.deepEqual(disk.entries(), pending, 'a later known serial does not adopt an unknown journal')
})

for (const unavailable of ['missing serial', 'missing model', 'missing handle info API']) {
	test(`opened identity with ${unavailable} cannot inherit discovery metadata`, async (t) => {
		const pending = [{ source: 0, mixes: [0], identity: identityA }]
		const disk = journal(t, pending, { serial: identityA.serialNumber })
		const desk = new FakeDesk(identityA)
		const backend = new FakeBackend(desk)
		backend.prepareHandle = (handle) => {
			if (unavailable === 'missing serial') handle.getDeviceInfo = async () => ({ ...desk.info, serialNumber: '' })
			else if (unavailable === 'missing model')
				handle.getDeviceInfo = async () => ({ ...desk.info, productId: undefined })
			else handle.getDeviceInfo = undefined
		}
		const app = await start(t, disk, backend)
		await app.ready()
		assert.deepEqual(desk.writes, [])
		assert.deepEqual(disk.entries(), pending)
		assertDeferred(app)
	})
}

test('an opened identity query failure closes the handle and preserves recovery until a successful retry', async (t) => {
	const pending = [{ source: 0, mixes: [0], identity: identityA }]
	const disk = journal(t, pending)
	const desk = new FakeDesk(identityA)
	const backend = new FakeBackend(desk)
	backend.prepareHandle = (handle) => {
		handle.getDeviceInfo = async () => {
			throw new Error('synthetic identity query failure')
		}
	}
	const app = await start(t, disk, backend)
	assert.equal(app.device.ready, false)
	assert.equal(app.transport.isOpen, false)
	assert.equal(app.transport.identity, null)
	assert.equal(backend.opened[0].closeCalls, 1)
	assert.deepEqual(
		[...app.timers.pending].map(({ at }) => at - app.timers.now),
		[RECONNECT_MS],
	)
	assert.deepEqual(desk.writes, [])
	assert.deepEqual(disk.entries(), pending)
	assert.ok(
		app.statuses.some(({ state, message }) => state === 'disconnected' && /identity query failure/.test(message)),
	)
	backend.prepareHandle = () => {}
	await app.timers.advance(RECONNECT_MS)
	await app.ready()
	assert.equal(desk.repairs.length, 1)
	assert.deepEqual(disk.entries(), [])
})

test('a cancelled identity query cannot replace the identity of a newer opened desk', async (t) => {
	const a = new FakeDesk(identityA)
	const b = new FakeDesk(identityB)
	const backend = new FakeBackend(a)
	const queried = Promise.withResolvers()
	const resume = Promise.withResolvers()
	backend.prepareHandle = (handle) => {
		if (handle.desk !== a) return
		handle.getDeviceInfo = async () => {
			queried.resolve()
			await resume.promise
			return { ...a.info }
		}
	}
	const transport = new HidTransport(backend)
	t.after(async () => {
		resume.resolve()
		await transport.close()
	})
	const opening = transport.open()
	const cancelled = assert.rejects(opening, /HID open cancelled/)
	await queried.promise
	assert.equal(transport.identity, null)
	await transport.close()
	backend.attached = [b]
	await transport.open()
	assert.deepEqual(transport.identity, identityB)
	resume.resolve()
	await cancelled
	assert.deepEqual(transport.identity, identityB)
	assert.equal(transport.device, backend.opened[1])
	assert.equal(backend.opened[0].closeCalls, 1)
	assert.equal(backend.opened[1].closeCalls, 0)
	assert.deepEqual(a.writes, [])
	assert.deepEqual(b.writes, [])
})

test('legacy journal records retain their fields through borrowing, settings changes and restart', async (t) => {
	const legacy = { strip: 0, source: 0, mixes: [0, 1] }
	const desk = new FakeDesk(identityA)
	desk.link(1, [0])
	const disk = journal(t, [legacy])
	const first = await start(t, disk, new FakeBackend(desk))
	await first.ready()
	assert.deepEqual(desk.writes, [])
	assert.deepEqual(first.device.pendingRepair, [legacy])
	assertDeferred(first)
	await first.device.borrowStrip(1)
	assert.deepEqual(disk.entries(), [legacy, { source: 1, mixes: [0], identity: identityA }])
	await first.device.releaseStrip(1)
	assert.deepEqual(disk.entries(), [legacy], 'legacy entries are neither removed nor assigned the current serial')
	await first.instance.configUpdated({ serial: '', levelControl: true, stripNames: 'Synthetic renamed strip' })
	assert.deepEqual(JSON.parse(first.instance.config.unlinkedSends), [legacy])
	await first.crash()
	const writeCount = desk.writes.length
	const second = await start(t, disk, new FakeBackend(desk))
	await second.ready()
	assert.equal(desk.writes.length, writeCount)
	assert.deepEqual(disk.entries(), [legacy])
	assertDeferred(second)
})
