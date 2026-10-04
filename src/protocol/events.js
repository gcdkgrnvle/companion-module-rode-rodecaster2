/**
 * Inbound typed events: decode change frames (through a {@link Layout}) into
 * named events, and extract the initial state from a fullSync tree.
 *
 * Port of `rodecaster-protocol/src/events.rs` (MIT, Yeradon). The decode
 * order below mirrors the Rust `decode_property` exactly: the first matching
 * family wins.
 *
 * An event is a plain object keyed by `type`, e.g.
 * `{ type: 'faderMuteChanged', fader: 'physical1', muted: true }`.
 * `*ParamChanged` events carry `param` (the wire property name) and `value`
 * (a juce-var Value). `unknown` carries `propName`, `path` and `value`
 * (`null` for a removed property).
 *
 * @module protocol/events
 */

import { decodeChangeFrame } from './change-frame.js'
import { asBool, asInt, asString } from './juce-var.js'
import {
	AppParam,
	AudioParam,
	BuildParam,
	CurrentShowParam,
	Fader,
	FxPresetParam,
	MeterParam,
	MixMinusesParam,
	MixOutput,
	NetworkParam,
	PadRecorderParam,
	RadioParam,
	RadioRxParam,
	RadioTxParam,
	RcSyncMixParam,
	RecordingParam,
	RecordingsParam,
	ShowControlParam,
	ShowParam,
	SipAdvancedParam,
	SipCallSlotsParam,
	SipCallingParam,
	SipRegistrationParam,
	Source,
	StorageVolumeParam,
	StreamerXMixPresetParam,
	StreamerXStreamMixParam,
	TestParam,
	ThemeParam,
	WifiScanResultParam,
} from './names.js'
import { decodePhase } from './trigger.js'

/** @typedef {import('./juce-var.js').Value} Value */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./valuetree.js').ValueTree} ValueTree */
/** @typedef {import('./change-frame.js').ChangeRecord} ChangeRecord */
/** @typedef {Record<string, any> & { type: string }} DeviceEvent */

/** @param {number} n */
const u8 = (n) => n & 0xff
/** @param {number | bigint} n */
const clampLevel = (n) => Math.min(127, Math.max(0, Number(n)))

/**
 * `channelInputSource` value -> source id (`null` for unassigned / unknown).
 * @param {Value | null} value
 */
function sourceFromValue(value) {
	const s = asInt(value)
	if (s === null || s < 0 || s > 255) return null
	return Source.fromProtocol(Number(s))
}

/**
 * Decode one change-frame body into a typed event, or `null` if the body is
 * not a valid change frame.
 * @param {Uint8Array} payload
 * @param {Layout} layout
 * @returns {DeviceEvent | null}
 */
export function decodeEvent(payload, layout) {
	const frame = decodeChangeFrame(payload)
	return frame ? decodeEventFromFrame(frame, layout) : null
}

/**
 * Decode an already-parsed change record into a typed event.
 * @param {ChangeRecord} frame
 * @param {Layout} layout
 * @returns {DeviceEvent}
 */
export function decodeEventFromFrame(frame, layout) {
	switch (frame.type) {
		case 'fullSync':
			return { type: 'initialState', events: extractInitialState(frame.root, layout) }
		case 'childAdded':
		case 'childRemoved':
		case 'childMoved':
			return { type: 'layoutInvalidated' }
		case 'propertyChanged':
			return decodeProperty(frame.path, frame.name, frame.value, layout)
		case 'propertyRemoved':
			return decodeProperty(frame.path, frame.name, null, layout)
		default:
			throw new TypeError(`unknown change record type: ${/** @type {any} */ (frame).type}`)
	}
}

/**
 * @param {number[]} path
 * @param {string} name
 * @param {Value | null} value `null` for propertyRemoved
 * @param {Layout} layout
 * @returns {DeviceEvent}
 */
