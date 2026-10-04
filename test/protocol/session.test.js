import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { encodeFullSync, encodePropertyChanged } from '../../src/protocol/change-frame.js'
import { V } from '../../src/protocol/juce-var.js'
import {
	HANDSHAKE_BODY,
	HANDSHAKE_PAUSE_MS,
	handshakeReports,
	MODE_NORMAL_BYTE,
	modeNormalReport,
	ProtocolSession,
	SESSION_OPEN_BODY,
	SessionError,
	sessionOpenReport,
} from '../../src/protocol/session.js'
import { encodeReports, REPORT_ID_OUT, REPORT_SIZE } from '../../src/protocol/usb.js'
import { ValueTree } from '../../src/protocol/valuetree.js'
import { minimalRootWith, n, np, syntheticRoot } from './helpers.js'

describe('handshake bytes', () => {
	test('report 1 carries only the normal-mode byte, zero-padded to 64', () => {
		const r = modeNormalReport()
		assert.equal(r.length, 64)
		assert.equal(MODE_NORMAL_BYTE, 0x4e)
		assert.deepEqual(r.subarray(0, 2), Buffer.from([0x01, 0x4e]))
		assert.equal(r[1], 'N'.charCodeAt(0))
		assert.ok(r.subarray(2).every((b) => b === 0))
		// Firmware-update bytes must never appear.
		assert.notEqual(r[1], 0x4d)
		assert.notEqual(r[1], 0x55)
	})

	test('report 3 session-open is the length-prefixed AD 10 A7 B0 body', () => {
		const r = sessionOpenReport()
		assert.equal(r.length, REPORT_SIZE)
		assert.deepEqual(r.subarray(0, 9), Buffer.from([REPORT_ID_OUT, 0x04, 0x00, 0x00, 0x00, 0xad, 0x10, 0xa7, 0xb0]))
		assert.ok(r.subarray(9).every((b) => b === 0))
		assert.deepEqual(SESSION_OPEN_BODY, Buffer.from([0xad, 0x10, 0xa7, 0xb0]))
		assert.equal(HANDSHAKE_BODY, SESSION_OPEN_BODY)
		assert.deepEqual(r, encodeReports(SESSION_OPEN_BODY)[0])
	})

	test('handshakeReports is mode then session-open', () => {
		const [a, b] = handshakeReports()
		assert.deepEqual(a, modeNormalReport())
		assert.deepEqual(b, sessionOpenReport())
		assert.equal(HANDSHAKE_PAUSE_MS, 200)
	})
})

