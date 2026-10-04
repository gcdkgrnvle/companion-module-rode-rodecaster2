/**
 * JUCE `ValueTreeSynchroniser` change-frame encoder and decoder.
 *
 * A change frame is the body carried by one transport message:
 *
 *   byte 0        change type (1 propertyChanged, 2 fullSync, 3 childAdded,
 *                 4 childRemoved, 5 childMoved, 6 propertyRemoved)
 *   propertyChanged : compint(depth) compint(idx) x depth  name "\0"  var
 *   propertyRemoved : compint(depth) compint(idx) x depth  name "\0"
 *   childAdded      : compint(depth) compint(idx) x depth  compint(index)  node
 *   childRemoved    : compint(depth) compint(idx) x depth  compint(oldIndex)
 *   childMoved      : compint(depth) compint(idx) x depth  compint(oldIndex) compint(newIndex)
 *   fullSync        : node
 *
 * where `node` is `ValueTree::writeToStream` (see valuetree.js).
 *
 * Port of `rodecaster-protocol/src/change_frame.rs` (MIT, Yeradon).
 *
 * @module protocol/change-frame
 */

import { readCString, readCompressedInt, readValue, writeCString, writeCompressedInt, writeValue } from './juce-var.js'
import { ValueTree } from './valuetree.js'

/** @typedef {import('./juce-var.js').Value} Value */

/** Change-type bytes. */
export const ChangeType = Object.freeze({
	PROPERTY_CHANGED: 1,
	FULL_SYNC: 2,
	CHILD_ADDED: 3,
	CHILD_REMOVED: 4,
	CHILD_MOVED: 5,
	PROPERTY_REMOVED: 6,
})

/**
 * @typedef {{ type: 'propertyChanged', path: number[], name: string, value: Value }
 *   | { type: 'propertyRemoved', path: number[], name: string }
 *   | { type: 'childAdded', path: number[], index: number, subtree: ValueTree }
 *   | { type: 'childRemoved', path: number[], oldIndex: number }
 *   | { type: 'childMoved', path: number[], oldIndex: number, newIndex: number }
 *   | { type: 'fullSync', root: ValueTree }} ChangeRecord
 */

/**
 * @param {Uint8Array} buf
 * @param {import('./juce-var.js').Cursor} cursor
 * @returns {number | null} a non-negative compressed int
 */
function readIndex(buf, cursor) {
	const v = readCompressedInt(buf, cursor)
	return v === null || v < 0 ? null : v
}

/**
 * @param {Uint8Array} buf
 * @param {import('./juce-var.js').Cursor} cursor
 * @returns {number[] | null}
 */
function readPath(buf, cursor) {
	const n = readIndex(buf, cursor)
	if (n === null) return null
	const path = []
	for (let i = 0; i < n; i++) {
		const p = readIndex(buf, cursor)
		if (p === null) return null
		path.push(p)
	}
	return path
}

/**
 * Decode a complete change-frame body. `null` if it is not exactly one valid
 * frame (unknown type, truncated, or trailing bytes).
 * @param {Uint8Array} payload
 * @returns {ChangeRecord | null}
 */
export function decodeChangeFrame(payload) {
	if (payload.length === 0) return null
	const cursor = { pos: 1 }
	/** @type {ChangeRecord | null} */
	let record = null
	switch (payload[0]) {
		case ChangeType.PROPERTY_CHANGED: {
			const path = readPath(payload, cursor)
			if (path === null) return null
			const name = readCString(payload, cursor)
			if (name === null) return null
			const value = readValue(payload, cursor)
			if (value === null) return null
			record = { type: 'propertyChanged', path, name, value }
			break
		}
		case ChangeType.FULL_SYNC: {
			const root = ValueTree.parse(payload, cursor)
			if (root === null) return null
			record = { type: 'fullSync', root }
			break
		}
		case ChangeType.CHILD_ADDED: {
			const path = readPath(payload, cursor)
			if (path === null) return null
			const index = readIndex(payload, cursor)
			if (index === null) return null
			const subtree = ValueTree.parse(payload, cursor)
			if (subtree === null) return null
			record = { type: 'childAdded', path, index, subtree }
			break
		}
		case ChangeType.CHILD_REMOVED: {
			const path = readPath(payload, cursor)
			if (path === null) return null
			const oldIndex = readIndex(payload, cursor)
			if (oldIndex === null) return null
			record = { type: 'childRemoved', path, oldIndex }
			break
		}
		case ChangeType.CHILD_MOVED: {
			const path = readPath(payload, cursor)
			if (path === null) return null
			const oldIndex = readIndex(payload, cursor)
			if (oldIndex === null) return null
			const newIndex = readIndex(payload, cursor)
			if (newIndex === null) return null
			record = { type: 'childMoved', path, oldIndex, newIndex }
			break
		}
		case ChangeType.PROPERTY_REMOVED: {
			const path = readPath(payload, cursor)
			if (path === null) return null
			const name = readCString(payload, cursor)
			if (name === null) return null
			record = { type: 'propertyRemoved', path, name }
			break
		}
		default:
			return null
	}
	return cursor.pos === payload.length ? record : null
}