export function decodeProperty(path, name, value, layout) {
	const model = layout.model

	// CHANNEL-addressed properties (single-level path). A channel with no
	// named fader (the master strip) falls through.
	{
		const idx = layout.channelIndexFromPath(path)
		const fader = idx === null ? null : Fader.fromIndex(model, idx)
		if (fader) {
			if (name === 'channelOutputMute' && value?.type === 'bool')
				return { type: 'faderMuteChanged', fader, muted: value.value }
			if (name === 'channelCueEnable' && value?.type === 'bool')
				return { type: 'faderCueChanged', fader, enabled: value.value }
			if (name === 'channelInputSource')
				return { type: 'faderAssignmentChanged', fader, source: sourceFromValue(value) }
		}
	}

	// FADER-addressed properties (two-level path through PHYSICALINTERFACE).
	{
		const idx = layout.faderIndexFromPath(path)
		const fader = idx === null ? null : Fader.fromIndex(model, idx)
		if (fader && name === 'faderLevel') {
			const level = asInt(value)
			if (level !== null) return { type: 'faderLevelChanged', fader, level: clampLevel(level) }
		}
	}

	// MIX-cell-addressed properties (single-level path).
	{
		const cell = layout.mixCellFromPath(path)
		const source = cell ? Source.fromProtocol(cell.source) : null
		const mix = cell ? MixOutput.fromProtocol(cell.mix) : null
		if (source && mix) {
			switch (name) {
				case 'mixMute':
					if (value?.type === 'bool') return { type: 'mixMuteChanged', source, mix, muted: value.value }
					break
				case 'mixLink':
					if (value?.type === 'bool') return { type: 'mixLinkChanged', source, mix, linked: value.value }
					break
				case 'mixDisabled':
					if (value?.type === 'bool') return { type: 'mixDisabledChanged', source, mix, disabled: value.value }
					break
				case 'mixLevelWithAnchor': {
					const s = asString(value)
					const parsed = s === null ? null : parseMixLevel(s)
					if (parsed) return { type: 'mixLevelChanged', source, mix, anchor: parsed.anchor, value: parsed.value }
					break
				}
				case 'mixLinkRequest':
				case 'mixUnlinkRequest': {
					const origin = decodePhase(value)
					if (origin) {
						return {
							type: 'mixLinkRequested',
							source,
							mix,
							direction: name === 'mixLinkRequest' ? 'link' : 'unlink',
							origin,
						}
					}
					break
				}
				default:
					break
			}
		}
	}

	// encoderSignal (fader touch): single-level path whose value IS the fader
	// index (stride 1, no base offset).
	if (name === 'encoderSignal' && path.length >= 1 && path[0] < layout.faderCount) {
		const fader = Fader.fromIndex(model, path[0])
		if (fader) return { type: 'faderTouched', fader }
	}

	// encoderColour: LED-ring colour of a strip's encoder; Int, -1 = cleared.
	if (name === 'encoderColour' && path.length >= 1 && path[0] < layout.faderCount) {
		const fader = Fader.fromIndex(model, path[0])
		const i = asInt(value)
		if (fader && i !== null) return { type: 'faderEncoderColourChanged', fader, colour: i < 0 ? null : Number(i) }
	}

	// channelInputSource echo: stride-1 channel first, else the stride-6 echo
	// addressing from first_channel.
	if (name === 'channelInputSource') {
		let fader = null
		const idx = layout.channelIndexFromPath(path)
		if (idx !== null) fader = Fader.fromIndex(model, idx)
		if (!fader && path.length >= 1) {
			const offset = path[0] - layout.firstChannel
			if (offset >= 0 && offset % 6 === 0) {
				const strip = offset / 6
				if (strip < layout.channelCount) fader = Fader.fromIndex(model, strip)
			}
		}
		if (fader) return { type: 'faderAssignmentChanged', fader, source: sourceFromValue(value) }
	}

	// PHYSICALINTERFACE hardware-child input events: [physical_interface_idx, child].
	if (path.length === 2 && path[0] === layout.physicalInterfaceIdx) {
		const child = u8(path[1])
		switch (name) {
			case 'potLevel':
				if (value?.type === 'int') return { type: 'potLevelChanged', pot: child, level: clampLevel(value.value) }
				break
			case 'padButtonPressed':
				if (value?.type === 'bool') return { type: 'padButtonPressed', button: child, pressed: value.value }
				break
			case 'mutePressed':
				if (value?.type === 'bool') return { type: 'mutePressed', button: child, pressed: value.value }
				break
			case 'soloPressed':
				if (value?.type === 'bool') return { type: 'soloPressed', button: child, pressed: value.value }
				break
			case 'encoderPressed':
				if (value?.type === 'bool') return { type: 'encoderPressed', encoder: child, pressed: value.value }
				break
			case 'recButtonPressed':
				if (value?.type === 'bool') return { type: 'recButtonPressed', pressed: value.value }
				break
			default:
				break
		}
	}

	// EMERGENCYMUTE singleton at root.
	if (path.length === 1 && name === 'emergencyMuteActive' && value?.type === 'bool') {
		return { type: 'emergencyMuteChanged', active: value.value }
	}

	// NETWORK singleton: its wire-name set is unique, so match on name alone.
	if (NetworkParam.has(name) && value) return { type: 'networkParamChanged', param: name, value }

	// RECORDINGS singleton (path.len() == 1).
	if (path.length === 1 && RecordingsParam.has(name) && value)
		return { type: 'recordingsParamChanged', param: name, value }

	// RECORDING / STORAGEVOLUME children (path.len() == 2); path[1] is the ordinal.
	if (path.length === 2) {
		if (RecordingParam.has(name) && value)
			return { type: 'recordingParamChanged', recording: u8(path[1]), param: name, value }
		if (StorageVolumeParam.has(name) && value)
			return { type: 'storageVolumeParamChanged', volume: u8(path[1]), param: name, value }
	}

	// Path-length-1 singletons whose property names are unique to each family.
	if (path.length === 1 && value) {
		if (AudioParam.has(name)) return { type: 'audioParamChanged', param: name, value }
		if (BuildParam.has(name)) return { type: 'buildParamChanged', param: name, value }
		if (AppParam.has(name)) return { type: 'appParamChanged', param: name, value }
		if (ThemeParam.has(name)) return { type: 'themeParamChanged', param: name, value }
		if (CurrentShowParam.has(name)) return { type: 'currentShowParamChanged', param: name, value }
		if (ShowControlParam.has(name)) return { type: 'showControlParamChanged', param: name, value }
	}

	// Path-length-2 children under SHOWS and METER containers.
	if (path.length === 2 && value) {
		if (ShowParam.has(name)) return { type: 'showParamChanged', show: u8(path[1]), param: name, value }
		if (path[0] !== layout.physicalInterfaceIdx && MeterParam.has(name)) {
			return { type: 'meterParamChanged', meter: u8(path[1]), param: name, value }
		}
	}

	// SIP families, layout-resolved.
	if (layout.isSingletonPath('sipCalling', path) && SipCallingParam.has(name) && value) {
		return { type: 'sipCallingParamChanged', param: name, value }
	}
	if (layout.isSingletonPath('sipAdvanced', path) && SipAdvancedParam.has(name) && value) {
		return { type: 'sipAdvancedParamChanged', param: name, value }
	}
	{
		const reg = layout.runIndexFromPath('sipRegistration', path)
		if (reg !== null && SipRegistrationParam.has(name) && value) {
			return { type: 'sipRegistrationParamChanged', registration: reg, param: name, value }
		}
		const slot = layout.runIndexFromPath('sipCallSlots', path)
		if (slot !== null && SipCallSlotsParam.has(name) && value) {
			return { type: 'sipCallSlotsParamChanged', slot, param: name, value }
		}
	}

	// Small families keyed by name; per-instance ordinal is path.last().
	const last = path.length ? u8(path[path.length - 1]) : 0
	if (value) {
		if (StreamerXMixPresetParam.has(name))
			return { type: 'streamerXMixPresetParamChanged', preset: last, param: name, value }
		if (StreamerXStreamMixParam.has(name))
			return { type: 'streamerXStreamMixParamChanged', stream: last, param: name, value }
		if (FxPresetParam.has(name)) return { type: 'fxPresetParamChanged', preset: last, param: name, value }
		if (PadRecorderParam.has(name)) return { type: 'padRecorderParamChanged', padRecorder: last, param: name, value }
		if (TestParam.has(name)) return { type: 'testParamChanged', param: name, value }
		if (WifiScanResultParam.has(name)) return { type: 'wifiScanResultChanged', slot: last, param: name, value }
		if (RadioParam.has(name)) return { type: 'radioParamChanged', param: name, value }
		if (RadioTxParam.has(name)) return { type: 'radioTxParamChanged', tx: last, param: name, value }
		if (RadioRxParam.has(name)) return { type: 'radioRxParamChanged', rx: last, param: name, value }
	}
	{
		const minuses = layout.runIndexFromPath('mixMinuses', path)
		if (minuses !== null && MixMinusesParam.has(name) && value) {
			return { type: 'mixMinusesParamChanged', minuses, param: name, value }
		}
		// RCSYNCMIX shares six wire names with the MIX cell family; the MIX
		// matrix decode above already claimed paths inside the discovered run.
		const mix = layout.runIndexFromPath('rcsyncMix', path)
		if (mix !== null && RcSyncMixParam.has(name) && value) {
			return { type: 'rcSyncMixParamChanged', mix, param: name, value }
		}
	}

	// Typed param-family promotion: any other property on an addressable node.
	const target = resolveParamTarget(path, name, layout)
	if (target && value) {
		switch (target.family) {
			case 'channel':
				return { type: 'channelParamChanged', fader: target.fader, param: name, value }
			case 'inputSource':
				return { type: 'inputSourceParamChanged', source: target.source, param: name, value }
			case 'master':
				return { type: 'masterParamChanged', param: name, value }
			case 'output':
				return { type: 'outputParamChanged', param: name, value }
			case 'ducker':
				return { type: 'duckerParamChanged', param: name, value }
			case 'recorder':
				return { type: 'recorderParamChanged', param: name, value }
			case 'player':
				return { type: 'playerParamChanged', param: name, value }
			case 'headphone':
				return { type: 'headphoneParamChanged', headphone: target.index, param: name, value }
			case 'effects':
				return { type: 'effectsParamChanged', effects: target.index, param: name, value }
			case 'gui':
				return { type: 'guiParamChanged', param: name, value }
			case 'pad':
				return { type: 'padParamChanged', pad: target.index, param: name, value }
			case 'system':
				return { type: 'systemParamChanged', param: name, value }
			default:
				break
		}
	}
	return { type: 'unknown', propName: name, path: path.slice(), value }
}

