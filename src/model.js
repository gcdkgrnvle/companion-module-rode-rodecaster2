/**
 * Pure helpers: strip naming, level maths, pad colours, record states.
 * No device access, fully unit-testable.
 */

/** Fader position of the desk's unity (0 dB) detent: 90 of 127. */
export const UNITY_LEVEL = 90 / 127

/** Protocol `channelInputSource` ordinal -> display name. */
const SOURCE_NAMES = {
	combo1: 'Mic 1',
	combo2: 'Mic 2',
	combo3: 'Mic 3',
	combo4: 'Mic 4',
	combo12: 'Mic 1+2',
	combo23: 'Mic 2+3',
	combo34: 'Mic 3+4',
	usb1: 'USB 1',
	chat: 'Chat',
	usb2: 'USB 2',
	bluetooth: 'Bluetooth',
	soundpad: 'Pads',
	game: 'Game',
	music: 'Music',
	virtuala: 'Virtual A',
	virtualb: 'Virtual B',
	callme1: 'Call 1',
	callme2: 'Call 2',
	callme3: 'Call 3',
}

/**
 * @param {string | null} sourceId Source id (names.js vocabulary) or null when the strip is empty
 * @param {number} stripIndex 0-based
 * @returns {string}
 */
export function defaultStripName(sourceId, stripIndex) {
	if (!sourceId) return `Strip ${stripIndex + 1}`
	return SOURCE_NAMES[sourceId] ?? sourceId
}

/**
 * Parse the user's strip name overrides: comma separated, position = strip,
 * empty entries keep the default.
 * @param {string | undefined} text
 * @returns {string[]}
 */
export function parseStripNames(text) {
	if (!text) return []
	return text.split(',').map((s) => s.trim())
}

/**
 * Parse `mixLevelWithAnchor` ("level|anchor", both 0..1).
 * @param {string | undefined} s
 * @returns {{ level: number, anchor: number } | null}
 */
export function parseMixLevel(s) {
	if (typeof s !== 'string') return null
	const [a, b] = s.split('|')
	const level = Number(a)
	const anchor = Number(b)
	if (!Number.isFinite(level) || !Number.isFinite(anchor)) return null
	return { level, anchor }
}

/** @param {number} level @param {number} anchor */
export function formatMixLevel(level, anchor) {
	return `${clamp01(level).toFixed(6)}|${clamp01(anchor).toFixed(6)}`
}

/** @param {number} x */
export function clamp01(x) {
	return Math.min(1, Math.max(0, x))
}

/** 0..1 -> 0..127 fader units. @param {number} level */
export function levelToFader(level) {
	return Math.round(clamp01(level) * 127)
}

/** 0..127 -> 0..1. @param {number} fader */
export function faderToLevel(fader) {
	return clamp01(fader / 127)
}

/**
 * Approximate dB readout relative to the unity detent. The desk publishes no
 * taper, so this is only a guide: 0 dB at fader 90, `-inf` at 0.
 * @param {number} level 0..1
 * @returns {string}
 */
export function levelToDbText(level) {
	if (level <= 0) return '-inf dB'
	const db = 20 * Math.log10(level / UNITY_LEVEL)
	return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}

/** @param {number} level 0..1 */
export function levelToPercentText(level) {
	return `${Math.round(clamp01(level) * 100)}%`
}

/** RECORDER.recordState -> label. @param {number | undefined} state */
export function recordStateLabel(state) {
	switch (state) {
		case 0:
			return 'Ready'
		case 1:
			return 'Paused'
		case 2:
			return 'Recording'
		case 3:
			return 'No destination'
		default:
			return 'Unknown'
	}
}

/** @param {number} seconds */
export function formatElapsed(seconds) {
	const s = Math.max(0, Math.floor(seconds))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const mm = String(m).padStart(2, '0')
	const ss = String(sec).padStart(2, '0')
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** SMART pad colour index (0..11) -> 0xRRGGBB, matching the desk's palette closely enough. */
const PAD_COLOURS = [
	0xff3b30, // 0 red
	0xff9500, // 1 orange
	0xffcc00, // 2 yellow
	0x34c759, // 3 green
	0x00c7be, // 4 teal
	0x32ade6, // 5 light blue
	0x007aff, // 6 blue
	0x5856d6, // 7 indigo
	0xaf52de, // 8 purple
	0xff2d55, // 9 pink
	0xffffff, // 10 white
	0x8e8e93, // 11 grey
]

/** @param {number | undefined} index */
export function padColour(index) {
	return PAD_COLOURS[index ?? -1] ?? 0x444444
}

/**
 * Elapsed-time accumulator for the recorder, driven by `recordState` pushes.
 * The desk never pushes `recordTimeMs`, so the host counts.
 */
export class RecordClock {
	constructor(now = () => Date.now()) {
		this.now = now
		this.accumulatedMs = 0
		/** @type {number | null} */
		this.runningSince = null
	}

	/** @param {number | undefined} state 0 ready, 1 paused, 2 recording, 3 no destination */
	apply(state) {
		const t = this.now()
		if (state === 2) {
			if (this.runningSince === null) this.runningSince = t
		} else {
			if (this.runningSince !== null) {
				this.accumulatedMs += t - this.runningSince
				this.runningSince = null
			}
			if (state !== 1) this.accumulatedMs = 0
		}
	}

	get elapsedSeconds() {
		const running = this.runningSince === null ? 0 : this.now() - this.runningSince
		return (this.accumulatedMs + running) / 1000
	}
}
