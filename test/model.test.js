import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	RecordClock,
	defaultStripName,
	formatElapsed,
	formatMixLevel,
	levelToDbText,
	levelToFader,
	parseMixLevel,
	parseStripNames,
	recordStateLabel,
	UNITY_LEVEL,
} from '../src/model.js'

test('mix level string round trip keeps six decimals', () => {
	assert.deepEqual(parseMixLevel('0.708661|0.692913'), { level: 0.708661, anchor: 0.692913 })
	assert.equal(formatMixLevel(0.3, 0.708661), '0.300000|0.708661')
	assert.equal(formatMixLevel(2, -1), '1.000000|0.000000')
	assert.equal(parseMixLevel('garbage'), null)
	assert.equal(parseMixLevel(undefined), null)
})

test('fader units and dB readout', () => {
	assert.equal(levelToFader(UNITY_LEVEL), 90)
	assert.equal(levelToDbText(UNITY_LEVEL), '+0.0 dB')
	assert.equal(levelToDbText(0), '-inf dB')
	assert.equal(levelToDbText(UNITY_LEVEL / 2), '-6.0 dB')
})

test('strip names: defaults from source, overrides by position', () => {
	assert.equal(defaultStripName('combo1', 0), 'Mic 1')
	assert.equal(defaultStripName('usb1', 1), 'USB 1')
	assert.equal(defaultStripName(null, 5), 'Strip 6')
	assert.deepEqual(parseStripNames('Host, , Guest'), ['Host', '', 'Guest'])
	assert.deepEqual(parseStripNames(''), [])
})

test('record state labels and elapsed formatting', () => {
	assert.equal(recordStateLabel(2), 'Recording')
	assert.equal(recordStateLabel(3), 'No destination')
	assert.equal(formatElapsed(65), '01:05')
	assert.equal(formatElapsed(3725), '1:02:05')
})

test('record clock counts only while recording and survives pause', () => {
	let t = 0
	const clock = new RecordClock(() => t)
	clock.apply(0)
	assert.equal(clock.elapsedSeconds, 0)
	clock.apply(2)
	t = 4000
	assert.equal(clock.elapsedSeconds, 4)
	clock.apply(1)
	t = 9000
	assert.equal(clock.elapsedSeconds, 4)
	clock.apply(2)
	t = 12000
	assert.equal(clock.elapsedSeconds, 7)
	clock.apply(0)
	assert.equal(clock.elapsedSeconds, 0)
})
