import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeChangeFrame, encodeFullSync, encodePropertyChanged } from '../src/protocol/change-frame.js'
import { V } from '../src/protocol/juce-var.js'
import { Layout } from '../src/protocol/layout.js'
import { encodeReports, Reassembler, REPORT_ID_IN } from '../src/protocol/usb.js'
import { repeat, syntheticRoot } from './protocol/helpers.js'

// Keep the actual instance, device and protocol code; prohibit discovery or
// access to hardware even if a test accidentally enters the connection path.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in headphone tests') }
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

class FakeHid extends EventEmitter {
	constructor() {
		super()
		this.tree = syntheticRoot()
		const mixEnd = this.tree.children.findIndex((node) => node.type === 'INPUTSOURCE')
		this.tree.children.splice(mixEnd, 0, ...repeat(26, 'MIX'))
		this.layout = Layout.fromFullSync(this.tree)
		for (let strip = 0; strip < this.layout.channelCount; strip++) {
			const node = this.tree.getByPath(this.layout.channelPath(strip))
			node.properties.set('channelInputSource', V.int(strip))
			node.properties.set('channelOutputMute', V.bool(false))
		}
		for (const node of this.tree.children.filter((node) => node.type === 'MIX')) {
			node.properties = new Map([
				['mixMute', V.bool(false)],
				['mixDisabled', V.bool(false)],
				['mixLink', V.bool(true)],
			])
		}
		const output = this.tree.getByPath(this.layout.singletonPath('output'))
		output.properties.set('outputMonMute', V.bool(false))
		output.properties.set('outputBTMute', V.bool(false))
		this.tree.getByPath(this.layout.singletonPath('system')).properties.set('disableAllHeadphoneOutputs', V.bool(false))
		this.reassembler = new Reassembler()
		this.writes = []
		this.beforeWrite = async () => {}
		this.afterWrite = async () => {}
	}

	cell(source, mix) {
		return this.tree.getByPath(this.layout.mixCellPath(source, mix))
	}

	muted(source, mix) {
		return this.cell(source, mix).properties.get('mixMute').value
	}

	async write(report) {
		for (const body of this.reassembler.push(report)) {
			const change = decodeChangeFrame(body)
			assert.equal(change?.type, 'propertyChanged')
			const request = { path: change.path, name: change.name, value: change.value.value }
			this.writes.push(request)
			await this.beforeWrite(request)
			this.tree.getByPath(change.path).properties.set(change.name, change.value)
			await this.afterWrite(request)
		}
	}

	async close() {}
}

function journal(t, entries = []) {
	const dir = mkdtempSync(join(tmpdir(), 'rode-headphone-mutes-'))
	const path = join(dir, 'config.json')
	writeFileSync(
		path,
		JSON.stringify({ stripNames: 'Synthetic A,Synthetic B', headphoneMixMutes: JSON.stringify(entries) }),
	)
	t.after(() => {
		unlinkSync(path)
		rmdirSync(dir)
	})
	return {
		read: () => JSON.parse(readFileSync(path, 'utf8')),
		entries: () => JSON.parse(JSON.parse(readFileSync(path, 'utf8')).headphoneMixMutes),
		save: (config) => writeFileSync(path, JSON.stringify(config)),
	}
}

