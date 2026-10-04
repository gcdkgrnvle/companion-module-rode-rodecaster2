/**
 * Typed command builders: turn a high-level command into one or more
 * change-frame bodies, resolving names to wire paths through a {@link Layout}.
 *
 * Port of `rodecaster-protocol/src/commands.rs` (MIT, Yeradon).
 *
 * A command is a plain object keyed by `type`, for example
 * `{ type: 'setFaderMute', fader: 'physical1', mute: true }`. See
 * {@link Command} for every shape. Parameter commands carry `param` (the wire
 * property name) and `value` (a juce-var Value built with `V.*`).
 *
 * @module protocol/commands
 */

import { encodePropertyChanged } from './change-frame.js'
import { V } from './juce-var.js'
import { DeviceModel, Fader, MixOutput, Source } from './names.js'
import { pressValue } from './trigger.js'

/** @typedef {import('./juce-var.js').Value} Value */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./names.js').FaderId} FaderId */
/** @typedef {import('./names.js').SourceId} SourceId */
/** @typedef {import('./names.js').MixOutputId} MixOutputId */

/**
 * @typedef {{ type: 'setFaderMute', fader: FaderId, mute: boolean }
 *   | { type: 'setFaderCue', fader: FaderId, enable: boolean }
 *   | { type: 'setFaderLevel', fader: FaderId, level: number }
 *   | { type: 'assignFaderSource', fader: FaderId, source: SourceId | null }
 *   | { type: 'setMixDisabled', source: SourceId, mix: MixOutputId, disabled: boolean }
 *   | { type: 'setMixMute', source: SourceId, mix: MixOutputId, mute: boolean }
 *   | { type: 'linkMix', source: SourceId, mix: MixOutputId }
 *   | { type: 'unlinkMix', source: SourceId, mix: MixOutputId }
 *   | { type: 'setMixLevel', source: SourceId, mix: MixOutputId, anchor: number, value: number }
 *   | { type: 'screenTouched' }
 *   | { type: 'powerOff' }
 *   | { type: 'linkCallMe', source: SourceId, mix: MixOutputId }
 *   | { type: 'unlinkCallMe', source: SourceId, mix: MixOutputId }
 *   | { type: 'setChannelParam', fader: FaderId, param: string, value: Value }
 *   | { type: 'setInputSourceParam', source: SourceId, param: string, value: Value }
 *   | { type: 'setMasterParam' | 'setOutputParam' | 'setDuckerParam' | 'setRecorderParam' | 'setPlayerParam' | 'setGuiParam' | 'setSystemParam' | 'setSipCallingParam' | 'setSipAdvancedParam' | 'setTestParam' | 'setNetworkParam' | 'setAudioParam' | 'setBuildParam' | 'setAppParam' | 'setThemeParam' | 'setCurrentShowParam' | 'setShowControlParam' | 'setRecordingsParam' | 'setRadioParam', param: string, value: Value }
 *   | { type: 'setHeadphoneParam', headphone: number, param: string, value: Value }
 *   | { type: 'setEffectsParam', effects: number, param: string, value: Value }
 *   | { type: 'setPadParam', pad: number, param: string, value: Value }
 *   | { type: 'setSipRegistrationParam', registration: number, param: string, value: Value }
 *   | { type: 'setSipCallSlotsParam', slot: number, param: string, value: Value }
 *   | { type: 'setPadRecorderParam', padRecorder: number, param: string, value: Value }
 *   | { type: 'setFxPresetParam', preset: number, param: string, value: Value }
 *   | { type: 'setShowParam', show: number, param: string, value: Value }
 *   | { type: 'setRecordingParam', recording: number, param: string, value: Value }
 *   | { type: 'setStorageVolumeParam', volume: number, param: string, value: Value }
 *   | { type: 'setRadioTxParam', tx: number, param: string, value: Value }
 *   | { type: 'setRadioRxParam', rx: number, param: string, value: Value }
 *   | { type: 'setWifiScanResultParam', slot: number, param: string, value: Value }
 *   | { type: 'setStreamerXMixPresetParam', preset: number, param: string, value: Value }
 *   | { type: 'setStreamerXStreamMixParam', stream: number, param: string, value: Value }
 *   | { type: 'setRcSyncMixParam', mix: number, param: string, value: Value }
 *   | { type: 'setMixMinusesParam', minuses: number, param: string, value: Value }
 *   | { type: 'setupSkip', language?: string | null, timezone?: string | null }} Command
 */

