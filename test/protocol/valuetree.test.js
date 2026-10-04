import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { encodePropertyChanged } from '../../src/protocol/change-frame.js'
import { V } from '../../src/protocol/juce-var.js'
import { node, ValueTree } from '../../src/protocol/valuetree.js'

const str = (s) => [...Buffer.from(s), 0x00]

describe('ValueTree codec', () => {
	test('parses a property with an int value', () => {
		// faderLevel = 75 as a one-property node body.
		const data = Buffer.from([
			...str('FADER'),
			0x01,
			0x01,
			...str('faderLevel'),
			0x01,
			0x05,
			0x01,
			0x4b,
			0x00,
			0x00,
			0x00,
			0x00,
		])
		const cursor = { pos: 0 }
		const n = ValueTree.parse(data, cursor)
		assert.equal(cursor.pos, data.length)
		assert.equal(n.type, 'FADER')
		assert.deepEqual(n.get('faderLevel'), V.int(75))
	})

	test('parses bool, double and binary properties', () => {
		const data = Buffer.from([
			...str('N'),
			0x01,
			0x03,
			...str('meterStereo'),
			0x01,
			0x01,
			0x02,
			...str('meterPeakL'),
			0x01,
			0x09,
			0x04,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0xf0,
			0x3f,
			...str('mixUnlinkRequest'),
			0x01,
			0x07,
			0x08,
			0x01,
			0x01,
			0x02,
			0x01,
			0x01,
			0x02,
			0x00,
		])
		const n = ValueTree.parse(data, { pos: 0 })
		assert.deepEqual(n.get('meterStereo'), V.bool(true))
		assert.equal(n.get('meterPeakL').value, 1.0)
		assert.deepEqual(n.get('mixUnlinkRequest'), V.binary([0x01, 0x01, 0x02, 0x01, 0x01, 0x02]))
	})

	test('node stream round-trips', () => {
		const root = new ValueTree('ROOT', { name: V.string('fixture') }, [
			new ValueTree('CHILD', { enabled: V.bool(true) }),
		])
		const bytes = root.toBuffer()
		const cursor = { pos: 0 }
		const back = ValueTree.parse(bytes, cursor)
		assert.equal(cursor.pos, bytes.length)
		assert.ok(back.equals(root))
		assert.deepEqual(back.toJSON(), root.toJSON())
	})

	test('fromFullSync requires the 0x02 header and no trailing bytes', () => {
		const root = new ValueTree('ROOT', {}, [new ValueTree('A'), new ValueTree('B')])
		const payload = Buffer.concat([Buffer.from([0x02]), root.toBuffer()])
		assert.ok(ValueTree.fromFullSync(payload).equals(root))
		assert.equal(ValueTree.fromFullSync(Buffer.alloc(0)), null)
		assert.equal(ValueTree.fromFullSync(Buffer.concat([Buffer.from([0x01]), root.toBuffer()])), null)
		assert.equal(ValueTree.fromFullSync(Buffer.concat([payload, Buffer.from([0])])), null)
		assert.equal(ValueTree.fromFullSync(payload.subarray(0, payload.length - 1)), null)
	})

	test('a declared child count is a hard contract (truncation yields null)', () => {
		const data = Buffer.from([...str('ROOT'), 0x00, 0x01, 0x02, ...str('ONLYONE'), 0x00, 0x00])
		assert.equal(ValueTree.parse(data, { pos: 0 }), null)
	})

	test('toString matches the Rust Display', () => {
		const n = new ValueTree('FADER', { faderLevel: V.int(75), channelOutputMute: V.bool(false) })
		assert.equal(n.toString(), 'Node(FADER, 2 props, 0 children)')
	})
})

