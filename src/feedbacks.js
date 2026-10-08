import { combineRgb } from '@companion-module/base'
import { FX_CHOICES } from './actions.js'
import { padColour } from './model.js'

const RED = combineRgb(204, 0, 0)
const GREEN = combineRgb(0, 153, 0)
const AMBER = combineRgb(230, 150, 0)
const BLUE = combineRgb(0, 90, 200)
const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)

/**
 * @param {import('./main.js').RodecasterInstance} self
 */
export function updateFeedbacks(self) {
	const dev = self.device
	const strips = dev.strips()
	const stripChoices = strips.map((s) => ({ id: s.index, label: `${s.index + 1}: ${s.name}` }))
	if (stripChoices.length === 0) stripChoices.push({ id: 0, label: 'Strip 1' })
	const stripField = {
		id: 'strip',
		type: 'dropdown',
		label: 'Strip',
		default: stripChoices[0].id,
		choices: stripChoices,
	}
	const slotChoices = Array.from({ length: 8 }, (_, i) => ({ id: i, label: `Pad ${i + 1}` }))
	const bankChoices = [
		{ id: -1, label: 'Current bank' },
		...Array.from({ length: 8 }, (_, i) => ({ id: i, label: `Bank ${i + 1}` })),
	]
	const routingChoices = (self.routing?.listPresets() ?? []).map((preset) => ({ id: preset.id, label: preset.name }))
	if (routingChoices.length === 0) routingChoices.push({ id: '', label: 'Save a preset on the routing page first' })

	self.setFeedbackDefinitions({
		routing_preset_active: {
			type: 'boolean',
			name: 'Routing preset active',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'preset', type: 'dropdown', label: 'Preset', default: routingChoices[0].id, choices: routingChoices },
			],
			callback: (f) => Boolean(dev.ready && self.routing?.presetMatches(String(f.options.preset))),
		},
		strip_muted: {
			type: 'boolean',
			name: 'Channel is muted',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [stripField],
			callback: (f) => dev.ready && dev.strip(Number(f.options.strip)).muted,
		},
		strip_cued: {
			type: 'boolean',
			name: 'Channel is cued',
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [stripField],
			callback: (f) => dev.ready && dev.strip(Number(f.options.strip)).cued,
		},
		strip_borrowed: {
			type: 'boolean',
			name: 'Channel level is driven by Companion (DIAL)',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [stripField],
			callback: (f) => dev.ready && dev.strip(Number(f.options.strip)).control === 'dial',
		},
		level_control_locked: {
			type: 'boolean',
			name: 'Level control is locked',
			defaultStyle: { bgcolor: combineRgb(60, 60, 60), color: combineRgb(160, 160, 160) },
			options: [],
			callback: () => !dev.levelControlEnabled,
		},
		monitor_muted: {
			type: 'boolean',
			name: 'Monitor is muted',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => dev.ready && dev.monitorMuted,
		},
		headphones_off: {
			type: 'boolean',
			name: 'All headphones are off',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => dev.ready && dev.headphonesOff,
		},
		headphone_mix_muted: {
			type: 'boolean',
			name: 'Headphone mix is muted',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				{
					id: 'headphone',
					type: 'dropdown',
					label: 'Headphone',
					default: 1,
					choices: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, label: `Headphone ${i + 1}` })),
				},
			],
			callback: (f) => dev.ready && dev.headphoneMixMuted(Number(f.options.headphone)),
		},
		panic_active: {
			type: 'boolean',
			name: 'Panic mute is active',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => dev.panicActive,
		},
		record_state: {
			type: 'boolean',
			name: 'Recorder state',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 2,
					choices: [
						{ id: 2, label: 'Recording' },
						{ id: 1, label: 'Paused' },
						{ id: 0, label: 'Ready' },
						{ id: 3, label: 'No destination' },
					],
				},
			],
			callback: (f) => dev.ready && dev.recordState === Number(f.options.state),
		},
		pad_active: {
			type: 'boolean',
			name: 'SMART pad is active (playing / engaged)',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'slot', type: 'dropdown', label: 'Pad', default: 0, choices: slotChoices },
				{ id: 'bank', type: 'dropdown', label: 'Bank', default: -1, choices: bankChoices },
			],
			callback: (f) => {
				const bank = Number(f.options.bank)
				return Boolean(dev.ready && dev.pad(Number(f.options.slot), bank < 0 ? null : bank)?.active)
			},
		},
		pad_colour: {
			type: 'advanced',
			name: 'SMART pad colour and name',
			description: "Paints the button in the pad's colour and shows its name; empty slots go dark.",
			options: [
				{ id: 'slot', type: 'dropdown', label: 'Pad', default: 0, choices: slotChoices },
				{ id: 'bank', type: 'dropdown', label: 'Bank', default: -1, choices: bankChoices },
			],
			callback: (f) => {
				const bank = Number(f.options.bank)
				const pad = dev.ready ? dev.pad(Number(f.options.slot), bank < 0 ? null : bank) : null
				if (!pad)
					return {
						bgcolor: combineRgb(30, 30, 30),
						color: combineRgb(120, 120, 120),
						text: `Pad ${Number(f.options.slot) + 1}`,
					}
				const bg = padColour(pad.colour)
				const luma = ((bg >> 16) & 255) * 0.299 + ((bg >> 8) & 255) * 0.587 + (bg & 255) * 0.114
				return { bgcolor: bg, color: luma > 150 ? BLACK : WHITE, text: pad.name || `Pad ${pad.slot + 1}` }
			},
		},
		pad_bank: {
			type: 'boolean',
			name: 'SMART pad bank is selected',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [{ id: 'bank', type: 'dropdown', label: 'Bank', default: 0, choices: bankChoices.slice(1) }],
			callback: (f) => dev.ready && dev.padBank === Number(f.options.bank),
		},
		fx_on: {
			type: 'boolean',
			name: 'Voice FX is on',
			defaultStyle: { bgcolor: combineRgb(120, 0, 160), color: WHITE },
			options: [
				{
					id: 'slot',
					type: 'dropdown',
					label: 'Slot',
					default: 0,
					choices: Array.from({ length: Math.max(dev.fxSlotCount, 4) }, (_, i) => ({ id: i, label: `Slot ${i + 1}` })),
				},
				{ id: 'effect', type: 'dropdown', label: 'Effect', default: 'reverbOn', choices: FX_CHOICES },
			],
			callback: (f) => dev.ready && dev.fxOn(Number(f.options.slot), String(f.options.effect)),
		},
		connected: {
			type: 'boolean',
			name: 'Desk is connected',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => dev.ready,
		},
	})
}
