import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V } from '../src/protocol/juce-var.js'
import { parseMixLevel } from '../src/model.js'
import { RoutingController, parseRoutingPresets } from '../src/routing-presets.js'
import { routingState, setCellLevel, setCellState, setMode } from '../src/routing.js'
import { RoutingDevice } from './helpers/routing-device.js'

function pair(options) {
	const device = new RoutingDevice(options)
	const routing = new RoutingController(device)
	return { device, routing }
}

function deferred() {
	let resolve
	const promise = new Promise((done) => (resolve = done))
	return { promise, resolve }
}

function requests(device) {
	return device.writes.map(({ path, name, value }) => ({ path, name, value }))
}

test('saving captures every output and source, including unassigned sources and null output modes', async () => {
	const { device, routing } = pair()
	const persisted = []
	routing.onPresetsChanged = (presets) => {
		assert.equal(routing.listPresets().length, presets.length, 'new definitions are visible during persistence')
		persisted.push(presets)
	}
	device.setCell(18, 12, { state: 'off', level: 0.37, anchor: 0.9 })
	const saved = await routing.savePreset('  Studio  ')
	assert.match(saved.id, /^[0-9a-f-]{36}$/)
	assert.equal(saved.name, 'Studio')
	assert.equal(persisted.length, 1)
	assert.equal(persisted[0][0].outputs.length, 13)
	assert.ok(persisted[0][0].outputs.every((output) => output.cells.length === 19))
	assert.equal(persisted[0][0].outputs[12].mode, null)
	assert.deepEqual(persisted[0][0].outputs[12].cells[18], { source: 18, state: 'off', level: 0.37 })
	assert.deepEqual(routing.listPresets(), [saved])
	assert.equal(routing.matchingPreset(), 'Studio')
	assert.deepEqual(device.writes, [])
	persisted[0][0].name = 'Callback must not mutate controller state'
	assert.equal(routing.presets[0].name, 'Studio')
})

test('stored snapshots preserve the discovered source count on older firmware', async () => {
	const { routing } = pair({ sourceCount: 17 })
	await routing.savePreset('Older firmware')
	const parsed = parseRoutingPresets(JSON.stringify(routing.presets))
	assert.equal(parsed[0].outputs[0].cells.length, 17)
	assert.deepEqual(parsed, routing.presets)
})

test('rename retains stable id and routing data, delete persists removal, and failed persistence rolls back', async () => {
	const { routing } = pair()
	const saved = await routing.savePreset('First')
	const outputs = structuredClone(routing.presets[0].outputs)
	assert.deepEqual(await routing.renamePreset(saved.id, '  Renamed '), { id: saved.id, name: 'Renamed' })
	assert.deepEqual(routing.presets[0].outputs, outputs)
	routing.onPresetsChanged = () => {
		throw new Error('config save failed')
	}
	await assert.rejects(routing.deletePreset(saved.id), /config save failed/)
	assert.deepEqual(routing.listPresets(), [{ id: saved.id, name: 'Renamed' }])
	const changes = []
	routing.onPresetsChanged = (presets) => changes.push(presets)
	await routing.deletePreset(saved.id)
	assert.deepEqual(changes, [[]])
	assert.deepEqual(routing.listPresets(), [])
	assert.equal(routing.matchingPreset(), '')
})

test('loading a matching snapshot emits no writes', async () => {
	const { device, routing } = pair()
	const saved = await routing.savePreset('Same')
	await routing.loadPreset(saved.id)
	assert.deepEqual(device.writes, [])
})

test('load applies Custom first, all changed states before levels, and the target mode last', async () => {
	const { device, routing } = pair()
	device.setCell(0, 0, { state: 'unlink', level: 0.3 })
	device.setCell(1, 0, { state: 'off', level: 0.2 })
	device.setOutputMode(1, 0)
	device.setCell(2, 1, { state: 'off', level: 0.4 })
	const saved = await routing.savePreset('Restore')
	device.setOutputMode(0, 0)
	device.setCell(0, 0)
	device.setCell(1, 0)
	device.setOutputMode(1, 2)
	device.setCell(2, 1)
	await routing.loadPreset(saved.id)
	const cell00 = device.layout.mixCellPath(0, 0)
	const cell10 = device.layout.mixCellPath(1, 0)
	const cell21 = device.layout.mixCellPath(2, 1)
	assert.deepEqual(requests(device), [
		{ path: device.layout.runPath('mixMinuses', 0), name: 'outputMixMinus', value: 2 },
		{ path: cell00, name: 'mixUnlinkRequest', value: Buffer.from([1, 1, 2, 1, 1, 2]) },
		{ path: cell10, name: 'mixDisabled', value: true },
		{ path: cell10, name: 'mixMute', value: true },
		{ path: cell00, name: 'mixLevelWithAnchor', value: '0.300000|0.600000' },
		{ path: cell10, name: 'mixLevelWithAnchor', value: '0.200000|0.600000' },
		{ path: cell21, name: 'mixDisabled', value: true },
		{ path: cell21, name: 'mixMute', value: true },
		{ path: cell21, name: 'mixLevelWithAnchor', value: '0.400000|0.600000' },
		{ path: device.layout.runPath('mixMinuses', 1), name: 'outputMixMinus', value: 0 },
	])
	assert.equal(routing.presetMatches(saved.id), true)
})

