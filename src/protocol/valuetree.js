/**
 * In-memory JUCE `ValueTree` plus the `ValueTree::writeToStream` codec.
 *
 * When a RODECaster connects it sends its whole state as a
 * `ValueTreeSynchroniser` full-sync payload: a change-type byte (`0x02`)
 * followed by the root node in `ValueTree::writeToStream` form:
 *
 *   node     := name "\0"  compint(propCount)  property x propCount
 *               compint(childCount)  node x childCount
 *   property := name "\0"  var
 *
 * Port of `rodecaster-protocol/src/valuetree.rs` (MIT, Yeradon), extended with
 * a mutable tree that can apply incremental change records.
 *
 * @module protocol/valuetree
 */

import {
	readCString,
	readCompressedInt,
	readValue,
	valueEquals,
	writeCString,
	writeCompressedInt,
	writeValue,
} from './juce-var.js'

/** @typedef {import('./juce-var.js').Value} Value */
/** @typedef {import('./juce-var.js').Cursor} Cursor */

/** `ValueTreeSynchroniser::ChangeType::fullSync`. */
const FULL_SYNC = 0x02
const PROPERTY_CHANGED = 0x01

/**
 * A node in the ValueTree: a type name, ordered properties and child nodes.
 * `properties` is a Map so insertion order (the wire order) is preserved.
 */
export class ValueTree {
	/**
	 * @param {string} type node type name (`CHANNEL`, `MIX`, ...)
	 * @param {Iterable<[string, Value]> | Map<string, Value> | Record<string, Value>} [properties]
	 * @param {ValueTree[]} [children]
	 */
	constructor(type, properties = [], children = []) {
		/** @type {string} */
		this.type = type
		/** @type {Map<string, Value>} */
		this.properties = new Map(
			properties instanceof Map || typeof properties[Symbol.iterator] === 'function'
				? /** @type {Iterable<[string, Value]>} */ (properties)
				: Object.entries(properties),
		)
		/** @type {ValueTree[]} */
		this.children = Array.from(children)
	}

	/**
	 * Parse one `ValueTree::writeToStream` node from the cursor: name,
	 * property count, properties, child count, children (recursive).
	 * A declared count is a hard contract: truncation yields `null`, never a
	 * partial tree.
	 * @param {Uint8Array} buf
	 * @param {Cursor} cursor
	 * @returns {ValueTree | null}
	 */
	static parse(buf, cursor) {
		const name = readCString(buf, cursor)
		if (name === null) return null
		const propCount = readCompressedInt(buf, cursor)
		if (propCount === null || propCount < 0) return null
		const node = new ValueTree(name)
		for (let i = 0; i < propCount; i++) {
			const pname = readCString(buf, cursor)
			if (pname === null) return null
			const value = readValue(buf, cursor)
			if (value === null) return null
			node.properties.set(pname, value)
		}
		const childCount = readCompressedInt(buf, cursor)
		if (childCount === null || childCount < 0) return null
		for (let i = 0; i < childCount; i++) {
			const child = ValueTree.parse(buf, cursor)
			if (child === null) return null
			node.children.push(child)
		}
		return node
	}

	/**
	 * Parse a complete full-sync payload (`0x02` + root node). The payload is
	 * the body after the transport frame. Trailing bytes are malformed.
	 * @param {Uint8Array} buf
	 * @returns {ValueTree | null}
	 */
	static fromFullSync(buf) {
		if (buf.length === 0 || buf[0] !== FULL_SYNC) return null
		const cursor = { pos: 1 }
		const root = ValueTree.parse(buf, cursor)
		if (root === null || cursor.pos !== buf.length) return null
		return root
	}

	/**
	 * Append this node in `ValueTree::writeToStream` form (tree body only; use
	 * `encodeFullSync` in change-frame.js to prepend the change type).
	 * @param {number[]} out
	 */
	write(out) {
		writeCString(out, this.type)
		writeCompressedInt(out, this.properties.size)
		for (const [name, value] of this.properties) {
			writeCString(out, name)
			writeValue(out, value)
		}
		writeCompressedInt(out, this.children.length)
		for (const child of this.children) child.write(out)
	}

