/**
 * JUCE `var` binary value encoding and decoding.
 *
 * Values exchanged with RODECaster devices are serialized with the JUCE
 * `var::writeToStream` format: a compressed-int length frame (`1 + payload`),
 * a marker byte for the variant type, then the raw payload.
 *
 * Port of `rodecaster-protocol/src/juce_var.rs` (MIT, Yeradon).
 *
 * A decoded value is a tagged plain object:
 *
 *   { type: 'bool',      value: boolean }
 *   { type: 'int',       value: number }   // 32-bit, marker 0x01
 *   { type: 'int64',     value: bigint }   // 64-bit, marker 0x06
 *   { type: 'double',    value: number }
 *   { type: 'string',    value: string }
 *   { type: 'array',     value: Value[] }
 *   { type: 'binary',    value: Buffer }
 *   { type: 'undefined' }
 *   { type: 'unknown',   typeId: number, data: Buffer }
 *
 * Decoders return `null` on malformed input (the Rust `Option::None`).
 *
 * @module protocol/juce-var
 */

/** `juce::var` VariantStreamMarkers: the byte after a value's length frame. */
export const marker = Object.freeze({
	/** 32-bit int. JUCE always writes a fixed 4-byte `writeInt`. */
	INT: 0x01,
	BOOL_TRUE: 0x02,
	BOOL_FALSE: 0x03,
	/** Double, 8 bytes IEEE 754 LE. */
	DOUBLE: 0x04,
	/** String, UTF-8 with a trailing NUL inside the frame. */
	STRING: 0x05,
	/** 64-bit int, 8 bytes LE. */
	INT64: 0x06,
	/** Array: a compressed-int element count, then that many values. */
	ARRAY: 0x07,
	/** Binary blob / MemoryBlock: the rest of the frame, raw. */
	BINARY: 0x08,
	UNDEFINED: 0x09,
})

/**
 * @typedef {{ type: 'bool', value: boolean }
 *   | { type: 'int', value: number }
 *   | { type: 'int64', value: bigint }
 *   | { type: 'double', value: number }
 *   | { type: 'string', value: string }
 *   | { type: 'array', value: Value[] }
 *   | { type: 'binary', value: Buffer }
 *   | { type: 'undefined' }
 *   | { type: 'unknown', typeId: number, data: Buffer }} Value
 */

/** @typedef {{ pos: number }} Cursor */

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Value constructors. */
export const V = Object.freeze({
	/** @param {boolean} value @returns {Value} */
	bool: (value) => ({ type: 'bool', value: Boolean(value) }),
	/**
	 * 32-bit int. The value is wrapped to i32 on the wire exactly like Rust's
	 * `as i32` (so `0xFFFFFFFF` encodes as -1).
	 * @param {number} value @returns {Value}
	 */
	int: (value) => {
		if (!Number.isInteger(value)) throw new TypeError(`int value must be an integer, got ${value}`)
		return { type: 'int', value: value | 0 }
	},
	/**
	 * 64-bit int. Accepts a bigint or a safe-integer number.
	 * @param {bigint | number} value @returns {Value}
	 */
	int64: (value) => {
		let big
		if (typeof value === 'bigint') big = value
		else if (Number.isSafeInteger(value)) big = BigInt(value)
		else throw new TypeError(`int64 value must be a bigint or safe integer, got ${value}`)
		if (big < INT64_MIN || big > INT64_MAX) throw new RangeError(`int64 value out of range: ${big}`)
		return { type: 'int64', value: big }
	},
	/** @param {number} value @returns {Value} */
	double: (value) => ({ type: 'double', value: Number(value) }),
	/** @param {string} value @returns {Value} */
	string: (value) => ({ type: 'string', value: String(value) }),
	/** @param {Value[]} value @returns {Value} */
	array: (value) => ({ type: 'array', value: Array.from(value) }),
	/** @param {Uint8Array | number[]} value @returns {Value} */
	binary: (value) => ({ type: 'binary', value: Buffer.from(value) }),
	/** @returns {Value} */
	undefined: () => ({ type: 'undefined' }),
	/** @param {number} typeId @param {Uint8Array | number[]} data @returns {Value} */
	unknown: (typeId, data) => ({ type: 'unknown', typeId, data: Buffer.from(data) }),
})

/**
 * Extract a bool, if this var is one.
 * @param {Value | null | undefined} v
 * @returns {boolean | null}
 */
export function asBool(v) {
	return v && v.type === 'bool' ? v.value : null
}

/**
 * Extract an integer from an `int` or `int64` var. An int64 that fits a safe
 * JS integer comes back as a number; otherwise as a bigint.
 * @param {Value | null | undefined} v
 * @returns {number | bigint | null}
 */
export function asInt(v) {
	if (!v) return null
	if (v.type === 'int') return v.value
	if (v.type === 'int64') {
		const n = Number(v.value)
		return Number.isSafeInteger(n) ? n : v.value
	}
	return null
}

