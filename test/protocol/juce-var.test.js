import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	asInt,
	decodeValue,
	encodeValue,
	readCompressedInt,
	readValue,
	toPlain,
	V,
	valueEquals,
	writeCompressedInt,
} from '../../src/protocol/juce-var.js'

/** Encode, decode back, and assert the frame is fully consumed. */
function assertRoundTrip(value) {
	const buf = encodeValue(value)
	const cursor = { pos: 0 }
	const decoded = readValue(buf, cursor)
	assert.ok(decoded, 'decodes')
	assert.ok(valueEquals(decoded, value), `round-trip mismatch for ${value.type} ${String(toPlain(value))}`)
	assert.deepEqual(decoded, value)
	assert.equal(cursor.pos, buf.length, 'frame fully consumed')
}

describe('juce-var', () => {
	test('round-trips every variant', () => {
		assertRoundTrip(V.bool(true))
		assertRoundTrip(V.bool(false))
		assertRoundTrip(V.int(75))
		assertRoundTrip(V.int(-1))
		assertRoundTrip(V.int(-2147483648))
		assertRoundTrip(V.int64(1n << 40n))
		assertRoundTrip(V.int64(-5))
		assertRoundTrip(V.double(0.5))
		assertRoundTrip(V.double(1.0))
		assertRoundTrip(V.string('0.472441|0.472441'))
		assertRoundTrip(V.string(''))
		assertRoundTrip(V.string('RØDECaster Duo'))
		assertRoundTrip(V.binary([0x01, 0x01, 0x02, 0x01, 0x01, 0x02]))
		assertRoundTrip(V.array([V.int(1), V.int(2)]))
		assertRoundTrip(V.array([V.string('a'), V.array([V.bool(true)]), V.undefined()]))
		assertRoundTrip(V.undefined())
		assertRoundTrip(V.unknown(0x42, [1, 2, 3]))
	})

	test('compressed ints round-trip', () => {
		for (const v of [0, 1, 5, 7, 9, 300, -5, 0xffff, 0x01000000, 0xffffffff]) {
			const out = []
			writeCompressedInt(out, v)
			const buf = Buffer.from(out)
			const cursor = { pos: 0 }
			assert.equal(readCompressedInt(buf, cursor), v, `for ${v}`)
			assert.equal(cursor.pos, buf.length)
		}
	})

	test('compressed int layout matches JUCE', () => {
		const enc = (v) => {
			const out = []
			writeCompressedInt(out, v)
			return Buffer.from(out)
		}
		assert.deepEqual(enc(0), Buffer.from([0x00]))
		assert.deepEqual(enc(1), Buffer.from([0x01, 0x01]))
		assert.deepEqual(enc(217), Buffer.from([0x01, 0xd9]))
		assert.deepEqual(enc(4100), Buffer.from([0x02, 0x04, 0x10]))
		assert.deepEqual(enc(-5), Buffer.from([0x81, 0x05]))
	})

	test('writes match known JUCE frames', () => {
		// Exact byte vectors the device's parser accepts (from the Rust tests).
		assert.deepEqual(encodeValue(V.bool(true)), Buffer.from([0x01, 0x01, 0x02]))
		assert.deepEqual(encodeValue(V.bool(false)), Buffer.from([0x01, 0x01, 0x03]))
		assert.deepEqual(encodeValue(V.int(75)), Buffer.from([0x01, 0x05, 0x01, 0x4b, 0x00, 0x00, 0x00]))
		// source_id = -1 (0xFFFFFFFF wrapped to i32)
		assert.deepEqual(encodeValue(V.int(0xffffffff)), Buffer.from([0x01, 0x05, 0x01, 0xff, 0xff, 0xff, 0xff]))
		assert.deepEqual(encodeValue(V.int(-1)), Buffer.from([0x01, 0x05, 0x01, 0xff, 0xff, 0xff, 0xff]))
		assert.deepEqual(
			encodeValue(V.binary([0x01, 0x01, 0x02, 0x01, 0x01, 0x02])),
			Buffer.from([0x01, 0x07, 0x08, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02]),
		)
		// var String "0.472441|0.472441" -> frame 0x13 = 1 marker + 17 chars + NUL
		assert.deepEqual(
			encodeValue(V.string('0.472441|0.472441')),
			Buffer.from([0x01, 0x13, 0x05, ...Buffer.from('0.472441|0.472441'), 0x00]),
		)
		// double 1.0
		assert.deepEqual(
			encodeValue(V.double(1.0)),
			Buffer.from([0x01, 0x09, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]),
		)
	})

	test('reads an empty frame as void', () => {
		const cursor = { pos: 0 }
		assert.deepEqual(readValue(Buffer.from([0x00]), cursor), V.undefined())
		assert.equal(cursor.pos, 1)
	})

	test('rejects an oversized compressed int', () => {
		assert.equal(readCompressedInt(Buffer.from([0x05, 1, 2, 3, 4, 5]), { pos: 0 }), null)
	})

	test('rejects truncated values', () => {
		for (const v of [V.int(7), V.double(2.5), V.string('abc'), V.int64(9n), V.array([V.int(1)]), V.binary([1, 2, 3])]) {
			const full = encodeValue(v)
			for (let len = 0; len < full.length; len++) {
				assert.equal(decodeValue(full.subarray(0, len)), null, `accepted truncation at ${len} of ${v.type}`)
			}
			assert.deepEqual(decodeValue(full), v)
		}
	})

	test('decodeValue rejects trailing bytes', () => {
		assert.equal(decodeValue(Buffer.concat([encodeValue(V.bool(true)), Buffer.from([0])])), null)
	})

	test('int constructor wraps to i32, int64 range-checks', () => {
		assert.equal(V.int(0xffffffff).value, -1)
		assert.equal(V.int(2147483648).value, -2147483648)
		assert.throws(() => V.int(1.5), TypeError)
		assert.equal(V.int64(5).value, 5n)
		assert.throws(() => V.int64(1n << 64n), RangeError)
		assert.throws(() => V.int64(2 ** 60), TypeError)
	})

	test('asInt widens int and int64', () => {
		assert.equal(asInt(V.int(-3)), -3)
		assert.equal(asInt(V.int64(42)), 42)
		assert.equal(asInt(V.int64(1n << 60n)), 1n << 60n)
		assert.equal(asInt(V.bool(true)), null)
		assert.equal(asInt(null), null)
	})
})
