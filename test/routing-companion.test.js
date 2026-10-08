import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { updateActions } from '../src/actions.js'
import { updateFeedbacks } from '../src/feedbacks.js'
import { updatePresets } from '../src/presets.js'
import { updateVariableDefinitions, updateVariableValues } from '../src/variables.js'
import { V } from '../src/protocol/juce-var.js'
import { RoutingDevice } from './helpers/routing-device.js'

// Keep the real instance and notification handlers; importing them must never discover USB devices.
const stubs = {
	'node-hid': `
		const forbidden = () => { throw new Error('real HID access forbidden in routing Companion tests') }
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
		if (Object.hasOwn(stubs, specifier))
			return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
		return nextResolve(specifier, context)
	},
})
const { RodecasterInstance } = await import('../src/main.js')
hooks.deregister()

function companion() {
	const saved = [
		{ id: 'studio', name: 'Studio' },
		{ id: 'interview', name: 'Interview' },
	]
	const loaded = []
	const logs = []
	const values = {}
	const app = {
		device: {
			ready: true,
			strips: () => [],
			fxSlotCount: 4,
			capabilities: { model: 'Pro II', firmware: '1.7.3' },
			monitorLevel: 0.5,
			bluetoothLevel: 0.5,
			headphoneMixMuted: () => false,
			recordState: 0,
			recordElapsedSeconds: 0,
			padBank: 0,
			pad: () => null,
			fxOn: () => false,
		},
		routing: {
			listPresets: () => saved,
			loadPreset: async (id) => loaded.push(id),
			presetMatches: (id) => id === 'studio',
			matchingPreset: () => 'Studio',
		},
		setActionDefinitions: (definitions) => (app.actions = definitions),
		setFeedbackDefinitions: (definitions) => (app.feedbacks = definitions),
		setPresetDefinitions: (sections, definitions) => {
			app.sections = sections
			app.presets = definitions
		},
		setVariableDefinitions: (definitions) => (app.variables = definitions),
		setVariableValues: (next) => Object.assign(values, next),
		log: (level, message) => logs.push({ level, message }),
	}
	return { app, saved, loaded, logs, values }
}

function definitions(app) {
	updateActions(app)
	updateFeedbacks(app)
	updatePresets(app)
	updateVariableDefinitions(app)
}

test('routing buttons load their saved IDs and use active feedback in the Routing category', async () => {
	const { app, loaded } = companion()
	definitions(app)
	const section = app.sections.find((section) => section.id === 'routing')
	assert.equal(section.name, 'Routing')
	assert.deepEqual(section.definitions, ['routing_studio', 'routing_interview'])
	const button = app.presets.routing_interview
	assert.equal(button.name, 'Interview')
	assert.equal(button.type, 'simple')
	assert.equal(button.style.text, 'ROUTING\\nInterview')
	const action = button.steps[0].down[0]
	assert.equal(app.actions[action.actionId].name, 'Routing: load preset')
	await app.actions[action.actionId].callback({ options: action.options })
	assert.deepEqual(loaded, ['interview'])
	const feedback = button.feedbacks[0]
	assert.equal(app.feedbacks[feedback.feedbackId].name, 'Routing preset active')
	assert.deepEqual(feedback.options, { preset: 'interview' })
	assert.deepEqual(feedback.style, { bgcolor: 0x009900, color: 0xffffff })
})

test('routing choices rebuild after save, rename and delete while existing action IDs stay usable', async () => {
	const { app, saved, loaded } = companion()
	definitions(app)
	const existingAction = app.presets.routing_studio.steps[0].down[0]
	saved[0].name = 'Live studio'
	saved.splice(1, 1, { id: 'podcast', name: 'Podcast' })
	definitions(app)
	for (const definition of [app.actions.routing_load_preset, app.feedbacks.routing_preset_active]) {
		assert.deepEqual(definition.options[0].choices, [
			{ id: 'studio', label: 'Live studio' },
			{ id: 'podcast', label: 'Podcast' },
		])
	}
	assert.equal(app.presets.routing_studio.name, 'Live studio')
	assert.equal(app.presets.routing_interview, undefined)
	assert.ok(app.presets.routing_podcast)
	await app.actions[existingAction.actionId].callback({ options: existingAction.options })
	assert.deepEqual(loaded, ['studio'])
})

test('routing action reports a rejected load in the Companion log', async () => {
	const { app, logs } = companion()
	app.routing.loadPreset = async () => {
		throw new Error('desk not ready')
	}
	updateActions(app)
	await app.actions.routing_load_preset.callback({ options: { preset: 'studio' } })
	assert.deepEqual(logs, [{ level: 'warn', message: 'routing load preset: desk not ready' }])
})

test('routing active feedback follows matching state and is false after disconnection', () => {
	const { app } = companion()
	updateFeedbacks(app)
	const feedback = app.feedbacks.routing_preset_active
	assert.equal(feedback.type, 'boolean')
	assert.equal(feedback.callback({ options: { preset: 'studio' } }), true)
	assert.equal(feedback.callback({ options: { preset: 'interview' } }), false)
	assert.equal(feedback.callback({ options: { preset: 'deleted' } }), false)
	app.device.ready = false
	assert.equal(feedback.callback({ options: { preset: 'studio' } }), false)
})

test('routing variable refreshes for each routing-related device area and clears stale matches', () => {
	const { app, values } = companion()
	updateVariableDefinitions(app)
	assert.ok(app.variables.routing_preset)
	for (const area of ['all', 'strips', 'monitor', 'system', 'routing']) {
		app.device.ready = true
		app.routing.matchingPreset = () => 'Studio'
		updateVariableValues(app, area)
		assert.equal(values.routing_preset, 'Studio', area)
		app.routing.matchingPreset = () => ''
		updateVariableValues(app, area)
		assert.equal(values.routing_preset, '', `${area}: changed routing`)
		app.routing.matchingPreset = () => 'Studio'
		app.device.ready = false
		updateVariableValues(app, area)
		assert.equal(values.routing_preset, '', `${area}: disconnected`)
	}
})

test('empty routing presets leave usable definitions without phantom buttons or active status', () => {
	const { app, saved, values } = companion()
	saved.length = 0
	app.routing.matchingPreset = () => ''
	definitions(app)
	assert.equal(app.actions.routing_load_preset.options[0].default, '')
	assert.equal(app.feedbacks.routing_preset_active.options[0].default, '')
	assert.equal(app.feedbacks.routing_preset_active.callback({ options: { preset: '' } }), false)
	assert.equal(
		app.sections.find((section) => section.id === 'routing'),
		undefined,
	)
	updateVariableValues(app, 'all')
	assert.equal(values.routing_preset, '')
	// Definition builders also run before a routing controller is available in older integrations.
	delete app.routing
	definitions(app)
	updateVariableValues(app, 'all')
	assert.equal(values.routing_preset, '')
	assert.equal(app.feedbacks.routing_preset_active.callback({ options: { preset: '' } }), false)
})

test('desk notifications, optimistic mode writes and saved-preset edits refresh real Companion state', async (t) => {
	const app = new RodecasterInstance({})
	const device = app.device
	const synthetic = new RoutingDevice()
	const values = {}
	const checked = []
	const saved = []
	device.session.tree = synthetic.tree
	device.session.layout = synthetic.layout
	device.session.capabilities = { model: 'pro2', firmware: '1.7.3' }
	device.ready = true
	device.start = () => {}
	device.connectionGuard = () => () => {}
	device.write = async (path, name, value) => device.tree.getByPath(path).properties.set(name, value)
	app.log = () => {}
	app.updateStatus = () => {}
	app.saveConfig = (config) => saved.push(structuredClone(config))
	app.setActionDefinitions = (definitions) => (app.actions = definitions)
	app.setFeedbackDefinitions = (definitions) => (app.feedbacks = definitions)
	app.setPresetDefinitions = (sections, definitions) => {
		app.sections = sections
		app.presets = definitions
	}
	app.setVariableDefinitions = () => {}
	app.setVariableValues = (next) => Object.assign(values, next)
	app.checkAllFeedbacks = () => checked.push('all')
	app.checkFeedbacks = (...ids) => checked.push(...ids)
	await app.init({})
	t.after(() => clearInterval(app.clockTimer))
	const { id } = await app.routing.savePreset('Studio')
	const isActive = () => app.feedbacks.routing_preset_active.callback({ options: { preset: id } })
	assert.equal(values.routing_preset, 'Studio')
	assert.equal(isActive(), true)
	assert.equal(app.actions.routing_load_preset.options[0].choices[0].label, 'Studio')
	assert.ok(app.presets[`routing_${id}`])

	const change = (path, name, value) => {
		checked.length = 0
		device.tree.getByPath(path).properties.set(name, value)
		device.onChange({ path, name, value })
		assert.ok(checked.includes('routing_preset_active'), name)
	}
	const cell = device.layout.mixCellPath(0, 7)
	change(cell, 'mixLevelWithAnchor', V.string('0.4|0.6'))
	assert.equal(values.routing_preset, '')
	assert.equal(isActive(), false)
	change(cell, 'mixLevelWithAnchor', V.string('0.6|0.6'))
	assert.equal(values.routing_preset, 'Studio')
	assert.equal(isActive(), true)
	change(device.layout.runPath('mixMinuses', 7), 'outputMixMinus', V.int(0))
	assert.equal(values.routing_preset, '')
	assert.equal(isActive(), false)
	checked.length = 0
	await app.routing.setMode(7, 2)
	assert.ok(checked.includes('routing_preset_active'))
	assert.equal(values.routing_preset, 'Studio')
	assert.equal(isActive(), true)

	await app.routing.renamePreset(id, 'Live studio')
	assert.equal(values.routing_preset, 'Live studio')
	assert.equal(app.actions.routing_load_preset.options[0].choices[0].label, 'Live studio')
	assert.equal(app.presets[`routing_${id}`].name, 'Live studio')
	assert.equal(JSON.parse(saved.at(-1).routingPresets)[0].name, 'Live studio')
	await app.routing.deletePreset(id)
	assert.equal(values.routing_preset, '')
	assert.equal(app.presets[`routing_${id}`], undefined)
	assert.equal(isActive(), false)
	assert.deepEqual(JSON.parse(saved.at(-1).routingPresets), [])
})