/**
 * Extract a string, if this var is one.
 * @param {Value | null | undefined} v
 * @returns {string | null}
 */
export function asString(v) {
	return v && v.type === 'string' ? v.value : null
}

/**
 * Structural equality of two decoded values.
 * @param {Value} a
 * @param {Value} b
 * @returns {boolean}
 */
export function valueEquals(a, b) {
	if (a === b) return true
	if (!a || !b || a.type !== b.type) return false
	switch (a.type) {
		case 'undefined':
			return true
		case 'bool':
		case 'int':
		case 'string':
			return a.value === b.value
		case 'int64':
			return a.value === /** @type {any} */ (b).value
		case 'double':
			return Object.is(a.value, /** @type {any} */ (b).value) || a.value === /** @type {any} */ (b).value
		case 'array': {
			const bv = /** @type {any} */ (b).value
			return a.value.length === bv.length && a.value.every((x, i) => valueEquals(x, bv[i]))
		}
		case 'binary':
			return a.value.equals(/** @type {any} */ (b).value)
		case 'unknown':
			return a.typeId === /** @type {any} */ (b).typeId && a.data.equals(/** @type {any} */ (b).data)
		default:
			return false
	}
}

// Free-function codec over (buf, cursor) so any reader can delegate.

/**
 * Read a JUCE `writeCompressedInt`: one size byte (low 7 bits = value byte
 * count, capped at 4; high bit = sign) then that many little-endian bytes.
 * @param {Uint8Array} buf
 * @param {Cursor} cursor
 * @returns {number | null}
 */
export function readCompressedInt(buf, cursor) {
	if (cursor.pos >= buf.length) return null
	const sizeByte = buf[cursor.pos++]
	const numBytes = sizeByte & 0x7f
	if (numBytes === 0) return 0
	// JUCE treats more than 4 value bytes as corrupt data and bails.
	if (numBytes > 4) return null
	if (cursor.pos + numBytes > buf.length) return null
	let value = 0
	for (let i = 0; i < numBytes; i++) {
		value += buf[cursor.pos + i] * 2 ** (8 * i)
	}
	cursor.pos += numBytes
	return sizeByte & 0x80 ? -value : value
}

/**
 * Write a JUCE `writeCompressedInt` (inverse of {@link readCompressedInt}).
 * Only the low 4 bytes of the magnitude are written, as in JUCE.
 * @param {number[]} out byte sink
 * @param {number} value
 */
export function writeCompressedInt(out, value) {
	const negative = value < 0
	let magnitude = Math.abs(Math.trunc(value))
	const bytes = []
	while (magnitude !== 0 && bytes.length < 4) {
		bytes.push(magnitude % 256)
		magnitude = Math.floor(magnitude / 256)
	}
	out.push(bytes.length | (negative ? 0x80 : 0))
	for (const b of bytes) out.push(b)
}

/**
 * Read a NUL-terminated UTF-8 string (`juce::OutputStream::writeString`).
 * @param {Uint8Array} buf
 * @param {Cursor} cursor
 * @returns {string | null}
 */
export function readCString(buf, cursor) {
	const start = cursor.pos
	if (start > buf.length) return null
	const nul = buf.indexOf(0, start)
	if (nul < 0) return null
	const s = Buffer.from(buf.buffer, buf.byteOffset + start, nul - start).toString('utf8')
	cursor.pos = nul + 1 // skip the NUL
	return s
}

/**
 * Write a NUL-terminated UTF-8 string.
 * @param {number[]} out
 * @param {string} s
 */
export function writeCString(out, s) {
	for (const b of Buffer.from(s, 'utf8')) out.push(b)
	out.push(0)
}

/**
 * Read a single `juce::var` (`var::readFromStream`): a compressed-int length
 * frame (`1 + payload_len`), the marker byte, then the payload. A zero-length
 * frame is a void var.
 * @param {Uint8Array} buf
 * @param {Cursor} cursor
 * @returns {Value | null}
 */