	/** @returns {Buffer} the `writeToStream` bytes of this node */
	toBuffer() {
		const out = []
		this.write(out)
		return Buffer.from(out)
	}

	/**
	 * Resolve a root-down child-index path. `[]` is this node.
	 * @param {number[]} indices
	 * @returns {ValueTree | null}
	 */
	getByPath(indices) {
		/** @type {ValueTree} */
		let node = this
		for (const i of indices) {
			const next = node.children[i]
			if (!next) return null
			node = next
		}
		return node
	}

	/**
	 * A property value by name, or `null`.
	 * @param {string} name
	 * @returns {Value | null}
	 */
	get(name) {
		return this.properties.get(name) ?? null
	}

	/**
	 * Index of the first child of this type, or -1.
	 * @param {string} type
	 * @returns {number}
	 */
	indexOfChild(type) {
		return this.children.findIndex((c) => c.type === type)
	}

	/**
	 * First child with this type name, or `null`.
	 * @param {string} type
	 * @returns {ValueTree | null}
	 */
	findChild(type) {
		return this.children.find((c) => c.type === type) ?? null
	}

	/**
	 * All children with this type name, in tree order.
	 * @param {string} type
	 * @returns {ValueTree[]}
	 */
	findChildren(type) {
		return this.children.filter((c) => c.type === type)
	}

	/**
	 * Iterate `[index, child]` for every child of this type.
	 * @param {string} type
	 * @returns {IterableIterator<[number, ValueTree]>}
	 */
	*entriesOfType(type) {
		for (let i = 0; i < this.children.length; i++) {
			if (this.children[i].type === type) yield [i, this.children[i]]
		}
	}

	/**
	 * Length of the contiguous run of same-typed children starting at `start`.
	 * @param {number} start
	 * @param {string} type
	 * @returns {number}
	 */
	countConsecutive(start, type) {
		let n = 0
		for (let i = start; i < this.children.length && this.children[i].type === type; i++) n++
		return n
	}

	/**
	 * Depth-first search for the first property with this name anywhere in the
	 * tree (this node first, then children in order).
	 * @param {string} name
	 * @returns {Value | null}
	 */
	findProperty(name) {
		const own = this.properties.get(name)
		if (own !== undefined) return own
		for (const child of this.children) {
			const v = child.findProperty(name)
			if (v !== null) return v
		}
		return null
	}

	/**
	 * Root-down path to a descendant node (identity match), or `null`.
	 * @param {ValueTree} node
	 * @returns {number[] | null}
	 */
	pathOf(node) {
		if (node === this) return []
		for (let i = 0; i < this.children.length; i++) {
			const sub = this.children[i].pathOf(node)
			if (sub !== null) return [i, ...sub]
		}
		return null
	}

	/** @returns {{ nodes: number, properties: number }} counts over the whole tree */
	size() {
		let nodes = 1
		let properties = this.properties.size
		for (const child of this.children) {
			const s = child.size()
			nodes += s.nodes
			properties += s.properties
		}
		return { nodes, properties }
	}

