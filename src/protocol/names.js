/**
 * Named RODECaster entities: the vocabulary the public API speaks.
 *
 * On the wire every entity is positional ("the Nth INPUTSOURCE node",
 * "source-major MIX cell N", "the Nth FADER node"). Those ordinals shift with
 * firmware and differ across models, so this module pins each ordinal to a
 * name. The name <-> ordinal maps are reverse-engineering knowledge that
 * cannot be recovered from a fullSync; they come verbatim from
 * `rodecaster-protocol/src/names/*.rs` (MIT, Yeradon). The parameter-name
 * tables below were generated from those files.
 *
 * Conventions:
 * - A device model is `'pro2'` or `'duo'`.
 * - A fader is `'physical1'..'physical6'`, `'virtual1'..'virtual5'`.
 * - A source is one of {@link Source.ALL}; a mix output one of {@link MixOutput.ALL}.
 * - A parameter is its wire property name (a string). Each family object
 *   (`ChannelParam`, `SystemParam`, ...) lists the names known on that node;
 *   unknown names are still carried through, just not listed (the Rust
 *   `Other(String)` variant).
 *
 * @module protocol/names
 */

/** @typedef {'pro2' | 'duo'} DeviceModelId */

export const DeviceModel = Object.freeze({
	PRO2: /** @type {DeviceModelId} */ ('pro2'),
	DUO: /** @type {DeviceModelId} */ ('duo'),

	/**
	 * Map `SYSTEM.boardType` (0 = Pro II, 1 = Duo). `null` for an unknown board.
	 * @param {number | bigint | null | undefined} boardType
	 * @returns {DeviceModelId | null}
	 */
	fromBoardType(boardType) {
		if (boardType === 0 || boardType === 0n) return 'pro2'
		if (boardType === 1 || boardType === 1n) return 'duo'
		return null
	},

	/**
	 * Map `SYSTEM.systemName`: contains "duo" (case-insensitive) => Duo, else Pro II.
	 * @param {string} systemName
	 * @returns {DeviceModelId}
	 */
	fromSystemName(systemName) {
		return systemName.toLowerCase().includes('duo') ? 'duo' : 'pro2'
	},

	/**
	 * Detect the model: `boardType` is authoritative, `systemName` the fallback,
	 * default Pro II (firmware 1.6.8 captures carry neither).
	 * @param {number | bigint | null | undefined} boardType
	 * @param {string | null | undefined} systemName
	 * @returns {DeviceModelId}
	 */
	detect(boardType, systemName) {
		const byBoard = DeviceModel.fromBoardType(boardType)
		if (byBoard) return byBoard
		if (typeof systemName === 'string') return DeviceModel.fromSystemName(systemName)
		return 'pro2'
	},

	/** @param {DeviceModelId} model */
	label(model) {
		return model === 'duo' ? 'RODECaster Duo' : 'RODECaster Pro II'
	},
})

/**
 * Build a name <-> ordinal vocabulary with labels and parse aliases.
 * @template {string} T
 * @param {T[]} ids protocol order (index == protocol ordinal)
 * @param {Record<T, string>} labels
 * @param {Record<string, T>} aliases extra lower-case parse aliases
 * @param {string} hint
 */
function vocabulary(ids, labels, aliases, hint) {
	const byId = new Map(ids.map((id, i) => [id, i]))
	return Object.freeze({
		/** All ids in protocol order. */
		ALL: Object.freeze(ids.slice()),
		/** @param {T} id @returns {number} protocol ordinal */
		toProtocol(id) {
			const i = byId.get(id)
			if (i === undefined) throw new RangeError(`unknown ${hint}: ${id}`)
			return i
		},
		/** @param {number} idx @returns {T | null} */
		fromProtocol(idx) {
			return ids[idx] ?? null
		},
		/** @param {string} id */
		has(id) {
			return byId.has(/** @type {T} */ (id))
		},
		/** @param {T} id @returns {string} */
		label(id) {
			return labels[id]
		},
		/**
		 * Parse a user-facing name or alias (case-insensitive, ignoring spaces,
		 * underscores and dashes). `null` if unknown.
		 * @param {string} s
		 * @returns {T | null}
		 */
		parse(s) {
			const clean = String(s).toLowerCase().replace(/[ _-]/g, '')
			if (byId.has(/** @type {T} */ (clean))) return /** @type {T} */ (clean)
			return aliases[clean] ?? null
		},
	})
}