/** JUCE Int value meaning "unassigned" for `channelInputSource`. */
export const CHANNEL_INPUT_SOURCE_UNASSIGNED = -1

/**
 * Verbatim wire bytes for the screen-wake message: PropertyChanged, path
 * depth 1, a 1-byte path entry of value 1, then "screenTouched\0" with NO
 * var value. Emitted verbatim by RODE Central to wake the touchscreen.
 */
export const SCREEN_TOUCHED_FRAME = Buffer.from([0x01, 0x01, 0x01, 0x01, ...Buffer.from('screenTouched'), 0x00])

/**
 * Mix offset for CallMe return-channel routing requests, used as
 * `(source << 8) | (CALLME_MIX_PATH_OFFSET + mix)`.
 */
export const CALLME_MIX_PATH_OFFSET = 4

/** Thrown by {@link encodeCommand} when the command cannot be addressed on the layout. */
export class EncodeError extends Error {
	/**
	 * @param {'outOfRange' | 'mixCellOutOfRange' | 'faderNotOnModel' | 'missingNode'} code
	 * @param {Record<string, unknown>} fields
	 */
	constructor(code, fields) {
		super(EncodeError.describe(code, fields))
		this.name = 'EncodeError'
		this.code = code
		Object.assign(this, fields)
	}

	/**
	 * @param {string} code
	 * @param {Record<string, any>} f
	 */
	static describe(code, f) {
		switch (code) {
			case 'outOfRange':
				return `${f.what} index ${f.index} out of range (bound ${f.bound})`
			case 'mixCellOutOfRange':
				return `mix cell (${f.source}, ${f.mix}) out of range (sources ${f.sourceBound}, mixes ${f.mixBound})`
			case 'faderNotOnModel':
				return `fader ${f.fader} does not exist on ${DeviceModel.label(f.model)}`
			case 'missingNode':
				return `layout has no ${f.what} node`
			default:
				return code
		}
	}
}

/** Singleton param commands: command type -> [layout singleton key, node name]. */
const SINGLETON_COMMANDS = Object.freeze({
	setMasterParam: ['masterChannel', 'MASTERCHANNEL'],
	setOutputParam: ['output', 'OUTPUT'],
	setDuckerParam: ['ducker', 'DUCKER'],
	setRecorderParam: ['recorder', 'RECORDER'],
	setPlayerParam: ['player', 'PLAYER'],
	setGuiParam: ['gui', 'GUI'],
	setSystemParam: ['system', 'SYSTEM'],
	setSipCallingParam: ['sipCalling', 'SIPCALLING'],
	setSipAdvancedParam: ['sipAdvanced', 'SIPADVANCED'],
	setTestParam: ['test', 'TEST'],
	setNetworkParam: ['network', 'NETWORK'],
	setAudioParam: ['audio', 'AUDIO'],
	setBuildParam: ['build', 'BUILD'],
	setAppParam: ['app', 'APP'],
	setThemeParam: ['theme', 'THEME'],
	setCurrentShowParam: ['currentShow', 'CURRENTSHOW'],
	setShowControlParam: ['showControl', 'SHOWCONTROL'],
	setRecordingsParam: ['recordings', 'RECORDINGS'],
	setRadioParam: ['radio', 'RADIO'],
})

/**
 * Indexed param commands addressed by a run with a `MissingNode` error on
 * failure (the Rust `encode_indexed!` macro): command type -> [run key, index
 * field, node name].
 */
const INDEXED_COMMANDS = Object.freeze({
	setSipRegistrationParam: ['sipRegistration', 'registration', 'SIPREGISTRATION'],
	setSipCallSlotsParam: ['sipCallSlots', 'slot', 'SIPCALLSLOTS'],
	setPadRecorderParam: ['padRecorder', 'padRecorder', 'PADRECORDER'],
	setFxPresetParam: ['fxPreset', 'preset', 'FXPRESET'],
	setShowParam: ['show', 'show', 'SHOW'],
	setRecordingParam: ['recording', 'recording', 'RECORDING'],
	setStorageVolumeParam: ['storageVolume', 'volume', 'STORAGEVOLUME'],
	setRadioTxParam: ['radioTx', 'tx', 'RADIOTX'],
	setRadioRxParam: ['radioRx', 'rx', 'RADIORX'],
	setWifiScanResultParam: ['wifiScanResult', 'slot', 'WIFISCANRESULT'],
	setStreamerXMixPresetParam: ['streamerxMixPreset', 'preset', 'STREAMERXMIXPRESET'],
	setStreamerXStreamMixParam: ['streamerxStreamMix', 'stream', 'STREAMERXSTREAMMIX'],
	setRcSyncMixParam: ['rcsyncMix', 'mix', 'RCSYNCMIX'],
	setMixMinusesParam: ['mixMinuses', 'minuses', 'MIXMINUSES'],
})