async function start(t, hid = new FakeHid(), disk = journal(t)) {
	const instance = new RodecasterInstance({})
	const values = {}
	const checkedFeedbacks = []
	const updates = []
	const logs = []
	instance.log = (level, message) => logs.push({ level, message })
	instance.updateStatus = () => {}
	instance.setVariableDefinitions = (definitions) => (instance.variables = definitions)
	instance.setVariableValues = (next) => Object.assign(values, next)
	instance.setActionDefinitions = (definitions) => (instance.actions = definitions)
	instance.setFeedbackDefinitions = (definitions) => (instance.feedbacks = definitions)
	instance.setPresetDefinitions = (sections, definitions) => {
		instance.sections = sections
		instance.presets = definitions
	}
	instance.checkAllFeedbacks = () => {}
	instance.checkFeedbacks = (...ids) => checkedFeedbacks.push(...ids)
	instance.saveConfig = disk.save
	const device = instance.device
	device.start = () => {}
	device.transport.device = hid
	device.on('update', (area) => updates.push(area))
	await instance.init(disk.read())
	const crash = () => {
		clearInterval(instance.clockTimer)
		device.clearTimers()
		device.transport.device = null
	}
	t.after(crash)
	const sync = () => {
		for (const report of encodeReports(encodeFullSync(hid.tree), REPORT_ID_IN)) device.onReport(report)
		assert.equal(device.ready, true)
	}
	const change = (source, mix, name, value) => {
		const path = hid.layout.mixCellPath(source, mix)
		hid.cell(source, mix).properties.set(name, value)
		for (const report of encodeReports(encodePropertyChanged(path, name, value), REPORT_ID_IN)) device.onReport(report)
	}
	sync()
	return { instance, device, hid, disk, values, checkedFeedbacks, updates, logs, crash, sync, change }
}

function requests(hid, headphone, sources, value) {
	return sources.map((source) => ({ path: hid.layout.mixCellPath(source, headphone - 1), name: 'mixMute', value }))
}

function assertBus(device, hid, headphone, expected) {
	for (let source = 0; source < hid.layout.sourceCount; source++) {
		assert.equal(hid.muted(source, headphone - 1), expected[source], `desk source ${source}`)
		assert.equal(
			device.propBool(device.layout.mixCellPath(source, headphone - 1), 'mixMute'),
			expected[source],
			`local source ${source}: writes are not echoed by the desk`,
		)
	}
}

for (const headphone of [1, 2, 3, 4]) {
	test(`headphone ${headphone} mute touches only its enabled, previously audible sends`, async (t) => {
		const hid = new FakeHid()
		hid.cell(1, headphone - 1).properties.set('mixDisabled', V.bool(true))
		hid.cell(2, headphone - 1).properties.set('mixMute', V.bool(true))
		hid.cell(3, headphone - 1).properties.set('mixLink', V.bool(false))
		const { device, disk, updates } = await start(t, hid)
		assert.equal(device.headphoneMixMuted(headphone), false)
		await device.setHeadphoneMixMute(headphone, true)
		assert.deepEqual(hid.writes, requests(hid, headphone, [0, 3], true))
		assert.deepEqual(disk.entries(), [{ headphone, sources: [0, 3] }])
		assertBus(device, hid, headphone, [true, false, true, true])
		assert.equal(device.headphoneMixMuted(headphone), true)
		assert.ok(updates.includes('monitor'))
		await device.setHeadphoneMixMute(headphone, true)
		assert.deepEqual(hid.writes, requests(hid, headphone, [0, 3], true), 'repeated mute retains original ownership')
		await device.setHeadphoneMixMute(headphone, false)
		assert.deepEqual(hid.writes, [
			...requests(hid, headphone, [0, 3], true),
			...requests(hid, headphone, [0, 3], false),
		])
		assertBus(device, hid, headphone, [false, false, true, false])
		assert.deepEqual(disk.entries(), [])
		for (let mix = 0; mix < hid.layout.mixCountPerSource; mix++) {
			if (mix === headphone - 1) continue
			for (let source = 0; source < hid.layout.sourceCount; source++) assert.equal(hid.muted(source, mix), false)
		}
	})
}

test('unmute without ownership restores all enabled muted sends in the selected bus', async (t) => {
	const hid = new FakeHid()
	for (const source of [0, 1, 2]) hid.cell(source, 2).properties.set('mixMute', V.bool(true))
	hid.cell(1, 2).properties.set('mixDisabled', V.bool(true))
	const { device } = await start(t, hid)
	await device.setHeadphoneMixMute(3, false)
	assert.deepEqual(hid.writes, requests(hid, 3, [0, 2], false))
	assertBus(device, hid, 3, [false, true, false, false])
})

