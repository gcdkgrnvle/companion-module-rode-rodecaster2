import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	decodeChangeFrame,
	encodeFullSync,
	encodePropertyChanged,
	encodePropertyRemoved,
} from '../../src/protocol/change-frame.js'
import { encodeCommand } from '../../src/protocol/commands.js'
import { decodeEvent, decodeEventFromFrame, extractInitialState, parseMixLevel } from '../../src/protocol/events.js'
import { V } from '../../src/protocol/juce-var.js'
import { Layout } from '../../src/protocol/layout.js'
import { layout, minimalRootWith, n, nc, np, repeat } from './helpers.js'

const near = (a, b) => Math.abs(a - b) < 1e-4

describe('decodeEvent', () => {
	test('fader mute / cue / level', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.channelPath(2), 'channelOutputMute', V.bool(true)), l), {
			type: 'faderMuteChanged',
			fader: 'physical3',
			muted: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.channelPath(0), 'channelCueEnable', V.bool(false)), l), {
			type: 'faderCueChanged',
			fader: 'physical1',
			enabled: false,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.faderPath(1), 'faderLevel', V.int(99)), l), {
			type: 'faderLevelChanged',
			fader: 'physical2',
			level: 99,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.faderPath(0), 'faderLevel', V.int(500)), l), {
			type: 'faderLevelChanged',
			fader: 'physical1',
			level: 127,
		})
	})

	test('mix cell properties', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.mixCellPath(1, 5), 'mixDisabled', V.bool(true)), l), {
			type: 'mixDisabledChanged',
			source: 'combo2',
			mix: 'recording',
			disabled: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.mixCellPath(1, 5), 'mixMute', V.bool(false)), l), {
			type: 'mixMuteChanged',
			source: 'combo2',
			mix: 'recording',
			muted: false,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.mixCellPath(0, 1), 'mixLink', V.bool(true)), l), {
			type: 'mixLinkChanged',
			source: 'combo1',
			mix: 'headphone2',
			linked: true,
		})
		const level = decodeEvent(encodePropertyChanged(l.mixCellPath(0, 0), 'mixLevelWithAnchor', V.string('0.3|0.7')), l)
		assert.equal(level.type, 'mixLevelChanged')
		assert.equal(level.source, 'combo1')
		assert.equal(level.mix, 'headphone1')
		assert.ok(near(level.anchor, 0.3) && near(level.value, 0.7))
	})

	test('mix link request: direction from name, origin from trigger phase', () => {
		const l = layout()
		const path = l.mixCellPath(0, 0)
		const press = encodePropertyChanged(path, 'mixLinkRequest', V.binary([0x01, 0x01, 0x02, 0x01, 0x01, 0x02]))
		const release = encodePropertyChanged(path, 'mixLinkRequest', V.binary([0x01, 0x01, 0x03, 0x01, 0x01, 0x03]))
		assert.deepEqual(decodeEvent(press, l), {
			type: 'mixLinkRequested',
			source: 'combo1',
			mix: 'headphone1',
			direction: 'link',
			origin: 'press',
		})
		assert.deepEqual(decodeEvent(release, l), {
			type: 'mixLinkRequested',
			source: 'combo1',
			mix: 'headphone1',
			direction: 'link',
			origin: 'release',
		})
		const unlink = encodePropertyChanged(path, 'mixUnlinkRequest', V.binary([0x01, 0x01, 0x03, 0x01, 0x01, 0x02]))
		assert.deepEqual(decodeEvent(unlink, l), {
			type: 'mixLinkRequested',
			source: 'combo1',
			mix: 'headphone1',
			direction: 'unlink',
			origin: 'release',
		})
	})

	test('encoderSignal and encoderColour address the fader by raw index', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(encodePropertyChanged([1], 'encoderSignal', V.int(1)), l), {
			type: 'faderTouched',
			fader: 'physical2',
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([2], 'encoderColour', V.int(7)), l), {
			type: 'faderEncoderColourChanged',
			fader: 'physical3',
			colour: 7,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([0], 'encoderColour', V.int(-1)), l), {
			type: 'faderEncoderColourChanged',
			fader: 'physical1',
			colour: null,
		})
		// Past fader_count -> not a touch ([5] is a MIX cell, which does not claim encoderSignal).
		assert.equal(decodeEvent(encodePropertyChanged([5], 'encoderSignal', V.int(5)), l).type, 'unknown')
		// A CHANNEL path keeps its channel-param promotion, as in the Rust precedence.
		assert.equal(decodeEvent(encodePropertyChanged([3], 'encoderSignal', V.int(3)), l).type, 'channelParamChanged')
	})

	test('channelInputSource: stride-1 write path and stride-6 echo', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(encodePropertyChanged([l.firstChannel + 6 * 2], 'channelInputSource', V.int(7)), l), {
			type: 'faderAssignmentChanged',
			fader: 'physical3',
			source: 'usb1',
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([l.firstChannel], 'channelInputSource', V.int(-1)), l), {
			type: 'faderAssignmentChanged',
			fader: 'physical1',
			source: null,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged(l.channelPath(0), 'channelInputSource', V.int(5)), l), {
			type: 'faderAssignmentChanged',
			fader: 'physical1',
			source: 'combo23',
		})
	})

	test('unknown property preserves wire data; removed property has value null', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(encodePropertyChanged([0], 'futureProperty', V.int(42)), l), {
			type: 'unknown',
			propName: 'futureProperty',
			path: [0],
			value: V.int(42),
		})
		assert.deepEqual(decodeEvent(encodePropertyRemoved([0], 'futureProperty'), l), {
			type: 'unknown',
			propName: 'futureProperty',
			path: [0],
			value: null,
		})
		// A removed CHANNEL param is Unknown too (no value to promote).
		assert.equal(decodeEvent(encodePropertyRemoved(l.channelPath(0), 'eqOn'), l).type, 'unknown')
		assert.equal(decodeEvent(Buffer.from([0xff]), l), null)
	})

	test('typed param families resolve by path, Other names stay typed', () => {
		const l = layout()
		const cases = [
			[
				l.channelPath(2),
				'eqHighGain',
				V.double(6.0),
				{ type: 'channelParamChanged', fader: 'physical3', param: 'eqHighGain', value: V.double(6.0) },
			],
			[
				l.channelPath(0),
				'channelMysteryKnob',
				V.int(3),
				{ type: 'channelParamChanged', fader: 'physical1', param: 'channelMysteryKnob', value: V.int(3) },
			],
			[
				l.channelPath(1),
				'channelOutputMute',
				V.bool(true),
				{ type: 'faderMuteChanged', fader: 'physical2', muted: true },
			],
			[
				l.inputSourcePath(1),
				'inputPower',
				V.int(1),
				{ type: 'inputSourceParamChanged', source: 'combo2', param: 'inputPower', value: V.int(1) },
			],
			[
				l.inputSourcePath(0),
				'inputMysteryFlag',
				V.bool(true),
				{ type: 'inputSourceParamChanged', source: 'combo1', param: 'inputMysteryFlag', value: V.bool(true) },
			],
			[
				l.masterChannelPath(),
				'masterCompellorOn',
				V.bool(true),
				{ type: 'masterParamChanged', param: 'masterCompellorOn', value: V.bool(true) },
			],
			[
				l.masterChannelPath(),
				'masterMysteryFlag',
				V.int(2),
				{ type: 'masterParamChanged', param: 'masterMysteryFlag', value: V.int(2) },
			],
			[
				l.outputPath(),
				'outputMonLevel',
				V.double(0),
				{ type: 'outputParamChanged', param: 'outputMonLevel', value: V.double(0) },
			],
			[
				l.duckerPath(),
				'duckerDepth',
				V.double(-9),
				{ type: 'duckerParamChanged', param: 'duckerDepth', value: V.double(-9) },
			],
			[
				l.recorderPath(),
				'requestRecordState',
				V.int(3),
				{ type: 'recorderParamChanged', param: 'requestRecordState', value: V.int(3) },
			],
			[l.playerPath(), 'playerState', V.int(0), { type: 'playerParamChanged', param: 'playerState', value: V.int(0) }],
			[
				l.playerPath(),
				'playerMysteryFlag',
				V.int(7),
				{ type: 'playerParamChanged', param: 'playerMysteryFlag', value: V.int(7) },
			],
			[
				l.headphonePath(1),
				'headphoneColour',
				V.string('ffd43580'),
				{ type: 'headphoneParamChanged', headphone: 1, param: 'headphoneColour', value: V.string('ffd43580') },
			],
			[
				l.effectsPath(2),
				'reverbMix',
				V.double(0.4),
				{ type: 'effectsParamChanged', effects: 2, param: 'reverbMix', value: V.double(0.4) },
			],
			[
				l.effectsPath(0),
				'flangerOn',
				V.bool(true),
				{ type: 'effectsParamChanged', effects: 0, param: 'flangerOn', value: V.bool(true) },
			],
			[
				l.guiPath(),
				'screenBrightness',
				V.int(250),
				{ type: 'guiParamChanged', param: 'screenBrightness', value: V.int(250) },
			],
			[
				l.guiPath(),
				'mysteryGuiFlag',
				V.bool(true),
				{ type: 'guiParamChanged', param: 'mysteryGuiFlag', value: V.bool(true) },
			],
			[
				l.systemPath(),
				'systemFirmwareVersion',
				V.string('1.7.3'),
				{ type: 'systemParamChanged', param: 'systemFirmwareVersion', value: V.string('1.7.3') },
			],
			[
				l.systemPath(),
				'mysterySystemFlag',
				V.bool(true),
				{ type: 'systemParamChanged', param: 'mysterySystemFlag', value: V.bool(true) },
			],
			[
				l.padPath(2),
				'padColourIndex',
				V.int(7),
				{ type: 'padParamChanged', pad: 2, param: 'padColourIndex', value: V.int(7) },
			],
			[
				l.padPath(0),
				'padMysteryFlag',
				V.bool(true),
				{ type: 'padParamChanged', pad: 0, param: 'padMysteryFlag', value: V.bool(true) },
			],
		]
		for (const [path, name, value, expected] of cases) {
			assert.deepEqual(decodeEvent(encodePropertyChanged(path, name, value), l), expected, `${name} at ${path}`)
		}
	})

	test('PHYSICALINTERFACE hardware children and emergency mute', () => {
		const l = layout()
		const p = l.physicalInterfaceIdx
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 5], 'potLevel', V.int(200)), l), {
			type: 'potLevelChanged',
			pot: 5,
			level: 127,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 2], 'padButtonPressed', V.bool(true)), l), {
			type: 'padButtonPressed',
			button: 2,
			pressed: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 2], 'mutePressed', V.bool(false)), l), {
			type: 'mutePressed',
			button: 2,
			pressed: false,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 2], 'soloPressed', V.bool(true)), l), {
			type: 'soloPressed',
			button: 2,
			pressed: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 0], 'encoderPressed', V.bool(true)), l), {
			type: 'encoderPressed',
			encoder: 0,
			pressed: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([p, 9], 'recButtonPressed', V.bool(true)), l), {
			type: 'recButtonPressed',
			pressed: true,
		})
		assert.deepEqual(decodeEvent(encodePropertyChanged([0], 'emergencyMuteActive', V.bool(true)), l), {
			type: 'emergencyMuteChanged',
			active: true,
		})
		// potLevel accepts Int only (not int64).
		assert.equal(decodeEvent(encodePropertyChanged([p, 5], 'potLevel', V.int64(5)), l).type, 'unknown')
	})

	test('name-keyed families: network, recordings, storage, show, meter, small families', () => {
		const l = layout()
		const ev = (path, name, value) => decodeEvent(encodePropertyChanged(path, name, value), l)
		assert.deepEqual(ev([0], 'wifiSSID', V.string('x')), {
			type: 'networkParamChanged',
			param: 'wifiSSID',
			value: V.string('x'),
		})
		assert.deepEqual(ev([0], 'recordingTotalCount', V.int(3)), {
			type: 'recordingsParamChanged',
			param: 'recordingTotalCount',
			value: V.int(3),
		})
		assert.deepEqual(ev([9, 4], 'recordingUID', V.string('u')), {
			type: 'recordingParamChanged',
			recording: 4,
			param: 'recordingUID',
			value: V.string('u'),
		})
		assert.deepEqual(ev([9, 1], 'storageVolumeFree', V.int64(5)), {
			type: 'storageVolumeParamChanged',
			volume: 1,
			param: 'storageVolumeFree',
			value: V.int64(5),
		})
		assert.deepEqual(ev([0], 'audioSampleRate', V.int(48000)), {
			type: 'audioParamChanged',
			param: 'audioSampleRate',
			value: V.int(48000),
		})
		assert.deepEqual(ev([0], 'buildGuiVersion', V.string('v')), {
			type: 'buildParamChanged',
			param: 'buildGuiVersion',
			value: V.string('v'),
		})
		assert.deepEqual(ev([0], 'appRecording', V.bool(true)), {
			type: 'appParamChanged',
			param: 'appRecording',
			value: V.bool(true),
		})
		assert.deepEqual(ev([0], 'themeId', V.int(1)), { type: 'themeParamChanged', param: 'themeId', value: V.int(1) })
		assert.deepEqual(ev([0], 'currentShowName', V.string('s')), {
			type: 'currentShowParamChanged',
			param: 'currentShowName',
			value: V.string('s'),
		})
		assert.deepEqual(ev([0], 'showControlUpdating', V.bool(true)), {
			type: 'showControlParamChanged',
			param: 'showControlUpdating',
			value: V.bool(true),
		})
		assert.deepEqual(ev([9, 2], 'showName', V.string('s')), {
			type: 'showParamChanged',
			show: 2,
			param: 'showName',
			value: V.string('s'),
		})
		assert.deepEqual(ev([9, 3], 'meterPeakL', V.double(1)), {
			type: 'meterParamChanged',
			meter: 3,
			param: 'meterPeakL',
			value: V.double(1),
		})
		// faderLevel under PHYSICALINTERFACE but past the FADER run is not a meter.
		assert.equal(ev([l.physicalInterfaceIdx, 9], 'faderLevel', V.int(1)).type, 'unknown')
		assert.deepEqual(ev([7, 3], 'streamerXPresetName', V.string('p')), {
			type: 'streamerXMixPresetParamChanged',
			preset: 3,
			param: 'streamerXPresetName',
			value: V.string('p'),
		})
		assert.deepEqual(ev([0, 1, 2], 'streammixmixLevel', V.double(0.5)), {
			type: 'streamerXStreamMixParamChanged',
			stream: 2,
			param: 'streammixmixLevel',
			value: V.double(0.5),
		})
		assert.deepEqual(ev([5, 1], 'fxPresetIdx', V.int(1)), {
			type: 'fxPresetParamChanged',
			preset: 1,
			param: 'fxPresetIdx',
			value: V.int(1),
		})
		assert.deepEqual(ev([6], 'padRecordState', V.int(1)), {
			type: 'padRecorderParamChanged',
			padRecorder: 6,
			param: 'padRecordState',
			value: V.int(1),
		})
		assert.deepEqual(ev([0], 'allLEDSWhite', V.bool(true)), {
			type: 'testParamChanged',
			param: 'allLEDSWhite',
			value: V.bool(true),
		})
		assert.deepEqual(ev([3, 7], 'wifiScanResultSSID', V.string('n')), {
			type: 'wifiScanResultChanged',
			slot: 7,
			param: 'wifiScanResultSSID',
			value: V.string('n'),
		})
		assert.deepEqual(ev([0], 'radioPaired', V.bool(true)), {
			type: 'radioParamChanged',
			param: 'radioPaired',
			value: V.bool(true),
		})
		assert.deepEqual(ev([8], 'txBatteryLevel', V.int(90)), {
			type: 'radioTxParamChanged',
			tx: 8,
			param: 'txBatteryLevel',
			value: V.int(90),
		})
		assert.deepEqual(ev([8], 'rxRadioId', V.int(1)), {
			type: 'radioRxParamChanged',
			rx: 8,
			param: 'rxRadioId',
			value: V.int(1),
		})
	})

	test('SIP, mix-minuses and rcSync families resolve through the layout', () => {
		const l = Layout.fromFullSync(
			minimalRootWith([
				nc('SIPCALLING', [n('SIPREGISTRATION'), n('SIPREGISTRATION')]),
				n('SIPADVANCED'),
				n('SIPCALLSLOTS'),
				n('SIPCALLSLOTS'),
				n('MIXMINUSES'),
				n('RCSYNCMIX'),
			]),
		)
		const ev = (path, name, value) => decodeEvent(encodePropertyChanged(path, name, value), l)
		assert.deepEqual(ev(l.singletonPath('sipCalling'), 'sipRodeCode', V.string('c')), {
			type: 'sipCallingParamChanged',
			param: 'sipRodeCode',
			value: V.string('c'),
		})
		assert.deepEqual(ev(l.singletonPath('sipAdvanced'), 'autoReconnect', V.bool(true)), {
			type: 'sipAdvancedParamChanged',
			param: 'autoReconnect',
			value: V.bool(true),
		})
		assert.deepEqual(ev(l.runPath('sipRegistration', 1), 'sipRegistrationIsRegistered', V.bool(true)), {
			type: 'sipRegistrationParamChanged',
			registration: 1,
			param: 'sipRegistrationIsRegistered',
			value: V.bool(true),
		})
		assert.deepEqual(ev(l.runPath('sipCallSlots', 1), 'sipSlotCallState', V.int(2)), {
			type: 'sipCallSlotsParamChanged',
			slot: 1,
			param: 'sipSlotCallState',
			value: V.int(2),
		})
		assert.deepEqual(ev(l.runPath('mixMinuses', 0), 'outputMixMinus', V.bool(true)), {
			type: 'mixMinusesParamChanged',
			minuses: 0,
			param: 'outputMixMinus',
			value: V.bool(true),
		})
		assert.deepEqual(ev(l.runPath('rcsyncMix', 0), 'mixMute', V.bool(true)), {
			type: 'rcSyncMixParamChanged',
			mix: 0,
			param: 'mixMute',
			value: V.bool(true),
		})
	})

	test('structural change yields layoutInvalidated; decodeEventFromFrame matches decodeEvent', () => {
		const l = layout()
		assert.deepEqual(decodeEvent(Buffer.from([0x04, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03]), l), {
			type: 'layoutInvalidated',
		})
		const payload = encodePropertyChanged(l.channelPath(0), 'channelOutputMute', V.bool(true))
		assert.deepEqual(decodeEventFromFrame(decodeChangeFrame(payload), l), decodeEvent(payload, l))
	})

	test('parseMixLevel', () => {
		assert.deepEqual(parseMixLevel('0.5|0.8'), { anchor: 0.5, value: 0.8 })
		assert.deepEqual(parseMixLevel('0.25'), { anchor: 0.25, value: 0.25 })
		assert.deepEqual(parseMixLevel('-1.5|2'), { anchor: -1.5, value: 2 })
		assert.equal(parseMixLevel('x|1'), null)
		assert.equal(parseMixLevel(''), null)
		assert.equal(parseMixLevel('1|'), null)
	})
})