/**
 * Resolve a fader name to its wire index on the layout's model.
 * @param {Layout} layout
 * @param {FaderId} fader
 */
function faderIndex(layout, fader) {
	const idx = Fader.toIndex(fader, layout.model)
	if (idx === null) throw new EncodeError('faderNotOnModel', { fader, model: layout.model })
	return idx
}

/**
 * Single-level request path for a CallMe routing cell.
 * @param {SourceId} source
 * @param {MixOutputId} mix
 */
function callmeRequestPath(source, mix) {
	return [(Source.toProtocol(source) << 8) | (CALLME_MIX_PATH_OFFSET + MixOutput.toProtocol(mix))]
}

/** @param {Layout} layout @param {number} idx */
function channelPath(layout, idx) {
	const p = layout.channelPath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'fader', index: idx, bound: layout.channelCount })
	return p
}
/** @param {Layout} layout @param {number} idx */
function faderPath(layout, idx) {
	const p = layout.faderPath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'fader', index: idx, bound: layout.faderCount })
	return p
}
/** @param {Layout} layout @param {SourceId} source */
function inputSourcePath(layout, source) {
	const idx = Source.toProtocol(source)
	const p = layout.inputSourcePath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'input source', index: idx, bound: layout.inputSourceCount })
	return p
}
/** @param {Layout} layout @param {number} idx */
function headphonePath(layout, idx) {
	const p = layout.headphonePath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'headphone', index: idx, bound: layout.headphoneCount })
	return p
}
/** @param {Layout} layout @param {number} idx */
function effectsPath(layout, idx) {
	const p = layout.effectsPath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'effects', index: idx, bound: layout.effectsCount })
	return p
}
/** @param {Layout} layout @param {number} idx */
function padPath(layout, idx) {
	const p = layout.padPath(idx)
	if (!p) throw new EncodeError('outOfRange', { what: 'pad', index: idx, bound: layout.padCount })
	return p
}
/** @param {Layout} layout @param {SourceId} source @param {MixOutputId} mix */
function mixPath(layout, source, mix) {
	const s = Source.toProtocol(source)
	const m = MixOutput.toProtocol(mix)
	const p = layout.mixCellPath(s, m)
	if (!p) {
		throw new EncodeError('mixCellOutOfRange', {
			source: s,
			mix: m,
			sourceBound: layout.sourceCount,
			mixBound: layout.mixCountPerSource,
		})
	}
	return p
}

/**
 * Format a mix level like Rust's `format!("{:.1}|{:.1}", anchor, value)`.
 * @param {number} anchor
 * @param {number} value
 */
export function formatMixLevel(anchor, value) {
	return `${anchor.toFixed(1)}|${value.toFixed(1)}`
}

/**
 * Encode a command into one or more change-frame bodies to send in order.
 * Throws {@link EncodeError} if the addressed entity does not exist in the
 * layout. Wrap each body with `usb.encodeReports` for the transport.
 * @param {Command} command
 * @param {Layout} layout
 * @returns {Buffer[]}
 */
