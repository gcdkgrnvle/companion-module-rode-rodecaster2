/**
 * Dynamic device topology discovery and address translation.
 *
 * RODECaster devices do not use fixed wire addresses across models and
 * firmware versions. The console sends its whole state tree (`fullSync`) on
 * connect; {@link Layout} inspects that tree to find where the CHANNEL strips,
 * physical FADERs, INPUTSOURCEs, the MIX matrix, sound PADs, effects slots and
 * the singleton nodes (OUTPUT, RECORDER, GUI, SYSTEM, ...) sit, so commands
 * and events can translate between names and child-index paths.
 *
 * Port of `rodecaster-protocol/src/layout.rs` (MIT, Yeradon).
 *
 * @module protocol/layout
 */

import { asInt, asString } from './juce-var.js'
import { DeviceModel } from './names.js'

/** @typedef {import('./valuetree.js').ValueTree} ValueTree */
/** @typedef {import('./names.js').DeviceModelId} DeviceModelId */

/**
 * Mix destinations per source in the Pro II / Duo mix matrix (firmware 1.7.x
 * observation). A device characteristic, not a JUCE fact: the total MIX node
 * count factors as `sourceCount * MIX_COUNT_PER_SOURCE`, and one dimension
 * cannot be recovered from the fullSync alone, so this constant pins it.
 */
export const MIX_COUNT_PER_SOURCE = 13

/** Thrown by {@link Layout.fromFullSync} when the tree lacks a required node family. */
export class LayoutError extends Error {
	/**
	 * @param {'missingNode' | 'shapeMismatch'} code
	 * @param {string} what
	 * @param {string} [detail]
	 */
	constructor(code, what, detail) {
		super(
			code === 'missingNode'
				? `fullSync missing required node: ${what}`
				: `fullSync shape mismatch for ${what}: ${detail}`,
		)
		this.name = 'LayoutError'
		this.code = code
		this.what = what
		this.detail = detail
	}
}

/** One addressable singleton node (no index): its root-child position, or absent. */
class Singleton {
	/** @param {number | null} idx */
	constructor(idx) {
		this.idx = idx
	}
	/** @returns {number[] | null} */
	path() {
		return this.idx === null ? null : [this.idx]
	}
	/** @param {number[]} path */
	isPath(path) {
		return this.idx !== null && path.length === 1 && path[0] === this.idx
	}
}

/** A contiguous run of same-typed nodes under root, addressed as `[first + n]`. */
class Indexed {
	/**
	 * @param {number | null} first
	 * @param {number} count
	 */
	constructor(first, count) {
		this.first = first
		this.count = count
	}
	/** @param {number} n @returns {number[] | null} */
	path(n) {
		if (this.first === null || n < 0 || n >= this.count) return null
		return [this.first + n]
	}
	/** @param {number[]} path @returns {number | null} */
	indexFromPath(path) {
		if (this.first === null || path.length !== 1) return null
		const n = path[0] - this.first
		return n >= 0 && n < this.count ? n : null
	}
}

/** A run of same-typed children under a container, addressed as `[parent, first + n]`. */
class TwoLevel {
	/**
	 * @param {number | null} parent
	 * @param {number} first
	 * @param {number} count
	 */
	constructor(parent, first, count) {
		this.parent = parent
		this.first = first
		this.count = count
	}
	/** @param {number} n @returns {number[] | null} */
	path(n) {
		if (this.parent === null || n < 0 || n >= this.count) return null
		return [this.parent, this.first + n]
	}
	/** @param {number[]} path @returns {number | null} */
	indexFromPath(path) {
		if (this.parent === null || path.length !== 2 || path[0] !== this.parent) return null
		const n = path[1] - this.first
		return n >= 0 && n < this.count ? n : null
	}
}

/**
 * @param {ValueTree} parent
 * @param {string} type
 * @returns {number | null}
 */
function positionOfNamedChild(parent, type) {
	const i = parent.indexOfChild(type)
	return i < 0 ? null : i
}

/**
 * Length of the run of `type` children from `start`, saturating at 255 like
 * the Rust u8 counters.
 * @param {ValueTree} parent
 * @param {number} start
 * @param {string} type
 */
