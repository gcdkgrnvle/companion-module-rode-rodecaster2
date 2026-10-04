import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	ChannelParam,
	DeviceModel,
	Fader,
	isCallMeSource,
	MeterParam,
	MixOutput,
	NetworkParam,
	ParamFamilies,
	Source,
	SystemParam,
} from '../../src/protocol/names.js'

describe('DeviceModel', () => {
	test('prefers boardType over name', () => {
		assert.equal(DeviceModel.detect(1, 'RODECaster Pro II'), 'duo')
		assert.equal(DeviceModel.detect(0, null), 'pro2')
		assert.equal(DeviceModel.detect(1n, null), 'duo')
	})
	test('falls back to name, then default', () => {
		assert.equal(DeviceModel.detect(99, 'rodecaster duo'), 'duo')
		assert.equal(DeviceModel.detect(null, null), 'pro2')
		assert.equal(DeviceModel.detect(null, 'Some Duo'), 'duo')
		assert.equal(DeviceModel.detect(null, 'Pro II'), 'pro2')
	})
})

describe('Source / MixOutput', () => {
	test('source protocol round-trips all 19', () => {
		assert.equal(Source.ALL.length, 19)
		for (let i = 0; i <= 18; i++) assert.equal(Source.toProtocol(Source.fromProtocol(i)), i)
		assert.equal(Source.fromProtocol(19), null)
		assert.equal(Source.toProtocol('combo1'), 0)
		assert.equal(Source.toProtocol('combo23'), 5)
		assert.equal(Source.toProtocol('usb1'), 7)
		assert.equal(Source.toProtocol('callme1'), 16)
		assert.throws(() => Source.toProtocol('nonsense'), RangeError)
	})
	test('mix output protocol round-trips all 13', () => {
		assert.equal(MixOutput.ALL.length, 13)
		for (let i = 0; i <= 12; i++) assert.equal(MixOutput.toProtocol(MixOutput.fromProtocol(i)), i)
		assert.equal(MixOutput.fromProtocol(13), null)
		assert.equal(MixOutput.toProtocol('speaker'), 4)
		assert.equal(MixOutput.toProtocol('recording'), 5)
	})
	test('callme classification', () => {
		assert.ok(isCallMeSource('callme1'))
		assert.ok(isCallMeSource('callme3'))
		assert.ok(!isCallMeSource('combo1'))
		assert.ok(!isCallMeSource('virtualb'))
	})
	test('labels and parse aliases', () => {
		assert.equal(Source.label('combo12'), 'Combo 1+2')
		assert.equal(MixOutput.label('usb2'), 'USB 2')
		assert.equal(Source.parse('mic1'), 'combo1')
		assert.equal(Source.parse('Combo 1+2'), 'combo12')
		assert.equal(Source.parse('combo1_2'), 'combo12')
		assert.equal(Source.parse('bt'), 'bluetooth')
		assert.equal(Source.parse('nonsense'), null)
		assert.equal(MixOutput.parse('hp3'), 'headphone3')
		assert.equal(MixOutput.parse('spk'), 'speaker')
		assert.equal(MixOutput.parse('CallMe 2'), 'callme2')
		for (const s of Source.ALL) assert.equal(Source.parse(s), s)
		for (const m of MixOutput.ALL) assert.equal(MixOutput.parse(m), m)
	})
})

