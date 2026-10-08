import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatMixLevel } from '../src/model.js'
import { decodeChangeFrame, encodeFullSync } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { releaseValue } from '../src/protocol/trigger.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { syntheticRoot, repeat } from './protocol/helpers.js'

// Keep the production device, protocol and instance code; replace only the
// external host APIs. Any accidental hardware enumeration/open must fail.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in repair tests') }
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
hooks.deregister()

const identity = { serialNumber: 'synthetic-repair-journal-serial', productId: 1 }

class FakeHid extends EventEmitter {
	constructor(sourceCount = 2) {
		super()
		this.tree = syntheticRoot()
		const mixEnd = this.tree.children.findIndex((node) => node.type === 'INPUTSOURCE')
		if (sourceCount > 2) this.tree.children.splice(mixEnd, 0, ...repeat((sourceCount - 2) * 13, 'MIX'))
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
		this.reassembler = new Reassembler()
		this.writes = []
		this.beforeWrite = async () => {}
	}

	cell(source, mix) {
		return this.tree.getByPath(this.layout.mixCellPath(source, mix))
	}

	linked(source, mix) {
		return this.cell(source, mix).properties.get('mixLink').value
	}

	async write(report) {
		for (const body of this.reassembler.push(report)) {
			const change = decodeChangeFrame(body)
			assert.equal(change?.type, 'propertyChanged')
			const cell = this.layout.mixCellFromPath(change.path)
			const request = { ...cell, name: change.name }
			this.writes.push(request)
			await this.beforeWrite(request)
			const node = this.tree.getByPath(change.path)
			node.properties.set(change.name, change.value)
			if (change.name === 'mixLinkRequest') node.properties.set('mixLink', V.bool(true))
			if (change.name === 'mixUnlinkRequest') node.properties.set('mixLink', V.bool(false))
		}
	}

	async close() {}
}