/**
 * A mix output bus: where audio is routed *to*. Model-independent (13 buses);
 * the protocol mix index equals list order and is the second dimension of the
 * source-major mix matrix.
 */
export const MixOutput = vocabulary(
	/** @type {const} */ ([
		'headphone1',
		'headphone2',
		'headphone3',
		'headphone4',
		'speaker',
		'recording',
		'bluetooth',
		'usb1',
		'chat',
		'usb2',
		'callme1',
		'callme2',
		'callme3',
	]),
	{
		headphone1: 'Headphone 1',
		headphone2: 'Headphone 2',
		headphone3: 'Headphone 3',
		headphone4: 'Headphone 4',
		speaker: 'Speaker',
		recording: 'Recording',
		bluetooth: 'Bluetooth',
		usb1: 'USB 1',
		chat: 'Chat',
		usb2: 'USB 2',
		callme1: 'CallMe 1',
		callme2: 'CallMe 2',
		callme3: 'CallMe 3',
	},
	{
		hp1: 'headphone1',
		hp2: 'headphone2',
		hp3: 'headphone3',
		hp4: 'headphone4',
		spk: 'speaker',
		monitor: 'speaker',
		rec: 'recording',
		bt: 'bluetooth',
		cm1: 'callme1',
		cm2: 'callme2',
		cm3: 'callme3',
	},
	'mix output',
)

/** @typedef {(typeof MixOutput.ALL)[number]} MixOutputId */

/**
 * An audio source: where audio comes *from*. Model-independent (19 sources);
 * the protocol source index equals list order and is the first (major)
 * dimension of the mix matrix. `callme1..3` (16..18) are return channels
 * addressed outside the regular matrix on some firmware.
 */
export const Source = vocabulary(
	/** @type {const} */ ([
		'combo1',
		'combo2',
		'combo3',
		'combo4',
		'combo12',
		'combo23',
		'combo34',
		'usb1',
		'chat',
		'usb2',
		'bluetooth',
		'soundpad',
		'game',
		'music',
		'virtuala',
		'virtualb',
		'callme1',
		'callme2',
		'callme3',
	]),
	{
		combo1: 'Combo 1',
		combo2: 'Combo 2',
		combo3: 'Combo 3',
		combo4: 'Combo 4',
		combo12: 'Combo 1+2',
		combo23: 'Combo 2+3',
		combo34: 'Combo 3+4',
		usb1: 'USB 1',
		chat: 'Chat',
		usb2: 'USB 2',
		bluetooth: 'Bluetooth',
		soundpad: 'Sound Pad',
		game: 'Game',
		music: 'Music',
		virtuala: 'Virtual A',
		virtualb: 'Virtual B',
		callme1: 'CallMe 1',
		callme2: 'CallMe 2',
		callme3: 'CallMe 3',
	},
	{
		mic1: 'combo1',
		mic2: 'combo2',
		mic3: 'combo3',
		mic4: 'combo4',
		'combo1+2': 'combo12',
		'combo2+3': 'combo23',
		'combo3+4': 'combo34',
		bt: 'bluetooth',
		pad: 'soundpad',
		virtualgame: 'game',
		vgame: 'game',
		virtualmusic: 'music',
		vmusic: 'music',
		va: 'virtuala',
		a: 'virtuala',
		vb: 'virtualb',
		b: 'virtualb',
		cm1: 'callme1',
		caller1: 'callme1',
		cm2: 'callme2',
		caller2: 'callme2',
		cm3: 'callme3',
		caller3: 'callme3',
	},
	'source',
)

/** @typedef {(typeof Source.ALL)[number]} SourceId */

/**
 * CallMe return channels use a dedicated request path outside the mix matrix.
 * @param {SourceId} source
 */
export function isCallMeSource(source) {
	return source === 'callme1' || source === 'callme2' || source === 'callme3'
}

/** @typedef {'physical1'|'physical2'|'physical3'|'physical4'|'physical5'|'physical6'|'virtual1'|'virtual2'|'virtual3'|'virtual4'|'virtual5'} FaderId */

const FADER_IDS = /** @type {FaderId[]} */ ([
	'physical1',
	'physical2',
	'physical3',
	'physical4',
	'physical5',
	'physical6',
	'virtual1',
	'virtual2',
	'virtual3',
	'virtual4',
	'virtual5',
])