export function encodeCommand(command, layout) {
	const c = /** @type {any} */ (command)
	switch (command.type) {
		case 'setFaderMute':
			return [
				encodePropertyChanged(channelPath(layout, faderIndex(layout, c.fader)), 'channelOutputMute', V.bool(c.mute)),
			]
		case 'setFaderCue':
			return [
				encodePropertyChanged(channelPath(layout, faderIndex(layout, c.fader)), 'channelCueEnable', V.bool(c.enable)),
			]
		case 'setFaderLevel':
			return [encodePropertyChanged(faderPath(layout, faderIndex(layout, c.fader)), 'faderLevel', V.int(c.level))]
		case 'assignFaderSource': {
			const path = channelPath(layout, faderIndex(layout, c.fader))
			const sourceValue =
				c.source === null || c.source === undefined ? CHANNEL_INPUT_SOURCE_UNASSIGNED : Source.toProtocol(c.source)
			return [encodePropertyChanged(path, 'channelInputSource', V.int(sourceValue))]
		}
		case 'setMixDisabled':
			return [encodePropertyChanged(mixPath(layout, c.source, c.mix), 'mixDisabled', V.bool(c.disabled))]
		case 'setMixMute':
			return [encodePropertyChanged(mixPath(layout, c.source, c.mix), 'mixMute', V.bool(c.mute))]
		case 'linkMix': {
			// Device-validated sequence: enable, unmute, then the mixLinkRequest pulse.
			const path = mixPath(layout, c.source, c.mix)
			return [
				encodePropertyChanged(path, 'mixDisabled', V.bool(false)),
				encodePropertyChanged(path, 'mixMute', V.bool(false)),
				encodePropertyChanged(path, 'mixLinkRequest', pressValue()),
			]
		}
		case 'unlinkMix':
			return [encodePropertyChanged(mixPath(layout, c.source, c.mix), 'mixUnlinkRequest', pressValue())]
		case 'setMixLevel':
			return [
				encodePropertyChanged(
					mixPath(layout, c.source, c.mix),
					'mixLevelWithAnchor',
					V.string(formatMixLevel(c.anchor, c.value)),
				),
			]
		case 'screenTouched':
			return [Buffer.from(SCREEN_TOUCHED_FRAME)]
		case 'powerOff': {
			const path = layout.systemPath()
			if (!path) throw new EncodeError('missingNode', { what: 'SYSTEM' })
			return [encodePropertyChanged(path, 'powerOffRequest', V.bool(true))]
		}
		case 'linkCallMe':
			return [encodePropertyChanged(callmeRequestPath(c.source, c.mix), 'mixLinkRequest', pressValue())]
		case 'unlinkCallMe':
			return [encodePropertyChanged(callmeRequestPath(c.source, c.mix), 'mixUnlinkRequest', pressValue())]
		case 'setChannelParam':
			return [encodePropertyChanged(channelPath(layout, faderIndex(layout, c.fader)), c.param, c.value)]
		case 'setInputSourceParam':
			return [encodePropertyChanged(inputSourcePath(layout, c.source), c.param, c.value)]
		case 'setHeadphoneParam':
			return [encodePropertyChanged(headphonePath(layout, c.headphone), c.param, c.value)]
		case 'setEffectsParam':
			return [encodePropertyChanged(effectsPath(layout, c.effects), c.param, c.value)]
		case 'setPadParam':
			return [encodePropertyChanged(padPath(layout, c.pad), c.param, c.value)]
		case 'setupSkip': {
			const frames = []
			const gui = layout.guiPath()
			const sys = layout.systemPath()
			const showControl = layout.singletonPath('showControl')
			if (c.language != null && gui) {
				frames.push(encodePropertyChanged(gui, 'lang', V.string(c.language)))
			}
			if (c.timezone != null && sys) {
				frames.push(encodePropertyChanged(sys, 'systemDateTimezone', V.string(c.timezone)))
				frames.push(encodePropertyChanged(sys, 'systemDateTime24h', V.bool(true)))
				frames.push(encodePropertyChanged(sys, 'systemDateTimeOnHome', V.bool(true)))
			}
			if (showControl) {
				frames.push(encodePropertyChanged(showControl, 'showControlNewFromDefaultMuted', V.bool(true)))
			}
			if (sys) {
				frames.push(encodePropertyChanged(sys, 'disableAllPhysicalButtons', V.bool(false)))
				frames.push(encodePropertyChanged(sys, 'disableAllLineoutOutputs', V.bool(false)))
				frames.push(encodePropertyChanged(sys, 'disableAllHeadphoneOutputs', V.bool(false)))
				frames.push(encodePropertyChanged(sys, 'systemChannelSelected', V.int(-1)))
			}
			return frames
		}
		default: {
			const singleton = SINGLETON_COMMANDS[/** @type {keyof typeof SINGLETON_COMMANDS} */ (command.type)]
			if (singleton) {
				const [key, what] = singleton
				const path = layout.singletonPath(/** @type {any} */ (key))
				if (!path) throw new EncodeError('missingNode', { what })
				return [encodePropertyChanged(path, c.param, c.value)]
			}
			const indexed = INDEXED_COMMANDS[/** @type {keyof typeof INDEXED_COMMANDS} */ (command.type)]
			if (indexed) {
				const [key, field, what] = indexed
				const path = layout.runPath(/** @type {any} */ (key), c[field])
				if (!path) throw new EncodeError('missingNode', { what })
				return [encodePropertyChanged(path, c.param, c.value)]
			}
			throw new TypeError(`unknown command type: ${command.type}`)
		}
	}
}
