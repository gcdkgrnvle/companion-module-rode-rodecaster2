import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	decodeChangeFrame,
	encodeChangeFrame,
	encodeChildAdded,
	encodeChildMoved,
	encodeChildRemoved,
	encodeFullSync,
	encodePropertyChanged,
	encodePropertyRemoved,
	isStructural,
} from '../../src/protocol/change-frame.js'
import { V } from '../../src/protocol/juce-var.js'
import { ValueTree } from '../../src/protocol/valuetree.js'

const str = (s) => [...Buffer.from(s), 0x00]

describe('change-frame decode', () => {
	test('decodes propertyChanged for mixLevelWithAnchor with a single-level path', () => {
		const bytes = Buffer.from([
			0x01, // propertyChanged
			0x01,
			0x01, // nLevels = 1
			0x01,
			0xd9, // path[0] = 217
			...str('mixLevelWithAnchor'),
			0x01,
			0x13,
			0x05,
			...str('0.472441|0.472441'), // var String
		])
		assert.deepEqual(decodeChangeFrame(bytes), {
			type: 'propertyChanged',
			path: [217],
			name: 'mixLevelWithAnchor',
			value: V.string('0.472441|0.472441'),
		})
	})

	test('decodes propertyChanged for faderLevel with a two-level path', () => {
		const bytes = Buffer.from([
			0x01,
			0x01,
			0x02, // nLevels = 2
			0x00, // path[0] = 0 (writeCompressedInt(0) is a single zero byte)
			0x01,
			0x07, // path[1] = 7
			...str('faderLevel'),
			0x01,
			0x05,
			0x01,
			0x4b,
			0x00,
			0x00,
			0x00, // var Int 75
		])
		assert.deepEqual(decodeChangeFrame(bytes), {
			type: 'propertyChanged',
			path: [0, 7],
			name: 'faderLevel',
			value: V.int(75),
		})
	})

	test('decodes a minimal fullSync', () => {
		const bytes = Buffer.from([0x02, ...str('ROOT'), 0x00, 0x00])
		const frame = decodeChangeFrame(bytes)
		assert.equal(frame.type, 'fullSync')
		assert.equal(frame.root.type, 'ROOT')
		assert.equal(frame.root.properties.size, 0)
		assert.equal(frame.root.children.length, 0)
	})

	test('decodes propertyRemoved', () => {
		const bytes = Buffer.from([0x06, 0x01, 0x01, 0x01, 0x05, ...str('gone')])
		assert.deepEqual(decodeChangeFrame(bytes), { type: 'propertyRemoved', path: [5], name: 'gone' })
	})

	test('decodes childRemoved', () => {
		const bytes = Buffer.from([0x04, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03])
		assert.deepEqual(decodeChangeFrame(bytes), { type: 'childRemoved', path: [2], oldIndex: 3 })
	})

	test('decodes childMoved', () => {
		const bytes = Buffer.from([0x05, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01, 0x04])
		assert.deepEqual(decodeChangeFrame(bytes), { type: 'childMoved', path: [2], oldIndex: 1, newIndex: 4 })
	})

	test('decodes childAdded with a subtree', () => {
		const bytes = Buffer.from([
			0x03,
			0x01,
			0x01,
			0x01,
			0x02, // path = [2]
			0x01,
			0x00, // index = 0
			...str('NEW'),
			0x01,
			0x01, // 1 property
			...str('prop'),
			0x01,
			0x05,
			0x01,
			0x07,
			0x00,
			0x00,
			0x00, // var Int 7
			0x00, // 0 children
		])
		const frame = decodeChangeFrame(bytes)
		assert.equal(frame.type, 'childAdded')
		assert.deepEqual(frame.path, [2])
		assert.equal(frame.index, 0)
		assert.equal(frame.subtree.type, 'NEW')
		assert.deepEqual([...frame.subtree.properties], [['prop', V.int(7)]])
		assert.equal(frame.subtree.children.length, 0)
	})

	test('rejects empty payload, unknown type and trailing bytes', () => {
		assert.equal(decodeChangeFrame(Buffer.alloc(0)), null)
		assert.equal(decodeChangeFrame(Buffer.from([0xff])), null)
		const ok = encodePropertyChanged([1], 'x', V.bool(true))
		assert.ok(decodeChangeFrame(ok))
		assert.equal(decodeChangeFrame(Buffer.concat([ok, Buffer.from([0])])), null)
		for (let len = 0; len < ok.length; len++)
			assert.equal(decodeChangeFrame(ok.subarray(0, len)), null, `truncated at ${len}`)
	})

	test('rejects a negative path count', () => {
		assert.equal(decodeChangeFrame(Buffer.from([0x01, 0x81, 0x01, ...str('x'), 0x01, 0x01, 0x02])), null)
	})
})

