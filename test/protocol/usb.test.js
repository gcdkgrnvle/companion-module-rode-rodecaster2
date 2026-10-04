import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	encodeReports,
	encodeWire,
	frameBody,
	framePayload,
	isAckReport,
	MAX_MESSAGE_LEN,
	packetFromBytes,
	Reassembler,
	REPORT_ID_ACK,
	REPORT_ID_IN,
	REPORT_ID_OUT,
	REPORT_PAYLOAD,
	REPORT_SIZE,
	scanFrame,
} from '../../src/protocol/usb.js'
import { handshakeBytes, SESSION_OPEN_BODY } from '../../src/protocol/session.js'

describe('usb framing', () => {
	test('constants', () => {
		assert.equal(REPORT_SIZE, 256)
		assert.equal(REPORT_PAYLOAD, 255)
		assert.equal(REPORT_ID_OUT, 0x03)
		assert.equal(REPORT_ID_IN, 0x04)
		assert.equal(REPORT_ID_ACK, 0x02)
	})

	test('packet round-trips in a single report', () => {
		const payload = Buffer.from([0x02, 0xde, 0xad, 0xbe, 0xef])
		const bytes = encodeWire(payload)
		assert.equal(bytes.length, REPORT_SIZE)
		const parsed = packetFromBytes(bytes)
		assert.equal(parsed.consumed, bytes.length)
		assert.deepEqual(parsed.body, payload)
	})

	test('wire layout is report id, u32 LE length, body, zero padding (no magic)', () => {
		const bytes = encodeWire(Buffer.from([0xaa, 0xbb]))
		assert.equal(bytes[0], REPORT_ID_OUT)
		assert.deepEqual(bytes.subarray(1, 5), Buffer.from([2, 0, 0, 0]))
		assert.deepEqual(bytes.subarray(5, 7), Buffer.from([0xaa, 0xbb]))
		assert.ok(bytes.subarray(7).every((b) => b === 0))
		assert.deepEqual(frameBody(Buffer.from([0xaa, 0xbb])), Buffer.from([2, 0, 0, 0, 0xaa, 0xbb]))
	})

	test('the length prefix counts the body only, not itself', () => {
		// 251 body bytes + 4 length bytes = 255 -> exactly one report.
		const b251 = Buffer.alloc(251, 7)
		assert.equal(encodeReports(b251).length, 1)
		assert.equal(encodeWire(b251).readUInt32LE(1), 251)
		// 252 body bytes -> framed 256 -> two reports.
		assert.equal(encodeReports(Buffer.alloc(252, 7)).length, 2)
	})

	test('handshake matches the known bytes', () => {
		const bytes = handshakeBytes()
		assert.equal(bytes.length, REPORT_SIZE)
		assert.equal(bytes[0], REPORT_ID_OUT)
		assert.deepEqual(bytes.subarray(1, 9), Buffer.from([0x04, 0x00, 0x00, 0x00, 0xad, 0x10, 0xa7, 0xb0]))
		assert.ok(bytes.subarray(9).every((b) => b === 0))
		assert.deepEqual(SESSION_OPEN_BODY, Buffer.from([0xad, 0x10, 0xa7, 0xb0]))
	})

	test('packet round-trips across multiple reports', () => {
		// 600-byte body -> framed 604 -> 3 reports.
		const payload = Buffer.from(Array.from({ length: 600 }, (_, i) => i % 251))
		const reports = encodeReports(payload)
		assert.equal(reports.length, 3)
		for (const r of reports) {
			assert.equal(r.length, REPORT_SIZE)
			assert.equal(r[0], REPORT_ID_OUT)
		}
		// Continuation reports carry no sub-header: report 2 starts with framed[255].
		const framed = frameBody(payload)
		assert.deepEqual(reports[1].subarray(1), framed.subarray(255, 510))
		const bytes = Buffer.concat(reports)
		const parsed = packetFromBytes(bytes)
		assert.equal(parsed.consumed, 3 * REPORT_SIZE)
		assert.deepEqual(parsed.body, payload)
		assert.deepEqual(framePayload(bytes), payload)
	})

	test('scanFrame: complete, incomplete, desync', () => {
		const bytes = encodeWire(Buffer.from([1, 2, 3]))
		assert.deepEqual(scanFrame(bytes), { state: 'complete', len: REPORT_SIZE })
		assert.deepEqual(scanFrame(bytes.subarray(0, REPORT_SIZE - 1)), { state: 'incomplete' })
		assert.deepEqual(scanFrame(Buffer.alloc(0)), { state: 'incomplete' })
		const big = encodeWire(Buffer.alloc(600, 7))
		assert.deepEqual(scanFrame(big.subarray(0, 2 * REPORT_SIZE)), { state: 'incomplete' })
		assert.deepEqual(scanFrame(Buffer.alloc(REPORT_SIZE)), { state: 'desync' })
		const huge = Buffer.alloc(REPORT_SIZE)
		huge.writeUInt32LE(MAX_MESSAGE_LEN + 1, 1)
		assert.deepEqual(scanFrame(huge), { state: 'desync' })
		const max = Buffer.alloc(REPORT_SIZE)
		max.writeUInt32LE(MAX_MESSAGE_LEN, 1)
		assert.deepEqual(scanFrame(max), { state: 'incomplete' })
	})

	test('report-aligned stream stops at the first message boundary', () => {
		const first = encodeWire(Buffer.from([0x02, 0xaa]))
		const two = Buffer.concat([first, encodeWire(Buffer.from([0x02, 0xbb, 0xcc]))])
		assert.deepEqual(scanFrame(two), { state: 'complete', len: first.length })
		assert.deepEqual(framePayload(two), Buffer.from([0x02, 0xaa]))
		const { consumed } = packetFromBytes(two)
		assert.deepEqual(framePayload(two.subarray(consumed)), Buffer.from([0x02, 0xbb, 0xcc]))
	})

	test('packetFromBytes ignores the report id so IN streams decode', () => {
		const bytes = encodeWire(Buffer.from([0x02, 0x11, 0x22]))
		bytes[0] = REPORT_ID_IN
		assert.deepEqual(framePayload(bytes), Buffer.from([0x02, 0x11, 0x22]))
		assert.deepEqual(encodeReports(Buffer.from([1]), REPORT_ID_IN)[0][0], REPORT_ID_IN)
	})

	test('rejects an empty body on the wire (length 0 is desync)', () => {
		assert.equal(packetFromBytes(encodeWire(Buffer.alloc(0))), null)
	})
})