test('an explicit mute of an already muted bus preserves hand-muted sends on unmute after restart', async (t) => {
	const hid = new FakeHid()
	for (let source = 0; source < hid.layout.sourceCount; source++)
		hid.cell(source, 2).properties.set('mixMute', V.bool(true))
	const first = await start(t, hid)
	await first.device.setHeadphoneMixMute(3, true)
	assert.deepEqual(first.disk.entries(), [{ headphone: 3, sources: [] }])
	first.crash()
	const restarted = await start(t, hid, first.disk)
	await restarted.device.setHeadphoneMixMute(3, false)
	assert.deepEqual(hid.writes, [])
	assertBus(restarted.device, hid, 3, [true, true, true, true])
})

test('connection configuration preserves mute ownership across restart for independent buses', async (t) => {
	const hid = new FakeHid()
	hid.cell(1, 2).properties.set('mixMute', V.bool(true))
	const first = await start(t, hid)
	await first.device.setHeadphoneMixMute(3, true)
	await first.device.setHeadphoneMixMute(4, true)
	const expected = [
		{ headphone: 3, sources: [0, 2, 3] },
		{ headphone: 4, sources: [0, 1, 2, 3] },
	]
	assert.deepEqual(first.disk.entries(), expected)
	first.crash()
	const restarted = await start(t, hid, first.disk)
	assert.deepEqual(restarted.device.headphoneMuteList(), expected)
	assertBus(restarted.device, hid, 3, [true, true, true, true])
	const beforeUnmute = hid.writes.length
	await restarted.device.setHeadphoneMixMute(3, false)
	assert.deepEqual(hid.writes.slice(beforeUnmute), requests(hid, 3, [0, 2, 3], false))
	assertBus(restarted.device, hid, 3, [false, true, false, false])
	assertBus(restarted.device, hid, 4, [true, true, true, true])
	assert.deepEqual(first.disk.entries(), [{ headphone: 4, sources: [0, 1, 2, 3] }])
	assert.equal(first.disk.read().stripNames, 'Synthetic A,Synthetic B')
})

test('disabled owned sends stay muted and remain recoverable when enabled again', async (t) => {
	const app = await start(t)
	await app.device.setHeadphoneMixMute(3, true)
	app.change(1, 2, 'mixDisabled', V.bool(true))
	app.hid.writes.length = 0
	await app.device.setHeadphoneMixMute(3, false)
	assert.deepEqual(app.hid.writes, requests(app.hid, 3, [0, 2, 3], false))
	assert.deepEqual(app.disk.entries(), [{ headphone: 3, sources: [1] }])
	app.change(1, 2, 'mixDisabled', V.bool(false))
	await app.device.setHeadphoneMixMute(3, false)
	assert.deepEqual(app.hid.writes.at(-1), requests(app.hid, 3, [1], false)[0])
	assert.deepEqual(app.disk.entries(), [])
})

for (const afterApply of [false, true]) {
	const timing = afterApply ? 'after' : 'before'
	test(`failed mute ${timing} applying the write is journaled and can be reversed without a desk echo`, async (t) => {
		const app = await start(t)
		const reject = async (request) => {
			const { source } = app.hid.layout.mixCellFromPath(request.path)
			assert.deepEqual(app.disk.entries(), [{ headphone: 3, sources: source === 0 ? [0] : [0, 1] }])
			if (source === 1) throw new Error('synthetic mute failure')
		}
		app.hid[afterApply ? 'afterWrite' : 'beforeWrite'] = reject
		await assert.rejects(app.device.setHeadphoneMixMute(3, true), /synthetic mute failure/)
		assert.deepEqual(app.disk.entries(), [{ headphone: 3, sources: [0, 1] }])
		app.hid.beforeWrite = async () => {}
		app.hid.afterWrite = async () => {}
		await app.device.setHeadphoneMixMute(3, false)
		assert.deepEqual(app.hid.writes.slice(2), requests(app.hid, 3, [0, 1], false))
		assertBus(app.device, app.hid, 3, [false, false, false, false])
		assert.deepEqual(app.disk.entries(), [])
	})

	test(`partial mute ${timing} applying a failed write survives restart and retry`, async (t) => {
		const first = await start(t)
		first.hid[afterApply ? 'afterWrite' : 'beforeWrite'] = async (request) => {
			if (first.hid.layout.mixCellFromPath(request.path).source === 1) throw new Error('synthetic mute failure')
		}
		await assert.rejects(first.device.setHeadphoneMixMute(3, true), /synthetic mute failure/)
		first.crash()
		first.hid.beforeWrite = async () => {}
		first.hid.afterWrite = async () => {}
		const restarted = await start(t, first.hid, first.disk)
		await restarted.device.setHeadphoneMixMute(3, true)
		assertBus(restarted.device, first.hid, 3, [true, true, true, true])
		assert.deepEqual(first.disk.entries(), [{ headphone: 3, sources: [0, 1, 2, 3] }])
		await restarted.device.setHeadphoneMixMute(3, false)
		assertBus(restarted.device, first.hid, 3, [false, false, false, false])
		assert.deepEqual(first.disk.entries(), [])
	})
}