describe('change-frame encode', () => {
	test('round-trips propertyChanged (single, two-level, empty path)', () => {
		for (const [path, name, value] of [
			[[217], 'mixLevelWithAnchor', V.bool(true)],
			[[0, 7], 'faderLevel', V.int(75)],
			[[], 'rootProp', V.bool(false)],
			[[28], 'channelOutputMute', V.bool(true)],
			[[0], 'rootProperty', V.undefined()],
		]) {
			const bytes = encodePropertyChanged(path, name, value)
			assert.deepEqual(decodeChangeFrame(bytes), { type: 'propertyChanged', path, name, value })
		}
	})

	test('encodes the exact faderLevel preamble', () => {
		assert.deepEqual(
			encodePropertyChanged([0, 7], 'faderLevel', V.int(75)),
			Buffer.from([0x01, 0x01, 0x02, 0x00, 0x01, 0x07, ...str('faderLevel'), 0x01, 0x05, 0x01, 0x4b, 0x00, 0x00, 0x00]),
		)
	})

	test('fullSync round-trips via the encoder', () => {
		const root = new ValueTree('ROOT', {}, [new ValueTree('CHILD')])
		const payload = encodeFullSync(root)
		const frame = decodeChangeFrame(payload)
		assert.equal(frame.type, 'fullSync')
		assert.ok(frame.root.equals(root))
	})

	test('every record type round-trips through encodeChangeFrame', () => {
		const sub = new ValueTree('NEW', { prop: V.int(7) })
		const records = [
			{ type: 'propertyChanged', path: [1, 2], name: 'a', value: V.double(1.5) },
			{ type: 'propertyRemoved', path: [5], name: 'gone' },
			{ type: 'childAdded', path: [2], index: 0, subtree: sub },
			{ type: 'childRemoved', path: [2], oldIndex: 3 },
			{ type: 'childMoved', path: [2], oldIndex: 1, newIndex: 4 },
			{ type: 'fullSync', root: new ValueTree('R', { x: V.bool(true) }, [sub]) },
		]
		for (const record of records) {
			const bytes = encodeChangeFrame(record)
			const back = decodeChangeFrame(bytes)
			assert.ok(back, record.type)
			assert.equal(back.type, record.type)
			if (record.type === 'childAdded') assert.ok(back.subtree.equals(sub))
			else if (record.type === 'fullSync') assert.ok(back.root.equals(record.root))
			else assert.deepEqual(back, record)
		}
		assert.deepEqual(encodePropertyRemoved([5], 'gone'), Buffer.from([0x06, 0x01, 0x01, 0x01, 0x05, ...str('gone')]))
		assert.deepEqual(encodeChildRemoved([2], 3), Buffer.from([0x04, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03]))
		assert.deepEqual(encodeChildMoved([2], 1, 4), Buffer.from([0x05, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01, 0x04]))
		assert.equal(encodeChildAdded([2], 0, sub)[0], 0x03)
	})

	test('structural flag matches expectations', () => {
		const empty = new ValueTree('')
		assert.equal(isStructural({ type: 'propertyChanged', path: [], name: '', value: V.undefined() }), false)
		assert.equal(isStructural({ type: 'propertyRemoved', path: [], name: '' }), false)
		assert.equal(isStructural({ type: 'childAdded', path: [], index: 0, subtree: empty }), true)
		assert.equal(isStructural({ type: 'childRemoved', path: [], oldIndex: 0 }), true)
		assert.equal(isStructural({ type: 'childMoved', path: [], oldIndex: 0, newIndex: 0 }), true)
		assert.equal(isStructural({ type: 'fullSync', root: empty }), true)
	})
})