describe('ProtocolSession', () => {
	test('rejects incremental events before a full sync', () => {
		const s = new ProtocolSession()
		assert.ok(!s.isReady)
		assert.throws(
			() => s.ingest(encodePropertyChanged([], 'property', V.bool(true))),
			(e) => e instanceof SessionError && e.code === 'notReady',
		)
		assert.throws(
			() => s.encode({ type: 'screenTouched' }),
			(e) => e.code === 'notReady',
		)
	})

	test('rejects malformed payloads', () => {
		const s = new ProtocolSession()
		assert.throws(
			() => s.ingest(Buffer.from([0xff])),
			(e) => e.code === 'decode',
		)
		assert.throws(
			() => s.ingest(Buffer.alloc(0)),
			(e) => e.code === 'decode',
		)
	})

	test('a structural change invalidates the session, ready or not', () => {
		const s = new ProtocolSession()
		let fired = 0
		s.on('needsFullSync', () => fired++)
		const childMoved = Buffer.from([0x05, 0x00, 0x01, 0x00, 0x01, 0x01])
		assert.deepEqual(s.ingest(childMoved), { type: 'needsFullSync' })
		assert.ok(!s.isReady)
		s.ingest(encodeFullSync(syntheticRoot()))
		assert.ok(s.isReady)
		assert.deepEqual(s.ingest(childMoved), { type: 'needsFullSync' })
		assert.ok(!s.isReady)
		assert.equal(s.capabilities, null)
		assert.equal(s.tree, null)
		assert.equal(fired, 2)
	})

	test('full sync readies the session, builds the tree and emits ready', () => {
		const s = new ProtocolSession()
		const root = syntheticRoot()
		let readyArgs = null
		s.on('ready', (initialEvents, capabilities) => (readyArgs = { initialEvents, capabilities }))
		const update = s.ingest(encodeFullSync(root))
		assert.equal(update.type, 'ready')
		assert.ok(s.isReady)
		assert.ok(s.tree.equals(root))
		assert.equal(s.layout.model, 'pro2')
		assert.equal(s.capabilities.faders.length, 3)
		assert.equal(s.capabilities.sources.length, 2)
		assert.equal(s.capabilities.mixOutputs.length, 13)
		assert.equal(s.capabilities.firmware, null)
		assert.equal(readyArgs.capabilities, s.capabilities)
		assert.equal(readyArgs.initialEvents, update.initialEvents)
	})

	test('property changes update the tree and emit typed events', () => {
		const s = new ProtocolSession()
		const root = syntheticRoot()
		root.getByPath([2]).properties.set('channelOutputMute', V.bool(false))
		s.ingest(encodeFullSync(root))
		const events = []
		const changes = []
		s.on('event', (e, c) => events.push([e, c]))
		s.on('change', (c) => changes.push(c))
		const body = encodePropertyChanged(s.layout.channelPath(0), 'channelOutputMute', V.bool(true))
		const update = s.ingest(body)
		assert.equal(update.type, 'event')
		assert.deepEqual(update.event, { type: 'faderMuteChanged', fader: 'physical1', muted: true })
		assert.deepEqual(update.change, {
			path: [2],
			name: 'channelOutputMute',
			oldValue: V.bool(false),
			value: V.bool(true),
		})
		assert.deepEqual(s.tree.getByPath([2]).get('channelOutputMute'), V.bool(true))
		assert.equal(events.length, 1)
		assert.equal(changes.length, 1)
		// A change on a path outside the tree still yields an event; change is null.
		const stray = s.ingest(encodePropertyChanged([99], 'x', V.int(1)))
		assert.equal(stray.event.type, 'unknown')
		assert.equal(stray.change, null)
	})

	test('a failed resync drops the stale layout', () => {
		const s = new ProtocolSession()
		s.ingest(encodeFullSync(syntheticRoot()))
		assert.ok(s.isReady)
		assert.throws(
			() => s.ingest(encodeFullSync(new ValueTree('DEVICE'))),
			(e) => e instanceof SessionError && e.code === 'layout' && e.cause.code === 'missingNode',
		)
		assert.ok(!s.isReady)
		assert.equal(s.capabilities, null)
	})

	test('encode wraps EncodeError and encodeReports produces HID reports', () => {
		const s = new ProtocolSession()
		s.ingest(encodeFullSync(syntheticRoot()))
		const bodies = s.encode({ type: 'setFaderMute', fader: 'physical2', mute: true })
		assert.equal(bodies.length, 1)
		assert.throws(
			() => s.encode({ type: 'setFaderMute', fader: 'virtual4', mute: true }),
			(e) => e.code === 'encode' && e.cause.code === 'faderNotOnModel',
		)
		const reports = s.encodeReports({ type: 'linkMix', source: 'combo1', mix: 'speaker' })
		assert.equal(reports.length, 3)
		for (const r of reports) {
			assert.equal(r.length, REPORT_SIZE)
			assert.equal(r[0], REPORT_ID_OUT)
		}
	})

	test('capabilities report setup mode from SYSTEM flags', () => {
		const s = new ProtocolSession()
		const root = minimalRootWith([
			np('SYSTEM', { disableAllPhysicalButtons: V.bool(true), systemFirmwareVersion: V.string('1.7.3') }),
		])
		s.ingest(encodeFullSync(root))
		assert.equal(s.capabilities.isInSetup, true)
		assert.equal(s.capabilities.firmware, '1.7.3')
		const root2 = minimalRootWith([
			np('SYSTEM', { disableAllLineoutOutputs: V.bool(true), disableAllHeadphoneOutputs: V.bool(false) }),
			n('GUI'),
		])
		s.ingest(encodeFullSync(root2))
		assert.equal(s.capabilities.isInSetup, false)
		assert.equal(s.capabilities.physicalComboCount, 4)
	})
})
