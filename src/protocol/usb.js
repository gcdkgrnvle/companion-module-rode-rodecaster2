/**
 * USB HID transport framing and report chunking.
 *
 * Mirrors `rodecaster-protocol/src/usb.rs` (MIT, Yeradon), cross-checked
 * against rcp2-cli's `transport/hid.rs` + `framing/mod.rs`, AccessCaster's
 * RODECASTER_PROTOCOL.txt section 2 and rodecasterpro2-linux's `rcp2-proto`.
 *
 * Facts confirmed from those sources:
 *
 * - Property reports are 256 bytes on the wire: one report-ID byte plus 255
 *   data bytes. Host -> device uses report ID 0x03, device -> host 0x04.
 * - A message is `[u32 LE body length][body]`. The length counts the body
 *   only; it does NOT include the 4 length bytes themselves.
 * - That framed message is cut into 255-byte pieces, each prefixed with the
 *   report ID. The last report is zero-padded to 256 bytes. Continuation
 *   reports carry no sub-header: they are raw slices of the framed message.
 * - So a message of body length L occupies ceil((4 + L) / 255) reports and
 *   every message starts at a report boundary.
 * - Report ID 0x02 (device -> host, 64-byte command path) is the ACK to a
 *   report-1 command; a normal response begins `02 41` (`'A'`).
 *
 * The {@link Reassembler} turns a stream of raw inbound reports (as read from
 * the HID device, report-ID byte first) into complete bodies.
 *
 * @module protocol/usb
 */

/** HID report ID for host -> device mode/command reports (64-byte path). */
export const REPORT_ID_MODE = 0x01
/** HID report ID for device -> host command responses / ACK (64-byte path). */
export const REPORT_ID_ACK = 0x02
/** HID report ID for host -> device property/bulk reports. */
export const REPORT_ID_OUT = 0x03
/** HID report ID for device -> host property/bulk reports. */
export const REPORT_ID_IN = 0x04

/** Total property report size on the wire: one report-ID byte plus the payload. */
export const REPORT_SIZE = 256
/** Usable payload bytes per property report. */
export const REPORT_PAYLOAD = REPORT_SIZE - 1
/** Total size of a report on the 64-byte command path (report ID + 63 data bytes). */
export const MODE_REPORT_SIZE = 64

/** ASCII 'A': first data byte of a normal report-2 response. */
export const ACK_BYTE = 0x41

/**
 * Sanity cap on a decoded message body (1 MiB). Past this, {@link scanFrame}
 * reports `desync` so a corrupt length prefix cannot wedge the reader.
 */
export const MAX_MESSAGE_LEN = 1024 * 1024

/**
 * Prefix a body with its u32 LE length.
 * @param {Uint8Array} body
 * @returns {Buffer}
 */
export function frameBody(body) {
	const framed = Buffer.alloc(4 + body.length)
	framed.writeUInt32LE(body.length, 0)
	framed.set(body, 4)
	return framed
}

/**
 * Serialize a body to the HID wire form: `[u32 LE len][body]` chunked into
 * 255-byte pieces, each prefixed with `reportId`, the last zero-padded to 256
 * bytes. Returns one Buffer per report; write each with one HID write.
 * @param {Uint8Array} body
 * @param {number} [reportId] defaults to {@link REPORT_ID_OUT}
 * @returns {Buffer[]}
 */
export function encodeReports(body, reportId = REPORT_ID_OUT) {
	const framed = frameBody(body)
	const nReports = Math.max(1, Math.ceil(framed.length / REPORT_PAYLOAD))
	const reports = []
	for (let i = 0; i < nReports; i++) {
		const report = Buffer.alloc(REPORT_SIZE)
		report[0] = reportId
		framed.copy(report, 1, i * REPORT_PAYLOAD, Math.min(framed.length, (i + 1) * REPORT_PAYLOAD))
		reports.push(report)
	}
	return reports
}

/**
 * Same as {@link encodeReports} but concatenated into one Buffer (the Rust
 * `Packet::to_bytes`). Its length is a multiple of {@link REPORT_SIZE}.
 * @param {Uint8Array} body
 * @param {number} [reportId]
 * @returns {Buffer}
 */
export function encodeWire(body, reportId = REPORT_ID_OUT) {
	return Buffer.concat(encodeReports(body, reportId))
}

/**
 * Read the 4-byte length prefix from the first report's payload. The caller
 * must have confirmed `buf.length >= REPORT_SIZE`.
 * @param {Uint8Array} buf
 */
function frameLenUnchecked(buf) {
	return buf[1] + buf[2] * 0x100 + buf[3] * 0x10000 + buf[4] * 0x1000000
}

/**
 * @typedef {{ state: 'complete', len: number } | { state: 'incomplete' } | { state: 'desync' }} FrameScan
 */

/**
 * Scan a raw report buffer for a complete leading message. `len` in a
 * `complete` result is the raw byte count to drain (a whole number of
 * reports). `desync` means the length prefix is impossible (zero or over
 * {@link MAX_MESSAGE_LEN}); drop one report and rescan.
 * @param {Uint8Array} buf
 * @returns {FrameScan}
 */