/**
 * Which addressable node family a property path lands on. Node index ranges
 * are disjoint, so first match wins.
 * @param {number[]} path
 * @param {string} name
 * @param {Layout} layout
 * @returns {{ family: string, fader?: import('./names.js').FaderId, source?: import('./names.js').SourceId, index?: number } | null}
 */
function resolveParamTarget(path, name, layout) {
	const model = layout.model
	if (name !== 'channelOutputMute' && name !== 'channelCueEnable' && name !== 'channelInputSource') {
		const idx = layout.channelIndexFromPath(path)
		const fader = idx === null ? null : Fader.fromIndex(model, idx)
		if (fader) return { family: 'channel', fader }
	}
	{
		const idx = layout.inputSourceIndexFromPath(path)
		const source = idx === null ? null : Source.fromProtocol(idx)
		if (source) return { family: 'inputSource', source }
	}
	if (layout.isMasterChannelPath(path)) return { family: 'master' }
	if (layout.isOutputPath(path)) return { family: 'output' }
	if (layout.isDuckerPath(path)) return { family: 'ducker' }
	if (layout.isRecorderPath(path)) return { family: 'recorder' }
	if (layout.isPlayerPath(path)) return { family: 'player' }
	{
		const h = layout.headphoneIndexFromPath(path)
		if (h !== null) return { family: 'headphone', index: h }
		const e = layout.effectsIndexFromPath(path)
		if (e !== null) return { family: 'effects', index: e }
	}
	if (layout.isGuiPath(path)) return { family: 'gui' }
	{
		const p = layout.padIndexFromPath(path)
		if (p !== null) return { family: 'pad', index: p }
	}
	if (layout.isSystemPath(path)) return { family: 'system' }
	return null
}

