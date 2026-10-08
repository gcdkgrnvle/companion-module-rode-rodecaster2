/** Versioned desk resources. Every mutation reads its response from the device model. */
import { levelToFader } from './model.js'
import { MixOutput, Source } from './protocol/names.js'
import { MODES, routingError, routingState } from './routing.js'

const EFFECTS = {
	reverb: 'reverbOn',
	echo: 'echoOn',
	pitchShift: 'pitchShiftOn',
	distortion: 'distortionOn',
	robot: 'robotOn',
	voiceDisguise: 'voiceDisguiseOn',
}

function fields(body, allowed) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw routingError('body must be a JSON object')
	if (Object.keys(body).some((key) => !allowed.includes(key))) throw routingError('unknown body field')
}

function number(value, min, max, name, integer = false) {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isInteger(value))
	)
		throw routingError(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`)
	return value
}

function index(value, count, name) {
	if (!/^\d+$/.test(value)) throw routingError(`${name} must be an integer from 1 to ${count}`)
	return number(Number(value), 1, count, name, true) - 1
}

function namedIndex(value, vocabulary, count, name) {
	const named = vocabulary.parse(value)
	const ordinal = /^\d+$/.test(value) ? Number(value) : named === null ? -1 : vocabulary.toProtocol(named)
	return number(ordinal, 0, count - 1, name, true)
}

function toggle(body, current) {
	fields(body, ['value'])
	if (body.value === 'toggle') return !current
	if (body.value === true || body.value === 'on') return true
	if (body.value === false || body.value === 'off') return false
	throw routingError('value must be true, false, on, off or toggle')
}

function levelEdit(body) {
	fields(body, ['level', 'delta'])
	if (Object.hasOwn(body, 'level') === Object.hasOwn(body, 'delta'))
		throw routingError('provide exactly one of level or delta')
	return Object.hasOwn(body, 'level')
		? { level: number(body.level, 0, 1, 'level') }
		: { delta: number(body.delta, -1, 1, 'delta') }
}

function brightness(body) {
	fields(body, ['value', 'pct'])
	if (Object.hasOwn(body, 'value') === Object.hasOwn(body, 'pct'))
		throw routingError('provide exactly one of value or pct')
	return Object.hasOwn(body, 'value')
		? number(body.value, 0, 255, 'value', true)
		: Math.round((number(body.pct, 0, 100, 'pct') * 255) / 100)
}

const ROUTES = [
	['GET', /^\/state$/, 'state'],
	['GET', /^\/routing$/, 'routingState'],
	['GET', /^\/routing\/outputs\/([^/]+)$/, 'output'],
	['PUT', /^\/routing\/outputs\/([^/]+)\/mode$/, 'mode'],
	['GET', /^\/routing\/outputs\/([^/]+)\/sources\/([^/]+)$/, 'cell'],
	['PATCH', /^\/routing\/outputs\/([^/]+)\/sources\/([^/]+)$/, 'editCell'],
	['GET', /^\/routing\/presets$/, 'presets'],
	['POST', /^\/routing\/presets$/, 'savePreset'],
	['POST', /^\/routing\/presets\/([^/]+)\/load$/, 'loadPreset'],
	['PATCH', /^\/routing\/presets\/([^/]+)$/, 'renamePreset'],
	['DELETE', /^\/routing\/presets\/([^/]+)$/, 'deletePreset'],
	['GET', /^\/strips$/, 'strips'],
	['GET', /^\/strips\/([^/]+)$/, 'strip'],
	['PUT', /^\/strips\/([^/]+)\/(mute|listen|level)$/, 'editStrip'],
	['POST', /^\/strips\/restore$/, 'restoreStrips'],
	['GET', /^\/monitor$/, 'monitor'],
	['PUT', /^\/monitor\/(level|mute)$/, 'editMonitor'],
	['GET', /^\/headphones$/, 'headphones'],
	['PUT', /^\/headphones\/off$/, 'headphonesOff'],
	['PUT', /^\/headphones\/([^/]+)\/mute$/, 'headphoneMute'],
	['GET', /^\/bluetooth$/, 'bluetooth'],
	['PUT', /^\/bluetooth\/(level|mute)$/, 'editBluetooth'],
	['GET', /^\/recorder$/, 'recorder'],
	['POST', /^\/recorder\/(record|pause|stop|marker)$/, 'editRecorder'],
	['GET', /^\/pads$/, 'pads'],
	['POST', /^\/pads\/([^/]+)\/press$/, 'pressPad'],
	['PUT', /^\/pads\/bank$/, 'padBank'],
	['GET', /^\/fx$/, 'fx'],
	['PUT', /^\/fx\/([^/]+)\/([^/]+)$/, 'editFx'],
	['GET', /^\/panic$/, 'panic'],
	['PUT', /^\/panic$/, 'editPanic'],
	['PUT', /^\/display\/(screen-brightness|button-brightness)$/, 'editDisplay'],
	['PUT', /^\/ducker\/depth$/, 'editDucker'],
]

export class DeskApiResources {
	constructor(device, routing) {
		this.device = device
		this.routing = routing
		this.queue = Promise.resolve()
	}

	/** Keep toggle/delta reads, writes and their response snapshots in request order. */
	handle(method, path, body = {}) {
		const route = ROUTES.find(([verb, pattern]) => verb === method && pattern.test(path))
		if (!route) return Promise.reject(routingError('not found', 404))
		let args
		try {
			args = route[1].exec(path).slice(1).map(decodeURIComponent)
		} catch {
			return Promise.reject(routingError('invalid URL encoding'))
		}
		const device = this.device
		const ready = device.ready
		const tree = device.tree
		const layout = device.layout
		const connectionGuard = ready ? device.connectionGuard?.() : null
		const guard = () => {
			if (!ready || !device.ready) throw routingError('desk disconnected', 503)
			if (device.tree !== tree || device.layout !== layout) throw routingError('desk connection or layout changed', 503)
			try {
				connectionGuard?.()
			} catch {
				throw routingError(device.ready ? 'desk connection or layout changed' : 'desk disconnected', 503)
			}
		}
		const operation = this.queue.then(async () => {
			guard()
			try {
				const result = await this[route[2]](...args, body)
				guard()
				return { status: route[2] === 'savePreset' ? 201 : 200, body: result }
			} catch (error) {
				guard()
				throw error
			}
		})
		this.queue = operation.catch(() => {})
		return operation
	}

	outputIndex(value) {
		return namedIndex(value, MixOutput, this.device.layout.mixCountPerSource, 'output')
	}

	sourceIndex(value) {
		return namedIndex(value, Source, this.device.layout.sourceCount, 'source')
	}

	routingState() {
		const state = routingState(this.device)
		return {
			outputs: state.outputs.map((output) => ({
				output: output.output,
				name: MixOutput.fromProtocol(output.output),
				mode: MODES[output.mode] ?? null,
				sources: output.cells.map((cell) => ({
					source: cell.source,
					name: Source.fromProtocol(cell.source),
					state: cell.disabled ? 'off' : cell.link ? 'link' : 'unlink',
					level: cell.level,
					anchor: cell.anchor,
					onFader: state.strips.some(
						(strip) => strip.strip < this.device.layout.faderCount && strip.source === cell.source,
					),
				})),
			})),
		}
	}

	output(output) {
		return this.routingState().outputs[this.outputIndex(output)]
	}

	async mode(output, body) {
		fields(body, ['mode'])
		const mode = typeof body.mode === 'string' ? MODES.indexOf(body.mode) : body.mode
		if (![0, 1, 2].includes(mode)) throw routingError('mode must be main, mixminus, custom, 0, 1 or 2')
		await this.routing.setMode(this.outputIndex(output), mode)
		return this.output(output)
	}

	cell(output, source) {
		const state = this.output(output)
		const sourceIndex = this.sourceIndex(source)
		const cell = state.sources.find((entry) => entry.source === sourceIndex)
		if (!cell) throw routingError('routing cell not found')
		return { output: state.output, outputName: state.name, ...cell }
	}

	async editCell(output, source, body) {
		fields(body, ['state', 'level', 'ensureCustom'])
		if (body.state === undefined && body.level === undefined) throw routingError('provide state or level')
		if (body.state !== undefined && !['link', 'unlink', 'off'].includes(body.state))
			throw routingError('state must be link, unlink or off')
		if (body.level !== undefined) number(body.level, 0, 1, 'level')
		if (body.ensureCustom !== undefined && typeof body.ensureCustom !== 'boolean')
			throw routingError('ensureCustom must be a boolean')
		// Check every field and both indices before ensureCustom can mutate the desk.
		const cell = this.cell(output, source)
		if (body.ensureCustom) await this.routing.setMode(cell.output, 2)
		await this.routing.setCell(cell.source, cell.output, { state: body.state, level: body.level })
		return this.cell(output, source)
	}

	presets() {
		return { presets: this.routing.listPresets(), active: this.routing.matchingPreset() }
	}

	presetId(idOrName) {
		const presets = this.routing.listPresets()
		const preset = presets.find((entry) => entry.id === idOrName) ?? presets.find((entry) => entry.name === idOrName)
		if (!preset) throw routingError('routing preset not found', 404)
		return preset.id
	}

	async savePreset(body) {
		fields(body, ['name'])
		await this.routing.savePreset(body.name)
		return this.presets()
	}

	async loadPreset(idOrName, body) {
		fields(body, [])
		await this.routing.loadPreset(this.presetId(idOrName))
		return { active: this.routing.matchingPreset(), ...this.routingState() }
	}

	async renamePreset(idOrName, body) {
		fields(body, ['name'])
		await this.routing.renamePreset(this.presetId(idOrName), body.name)
		return this.presets()
	}

	async deletePreset(idOrName, body) {
		fields(body, [])
		await this.routing.deletePreset(this.presetId(idOrName))
		return this.presets()
	}

	stripState(strip) {
		return {
			strip: strip.index + 1,
			name: strip.name,
			source: strip.source ? { index: strip.sourceOrdinal, name: strip.source } : null,
			muted: strip.muted,
			listen: strip.cued,
			level: strip.level,
			levelPct: Math.round(strip.level * 100),
			fader: levelToFader(strip.faderLevel),
			control: strip.control,
		}
	}

	strips() {
		return { strips: this.device.strips().map((strip) => this.stripState(strip)) }
	}

	strip(strip) {
		return this.stripState(this.device.strip(index(strip, this.device.stripCount, 'strip')))
	}

	async editStrip(strip, operation, body) {
		const i = index(strip, this.device.stripCount, 'strip')
		if (operation === 'mute') await this.device.setStripMute(i, toggle(body, this.device.strip(i).muted))
		else if (operation === 'listen') await this.device.setStripCue(i, toggle(body, this.device.strip(i).cued))
		else {
			const edit = levelEdit(body)
			if (!this.device.levelControlEnabled)
				throw routingError('level control disabled; enable it in the connection settings', 409)
			if (edit.level !== undefined) await this.device.setStripLevel(i, edit.level)
			else await this.device.stepStripLevel(i, edit.delta)
		}
		return this.strip(strip)
	}

	async restoreStrips(body) {
		fields(body, [])
		await this.device.restoreFaders()
		return this.strips()
	}

	monitor() {
		return {
			level: this.device.monitorLevel,
			levelPct: Math.round(this.device.monitorLevel * 100),
			muted: this.device.monitorMuted,
		}
	}

	async editMonitor(operation, body) {
		if (operation === 'mute') await this.device.setMonitorMute(toggle(body, this.device.monitorMuted))
		else {
			const edit = levelEdit(body)
			if (edit.level !== undefined) await this.device.setMonitorLevel(edit.level)
			else await this.device.stepMonitorLevel(edit.delta)
		}
		return this.monitor()
	}

	headphones() {
		return {
			allOff: this.device.headphonesOff,
			mixes: Array.from({ length: 4 }, (_, i) => ({ headphone: i + 1, muted: this.device.headphoneMixMuted(i + 1) })),
		}
	}

	async headphonesOff(body) {
		await this.device.setHeadphonesOff(toggle(body, this.device.headphonesOff))
		return this.headphones()
	}

	async headphoneMute(headphone, body) {
		const n = index(headphone, 4, 'headphone') + 1
		toggle(body, false)
		await this.device.setHeadphoneMixMute(n, () => toggle(body, this.device.headphoneMixMuted(n)))
		return this.headphones()
	}

	bluetooth() {
		return {
			level: this.device.bluetoothLevel,
			levelPct: Math.round(this.device.bluetoothLevel * 100),
			muted: this.device.bluetoothMuted,
		}
	}

	async editBluetooth(operation, body) {
		if (operation === 'mute') await this.device.setBluetoothMute(toggle(body, this.device.bluetoothMuted))
		else {
			const edit = levelEdit(body)
			await this.device.setBluetoothLevel(edit.level ?? this.device.bluetoothLevel + edit.delta)
		}
		return this.bluetooth()
	}

	recorder() {
		return {
			state: ['stopped', 'paused', 'recording'][this.device.recordState] ?? 'stopped',
			elapsedMs: Math.floor(this.device.recordElapsedSeconds * 1000),
		}
	}

	async editRecorder(operation, body) {
		fields(body, [])
		if (operation === 'marker') await this.device.dropMarker()
		else await this.device.requestRecord({ record: 2, pause: 1, stop: 0 }[operation])
		return this.recorder()
	}

	pads() {
		const bank = this.device.padBank + 1
		return {
			bank,
			pads: Array.from({ length: 8 }, (_, slot) => {
				const pad = this.device.pad(slot)
				return {
					slot: slot + 1,
					bank,
					name: pad?.name ?? '',
					active: pad?.active ?? false,
					type: pad?.type ?? 0,
					colour: pad?.colour ?? 11,
				}
			}),
		}
	}

	async pressPad(slot, body) {
		fields(body, ['bank'])
		const i = index(slot, 8, 'slot')
		const bank = body.bank === undefined ? null : number(body.bank, 1, 8, 'bank', true) - 1
		await this.device.pressPad(i, bank)
		return this.pads()
	}

	async padBank(body) {
		fields(body, ['bank', 'delta'])
		if (Object.hasOwn(body, 'bank') === Object.hasOwn(body, 'delta'))
			throw routingError('provide exactly one of bank or delta')
		const bank = Object.hasOwn(body, 'bank')
			? number(body.bank, 1, 8, 'bank', true) - 1
			: (((this.device.padBank + number(body.delta, -8, 8, 'delta', true)) % 8) + 8) % 8
		await this.device.setPadBank(bank)
		return this.pads()
	}

	fxSlot(slot) {
		return {
			slot: slot + 1,
			...Object.fromEntries(Object.entries(EFFECTS).map(([name, effect]) => [name, this.device.fxOn(slot, effect)])),
		}
	}

	fx() {
		return { slots: Array.from({ length: this.device.fxSlotCount }, (_, slot) => this.fxSlot(slot)) }
	}

	async editFx(slot, effect, body) {
		const i = index(slot, this.device.fxSlotCount, 'slot')
		const name = effect === 'megaphone' ? 'distortion' : effect.endsWith('On') ? effect.slice(0, -2) : effect
		if (!Object.hasOwn(EFFECTS, name)) throw routingError('unknown effect')
		await this.device.setFx(i, EFFECTS[name], toggle(body, this.device.fxOn(i, EFFECTS[name])))
		return this.fxSlot(i)
	}

	panic() {
		return { active: this.device.panicActive }
	}

	async editPanic(body) {
		toggle(body, false)
		const guard = this.device.connectionGuard?.()
		await this.device.queuePanic(() => {
			guard?.()
			return toggle(body, this.device.panicActive)
		})
		return this.panic()
	}

	display() {
		return { screenBrightness: this.device.screenBrightness, buttonBrightness: this.device.buttonsBrightness }
	}

	async editDisplay(operation, body) {
		const value = brightness(body)
		if (operation === 'screen-brightness') await this.device.setScreenBrightness(value)
		else await this.device.setButtonsBrightness(value)
		return this.display()
	}

	ducker() {
		return { depth: this.device.duckerDepth }
	}

	async editDucker(body) {
		fields(body, ['value'])
		await this.device.setDuckerDepth(number(body.value, -60, 0, 'value'))
		return this.ducker()
	}

	state() {
		return {
			routing: this.routingState(),
			presets: this.presets(),
			strips: this.strips(),
			monitor: this.monitor(),
			headphones: this.headphones(),
			bluetooth: this.bluetooth(),
			recorder: this.recorder(),
			pads: this.pads(),
			fx: this.fx(),
			panic: this.panic(),
			display: this.display(),
			ducker: this.ducker(),
		}
	}
}