/** Wire fader/channel index per model (list order == index 0..8). */
const FADER_ORDER = Object.freeze({
	pro2: /** @type {FaderId[]} */ ([
		'physical1',
		'physical2',
		'physical3',
		'physical4',
		'physical5',
		'physical6',
		'virtual1',
		'virtual2',
		'virtual3',
	]),
	duo: /** @type {FaderId[]} */ ([
		'physical1',
		'physical2',
		'physical3',
		'physical4',
		'virtual1',
		'virtual2',
		'virtual3',
		'virtual4',
		'virtual5',
	]),
})

const FADER_LABELS = Object.freeze({
	physical1: 'Fader 1',
	physical2: 'Fader 2',
	physical3: 'Fader 3',
	physical4: 'Fader 4',
	physical5: 'Fader 5',
	physical6: 'Fader 6',
	virtual1: 'Virtual 1',
	virtual2: 'Virtual 2',
	virtual3: 'Virtual 3',
	virtual4: 'Virtual 4',
	virtual5: 'Virtual 5',
})

/**
 * A fader strip. The strip <-> wire index map is model-dependent:
 * - Pro II: physical1..6 => 0..5, virtual1..3 => 6..8
 * - Duo:    physical1..4 => 0..3, virtual1..5 => 4..8
 * A strip absent on a model (e.g. physical6 on the Duo) has no index there.
 */
export const Fader = Object.freeze({
	/** All fader ids (both models). */
	ALL: Object.freeze(FADER_IDS.slice()),

	/**
	 * Wire index for this strip on `model`, or `null` if absent there.
	 * @param {FaderId} fader
	 * @param {DeviceModelId} model
	 * @returns {number | null}
	 */
	toIndex(fader, model) {
		const i = FADER_ORDER[model].indexOf(fader)
		return i < 0 ? null : i
	},

	/**
	 * Strip at wire index `idx` on `model`, or `null` (e.g. index 9, the master channel).
	 * @param {DeviceModelId} model
	 * @param {number} idx
	 * @returns {FaderId | null}
	 */
	fromIndex(model, idx) {
		return FADER_ORDER[model]?.[idx] ?? null
	},

	/**
	 * Strips that exist on `model`, in wire order.
	 * @param {DeviceModelId} model
	 * @returns {FaderId[]}
	 */
	onModel(model) {
		return FADER_ORDER[model].slice()
	},

	/**
	 * True if the strip is a physical slide potentiometer on `model`.
	 * @param {FaderId} fader
	 * @param {DeviceModelId} model
	 */
	isPhysical(fader, model) {
		return fader.startsWith('physical') && FADER_ORDER[model].includes(fader)
	},

	/** @param {string} id */
	has(id) {
		return FADER_IDS.includes(/** @type {FaderId} */ (id))
	},

	/** @param {FaderId} fader */
	label(fader) {
		return FADER_LABELS[fader]
	},

	/**
	 * Parse `physical1` / `p1` / `fader1` / `virtual1` / `v1` / `vfader1`.
	 * @param {string} s
	 * @returns {FaderId | null}
	 */
	parse(s) {
		const m = String(s)
			.toLowerCase()
			.match(/^(physical|p|fader|virtual|v|vfader)([1-6])$/)
		if (!m) return null
		const kind = m[1] === 'physical' || m[1] === 'p' || m[1] === 'fader' ? 'physical' : 'virtual'
		const n = Number(m[2])
		if (kind === 'virtual' && n > 5) return null
		return /** @type {FaderId} */ (`${kind}${n}`)
	},
})

/**
 * A parameter family: the wire property names known on one node type.
 * @param {string} familyName
 * @param {string[]} names
 */
function family(familyName, names) {
	const set = new Set(names)
	return Object.freeze({
		/** Family name (`ChannelParam`, ...). */
		name: familyName,
		/** Known wire names in source order. */
		ALL: Object.freeze(names.slice()),
		/** @param {string} wireName */
		has(wireName) {
			return set.has(wireName)
		},
		/**
		 * The wire name if known, else `null` (the Rust `from_known_name`).
		 * @param {string} wireName
		 * @returns {string | null}
		 */
		fromKnownName(wireName) {
			return set.has(wireName) ? wireName : null
		},
	})
}

// ---------------------------------------------------------------------------
// Parameter families (generated from rodecaster-protocol/src/names/*.rs)
// ---------------------------------------------------------------------------

// From names/app.rs (4 names).
export const AppParam = family('AppParam', ['appCompression', 'appMonitorMix', 'appOutputDevice', 'appRecording'])