test('off to unlink restores enabled flags through link then unlink and restores the saved level after relink', async () => {
	const { device, routing } = pair()
	device.setCell(0, 0, { state: 'unlink', level: 0.3, anchor: 0.8 })
	device.setCell(1, 0, { state: 'link', level: 0.4, anchor: 0.9 })
	const saved = await routing.savePreset('Unmuted')
	device.setCell(0, 0, { state: 'off', level: 0.3, anchor: 0.8 })
	device.setCell(1, 0, { state: 'unlink', level: 0.4, anchor: 0.9 })
	await routing.loadPreset(saved.id)
	assert.deepEqual(
		device.writes.map(({ name }) => name),
		[
			'mixDisabled',
			'mixMute',
			'mixLinkRequest',
			'mixUnlinkRequest',
			'mixDisabled',
			'mixMute',
			'mixLinkRequest',
			'mixLevelWithAnchor',
			'mixLevelWithAnchor',
		],
	)
	assert.equal(routing.presetMatches(saved.id), true)
	assert.equal(device.propBool(device.layout.mixCellPath(0, 0), 'mixDisabled'), false)
	assert.equal(device.propBool(device.layout.mixCellPath(0, 0), 'mixMute'), false)
	assert.deepEqual(parseMixLevel(device.propString(device.layout.mixCellPath(1, 0), 'mixLevelWithAnchor')), {
		level: 0.4,
		anchor: 0.9,
	})
})

test('load restores cells on outputs without mode nodes and never invents their modes', async () => {
	const { device, routing } = pair()
	device.setCell(18, 12, { state: 'off', level: 0.2 })
	const saved = await routing.savePreset('CallMe')
	device.setCell(18, 12)
	await routing.loadPreset(saved.id)
	assert.deepEqual(
		device.writes.map(({ name }) => name),
		['mixDisabled', 'mixMute', 'mixLevelWithAnchor'],
	)
	assert.equal(routing.presetMatches(saved.id), true)
})

test('direct edits use the same safe state sequence and write an explicit level after relinking', async () => {
	const { device, routing } = pair()
	device.setCell(0, 0, { state: 'off', level: 0.3, anchor: 0.8 })
	await routing.setCell(0, 0, { state: 'unlink', level: 0.3 })
	assert.deepEqual(
		device.writes.map(({ name }) => name),
		['mixDisabled', 'mixMute', 'mixLinkRequest', 'mixUnlinkRequest', 'mixLevelWithAnchor'],
	)
	assert.equal(routingState(device).outputs[0].cells[0].level, 0.3)
	device.writes.length = 0
	await routing.setCell(0, 0, { state: 'unlink', level: 0.3 })
	await routing.setMode(0, 2)
	assert.deepEqual(device.writes, [])
})

test('match covers every mode, state and level, tolerates 0.005, and ignores anchors', async () => {
	const { device, routing } = pair()
	const saved = await routing.savePreset('Match')
	device.setCell(18, 12, { state: 'link', level: 0.605, anchor: 0.1 })
	assert.equal(routing.presetMatches(saved.id), true)
	device.setCell(18, 12, { state: 'link', level: 0.605001, anchor: 0.1 })
	assert.equal(routing.presetMatches(saved.id), false)
	assert.equal(routing.matchingPreset(), '')
	device.setCell(18, 12)
	device.setOutputMode(9, 1)
	assert.equal(routing.presetMatches(saved.id), false)
	device.setOutputMode(9, 2)
	device.cell(18, 12).properties.set('mixDisabled', V.bool(true))
	assert.equal(routing.presetMatches(saved.id), false)
	device.setCell(18, 12)
	assert.equal(routing.matchingPreset(), 'Match')
	assert.equal(routing.presetMatches('unknown'), false)
	device.ready = false
	assert.equal(routing.presetMatches(saved.id), false)
	assert.equal(routing.matchingPreset(), '')
})

