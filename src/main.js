import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { readFile } from 'node:fs/promises'
import { RodecasterDevice } from './device.js'
import { parseStripNames } from './model.js'
import { updateActions } from './actions.js'
import { updateFeedbacks } from './feedbacks.js'
import { updatePresets } from './presets.js'
import { updateVariableDefinitions, updateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { routingState } from './routing.js'
import { RoutingController, parseRoutingPresets } from './routing-presets.js'
import { DeskApiServer } from './desk-api.js'

const FEEDBACKS_BY_AREA = {
	strips: [
		'strip_muted',
		'strip_cued',
		'strip_borrowed',
		'level_control_locked',
		'panic_active',
		'routing_preset_active',
	],
	monitor: ['monitor_muted', 'headphones_off', 'headphone_mix_muted', 'panic_active', 'routing_preset_active'],
	recorder: ['record_state'],
	pads: ['pad_active', 'pad_colour', 'pad_bank'],
	fx: ['fx_on'],
	gui: [],
	system: ['connected', 'routing_preset_active'],
	routing: ['routing_preset_active'],
}

export class RodecasterInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.device = new RodecasterDevice()
		this.routing = new RoutingController(this.device, {
			onPresetsChanged: (presets) => this.persistRoutingPresets(presets),
		})
		this.secrets = {}
		this.apiError = null
		this.deskStatus = { state: 'connecting', message: null }
		this.api = new DeskApiServer(this.device, this.routing, {
			log: (level, message) => this.log(level, message),
			onError: (message) => {
				if (this.apiError === message) return
				this.apiError = message
				this.updateConnectionStatus()
			},
		})
		/** @type {NodeJS.Timeout | null} */
		this.clockTimer = null
		this.definitionsBuilt = false
	}

	async init(config, _isFirstInit, secrets = {}) {
		this.config = { ...config }
		delete this.config.apiKey
		this.secrets = secrets ?? {}
		this.routing.presets = parseRoutingPresets(config.routingPresets)
		this.applyOptions()
		this.device.setPendingRepair(parseUnlinked(config.unlinkedSends))
		this.device.setHeadphoneMutes(parseHeadphoneMutes(config.headphoneMixMutes))

		this.device.on('log', (level, msg) => this.log(level, msg))
		this.device.on('status', (state, message) => {
			this.deskStatus = { state, message: message ?? null }
			this.updateConnectionStatus()
		})
		this.device.on('update', (area) => this.onUpdate(area))
		this.device.on('borrowed', (list) => this.persistBorrowed(list))
		this.device.on('headphoneMutes', (list) => this.persistHeadphoneMutes(list))

		updateVariableDefinitions(this)
		this.rebuildDefinitions()
		this.updateConnectionStatus()
		this.device.start()
		await this.api.configure(this.config, this.secrets)
		this.clockTimer = setInterval(() => {
			if (this.device.recordState === 2) this.onUpdate('recorder')
		}, 1000)
	}

	/**
	 * Routing page and API under /instance/<label>/ (Companion HTTP).
	 * @param {import('@companion-module/base').CompanionHTTPRequest} req
	 */
	async handleHttpRequest(req) {
		const json = (status, body) => ({
			status,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
			body: JSON.stringify(body),
		})
		try {
			if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
				return {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
					body: await readFile(new URL('./routing-page.html', import.meta.url), 'utf8'),
				}
			}
			if (req.method === 'GET' && req.path === '/routing') return json(200, routingState(this.device))
			if (req.method === 'POST' && req.path === '/routing/mode') {
				const b = routingBody(req, ['output', 'mode'])
				await this.routing.setMode(b.output, b.mode)
				return json(200, { ok: true })
			}
			if (req.method === 'POST' && req.path === '/routing/cell') {
				const b = routingBody(req, ['source', 'output', 'state', 'level'])
				const changes = {}
				if (Object.hasOwn(b, 'state')) changes.state = b.state
				if (Object.hasOwn(b, 'level')) changes.level = b.level
				await this.routing.setCell(b.source, b.output, changes)
				return json(200, { ok: true })
			}
			if (req.path === '/routing/presets' && req.method === 'GET') {
				if (!this.device.ready) return json(503, { error: 'desk disconnected' })
				return json(200, { presets: this.routing.listPresets(), active: this.routing.matchingPreset() })
			}
			if (req.path === '/routing/presets' && req.method === 'POST') {
				const b = routingBody(req, ['name'])
				const preset = await this.routing.savePreset(b.name)
				return json(201, { preset })
			}
			const presetRoute = /^\/routing\/presets\/([^/]+)(\/load)?$/.exec(req.path)
			if (presetRoute) {
				const id = decodeURIComponent(presetRoute[1])
				if (req.method === 'POST' && presetRoute[2]) {
					routingBody(req, [])
					await this.routing.loadPreset(id)
					return json(200, { ok: true })
				}
				if (req.method === 'POST' && !presetRoute[2]) {
					const b = routingBody(req, ['name'])
					await this.routing.renamePreset(id, b.name)
					return json(200, { ok: true })
				}
				if (req.method === 'DELETE' && !presetRoute[2]) {
					routingBody(req, [])
					await this.routing.deletePreset(id)
					return json(200, { ok: true })
				}
			}
			return json(404, { error: 'not found' })
		} catch (err) {
			return json(err.statusCode ?? 400, { error: err instanceof Error ? err.message : String(err) })
		}
	}

	async destroy() {
		if (this.clockTimer) clearInterval(this.clockTimer)
		this.clockTimer = null
		await this.api.stop()
		await this.device.stop()
	}

	async configUpdated(config, secrets = this.secrets) {
		const serialChanged = (config.serial ?? '') !== (this.config?.serial ?? '')
		// Settings forms may carry an older preset list. The running controller
		// owns edits made through the page, just as the device owns repair state.
		this.config = { ...config, routingPresets: JSON.stringify(this.routing.presets) }
		delete this.config.apiKey
		this.secrets = secrets ?? {}
		if (this.config.routingPresets !== (config.routingPresets ?? '[]')) this.saveConfig(this.config)
		this.applyOptions()
		this.rebuildDefinitions()
		// Settings updates can carry an older journal. Keep the recovery state
		// owned by the running device, including records for other desks.
		this.persistBorrowed(this.device.borrowedList())
		if (serialChanged) {
			await this.device.stop()
			this.device.start()
		}
		await this.api.configure(this.config, this.secrets)
	}

	updateConnectionStatus() {
		if (this.apiError) this.updateStatus(InstanceStatus.ConnectionFailure, this.apiError)
		else if (this.deskStatus.state === 'ready') this.updateStatus(InstanceStatus.Ok)
		else if (this.deskStatus.state === 'connecting') this.updateStatus(InstanceStatus.Connecting)
		else this.updateStatus(InstanceStatus.Disconnected, this.deskStatus.message)
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
			{
				type: 'checkbox',
				id: 'apiEnabled',
				label: 'Enable HTTP API for LAN clients',
				width: 12,
				default: false,
			},
			{
				type: 'textinput',
				id: 'apiBind',
				label: 'HTTP API listen address',
				width: 6,
				default: '0.0.0.0',
			},
			{
				type: 'number',
				id: 'apiPort',
				label: 'HTTP API port',
				width: 6,
				default: 8765,
				min: 1,
				max: 65535,
			},
			{
				type: 'secret-text',
				id: 'apiKey',
				label: 'HTTP API key (required when enabled)',
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

	/** @param {Array<import('./device.js').RecoveryEntry>} list */
	persistBorrowed(list) {
		// Every update must preserve unresolved startup repairs as well as sends
		// borrowed in this run, including updates while a repair is awaiting HID.
		const recovery = [
			...this.device.pendingRepair,
			...list.map((e) => ({ source: e.source, mixes: e.mixes, identity: e.identity })),
		]
		const unlinkedSends = JSON.stringify(recovery)
		if (unlinkedSends === (this.config.unlinkedSends ?? '[]')) return
		this.config = { ...this.config, unlinkedSends }
		try {
			this.saveConfig(this.config)
		} catch (err) {
			this.log('warn', `could not persist borrowed sends: ${err.message}`)
		}
	}

	/** @param {Array<{ headphone: number, sources: number[] }>} list */
	persistHeadphoneMutes(list) {
		const headphoneMixMutes = JSON.stringify(list)
		if (headphoneMixMutes === (this.config.headphoneMixMutes ?? '[]')) return
		this.config = { ...this.config, headphoneMixMutes }
		try {
			this.saveConfig(this.config)
		} catch (err) {
			this.log('warn', `could not persist headphone mutes: ${err.message}`)
		}
	}

	/** Persist edits before reporting success to the page. */
	persistRoutingPresets(presets) {
		const config = { ...this.config, routingPresets: JSON.stringify(presets) }
		this.saveConfig(config)
		this.config = config
		this.rebuildDefinitions()
	}
}

/** Parse both Companion's JSON string bodies and its pre-parsed bodies. */
function routingBody(req, fields) {
	const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object')
	if (Object.keys(body).some((key) => !fields.includes(key))) throw new Error('unexpected request field')
	return body
}

/** @param {string | undefined} text */
function parseHeadphoneMutes(text) {
	try {
		return JSON.parse(text ?? '[]')
	} catch {
		return []
	}
}

/** @param {string | undefined} text */
function parseUnlinked(text) {
	if (!text) return []
	try {
		const list = JSON.parse(text)
		return Array.isArray(list) ? list.filter((e) => e && typeof e.source === 'number' && Array.isArray(e.mixes)) : []
	} catch {
		return []
	}
}

export default RodecasterInstance
export { UpgradeScripts }