function journal(t, entries = []) {
	const dir = mkdtempSync(join(tmpdir(), 'rode-repair-journal-'))
	const path = join(dir, 'config.json')
	const config = { levelControl: true, stripNames: 'Synthetic A,Synthetic B', unlinkedSends: JSON.stringify(entries) }
	writeFileSync(path, JSON.stringify(config))
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

async function start(t, disk, hid) {
	const instance = new RodecasterInstance({})
	instance.log = () => {}
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
	const device = instance.device
	// Skip physical discovery/handshake; all full-sync reports and writes use the fake.
	device.start = () => {}
	device.transport.device = hid
	device.transport.info = { ...identity }
	await instance.init(disk.read())
	const crash = () => {
		clearInterval(instance.clockTimer)
		device.clearTimers()
		device.transport.device = null
	}
	t.after(crash)
	let repair
	const repairOnStart = device.repairOnStart.bind(device)
	device.repairOnStart = () => (repair = repairOnStart())
	const sync = async () => {
		for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
		await repair
	}
	return { instance, device, sync, crash }
}

function failLink(source, mix) {
	return async (request) => {
		if (request.source === source && request.mix === mix && request.name === 'mixLinkRequest') {
			throw new Error('synthetic HID write failure')
		}
	}
}

test('partial startup repair survives repeated failures and restarts until eventual success', async (t) => {
	const pending = [{ source: 0, mixes: [0, 1], identity }]
	const disk = journal(t, pending)
	const hid = new FakeHid()
	hid.beforeWrite = failLink(0, 1)
	const first = await start(t, disk, hid)
	await first.sync()
	assert.equal(hid.linked(0, 0), true)
	assert.equal(hid.linked(0, 1), false)
	assert.deepEqual(disk.entries(), pending, 'a partial repair must remain durable')
	assert.deepEqual(first.device.pendingRepair, pending)

	await first.device.repairOnStart()
	assert.deepEqual(disk.entries(), pending, 'a repeated failure must not clear the journal')
	first.crash()
	const second = await start(t, disk, hid)
	await second.sync()
	assert.deepEqual(disk.entries(), pending, 'a restarted instance must retain a failed repair')
	assert.deepEqual(
		hid.writes.map(({ mix }) => mix),
		[0, 1, 1, 1],
		'already linked sends are skipped',
	)

	hid.beforeWrite = async () => {}
	await second.sync()
	assert.equal(hid.linked(0, 1), true)
	assert.deepEqual(second.device.pendingRepair, [])
	assert.deepEqual(disk.entries(), [])
	assert.equal(disk.read().stripNames, 'Synthetic A,Synthetic B')
	const writeCount = hid.writes.length
	second.crash()
	const third = await start(t, disk, hid)
	await third.sync()
	assert.equal(hid.writes.length, writeCount, 'completed repairs are not replayed')
})

test('successful entries retire independently while failures remain recoverable', async (t) => {
	const failed = { source: 0, mixes: [0], identity }
	const disk = journal(t, [failed, { source: 1, mixes: [0], identity }])
	const hid = new FakeHid()
	hid.beforeWrite = failLink(0, 0)
	const app = await start(t, disk, hid)
	await app.sync()
	assert.deepEqual(disk.entries(), [failed])
	assert.deepEqual(app.device.pendingRepair, [failed])
	assert.equal(hid.linked(1, 0), true, 'a failed source must not prevent another source from repairing')

	hid.beforeWrite = async () => {}
	await app.device.repairOnStart()
	assert.deepEqual(disk.entries(), [])
	assert.deepEqual(
		hid.writes.map(({ source }) => source),
		[0, 1, 0],
	)
})

test('borrow and release updates preserve pending repairs, including while a write is in flight', async (t) => {
	const pending = [{ source: 0, mixes: [0], identity }]
	const active = { source: 1, mixes: [0, 1], identity }
	const disk = journal(t, pending)
	const hid = new FakeHid()
	for (const mix of active.mixes) hid.cell(1, mix).properties.set('mixLink', V.bool(true))
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	hid.beforeWrite = async (request) => {
		if (request.source === 0) {
			entered.resolve()
			await resume.promise
			throw new Error('synthetic delayed write failure')
		}
	}
	const app = await start(t, disk, hid)
	const repairing = app.sync()
	await entered.promise
	await app.device.borrowStrip(1)
	assert.deepEqual(disk.entries(), [...pending, active], 'borrowing must not overwrite an in-flight repair')
	await app.device.releaseStrip(1)
	assert.deepEqual(disk.entries(), pending, 'releasing must not overwrite an in-flight repair')
	resume.resolve()
	await repairing
	assert.deepEqual(disk.entries(), pending)

	await app.device.borrowStrip(1)
	assert.deepEqual(disk.entries(), [...pending, active], 'later borrow updates must retain earlier failed repairs')
	hid.beforeWrite = async () => {}
	await app.device.repairOnStart()
	assert.deepEqual(disk.entries(), [active], 'successful repair must preserve current borrowed sends')
	assert.equal(app.device.borrowed.has(1), true)
	assert.equal(hid.linked(1, 0), false)
	assert.equal(hid.linked(1, 1), false)

	app.crash()
	const restarted = await start(t, disk, hid)
	await restarted.sync()
	assert.equal(hid.linked(1, 0), true)
	assert.equal(hid.linked(1, 1), true)
	assert.deepEqual(disk.entries(), [])
})

test('a partial borrow is journaled before writes and repaired after a crash', async (t) => {
	const disk = journal(t)
	const hid = new FakeHid()
	for (const mix of [0, 1, 2]) hid.cell(0, mix).properties.set('mixLink', V.bool(true))
	hid.cell(0, 2).properties.set('mixDisabled', V.bool(true))
	const app = await start(t, disk, hid)
	await app.sync()
	const expected = [{ source: 0, mixes: [0, 1], identity }]
	hid.beforeWrite = async (request) => {
		assert.deepEqual(disk.entries(), expected, 'recovery must be saved before the first unlink')
		if (request.mix === 1) throw new Error('synthetic unlink failure')
	}
	await assert.rejects(app.device.borrowStrip(0), /synthetic unlink failure/)
	assert.equal(hid.linked(0, 0), false)
	assert.equal(hid.linked(0, 1), true)
	assert.deepEqual(disk.entries(), expected)
	app.crash()

	hid.beforeWrite = async () => {}
	const restarted = await start(t, disk, hid)
	await restarted.sync()
	assert.deepEqual(disk.entries(), [])
	assert.equal(hid.linked(0, 0), true)
	assert.equal(hid.linked(0, 2), true, 'disabled sends are untouched')
	assert.equal(hid.linked(0, 3), false, 'user-unlinked sends are untouched')
	assert.deepEqual(hid.writes, [
		{ source: 0, mix: 0, name: 'mixUnlinkRequest' },
		{ source: 0, mix: 1, name: 'mixUnlinkRequest' },
		{ source: 0, mix: 0, name: 'mixLinkRequest' },
	])
})

test('retrying a partial repair defers sends reborrowed in this run until they are released', async (t) => {
	const pending = [{ source: 0, mixes: [0, 1], identity }]
	const active = { source: 0, mixes: [0], identity }
	const disk = journal(t, pending)
	const hid = new FakeHid()
	hid.beforeWrite = failLink(0, 1)
	const app = await start(t, disk, hid)
	await app.sync()
	await app.device.borrowStrip(0)
	assert.equal(hid.linked(0, 0), false)
	assert.deepEqual(disk.entries(), [...pending, active])

	hid.beforeWrite = async () => {}
	await app.device.repairOnStart()
	assert.equal(hid.linked(0, 0), false, 'startup recovery must not take back a currently borrowed send')
	assert.equal(app.device.borrowed.has(0), true)
	assert.deepEqual(disk.entries(), [...pending, active])

	await app.device.releaseStrip(0)
	assert.deepEqual(disk.entries(), pending)
	await app.device.repairOnStart()
	assert.equal(hid.linked(0, 0), true)
	assert.equal(hid.linked(0, 1), true)
	assert.deepEqual(disk.entries(), [])
})

test('partial release keeps borrowed recovery state until every relink succeeds', async (t) => {
	const disk = journal(t)
	const hid = new FakeHid()
	for (const mix of [0, 1]) hid.cell(0, mix).properties.set('mixLink', V.bool(true))
	const app = await start(t, disk, hid)
	await app.sync()
	await app.device.borrowStrip(0)
	hid.beforeWrite = failLink(0, 1)
	await assert.rejects(app.device.releaseStrip(0), /synthetic HID write failure/)
	assert.deepEqual(disk.entries(), [{ source: 0, mixes: [0, 1], identity }])
	assert.equal(app.device.borrowed.has(0), true)
	assert.equal(hid.linked(0, 0), true)
	assert.equal(hid.linked(0, 1), false)
	hid.beforeWrite = async () => {}
	await app.device.releaseStrip(0)
	assert.equal(app.device.borrowed.has(0), false)
	assert.deepEqual(disk.entries(), [])
})

test('already linked repairs retire without issuing HID writes', async (t) => {
	const disk = journal(t, [{ source: 0, mixes: [0, 1], identity }])
	const hid = new FakeHid()
	for (const mix of [0, 1]) hid.cell(0, mix).properties.set('mixLink', V.bool(true))
	const app = await start(t, disk, hid)
	await app.sync()
	assert.deepEqual(hid.writes, [])
	assert.deepEqual(disk.entries(), [])
})

test('a repair absent from the current layout remains durable until its source returns', async (t) => {
	const pending = [{ source: 2, mixes: [0], identity }]
	const disk = journal(t, pending)
	const hid = new FakeHid()
	const app = await start(t, disk, hid)
	await app.sync()
	assert.deepEqual(disk.entries(), pending, 'a missing mix path is not a successful repair')
	assert.deepEqual(hid.writes, [])
	app.crash()
	const restored = new FakeHid(3)
	const restarted = await start(t, disk, restored)
	await restarted.sync()
	assert.equal(restored.linked(2, 0), true)
	assert.deepEqual(disk.entries(), [])
})