test('independent headphone mutes do not change preset state or get cleared by an unchanged load', async () => {
	const { device, routing } = pair()
	device.cell(0, 0).properties.set('mixMute', V.bool(true))
	const saved = await routing.savePreset('Muted headphones')
	assert.equal(routing.presets[0].outputs[0].cells[0].state, 'link')
	assert.equal(routing.presetMatches(saved.id), true)
	await routing.loadPreset(saved.id)
	assert.deepEqual(device.writes, [])
	assert.equal(device.cell(0, 0).properties.get('mixMute').value, true)
	device.cell(0, 0).properties.set('mixMute', V.bool(false))
	assert.equal(routing.presetMatches(saved.id), true)
})

test('load is one queue transaction: slider writes and save snapshots cannot interleave', async () => {
	const { device, routing } = pair()
	device.setCell(0, 0, { state: 'off', level: 0.3 })
	const saved = await routing.savePreset('Restore')
	device.setCell(0, 0)
	const entered = deferred()
	const release = deferred()
	device.beforeWrite = async () => {
		entered.resolve()
		await release.promise
	}
	const loading = routing.loadPreset(saved.id)
	await entered.promise
	const slider = routing.setCell(1, 0, { level: 0.9 })
	const saving = routing.savePreset('After slider')
	assert.deepEqual(device.writes, [])
	release.resolve()
	await Promise.all([loading, slider, saving])
	assert.deepEqual(
		device.writes.map(({ name }) => name),
		['mixDisabled', 'mixMute', 'mixLevelWithAnchor', 'mixLevelWithAnchor'],
	)
	assert.equal(device.writes.at(-1).value, '0.900000|0.600000')
	assert.equal(routing.presets[1].outputs[0].cells[1].level, 0.9)
})

test('queued work rechecks readiness, does not run on a replacement tree, and recovers after rejection', async () => {
	const { device, routing } = pair()
	const entered = deferred()
	const release = deferred()
	device.beforeWrite = async () => {
		entered.resolve()
		await release.promise
	}
	const first = routing.setCell(0, 0, { state: 'off' })
	const firstRejected = assert.rejects(first, { statusCode: 503 })
	await entered.promise
	const second = routing.setCell(1, 0, { level: 0.7 })
	const secondRejected = assert.rejects(second, { statusCode: 503 })
	device.ready = false
	release.resolve()
	await Promise.all([firstRejected, secondRejected])
	assert.deepEqual(device.writes, [])
	device.ready = true
	const queued = routing.setCell(1, 0, { level: 0.7 })
	device.tree = new RoutingDevice().tree
	await assert.rejects(queued, { statusCode: 503 })
	device.beforeWrite = async () => {}
	await routing.setCell(1, 0, { level: 0.7 })
	assert.equal(device.writes.length, 1)
})

test('a disconnect during a primitive sequence stops the remaining writes', async () => {
	const { device, routing } = pair()
	device.afterWrite = async () => {
		device.ready = false
	}
	await assert.rejects(routing.setCell(0, 0, { state: 'off' }), { statusCode: 503 })
	assert.deepEqual(
		device.writes.map(({ name }) => name),
		['mixDisabled'],
	)
})

test('controller rejects malformed integers, state, level and combined edits without partial writes', async () => {
	const { device, routing } = pair()
	for (const index of ['0', null, undefined, true, -1, 0.5, NaN, Infinity, 19]) {
		await assert.rejects(routing.setCell(index, 0, { state: 'off' }), { statusCode: 400 })
	}
	for (const index of ['0', null, false, -1, 0.5, 13]) {
		await assert.rejects(routing.setCell(0, index, { level: 0.1 }), { statusCode: 400 })
		await assert.rejects(routing.setMode(index, 2), { statusCode: 400 })
	}
	for (const mode of ['2', null, false, -1, 0.5, 3]) {
		await assert.rejects(routing.setMode(0, mode), { statusCode: 400 })
	}
	for (const level of ['0.2', null, false, NaN, Infinity, -0.01, 1.01]) {
		await assert.rejects(routing.setCell(0, 0, { state: 'off', level }), { statusCode: 400 })
	}
	for (const state of ['linked', '', null, true, 1, {}, []]) {
		await assert.rejects(routing.setCell(0, 0, { state, level: 0.1 }), { statusCode: 400 })
	}
	for (const edit of [undefined, null, [], 'off', {}, { state: undefined }]) {
		await assert.rejects(routing.setCell(0, 0, edit), { statusCode: 400 })
	}
	await assert.rejects(routing.setMode(12, 2), { statusCode: 400 })
	await assert.rejects(routing.setCell(0, 12, { level: 0.1 }), { statusCode: 400 })
	for (const mode of [0, 1]) {
		device.setOutputMode(0, mode)
		await assert.rejects(routing.setCell(0, 0, { state: 'off' }), { statusCode: 400 })
	}
	assert.deepEqual(device.writes, [])
})