/** Alias matching the Rust name. */
export const decode = decodeChangeFrame

/**
 * True if the record alters tree topology (child added/removed/moved, fullSync).
 * @param {ChangeRecord} record
 */
export function isStructural(record) {
	return (
		record.type === 'childAdded' ||
		record.type === 'childRemoved' ||
		record.type === 'childMoved' ||
		record.type === 'fullSync'
	)
}

/**
 * @param {number[]} out
 * @param {number[]} path
 */
function writePath(out, path) {
	writeCompressedInt(out, path.length)
	for (const p of path) writeCompressedInt(out, p)
}

/**
 * Encode a `propertyChanged` frame.
 * @param {number[]} path root-down child indices
 * @param {string} name property name
 * @param {Value} value
 * @returns {Buffer}
 */
export function encodePropertyChanged(path, name, value) {
	const out = [ChangeType.PROPERTY_CHANGED]
	writePath(out, path)
	writeCString(out, name)
	writeValue(out, value)
	return Buffer.from(out)
}

/**
 * Encode a `propertyRemoved` frame.
 * @param {number[]} path
 * @param {string} name
 * @returns {Buffer}
 */
export function encodePropertyRemoved(path, name) {
	const out = [ChangeType.PROPERTY_REMOVED]
	writePath(out, path)
	writeCString(out, name)
	return Buffer.from(out)
}

/**
 * Encode a complete `fullSync` frame (`0x02` + root in writeToStream form).
 * @param {ValueTree} root
 * @returns {Buffer}
 */
export function encodeFullSync(root) {
	const out = [ChangeType.FULL_SYNC]
	root.write(out)
	return Buffer.from(out)
}

/**
 * Encode a `childAdded` frame.
 * @param {number[]} path parent path
 * @param {number} index insertion index
 * @param {ValueTree} subtree
 * @returns {Buffer}
 */
export function encodeChildAdded(path, index, subtree) {
	const out = [ChangeType.CHILD_ADDED]
	writePath(out, path)
	writeCompressedInt(out, index)
	subtree.write(out)
	return Buffer.from(out)
}

/**
 * Encode a `childRemoved` frame.
 * @param {number[]} path
 * @param {number} oldIndex
 * @returns {Buffer}
 */
export function encodeChildRemoved(path, oldIndex) {
	const out = [ChangeType.CHILD_REMOVED]
	writePath(out, path)
	writeCompressedInt(out, oldIndex)
	return Buffer.from(out)
}

/**
 * Encode a `childMoved` frame.
 * @param {number[]} path
 * @param {number} oldIndex
 * @param {number} newIndex
 * @returns {Buffer}
 */
export function encodeChildMoved(path, oldIndex, newIndex) {
	const out = [ChangeType.CHILD_MOVED]
	writePath(out, path)
	writeCompressedInt(out, oldIndex)
	writeCompressedInt(out, newIndex)
	return Buffer.from(out)
}

/**
 * Encode any change record back to its wire body.
 * @param {ChangeRecord} record
 * @returns {Buffer}
 */
export function encodeChangeFrame(record) {
	switch (record.type) {
		case 'propertyChanged':
			return encodePropertyChanged(record.path, record.name, record.value)
		case 'propertyRemoved':
			return encodePropertyRemoved(record.path, record.name)
		case 'fullSync':
			return encodeFullSync(record.root)
		case 'childAdded':
			return encodeChildAdded(record.path, record.index, record.subtree)
		case 'childRemoved':
			return encodeChildRemoved(record.path, record.oldIndex)
		case 'childMoved':
			return encodeChildMoved(record.path, record.oldIndex, record.newIndex)
		default:
			throw new TypeError(`unknown change record type: ${/** @type {any} */ (record).type}`)
	}
}
