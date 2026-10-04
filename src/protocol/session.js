/**
 * Handshake bytes and the transport-independent protocol session.
 *
 * Session lifecycle (mirrors `rodecaster-protocol/src/session.rs`, MIT,
 * Yeradon; handshake facts from rodecasterpro2-linux `rcp2-proto` and
 * AccessCaster RODECASTER_PROTOCOL.txt section 2.5):
 *
 * 1. Open the HID interface and start reading before writing anything: the
 *    state dump begins at once and reports are lost if nobody reads them.
 * 2. Send {@link modeNormalReport} (report 1, `'N'`), wait ~200 ms
 *    ({@link HANDSHAKE_PAUSE_MS}, as RODE's app does), then send
 *    {@link sessionOpenReport} (report 3, body `AD 10 A7 B0`). The device
 *    answers with a report-2 ACK and streams its whole state as a `fullSync`
 *    on report 4, then pushes `propertyChanged` records as things change.
 * 3. Feed every complete body (from `usb.Reassembler`) to
 *    {@link ProtocolSession.ingest}. A fullSync makes the session ready
 *    (`layout`, `capabilities`, `tree` populated) and yields the initial
 *    state; afterwards each record yields one typed event and keeps `tree`
 *    current.
 * 4. A structural change (child added/removed/moved) invalidates the
 *    layout: the session resets and asks for a fresh full sync (send
 *    {@link sessionOpenReport} again).
 *
 * Only ever write `0x4E` on report 1: other report-1 bytes (`0x4D`, `0x55`)
 * put the device into firmware-update mode or trigger a flash.
 *
 * @module protocol/session
 */

import { EventEmitter } from 'node:events'
import { discoverCapabilities } from './capabilities.js'
import { decodeChangeFrame } from './change-frame.js'
import { encodeCommand, EncodeError } from './commands.js'
import { decodeEventFromFrame, extractInitialState } from './events.js'
import { Layout, LayoutError } from './layout.js'
import { encodeReports, MODE_REPORT_SIZE, REPORT_ID_MODE, REPORT_ID_OUT, REPORT_SIZE } from './usb.js'
import { ValueTree } from './valuetree.js'

/** @typedef {import('./commands.js').Command} Command */
/** @typedef {import('./events.js').DeviceEvent} DeviceEvent */
/** @typedef {import('./capabilities.js').DeviceCapabilities} DeviceCapabilities */

/** Report-1 byte for normal / app mode (`'N'`). The only safe report-1 byte. */
export const MODE_NORMAL_BYTE = 0x4e

/**
 * The 4-byte body the device expects as the first report-3 message after
 * connect to subscribe to notifications and start a full-state sync. On the
 * wire it is `[04 00 00 00][AD 10 A7 B0]` zero-padded in one report.
 */
export const SESSION_OPEN_BODY = Buffer.from([0xad, 0x10, 0xa7, 0xb0])

/** Alias matching the Rust `HANDSHAKE_BODY`. */
export const HANDSHAKE_BODY = SESSION_OPEN_BODY

/** Pause between the two handshake reports, as observed with RODE's app. */
export const HANDSHAKE_PAUSE_MS = 200

/**
 * The report-1 mode report: `01 4E` zero-padded to 64 bytes (report ID + 63
 * data bytes on the command path).
 * @returns {Buffer}
 */
export function modeNormalReport() {
	const report = Buffer.alloc(MODE_REPORT_SIZE)
	report[0] = REPORT_ID_MODE
	report[1] = MODE_NORMAL_BYTE
	return report
}

/**
 * The report-3 session-open report: `03 04 00 00 00 AD 10 A7 B0` zero-padded
 * to 256 bytes.
 * @returns {Buffer}
 */
export function sessionOpenReport() {
	const [report] = encodeReports(SESSION_OPEN_BODY, REPORT_ID_OUT)
	return report
}

/** Alias matching the Rust `usb::handshake_bytes()` (one 256-byte report). */
export const handshakeBytes = sessionOpenReport

/**
 * Both handshake reports in send order. Pause {@link HANDSHAKE_PAUSE_MS}
 * between them.
 * @returns {[Buffer, Buffer]}
 */
export function handshakeReports() {
	return [modeNormalReport(), sessionOpenReport()]
}