// From names/audio.rs (9 names).
export const AudioParam = family('AudioParam', [
	'activeStreamerXMixPreset',
	'audioBufferSize',
	'audioSampleRate',
	'audioInputChannels',
	'audioOutputChannels',
	'audioInputLatency',
	'audioOuputLatency',
	'rcSyncChannelAssign',
	'rcSyncChannelSwap',
])

// From names/build.rs (5 names).
export const BuildParam = family('BuildParam', [
	'buildCallMeVersion',
	'buildGuiVersion',
	'buildGuiModulesGitSha',
	'buildMixerVersion',
	'buildMixerModulesGitSha',
])

// From names/channel.rs (58 names).
export const ChannelParam = family('ChannelParam', [
	'eqOn',
	'eqLowOn',
	'eqLowGain',
	'eqLowQ',
	'eqLowShelf',
	'eqMidOn',
	'eqMidGain',
	'eqMidQ',
	'eqMidBell',
	'eqHighOn',
	'eqHighGain',
	'eqHighQ',
	'eqHighBell',
	'compressorOn',
	'compressorThreshold',
	'compressorRatio',
	'compressorAttack',
	'compressorRelease',
	'compressorGain',
	'deesserOn',
	'deesserThreshold',
	'deesserRatio',
	'deesserAttack',
	'deesserRelease',
	'deesserGain',
	'deesserFrequency',
	'noiseGateOn',
	'noiseGateThreshold',
	'noiseGateRange',
	'noiseGateAttack',
	'noiseGateHold',
	'noiseGateRelease',
	'noiseGateHysteresis',
	'hpfOn',
	'hpfFrequency',
	'hpfSlope',
	'hpfLowerOn',
	'hpfHigherOn',
	'aphexOn',
	'aphexAEMix',
	'aphexAETune',
	'aphexBBDrive',
	'aphexBBTune',
	'channelPanOn',
	'channelPan',
	'channelPanL',
	'channelPanR',
	'channelPanMode',
	'channelDepth',
	'channelSparkle',
	'channelPunch',
	'channelAdvancedProcessing',
	'channelBypassProcessing',
	'channelCurrentFxPreset',
	'channelListenSource',
	'channelTalkbackEnable',
	'channelWirelessMute',
	'channelIndex',
])

// From names/ducker.rs (1 names).
export const DuckerParam = family('DuckerParam', ['duckerDepth'])

// From names/effects.rs (21 names).
export const EffectsParam = family('EffectsParam', [
	'reverbOn',
	'reverbMix',
	'reverbModel',
	'reverbHighCut',
	'reverbLowCut',
	'echoOn',
	'echoMix',
	'echoDecay',
	'echoDelay',
	'echoHighCut',
	'echoLowCut',
	'pitchShiftOn',
	'pitchShiftSemitones',
	'distortionOn',
	'distortionIntensity',
	'robotOn',
	'robotLevel',
	'robotMix',
	'voiceDisguiseOn',
	'effectsIdx',
	'channelInputSource',
])

// From names/fx_preset.rs (2 names).
export const FxPresetParam = family('FxPresetParam', ['fxPresetContents', 'fxPresetIdx'])

// From names/gui.rs (14 names).
export const GuiParam = family('GuiParam', [
	'lang',
	'screenBrightness',
	'autoBrightness',
	'screenDimAfterSeconds',
	'activeButtonsBrightness',
	'inactiveButtonsBrightness',
	'metering',
	'broadcastMeters',
	'selectedBank',
	'padActiveEdit',
	'screenTouched',
	'eqParamModeLow',
	'eqParamModeMid',
	'eqParamModeHigh',
])

// From names/headphone.rs (2 names).
export const HeadphoneParam = family('HeadphoneParam', ['headphoneColour', 'headphoneType'])

// From names/input_source.rs (12 names).
export const InputSourceParam = family('InputSourceParam', [
	'inputId',
	'inputColour',
	'inputType',
	'inputPower',
	'inputMicrophoneType',
	'inputMicrophoneGain',
	'inputDigitalGain',
	'inputInstrumentGain',
	'inputPhaseFlip',
	'inputWirelessSN',
	'inputSipCallSlot',
	'inputRcvAudioSourceType',
])

