import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { RodecasterDevice } from './device.js'
import { parseStripNames } from './model.js'
import { updateActions } from './actions.js'
import { updateFeedbacks } from './feedbacks.js'
import { updatePresets } from './presets.js'
import { updateVariableDefinitions, updateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'

const FEEDBACKS_BY_AREA = {
	strips: ['strip_muted', 'strip_cued', 'strip_borrowed', 'level_control_locked', 'panic_active'],
	monitor: ['monitor_muted', 'headphones_off', 'panic_active'],
	recorder: ['record_state'],
	pads: ['pad_active', 'pad_colour', 'pad_bank'],
	fx: ['fx_on'],
	gui: [],
	system: ['connected'],
}

export class RodecasterInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.device = new RodecasterDevice()
		/** @type {NodeJS.Timeout | null} */
		this.clockTimer = null
		this.definitionsBuilt = false
	}

	async init(config) {
		this.config = config
		this.applyOptions()
		this.device.setPendingRepair(parseUnlinked(config.unlinkedSends))

		this.device.on('log', (level, msg) => this.log(level, msg))
		this.device.on('status', (state, message) => {
			if (state === 'ready') this.updateStatus(InstanceStatus.Ok)
			else if (state === 'connecting') this.updateStatus(InstanceStatus.Connecting)
			else this.updateStatus(InstanceStatus.Disconnected, message ?? null)
		})
		this.device.on('update', (area) => this.onUpdate(area))
		this.device.on('borrowed', (list) => this.persistBorrowed(list))

		updateVariableDefinitions(this)
		this.rebuildDefinitions()
		this.updateStatus(InstanceStatus.Connecting)
		this.device.start()
		this.clockTimer = setInterval(() => {
			if (this.device.recordState === 2) this.onUpdate('recorder')
		}, 1000)
	}

	async destroy() {
		if (this.clockTimer) clearInterval(this.clockTimer)
		this.clockTimer = null
		await this.device.stop()
	}

	async configUpdated(config) {
		const serialChanged = (config.serial ?? '') !== (this.config?.serial ?? '')
		this.config = config
		this.applyOptions()
		this.rebuildDefinitions()
		if (serialChanged) {
			await this.device.stop()
			this.device.start()
		}
	}

	applyOptions() {
		this.device.setOptions({
			serial: this.config.serial ?? '',
			stripNames: parseStripNames(this.config.stripNames),
			levelControl: Boolean(this.config.levelControl),
			monitorMethod: this.config.monitorMethod === 'encoder' ? 'encoder' : 'property',
		})
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'RØDECaster Pro II / Duo over USB',
				value:
					"Connect the desk's USB 1 port to this machine. The desk is found automatically. On Linux install the udev rule and the usbhid quirk from the help page.",
			},
			{
				type: 'textinput',
				id: 'serial',
				label: 'Desk serial number (optional, only with several desks)',
				width: 6,
				default: '',
			},
			{
				type: 'dropdown',
				id: 'monitorMethod',
				label: 'Monitor level method',
				width: 6,
				default: 'property',
				choices: [
					{ id: 'property', label: 'Write the level (default)' },
					{ id: 'encoder', label: 'Emulate the big knob (0.01 per tick)' },
				],
			},
			{
				type: 'checkbox',
				id: 'levelControl',
				label: 'Let Companion drive channel levels',
				width: 12,
				default: false,
			},
			{
				type: 'static-text',
				id: 'levelInfo',
				width: 12,
				label: '',
				value:
					'Channel level control borrows a strip from its physical fader while Companion drives it. Touching the fader, "Hand back to fader" or "Restore all faders" returns it; a crash is repaired on the next start. Leave this off if you never use volume buttons or dials.',
			},
			{
				type: 'textinput',
				id: 'stripNames',
				label: 'Strip names (comma separated, in strip order; empty keeps the default)',
				width: 12,
				default: '',
			},
		]
	}

	rebuildDefinitions() {
		updateActions(this)
		updateFeedbacks(this)
		updatePresets(this)
		this.definitionsBuilt = true
		this.onUpdate('all')
	}

	/** @param {string} area */
	onUpdate(area) {
		if (!this.definitionsBuilt) return
		if (area === 'all') {
			// strip names and counts may have changed: definitions depend on them
			updateActions(this)
			updateFeedbacks(this)
			updatePresets(this)
			updateVariableValues(this, 'all')
			this.checkAllFeedbacks()
			return
		}
		updateVariableValues(this, area)
		const ids = FEEDBACKS_BY_AREA[area] ?? []
		if (ids.length) this.checkFeedbacks(...ids)
	}

	/** @param {Array<{ strip: number, source: number, mixes: number[] }>} list */
	persistBorrowed(list) {
		const unlinkedSends = JSON.stringify(list.map((e) => ({ source: e.source, mixes: e.mixes })))
		if (unlinkedSends === (this.config.unlinkedSends ?? '[]')) return
		this.config = { ...this.config, unlinkedSends }
		try {
			this.saveConfig(this.config)
		} catch (err) {
			this.log('warn', `could not persist borrowed sends: ${err.message}`)
		}
	}
}

/** @param {string | undefined} text */
function parseUnlinked(text) {
	if (!text) return []
	try {
		const list = JSON.parse(text)
		return Array.isArray(list) ? list.filter((e) => typeof e.source === 'number' && Array.isArray(e.mixes)) : []
	} catch {
		return []
	}
}

export default RodecasterInstance
export { UpgradeScripts }
