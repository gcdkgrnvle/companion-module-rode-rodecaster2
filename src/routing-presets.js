/** Saved routing snapshots and one queue shared by HTTP and Companion actions. */
import { randomUUID } from 'node:crypto'
import { MixOutput, Source } from './protocol/names.js'
import { requireRoutingReady, routingError, routingState, setCellLevel, setCellState, setMode } from './routing.js'

const STATES = ['link', 'unlink', 'off']
const LEVEL_TOLERANCE = 0.005

function cellState(cell) {
	// mixMute can also belong to a temporary headphone bus mute. Only the
	// routing screen's mixDisabled flag represents its red-X state.
	return cell.disabled ? 'off' : cell.link ? 'link' : 'unlink'
}

function presetName(name) {
	if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
		throw routingError('preset name must contain 1 to 80 characters')
	return name.trim()
}

function validLevel(level) {
	return typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1
}

function validIndex(value, count) {
	return Number.isInteger(value) && value >= 0 && value < count
}

function cleanOutputs(outputs) {
	if (!Array.isArray(outputs) || outputs.length !== MixOutput.ALL.length)
		throw routingError('preset must include all routing outputs')
	const sorted = outputs.slice().sort((a, b) => a?.output - b?.output)
	let sourceCount
	return sorted.map((output, index) => {
		if (
			!output ||
			output.output !== index ||
			![null, 0, 1, 2].includes(output.mode) ||
			!Array.isArray(output.cells) ||
			output.cells.length < 1 ||
			output.cells.length > Source.ALL.length
		)
			throw routingError('invalid preset output')
		sourceCount ??= output.cells.length
		if (sourceCount !== output.cells.length) throw routingError('preset sources must match on every output')
		const cells = output.cells.slice().sort((a, b) => a?.source - b?.source)
		return {
			output: index,
			mode: output.mode,
			cells: cells.map((cell, source) => {
				if (!cell || cell.source !== source || !STATES.includes(cell.state) || !validLevel(cell.level))
					throw routingError('invalid preset cell')
				return { source, state: cell.state, level: cell.level }
			}),
		}
	})
}

/** Invalid saved entries cannot become hardware writes; keep any valid siblings. */
export function parseRoutingPresets(text) {
	let entries
	try {
		entries = typeof text === 'string' ? JSON.parse(text) : text
	} catch {
		return []
	}
	if (!Array.isArray(entries)) return []
	const presets = []
	for (const entry of entries) {
		try {
			if (typeof entry?.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.id)) continue
			const name = presetName(entry.name)
			if (presets.some((preset) => preset.id === entry.id || preset.name === name)) continue
			presets.push({ id: entry.id, name, outputs: cleanOutputs(entry.outputs) })
		} catch {
			// A damaged config entry must not prevent the connection from starting.
		}
	}
	return presets
}

function snapshot(device) {
	return routingState(device).outputs.map((output) => ({
		output: output.output,
		mode: output.mode,
		cells: output.cells.map((cell) => ({ source: cell.source, state: cellState(cell), level: cell.level })),
	}))
}