test('partial unmute retains the failed and unattempted sends for retry', async (t) => {
	const app = await start(t)
	await app.device.setHeadphoneMixMute(3, true)
	app.hid.beforeWrite = async (request) => {
		if (app.hid.layout.mixCellFromPath(request.path).source === 1) throw new Error('synthetic unmute failure')
	}
	await assert.rejects(app.device.setHeadphoneMixMute(3, false), /synthetic unmute failure/)
	assert.deepEqual(app.disk.entries(), [{ headphone: 3, sources: [1, 2, 3] }])
	app.hid.beforeWrite = async () => {}
	app.hid.writes.length = 0
	await app.device.setHeadphoneMixMute(3, false)
	assert.deepEqual(app.hid.writes, requests(app.hid, 3, [1, 2, 3], false))
	assert.deepEqual(app.disk.entries(), [])
})

test('an unmute queued during mute waits and restores only the sends acquired by that mute', async (t) => {
	const hid = new FakeHid()
	hid.cell(2, 2).properties.set('mixMute', V.bool(true))
	const app = await start(t, hid)
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	hid.beforeWrite = async (request) => {
		if (request.value && hid.layout.mixCellFromPath(request.path).source === 0) {
			entered.resolve()
			await resume.promise
		}
	}
	const muting = app.device.setHeadphoneMixMute(3, true)
	await entered.promise
	const unmuting = app.device.setHeadphoneMixMute(3, false)
	await Promise.resolve()
	assert.deepEqual(hid.writes, requests(hid, 3, [0], true), 'queued unmute must not race the pending mute')
	resume.resolve()
	await Promise.all([muting, unmuting])
	assert.deepEqual(hid.writes, [...requests(hid, 3, [0, 1, 3], true), ...requests(hid, 3, [0, 1, 3], false)])
	assertBus(app.device, hid, 3, [false, false, true, false])
	assert.deepEqual(app.disk.entries(), [])
})

test('desk changes during a pending write protect sends subsequently muted by hand or disabled', async (t) => {
	const app = await start(t)
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	app.hid.beforeWrite = async (request) => {
		if (request.value && app.hid.layout.mixCellFromPath(request.path).source === 0) {
			entered.resolve()
			await resume.promise
		}
	}
	const muting = app.device.setHeadphoneMixMute(3, true)
	await entered.promise
	app.change(1, 2, 'mixMute', V.bool(true))
	app.change(2, 2, 'mixDisabled', V.bool(true))
	resume.resolve()
	await muting
	assert.deepEqual(app.hid.writes, requests(app.hid, 3, [0, 3], true))
	assert.deepEqual(app.disk.entries(), [{ headphone: 3, sources: [0, 3] }])
	await app.device.setHeadphoneMixMute(3, false)
	assertBus(app.device, app.hid, 3, [false, true, false, false])
})