export function readValue(buf, cursor) {
	const dataLen = readCompressedInt(buf, cursor)
	if (dataLen === null) return null
	if (dataLen <= 0) {
		// numBytes == 0 -> JUCE returns a void var.
		return V.undefined()
	}
	if (cursor.pos >= buf.length) return null
	const typeByte = buf[cursor.pos++]
	const valueLen = dataLen - 1
	const view = () => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)

	switch (typeByte) {
		case marker.INT: {
			// JUCE writes a fixed 4-byte writeInt.
			if (cursor.pos + 4 > buf.length) return null
			const v = view().readInt32LE(cursor.pos)
			cursor.pos += 4
			return { type: 'int', value: v }
		}
		case marker.BOOL_TRUE:
			return V.bool(true)
		case marker.BOOL_FALSE:
			return V.bool(false)
		case marker.DOUBLE: {
			if (cursor.pos + 8 > buf.length) return null
			const v = view().readDoubleLE(cursor.pos)
			cursor.pos += 8
			return { type: 'double', value: v }
		}
		case marker.STRING: {
			if (cursor.pos + valueLen > buf.length) return null
			let s = Buffer.from(buf.buffer, buf.byteOffset + cursor.pos, valueLen).toString('utf8')
			cursor.pos += valueLen
			// Strip trailing NULs (the Rust port uses trim_end_matches('\0')).
			s = s.replace(/\0+$/, '')
			return { type: 'string', value: s }
		}
		case marker.INT64: {
			if (cursor.pos + 8 > buf.length) return null
			const v = view().readBigInt64LE(cursor.pos)
			cursor.pos += 8
			return { type: 'int64', value: v }
		}
		case marker.ARRAY: {
			const count = readCompressedInt(buf, cursor)
			if (count === null || count < 0) return null
			const values = []
			for (let i = 0; i < count; i++) {
				const v = readValue(buf, cursor)
				if (v === null) return null
				values.push(v)
			}
			return { type: 'array', value: values }
		}
		case marker.BINARY: {
			if (cursor.pos + valueLen > buf.length) return null
			const data = Buffer.from(buf.subarray(cursor.pos, cursor.pos + valueLen))
			cursor.pos += valueLen
			return { type: 'binary', value: data }
		}
		case marker.UNDEFINED:
			return V.undefined()
		default: {
			if (cursor.pos + valueLen > buf.length) return null
			const data = Buffer.from(buf.subarray(cursor.pos, cursor.pos + valueLen))
			cursor.pos += valueLen
			return { type: 'unknown', typeId: typeByte, data }
		}
	}
}

/**
 * Encode as `juce::var::writeToStream`: `writeCompressedInt(1 + payload)`,
 * the marker byte, then the payload.
 * @param {number[]} out byte sink
 * @param {Value} v
 */
export function writeValue(out, v) {
	switch (v.type) {
		case 'bool':
			writeCompressedInt(out, 1)
			out.push(v.value ? marker.BOOL_TRUE : marker.BOOL_FALSE)
			return
		case 'int': {
			writeCompressedInt(out, 5)
			out.push(marker.INT)
			const b = Buffer.alloc(4)
			b.writeInt32LE(v.value | 0, 0)
			for (const x of b) out.push(x)
			return
		}
		case 'int64': {
			writeCompressedInt(out, 9)
			out.push(marker.INT64)
			const b = Buffer.alloc(8)
			b.writeBigInt64LE(BigInt(v.value), 0)
			for (const x of b) out.push(x)
			return
		}
		case 'double': {
			writeCompressedInt(out, 9)
			out.push(marker.DOUBLE)
			const b = Buffer.alloc(8)
			b.writeDoubleLE(v.value, 0)
			for (const x of b) out.push(x)
			return
		}
		case 'string': {
			const bytes = Buffer.from(v.value, 'utf8')
			// Payload is UTF-8 plus a trailing NUL; the frame counts both.
			writeCompressedInt(out, 1 + bytes.length + 1)
			out.push(marker.STRING)
			for (const x of bytes) out.push(x)
			out.push(0)
			return
		}
		case 'binary':
			writeCompressedInt(out, 1 + v.value.length)
			out.push(marker.BINARY)
			for (const x of v.value) out.push(x)
			return
		case 'array': {
			// Serialize the body first so the length frame can count it.
			const body = []
			writeCompressedInt(body, v.value.length)
			for (const item of v.value) writeValue(body, item)
			writeCompressedInt(out, 1 + body.length)
			out.push(marker.ARRAY)
			for (const x of body) out.push(x)
			return
		}
		case 'undefined':
			writeCompressedInt(out, 1)
			out.push(marker.UNDEFINED)
			return
		case 'unknown':
			writeCompressedInt(out, 1 + v.data.length)
			out.push(v.typeId)
			for (const x of v.data) out.push(x)
			return
		default:
			throw new TypeError(`unknown value type: ${/** @type {any} */ (v).type}`)
	}
}

/**
 * Encode one value to a fresh Buffer.
 * @param {Value} v
 * @returns {Buffer}
 */
export function encodeValue(v) {
	const out = []
	writeValue(out, v)
	return Buffer.from(out)
}

/**
 * Decode exactly one value from a buffer; `null` if malformed or if bytes
 * remain after the value.
 * @param {Uint8Array} buf
 * @returns {Value | null}
 */
export function decodeValue(buf) {
	const cursor = { pos: 0 }
	const v = readValue(buf, cursor)
	if (v === null || cursor.pos !== buf.length) return null
	return v
}

/**
 * Convert a decoded value into an ordinary JS value (for logging, Companion
 * variables and the like). int64 -> bigint, binary -> Buffer.
 * @param {Value} v
 * @returns {unknown}
 */
export function toPlain(v) {
	switch (v.type) {
		case 'undefined':
			return undefined
		case 'array':
			return v.value.map(toPlain)
		case 'unknown':
			return { typeId: v.typeId, data: v.data }
		default:
			return v.value
	}
}