// From names/master.rs (7 names).
export const MasterParam = family('MasterParam', [
	'masterCompellorOn',
	'masterCompellorThreshold',
	'masterCompellorAttack',
	'masterCompellorRelease',
	'masterCompellorGain',
	'masterDelayOn',
	'masterDelaySeconds',
])

// From names/meter.rs (6 names).
export const MeterParam = family('MeterParam', [
	'faderLevel',
	'meterLevelL',
	'meterLevelR',
	'meterPeakL',
	'meterPeakR',
	'meterStereo',
])

// From names/mix_minuses.rs (1 names).
export const MixMinusesParam = family('MixMinusesParam', ['outputMixMinus'])

// From names/network.rs (56 names).
export const NetworkParam = family('NetworkParam', [
	'btVisible',
	'btDoScan',
	'btDoPair',
	'btDoUnPair',
	'btDoConnect',
	'btDoDisconnect',
	'btPairCode',
	'btConnectedAddress',
	'btConnectedType',
	'btPairedNumber1',
	'btPairedNumber2',
	'btPairedNumber3',
	'btPairedNumber4',
	'btPairedNumber5',
	'btScan1',
	'btScan2',
	'btScan3',
	'btScan4',
	'btScan5',
	'btScan6',
	'btScan7',
	'btScan8',
	'btScan9',
	'btScan10',
	'cellAPN',
	'cellEnabled',
	'cellGateway',
	'cellIpAddress',
	'cellSubnetMask',
	'cellUSBFound',
	'gateway',
	'ipAddress',
	'primaryDns',
	'secondaryDns',
	'staticIpSet',
	'subnetMask',
	'wiredConnected',
	'wifi',
	'wifiDHCP',
	'wifiGateway',
	'wifiIncorrectPSK',
	'wifiIpAddress',
	'wifiPSK',
	'wifiSSID',
	'wifiSubnetMask',
	'wifiScan',
	'wifiScan1',
	'wifiScan2',
	'wifiScan3',
	'wifiScan4',
	'wifiScan5',
	'wifiScan6',
	'wifiScan7',
	'wifiScan8',
	'wifiScan9',
	'wifiScan10',
])

// From names/output.rs (15 names).
export const OutputParam = family('OutputParam', [
	'outputMonLevel',
	'outputMonMute',
	'outputMonAutoMute',
	'outputMonAutoMuteActive',
	'outputMonFixed',
	'outputBTLevel',
	'outputBTMute',
	'outputBTAutoMute',
	'outputBTAutoMuteActive',
	'outputMultiMode',
	'outputMultiBypass',
	'outputPrefader',
	'recordingCompressionQuality',
	'recordingMultitrackMode',
	'recordingProcessingBypass',
])

// From names/pad.rs (48 names).
export const PadParam = family('PadParam', [
	'padIdx',
	'padColourIndex',
	'padName',
	'padType',
	'padIsInternal',
	'padRCVSyncPadType',
	'padFilePath',
	'padActive',
	'padLoop',
	'padReplay',
	'padPlayMode',
	'padProgress',
	'padProgressRequestSignal',
	'padGain',
	'padEnvStart',
	'padEnvStop',
	'padEnvFadeIn',
	'padEnvFadeOut',
	'padMixerMode',
	'padMixerTriggerMode',
	'padMixerCensorCustom',
	'padMixerCensorFilePath',
	'padMixerFadeInSeconds',
	'padMixerFadeOutSeconds',
	'padMixerFadeExcludeHost',
	'padMixerBackChannelMic2',
	'padMixerBackChannelMic3',
	'padMixerBackChannelMic4',
	'padMixerBackChannelUsb1Comms',
	'padMixerBackChannelUsb2Main',
	'padMixerBackChannelBluetooth',
	'padMixerBackChannelCallMe1',
	'padMixerBackChannelCallMe2',
	'padMixerBackChannelCallMe3',
	'padEffectInput',
	'padEffectTriggerMode',
	'padSIPPhoneBookEntry',
	'padSIPCallSlot',
	'padSIPFlashState',
	'padSIPQdLock',
	'padTriggerMode',
	'padTriggerSend',
	'padTriggerType',
	'padTriggerCustom',
	'padTriggerControl',
	'padTriggerChannel',
	'padTriggerOn',
	'padTriggerOff',
])

// From names/pad_recorder.rs (6 names).
export const PadRecorderParam = family('PadRecorderParam', [
	'padRecordIdx',
	'padRecordState',
	'padRecordSeconds',
	'padRecordMemoryFull',
	'padRecordStateRequest',
	'padRecordClear',
])