function countConsecutiveU8(parent, start, type) {
	return Math.min(255, parent.countConsecutive(start, type))
}

/**
 * First contiguous run of `type` children under `parent`.
 * @param {ValueTree} parent
 * @param {string} type
 */
function discoverRun(parent, type) {
	const first = positionOfNamedChild(parent, type)
	return first === null ? new Indexed(null, 0) : new Indexed(first, countConsecutiveU8(parent, first, type))
}

/**
 * Two-level run of `childType` inside the `containerType` node under root.
 * @param {ValueTree} root
 * @param {string} containerType
 * @param {string} childType
 */
function discoverTwoLevel(root, containerType, childType) {
	const parent = positionOfNamedChild(root, containerType)
	if (parent === null) return new TwoLevel(null, 0, 0)
	const container = root.children[parent]
	const first = positionOfNamedChild(container, childType)
	if (first === null) return new TwoLevel(parent, 0, 0)
	return new TwoLevel(parent, first, countConsecutiveU8(container, first, childType))
}

/**
 * Read `SYSTEM.boardType` / `SYSTEM.systemName` and resolve the model.
 * Missing SYSTEM (synthetic trees, partial captures) -> Pro II default.
 * @param {ValueTree} root
 * @returns {DeviceModelId}
 */
export function detectModel(root) {
	const sys = root.findChild('SYSTEM')
	const boardType = sys ? asInt(sys.get('boardType')) : null
	const systemName = sys ? asString(sys.get('systemName')) : null
	return DeviceModel.detect(boardType, systemName)
}

/** Root singleton families: layout key -> node type name. */
export const SINGLETONS = Object.freeze({
	masterChannel: 'MASTERCHANNEL',
	output: 'OUTPUT',
	ducker: 'DUCKER',
	recorder: 'RECORDER',
	player: 'PLAYER',
	gui: 'GUI',
	system: 'SYSTEM',
	sipCalling: 'SIPCALLING',
	sipAdvanced: 'SIPADVANCED',
	test: 'TEST',
	network: 'NETWORK',
	audio: 'AUDIO',
	build: 'BUILD',
	app: 'APP',
	theme: 'THEME',
	currentShow: 'CURRENTSHOW',
	showControl: 'SHOWCONTROL',
	recordings: 'RECORDINGS',
	radio: 'RADIO',
})

/** Single-level runs at root: layout key -> node type name. */
export const ROOT_RUNS = Object.freeze({
	inputSource: 'INPUTSOURCE',
	headphone: 'HEADPHONE',
	effects: 'EFFECTS_PARAMETERS',
	sipCallSlots: 'SIPCALLSLOTS',
	padRecorder: 'PADRECORDER',
	storageVolume: 'STORAGEVOLUME',
	radioTx: 'RADIOTX',
	radioRx: 'RADIORX',
	wifiScanResult: 'WIFISCANRESULT',
	streamerxMixPreset: 'STREAMERXMIXPRESET',
	streamerxStreamMix: 'STREAMERXSTREAMMIX',
	rcsyncMix: 'RCSYNCMIX',
	mixMinuses: 'MIXMINUSES',
})

/** Two-level runs: layout key -> [container type, child type]. */
export const CONTAINER_RUNS = Object.freeze({
	pad: ['SOUNDPADS', 'PAD'],
	sipRegistration: ['SIPCALLING', 'SIPREGISTRATION'],
	fxPreset: ['FXPRESETS', 'FXPRESET'],
	show: ['SHOWS', 'SHOW'],
	recording: ['RECORDINGS', 'RECORDING'],
})

/** @typedef {keyof typeof SINGLETONS} SingletonKey */
/** @typedef {keyof typeof ROOT_RUNS | keyof typeof CONTAINER_RUNS} RunKey */

/**
 * Tree positions of the addressable node families, all discovered from a
 * fullSync root, never hardcoded.
 */