test('a recorded source absent from the current layout remains pending without addressing another output', async (t) => {
	const disk = journal(t, [{ headphone: 3, sources: [0, 10] }])
	const hid = new FakeHid()
	hid.cell(0, 2).properties.set('mixMute', V.bool(true))
	const { device } = await start(t, hid, disk)
	await device.setHeadphoneMixMute(3, false)
	assert.deepEqual(hid.writes, requests(hid, 3, [0], false))
	assert.deepEqual(disk.entries(), [{ headphone: 3, sources: [10] }])
})

test('feedback and monitor variables follow optimistic writes and incoming mute and disabled changes', async (t) => {
	const app = await start(t)
	const feedback = app.instance.feedbacks.headphone_mix_muted
	assert.equal(feedback.type, 'boolean')
	assert.deepEqual(feedback.defaultStyle, { bgcolor: 0xcc0000, color: 0xffffff })
	for (const headphone of [1, 2, 3, 4]) {
		assert.ok(app.instance.variables[`headphone${headphone}_muted`])
		assert.equal(app.values[`headphone${headphone}_muted`], false)
		assert.equal(feedback.callback({ options: { headphone } }), false)
	}
	await app.device.setHeadphoneMixMute(3, true)
	assert.equal(app.values.headphone3_muted, true)
	assert.equal(feedback.callback({ options: { headphone: 3 } }), true)
	assert.equal(app.values.headphone2_muted, false)
	app.checkedFeedbacks.length = 0
	app.updates.length = 0
	app.change(2, 2, 'mixMute', V.bool(false))
	assert.equal(app.values.headphone3_muted, false)
	assert.equal(feedback.callback({ options: { headphone: 3 } }), false)
	assert.ok(app.checkedFeedbacks.includes('headphone_mix_muted'))
	assert.ok(app.updates.includes('monitor'))
	app.change(2, 2, 'mixDisabled', V.bool(true))
	assert.equal(app.values.headphone3_muted, true)
	assert.equal(feedback.callback({ options: { headphone: 3 } }), true)
	app.device.ready = false
	app.instance.onUpdate('monitor')
	assert.equal(app.values.headphone3_muted, false)
	assert.equal(feedback.callback({ options: { headphone: 3 } }), false)
})

test('headphone action supports on, off and toggle and each Monitoring preset selects its own bus', async (t) => {
	const app = await start(t)
	const action = app.instance.actions.headphone_mix_mute
	assert.equal(action.name, 'Headphones: Mute one headphone mix')
	assert.deepEqual(
		action.options.find((field) => field.id === 'headphone').choices.map((choice) => choice.id),
		[1, 2, 3, 4],
	)
	for (const [mode, expected] of [
		['on', true],
		['on', true],
		['off', false],
		['toggle', true],
		['toggle', false],
	]) {
		await action.callback({ options: { headphone: '3', mode } })
		assert.equal(app.device.headphoneMixMuted(3), expected)
	}
	const category = app.instance.sections.find((section) => section.name === 'Monitoring')
	for (const headphone of [1, 2, 3, 4]) {
		const id = `headphone${headphone}_mute`
		const preset = app.instance.presets[id]
		assert.ok(category.definitions.includes(id))
		assert.equal(preset.style.text, `HP${headphone}\\nMUTE`)
		assert.deepEqual(preset.steps, [
			{ down: [{ actionId: 'headphone_mix_mute', options: { headphone, mode: 'toggle' } }], up: [] },
		])
		assert.deepEqual(preset.feedbacks, [
			{ feedbackId: 'headphone_mix_muted', options: { headphone }, style: { bgcolor: 0xcc0000, color: 0xffffff } },
		])
	}
	assert.deepEqual(
		app.logs.filter(({ level }) => level === 'warn'),
		[],
	)
})

