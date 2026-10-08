/**
 * Action definitions. Strip, pad and FX choices come from the connected desk.
 * @param {import('./main.js').RodecasterInstance} self
 */
export function updateActions(self) {
	const dev = self.device
	const strips = dev.strips()
	const stripChoices = strips.map((s) => ({ id: s.index, label: `${s.index + 1}: ${s.name}` }))
	if (stripChoices.length === 0) stripChoices.push({ id: 0, label: 'Strip 1 (desk not connected yet)' })
	const slotChoices = Array.from({ length: 8 }, (_, i) => ({ id: i, label: `Pad ${i + 1}` }))
	const bankChoices = [
		{ id: -1, label: 'Current bank' },
		...Array.from({ length: 8 }, (_, i) => ({ id: i, label: `Bank ${i + 1}` })),
	]
	const fxSlots = Array.from({ length: Math.max(dev.fxSlotCount, 4) }, (_, i) => ({
		id: i,
		label: i < strips.length ? `Slot ${i + 1} (${strips[i].name})` : `Slot ${i + 1}`,
	}))
	const modeField = {
		id: 'mode',
		type: 'dropdown',
		label: 'Mode',
		default: 'toggle',
		choices: [
			{ id: 'toggle', label: 'Toggle' },
			{ id: 'on', label: 'On' },
			{ id: 'off', label: 'Off' },
		],
	}
	const stripField = {
		id: 'strip',
		type: 'dropdown',
		label: 'Strip',
		default: stripChoices[0].id,
		choices: stripChoices,
	}

	/** @param {string} mode @param {boolean} current */
	const resolve = (mode, current) => (mode === 'toggle' ? !current : mode === 'on')

	/** Wrap a handler so failures land in the log instead of vanishing. */
	const guard = (name, fn) => async (event) => {
		try {
			await fn(event)
		} catch (err) {
			self.log('warn', `${name}: ${err.message}`)
		}
	}

	self.setActionDefinitions({
		strip_mute: {
			name: 'Channel: Mute',
			options: [stripField, modeField],
			callback: guard('mute', async (e) => {
				const i = Number(e.options.strip)
				await dev.setStripMute(i, () => resolve(String(e.options.mode), dev.strip(i).muted))
			}),
		},
		strip_cue: {
			name: 'Channel: Cue',
			options: [stripField, modeField],
			callback: guard('cue', async (e) => {
				const i = Number(e.options.strip)
				await dev.setStripCue(i, () => resolve(String(e.options.mode), dev.strip(i).cued))
			}),
		},
		strip_level_step: {
			name: 'Channel: Volume up / down',
			description:
				'Borrows the strip from its physical fader (needs level control enabled). Assign to rotate or hold to ramp.',
			options: [
				stripField,
				{ id: 'delta', type: 'number', label: 'Step (fader units, -127..127)', default: 2, min: -127, max: 127 },
			],
			callback: guard('volume step', async (e) => {
				await dev.stepStripLevel(Number(e.options.strip), Number(e.options.delta) / 127)
			}),
		},
		strip_level_set: {
			name: 'Channel: Set volume',
			options: [
				stripField,
				{ id: 'level', type: 'number', label: 'Level (0-127, 90 = unity)', default: 90, min: 0, max: 127 },
			],
			callback: guard('volume set', async (e) => {
				await dev.setStripLevel(Number(e.options.strip), Number(e.options.level) / 127)
			}),
		},
		strip_release: {
			name: 'Channel: Hand back to fader',
			options: [stripField],
			callback: guard('release', async (e) => dev.releaseStrip(Number(e.options.strip))),
		},
		restore_faders: {
			name: 'Restore all faders',
			description: 'Relinks every send this module borrowed. Put it on a button with a 1 s hold.',
			options: [],
			callback: guard('restore faders', async () => dev.restoreFaders()),
		},
		monitor_level_step: {
			name: 'Monitor: Level up / down',
			options: [{ id: 'delta', type: 'number', label: 'Step (%)', default: 2, min: -100, max: 100 }],
			callback: guard('monitor step', async (e) => dev.stepMonitorLevel(Number(e.options.delta) / 100)),
		},
		monitor_level_set: {
			name: 'Monitor: Set level',
			options: [{ id: 'level', type: 'number', label: 'Level (%)', default: 50, min: 0, max: 100 }],
			callback: guard('monitor set', async (e) => dev.setMonitorLevel(Number(e.options.level) / 100)),
		},
		monitor_mute: {
			name: 'Monitor: Mute',
			options: [modeField],
			callback: guard('monitor mute', async (e) =>
				dev.setMonitorMute(() => resolve(String(e.options.mode), dev.monitorMuted)),
			),
		},
		headphones_off: {
			name: 'Headphones: All off',
			options: [modeField],
			callback: guard('headphones off', async (e) =>
				dev.setHeadphonesOff(() => resolve(String(e.options.mode), dev.headphonesOff)),
			),
		},
		headphone_mix_mute: {
			name: 'Headphones: Mute one headphone mix',
			description: 'Mutes only the selected headphone mix. Unmute restores the sends this module muted.',
			options: [
				{
					id: 'headphone',
					type: 'dropdown',
					label: 'Headphone',
					default: 1,
					choices: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, label: `Headphone ${i + 1}` })),
				},
				modeField,
			],
			callback: guard('headphone mix mute', async (e) => {
				const n = Number(e.options.headphone)
				await dev.setHeadphoneMixMute(n, () => resolve(String(e.options.mode), dev.headphoneMixMuted(n)))
			}),
		},
		bluetooth_level_step: {
			name: 'Bluetooth: Send level up / down',
			options: [{ id: 'delta', type: 'number', label: 'Step (%)', default: 5, min: -100, max: 100 }],
			callback: guard('bluetooth step', async (e) =>
				dev.setBluetoothLevel(() => dev.bluetoothLevel + Number(e.options.delta) / 100),
			),
		},
		panic: {
			name: 'Panic mute',
			description:
				'Kills every output; releasing restores exactly what was muted before. Use "on" on press and "off" on release.',
			options: [modeField],
			callback: guard('panic', async (e) => {
				await dev.queuePanic(() => resolve(String(e.options.mode), dev.panicActive))
			}),
		},
		record: {
			name: 'Record',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Record / pause (toggle)' },
						{ id: 'record', label: 'Record (or resume)' },
						{ id: 'pause', label: 'Pause' },
						{ id: 'stop', label: 'Stop' },
					],
				},
			],
			callback: guard('record', async (e) => {
				const mode = String(e.options.mode)
				if (mode === 'record') await dev.requestRecord(2)
				else if (mode === 'pause') await dev.requestRecord(1)
				else if (mode === 'stop') await dev.requestRecord(0)
				else await dev.requestRecord(() => (dev.recordToggleState === 2 ? 1 : 2))
			}),
		},
		drop_marker: {
			name: 'Drop marker',
			options: [],
			callback: guard('marker', async () => dev.dropMarker()),
		},
		pad_press: {
			name: 'SMART pad: Press',
			options: [
				{ id: 'slot', type: 'dropdown', label: 'Pad', default: 0, choices: slotChoices },
				{ id: 'bank', type: 'dropdown', label: 'Bank', default: -1, choices: bankChoices },
			],
			callback: guard('pad', async (e) => {
				const bank = Number(e.options.bank)
				await dev.pressPad(Number(e.options.slot), bank < 0 ? null : bank)
			}),
		},
		pad_bank: {
			name: 'SMART pad: Bank',
			options: [
				{
					id: 'bank',
					type: 'dropdown',
					label: 'Bank',
					default: 'next',
					choices: [{ id: 'next', label: 'Next' }, { id: 'prev', label: 'Previous' }, ...bankChoices.slice(1)],
				},
			],
			callback: guard('bank', async (e) => {
				const b = e.options.bank
				if (b === 'next') await dev.setPadBank(() => (dev.padBank + 1) % 8)
				else if (b === 'prev') await dev.setPadBank(() => (dev.padBank + 7) % 8)
				else await dev.setPadBank(Number(b))
			}),
		},
		fx: {
			name: 'Voice FX',
			options: [
				{ id: 'slot', type: 'dropdown', label: 'Slot', default: 0, choices: fxSlots },
				{
					id: 'effect',
					type: 'dropdown',
					label: 'Effect',
					default: 'reverbOn',
					choices: FX_CHOICES,
				},
				modeField,
			],
			callback: guard('fx', async (e) => {
				const slot = Number(e.options.slot)
				const effect = String(e.options.effect)
				await dev.setFx(slot, effect, () => resolve(String(e.options.mode), dev.fxOn(slot, effect)))
			}),
		},
		screen_brightness: {
			name: 'Desk: Screen brightness',
			options: [
				{ id: 'op', type: 'dropdown', label: 'Operation', default: 'set', choices: OP_CHOICES },
				{ id: 'value', type: 'number', label: 'Value (0-255) or step', default: 255, min: -255, max: 255 },
			],
			callback: guard('screen brightness', async (e) => {
				const v = Number(e.options.value)
				await dev.setScreenBrightness(() => (e.options.op === 'step' ? dev.screenBrightness + v : v))
			}),
		},
		buttons_brightness: {
			name: 'Desk: Button brightness',
			options: [
				{ id: 'op', type: 'dropdown', label: 'Operation', default: 'set', choices: OP_CHOICES },
				{ id: 'value', type: 'number', label: 'Value (0-255) or step', default: 8, min: -255, max: 255 },
			],
			callback: guard('button brightness', async (e) => {
				const v = Number(e.options.value)
				await dev.setButtonsBrightness(() => (e.options.op === 'step' ? dev.buttonsBrightness + v : v))
			}),
		},
		ducker_depth: {
			name: 'Desk: Ducker depth',
			options: [
				{ id: 'op', type: 'dropdown', label: 'Operation', default: 'set', choices: OP_CHOICES },
				{ id: 'value', type: 'number', label: 'Depth (dB, 0 to -60) or step', default: -7, min: -60, max: 60 },
			],
			callback: guard('ducker', async (e) => {
				const v = Number(e.options.value)
				await dev.setDuckerDepth(() => (e.options.op === 'step' ? dev.duckerDepth + v : v))
			}),
		},
	})
}

export const FX_CHOICES = [
	{ id: 'reverbOn', label: 'Reverb' },
	{ id: 'echoOn', label: 'Echo' },
	{ id: 'pitchShiftOn', label: 'Pitch shift' },
	{ id: 'distortionOn', label: 'Distortion' },
	{ id: 'robotOn', label: 'Robot' },
	{ id: 'voiceDisguiseOn', label: 'Voice disguise' },
]

const OP_CHOICES = [
	{ id: 'set', label: 'Set to value' },
	{ id: 'step', label: 'Step by value' },
]