export class Layout {
	/**
	 * Use {@link Layout.fromFullSync}.
	 * @param {object} fields
	 * @param {DeviceModelId} fields.model
	 * @param {Indexed} fields.channel
	 * @param {number} fields.firstMix
	 * @param {number} fields.sourceCount
	 * @param {TwoLevel} fields.fader
	 * @param {Record<string, Singleton>} fields.singletons
	 * @param {Record<string, Indexed | TwoLevel>} fields.runs
	 */
	constructor({ model, channel, firstMix, sourceCount, fader, singletons, runs }) {
		/** @type {DeviceModelId} */
		this.model = model
		/** @private */
		this._channel = channel
		/** @private */
		this._fader = fader
		/** @private */
		this._singletons = singletons
		/** @private */
		this._runs = runs
		/** Root index of the first MIX node. */
		this.firstMix = firstMix
		/** First dimension of the MIX matrix (number of sources). */
		this.sourceCount = sourceCount
	}

	/**
	 * Walk a parsed fullSync root and discover the layout. Throws
	 * {@link LayoutError} on missing required nodes so a future firmware layout
	 * change surfaces immediately rather than silently misrouting.
	 * @param {ValueTree} root
	 * @returns {Layout}
	 */
	static fromFullSync(root) {
		const model = detectModel(root)

		// PHYSICALINTERFACE under root with FADER children (required, two-level).
		const physIdx = positionOfNamedChild(root, 'PHYSICALINTERFACE')
		if (physIdx === null) throw new LayoutError('missingNode', 'PHYSICALINTERFACE under root')
		const phys = root.children[physIdx]
		const firstFader = positionOfNamedChild(phys, 'FADER')
		if (firstFader === null) throw new LayoutError('missingNode', 'FADER under PHYSICALINTERFACE')
		const fader = new TwoLevel(physIdx, firstFader, countConsecutiveU8(phys, firstFader, 'FADER'))

		// CHANNEL nodes under root (required, single-level).
		const firstChannel = positionOfNamedChild(root, 'CHANNEL')
		if (firstChannel === null) throw new LayoutError('missingNode', 'CHANNEL under root')
		const channel = new Indexed(firstChannel, countConsecutiveU8(root, firstChannel, 'CHANNEL'))

		// MIX nodes under root. Count, then factor by MIX_COUNT_PER_SOURCE.
		const firstMix = positionOfNamedChild(root, 'MIX')
		if (firstMix === null) throw new LayoutError('missingNode', 'MIX under root')
		const mixTotal = root.countConsecutive(firstMix, 'MIX')
		if (mixTotal === 0 || mixTotal % MIX_COUNT_PER_SOURCE !== 0) {
			throw new LayoutError(
				'shapeMismatch',
				'MIX',
				`expected mix_total divisible by MIX_COUNT_PER_SOURCE=${MIX_COUNT_PER_SOURCE}, got ${mixTotal}`,
			)
		}
		const sourceCount = mixTotal / MIX_COUNT_PER_SOURCE
		if (sourceCount > 255) {
			throw new LayoutError('shapeMismatch', 'MIX', `source_count overflows u8 (mix_total=${mixTotal})`)
		}

		/** @type {Record<string, Singleton>} */
		const singletons = {}
		for (const [key, type] of Object.entries(SINGLETONS)) {
			singletons[key] = new Singleton(positionOfNamedChild(root, type))
		}
		/** @type {Record<string, Indexed | TwoLevel>} */
		const runs = {}
		for (const [key, type] of Object.entries(ROOT_RUNS)) {
			runs[key] = discoverRun(root, type)
		}
		for (const [key, [container, child]] of Object.entries(CONTAINER_RUNS)) {
			runs[key] = discoverTwoLevel(root, container, child)
		}

		return new Layout({ model, channel, firstMix, sourceCount, fader, singletons, runs })
	}

	// Core hardware and routing

	/** Root index of PHYSICALINTERFACE. */
	get physicalInterfaceIdx() {
		return /** @type {number} */ (this._fader.parent)
	}
	/** Offset of the first FADER inside PHYSICALINTERFACE. */
	get firstFaderInPhys() {
		return this._fader.first
	}
	get faderCount() {
		return this._fader.count
	}
	/** Root index of the first CHANNEL. */
	get firstChannel() {
		return /** @type {number} */ (this._channel.first)
	}
	get channelCount() {
		return this._channel.count
	}
	get mixCountPerSource() {
		return MIX_COUNT_PER_SOURCE
	}

