/**
 * Momentary two-boolean trigger pulses.
 *
 * Many action/request properties (`mixLinkRequest`, `mixUnlinkRequest`,
 * `padProgressRequestSignal`, `sipSlotCallDisconnect`, ...) carry a Binary
 * value of two serialized JUCE booleans:
 *
 *   press   (true, true)   -> 01 01 02 01 01 02
 *   release (false, false) -> 01 01 03 01 01 03
 *
 * Commands assert `press`; the device answers with a `release`.
 *
 * Port of `rodecaster-protocol/src/trigger.rs` (MIT, Yeradon).
 *
 * @module protocol/trigger
 */

import { marker, V } from './juce-var.js'

/** @typedef {import('./juce-var.js').Value} Value */

/**
 * Encode two booleans into the canonical 6-byte payload.
 * @param {boolean} a
 * @param {boolean} b
 * @returns {Buffer}
 */
export function boolPair(a, b) {
	return Buffer.from([
		0x01,
		0x01,
		a ? marker.BOOL_TRUE : marker.BOOL_FALSE,
		0x01,
		0x01,
		b ? marker.BOOL_TRUE : marker.BOOL_FALSE,
	])
}

/** The 6-byte trigger payload when asserting a press: (true, true). Treat as read-only. */
export const PRESS_BYTES = boolPair(true, true)
/** The 6-byte trigger payload when releasing / idle: (false, false). Treat as read-only. */
export const RELEASE_BYTES = boolPair(false, false)

/** @returns {Value} a Binary value holding the press payload */
export function pressValue() {
	return V.binary(PRESS_BYTES)
}

/** @returns {Value} a Binary value holding the release payload */
export function releaseValue() {
	return V.binary(RELEASE_BYTES)
}

/**
 * Decode a 6-byte payload into its two booleans, or `null` if it is not the
 * two-boolean shape.
 * @param {Uint8Array} bytes
 * @returns {[boolean, boolean] | null}
 */
export function decodeBoolPair(bytes) {
	if (bytes.length !== 6) return null
	if (bytes[0] !== 0x01 || bytes[1] !== 0x01 || bytes[3] !== 0x01 || bytes[4] !== 0x01) return null
	const a = bytes[2] === marker.BOOL_TRUE ? true : bytes[2] === marker.BOOL_FALSE ? false : null
	const b = bytes[5] === marker.BOOL_TRUE ? true : bytes[5] === marker.BOOL_FALSE ? false : null
	if (a === null || b === null) return null
	return [a, b]
}

/**
 * Trigger phase from a value: `'press'` for (true, _), `'release'` for
 * (false, _), `null` if not a valid trigger payload.
 * @param {Value | null | undefined} value
 * @returns {'press' | 'release' | null}
 */
export function decodePhase(value) {
	if (!value || value.type !== 'binary') return null
	const pair = decodeBoolPair(value.value)
	if (!pair) return null
	return pair[0] ? 'press' : 'release'
}