describe('ValueTree helpers', () => {
	const tree = () =>
		node('DEVICE', {}, [
			node('OTHER'),
			node('PHYSICALINTERFACE', {}, [
				node('HEADER'),
				node('FADER', { faderLevel: V.int(1) }),
				node('FADER', { faderLevel: V.int(2) }),
			]),
			node('CHANNEL', { channelOutputMute: V.bool(false) }),
			node('CHANNEL', { channelOutputMute: V.bool(true) }),
			node('SYSTEM', { systemFirmwareVersion: V.string('1.7.4') }),
		])

	test('getByPath, find helpers and counts', () => {
		const t = tree()
		assert.equal(t.getByPath([]), t)
		assert.equal(t.getByPath([1, 2]).get('faderLevel').value, 2)
		assert.equal(t.getByPath([9]), null)
		assert.equal(t.getByPath([1, 2, 0]), null)
		assert.equal(t.indexOfChild('CHANNEL'), 2)
		assert.equal(t.indexOfChild('NOPE'), -1)
		assert.equal(t.findChild('SYSTEM').type, 'SYSTEM')
		assert.equal(t.findChild('NOPE'), null)
		assert.equal(t.findChildren('CHANNEL').length, 2)
		assert.deepEqual(
			[...t.entriesOfType('CHANNEL')].map(([i]) => i),
			[2, 3],
		)
		assert.equal(t.countConsecutive(2, 'CHANNEL'), 2)
		assert.equal(t.countConsecutive(1, 'CHANNEL'), 0)
		assert.equal(t.children[1].countConsecutive(1, 'FADER'), 2)
		assert.deepEqual(t.findProperty('systemFirmwareVersion'), V.string('1.7.4'))
		assert.equal(t.findProperty('missing'), null)
		assert.deepEqual(t.pathOf(t.children[1].children[2]), [1, 2])
		assert.equal(t.pathOf(node('X')), null)
		assert.deepEqual(t.size(), { nodes: 9, properties: 5 })
	})

	test('applyChange: propertyChanged returns old and new value', () => {
		const t = tree()
		const change = t.applyChange({
			type: 'propertyChanged',
			path: [3],
			name: 'channelOutputMute',
			value: V.bool(false),
		})
		assert.deepEqual(change, { path: [3], name: 'channelOutputMute', oldValue: V.bool(true), value: V.bool(false) })
		assert.deepEqual(t.getByPath([3]).get('channelOutputMute'), V.bool(false))
		// New property: oldValue null.
		const added = t.applyChange({ type: 'propertyChanged', path: [1, 1], name: 'newProp', value: V.int(9) })
		assert.deepEqual(added, { path: [1, 1], name: 'newProp', oldValue: null, value: V.int(9) })
		// Unresolvable path: null, tree untouched.
		assert.equal(t.applyChange({ type: 'propertyChanged', path: [42], name: 'x', value: V.int(1) }), null)
	})

	test('applyChange: propertyRemoved', () => {
		const t = tree()
		const change = t.applyChange({ type: 'propertyRemoved', path: [4], name: 'systemFirmwareVersion' })
		assert.deepEqual(change, { path: [4], name: 'systemFirmwareVersion', oldValue: V.string('1.7.4'), value: null })
		assert.equal(t.getByPath([4]).get('systemFirmwareVersion'), null)
	})

	test('applyChange: structural records', () => {
		const t = tree()
		const sub = node('NEW')
		assert.equal(t.applyChange({ type: 'childAdded', path: [1], index: 1, subtree: sub }).structural, true)
		assert.equal(t.getByPath([1, 1]), sub)
		assert.equal(t.applyChange({ type: 'childMoved', path: [1], oldIndex: 1, newIndex: 3 }).node, sub)
		assert.equal(t.getByPath([1, 3]), sub)
		assert.equal(t.applyChange({ type: 'childRemoved', path: [1], oldIndex: 3 }).node, sub)
		assert.equal(t.children[1].children.length, 3)
		assert.equal(t.applyChange({ type: 'childRemoved', path: [1], oldIndex: 99 }), null)
	})

	test('applyChange: fullSync replaces the contents in place', () => {
		const t = tree()
		const fresh = node('Rodecaster', { a: V.int(1) }, [node('X')])
		assert.deepEqual(t.applyChange({ type: 'fullSync', root: fresh }), { path: [], fullSync: true })
		assert.equal(t.type, 'Rodecaster')
		assert.ok(t.equals(fresh))
	})

	test('encodePropertyChange matches the change-frame encoder', () => {
		const t = tree()
		for (const [path, name, value] of [
			[[3], 'channelOutputMute', V.bool(true)],
			[[1, 2], 'faderLevel', V.int(75)],
			[[], 'root', V.string('x')],
		]) {
			assert.deepEqual(t.encodePropertyChange(path, name, value), encodePropertyChanged(path, name, value))
			assert.deepEqual(ValueTree.encodePropertyChange(path, name, value), encodePropertyChanged(path, name, value))
		}
	})

	test('clone is deep and equals', () => {
		const t = tree()
		const c = t.clone()
		assert.ok(c.equals(t))
		c.getByPath([2]).properties.set('channelOutputMute', V.bool(true))
		assert.ok(!c.equals(t))
	})
})