	/** @param {number} n @returns {number[] | null} root-down path to the nth CHANNEL */
	channelPath(n) {
		return this._channel.path(n)
	}
	/** @param {number[]} path @returns {number | null} */
	channelIndexFromPath(path) {
		return this._channel.indexFromPath(path)
	}
	/** @param {number} n @returns {number[] | null} two-level path to the nth FADER */
	faderPath(n) {
		return this._fader.path(n)
	}
	/** @param {number[]} path @returns {number | null} */
	faderIndexFromPath(path) {
		return this._fader.indexFromPath(path)
	}

	/**
	 * Root-down path to the MIX cell at (source, mix), source-major.
	 * @param {number} source
	 * @param {number} mix
	 * @returns {number[] | null}
	 */
	mixCellPath(source, mix) {
		if (source < 0 || mix < 0 || source >= this.sourceCount || mix >= MIX_COUNT_PER_SOURCE) return null
		return [this.firstMix + source * MIX_COUNT_PER_SOURCE + mix]
	}
	/**
	 * Inverse of {@link Layout.mixCellPath}.
	 * @param {number[]} path
	 * @returns {{ source: number, mix: number } | null}
	 */
	mixCellFromPath(path) {
		if (path.length !== 1) return null
		const offset = path[0] - this.firstMix
		if (offset < 0 || offset >= this.sourceCount * MIX_COUNT_PER_SOURCE) return null
		return { source: Math.floor(offset / MIX_COUNT_PER_SOURCE), mix: offset % MIX_COUNT_PER_SOURCE }
	}

	// Singletons (generic)

	/**
	 * Root index of a singleton node, or `null` if absent.
	 * @param {SingletonKey} key
	 * @returns {number | null}
	 */
	singletonIndex(key) {
		return this._singleton(key).idx
	}
	/**
	 * Root-down path to a singleton node, or `null`.
	 * @param {SingletonKey} key
	 * @returns {number[] | null}
	 */
	singletonPath(key) {
		return this._singleton(key).path()
	}
	/**
	 * True if this single-level path points at the singleton.
	 * @param {SingletonKey} key
	 * @param {number[]} path
	 */
	isSingletonPath(key, path) {
		return this._singleton(key).isPath(path)
	}
	/** @private @param {string} key */
	_singleton(key) {
		const s = this._singletons[key]
		if (!s) throw new RangeError(`unknown singleton family: ${key}`)
		return s
	}

	// Runs (generic)

	/**
	 * Root-down path to the nth node of a run, or `null`.
	 * @param {RunKey} key
	 * @param {number} n
	 * @returns {number[] | null}
	 */
	runPath(key, n) {
		return this._run(key).path(n)
	}
	/**
	 * Ordinal within a run for this path, or `null`.
	 * @param {RunKey} key
	 * @param {number[]} path
	 * @returns {number | null}
	 */
	runIndexFromPath(key, path) {
		return this._run(key).indexFromPath(path)
	}
	/**
	 * Number of nodes in a run (0 when absent).
	 * @param {RunKey} key
	 */
	runCount(key) {
		return this._run(key).count
	}
	/**
	 * Root index of the first node of a single-level run, or `null`.
	 * @param {keyof typeof ROOT_RUNS} key
	 */
	runFirst(key) {
		const r = this._run(key)
		return r instanceof Indexed ? r.first : null
	}
	/**
	 * Root index of the container of a two-level run, or `null`.
	 * @param {keyof typeof CONTAINER_RUNS} key
	 */
	runParent(key) {
		const r = this._run(key)
		return r instanceof TwoLevel ? r.parent : null
	}
	/**
	 * Offset of the first child of a two-level run inside its container.
	 * @param {keyof typeof CONTAINER_RUNS} key
	 */
	runFirstInParent(key) {
		const r = this._run(key)
		return r instanceof TwoLevel ? r.first : 0
	}
	/** @private @param {string} key */
	_run(key) {
		const r = this._runs[key]
		if (!r) throw new RangeError(`unknown run family: ${key}`)
		return r
	}

	// Named conveniences for the families commands and events use most.