test('preset names, duplicate names, ids and disconnected CRUD requests are validated', async () => {
	const { device, routing } = pair()
	for (const name of ['', '  ', null, true, 123, [], {}, 'x'.repeat(81)]) {
		await assert.rejects(routing.savePreset(name), { statusCode: 400 })
	}
	const first = await routing.savePreset('First')
	const second = await routing.savePreset('Second')
	await assert.rejects(routing.savePreset(' First '), { statusCode: 409 })
	await assert.rejects(routing.renamePreset(second.id, 'First'), { statusCode: 409 })
	await assert.rejects(routing.renamePreset(first.id, ' '), { statusCode: 400 })
	await assert.rejects(routing.loadPreset(null), { statusCode: 400 })
	await assert.rejects(routing.loadPreset('missing'), { statusCode: 404 })
	await assert.rejects(routing.renamePreset('missing', 'Name'), { statusCode: 404 })
	await assert.rejects(routing.deletePreset('missing'), { statusCode: 404 })
	device.ready = false
	for (const operation of [
		() => routing.savePreset('Disconnected'),
		() => routing.renamePreset(first.id, 'Disconnected'),
		() => routing.deletePreset(first.id),
		() => routing.loadPreset(first.id),
		() => routing.setMode(0, 2),
		() => routing.setCell(0, 0, { level: 0.1 }),
	]) {
		await assert.rejects(operation(), { statusCode: 503 })
	}
	assert.equal(routing.listPresets().length, 2)
	assert.deepEqual(device.writes, [])
})

test('invalid persisted snapshots are ignored without accepting duplicate ids or names', async () => {
	const { routing } = pair()
	await routing.savePreset('Valid')
	const good = routing.presets[0]
	for (const value of [undefined, null, false, {}, 'invalid json', '{}']) {
		assert.deepEqual(parseRoutingPresets(value), [])
	}
	const malformed = [
		{ ...good, id: 'invalid' },
		{ ...good, name: '  ' },
		{ ...good, outputs: good.outputs.slice(1) },
		{ ...good, outputs: good.outputs.map((output) => ({ ...output, mode: '2' })) },
		{ ...good, outputs: good.outputs.map((output) => ({ ...output, cells: output.cells.slice(1) })) },
		{
			...good,
			outputs: good.outputs.map((output) => ({
				...output,
				cells: output.cells.map((cell) => ({ ...cell, level: 4 })),
			})),
		},
		{
			...good,
			outputs: good.outputs.map((output) => ({
				...output,
				cells: output.cells.map((cell) => ({ ...cell, state: 'bad' })),
			})),
		},
	]
	for (const bad of malformed) assert.deepEqual(parseRoutingPresets([bad, good]), [good])
	assert.deepEqual(parseRoutingPresets([good, good, { ...good, id: '00000000-0000-0000-0000-000000000000' }]), [good])
})

test('load validates the entire snapshot and connected layout before any writes', async () => {
	const { device, routing } = pair()
	const saved = await routing.savePreset('Target')
	device.setOutputMode(0, 0)
	routing.presets[0].outputs[12].cells[18].level = 2
	await assert.rejects(routing.loadPreset(saved.id), { statusCode: 400 })
	routing.presets[0].outputs[12].cells[18].level = 0.6
	routing.presets[0].outputs[12].mode = 2
	await assert.rejects(routing.loadPreset(saved.id), { statusCode: 400 })
	const other = pair({ sourceCount: 17 })
	const old = await other.routing.savePreset('Old')
	routing.presets = other.routing.presets
	await assert.rejects(routing.loadPreset(old.id), { statusCode: 400 })
	assert.deepEqual(device.writes, [])
})

test('routing primitives reject invalid values without coercing or clamping them', async () => {
	const { device } = pair()
	await assert.rejects(setMode(device, '0', 2), { statusCode: 400 })
	await assert.rejects(setMode(device, 0, '2'), { statusCode: 400 })
	await assert.rejects(setMode(device, 10, 2), { statusCode: 400 })
	await assert.rejects(setCellState(device, 0.5, 0, 'off'), { statusCode: 400 })
	await assert.rejects(setCellState(device, 0, '0', 'off'), { statusCode: 400 })
	await assert.rejects(setCellState(device, 0, 0, 'invalid'), { statusCode: 400 })
	for (const level of [-1, 2, NaN, Infinity, null, '0.2', false])
		await assert.rejects(setCellLevel(device, 0, 0, level), { statusCode: 400 })
	assert.deepEqual(device.writes, [])
	device.ready = false
	await assert.rejects(setMode(device, 0, 2), { statusCode: 503 })
	await assert.rejects(setCellState(device, 0, 0, 'off'), { statusCode: 503 })
	await assert.rejects(setCellLevel(device, 0, 0, 0.5), { statusCode: 503 })
})