test('overlapping action toggles complete a mute and unmute while preserving hand-muted sends', async (t) => {
	const hid = new FakeHid()
	hid.cell(2, 2).properties.set('mixMute', V.bool(true))
	const app = await start(t, hid)
	const entered = Promise.withResolvers()
	const resume = Promise.withResolvers()
	t.after(() => resume.resolve())
	hid.beforeWrite = async (request) => {
		if (request.value && hid.layout.mixCellFromPath(request.path).source === 0) {
			entered.resolve()
			await resume.promise
		}
	}
	const action = app.instance.actions.headphone_mix_mute
	const first = action.callback({ options: { headphone: 3, mode: 'toggle' } })
	await entered.promise
	assert.equal(app.values.headphone3_muted, false)
	const second = action.callback({ options: { headphone: 3, mode: 'toggle' } })
	resume.resolve()
	await Promise.all([first, second])
	assert.deepEqual(hid.writes, [...requests(hid, 3, [0, 1, 3], true), ...requests(hid, 3, [0, 1, 3], false)])
	assertBus(app.device, hid, 3, [false, false, true, false])
	assert.equal(app.values.headphone3_muted, false)
	assert.deepEqual(app.disk.entries(), [])
})

test('a failed headphone action does not prevent later actions from retrying or unmuting', async (t) => {
	const app = await start(t)
	app.hid.beforeWrite = async () => {
		throw new Error('synthetic action mute failure')
	}
	const action = app.instance.actions.headphone_mix_mute
	await action.callback({ options: { headphone: 3, mode: 'on' } })
	assert.ok(
		app.logs.some(({ level, message }) => level === 'warn' && message.includes('synthetic action mute failure')),
	)
	app.hid.beforeWrite = async () => {}
	await action.callback({ options: { headphone: 3, mode: 'on' } })
	assertBus(app.device, app.hid, 3, [true, true, true, true])
	await action.callback({ options: { headphone: 3, mode: 'off' } })
	assertBus(app.device, app.hid, 3, [false, false, false, false])
	assert.deepEqual(app.disk.entries(), [])
})

test('panic release preserves headphone mixes muted before and during panic', async (t) => {
	const app = await start(t)
	await app.device.setHeadphoneMixMute(3, true)
	const beforePanic = app.hid.writes.length
	await app.device.panic()
	assert.equal(app.device.panicActive, true)
	assert.ok(app.hid.writes.slice(beforePanic).every(({ name }) => name !== 'mixMute'))
	await app.device.setHeadphoneMixMute(4, true)
	const beforeRelease = app.hid.writes.length
	await app.device.releasePanic()
	assert.equal(app.device.panicActive, false)
	assert.ok(app.hid.writes.slice(beforeRelease).every(({ name }) => name !== 'mixMute'))
	assertBus(app.device, app.hid, 3, [true, true, true, true])
	assertBus(app.device, app.hid, 4, [true, true, true, true])
	assert.equal(app.device.headphonesOff, false)
	assert.equal(app.device.monitorMuted, false)
	await app.device.setHeadphoneMixMute(3, false)
	assertBus(app.device, app.hid, 3, [false, false, false, false])
	assertBus(app.device, app.hid, 4, [true, true, true, true])
})

test('invalid headphone numbers cannot address any output', async (t) => {
	const { device, hid } = await start(t)
	for (const headphone of [0, 5, -1, 1.5, NaN, Infinity]) {
		assert.equal(device.headphoneMixMuted(headphone), false)
		await assert.rejects(device.setHeadphoneMixMute(headphone, true))
		await assert.rejects(device.setHeadphoneMixMute(headphone, false))
	}
	assert.deepEqual(hid.writes, [])
})

test('a connected bus with every send disabled is muted, but a disconnected bus is not', async (t) => {
	const hid = new FakeHid()
	for (let source = 0; source < hid.layout.sourceCount; source++)
		hid.cell(source, 2).properties.set('mixDisabled', V.bool(true))
	const { device } = await start(t, hid)
	assert.equal(device.headphoneMixMuted(3), true)
	await device.setHeadphoneMixMute(3, true)
	await device.setHeadphoneMixMute(3, false)
	assert.deepEqual(hid.writes, [])
	device.ready = false
	assert.equal(device.headphoneMixMuted(3), false)
})