	get firstInputSource() {
		return this.runFirst('inputSource')
	}
	get inputSourceCount() {
		return this.runCount('inputSource')
	}
	/** @param {number} n */
	inputSourcePath(n) {
		return this.runPath('inputSource', n)
	}
	/** @param {number[]} path */
	inputSourceIndexFromPath(path) {
		return this.runIndexFromPath('inputSource', path)
	}
	get firstHeadphone() {
		return this.runFirst('headphone')
	}
	get headphoneCount() {
		return this.runCount('headphone')
	}
	/** @param {number} n */
	headphonePath(n) {
		return this.runPath('headphone', n)
	}
	/** @param {number[]} path */
	headphoneIndexFromPath(path) {
		return this.runIndexFromPath('headphone', path)
	}
	get firstEffects() {
		return this.runFirst('effects')
	}
	get effectsCount() {
		return this.runCount('effects')
	}
	/** @param {number} n */
	effectsPath(n) {
		return this.runPath('effects', n)
	}
	/** @param {number[]} path */
	effectsIndexFromPath(path) {
		return this.runIndexFromPath('effects', path)
	}
	/** Root index of the SOUNDPADS container, or null. */
	get soundpads() {
		return this.runParent('pad')
	}
	get firstPad() {
		return this.runFirstInParent('pad')
	}
	get padCount() {
		return this.runCount('pad')
	}
	/** @param {number} n */
	padPath(n) {
		return this.runPath('pad', n)
	}
	/** @param {number[]} path */
	padIndexFromPath(path) {
		return this.runIndexFromPath('pad', path)
	}
	get sipCallSlotsCount() {
		return this.runCount('sipCallSlots')
	}
	get sipRegistrationCount() {
		return this.runCount('sipRegistration')
	}

	/** Root index of MASTERCHANNEL or null. */
	get masterChannel() {
		return this.singletonIndex('masterChannel')
	}
	get output() {
		return this.singletonIndex('output')
	}
	get ducker() {
		return this.singletonIndex('ducker')
	}
	get recorder() {
		return this.singletonIndex('recorder')
	}
	get player() {
		return this.singletonIndex('player')
	}
	get gui() {
		return this.singletonIndex('gui')
	}
	get system() {
		return this.singletonIndex('system')
	}
	masterChannelPath() {
		return this.singletonPath('masterChannel')
	}
	outputPath() {
		return this.singletonPath('output')
	}
	duckerPath() {
		return this.singletonPath('ducker')
	}
	recorderPath() {
		return this.singletonPath('recorder')
	}
	playerPath() {
		return this.singletonPath('player')
	}
	guiPath() {
		return this.singletonPath('gui')
	}
	systemPath() {
		return this.singletonPath('system')
	}
	/** @param {number[]} path */
	isMasterChannelPath(path) {
		return this.isSingletonPath('masterChannel', path)
	}
	/** @param {number[]} path */
	isOutputPath(path) {
		return this.isSingletonPath('output', path)
	}
	/** @param {number[]} path */
	isDuckerPath(path) {
		return this.isSingletonPath('ducker', path)
	}
	/** @param {number[]} path */
	isRecorderPath(path) {
		return this.isSingletonPath('recorder', path)
	}
	/** @param {number[]} path */
	isPlayerPath(path) {
		return this.isSingletonPath('player', path)
	}
	/** @param {number[]} path */
	isGuiPath(path) {
		return this.isSingletonPath('gui', path)
	}
	/** @param {number[]} path */
	isSystemPath(path) {
		return this.isSingletonPath('system', path)
	}

	/** Summary of the discovered positions (for logs). */
	toJSON() {
		return {
			model: this.model,
			physicalInterfaceIdx: this.physicalInterfaceIdx,
			firstFaderInPhys: this.firstFaderInPhys,
			faderCount: this.faderCount,
			firstChannel: this.firstChannel,
			channelCount: this.channelCount,
			firstMix: this.firstMix,
			sourceCount: this.sourceCount,
			mixCountPerSource: MIX_COUNT_PER_SOURCE,
			singletons: Object.fromEntries(Object.entries(this._singletons).map(([k, s]) => [k, s.idx])),
			runs: Object.fromEntries(
				Object.entries(this._runs).map(([k, r]) => [
					k,
					r instanceof TwoLevel
						? { parent: r.parent, first: r.first, count: r.count }
						: { first: r.first, count: r.count },
				]),
			),
		}
	}
}
