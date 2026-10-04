/**
 * Integration tests backed by the sanitized Duo fw 1.7.4 full sync captured
 * from real hardware (port of the crate's tests/captured_full_sync.rs).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeChangeFrame, encodeFullSync } from '../../src/protocol/change-frame.js'
import { discoverCapabilities } from '../../src/protocol/capabilities.js'
import { decodeEvent } from '../../src/protocol/events.js'
import { Layout } from '../../src/protocol/layout.js'
import { ProtocolSession } from '../../src/protocol/session.js'
import { encodeReports, Reassembler, REPORT_ID_IN, REPORT_PAYLOAD } from '../../src/protocol/usb.js'
import { duoFrame, duoFullSyncBody } from './helpers.js'

const manifest = readFileSync(fileURLToPath(new URL('../fixtures/duo/fw-1.7.4/manifest.toml', import.meta.url)), 'utf8')
const expected = (key) => Number(manifest.match(new RegExp(`^${key} = (\\d+)`, 'm'))[1])

function duoFixture() {
	const body = duoFullSyncBody()
	const frame = decodeChangeFrame(body)
	assert.equal(frame?.type, 'fullSync')
	return { body, root: frame.root, layout: Layout.fromFullSync(frame.root) }
}

describe('Duo 1.7.4 captured full sync', () => {
	test('layout contract matches the manifest', () => {
		const { root, layout } = duoFixture()
		assert.equal(layout.model, 'duo')
		assert.equal(layout.faderCount, expected('expected_faders'))
		assert.equal(layout.channelCount, expected('expected_channels'))
		assert.equal(layout.sourceCount, expected('expected_sources'))
		assert.equal(layout.mixCountPerSource, expected('expected_mixes_per_source'))
		assert.equal(layout.inputSourceCount, expected('expected_input_sources'))
		assert.equal(layout.headphoneCount, expected('expected_headphones'))
		assert.equal(layout.effectsCount, expected('expected_effects'))
		assert.equal(layout.padCount, expected('expected_pads'))
		assert.equal(layout.sipCallSlotsCount, expected('expected_sip_call_slots'))
		assert.equal(layout.sipRegistrationCount, expected('expected_sip_registrations'))
		assert.deepEqual(root.size(), { nodes: expected('expected_nodes'), properties: expected('expected_properties') })
		assert.deepEqual(root.findProperty('systemFirmwareVersion'), { type: 'string', value: '1.7.4' })
		assert.equal(root.type, 'Rodecaster')
	})

	test('discovered root positions on real firmware', () => {
		// Pinned so a regression in run discovery is visible, not just a count change.
		const { layout } = duoFixture()
		assert.equal(layout.physicalInterfaceIdx, 0)
		assert.equal(layout.firstFaderInPhys, 4)
		assert.equal(layout.firstChannel, 28)
		assert.equal(layout.firstMix, 62)
		assert.equal(layout.firstInputSource, 328)
		assert.equal(layout.system, 15)
		assert.equal(layout.gui, 7)
		assert.equal(layout.output, 13)
		assert.equal(layout.masterChannel, 14)
		assert.equal(layout.recorder, 3)
		assert.equal(layout.soundpads, 361)
		assert.equal(layout.firstPad, 0)
	})

	test('strip list with sources from the capture', () => {
		const { root, layout } = duoFixture()
		const strips = root.findChildren('CHANNEL').map((c, i) => ({
			index: i,
			fader:
				i < 9
					? [
							'physical1',
							'physical2',
							'physical3',
							'physical4',
							'virtual1',
							'virtual2',
							'virtual3',
							'virtual4',
							'virtual5',
						][i]
					: null,
			source: c.get('channelInputSource'),
		}))
		assert.equal(strips.length, 10)
		// Sanitized capture: every channelInputSource is Int(0) (source combo1); the
		// 10th CHANNEL is the master strip with no named fader.
		for (const s of strips) assert.deepEqual(s.source, { type: 'int', value: 0 })
		const caps = discoverCapabilities(root, layout)
		assert.deepEqual(caps.faders, [
			'physical1',
			'physical2',
			'physical3',
			'physical4',
			'virtual1',
			'virtual2',
			'virtual3',
			'virtual4',
			'virtual5',
		])
		assert.equal(caps.sources.length, 19)
		assert.equal(caps.sources[0], 'combo1')
		assert.equal(caps.sources[18], 'callme3')
		assert.equal(caps.mixOutputs.length, 13)
		assert.equal(caps.firmware, '1.7.4')
		assert.ok(caps.supportsFader('physical4'))
		assert.ok(!caps.supportsFader('physical5'))
		assert.equal(caps.physicalComboCount, 2)
		assert.equal(caps.physicalHeadphoneCount, 2)
		assert.equal(caps.isInSetup, false)
	})

	test('high-level session discovers Duo capabilities and encodes for it', () => {
		const { body } = duoFixture()
		const s = new ProtocolSession()
		const update = s.ingest(body)
		assert.equal(update.type, 'ready')
		assert.equal(update.initialEvents.length, 3068)
		assert.equal(s.capabilities.model, 'duo')
		const payloads = s.encode({ type: 'setFaderMute', fader: 'physical4', mute: true })
		assert.equal(payloads.length, 1)
		assert.deepEqual(decodeEvent(payloads[0], s.layout), { type: 'faderMuteChanged', fader: 'physical4', muted: true })
		// physical4 is CHANNEL index 3 -> root child 28 + 3 = 31.
		assert.deepEqual(payloads[0].subarray(0, 5), Buffer.from([0x01, 0x01, 0x01, 0x01, 31]))
		assert.throws(
			() => s.encode({ type: 'setFaderMute', fader: 'physical5', mute: true }),
			(e) => e.code === 'encode',
		)
		// A property change on the real tree updates it and decodes to a typed event.
		const mutePath = s.layout.channelPath(0)
		const change = s.ingest(s.tree.encodePropertyChange(mutePath, 'channelOutputMute', { type: 'bool', value: true }))
		assert.deepEqual(change.event, { type: 'faderMuteChanged', fader: 'physical1', muted: true })
		assert.deepEqual(change.change.oldValue, { type: 'bool', value: false })
	})

	test('all discovered addresses reverse cleanly', () => {
		const { layout } = duoFixture()
		for (let f = 0; f < layout.faderCount; f++) assert.equal(layout.faderIndexFromPath(layout.faderPath(f)), f)
		for (let c = 0; c < layout.channelCount; c++) assert.equal(layout.channelIndexFromPath(layout.channelPath(c)), c)
		for (let s = 0; s < layout.sourceCount; s++) {
			assert.equal(layout.inputSourceIndexFromPath(layout.inputSourcePath(s)), s)
			for (let m = 0; m < layout.mixCountPerSource; m++)
				assert.deepEqual(layout.mixCellFromPath(layout.mixCellPath(s, m)), { source: s, mix: m })
		}
		for (let h = 0; h < layout.headphoneCount; h++)
			assert.equal(layout.headphoneIndexFromPath(layout.headphonePath(h)), h)
		for (let e = 0; e < layout.effectsCount; e++) assert.equal(layout.effectsIndexFromPath(layout.effectsPath(e)), e)
		for (let p = 0; p < layout.padCount; p++) assert.equal(layout.padIndexFromPath(layout.padPath(p)), p)
	})

	test('full sync decodes to 3068 semantic events, none unknown', () => {
		const { body, layout } = duoFixture()
		const event = decodeEvent(body, layout)
		assert.equal(event.type, 'initialState')
		const events = event.events
		assert.equal(events.length, 3068)
		assert.equal(events.filter((e) => e.type === 'unknown').length, 0)
		assert.ok(events.some((e) => e.type === 'systemParamChanged'))
		assert.ok(events.some((e) => e.type === 'faderMuteChanged'))
		assert.ok(events.some((e) => e.type === 'mixLevelChanged'))
	})

	test('rejects truncated and overlong change frames', () => {
		const { body } = duoFixture()
		const cuts = new Set()
		for (let i = 0; i < body.length; i += 4096) cuts.add(i)
		for (let i = Math.max(0, body.length - 256); i < body.length; i++) cuts.add(i)
		for (const len of cuts)
			assert.equal(decodeChangeFrame(body.subarray(0, len)), null, `accepted truncation at ${len}`)
		assert.equal(decodeChangeFrame(Buffer.concat([body, Buffer.from([0])])), null)
	})

	test('fixture contains only sanitized values', () => {
		const { root } = duoFixture()
		const sanitizedValue = (v) => {
			switch (v.type) {
				case 'bool':
					return v.value === false
				case 'int':
					return v.value === 0
				case 'int64':
					return v.value === 0n
				case 'double':
					return v.value === 0
				case 'undefined':
					return true
				case 'string':
					return v.value === '<redacted>'
				case 'array':
					return v.value.every(sanitizedValue)
				case 'binary':
					return v.value.every((b) => b === 0)
				case 'unknown':
					return v.data.every((b) => b === 0)
				default:
					return false
			}
		}
		const walk = (node) => {
			for (const [name, v] of node.properties) {
				if (name === 'boardType' && v.type === 'int' && v.value === 1) continue
				if (name === 'systemFirmwareVersion') {
					assert.deepEqual(v, { type: 'string', value: '1.7.4' })
					continue
				}
				if (name === 'mixLevelWithAnchor') {
					assert.deepEqual(v, { type: 'string', value: '0.0|0.0' })
					continue
				}
				assert.ok(sanitizedValue(v), `unsanitized ${name}: ${v.type} ${String(v.value ?? v.data ?? '')}`)
			}
			node.children.forEach(walk)
		}
		walk(root)
	})

	test('codec is stable: re-encoding the tree reproduces the capture byte for byte', () => {
		const { body, root } = duoFixture()
		assert.ok(encodeFullSync(root).equals(body))
		const frame = duoFrame()
		const rebuilt = Buffer.alloc(8 + body.length)
		rebuilt.writeUInt32LE(0xf2b49e2c, 0)
		rebuilt.writeUInt32LE(body.length, 4)
		encodeFullSync(root).copy(rebuilt, 8)
		assert.ok(rebuilt.equals(frame))
	})

	test('reassembles the dump from 256-byte report-4 reports', () => {
		const { body } = duoFixture()
		const reports = encodeReports(body, REPORT_ID_IN)
		assert.equal(reports.length, Math.ceil((4 + body.length) / REPORT_PAYLOAD))
		const r = new Reassembler()
		const bodies = []
		for (const rep of reports) bodies.push(...r.push(rep))
		assert.equal(bodies.length, 1)
		assert.ok(bodies[0].equals(body))
		assert.equal(r.pending, 0)
		const s = new ProtocolSession()
		assert.equal(s.ingest(bodies[0]).type, 'ready')
	})
})
