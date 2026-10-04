/**
 * RodecasterDevice: connection lifecycle plus a desk-level API on top of the
 * protocol session. Everything the Companion instance needs goes through here.
 *
 * Emits:
 *  - 'status'  (state: 'connecting' | 'ready' | 'disconnected', message?)
 *  - 'update'  (area: 'strips' | 'monitor' | 'recorder' | 'pads' | 'fx' | 'gui' | 'system' | 'all')
 *  - 'log'     (level, message)
 *  - 'borrowed' (list of currently borrowed sends, for persistence)
 */
import { EventEmitter } from 'node:events'
import {
	ProtocolSession,
	Reassembler,
	encodeReports,
	encodePropertyChanged,
	modeNormalReport,
	sessionOpenReport,
	HANDSHAKE_PAUSE_MS,
	REPORT_ID_OUT,
	Fader,
	Source,
	MixOutput,
	V,
	pressValue,
	asInt,
	asBool,
	asString,
} from './protocol/index.js'
import { HidTransport } from './hid-transport.js'
import { RecordClock, defaultStripName, parseMixLevel, formatMixLevel, clamp01, faderToLevel } from './model.js'

const RECONNECT_MS = 3000
const READY_TIMEOUT_MS = 8000
const PAD_PRESS_MS = 80
const CHANNEL_SOURCE_UNASSIGNED = -1

/**
 * @typedef {object} StripInfo
 * @property {number} index 0-based strip
 * @property {string} faderId names.js Fader id
 * @property {string | null} source Source id or null
 * @property {number} sourceOrdinal protocol ordinal or -1
 * @property {string} name display name (override or default)
 * @property {boolean} muted
 * @property {boolean} cued
 * @property {number} faderLevel 0..1 physical fader position (anchor)
 * @property {number} level 0..1 effective send level (fader when linked)
 * @property {'fader' | 'dial' | 'locked' | 'none'} control
 */

/**
 * @typedef {{ source: number, mixes: number[], anchor: number }} BorrowedStrip
 */

export class RodecasterDevice extends EventEmitter {
	/**
	 * @param {{ serial?: string, stripNames?: string[], levelControl?: boolean, monitorMethod?: 'property' | 'encoder' }} options
	 */
	constructor(options = {}) {
		super()
		this.options = { serial: '', stripNames: [], levelControl: false, monitorMethod: 'property', ...options }
		this.transport = new HidTransport()
		this.session = new ProtocolSession()
		this.reasm = new Reassembler()
		this.clock = new RecordClock()
		this.running = false
		this.ready = false
		/** @type {NodeJS.Timeout | null} */
		this.reconnectTimer = null
		/** @type {NodeJS.Timeout | null} */
		this.readyTimer = null
		/** @type {Map<number, BorrowedStrip>} strip index -> borrowed sends */
		this.borrowed = new Map()
		/** @type {{ strips: boolean[], monMute: boolean, phonesOff: boolean, btMute: boolean } | null} */
		this.panicSnapshot = null
		/** @type {Array<{ source: number, mixes: number[] }>} sends to relink on the next ready */
		this.pendingRepair = []
		this.encoderPhase = false

		this.session.on('ready', () => this.onReady())
		this.session.on('change', (c) => this.onChange(c))
		this.session.on('needsFullSync', () => this.resync())
		this.transport.on('report', (buf) => this.onReport(buf))
		this.transport.on('close', (err) => this.onClosed(err))
	}

	// ---------------------------------------------------------------- lifecycle

	/** @param {Partial<typeof this.options>} options */
	setOptions(options) {
		Object.assign(this.options, options)
		this.emit('update', 'all')
	}

	start() {
		if (this.running) return
		this.running = true
		void this.connect()
	}

	async stop() {
		this.running = false
		this.clearTimers()
		if (this.borrowed.size > 0) await this.restoreFaders().catch(() => {})
		await this.transport.close()
		this.ready = false
		this.session.reset()
	}