function guardedDevice(device, guard) {
	return new Proxy(device, {
		get(target, key) {
			if (key === 'write')
				return async (path, name, value) => {
					guard()
					await target.write(path, name, value, guard)
					guard()
				}
			const value = Reflect.get(target, key)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

function matches(outputs, current) {
	return (
		outputs.length === current.length &&
		outputs.every((output, index) => {
			const actual = current[index]
			return (
				output.output === actual.output &&
				output.mode === actual.mode &&
				output.cells.length === actual.cells.length &&
				output.cells.every((cell, source) => {
					const actualCell = actual.cells[source]
					return (
						cell.source === actualCell.source &&
						cell.state === actualCell.state &&
						Math.abs(cell.level - actualCell.level) <= LEVEL_TOLERANCE + Number.EPSILON
					)
				})
			)
		})
	)
}

export class RoutingController {
	constructor(device, { presets = [], onPresetsChanged = () => {} } = {}) {
		this.device = device
		this.presets = parseRoutingPresets(presets)
		this.onPresetsChanged = onPresetsChanged
		this.queue = Promise.resolve()
	}

	/** A rejected request never prevents later edits, and readiness is checked when work starts. */
	enqueue(operation) {
		const connectionGuard = this.device.ready ? this.device.connectionGuard?.() : null
		const tree = this.device.tree
		const layout = this.device.layout
		const guard = () => {
			requireRoutingReady(this.device)
			if (this.device.tree !== tree || this.device.layout !== layout)
				throw routingError('desk connection or layout changed', 503)
			try {
				connectionGuard?.()
			} catch {
				throw routingError('desk connection or layout changed', 503)
			}
		}
		const result = this.queue.then(() => {
			guard()
			return operation(guardedDevice(this.device, guard))
		})
		this.queue = result.catch(() => {})
		return result
	}

	listPresets() {
		return this.presets.map(({ id, name }) => ({ id, name }))
	}

	findPreset(id) {
		if (typeof id !== 'string' || !id) throw routingError('preset id must be a nonempty string')
		const preset = this.presets.find((entry) => entry.id === id)
		if (!preset) throw routingError('routing preset not found', 404)
		return preset
	}

	checkName(name, exceptId) {
		const normalized = presetName(name)
		if (this.presets.some((preset) => preset.id !== exceptId && preset.name === normalized))
			throw routingError('a routing preset with that name already exists', 409)
		return normalized
	}

	async persist(presets) {
		const previous = this.presets
		this.presets = presets
		try {
			await this.onPresetsChanged(structuredClone(presets))
		} catch (error) {
			this.presets = previous
			throw error
		}
	}

	savePreset(name) {
		return this.enqueue(async () => {
			const preset = { id: randomUUID(), name: this.checkName(name), outputs: cleanOutputs(snapshot(this.device)) }
			await this.persist([...this.presets, preset])
			return { id: preset.id, name: preset.name }
		})
	}

	renamePreset(id, name) {
		return this.enqueue(async () => {
			const preset = this.findPreset(id)
			const renamed = { ...preset, name: this.checkName(name, id) }
			await this.persist(this.presets.map((entry) => (entry.id === id ? renamed : entry)))
			return { id, name: renamed.name }
		})
	}

	deletePreset(id) {
		return this.enqueue(async () => {
			this.findPreset(id)
			await this.persist(this.presets.filter((entry) => entry.id !== id))
		})
	}

	presetMatches(id) {
		if (!this.device.ready) return false
		const preset = this.presets.find((entry) => entry.id === id)
		return !!preset && matches(preset.outputs, snapshot(this.device))
	}

	matchingPreset() {
		if (!this.device.ready) return ''
		const current = snapshot(this.device)
		return this.presets.find((preset) => matches(preset.outputs, current))?.name ?? ''
	}

	setMode(output, mode) {
		return this.enqueue(async (device) => {
			if (!validIndex(output, this.device.layout.mixCountPerSource)) throw routingError('invalid output index')
			if (![0, 1, 2].includes(mode)) throw routingError('mode must be 0, 1 or 2')
			const current = routingState(this.device).outputs[output]
			if (current.mode === null) throw routingError(`output ${output} has no routing mode`)
			if (current.mode !== mode) await setMode(device, output, mode)
		})
	}

	/** Unlink alone keeps the disabled flags; wake an off send through the proven link sequence. */
	async changeState(device, source, output, state, currentState) {
		if (state === currentState) return false
		const relinked = state === 'link' || (currentState === 'off' && state === 'unlink')
		if (currentState === 'off' && state === 'unlink') await setCellState(device, source, output, 'link')
		await setCellState(device, source, output, state)
		return relinked
	}

	setCell(source, output, options) {
		return this.enqueue(async (device) => {
			if (!validIndex(output, this.device.layout.mixCountPerSource)) throw routingError('invalid output index')
			if (!validIndex(source, this.device.layout.sourceCount)) throw routingError('invalid source index')
			if (!options || typeof options !== 'object' || Array.isArray(options)) throw routingError('invalid cell edit')
			const { state, level } = options
			if (state === undefined && level === undefined) throw routingError('provide state or level')
			if (state !== undefined && !STATES.includes(state)) throw routingError('state must be link, unlink or off')
			if (level !== undefined && !validLevel(level)) throw routingError('level must be a number from 0 to 1')
			const currentOutput = routingState(this.device).outputs[output]
			if (currentOutput.mode !== 2) throw routingError('select Custom before editing routing cells')
			const cell = currentOutput.cells.find((entry) => entry.source === source)
			if (!cell) throw routingError('routing cell not found')
			let relinked = false
			if (state !== undefined) relinked = await this.changeState(device, source, output, state, cellState(cell))
			if (level !== undefined && (relinked || Math.abs(level - cell.level) > 0.0000005))
				await setCellLevel(device, source, output, level)
		})
	}

	loadPreset(id) {
		return this.enqueue(async (device) => {
			const preset = this.findPreset(id)
			const outputs = cleanOutputs(preset.outputs)
			const current = snapshot(this.device)
			// Validate the whole snapshot against this layout before sending any writes.
			for (const output of outputs) {
				const actual = current[output.output]
				if (!actual || output.cells.length !== actual.cells.length || (output.mode === null) !== (actual.mode === null))
					throw routingError('preset does not match the connected desk routing layout')
			}
			for (const output of outputs) {
				const actual = current[output.output]
				let mode = actual.mode
				if ((output.mode === 2 || mode === 2) && mode !== 2) {
					await setMode(device, output.output, 2)
					mode = 2
				}
				const relinked = new Set()
				for (const cell of output.cells) {
					if (await this.changeState(device, cell.source, output.output, cell.state, actual.cells[cell.source].state))
						relinked.add(cell.source)
				}
				for (const cell of output.cells) {
					if (relinked.has(cell.source) || Math.abs(cell.level - actual.cells[cell.source].level) > 0.0000005)
						await setCellLevel(device, cell.source, output.output, cell.level)
				}
				if (output.mode !== null && mode !== output.mode) await setMode(device, output.output, output.mode)
			}
		})
	}
}
