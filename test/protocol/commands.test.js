import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decodeChangeFrame } from '../../src/protocol/change-frame.js'
import {
	CHANNEL_INPUT_SOURCE_UNASSIGNED,
	encodeCommand,
	EncodeError,
	formatMixLevel,
} from '../../src/protocol/commands.js'
import { V } from '../../src/protocol/juce-var.js'
import { Layout } from '../../src/protocol/layout.js'
import { PRESS_BYTES } from '../../src/protocol/trigger.js'
import { layout, minimalLayout, minimalRootWith, n, nc, repeat } from './helpers.js'

const str = (s) => [...Buffer.from(s), 0x00]
const PRESS_VAR = [0x01, 0x07, 0x08, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02]

function decodeSingleProp(bytes) {
	const f = decodeChangeFrame(bytes)
	assert.equal(f?.type, 'propertyChanged')
	return f
}

describe('encodeCommand', () => {
	test('setFaderMute encodes a JUCE propertyChanged on the CHANNEL path', () => {
		const l = layout() // Pro II (empty SYSTEM node): physical2 -> index 1
		const bytes = encodeCommand({ type: 'setFaderMute', fader: 'physical2', mute: true }, l)
		assert.equal(bytes.length, 1)
		const f = decodeSingleProp(bytes[0])
		assert.deepEqual(f.path, l.channelPath(1))
		assert.equal(f.name, 'channelOutputMute')
		assert.deepEqual(f.value, V.bool(true))
	})

	test('setFaderCue', () => {
		const f = decodeSingleProp(encodeCommand({ type: 'setFaderCue', fader: 'physical1', enable: true }, layout())[0])
		assert.deepEqual(f.path, [2])
		assert.equal(f.name, 'channelCueEnable')
		assert.deepEqual(f.value, V.bool(true))
	})

	test('setFaderLevel uses the two-level path through PHYSICALINTERFACE', () => {
		const f = decodeSingleProp(encodeCommand({ type: 'setFaderLevel', fader: 'physical3', level: 75 }, layout())[0])
		assert.deepEqual(f.path, [1, 3])
		assert.equal(f.name, 'faderLevel')
		assert.deepEqual(f.value, V.int(75))
	})

	test('assignFaderSource with a source and with null', () => {
		const l = layout()
		const some = decodeSingleProp(
			encodeCommand({ type: 'assignFaderSource', fader: 'physical1', source: 'combo23' }, l)[0],
		)
		assert.equal(some.name, 'channelInputSource')
		assert.deepEqual(some.value, V.int(5))
		const none = decodeSingleProp(encodeCommand({ type: 'assignFaderSource', fader: 'physical1', source: null }, l)[0])
		assert.deepEqual(none.value, V.int(CHANNEL_INPUT_SOURCE_UNASSIGNED))
		assert.deepEqual(none.value, V.int(-1))
	})

	test('mix cell commands address the source-major cell', () => {
		const l = layout()
		const disabled = decodeSingleProp(
			encodeCommand({ type: 'setMixDisabled', source: 'combo2', mix: 'recording', disabled: true }, l)[0],
		)
		assert.deepEqual(disabled.path, l.mixCellPath(1, 5))
		assert.equal(disabled.name, 'mixDisabled')
		assert.deepEqual(disabled.value, V.bool(true))
		const mute = decodeSingleProp(
			encodeCommand({ type: 'setMixMute', source: 'combo2', mix: 'recording', mute: true }, l)[0],
		)
		assert.deepEqual(mute.path, l.mixCellPath(1, 5))
		assert.equal(mute.name, 'mixMute')
		const level = decodeSingleProp(
			encodeCommand({ type: 'setMixLevel', source: 'combo2', mix: 'recording', anchor: 0.4, value: 0.9 }, l)[0],
		)
		assert.deepEqual(level.path, l.mixCellPath(1, 5))
		assert.equal(level.name, 'mixLevelWithAnchor')
		assert.deepEqual(level.value, V.string('0.4|0.9'))
		assert.equal(formatMixLevel(0.5, 0.8), '0.5|0.8')
		assert.equal(formatMixLevel(1, 0), '1.0|0.0')
	})

	test('linkMix emits enable + unmute + trigger; unlinkMix a single trigger', () => {
		const l = layout()
		const link = encodeCommand({ type: 'linkMix', source: 'combo1', mix: 'headphone4' }, l)
		assert.equal(link.length, 3)
		const expect = [
			['mixDisabled', V.bool(false)],
			['mixMute', V.bool(false)],
			['mixLinkRequest', V.binary(PRESS_BYTES)],
		]
		link.forEach((raw, i) => {
			const f = decodeSingleProp(raw)
			assert.deepEqual(f.path, l.mixCellPath(0, 3))
			assert.equal(f.name, expect[i][0])
			assert.deepEqual(f.value, expect[i][1])
		})
		const unlink = encodeCommand({ type: 'unlinkMix', source: 'combo1', mix: 'headphone4' }, l)
		assert.equal(unlink.length, 1)
		const f = decodeSingleProp(unlink[0])
		assert.equal(f.name, 'mixUnlinkRequest')
		assert.deepEqual(f.value, V.binary([0x01, 0x01, 0x02, 0x01, 0x01, 0x02]))
	})

	test('param commands carry the caller name and value (typed or raw)', () => {
		const l = layout()
		const cases = [
			[{ type: 'setChannelParam', fader: 'physical3', param: 'eqHighGain', value: V.double(6.0) }, l.channelPath(2)],
			[{ type: 'setChannelParam', fader: 'physical1', param: 'channelMysteryKnob', value: V.int(3) }, l.channelPath(0)],
			[{ type: 'setInputSourceParam', source: 'combo2', param: 'inputPower', value: V.int(1) }, l.inputSourcePath(1)],
			[
				{ type: 'setInputSourceParam', source: 'combo1', param: 'inputMysteryFlag', value: V.bool(true) },
				l.inputSourcePath(0),
			],
			[{ type: 'setMasterParam', param: 'masterCompellorThreshold', value: V.double(0.67) }, l.masterChannelPath()],
			[{ type: 'setMasterParam', param: 'masterMysteryKnob', value: V.int(7) }, l.masterChannelPath()],
			[{ type: 'setOutputParam', param: 'outputMonMute', value: V.bool(true) }, l.outputPath()],
			[{ type: 'setDuckerParam', param: 'duckerDepth', value: V.double(-12.0) }, l.duckerPath()],
			[{ type: 'setRecorderParam', param: 'requestRecordState', value: V.int(1) }, l.recorderPath()],
			[{ type: 'setPlayerParam', param: 'playerSpeed', value: V.int(0) }, l.playerPath()],
			[{ type: 'setHeadphoneParam', headphone: 1, param: 'headphoneType', value: V.int(2) }, l.headphonePath(1)],
			[{ type: 'setEffectsParam', effects: 2, param: 'reverbMix', value: V.double(0.4) }, l.effectsPath(2)],
			[{ type: 'setGuiParam', param: 'screenBrightness', value: V.int(250) }, l.guiPath()],
			[{ type: 'setGuiParam', param: 'mysteryGuiFlag', value: V.bool(true) }, l.guiPath()],
			[{ type: 'setSystemParam', param: 'updateViaUSB', value: V.bool(true) }, l.systemPath()],
			[{ type: 'setSystemParam', param: 'mysterySystemFlag', value: V.int(7) }, l.systemPath()],
			[{ type: 'setPadParam', pad: 2, param: 'padColourIndex', value: V.int(7) }, l.padPath(2)],
			[{ type: 'setPadParam', pad: 0, param: 'padMysteryFlag', value: V.bool(true) }, l.padPath(0)],
		]
		for (const [cmd, path] of cases) {
			const bytes = encodeCommand(cmd, l)
			assert.equal(bytes.length, 1, cmd.type)
			const f = decodeSingleProp(bytes[0])
			assert.deepEqual(f.path, path, cmd.type)
			assert.equal(f.name, cmd.param)
			assert.deepEqual(f.value, cmd.value)
		}
	})

	test('out-of-range indices return errors, never throw TypeErrors', () => {
		const l = layout()
		const expectOutOfRange = (cmd, what, index, bound) => {
			assert.throws(
				() => encodeCommand(cmd, l),
				(e) =>
					e instanceof EncodeError &&
					e.code === 'outOfRange' &&
					e.what === what &&
					e.index === index &&
					(bound === undefined || e.bound === bound),
				cmd.type,
			)
		}
		expectOutOfRange(
			{ type: 'setHeadphoneParam', headphone: 5, param: 'headphoneColour', value: V.string('ffffffff') },
			'headphone',
			5,
			2,
		)
		expectOutOfRange({ type: 'setEffectsParam', effects: 7, param: 'echoMix', value: V.double(0.1) }, 'effects', 7, 3)
		expectOutOfRange({ type: 'setPadParam', pad: 9, param: 'padGain', value: V.double(0.5) }, 'pad', 9, 3)
		// virtual1 (index 6) resolves past the synthetic layout's 3 channels.
		expectOutOfRange({ type: 'setChannelParam', fader: 'virtual1', param: 'eqOn', value: V.bool(true) }, 'fader', 6)
		expectOutOfRange({ type: 'setFaderMute', fader: 'virtual1', mute: true }, 'fader', 6)
		// No INPUTSOURCE run: bound 0.
		assert.throws(
			() =>
				encodeCommand(
					{ type: 'setInputSourceParam', source: 'combo1', param: 'inputPower', value: V.int(1) },
					minimalLayout(),
				),
			(e) => e.code === 'outOfRange' && e.what === 'input source' && e.bound === 0,
		)
	})

	test('fader not on model', () => {
		assert.throws(
			() => encodeCommand({ type: 'setFaderMute', fader: 'virtual4', mute: true }, layout()),
			(e) => e instanceof EncodeError && e.code === 'faderNotOnModel' && e.fader === 'virtual4' && e.model === 'pro2',
		)
	})

	test('mix cell out of range (CallMe source past the matrix)', () => {
		assert.throws(
			() => encodeCommand({ type: 'setMixDisabled', source: 'callme1', mix: 'headphone1', disabled: true }, layout()),
			(e) => e.code === 'mixCellOutOfRange' && e.source === 16 && e.sourceBound === 2 && e.mixBound === 13,
		)
	})

	test('absent singletons return missingNode', () => {
		const l = minimalLayout()
		const expectMissing = (cmd, what) =>
			assert.throws(
				() => encodeCommand(cmd, l),
				(e) => e.code === 'missingNode' && e.what === what,
				cmd.type,
			)
		expectMissing({ type: 'setMasterParam', param: 'masterCompellorOn', value: V.bool(true) }, 'MASTERCHANNEL')
		expectMissing({ type: 'setOutputParam', param: 'outputMonMute', value: V.bool(true) }, 'OUTPUT')
		expectMissing({ type: 'setGuiParam', param: 'screenBrightness', value: V.int(250) }, 'GUI')
		expectMissing({ type: 'setSystemParam', param: 'powerOffRequest', value: V.bool(true) }, 'SYSTEM')
		expectMissing({ type: 'setDuckerParam', param: 'duckerDepth', value: V.double(-9) }, 'DUCKER')
		expectMissing({ type: 'setRecorderParam', param: 'recordState', value: V.int(0) }, 'RECORDER')
		expectMissing({ type: 'setPlayerParam', param: 'playerState', value: V.int(0) }, 'PLAYER')
		expectMissing({ type: 'powerOff' }, 'SYSTEM')
		expectMissing({ type: 'setShowParam', show: 0, param: 'showName', value: V.string('x') }, 'SHOW')
	})

	test('encoding depends on layout, not constants', () => {
		const phys = () => nc('PHYSICALINTERFACE', [n('FADER'), n('FADER')])
		const a = Layout.fromFullSync(
			nc('DEVICE', [phys(), n('X'), n('Y'), n('CHANNEL'), n('CHANNEL'), ...repeat(13, 'MIX')]),
		)
		const b = Layout.fromFullSync(
			nc('DEVICE', [phys(), n('X'), n('Y'), n('Z'), n('W'), n('CHANNEL'), n('CHANNEL'), ...repeat(13, 'MIX')]),
		)
		const cmd = { type: 'setFaderMute', fader: 'physical1', mute: true }
		const ea = encodeCommand(cmd, a)
		const eb = encodeCommand(cmd, b)
		assert.notDeepEqual(ea, eb)
		assert.deepEqual(decodeSingleProp(ea[0]).path, [3])
		assert.deepEqual(decodeSingleProp(eb[0]).path, [5])
	})

	// Frozen wire-byte goldens from the Rust tests.

	test('screenTouched golden bytes', () => {
		const bytes = encodeCommand({ type: 'screenTouched' }, layout())
		assert.equal(bytes.length, 1)
		assert.deepEqual(bytes[0], Buffer.from([0x01, 0x01, 0x01, 0x01, ...str('screenTouched')]))
	})

	test('powerOff golden bytes', () => {
		const l = layout()
		const sysIdx = l.systemPath()[0]
		const bytes = encodeCommand({ type: 'powerOff' }, l)
		assert.deepEqual(
			bytes[0],
			Buffer.from([0x01, 0x01, 0x01, 0x01, sysIdx, ...str('powerOffRequest'), 0x01, 0x01, 0x02]),
		)
	})

	test('linkCallMe golden bytes', () => {
		// callme1 = source 16, headphone1 = mix 0: path[0] = (16<<8)|(4+0) = 4100 -> `02 04 10`.
		const bytes = encodeCommand({ type: 'linkCallMe', source: 'callme1', mix: 'headphone1' }, layout())
		assert.deepEqual(
			bytes[0],
			Buffer.from([0x01, 0x01, 0x01, 0x02, 0x04, 0x10, ...str('mixLinkRequest'), ...PRESS_VAR]),
		)
	})

	test('unlinkCallMe golden bytes', () => {
		// callme2 = 17, headphone3 = 2: (17<<8)|(4+2) = 4358 -> `02 06 11`.
		const bytes = encodeCommand({ type: 'unlinkCallMe', source: 'callme2', mix: 'headphone3' }, layout())
		assert.deepEqual(
			bytes[0],
			Buffer.from([0x01, 0x01, 0x01, 0x02, 0x06, 0x11, ...str('mixUnlinkRequest'), ...PRESS_VAR]),
		)
	})

	test('setFaderMute golden bytes on the Pro II synthetic layout', () => {
		// channel index 1 lives at root child 3 in syntheticRoot.
		const bytes = encodeCommand({ type: 'setFaderMute', fader: 'physical2', mute: true }, layout())
		assert.deepEqual(
			bytes[0],
			Buffer.from([0x01, 0x01, 0x01, 0x01, 0x03, ...str('channelOutputMute'), 0x01, 0x01, 0x02]),
		)
	})

	test('remaining param families encode cleanly', () => {
		const l = Layout.fromFullSync(
			minimalRootWith([
				n('NETWORK'),
				n('AUDIO'),
				n('BUILD'),
				n('APP'),
				n('THEME'),
				n('CURRENTSHOW'),
				n('SHOWCONTROL'),
				n('RADIO'),
				// RECORDINGS is both the singleton and the container of RECORDING children (as on real firmware).
				nc('SHOWS', [n('SHOW')]),
				nc('RECORDINGS', [n('RECORDING')]),
				n('STORAGEVOLUME'),
				n('RADIOTX'),
				n('RADIORX'),
				n('WIFISCANRESULT'),
				n('STREAMERXMIXPRESET'),
				n('STREAMERXSTREAMMIX'),
				n('RCSYNCMIX'),
				n('MIXMINUSES'),
				n('TEST'),
				n('SIPCALLING'),
				n('SIPADVANCED'),
				n('SIPCALLSLOTS'),
				n('PADRECORDER'),
				nc('FXPRESETS', [n('FXPRESET')]),
			]),
		)
		const cmds = [
			{ type: 'setNetworkParam', param: 'btVisible', value: V.bool(true) },
			{ type: 'setAudioParam', param: 'audioSampleRate', value: V.int(48000) },
			{ type: 'setBuildParam', param: 'buildGuiVersion', value: V.string('x') },
			{ type: 'setAppParam', param: 'appRecording', value: V.bool(false) },
			{ type: 'setThemeParam', param: 'themeId', value: V.int(1) },
			{ type: 'setCurrentShowParam', param: 'currentShowName', value: V.string('s') },
			{ type: 'setShowControlParam', param: 'showControlNewFromDefaultMuted', value: V.bool(true) },
			{ type: 'setRecordingsParam', param: 'recordingTotalCount', value: V.int(0) },
			{ type: 'setRadioParam', param: 'radioPair', value: V.bool(true) },
			{ type: 'setShowParam', show: 0, param: 'showName', value: V.string('Test') },
			{ type: 'setRecordingParam', recording: 0, param: 'recordingUID', value: V.string('u') },
			{ type: 'setStorageVolumeParam', volume: 0, param: 'storageVolumeEject', value: V.bool(true) },
			{ type: 'setRadioTxParam', tx: 0, param: 'txRecord', value: V.bool(true) },
			{ type: 'setRadioRxParam', rx: 0, param: 'rxRadioId', value: V.int(1) },
			{ type: 'setWifiScanResultParam', slot: 0, param: 'wifiScanResultSSID', value: V.string('x') },
			{ type: 'setStreamerXMixPresetParam', preset: 0, param: 'streamerXPresetName', value: V.string('p') },
			{ type: 'setStreamerXStreamMixParam', stream: 0, param: 'streammixmixLevel', value: V.double(0.5) },
			{ type: 'setRcSyncMixParam', mix: 0, param: 'mixMute', value: V.bool(true) },
			{ type: 'setMixMinusesParam', minuses: 0, param: 'outputMixMinus', value: V.bool(true) },
			{ type: 'setTestParam', param: 'allLEDSWhite', value: V.bool(true) },
			{ type: 'setSipCallingParam', param: 'sipCallHostingEnabled', value: V.bool(true) },
			{ type: 'setSipAdvancedParam', param: 'autoReconnect', value: V.bool(true) },
			{ type: 'setSipCallSlotsParam', slot: 0, param: 'sipSlotCallDisconnect', value: V.bool(true) },
			{ type: 'setPadRecorderParam', padRecorder: 0, param: 'padRecordClear', value: V.bool(true) },
			{ type: 'setFxPresetParam', preset: 0, param: 'fxPresetIdx', value: V.int(0) },
		]
		for (const cmd of cmds) {
			const bytes = encodeCommand(cmd, l)
			assert.equal(bytes.length, 1, cmd.type)
			const f = decodeSingleProp(bytes[0])
			assert.equal(f.name, cmd.param)
			assert.deepEqual(f.value, cmd.value)
		}
		assert.throws(
			() => encodeCommand({ type: 'setShowParam', show: 1, param: 'showName', value: V.string('x') }, l),
			(e) => e.code === 'missingNode',
		)
		assert.throws(() => encodeCommand({ type: 'bogus' }, l), TypeError)
	})

	test('setupSkip emits the documented sequence', () => {
		const l = Layout.fromFullSync(minimalRootWith([n('GUI'), n('SYSTEM'), n('SHOWCONTROL')]))
		const frames = encodeCommand({ type: 'setupSkip', language: 'en', timezone: 'Europe/Copenhagen' }, l).map(
			decodeSingleProp,
		)
		assert.deepEqual(
			frames.map((f) => [f.path[0], f.name]),
			[
				[l.gui, 'lang'],
				[l.system, 'systemDateTimezone'],
				[l.system, 'systemDateTime24h'],
				[l.system, 'systemDateTimeOnHome'],
				[l.singletonIndex('showControl'), 'showControlNewFromDefaultMuted'],
				[l.system, 'disableAllPhysicalButtons'],
				[l.system, 'disableAllLineoutOutputs'],
				[l.system, 'disableAllHeadphoneOutputs'],
				[l.system, 'systemChannelSelected'],
			],
		)
		assert.deepEqual(frames[frames.length - 1].value, V.int(-1))
		assert.equal(encodeCommand({ type: 'setupSkip' }, minimalLayout()).length, 0)
	})
})