	clearTimers() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.readyTimer) clearTimeout(this.readyTimer)
		this.reconnectTimer = null
		this.readyTimer = null
	}

	async connect() {
		if (!this.running || this.transport.isOpen) return
		this.emit('status', 'connecting')
		try {
			const info = await this.transport.open(this.options.serial || undefined)
			this.log('info', `opened ${info.product} ${info.serialNumber} (pid 0x${info.productId.toString(16)})`)
			this.reasm = new Reassembler()
			this.session.reset()
			await this.handshake()
			this.readyTimer = setTimeout(() => {
				if (!this.ready) {
					this.log('warn', 'no full sync within 8 s, reopening')
					void this.transport.close().then(() => this.onClosed())
				}
			}, READY_TIMEOUT_MS)
		} catch (err) {
			this.emit('status', 'disconnected', err.message)
			this.scheduleReconnect()
		}
	}

	async handshake() {
		await this.transport.write(modeNormalReport())
		await new Promise((r) => setTimeout(r, HANDSHAKE_PAUSE_MS))
		await this.transport.write(sessionOpenReport())
	}

	async resync() {
		this.ready = false
		this.borrowedBeforeResync = new Map(this.borrowed)
		this.log('debug', 'layout changed, requesting a new full sync')
		try {
			await this.transport.write(sessionOpenReport())
		} catch (err) {
			this.log('warn', `resync failed: ${err.message}`)
		}
	}

	scheduleReconnect() {
		if (!this.running || this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			void this.connect()
		}, RECONNECT_MS)
	}

	/** @param {Error} [err] */
	onClosed(err) {
		const wasReady = this.ready
		this.ready = false
		this.clearTimers()
		this.session.reset()
		if (wasReady || err) this.emit('status', 'disconnected', err?.message ?? 'desk disconnected')
		this.emit('update', 'all')
		this.scheduleReconnect()
	}

	/** @param {Buffer} buf */
	onReport(buf) {
		for (const body of this.reasm.push(buf)) {
			try {
				this.session.ingest(body)
			} catch (err) {
				if (err.code !== 'notReady') this.log('debug', `ingest: ${err.message}`)
			}
		}
	}

	onReady() {
		if (this.readyTimer) clearTimeout(this.readyTimer)
		this.readyTimer = null
		this.ready = true
		const caps = this.session.capabilities
		this.log('info', `ready: ${caps.model} firmware ${caps.firmware}, ${caps.faders.length} strips`)
		this.clock.apply(this.recordState)
		this.emit('status', 'ready')
		this.emit('update', 'all')
		void this.repairOnStart()
	}

	/** @param {'debug' | 'info' | 'warn' | 'error'} level @param {string} message */
	log(level, message) {
		this.emit('log', level, message)
	}

	// ---------------------------------------------------------------- tree access

	get tree() {
		return this.session.tree
	}

	get layout() {
		return this.session.layout
	}

	get capabilities() {
		return this.session.capabilities
	}

	/**
	 * @param {number[] | null} path
	 * @param {string} name
	 */
	prop(path, name) {
		if (!path || !this.tree) return undefined
		return this.tree.getByPath(path)?.properties.get(name)
	}

	/** @param {number[] | null} path @param {string} name */
	propBool(path, name) {
		const v = this.prop(path, name)
		return v === undefined ? undefined : asBool(v)
	}

	/** @param {number[] | null} path @param {string} name */
	propInt(path, name) {
		const v = this.prop(path, name)
		return v === undefined ? undefined : asInt(v)
	}

	/** @param {number[] | null} path @param {string} name */
	propNumber(path, name) {
		const v = this.prop(path, name)
		if (v === undefined) return undefined
		if (v.type === 'double') return v.value
		return asInt(v)
	}

	/** @param {number[] | null} path @param {string} name */
	propString(path, name) {
		const v = this.prop(path, name)
		return v === undefined ? undefined : asString(v)
	}

	/**
	 * Write one property. The desk never echoes our own writes, so the local
	 * tree is updated here; side-effect pushes still arrive normally.
	 * Refuses names the node does not already have (a write to an unknown name
	 * would create a stray property that only a factory reset removes).
	 * @param {number[] | null} path
	 * @param {string} name
	 * @param {import('./protocol/juce-var.js').Value} value
	 */
	async write(path, name, value) {
		if (!this.ready || !this.tree || !path) throw new Error('desk not connected')
		const node = this.tree.getByPath(path)
		if (!node) throw new Error(`no node at ${path.join('/')}`)
		if (!node.properties.has(name)) throw new Error(`${node.type} has no property ${name}; refusing to create it`)
		const body = encodePropertyChanged(path, name, value)
		for (const report of encodeReports(body, REPORT_ID_OUT)) await this.transport.write(report)
		node.properties.set(name, value)
	}

	/**
	 * Root-level node of a given type (first occurrence), for nodes the layout
	 * does not index (ENCODER, EMERGENCYMUTE, ...).
	 * @param {string} type
	 * @returns {number[] | null}
	 */
	rootPathOfType(type) {
		if (!this.tree) return null
		const idx = this.tree.children.findIndex((c) => c.type === type)
		return idx < 0 ? null : [idx]
	}

	// ---------------------------------------------------------------- strips

	get stripCount() {
		return this.ready ? this.layout.faderCount : 0
	}

	/** @param {number} i */
	channelPath(i) {
		return this.ready ? this.layout.channelPath(i) : null
	}

	/** @param {number} i */
	faderPath(i) {
		return this.ready ? this.layout.faderPath(i) : null
	}

	/** Protocol source ordinal of strip `i`, or -1. @param {number} i */
	stripSourceOrdinal(i) {
		const v = this.propInt(this.channelPath(i), 'channelInputSource')
		return v === undefined ? -1 : v
	}

	/** @param {number} i @returns {string | null} */
	stripSource(i) {
		const ord = this.stripSourceOrdinal(i)
		if (ord === CHANNEL_SOURCE_UNASSIGNED || ord < 0) return null
		return Source.fromProtocol(ord) ?? null
	}

	/** @param {number} i */
	stripName(i) {
		const override = this.options.stripNames?.[i]
		if (override) return override
		return defaultStripName(this.stripSource(i), i)
	}

	/**
	 * Mix cells of a strip's source, with their current state.
	 * @param {number} i
	 * @returns {Array<{ mix: number, path: number[], link: boolean, disabled: boolean, mute: boolean, level: number, anchor: number }>}
	 */
	stripCells(i) {
		const source = this.stripSourceOrdinal(i)
		if (source < 0 || !this.ready) return []
		const out = []
		for (let mix = 0; mix < this.layout.mixCountPerSource; mix++) {
			const path = this.layout.mixCellPath(source, mix)
			if (!path) continue
			const lvl = parseMixLevel(this.propString(path, 'mixLevelWithAnchor')) ?? { level: 0, anchor: 0 }
			out.push({
				mix,
				path,
				link: this.propBool(path, 'mixLink') ?? true,
				disabled: this.propBool(path, 'mixDisabled') ?? false,
				mute: this.propBool(path, 'mixMute') ?? false,
				level: lvl.level,
				anchor: lvl.anchor,
			})
		}
		return out
	}

	/** @param {number} i @returns {StripInfo} */
	strip(i) {
		const cells = this.stripCells(i)
		const source = this.stripSource(i)
		const faderUnits = this.propInt(this.faderPath(i), 'faderLevel')
		// The physical fader is not pushed live; the cells' anchor is.
		const anchor = cells.length ? cells[0].anchor : faderUnits === undefined ? 0 : faderToLevel(faderUnits)
		const borrowed = this.borrowed.get(i)
		const linked = cells.find((c) => c.link && !c.disabled)
		const level = borrowed
			? (cells.find((c) => borrowed.mixes.includes(c.mix))?.level ?? anchor)
			: (linked?.level ?? anchor)
		/** @type {StripInfo['control']} */
		let control = 'fader'
		if (!source) control = 'none'
		else if (borrowed) control = 'dial'
		else if (!this.options.levelControl) control = 'locked'
		return {
			index: i,
			faderId: Fader.fromIndex(this.layout.model, i) ?? `strip${i + 1}`,
			source,
			sourceOrdinal: this.stripSourceOrdinal(i),
			name: this.stripName(i),
			muted: this.propBool(this.channelPath(i), 'channelOutputMute') ?? false,
			cued: this.propBool(this.channelPath(i), 'channelCueEnable') ?? false,
			faderLevel: anchor,
			level,
			control,
		}
	}

	/** @returns {StripInfo[]} */
	strips() {
		const out = []
		for (let i = 0; i < this.stripCount; i++) out.push(this.strip(i))
		return out
	}

	/** @param {number} i @param {boolean} muted */
	async setStripMute(i, muted) {
		await this.write(this.channelPath(i), 'channelOutputMute', V.bool(muted))
		this.emit('update', 'strips')
	}

	/** @param {number} i @param {boolean} cued */
	async setStripCue(i, cued) {
		await this.write(this.channelPath(i), 'channelCueEnable', V.bool(cued))
		this.emit('update', 'strips')
	}

	// ---------------------------------------------------------------- level control (borrowing)

	get levelControlEnabled() {
		return Boolean(this.options.levelControl)
	}

	/**
	 * Take the strip's linked sends away from the physical fader so their level
	 * can be driven. Sends the user disabled or already unlinked are left alone.
	 * @param {number} i
	 */
	async borrowStrip(i) {
		if (!this.levelControlEnabled) throw new Error('level control is locked (enable it in the connection settings)')
		if (this.borrowed.has(i)) return this.borrowed.get(i)
		const source = this.stripSourceOrdinal(i)
		if (source < 0) throw new Error(`strip ${i + 1} has no input source`)
		const cells = this.stripCells(i).filter((c) => c.link && !c.disabled)
		if (cells.length === 0) throw new Error(`strip ${i + 1} has no linked sends to borrow`)
		const entry = { source, mixes: cells.map((c) => c.mix), anchor: cells[0].anchor }
		this.borrowed.set(i, entry)
		this.emit('borrowed', this.borrowedList())
		for (const c of cells) {
			await this.write(c.path, 'mixUnlinkRequest', pressValue())
			this.tree.getByPath(c.path)?.properties.set('mixLink', V.bool(false))
		}
		this.emit('update', 'strips')
		return entry
	}

	/**
	 * Drive a borrowed strip to `level` (0..1), borrowing it first if needed.
	 * @param {number} i
	 * @param {number} level
	 */
	async setStripLevel(i, level) {
		const entry = await this.borrowStrip(i)
		const target = clamp01(level)
		for (const c of this.stripCells(i)) {
			if (!entry.mixes.includes(c.mix)) continue
			await this.write(c.path, 'mixLevelWithAnchor', V.string(formatMixLevel(target, c.anchor)))
		}
		this.emit('update', 'strips')
	}

	/** @param {number} i @param {number} delta signed, 0..1 scale */
	async stepStripLevel(i, delta) {
		const current = this.strip(i).level
		await this.setStripLevel(i, current + delta)
	}

	/**
	 * Hand a strip back to its fader: relink every send this module unlinked.
	 * @param {number} i
	 */
	async releaseStrip(i) {
		const entry = this.borrowed.get(i)
		if (!entry) return
		await this.relinkSends(entry.source, entry.mixes)
		this.borrowed.delete(i)
		this.emit('borrowed', this.borrowedList())
		this.emit('update', 'strips')
	}

	/** @param {number} source @param {number[]} mixes */
	async relinkSends(source, mixes) {
		for (const mix of mixes) {
			const path = this.layout.mixCellPath(source, mix)
			if (!path) continue
			if (this.propBool(path, 'mixLink') === true) continue
			await this.write(path, 'mixLinkRequest', pressValue())
			this.tree.getByPath(path)?.properties.set('mixLink', V.bool(true))
		}
	}

	/** Relink everything this module borrowed. */
	async restoreFaders() {
		for (const i of [...this.borrowed.keys()]) await this.releaseStrip(i)
	}

	/** @returns {Array<{ strip: number, source: number, mixes: number[] }>} */
	borrowedList() {
		return [...this.borrowed.entries()].map(([strip, e]) => ({ strip, source: e.source, mixes: e.mixes }))
	}

	/**
	 * Sends recorded as borrowed by a previous run (persisted by the instance):
	 * relinked on the next ready so a crash never leaves a fader disconnected.
	 * @param {Array<{ source: number, mixes: number[] }>} list
	 */
	setPendingRepair(list) {
		this.pendingRepair = Array.isArray(list) ? list : []
	}

	async repairOnStart() {
		const pending = this.pendingRepair
		this.pendingRepair = []
		// After a resync (layout change) the borrowed map survives; re-apply nothing.
		if (this.borrowedBeforeResync) {
			this.borrowedBeforeResync = null
		}
		for (const entry of pending) {
			try {
				await this.relinkSends(entry.source, entry.mixes)
				this.log('info', `relinked sends of source ${entry.source} left borrowed by a previous run`)
			} catch (err) {
				this.log('warn', `could not relink source ${entry.source}: ${err.message}`)
			}
		}
		if (pending.length) this.emit('borrowed', this.borrowedList())
	}

	// ---------------------------------------------------------------- monitor / headphones / bluetooth

	get outputPath() {
		return this.ready ? this.layout.singletonPath('output') : null
	}

	get systemPath() {
		return this.ready ? this.layout.singletonPath('system') : null
	}

	get guiPath() {
		return this.ready ? this.layout.singletonPath('gui') : null
	}

	get duckerPath() {
		return this.ready ? this.layout.singletonPath('ducker') : null
	}

	get recorderPath() {
		return this.ready ? this.layout.singletonPath('recorder') : null
	}

	get monitorLevel() {
		return this.propNumber(this.outputPath, 'outputMonLevel') ?? 0
	}

	get monitorMuted() {
		return this.propBool(this.outputPath, 'outputMonMute') ?? false
	}

	get bluetoothLevel() {
		return this.propNumber(this.outputPath, 'outputBTLevel') ?? 0
	}

	get headphonesOff() {
		return this.propBool(this.systemPath, 'disableAllHeadphoneOutputs') ?? false
	}

	/** @param {number} level 0..1 */
	async setMonitorLevel(level) {
		const target = Math.round(clamp01(level) * 100) / 100
		if (this.options.monitorMethod === 'encoder') {
			const ticks = Math.round((target - this.monitorLevel) * 100)
			await this.encoderTicks(ticks)
			return
		}
		await this.write(this.outputPath, 'outputMonLevel', V.double(target))
		this.emit('update', 'monitor')
	}

	/** @param {number} delta signed, 0..1 scale */
	async stepMonitorLevel(delta) {
		await this.setMonitorLevel(this.monitorLevel + delta)
	}

	/**
	 * Emulate the big encoder: one tick = 0.01 of monitor level when the desk
	 * has the encoder on the monitor (its default). Alternates the phase bool
	 * like the hardware does so every tick is a distinct change.
	 * @param {number} ticks signed
	 */
	async encoderTicks(ticks) {
		const path = this.rootPathOfType('ENCODER')
		if (!path) throw new Error('no ENCODER node')
		const n = Math.min(100, Math.abs(ticks))
		const delta = ticks < 0 ? -1 : 1
		for (let k = 0; k < n; k++) {
			this.encoderPhase = !this.encoderPhase
			await this.write(path, 'encoderSignal', V.binary(encoderSignal(delta, this.encoderPhase)))
		}
	}

	/** @param {boolean} muted */
	async setMonitorMute(muted) {
		await this.write(this.outputPath, 'outputMonMute', V.bool(muted))
		this.emit('update', 'monitor')
	}

	/** @param {boolean} off */
	async setHeadphonesOff(off) {
		await this.write(this.systemPath, 'disableAllHeadphoneOutputs', V.bool(off))
		this.emit('update', 'monitor')
	}

	/** @param {number} level 0..1 */
	async setBluetoothLevel(level) {
		await this.write(this.outputPath, 'outputBTLevel', V.double(clamp01(level)))
		this.emit('update', 'monitor')
	}

	// ---------------------------------------------------------------- panic

	get panicActive() {
		return this.panicSnapshot !== null
	}

	/**
	 * Mute every strip, the monitor and all headphones at once, remembering
	 * what was already muted so release restores exactly that.
	 */
	async panic() {
		if (this.panicSnapshot) return
		const strips = this.strips()
		this.panicSnapshot = {
			strips: strips.map((s) => s.muted),
			monMute: this.monitorMuted,
			phonesOff: this.headphonesOff,
			btMute: this.propBool(this.outputPath, 'outputBTMute') ?? false,
		}
		for (const s of strips)
			if (s.source && !s.muted) await this.write(this.channelPath(s.index), 'channelOutputMute', V.bool(true))
		if (!this.panicSnapshot.monMute) await this.write(this.outputPath, 'outputMonMute', V.bool(true))
		if (!this.panicSnapshot.btMute) await this.write(this.outputPath, 'outputBTMute', V.bool(true))
		if (!this.panicSnapshot.phonesOff) await this.write(this.systemPath, 'disableAllHeadphoneOutputs', V.bool(true))
		this.emit('update', 'all')
	}

	async releasePanic() {
		const snap = this.panicSnapshot
		if (!snap) return
		this.panicSnapshot = null
		for (let i = 0; i < snap.strips.length && i < this.stripCount; i++) {
			if (!snap.strips[i] && this.stripSource(i))
				await this.write(this.channelPath(i), 'channelOutputMute', V.bool(false))
		}
		if (!snap.monMute) await this.write(this.outputPath, 'outputMonMute', V.bool(false))
		if (!snap.btMute) await this.write(this.outputPath, 'outputBTMute', V.bool(false))
		if (!snap.phonesOff) await this.write(this.systemPath, 'disableAllHeadphoneOutputs', V.bool(false))
		this.emit('update', 'all')
	}

	// ---------------------------------------------------------------- recorder

	get recordState() {
		return this.propInt(this.recorderPath, 'recordState')
	}

	get recordElapsedSeconds() {
		return this.clock.elapsedSeconds
	}

	/** @param {0 | 1 | 2} state 0 stop, 1 pause, 2 record */
	async requestRecord(state) {
		await this.write(this.recorderPath, 'requestRecordState', V.int(state))
	}

	async dropMarker() {
		await this.write(this.recorderPath, 'requestDropMarker', V.double(1))
	}

	// ---------------------------------------------------------------- SMART pads

	get padBank() {
		return this.propInt(this.guiPath, 'selectedBank') ?? 0
	}

	/** @param {number} bank 0..7 */
	async setPadBank(bank) {
		await this.write(this.guiPath, 'selectedBank', V.int(Math.max(0, Math.min(7, bank))))
		this.emit('update', 'pads')
	}

	/** PADBUTTON nodes under PHYSICALINTERFACE. @returns {number[][]} paths */
	padButtonPaths() {
		if (!this.ready) return []
		const physIdx = this.layout.physicalInterfaceIdx
		const phys = this.tree.children[physIdx]
		const out = []
		phys?.children.forEach((c, idx) => {
			if (c.type === 'PADBUTTON') out.push([physIdx, idx])
		})
		return out
	}

	/**
	 * Fire a pad: slot 0..7 of the current bank, or of `bank` (switches first).
	 * @param {number} slot
	 * @param {number | null} bank
	 */
	async pressPad(slot, bank = null) {
		if (bank !== null && bank !== this.padBank) await this.setPadBank(bank)
		const paths = this.padButtonPaths()
		const path = paths[slot]
		if (!path) throw new Error(`no pad button ${slot + 1}`)
		await this.write(path, 'padButtonPressed', V.bool(true))
		await new Promise((r) => setTimeout(r, PAD_PRESS_MS))
		await this.write(path, 'padButtonPressed', V.bool(false))
	}

	/**
	 * Configured pads (SOUNDPADS/PAD nodes), keyed by their desk index.
	 * @returns {Map<number, { idx: number, bank: number, slot: number, name: string, colour: number, active: boolean, type: number }>}
	 */
	pads() {
		const out = new Map()
		if (!this.ready) return out
		for (let n = 0; n < this.layout.padCount; n++) {
			const path = this.layout.padPath(n)
			const idx = this.propInt(path, 'padIdx') ?? n
			out.set(idx, {
				idx,
				bank: Math.floor(idx / 8),
				slot: idx % 8,
				name: this.propString(path, 'padName') ?? '',
				colour: this.propInt(path, 'padColourIndex') ?? 11,
				active: this.propBool(path, 'padActive') ?? false,
				type: this.propInt(path, 'padType') ?? 0,
			})
		}
		return out
	}

	/** @param {number} slot @param {number | null} bank */
	pad(slot, bank = null) {
		return this.pads().get((bank ?? this.padBank) * 8 + slot) ?? null
	}

	// ---------------------------------------------------------------- voice FX

	get fxSlotCount() {
		return this.ready ? this.layout.effectsCount : 0
	}

	/** @param {number} slot @param {string} effect e.g. reverbOn */
	fxOn(slot, effect) {
		return this.propBool(this.ready ? this.layout.effectsPath(slot) : null, effect) ?? false
	}

	/** @param {number} slot @param {string} effect @param {boolean} on */
	async setFx(slot, effect, on) {
		await this.write(this.layout.effectsPath(slot), effect, V.bool(on))
		this.emit('update', 'fx')
	}

	// ---------------------------------------------------------------- desk settings

	get screenBrightness() {
		return this.propInt(this.guiPath, 'screenBrightness') ?? 0
	}

	get buttonsBrightness() {
		return this.propInt(this.guiPath, 'activeButtonsBrightness') ?? 0
	}

	get duckerDepth() {
		return this.propNumber(this.duckerPath, 'duckerDepth') ?? 0
	}

	/** @param {number} value 0..255 */
	async setScreenBrightness(value) {
		await this.write(this.guiPath, 'screenBrightness', V.int(clampInt(value, 0, 255)))
		this.emit('update', 'gui')
	}

	/** @param {number} value 0..255 */
	async setButtonsBrightness(value) {
		await this.write(this.guiPath, 'activeButtonsBrightness', V.int(clampInt(value, 0, 255)))
		this.emit('update', 'gui')
	}

	/** @param {number} db ducker depth in dB (negative) */
	async setDuckerDepth(db) {
		await this.write(this.duckerPath, 'duckerDepth', V.double(Math.max(-60, Math.min(0, db))))
		this.emit('update', 'gui')
	}

	// ---------------------------------------------------------------- change routing

	/** @param {{ path: number[], name: string, value: any }} c */
	onChange(c) {
		const L = this.layout
		if (!L) return
		const name = c.name
		if (name === 'meterLevelL' || name === 'meterLevelR' || name === 'meterPeakL' || name === 'meterPeakR') return
		const cell = L.mixCellFromPath(c.path)
		if (cell) {
			if (name === 'mixLevelWithAnchor') this.onAnchorChange(cell, c.value)
			this.emit('update', 'strips')
			return
		}
		if (c.path.length === 1 && L.channelIndexFromPath(c.path) !== null) {
			this.emit('update', 'strips')
			return
		}
		if (L.isSingletonPath('output', c.path)) {
			this.emit('update', 'monitor')
			return
		}
		if (L.isSingletonPath('recorder', c.path)) {
			if (name === 'recordState') this.clock.apply(asInt(c.value))
			this.emit('update', 'recorder')
			return
		}
		if (L.isSingletonPath('gui', c.path) || L.isSingletonPath('ducker', c.path)) {
			this.emit('update', name === 'selectedBank' ? 'pads' : 'gui')
			return
		}
		if (L.isSingletonPath('system', c.path)) {
			this.emit('update', name === 'disableAllHeadphoneOutputs' ? 'monitor' : 'system')
			return
		}
		if (c.path.length >= 1 && this.tree.children[c.path[0]]?.type === 'SOUNDPADS') {
			this.emit('update', 'pads')
			return
		}
		if (L.effectsIndexFromPath(c.path) !== null) {
			this.emit('update', 'fx')
			return
		}
		if (name === 'mutePressed' || name === 'soloPressed' || name === 'padButtonPressed') return
		this.emit('update', 'system')
	}

	/**
	 * The physical fader is reported only through the anchor half of the
	 * strip's cells. When a borrowed strip's fader moves, the hand wins: relink.
	 * @param {{ source: number, mix: number }} cell
	 * @param {any} value
	 */
	onAnchorChange(cell, value) {
		for (const [strip, entry] of this.borrowed) {
			if (entry.source !== cell.source) continue
			const parsed = parseMixLevel(asString(value))
			if (!parsed) return
			if (Math.abs(parsed.anchor - entry.anchor) > 0.004) {
				this.log('info', `fader ${strip + 1} moved while borrowed: handing it back`)
				void this.releaseStrip(strip).catch((err) => this.log('warn', `release failed: ${err.message}`))
			}
		}
	}
}

/** @param {number} v @param {number} lo @param {number} hi */
function clampInt(v, lo, hi) {
	return Math.max(lo, Math.min(hi, Math.round(v)))
}

/**
 * The `encoderSignal` pair as the hardware emits it: `01 05 01 <int32 delta> 01 01 <bool>`.
 * @param {number} delta
 * @param {boolean} phase
 */
function encoderSignal(delta, phase) {
	const b = Buffer.alloc(10)
	b[0] = 0x01
	b[1] = 0x05
	b[2] = 0x01
	b.writeInt32LE(delta, 3)
	b[7] = 0x01
	b[8] = 0x01
	b[9] = phase ? 0x02 : 0x03
	return b
}

export { MixOutput }