// From names/player.rs (11 names).
export const PlayerParam = family('PlayerParam', [
	'playerState',
	'playerSpeed',
	'playerProgress',
	'playerCurrentPositionTime',
	'playerJumpToSample',
	'playerFilePath',
	'playerFileSize',
	'playerEnvStart',
	'playerEnvStop',
	'playerEnvFadeIn',
	'playerEnvFadeOut',
])

// From names/radio.rs (3 names).
export const RadioParam = family('RadioParam', ['radioPair', 'radioPaired', 'radioUnpair'])

// From names/radio.rs (12 names).
export const RadioTxParam = family('RadioTxParam', [
	'txBatteryLevel',
	'txChargingState',
	'txConnected',
	'txConnectionId',
	'txDeviceSN',
	'txDeviceType',
	'txGainAssist',
	'txPad',
	'txRecord',
	'txRemoteMute',
	'txRssi',
	'txSignalQuality',
])

// From names/radio.rs (1 names).
export const RadioRxParam = family('RadioRxParam', ['rxRadioId'])

// From names/rcsync.rs (7 names).
export const RcSyncMixParam = family('RcSyncMixParam', [
	'mixDisabled',
	'mixLevelWithAnchor',
	'mixLink',
	'mixLinkRequest',
	'mixMute',
	'mixUnlinkRequest',
	'mixRcSyncLevelRequest',
])

// From names/recorder.rs (5 names).
export const RecorderParam = family('RecorderParam', [
	'recordState',
	'recordTimeMs',
	'recordBytesPerSecond',
	'requestRecordState',
	'requestDropMarker',
])

// From names/recording.rs (3 names).
export const RecordingsParam = family('RecordingsParam', [
	'recordingTotalCount',
	'recordingTotalDuration',
	'requestDeleteUID',
])

// From names/recording.rs (2 names).
export const RecordingParam = family('RecordingParam', ['recordingContent', 'recordingUID'])

// From names/show.rs (7 names).
export const ShowParam = family('ShowParam', [
	'showIcon',
	'showLastModification',
	'showName',
	'showSnapshotIndex',
	'showStorageType',
	'showUID',
	'showUUID',
])

// From names/show.rs (3 names).
export const CurrentShowParam = family('CurrentShowParam', ['currentShowIcon', 'currentShowName', 'currentShowUUID'])

// From names/show.rs (10 names).
export const ShowControlParam = family('ShowControlParam', [
	'showControlDelete',
	'showControlExport',
	'showControlExportImport',
	'showControlImport',
	'showControlLastError',
	'showControlLockoutCentral',
	'showControlNewFromDefault',
	'showControlNewFromDefaultMuted',
	'showControlProgress',
	'showControlUpdating',
])

// From names/sip.rs (14 names).
export const SipCallingParam = family('SipCallingParam', [
	'sipCallHostingEnabled',
	'sipCallHostingToggleEnabled',
	'sipLicenceMode',
	'sipLicenceCheck',
	'sipRodeCode',
	'sipIncomingCallAccept',
	'sipIncomingCallDetails',
	'sipOutgoingCallDetails',
	'sipSlotPendingCallSetup',
	'sipRemainingCalltime',
	'sipRemainingWebCalltime',
	'sipRenewalDate',
	'sipLicenceRenewal',
	'sipCallRating',
])

// From names/sip.rs (3 names).
export const SipRegistrationParam = family('SipRegistrationParam', [
	'sipRegistrationIndex',
	'sipRegistrationDetails',
	'sipRegistrationIsRegistered',
])

// From names/sip.rs (12 names).
export const SipCallSlotsParam = family('SipCallSlotsParam', [
	'sipCallSlotId',
	'sipSlotCallState',
	'sipSlotCallUUID',
	'sipSlotCallAddress',
	'sipSlotCallQuality',
	'sipSlotCallJitter',
	'sipSlotCallBitrate',
	'sipSlotCallPacketLoss',
	'sipSlotCallDisconnect',
	'sipSlotCallExtend',
	'sipSlotCallIsHost',
	'sipSlotCallMode',
])