describe('round trips through commands', () => {
	test('every command decodes back to the matching event', () => {
		const l = layout()
		const rt = (cmd) => encodeCommand(cmd, l).map((b) => decodeEvent(b, l))
		assert.deepEqual(rt({ type: 'setFaderMute', fader: 'physical2', mute: true }), [
			{ type: 'faderMuteChanged', fader: 'physical2', muted: true },
		])
		assert.deepEqual(rt({ type: 'setFaderCue', fader: 'physical1', enable: true }), [
			{ type: 'faderCueChanged', fader: 'physical1', enabled: true },
		])
		assert.deepEqual(rt({ type: 'setFaderLevel', fader: 'physical3', level: 100 }), [
			{ type: 'faderLevelChanged', fader: 'physical3', level: 100 },
		])
		assert.deepEqual(rt({ type: 'setMixDisabled', source: 'combo2', mix: 'usb1', disabled: true }), [
			{ type: 'mixDisabledChanged', source: 'combo2', mix: 'usb1', disabled: true },
		])
		const [lvl] = rt({ type: 'setMixLevel', source: 'combo2', mix: 'usb1', anchor: 0.5, value: 0.8 })
		assert.equal(lvl.type, 'mixLevelChanged')
		assert.ok(near(lvl.anchor, 0.5) && near(lvl.value, 0.8))
		assert.deepEqual(rt({ type: 'linkMix', source: 'combo1', mix: 'speaker' }), [
			{ type: 'mixDisabledChanged', source: 'combo1', mix: 'speaker', disabled: false },
			{ type: 'mixMuteChanged', source: 'combo1', mix: 'speaker', muted: false },
			{ type: 'mixLinkRequested', source: 'combo1', mix: 'speaker', direction: 'link', origin: 'press' },
		])
		assert.deepEqual(rt({ type: 'unlinkMix', source: 'combo1', mix: 'speaker' }), [
			{ type: 'mixLinkRequested', source: 'combo1', mix: 'speaker', direction: 'unlink', origin: 'press' },
		])
		for (const [param, value] of [
			['eqOn', V.bool(true)],
			['compressorRatio', V.int(4)],
			['hpfFrequency', V.double(80)],
			['channelCustomLabel', V.string('xlr')],
			['channelMysteryKnob', V.int(3)],
		]) {
			assert.deepEqual(rt({ type: 'setChannelParam', fader: 'physical1', param, value }), [
				{ type: 'channelParamChanged', fader: 'physical1', param, value },
			])
		}
		for (const [param, value] of [
			['inputPower', V.int(1)],
			['inputPhaseFlip', V.bool(true)],
			['inputWirelessSN', V.string('SN12345')],
			['inputMysteryFlag', V.int(7)],
		]) {
			assert.deepEqual(rt({ type: 'setInputSourceParam', source: 'combo1', param, value }), [
				{ type: 'inputSourceParamChanged', source: 'combo1', param, value },
			])
		}
		assert.deepEqual(rt({ type: 'setMasterParam', param: 'masterDelaySeconds', value: V.double(0.25) }), [
			{ type: 'masterParamChanged', param: 'masterDelaySeconds', value: V.double(0.25) },
		])
		assert.deepEqual(rt({ type: 'setOutputParam', param: 'outputMultiMode', value: V.int(5) }), [
			{ type: 'outputParamChanged', param: 'outputMultiMode', value: V.int(5) },
		])
		assert.deepEqual(rt({ type: 'setHeadphoneParam', headphone: 1, param: 'headphoneMystery', value: V.bool(true) }), [
			{ type: 'headphoneParamChanged', headphone: 1, param: 'headphoneMystery', value: V.bool(true) },
		])
		assert.deepEqual(rt({ type: 'setEffectsParam', effects: 2, param: 'pitchShiftSemitones', value: V.int(-3) }), [
			{ type: 'effectsParamChanged', effects: 2, param: 'pitchShiftSemitones', value: V.int(-3) },
		])
		assert.deepEqual(rt({ type: 'setGuiParam', param: 'lang', value: V.string('en') }), [
			{ type: 'guiParamChanged', param: 'lang', value: V.string('en') },
		])
		assert.deepEqual(rt({ type: 'setPadParam', pad: 1, param: 'padGain', value: V.double(0.5) }), [
			{ type: 'padParamChanged', pad: 1, param: 'padGain', value: V.double(0.5) },
		])
		assert.deepEqual(rt({ type: 'setSystemParam', param: 'updateViaUSB', value: V.bool(true) }), [
			{ type: 'systemParamChanged', param: 'updateViaUSB', value: V.bool(true) },
		])
	})

	test('decoding A bytes under B layout does not resolve the same way', () => {
		const phys = () => nc('PHYSICALINTERFACE', [n('FADER'), n('FADER')])
		const a = Layout.fromFullSync(
			nc('DEVICE', [phys(), n('X'), n('Y'), n('Z'), n('CHANNEL'), n('CHANNEL'), ...repeat(13, 'MIX')]),
		)
		const b = Layout.fromFullSync(
			nc('DEVICE', [
				phys(),
				n('X'),
				n('Y'),
				n('Z'),
				n('W1'),
				n('W2'),
				n('W3'),
				n('CHANNEL'),
				n('CHANNEL'),
				...repeat(13, 'MIX'),
			]),
		)
		const cmd = { type: 'setFaderMute', fader: 'physical1', mute: true }
		const ea = encodeCommand(cmd, a)
		const eb = encodeCommand(cmd, b)
		const expected = { type: 'faderMuteChanged', fader: 'physical1', muted: true }
		assert.deepEqual(decodeEvent(ea[0], a), expected)
		assert.deepEqual(decodeEvent(eb[0], b), expected)
		assert.notDeepEqual(decodeEvent(ea[0], b), expected)
	})
})