	/**
	 * Apply one decoded change record (see change-frame.js) to this tree,
	 * which must be the root the record's path is relative to.
	 *
	 * Returns what changed, or `null` if the path does not resolve:
	 *   - propertyChanged:  `{ path, name, oldValue, value }`
	 *   - propertyRemoved:  `{ path, name, oldValue, value: null }`
	 *   - childAdded/Removed/Moved: `{ path, structural: true, ... }`
	 *   - fullSync: replaces this node's contents, returns `{ path: [], fullSync: true }`
	 *
	 * @param {import('./change-frame.js').ChangeRecord} record
	 * @returns {{ path: number[], name?: string, oldValue?: Value | null, value?: Value | null, structural?: boolean, fullSync?: boolean, index?: number, oldIndex?: number, newIndex?: number, node?: ValueTree } | null}
	 */
	applyChange(record) {
		switch (record.type) {
			case 'propertyChanged': {
				const node = this.getByPath(record.path)
				if (!node) return null
				const oldValue = node.properties.get(record.name) ?? null
				node.properties.set(record.name, record.value)
				return { path: record.path, name: record.name, oldValue, value: record.value }
			}
			case 'propertyRemoved': {
				const node = this.getByPath(record.path)
				if (!node) return null
				const oldValue = node.properties.get(record.name) ?? null
				node.properties.delete(record.name)
				return { path: record.path, name: record.name, oldValue, value: null }
			}
			case 'childAdded': {
				const node = this.getByPath(record.path)
				if (!node) return null
				node.children.splice(record.index, 0, record.subtree)
				return { path: record.path, structural: true, index: record.index, node: record.subtree }
			}
			case 'childRemoved': {
				const node = this.getByPath(record.path)
				if (!node || record.oldIndex >= node.children.length) return null
				const [removed] = node.children.splice(record.oldIndex, 1)
				return { path: record.path, structural: true, oldIndex: record.oldIndex, node: removed }
			}
			case 'childMoved': {
				const node = this.getByPath(record.path)
				if (!node || record.oldIndex >= node.children.length) return null
				const [moved] = node.children.splice(record.oldIndex, 1)
				node.children.splice(record.newIndex, 0, moved)
				return {
					path: record.path,
					structural: true,
					oldIndex: record.oldIndex,
					newIndex: record.newIndex,
					node: moved,
				}
			}
			case 'fullSync': {
				this.type = record.root.type
				this.properties = new Map(record.root.properties)
				this.children = record.root.children.slice()
				return { path: [], fullSync: true }
			}
			default:
				return null
		}
	}

	/**
	 * Wire body for a `propertyChanged` record at `pathIndices` (identical to
	 * `encodePropertyChanged` in change-frame.js; provided here so a tree can
	 * build writes without importing the frame codec).
	 * @param {number[]} pathIndices
	 * @param {string} name
	 * @param {Value} value
	 * @returns {Buffer}
	 */
	static encodePropertyChange(pathIndices, name, value) {
		const out = [PROPERTY_CHANGED]
		writeCompressedInt(out, pathIndices.length)
		for (const p of pathIndices) writeCompressedInt(out, p)
		writeCString(out, name)
		writeValue(out, value)
		return Buffer.from(out)
	}

	/**
	 * Instance form of {@link ValueTree.encodePropertyChange}.
	 * @param {number[]} pathIndices
	 * @param {string} name
	 * @param {Value} value
	 * @returns {Buffer}
	 */
	encodePropertyChange(pathIndices, name, value) {
		return ValueTree.encodePropertyChange(pathIndices, name, value)
	}

	/** Deep copy. @returns {ValueTree} */
	clone() {
		return new ValueTree(
			this.type,
			this.properties,
			this.children.map((c) => c.clone()),
		)
	}

	/** Structural equality (type, properties in order, children). @param {ValueTree} other */
	equals(other) {
		if (!(other instanceof ValueTree) || this.type !== other.type) return false
		if (this.properties.size !== other.properties.size || this.children.length !== other.children.length) return false
		const a = [...this.properties]
		const b = [...other.properties]
		for (let i = 0; i < a.length; i++) {
			if (a[i][0] !== b[i][0] || !valueEquals(a[i][1], b[i][1])) return false
		}
		return this.children.every((c, i) => c.equals(other.children[i]))
	}

	/** JSON-friendly form. */
	toJSON() {
		return {
			type: this.type,
			properties: Object.fromEntries(this.properties),
			children: this.children.map((c) => c.toJSON()),
		}
	}

	toString() {
		return `Node(${this.type}, ${this.properties.size} props, ${this.children.length} children)`
	}
}

/**
 * Convenience builders mirroring the Rust test fixtures (`n`, `np`, `nc`).
 * @param {string} type
 * @param {Record<string, Value> | Iterable<[string, Value]>} [properties]
 * @param {ValueTree[]} [children]
 * @returns {ValueTree}
 */
export function node(type, properties = {}, children = []) {
	return new ValueTree(type, properties, children)
}