/** Thrown by {@link ProtocolSession.ingest} / {@link ProtocolSession.encode}. */
export class SessionError extends Error {
	/**
	 * @param {'decode' | 'layout' | 'notReady' | 'encode'} code
	 * @param {Error} [cause]
	 */
	constructor(code, cause) {
		const text = {
			decode: 'invalid or incomplete protocol payload',
			layout: `could not build device layout: ${cause?.message ?? ''}`,
			notReady: 'protocol session needs a full sync',
			encode: `could not encode command: ${cause?.message ?? ''}`,
		}[code]
		super(text, cause ? { cause } : undefined)
		this.name = 'SessionError'
		this.code = code
	}
}

/**
 * @typedef {{ type: 'ready', initialEvents: DeviceEvent[] }
 *   | { type: 'event', event: DeviceEvent, change: ReturnType<ValueTree['applyChange']> }
 *   | { type: 'needsFullSync' }} SessionUpdate
 */

/**
 * Stateful, transport-independent RODECaster protocol session.
 *
 * Events emitted:
 * - `'ready'`   (initialEvents, capabilities)   after a valid fullSync
 * - `'event'`   (event, change)                 one typed incremental event
 * - `'change'`  (change)                        raw tree change `{path, name, oldValue, value}`
 * - `'needsFullSync'`                           layout invalidated; send sessionOpenReport again
 */
export class ProtocolSession extends EventEmitter {
	constructor() {
		super()
		/** @type {ValueTree | null} the live state tree (root), after a fullSync */
		this.tree = null
		/** @type {Layout | null} */
		this.layout = null
		/** @type {DeviceCapabilities | null} */
		this.capabilities = null
	}

	/** Whether a valid full sync has established the current layout. */
	get isReady() {
		return this.layout !== null
	}

	/** Forget the current layout and tree; back to the pre-full-sync state. */
	reset() {
		this.tree = null
		this.layout = null
		this.capabilities = null
	}

	/**
	 * Ingest exactly one change-frame body (no transport wrapper).
	 * Throws {@link SessionError}: `decode` for a malformed body, `layout`
	 * when a fullSync lacks the required topology (the session is reset),
	 * `notReady` for an incremental record before any fullSync.
	 * @param {Uint8Array} body
	 * @returns {SessionUpdate}
	 */
	ingest(body) {
		const frame = decodeChangeFrame(body)
		if (!frame) throw new SessionError('decode')
		switch (frame.type) {
			case 'fullSync': {
				// A replacement sync supersedes the old address space even if the
				// new topology is unsupported: never keep encoding through a stale
				// layout after a failed resync.
				this.reset()
				let layout
				try {
					layout = Layout.fromFullSync(frame.root)
				} catch (err) {
					if (err instanceof LayoutError) throw new SessionError('layout', err)
					throw err
				}
				const capabilities = discoverCapabilities(frame.root, layout)
				const initialEvents = extractInitialState(frame.root, layout)
				this.tree = frame.root
				this.layout = layout
				this.capabilities = capabilities
				this.emit('ready', initialEvents, capabilities)
				return { type: 'ready', initialEvents }
			}
			case 'childAdded':
			case 'childRemoved':
			case 'childMoved':
				this.reset()
				this.emit('needsFullSync')
				return { type: 'needsFullSync' }
			case 'propertyChanged':
			case 'propertyRemoved': {
				if (!this.layout || !this.tree) throw new SessionError('notReady')
				const change = this.tree.applyChange(frame)
				const event = decodeEventFromFrame(frame, this.layout)
				if (change) this.emit('change', change)
				this.emit('event', event, change)
				return { type: 'event', event, change }
			}
			default:
				throw new SessionError('decode')
		}
	}

	/**
	 * Encode a command into change-frame bodies using the current layout.
	 * Throws {@link SessionError} (`notReady` or `encode`).
	 * @param {Command} command
	 * @returns {Buffer[]}
	 */
	encode(command) {
		if (!this.layout) throw new SessionError('notReady')
		try {
			return encodeCommand(command, this.layout)
		} catch (err) {
			if (err instanceof EncodeError) throw new SessionError('encode', err)
			throw err
		}
	}

	/**
	 * Encode a command straight to HID output reports (each {@link REPORT_SIZE}
	 * bytes, report ID 3), in send order.
	 * @param {Command} command
	 * @returns {Buffer[]}
	 */
	encodeReports(command) {
		return this.encode(command).flatMap((body) => encodeReports(body, REPORT_ID_OUT))
	}
}

export { REPORT_SIZE }