describe('Fader', () => {
	test('index round-trips per model', () => {
		for (const model of ['pro2', 'duo']) {
			for (let idx = 0; idx <= 8; idx++) {
				const f = Fader.fromIndex(model, idx)
				assert.ok(f, `${model} ${idx}`)
				assert.equal(Fader.toIndex(f, model), idx)
			}
			assert.equal(Fader.fromIndex(model, 9), null)
		}
	})
	test('layout differs by model', () => {
		assert.equal(Fader.toIndex('physical6', 'pro2'), 5)
		assert.equal(Fader.toIndex('virtual1', 'pro2'), 6)
		assert.equal(Fader.toIndex('virtual3', 'pro2'), 8)
		assert.equal(Fader.toIndex('virtual4', 'pro2'), null)
		assert.equal(Fader.toIndex('virtual5', 'pro2'), null)
		assert.equal(Fader.toIndex('physical4', 'duo'), 3)
		assert.equal(Fader.toIndex('virtual1', 'duo'), 4)
		assert.equal(Fader.toIndex('virtual5', 'duo'), 8)
		assert.equal(Fader.toIndex('physical5', 'duo'), null)
		assert.equal(Fader.toIndex('physical6', 'duo'), null)
		assert.deepEqual(Fader.onModel('duo').length, 9)
	})
	test('isPhysical per model', () => {
		assert.ok(Fader.isPhysical('physical6', 'pro2'))
		assert.ok(!Fader.isPhysical('virtual1', 'pro2'))
		assert.ok(Fader.isPhysical('physical4', 'duo'))
		assert.ok(!Fader.isPhysical('physical5', 'duo'))
	})
	test('parse aliases', () => {
		assert.equal(Fader.parse('p1'), 'physical1')
		assert.equal(Fader.parse('fader4'), 'physical4')
		assert.equal(Fader.parse('v5'), 'virtual5')
		assert.equal(Fader.parse('vfader2'), 'virtual2')
		assert.equal(Fader.parse('Physical6'), 'physical6')
		assert.equal(Fader.parse('virtual6'), null)
		assert.equal(Fader.parse('nonsense'), null)
		assert.equal(Fader.label('virtual1'), 'Virtual 1')
	})
})

describe('parameter families', () => {
	test('known names and exact firmware casing', () => {
		assert.ok(ChannelParam.has('aphexAEMix'))
		assert.ok(ChannelParam.has('aphexBBDrive'))
		assert.ok(ChannelParam.has('channelPan'))
		assert.ok(!ChannelParam.has('channelMysteryKnob'))
		assert.equal(ChannelParam.fromKnownName('eqHighGain'), 'eqHighGain')
		assert.equal(ChannelParam.fromKnownName('nope'), null)
		assert.ok(NetworkParam.has('cellAPN'))
		assert.ok(NetworkParam.has('wifiDHCP'))
		assert.ok(NetworkParam.has('wifiIncorrectPSK'))
		assert.ok(NetworkParam.has('cellUSBFound'))
		assert.ok(SystemParam.has('updateViaUSB'))
		assert.ok(SystemParam.has('lastRecordingID'))
		assert.ok(SystemParam.has('usbHostUnspportedFirmware'))
		assert.ok(MeterParam.has('faderLevel'))
	})
	test('family sizes match the Rust tables', () => {
		const sizes = {
			AppParam: 4,
			AudioParam: 9,
			BuildParam: 5,
			ChannelParam: 58,
			DuckerParam: 1,
			EffectsParam: 21,
			FxPresetParam: 2,
			GuiParam: 14,
			HeadphoneParam: 2,
			InputSourceParam: 12,
			MasterParam: 7,
			MeterParam: 6,
			MixMinusesParam: 1,
			NetworkParam: 56,
			OutputParam: 15,
			PadParam: 48,
			PadRecorderParam: 6,
			PlayerParam: 11,
			RadioParam: 3,
			RadioTxParam: 12,
			RadioRxParam: 1,
			RcSyncMixParam: 7,
			RecorderParam: 5,
			RecordingsParam: 3,
			RecordingParam: 2,
			ShowParam: 7,
			CurrentShowParam: 3,
			ShowControlParam: 10,
			SipCallingParam: 14,
			SipRegistrationParam: 3,
			SipCallSlotsParam: 12,
			SipAdvancedParam: 25,
			StorageVolumeParam: 11,
			StreamerXMixPresetParam: 2,
			StreamerXStreamMixParam: 1,
			SystemParam: 49,
			TestParam: 2,
			ThemeParam: 1,
			WifiScanResultParam: 1,
		}
		assert.deepEqual(Object.keys(ParamFamilies).sort(), Object.keys(sizes).sort())
		for (const [name, size] of Object.entries(sizes)) {
			assert.equal(ParamFamilies[name].ALL.length, size, name)
			assert.equal(ParamFamilies[name].name, name)
			assert.equal(new Set(ParamFamilies[name].ALL).size, size, `${name} has duplicates`)
		}
	})
})
