import { combineRgb } from '@companion-module/base'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const DARK = combineRgb(20, 20, 20)
const RED = combineRgb(204, 0, 0)
const AMBER = combineRgb(230, 150, 0)
const BLUE = combineRgb(0, 90, 200)
const GREEN = combineRgb(0, 153, 0)

/** @param {string} text @param {number} [bgcolor] */
const style = (text, bgcolor = DARK, size = '14') => ({ text, size, color: WHITE, bgcolor })

/**
 * @param {import('./main.js').RodecasterInstance} self
 */
export function updatePresets(self) {
	const dev = self.device
	const strips = dev.strips()
	/** @type {Record<string, any>} */
	const presets = {}
	/** @type {Array<{ id: string, name: string, definitions: string[] }>} */
	const sections = []

	const routingIds = []
	for (const preset of self.routing?.listPresets() ?? []) {
		const id = `routing_${preset.id}`
		presets[id] = {
			type: 'simple',
			name: preset.name,
			style: style(`ROUTING\\n${preset.name}`),
			steps: [{ down: [{ actionId: 'routing_load_preset', options: { preset: preset.id } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'routing_preset_active',
					options: { preset: preset.id },
					style: { bgcolor: GREEN, color: WHITE },
				},
			],
		}
		routingIds.push(id)
	}
	if (routingIds.length) sections.push({ id: 'routing', name: 'Routing', definitions: routingIds })

	const stripIds = []
	for (const s of strips) {
		if (!s.source) continue
		const n = s.index + 1
		presets[`strip_${n}_mute`] = {
			type: 'simple',
			name: `${s.name}: mute`,
			style: style(`$(rodecaster2:strip_${n}_name)\\nMUTE`),
			steps: [{ down: [{ actionId: 'strip_mute', options: { strip: s.index, mode: 'toggle' } }], up: [] }],
			feedbacks: [{ feedbackId: 'strip_muted', options: { strip: s.index }, style: { bgcolor: RED, color: WHITE } }],
		}
		presets[`strip_${n}_cue`] = {
			type: 'simple',
			name: `${s.name}: cue`,
			style: style(`$(rodecaster2:strip_${n}_name)\\nCUE`),
			steps: [{ down: [{ actionId: 'strip_cue', options: { strip: s.index, mode: 'toggle' } }], up: [] }],
			feedbacks: [{ feedbackId: 'strip_cued', options: { strip: s.index }, style: { bgcolor: AMBER, color: BLACK } }],
		}
		presets[`strip_${n}_volume`] = {
			type: 'simple',
			name: `${s.name}: volume dial`,
			style: style(
				`$(rodecaster2:strip_${n}_name)\\n$(rodecaster2:strip_${n}_level_db)\\n$(rodecaster2:strip_${n}_control)`,
			),
			steps: [
				{
					down: [{ actionId: 'strip_mute', options: { strip: s.index, mode: 'toggle' } }],
					up: [],
					rotate_left: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: -2 } }],
					rotate_right: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: 2 } }],
					1000: {
						options: { runWhileHeld: false },
						actions: [{ actionId: 'strip_release', options: { strip: s.index } }],
					},
				},
			],
			feedbacks: [
				{ feedbackId: 'strip_borrowed', options: { strip: s.index }, style: { bgcolor: BLUE, color: WHITE } },
				{ feedbackId: 'strip_muted', options: { strip: s.index }, style: { bgcolor: RED, color: WHITE } },
				{ feedbackId: 'level_control_locked', options: {}, style: { text: `$(rodecaster2:strip_${n}_name)\\nLOCKED` } },
			],
		}
		presets[`strip_${n}_up`] = {
			type: 'simple',
			name: `${s.name}: volume up`,
			style: style(`$(rodecaster2:strip_${n}_name)\\n▲\\n$(rodecaster2:strip_${n}_level_pct)`),
			steps: [
				{
					down: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: 2 } }],
					up: [],
					500: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: 2 } }],
					},
				},
			],
			feedbacks: [
				{ feedbackId: 'strip_borrowed', options: { strip: s.index }, style: { bgcolor: BLUE, color: WHITE } },
			],
		}
		presets[`strip_${n}_down`] = {
			type: 'simple',
			name: `${s.name}: volume down`,
			style: style(`$(rodecaster2:strip_${n}_name)\\n▼\\n$(rodecaster2:strip_${n}_level_pct)`),
			steps: [
				{
					down: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: -2 } }],
					up: [],
					500: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'strip_level_step', options: { strip: s.index, delta: -2 } }],
					},
				},
			],
			feedbacks: [
				{ feedbackId: 'strip_borrowed', options: { strip: s.index }, style: { bgcolor: BLUE, color: WHITE } },
			],
		}
		stripIds.push(`strip_${n}_mute`, `strip_${n}_cue`, `strip_${n}_volume`, `strip_${n}_up`, `strip_${n}_down`)
	}
	presets.restore_faders = {
		type: 'simple',
		name: 'Restore faders (hold 1 s)',
		style: style('RESTORE\\nFADERS\\nhold 1s'),
		steps: [
			{
				down: [],
				up: [],
				1000: { options: { runWhileHeld: false }, actions: [{ actionId: 'restore_faders', options: {} }] },
			},
		],
		feedbacks: [],
	}
	stripIds.push('restore_faders')
	sections.push({ id: 'strips', name: 'Channel strips', definitions: stripIds })

	presets.monitor_dial = {
		type: 'simple',
		name: 'Monitor dial',
		style: style('MONITOR\\n$(rodecaster2:monitor_level_pct)'),
		steps: [
			{
				down: [{ actionId: 'monitor_mute', options: { mode: 'toggle' } }],
				up: [],
				rotate_left: [{ actionId: 'monitor_level_step', options: { delta: -2 } }],
				rotate_right: [{ actionId: 'monitor_level_step', options: { delta: 2 } }],
			},
		],
		feedbacks: [
			{ feedbackId: 'monitor_muted', options: {}, style: { bgcolor: RED, color: WHITE, text: 'MONITOR\\nMUTED' } },
		],
	}
	presets.monitor_up = {
		type: 'simple',
		name: 'Monitor up',
		style: style('MONITOR\\n▲\\n$(rodecaster2:monitor_level_pct)'),
		steps: [
			{
				down: [{ actionId: 'monitor_level_step', options: { delta: 2 } }],
				up: [],
				500: { options: { runWhileHeld: true }, actions: [{ actionId: 'monitor_level_step', options: { delta: 2 } }] },
			},
		],
		feedbacks: [],
	}
	presets.monitor_down = {
		type: 'simple',
		name: 'Monitor down',
		style: style('MONITOR\\n▼\\n$(rodecaster2:monitor_level_pct)'),
		steps: [
			{
				down: [{ actionId: 'monitor_level_step', options: { delta: -2 } }],
				up: [],
				500: { options: { runWhileHeld: true }, actions: [{ actionId: 'monitor_level_step', options: { delta: -2 } }] },
			},
		],
		feedbacks: [],
	}
	presets.monitor_mute = {
		type: 'simple',
		name: 'Monitor mute',
		style: style('MONITOR\\nMUTE'),
		steps: [{ down: [{ actionId: 'monitor_mute', options: { mode: 'toggle' } }], up: [] }],
		feedbacks: [{ feedbackId: 'monitor_muted', options: {}, style: { bgcolor: RED, color: WHITE } }],
	}
	presets.headphones_off = {
		type: 'simple',
		name: 'Headphones off',
		style: style('HEADPHONES\\nOFF'),
		steps: [{ down: [{ actionId: 'headphones_off', options: { mode: 'toggle' } }], up: [] }],
		feedbacks: [{ feedbackId: 'headphones_off', options: {}, style: { bgcolor: RED, color: WHITE } }],
	}
	const headphoneIds = []
	for (let n = 1; n <= 4; n++) {
		presets[`headphone${n}_mute`] = {
			type: 'simple',
			name: `Headphone ${n}: mute mix`,
			style: style(`HP${n}\\nMUTE`),
			steps: [{ down: [{ actionId: 'headphone_mix_mute', options: { headphone: n, mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'headphone_mix_muted', options: { headphone: n }, style: { bgcolor: RED, color: WHITE } },
			],
		}
		headphoneIds.push(`headphone${n}_mute`)
	}
	presets.panic = {
		type: 'simple',
		name: 'Panic mute (hold)',
		style: style('PANIC', combineRgb(90, 0, 0), '18'),
		steps: [
			{ down: [{ actionId: 'panic', options: { mode: 'on' } }], up: [{ actionId: 'panic', options: { mode: 'off' } }] },
		],
		feedbacks: [{ feedbackId: 'panic_active', options: {}, style: { bgcolor: RED, color: WHITE } }],
	}
	sections.push({
		id: 'monitoring',
		name: 'Monitoring',
		definitions: [
			'monitor_dial',
			'monitor_up',
			'monitor_down',
			'monitor_mute',
			'headphones_off',
			...headphoneIds,
			'panic',
		],
	})

	presets.record = {
		type: 'simple',
		name: 'Record / pause',
		style: style('REC\\n$(rodecaster2:record_elapsed)'),
		steps: [{ down: [{ actionId: 'record', options: { mode: 'toggle' } }], up: [] }],
		feedbacks: [
			{ feedbackId: 'record_state', options: { state: 2 }, style: { bgcolor: RED, color: WHITE } },
			{
				feedbackId: 'record_state',
				options: { state: 1 },
				style: { bgcolor: AMBER, color: BLACK, text: 'PAUSED\\n$(rodecaster2:record_elapsed)' },
			},
			{
				feedbackId: 'record_state',
				options: { state: 3 },
				style: { bgcolor: DARK, color: combineRgb(130, 130, 130), text: 'REC\\nno card' },
			},
		],
	}
	presets.record_stop = {
		type: 'simple',
		name: 'Stop recording',
		style: style('STOP'),
		steps: [{ down: [{ actionId: 'record', options: { mode: 'stop' } }], up: [] }],
		feedbacks: [{ feedbackId: 'record_state', options: { state: 2 }, style: { bgcolor: RED, color: WHITE } }],
	}
	presets.drop_marker = {
		type: 'simple',
		name: 'Drop marker',
		style: style('MARKER'),
		steps: [{ down: [{ actionId: 'drop_marker', options: {} }], up: [] }],
		feedbacks: [
			{ feedbackId: 'record_state', options: { state: 2 }, style: { bgcolor: combineRgb(0, 70, 0), color: WHITE } },
		],
	}
	sections.push({ id: 'recording', name: 'Recording', definitions: ['record', 'record_stop', 'drop_marker'] })

	const padIds = []
	for (let p = 0; p < 8; p++) {
		presets[`pad_${p + 1}`] = {
			type: 'simple',
			name: `SMART pad ${p + 1} (current bank)`,
			style: style(`Pad ${p + 1}`),
			steps: [{ down: [{ actionId: 'pad_press', options: { slot: p, bank: -1 } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'pad_colour', options: { slot: p, bank: -1 } },
				{ feedbackId: 'pad_active', options: { slot: p, bank: -1 }, style: { bgcolor: GREEN, color: WHITE } },
			],
		}
		padIds.push(`pad_${p + 1}`)
	}
	presets.pad_bank_next = {
		type: 'simple',
		name: 'Pad bank next',
		style: style('BANK ▶\\n$(rodecaster2:pad_bank)'),
		steps: [{ down: [{ actionId: 'pad_bank', options: { bank: 'next' } }], up: [] }],
		feedbacks: [],
	}
	presets.pad_bank_prev = {
		type: 'simple',
		name: 'Pad bank previous',
		style: style('◀ BANK\\n$(rodecaster2:pad_bank)'),
		steps: [{ down: [{ actionId: 'pad_bank', options: { bank: 'prev' } }], up: [] }],
		feedbacks: [],
	}
	presets.pad_bank_dial = {
		type: 'simple',
		name: 'Pad bank dial',
		style: style('BANK\\n$(rodecaster2:pad_bank)'),
		steps: [
			{
				down: [],
				up: [],
				rotate_left: [{ actionId: 'pad_bank', options: { bank: 'prev' } }],
				rotate_right: [{ actionId: 'pad_bank', options: { bank: 'next' } }],
			},
		],
		feedbacks: [],
	}
	sections.push({
		id: 'pads',
		name: 'SMART pads',
		definitions: [...padIds, 'pad_bank_next', 'pad_bank_prev', 'pad_bank_dial'],
	})

	const fxIds = []
	const fxList = [
		['reverbOn', 'REVERB'],
		['echoOn', 'ECHO'],
		['pitchShiftOn', 'PITCH'],
		['distortionOn', 'DISTORT'],
		['robotOn', 'ROBOT'],
		['voiceDisguiseOn', 'DISGUISE'],
	]
	for (const [effect, label] of fxList) {
		presets[`fx_${effect}`] = {
			type: 'simple',
			name: `Voice FX: ${label.toLowerCase()} (slot 1)`,
			style: style(`FX\\n${label}`),
			steps: [{ down: [{ actionId: 'fx', options: { slot: 0, effect, mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'fx_on',
					options: { slot: 0, effect },
					style: { bgcolor: combineRgb(120, 0, 160), color: WHITE },
				},
			],
		}
		fxIds.push(`fx_${effect}`)
	}
	sections.push({ id: 'fx', name: 'Voice FX', definitions: fxIds })

	presets.screen_dial = {
		type: 'simple',
		name: 'Desk dial: screen brightness',
		style: style('SCREEN\\n$(rodecaster2:screen_brightness)'),
		steps: [
			{
				down: [],
				up: [],
				rotate_left: [{ actionId: 'screen_brightness', options: { op: 'step', value: -10 } }],
				rotate_right: [{ actionId: 'screen_brightness', options: { op: 'step', value: 10 } }],
			},
		],
		feedbacks: [],
	}
	presets.ducker_dial = {
		type: 'simple',
		name: 'Desk dial: ducker depth',
		style: style('DUCKER\\n$(rodecaster2:ducker_depth_db) dB'),
		steps: [
			{
				down: [],
				up: [],
				rotate_left: [{ actionId: 'ducker_depth', options: { op: 'step', value: -1 } }],
				rotate_right: [{ actionId: 'ducker_depth', options: { op: 'step', value: 1 } }],
			},
		],
		feedbacks: [],
	}
	presets.connected = {
		type: 'simple',
		name: 'Desk status',
		style: style('$(rodecaster2:model)\\n$(rodecaster2:firmware)'),
		steps: [{ down: [], up: [] }],
		feedbacks: [{ feedbackId: 'connected', options: {}, style: { bgcolor: GREEN, color: WHITE } }],
	}
	sections.push({ id: 'desk', name: 'Desk', definitions: ['screen_dial', 'ducker_dial', 'connected'] })

	self.setPresetDefinitions(sections, presets)
}