// From names/sip.rs (25 names).
export const SipAdvancedParam = family('SipAdvancedParam', [
	'forceCodecChoice',
	'enableVideoStream',
	'enableRFCDuplication',
	'incomingNameFilter',
	'usbNumberPad',
	'nonHTTPSInterface',
	'autoReconnect',
	'incomingAudioRouting',
	'dtmfMode',
	'receiveJitterBufferMin',
	'receiveJitterBufferMax',
	'sipWebPassword',
	'sipAccountRegister',
	'sipAccountUsername',
	'sipAccountPassword',
	'sipAccountDomain',
	'sipAccountProxyAddress',
	'sipAccountTransport',
	'sipNATTraversalMode',
	'sipNATTraversalServer',
	'sipNATTraversalUsername',
	'sipNATTraversalPassword',
	'sipUnitName',
	'sipAccountAuthUsername',
	'rodeCallQuality',
])

// From names/storage.rs (11 names).
export const StorageVolumeParam = family('StorageVolumeParam', [
	'storageVolumeName',
	'storageVolumeCapacity',
	'storageVolumeFree',
	'storageVolumeInserted',
	'storageVolumeMounted',
	'storageVolumeFormatted',
	'storageVolumeRecDestination',
	'storageVolumeState',
	'storageVolumeEject',
	'storageVolumeErase',
	'storageVolumeTransfer',
])

// From names/streamerx.rs (2 names).
export const StreamerXMixPresetParam = family('StreamerXMixPresetParam', [
	'streamerXPresetCreated',
	'streamerXPresetName',
])

// From names/streamerx.rs (1 names).
export const StreamerXStreamMixParam = family('StreamerXStreamMixParam', ['streammixmixLevel'])

// From names/system.rs (49 names).
export const SystemParam = family('SystemParam', [
	'systemMidiControl',
	'systemChannelSelected',
	'systemMixSelected',
	'systemFirmwareVersion',
	'engineMode',
	'systemSerialNumber',
	'boardType',
	'systemDateTimezone',
	'systemDateTimeDaylightSavings',
	'systemDateTimeOnHome',
	'systemDateTime24h',
	'systemBetaMode',
	'systemHapticSetting',
	'systemRecButtonSetting',
	'unifyMode',
	'presenterMode',
	'presenterSoftware',
	'assignableMeterSource',
	'lastRecordingID',
	'transferModeType',
	'appUpdateAvailable',
	'osUpdateAvailable',
	'updateDownloaded',
	'updateChecking',
	'updateNoInternet',
	'updateComplete',
	'updateDownloadProgress',
	'updateInstalledProgress',
	'updateVersion',
	'updateViaUSB',
	'updateCheckRequested',
	'updateInitiateRequested',
	'downloadInitiateRequested',
	'downloadCancelRequested',
	'updateRebootRequested',
	'updateResetDeviceRequested',
	'updateResetAppRequested',
	'updateResetAfterFWURequested',
	'powerOffRequest',
	'disableAllHeadphoneOutputs',
	'disableAllLineoutOutputs',
	'disableAllPhysicalButtons',
	'usb1Connected',
	'usbHostOnUsb2',
	'usbHostUnspportedFirmware',
	'remountPadStorage',
	'badPadDetected',
	'shareAnom',
	'shareResource',
])

// From names/test.rs (2 names).
export const TestParam = family('TestParam', ['allLEDSWhite', 'toneGeneration'])

// From names/theme.rs (1 names).
export const ThemeParam = family('ThemeParam', ['themeId'])

// From names/wifi_scan_result.rs (1 names).
export const WifiScanResultParam = family('WifiScanResultParam', ['wifiScanResultSSID'])

/** Every parameter family, keyed by family name. */
export const ParamFamilies = Object.freeze({
	AppParam,
	AudioParam,
	BuildParam,
	ChannelParam,
	DuckerParam,
	EffectsParam,
	FxPresetParam,
	GuiParam,
	HeadphoneParam,
	InputSourceParam,
	MasterParam,
	MeterParam,
	MixMinusesParam,
	NetworkParam,
	OutputParam,
	PadParam,
	PadRecorderParam,
	PlayerParam,
	RadioParam,
	RadioTxParam,
	RadioRxParam,
	RcSyncMixParam,
	RecorderParam,
	RecordingsParam,
	RecordingParam,
	ShowParam,
	CurrentShowParam,
	ShowControlParam,
	SipCallingParam,
	SipRegistrationParam,
	SipCallSlotsParam,
	SipAdvancedParam,
	StorageVolumeParam,
	StreamerXMixPresetParam,
	StreamerXStreamMixParam,
	SystemParam,
	TestParam,
	ThemeParam,
	WifiScanResultParam,
})