/**
 * `mixLevelWithAnchor` wire form: `anchor|value` (or a single number for
 * both). Returns the left/configured matrix level and the right/fader-tracked
 * level, or `null` if either half is not a number.
 * @param {string} s
 * @returns {{ anchor: number, value: number } | null}
 */
export function parseMixLevel(s) {
	const parts = s.split('|')
	const anchor = parseNumberStrict(parts[0])
	const value = parseNumberStrict(parts[parts.length - 1])
	if (anchor === null || value === null) return null
	return { anchor, value }
}

/** @param {string} s */
function parseNumberStrict(s) {
	const t = s.trim()
	if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
	const n = Number(t)
	return Number.isFinite(n) ? n : null
}

/**
 * Walk a parsed fullSync tree and extract the initial device state as a list
 * of events, in the same order as the Rust `extract_initial_state`.
 * @param {ValueTree} root
 * @param {Layout} layout
 * @returns {DeviceEvent[]}
 */
export function extractInitialState(root, layout) {
	/** @type {DeviceEvent[]} */
	const out = []
	const model = layout.model

	// 1. PHYSICALINTERFACE -> FADER initial levels.
	const phys = root.findChild('PHYSICALINTERFACE')
	if (phys) {
		let faderIdx = 0
		for (const child of phys.children) {
			if (child.type !== 'FADER') continue
			const fader = Fader.fromIndex(model, faderIdx)
			const level = asInt(child.get('faderLevel'))
			if (fader && level !== null) out.push({ type: 'faderLevelChanged', fader, level: clampLevel(level) })
			faderIdx = Math.min(255, faderIdx + 1)
		}
	}

	// 2. CHANNEL initial mute/cue/assignment + every other strip property.
	let channelIdx = 0
	for (const child of root.children) {
		if (child.type !== 'CHANNEL') continue
		const fader = Fader.fromIndex(model, channelIdx)
		if (fader) {
			const muted = asBool(child.get('channelOutputMute'))
			if (muted !== null) out.push({ type: 'faderMuteChanged', fader, muted })
			const enabled = asBool(child.get('channelCueEnable'))
			if (enabled !== null) out.push({ type: 'faderCueChanged', fader, enabled })
			const sourceI = asInt(child.get('channelInputSource'))
			if (sourceI !== null) {
				out.push({
					type: 'faderAssignmentChanged',
					fader,
					source: sourceI < 0 ? null : sourceFromValue(child.get('channelInputSource')),
				})
			}
			for (const [pname, pvalue] of child.properties) {
				if (pname === 'channelOutputMute' || pname === 'channelCueEnable' || pname === 'channelInputSource') continue
				out.push({ type: 'channelParamChanged', fader, param: pname, value: pvalue })
			}
		}
		channelIdx = Math.min(255, channelIdx + 1)
	}

	// 3. MIX cells, source-major. Cells past the named vocabulary are skipped
	// but the counter still advances.
	let mixCounter = 0
	const perSource = layout.mixCountPerSource
	for (const child of root.children) {
		if (child.type !== 'MIX') continue
		const sourceIdx = Math.floor(mixCounter / perSource)
		const mixIdx = mixCounter % perSource
		mixCounter++
		const source = sourceIdx <= 255 ? Source.fromProtocol(sourceIdx) : null
		const mix = MixOutput.fromProtocol(mixIdx)
		if (!source || !mix) continue
		const levelS = asString(child.get('mixLevelWithAnchor'))
		const parsed = levelS === null ? null : parseMixLevel(levelS)
		if (parsed) out.push({ type: 'mixLevelChanged', source, mix, anchor: parsed.anchor, value: parsed.value })
		const muted = asBool(child.get('mixMute'))
		if (muted !== null) out.push({ type: 'mixMuteChanged', source, mix, muted })
		const linked = asBool(child.get('mixLink'))
		if (linked !== null) out.push({ type: 'mixLinkChanged', source, mix, linked })
		const disabled = asBool(child.get('mixDisabled'))
		if (disabled !== null) out.push({ type: 'mixDisabledChanged', source, mix, disabled })
	}

	// 4. INPUTSOURCE params; ordinal == inputId == Source protocol index.
	let inputSourceIdx = 0
	for (const child of root.children) {
		if (child.type !== 'INPUTSOURCE') continue
		const ordinal = inputSourceIdx++
		const source = ordinal <= 255 ? Source.fromProtocol(ordinal) : null
		if (!source) continue
		for (const [pname, pvalue] of child.properties) {
			out.push({ type: 'inputSourceParamChanged', source, param: pname, value: pvalue })
		}
	}

	// 5./6./9./11. Singletons: every property as a key-less typed event.
	const singletonEvents = /** @type {const} */ ([
		['MASTERCHANNEL', 'masterParamChanged'],
		['OUTPUT', 'outputParamChanged'],
		['DUCKER', 'duckerParamChanged'],
		['RECORDER', 'recorderParamChanged'],
		['PLAYER', 'playerParamChanged'],
	])
	for (const [nodeType, eventType] of singletonEvents) {
		const node = root.findChild(nodeType)
		if (!node) continue
		for (const [pname, pvalue] of node.properties) out.push({ type: eventType, param: pname, value: pvalue })
	}

	// 7. HEADPHONE (every node in tree order; ordinal = headphone index).
	let headphoneIdx = 0
	for (const child of root.children) {
		if (child.type !== 'HEADPHONE') continue
		const headphone = headphoneIdx
		headphoneIdx = Math.min(255, headphoneIdx + 1)
		for (const [pname, pvalue] of child.properties) {
			out.push({ type: 'headphoneParamChanged', headphone, param: pname, value: pvalue })
		}
	}

	// 8. EFFECTS_PARAMETERS: only the first contiguous run at root.
	let effectsIdx = 0
	let seenEffects = false
	for (const child of root.children) {
		if (child.type !== 'EFFECTS_PARAMETERS') {
			if (seenEffects) break
			continue
		}
		seenEffects = true
		const effects = effectsIdx
		effectsIdx = Math.min(255, effectsIdx + 1)
		for (const [pname, pvalue] of child.properties) {
			out.push({ type: 'effectsParamChanged', effects, param: pname, value: pvalue })
		}
	}

	// 9. GUI singleton.
	{
		const node = root.findChild('GUI')
		if (node)
			for (const [pname, pvalue] of node.properties) out.push({ type: 'guiParamChanged', param: pname, value: pvalue })
	}

	// 10. SOUNDPADS -> PAD: only the first contiguous run inside the container.
	const soundpads = root.findChild('SOUNDPADS')
	if (soundpads) {
		let padIdx = 0
		let seenPad = false
		for (const child of soundpads.children) {
			if (child.type !== 'PAD') {
				if (seenPad) break
				continue
			}
			seenPad = true
			const pad = padIdx
			padIdx = Math.min(255, padIdx + 1)
			for (const [pname, pvalue] of child.properties) {
				out.push({ type: 'padParamChanged', pad, param: pname, value: pvalue })
			}
		}
	}

	// 11. SYSTEM singleton.
	{
		const node = root.findChild('SYSTEM')
		if (node)
			for (const [pname, pvalue] of node.properties)
				out.push({ type: 'systemParamChanged', param: pname, value: pvalue })
	}

	return out
}