describe('extractInitialState', () => {
	test('fader levels, mutes, cues and mix levels in order', () => {
		const phys = nc('PHYSICALINTERFACE', [
			np('FADER', { faderLevel: V.int(64) }),
			np('FADER', { faderLevel: V.int(100) }),
		])
		const children = [
			phys,
			np('CHANNEL', { channelOutputMute: V.bool(false), channelCueEnable: V.bool(true) }),
			np('CHANNEL', { channelOutputMute: V.bool(true) }),
		]
		for (let i = 0; i < 13; i++)
			children.push(np('MIX', { mixLevelWithAnchor: V.string(`0.5|${(0.1 * i).toFixed(1)}`) }))
		const root = nc('DEVICE', children)
		const events = extractInitialState(root, Layout.fromFullSync(root))
		assert.equal(events.length, 18)
		assert.deepEqual(events[0], { type: 'faderLevelChanged', fader: 'physical1', level: 64 })
		assert.deepEqual(events[1], { type: 'faderLevelChanged', fader: 'physical2', level: 100 })
		assert.deepEqual(events[2], { type: 'faderMuteChanged', fader: 'physical1', muted: false })
		assert.deepEqual(events[3], { type: 'faderCueChanged', fader: 'physical1', enabled: true })
		assert.deepEqual(events[4], { type: 'faderMuteChanged', fader: 'physical2', muted: true })
		assert.equal(events[17].type, 'mixLevelChanged')
		assert.equal(events[17].source, 'combo1')
		assert.equal(events[17].mix, 'callme3')
	})

	test('fullSync through decodeEvent yields initialState', () => {
		const phys = nc('PHYSICALINTERFACE', [
			n('HEADER'),
			np('FADER', { faderLevel: V.int(50) }),
			np('FADER', { faderLevel: V.int(60) }),
			np('FADER', { faderLevel: V.int(70) }),
			n('FOOTER'),
		])
		const children = [
			n('OTHER1'),
			n('OTHER2'),
			phys,
			n('OTHER3'),
			np('CHANNEL', { channelOutputMute: V.bool(false), channelCueEnable: V.bool(false) }),
			np('CHANNEL', { channelOutputMute: V.bool(true) }),
			np('CHANNEL', { channelOutputMute: V.bool(false) }),
			n('OTHER4'),
		]
		for (let i = 0; i < 26; i++) children.push(np('MIX', { mixLevelWithAnchor: V.string(`0.5|${0.1 * (i % 13)}`) }))
		children.push(
			...repeat(19, 'INPUTSOURCE'),
			n('MASTERCHANNEL'),
			n('OUTPUT'),
			n('DUCKER'),
			n('RECORDER'),
			n('PLAYER'),
			n('HEADPHONE'),
			n('HEADPHONE'),
			n('EFFECTS_PARAMETERS'),
			n('EFFECTS_PARAMETERS'),
			n('EFFECTS_PARAMETERS'),
			n('GUI'),
			nc('SOUNDPADS', [n('PAD'), n('PAD')]),
			n('SYSTEM'),
		)
		const root = nc('DEVICE', children)
		const l = Layout.fromFullSync(root)
		const event = decodeEvent(encodeFullSync(root), l)
		assert.equal(event.type, 'initialState')
		// 3 fader levels + 3 mute + 1 cue + 26 mix levels = 33 events.
		assert.equal(event.events.length, 33)
		assert.deepEqual(event.events.slice(0, 3), [
			{ type: 'faderLevelChanged', fader: 'physical1', level: 50 },
			{ type: 'faderLevelChanged', fader: 'physical2', level: 60 },
			{ type: 'faderLevelChanged', fader: 'physical3', level: 70 },
		])
	})

	test('includes every typed family with its ordinal', () => {
		const root = minimalRootWith([
			np('INPUTSOURCE', { inputId: V.int(0), inputPower: V.int(1) }),
			np('INPUTSOURCE', { inputMicrophoneGain: V.int(50) }),
			np('MASTERCHANNEL', { masterCompellorOn: V.bool(true), masterDelaySeconds: V.double(0) }),
			np('OUTPUT', { outputMonLevel: V.double(0), outputMysteryFlag: V.int(9) }),
			np('DUCKER', { duckerDepth: V.double(-9) }),
			np('RECORDER', { recordState: V.int(0) }),
			np('PLAYER', { playerState: V.int(0) }),
			np('HEADPHONE', { headphoneType: V.int(0) }),
			np('HEADPHONE', { headphoneColour: V.string('ffd43580') }),
			np('EFFECTS_PARAMETERS', { effectsIdx: V.int(0), reverbOn: V.bool(true) }),
			np('EFFECTS_PARAMETERS', { echoMix: V.double(0.25) }),
			n('GAP'),
			np('EFFECTS_PARAMETERS', { echoMix: V.double(0.75) }), // second run: not addressable
			np('GUI', { lang: V.string('en'), screenBrightness: V.int(250), eqParamModeLow: V.int(0) }),
			nc('SOUNDPADS', [
				np('PAD', { padIdx: V.int(0), padName: V.string('Applause') }),
				np('PAD', { padIdx: V.int(1), padColourIndex: V.int(7) }),
				n('OTHER'),
				np('PAD', { padIdx: V.int(2) }),
			]),
			np('SYSTEM', {
				boardType: V.int(0),
				systemFirmwareVersion: V.string('1.7.3'),
				lastRecordingID: V.int(42),
				powerOffRequest: V.bool(false),
			}),
		])
		root.children[1].properties.set('channelOutputMute', V.bool(false))
		root.children[1].properties.set('eqOn', V.bool(true))
		root.children[1].properties.set('compressorThreshold', V.double(-18))
		root.children[1].properties.set('channelInputSource', V.int(7))
		const events = extractInitialState(root, Layout.fromFullSync(root))
		const has = (e) =>
			assert.ok(
				events.some((x) => {
					try {
						assert.deepEqual(x, e)
						return true
					} catch {
						return false
					}
				}),
				JSON.stringify(e),
			)
		has({ type: 'faderMuteChanged', fader: 'physical1', muted: false })
		has({ type: 'faderAssignmentChanged', fader: 'physical1', source: 'usb1' })
		has({ type: 'channelParamChanged', fader: 'physical1', param: 'eqOn', value: V.bool(true) })
		has({ type: 'channelParamChanged', fader: 'physical1', param: 'compressorThreshold', value: V.double(-18) })
		has({ type: 'inputSourceParamChanged', source: 'combo1', param: 'inputId', value: V.int(0) })
		has({ type: 'inputSourceParamChanged', source: 'combo2', param: 'inputMicrophoneGain', value: V.int(50) })
		has({ type: 'masterParamChanged', param: 'masterCompellorOn', value: V.bool(true) })
		has({ type: 'outputParamChanged', param: 'outputMysteryFlag', value: V.int(9) })
		has({ type: 'duckerParamChanged', param: 'duckerDepth', value: V.double(-9) })
		has({ type: 'recorderParamChanged', param: 'recordState', value: V.int(0) })
		has({ type: 'playerParamChanged', param: 'playerState', value: V.int(0) })
		has({ type: 'headphoneParamChanged', headphone: 0, param: 'headphoneType', value: V.int(0) })
		has({ type: 'headphoneParamChanged', headphone: 1, param: 'headphoneColour', value: V.string('ffd43580') })
		has({ type: 'effectsParamChanged', effects: 0, param: 'effectsIdx', value: V.int(0) })
		has({ type: 'effectsParamChanged', effects: 1, param: 'echoMix', value: V.double(0.25) })
		assert.ok(
			!events.some((e) => e.type === 'effectsParamChanged' && e.effects === 2),
			'second EFFECTS run is not addressable',
		)
		has({ type: 'guiParamChanged', param: 'eqParamModeLow', value: V.int(0) })
		has({ type: 'padParamChanged', pad: 0, param: 'padName', value: V.string('Applause') })
		has({ type: 'padParamChanged', pad: 1, param: 'padColourIndex', value: V.int(7) })
		assert.ok(
			!events.some((e) => e.type === 'padParamChanged' && e.pad === 2),
			'PAD after a non-PAD sibling is not addressable',
		)
		has({ type: 'systemParamChanged', param: 'boardType', value: V.int(0) })
		has({ type: 'systemParamChanged', param: 'lastRecordingID', value: V.int(42) })
		has({ type: 'systemParamChanged', param: 'powerOffRequest', value: V.bool(false) })
	})
})