export function scanFrame(buf) {
	if (buf.length < REPORT_SIZE) return { state: 'incomplete' }
	const bodyLen = frameLenUnchecked(buf)
	if (bodyLen === 0 || bodyLen > MAX_MESSAGE_LEN) return { state: 'desync' }
	const nReports = Math.ceil((4 + bodyLen) / REPORT_PAYLOAD)
	const totalRaw = nReports * REPORT_SIZE
	if (buf.length < totalRaw) return { state: 'incomplete' }
	return { state: 'complete', len: totalRaw }
}

/**
 * Parse one message from a buffer of raw reports (each 256 bytes as read from
 * the device). Returns the body and the raw byte count to drain, or `null`
 * unless the buffer begins with a complete, valid message. The report-ID byte
 * of each report is ignored, so this decodes both OUT and IN streams.
 * @param {Uint8Array} buf
 * @returns {{ body: Buffer, consumed: number } | null}
 */
export function packetFromBytes(buf) {
	const scan = scanFrame(buf)
	if (scan.state !== 'complete') return null
	const bodyLen = frameLenUnchecked(buf)
	const nReports = scan.len / REPORT_SIZE
	// De-chunk: concatenate each report's payload (skipping the report-ID
	// byte), then take the body that follows the 4-byte length prefix.
	const framed = Buffer.alloc(nReports * REPORT_PAYLOAD)
	for (let i = 0; i < nReports; i++) {
		const base = i * REPORT_SIZE
		framed.set(buf.subarray(base + 1, base + REPORT_SIZE), i * REPORT_PAYLOAD)
	}
	return { body: framed.subarray(4, 4 + bodyLen), consumed: scan.len }
}

/**
 * The body of one complete message at the front of a raw report buffer.
 * @param {Uint8Array} buf
 * @returns {Buffer | null}
 */
export function framePayload(buf) {
	const p = packetFromBytes(buf)
	return p ? p.body : null
}

/**
 * Is this inbound report a report-2 ACK (`02 41 ...`)?
 * @param {Uint8Array} report report-ID byte first
 */
export function isAckReport(report) {
	return report.length >= 2 && report[0] === REPORT_ID_ACK && report[1] === ACK_BYTE
}

/**
 * Reassembles inbound HID reports into complete message bodies.
 *
 * Feed every report exactly as read from the device (report-ID byte first).
 * Report-4 reports are appended to a buffer and complete messages are cut
 * out by their length prefix, exactly like the Rust `scan_frame` /
 * `Packet::from_bytes` loop. Report-2 reports are counted as ACKs and
 * never enter the buffer. Other report IDs are ignored.
 *
 * A report shorter than 256 bytes is zero-padded to 256 so report alignment
 * is preserved (hidraw delivers whole reports; a short read is unexpected).
 */
export class Reassembler {
	constructor() {
		/** @type {Buffer} raw report bytes not yet consumed */
		this.buffer = Buffer.alloc(0)
		/** Number of report-2 ACKs seen. */
		this.ackCount = 0
		/** The most recent report-2 report (report-ID byte included), or null. */
		this.lastAck = null
		/** Number of reports dropped because of an impossible length prefix. */
		this.desyncCount = 0
		/** Number of reports ignored because of an unknown report ID. */
		this.ignoredCount = 0
	}

	/**
	 * Push one inbound report. Returns every complete body it completes (zero,
	 * one, or several).
	 * @param {Uint8Array} report
	 * @returns {Buffer[]}
	 */
	push(report) {
		if (report.length === 0) return []
		if (report[0] === REPORT_ID_ACK) {
			this.ackCount++
			this.lastAck = Buffer.from(report)
			return []
		}
		if (report[0] !== REPORT_ID_IN && report[0] !== REPORT_ID_OUT) {
			this.ignoredCount++
			return []
		}
		let chunk = Buffer.from(report)
		if (chunk.length < REPORT_SIZE) {
			chunk = Buffer.concat([chunk, Buffer.alloc(REPORT_SIZE - chunk.length)])
		} else if (chunk.length > REPORT_SIZE) {
			chunk = chunk.subarray(0, REPORT_SIZE)
		}
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
		return this.drain()
	}

	/** @returns {Buffer[]} */
	drain() {
		const bodies = []
		for (;;) {
			const scan = scanFrame(this.buffer)
			if (scan.state === 'incomplete') break
			if (scan.state === 'desync') {
				this.desyncCount++
				this.buffer = this.buffer.subarray(Math.min(REPORT_SIZE, this.buffer.length))
				continue
			}
			const packet = packetFromBytes(this.buffer)
			if (!packet) break
			bodies.push(Buffer.from(packet.body))
			this.buffer = this.buffer.subarray(packet.consumed)
		}
		if (this.buffer.length === 0) this.buffer = Buffer.alloc(0)
		return bodies
	}

	/** Bytes of a partially received message still waiting, or 0. */
	get pending() {
		return this.buffer.length
	}

	/** Drop any partial message. */
	reset() {
		this.buffer = Buffer.alloc(0)
	}
}