describe('Reassembler', () => {
	test('reassembles single and multi-report messages and counts ACKs', () => {
		const r = new Reassembler()
		const a = Buffer.from([0x02, 0xaa])
		const b = Buffer.from(Array.from({ length: 700 }, (_, i) => i & 0xff))
		assert.deepEqual(r.push(Buffer.from([REPORT_ID_ACK, 0x41, 0x00])), [])
		assert.equal(r.ackCount, 1)
		assert.ok(isAckReport(r.lastAck))
		const out = []
		for (const rep of encodeReports(a, REPORT_ID_IN)) out.push(...r.push(rep))
		assert.deepEqual(out, [a])
		const reps = encodeReports(b, REPORT_ID_IN)
		assert.equal(reps.length, 3)
		assert.deepEqual(r.push(reps[0]), [])
		assert.equal(r.pending, REPORT_SIZE)
		assert.deepEqual(r.push(reps[1]), [])
		assert.deepEqual(r.push(reps[2]), [b])
		assert.equal(r.pending, 0)
	})

	test('a desync report is dropped and the stream recovers', () => {
		const r = new Reassembler()
		const zero = Buffer.alloc(REPORT_SIZE)
		zero[0] = REPORT_ID_IN
		assert.deepEqual(r.push(zero), [])
		assert.equal(r.desyncCount, 1)
		const body = Buffer.from([1, 2, 3])
		assert.deepEqual(r.push(encodeReports(body, REPORT_ID_IN)[0]), [body])
	})

	test('ignores unknown report ids and pads short reports', () => {
		const r = new Reassembler()
		assert.deepEqual(r.push(Buffer.from([0x07, 1, 2, 3])), [])
		assert.equal(r.ignoredCount, 1)
		assert.deepEqual(r.push(Buffer.alloc(0)), [])
		const body = Buffer.from([9, 8, 7])
		const short = encodeReports(body, REPORT_ID_IN)[0].subarray(0, 10)
		assert.deepEqual(r.push(short), [body])
	})

	test('does not mutate the caller report and returns owned bodies', () => {
		const r = new Reassembler()
		const body = Buffer.from([5, 6])
		const rep = encodeReports(body, REPORT_ID_IN)[0]
		const copy = Buffer.from(rep)
		const [out] = r.push(rep)
		rep.fill(0)
		assert.deepEqual(out, body)
		assert.notDeepEqual(rep, copy)
	})
})
