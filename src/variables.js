import { formatElapsed, levelToDbText, levelToFader, levelToPercentText, recordStateLabel } from './model.js'

const MAX_STRIPS = 11
const FX_NAMES = {
	reverbOn: 'reverb',
	echoOn: 'echo',
	pitchShiftOn: 'pitch',
	distortionOn: 'distortion',
	robotOn: 'robot',
	voiceDisguiseOn: 'disguise',
}

/**
 * @param {import('./main.js').RodecasterInstance} self
 */
export function updateVariableDefinitions(self) {
	/** @type {Record<string, { name: string }>} */
	const defs = {
		connected: { name: 'Desk connected (true/false)' },
		model: { name: 'Desk model' },
		firmware: { name: 'Desk firmware version' },
		monitor_level_pct: { name: 'Monitor level (%)' },
		monitor_level_db: { name: 'Monitor level (dB, approximate)' },
		monitor_muted: { name: 'Monitor muted (true/false)' },
		headphones_off: { name: 'All headphones off (true/false)' },
		bluetooth_level_pct: { name: 'Bluetooth send level (%)' },
		panic_active: { name: 'Panic mute active (true/false)' },
		record_state: { name: 'Recorder state (Ready / Recording / Paused / No destination)' },
		record_state_code: { name: 'Recorder state code (0-3)' },
		record_elapsed: { name: 'Recording elapsed time (mm:ss)' },
		record_elapsed_s: { name: 'Recording elapsed time (seconds)' },
		pad_bank: { name: 'Selected SMART pad bank (1-8)' },
		screen_brightness: { name: 'Screen brightness (0-255)' },
		buttons_brightness: { name: 'Button brightness (0-255)' },
		ducker_depth_db: { name: 'Ducker depth (dB)' },
		level_control: { name: 'Level control (enabled/locked)' },
	}
	for (let n = 1; n <= 4; n++) {
		defs[`headphone${n}_muted`] = { name: `Headphone ${n} mix muted (true/false)` }
	}
	for (let i = 1; i <= MAX_STRIPS; i++) {
		defs[`strip_${i}_name`] = { name: `Strip ${i} name` }
		defs[`strip_${i}_source`] = { name: `Strip ${i} input source` }
		defs[`strip_${i}_muted`] = { name: `Strip ${i} muted (true/false)` }
		defs[`strip_${i}_cued`] = { name: `Strip ${i} cued (true/false)` }
		defs[`strip_${i}_fader`] = { name: `Strip ${i} physical fader (0-127)` }
		defs[`strip_${i}_level_pct`] = { name: `Strip ${i} level (%)` }
		defs[`strip_${i}_level_db`] = { name: `Strip ${i} level (dB, approximate)` }
		defs[`strip_${i}_control`] = { name: `Strip ${i} control (FADER / DIAL / LOCKED)` }
	}
	for (let p = 1; p <= 8; p++) {
		defs[`pad_${p}_name`] = { name: `Pad ${p} name (current bank)` }
		defs[`pad_${p}_active`] = { name: `Pad ${p} active (current bank)` }
	}
	for (let s = 1; s <= 4; s++) {
		for (const fx of Object.values(FX_NAMES)) defs[`fx_${s}_${fx}`] = { name: `FX slot ${s} ${fx} on (true/false)` }
	}
	self.setVariableDefinitions(defs)
}

/**
 * @param {import('./main.js').RodecasterInstance} self
 * @param {'strips' | 'monitor' | 'recorder' | 'pads' | 'fx' | 'gui' | 'system' | 'all'} area
 */
export function updateVariableValues(self, area) {
	const dev = self.device
	/** @type {Record<string, any>} */
	const v = {}
	const all = area === 'all'
	if (all || area === 'system') {
		v.connected = dev.ready
		v.model = dev.ready ? dev.capabilities.model : ''
		v.firmware = dev.ready ? (dev.capabilities.firmware ?? '') : ''
		v.level_control = dev.levelControlEnabled ? 'enabled' : 'locked'
		v.panic_active = dev.panicActive
	}
	if (all || area === 'strips') {
		const strips = dev.strips()
		for (let i = 1; i <= MAX_STRIPS; i++) {
			const s = strips[i - 1]
			v[`strip_${i}_name`] = s ? s.name : ''
			v[`strip_${i}_source`] = s?.source ?? ''
			v[`strip_${i}_muted`] = s ? s.muted : false
			v[`strip_${i}_cued`] = s ? s.cued : false
			v[`strip_${i}_fader`] = s ? levelToFader(s.faderLevel) : 0
			v[`strip_${i}_level_pct`] = s ? levelToPercentText(s.level) : ''
			v[`strip_${i}_level_db`] = s ? levelToDbText(s.level) : ''
			v[`strip_${i}_control`] = s ? s.control.toUpperCase() : ''
		}
		v.panic_active = dev.panicActive
	}
	if (all || area === 'monitor') {
		v.monitor_level_pct = levelToPercentText(dev.monitorLevel)
		v.monitor_level_db = levelToDbText(dev.monitorLevel)
		v.monitor_muted = dev.monitorMuted
		v.headphones_off = dev.headphonesOff
		for (let n = 1; n <= 4; n++) v[`headphone${n}_muted`] = dev.ready && dev.headphoneMixMuted(n)
		v.bluetooth_level_pct = levelToPercentText(dev.bluetoothLevel)
	}
	if (all || area === 'recorder') {
		const state = dev.recordState
		v.record_state = dev.ready ? recordStateLabel(state) : ''
		v.record_state_code = state ?? -1
		v.record_elapsed = formatElapsed(dev.recordElapsedSeconds)
		v.record_elapsed_s = Math.floor(dev.recordElapsedSeconds)
	}
	if (all || area === 'pads') {
		v.pad_bank = dev.padBank + 1
		for (let p = 1; p <= 8; p++) {
			const pad = dev.ready ? dev.pad(p - 1) : null
			v[`pad_${p}_name`] = pad?.name ?? ''
			v[`pad_${p}_active`] = pad?.active ?? false
		}
	}
	if (all || area === 'fx') {
		for (let s = 1; s <= 4; s++) {
			for (const [prop, fx] of Object.entries(FX_NAMES)) v[`fx_${s}_${fx}`] = dev.fxOn(s - 1, prop)
		}
	}
	if (all || area === 'gui') {
		v.screen_brightness = dev.screenBrightness
		v.buttons_brightness = dev.buttonsBrightness
		v.ducker_depth_db = dev.duckerDepth
		v.pad_bank = dev.padBank + 1
	}
	self.setVariableValues(v)
}
