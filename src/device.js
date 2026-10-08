/**
 * RodecasterDevice: connection lifecycle plus a desk-level API on top of the
 * protocol session. Everything the Companion instance needs goes through here.
 *
 * Emits:
 *  - 'status'  (state: 'connecting' | 'ready' | 'disconnected', message?)
 *  - 'update'  (area: 'strips' | 'monitor' | 'recorder' | 'pads' | 'fx' | 'gui' | 'system' | 'all')
 *  - 'log'     (level, message)
 *  - 'borrowed' (list of currently borrowed sends, for persistence)
 *  - 'headphoneMutes' (list of headphone sends muted here, for persistence)
 */
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
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
 * @typedef {{ source: number, mixes: number[], identity?: import('./hid-transport.js').DeviceIdentity | null }} RecoveryEntry
 * @typedef {RecoveryEntry & { anchor: number }} BorrowedStrip
 */

export class RodecasterDevice extends EventEmitter {
	/**
	 * @param {{ serial?: string, stripNames?: string[], levelControl?: boolean, monitorMethod?: 'property' | 'encoder' }} options
	 * @param {{ transport?: HidTransport, timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} dependencies
	 */
	constructor(options = {}, { transport = new HidTransport(), timers = { setTimeout, clearTimeout } } = {}) {
		super()
		this.options = { serial: '', stripNames: [], levelControl: false, monitorMethod: 'property', ...options }
		this.transport = transport
		this.timers = timers
		this.session = new ProtocolSession()
		this.reasm = new Reassembler()
		this.clock = new RecordClock()
		this.running = false
		this.ready = false
		/** @type {NodeJS.Timeout | null} */
		this.reconnectTimer = null
		/** @type {NodeJS.Timeout | null} */
		this.readyTimer = null
		this.handshakePause = null
		this.connectionListeners = null
		this.connecting = false
		this.closing = null
		this.stopping = null
		this.syncRequest = null
		/** @type {Map<number, BorrowedStrip>} strip index -> borrowed sends */
		this.borrowed = new Map()
		/** @type {Map<number, Set<number>>} headphone (1..4) -> sources muted here */
		this.headphoneMutes = new Map()
		this.headphoneMuteQueue = Promise.resolve()
		/** @type {ReturnType<RodecasterDevice['capturePanic']> | null} */
		this.panicSnapshot = null
		this.panicQueue = Promise.resolve()
		this.connectionGeneration = 0
		/** @type {RecoveryEntry[]} sends to relink when their original desk is ready */
		this.pendingRepair = []
		this.encoderPhase = false

		this.session.on('ready', () => this.onReady())
		this.session.on('change', (c) => this.onChange(c))
		this.session.on('needsFullSync', () => this.resync())
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

	stop() {
		this.running = false
		if (this.stopping) return this.stopping
		this.connectionGeneration++
		this.clearTimers()
		this.detachTransportListeners()
		this.connecting = false
		this.syncRequest = null
		this.stopping = (async () => {
			if (this.borrowed.size > 0 && this.ready) await this.restoreFaders().catch(() => {})
			await this.transport.close()
			this.ready = false
			this.session.reset()
		})().finally(() => {
			this.stopping = null
			if (this.running) void this.connect()
		})
		return this.stopping
	}

	clearTimers() {
		if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer)
		if (this.readyTimer !== null) this.timers.clearTimeout(this.readyTimer)
		this.reconnectTimer = null
		this.readyTimer = null
		if (this.handshakePause) {
			const pause = this.handshakePause
			this.handshakePause = null
			this.timers.clearTimeout(pause.timer)
			pause.resolve()
		}
	}

	isCurrentConnection(generation) {
		return this.running && generation === this.connectionGeneration
	}

	detachTransportListeners() {
		if (!this.connectionListeners) return
		const { transport, report, close } = this.connectionListeners
		transport.off('report', report)
		transport.off('close', close)
		this.connectionListeners = null
	}

	armReadyTimeout(generation) {
		// Repeated structural changes must not keep extending recovery forever.
		if (this.readyTimer !== null) return
		const timer = this.timers.setTimeout(() => {
			if (this.readyTimer !== timer || !this.isCurrentConnection(generation)) return
			this.readyTimer = null
			this.log('warn', 'no full sync within 8 s, reopening')
			void this.onClosed(new Error('no full sync within 8 s'), generation)
		}, READY_TIMEOUT_MS)
		this.readyTimer = timer
	}

	async connect() {
		if (!this.running || this.transport.isOpen || this.connecting || this.closing || this.stopping) return
		const generation = ++this.connectionGeneration
		this.connecting = true
		this.clearTimers()
		this.ready = false
		this.reasm = new Reassembler()
		this.session.reset()
		const report = (buf) => {
			if (this.isCurrentConnection(generation)) this.onReport(buf)
		}
		const close = (err) => void this.onClosed(err, generation)
		this.connectionListeners = { transport: this.transport, report, close }
		this.transport.on('report', report)
		this.transport.on('close', close)
		// Arm before any await: even a write that never settles needs recovery,
		// and a full sync delivered during the handshake must clear this timer.
		this.armReadyTimeout(generation)
		this.emit('status', 'connecting')
		try {
			if (!this.isCurrentConnection(generation)) return
			const info = await this.transport.open(this.options.serial || undefined)
			if (!this.isCurrentConnection(generation)) return
			this.log(
				'info',
				`opened ${info.product} ${info.serialNumber} (pid 0x${info.productId?.toString(16) ?? 'unknown'})`,
			)
			await this.handshake(generation)
		} catch (err) {
			await this.onClosed(err, generation)
		} finally {
			if (generation === this.connectionGeneration) this.connecting = false
		}
	}

	async handshake(generation) {
		if (!this.isCurrentConnection(generation)) return
		await this.transport.write(modeNormalReport())
		if (!this.isCurrentConnection(generation)) return
		await new Promise((resolve) => {
			const pause = { resolve, timer: null }
			this.handshakePause = pause
			pause.timer = this.timers.setTimeout(() => {
				if (this.handshakePause !== pause) return
				this.handshakePause = null
				resolve()
			}, HANDSHAKE_PAUSE_MS)
		})
		if (!this.isCurrentConnection(generation)) return
		await this.transport.write(sessionOpenReport())
	}

	async resync() {
		const generation = this.connectionGeneration
		if (!this.isCurrentConnection(generation) || !this.transport.isOpen) return
		this.ready = false
		if (this.syncRequest) return
		const request = (this.syncRequest = {})
		this.borrowedBeforeResync = new Map(this.borrowed)
		this.armReadyTimeout(generation)
		this.log('debug', 'layout changed, requesting a new full sync')
		try {
			await this.transport.write(sessionOpenReport())
		} catch (err) {
			if (!this.isCurrentConnection(generation) || this.syncRequest !== request) return
			this.log('warn', `resync failed: ${err.message}`)
			await this.onClosed(err, generation)
		}
	}

	scheduleReconnect() {
		if (!this.running || this.reconnectTimer !== null) return
		const generation = this.connectionGeneration
		const timer = this.timers.setTimeout(() => {
			if (this.reconnectTimer !== timer || !this.isCurrentConnection(generation)) return
			this.reconnectTimer = null
			void this.connect()
		}, RECONNECT_MS)
		this.reconnectTimer = timer
	}

	/** @param {Error} [err] */
	onClosed(err, generation = this.connectionGeneration) {
		if (generation !== this.connectionGeneration || this.closing) return this.closing
		if (!this.connecting && !this.connectionListeners && !this.transport.isOpen) return
		const disconnectedGeneration = ++this.connectionGeneration
		const wasReady = this.ready
		this.ready = false
		this.connecting = false
		this.syncRequest = null
		this.clearTimers()
		this.detachTransportListeners()
		this.session.reset()
		// Detach the handle before scheduling a retry, including write failures
		// that produce no separate HID error event.
		const closing = this.transport.close().finally(() => {
			if (this.closing === closing) this.closing = null
			if (this.isCurrentConnection(disconnectedGeneration)) this.scheduleReconnect()
		})
		this.closing = closing
		if (wasReady || err) this.emit('status', 'disconnected', err?.message ?? 'desk disconnected')
		this.emit('update', 'all')
		return closing
	}

	/** @param {Buffer} buf */
	onReport(buf) {
		if (!this.transport.isOpen) return
		const generation = this.connectionGeneration
		for (const body of this.reasm.push(buf)) {
			if (generation !== this.connectionGeneration) return
			try {
				this.session.ingest(body)
			} catch (err) {
				if (err.code !== 'notReady') this.log('debug', `ingest: ${err.message}`)
			}
		}
	}

	onReady() {
		if (!this.transport.isOpen || !this.session.isReady) return
		if (this.readyTimer !== null) this.timers.clearTimeout(this.readyTimer)
		this.readyTimer = null
		this.syncRequest = null
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

	/** Keep an in-flight operation on its original connection and address space. */
	connectionGuard() {
		const generation = this.connectionGeneration
		const transport = this.transport
		const device = transport.device
		const tree = this.tree
		const layout = this.layout
		return () => {
			if (
				!this.ready ||
				!transport.isOpen ||
				this.connectionGeneration !== generation ||
				this.transport !== transport ||
				transport.device !== device ||
				this.tree !== tree ||
				this.layout !== layout
			) {
				throw new Error('desk connection or layout changed')
			}
		}
	}

	/**
	 * Write one property. The desk never echoes our own writes, so the local
	 * tree is updated here; side-effect pushes still arrive normally.
	 * Refuses names the node does not already have (a write to an unknown name
	 * would create a stray property that only a factory reset removes).
	 * @param {number[] | null} path
	 * @param {string} name
	 * @param {import('./protocol/juce-var.js').Value} value
	 * @param {() => void} [guard] Optional identity check for panic recovery.
	 */
	async write(path, name, value, guard) {
		guard?.()
		if (!this.ready || !this.tree || !path) throw new Error('desk not connected')
		const connectionGuard = this.connectionGuard()
		connectionGuard()
		const node = this.tree.getByPath(path)
		if (!node) throw new Error(`no node at ${path.join('/')}`)
		if (!node.properties.has(name)) throw new Error(`${node.type} has no property ${name}; refusing to create it`)
		const body = encodePropertyChanged(path, name, value)
		for (const report of encodeReports(body, REPORT_ID_OUT)) {
			guard?.()
			connectionGuard()
			await this.transport.write(report)
			guard?.()
			connectionGuard()
		}
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
		const guard = this.connectionGuard()
		guard()
		if (!this.levelControlEnabled) throw new Error('level control is locked (enable it in the connection settings)')
		if (this.borrowed.has(i)) {
			const entry = this.borrowed.get(i)
			this.checkRecoveryIdentity(entry.identity)
			return entry
		}
		const source = this.stripSourceOrdinal(i)
		if (source < 0) throw new Error(`strip ${i + 1} has no input source`)
		const cells = this.stripCells(i).filter((c) => c.link && !c.disabled)
		if (cells.length === 0) throw new Error(`strip ${i + 1} has no linked sends to borrow`)
		const entry = {
			source,
			mixes: cells.map((c) => c.mix),
			anchor: cells[0].anchor,
			identity: this.transport.identity,
		}
		if (!knownIdentity(entry.identity)) {
			this.log(
				'warn',
				'borrowed sends have unknown desk identity; automatic recovery is blocked, manual review required',
			)
		}
		this.borrowed.set(i, entry)
		this.emit('borrowed', this.borrowedList())
		for (const c of cells) {
			guard()
			await this.write(c.path, 'mixUnlinkRequest', pressValue())
			guard()
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
		const guard = this.connectionGuard()
		const entry = await this.borrowStrip(i)
		guard()
		const target = clamp01(level)
		for (const c of this.stripCells(i)) {
			guard()
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
		const guard = this.connectionGuard()
		await this.relinkSends(entry.source, entry.mixes, entry.identity)
		guard()
		this.checkRecoveryIdentity(entry.identity)
		this.borrowed.delete(i)
		this.emit('borrowed', this.borrowedList())
		this.emit('update', 'strips')
	}

	/** @param {number} source @param {number[]} mixes @param {RecoveryEntry['identity']} identity */
	async relinkSends(source, mixes, identity) {
		const connectionGuard = this.connectionGuard()
		const guard = () => {
			connectionGuard()
			this.checkRecoveryIdentity(identity)
		}
		guard()
		for (const mix of mixes) {
			guard()
			const path = this.layout.mixCellPath(source, mix)
			if (!path) continue
			if (this.propBool(path, 'mixLink') === true) continue
			await this.write(path, 'mixLinkRequest', pressValue(), guard)
			guard()
			this.tree.getByPath(path)?.properties.set('mixLink', V.bool(true))
		}
	}

	/** Relink everything this module borrowed. */
	async restoreFaders() {
		for (const i of [...this.borrowed.keys()]) await this.releaseStrip(i)
	}

	/** @returns {Array<RecoveryEntry & { strip: number }>} */
	borrowedList() {
		return [...this.borrowed.entries()].map(([strip, e]) => ({
			strip,
			source: e.source,
			mixes: e.mixes,
			identity: e.identity,
		}))
	}

	/** Unknown and legacy identities never authorize a recovery write. */
	checkRecoveryIdentity(identity) {
		if (!knownIdentity(identity)) {
			throw new Error('recovery retained: unknown or legacy desk identity; manual review required')
		}
		const current = this.transport.identity
		if (!knownIdentity(current)) {
			throw new Error(
				'recovery retained: attached desk identity is unknown; reconnect the original desk with a known serial',
			)
		}
		if (!sameIdentity(identity, current)) {
			throw new Error('recovery retained for another desk; reconnect the original desk to repair its sends')
		}
	}

	/**
	 * Sends recorded as borrowed by a previous run (persisted by the instance):
	 * relinked only when the original desk can be identified on the next ready.
	 * @param {RecoveryEntry[]} list
	 */
	setPendingRepair(list) {
		this.pendingRepair = Array.isArray(list) ? list : []
	}

	async repairOnStart() {
		// Active borrowing belongs to its original desk too. A replacement must
		// not inherit it, but the records must survive until that desk returns.
		const borrowedCount = this.borrowed.size
		for (const [strip, entry] of this.borrowed) {
			if (sameIdentity(entry.identity, this.transport.identity)) continue
			this.pendingRepair.push({ source: entry.source, mixes: entry.mixes, identity: entry.identity })
			this.borrowed.delete(strip)
		}
		if (this.borrowed.size !== borrowedCount) this.emit('update', 'strips')
		// Keep entries journaled while writes are in flight or fail. Successful
		// sends are skipped by relinkSends when a partial repair is retried.
		const pending = [...this.pendingRepair]
		const guard = this.connectionGuard()
		// After a resync (layout change) the borrowed map survives; re-apply nothing.
		if (this.borrowedBeforeResync) {
			this.borrowedBeforeResync = null
		}
		for (const entry of pending) {
			try {
				guard()
				this.checkRecoveryIdentity(entry.identity)
				// A send repaired on an earlier attempt may have been borrowed again.
				// Defer that entry until it can be repaired without taking active control.
				if (
					[...this.borrowed.values()].some(
						(e) => e.source === entry.source && e.mixes.some((mix) => entry.mixes.includes(mix)),
					)
				)
					continue
				if (entry.mixes.some((mix) => !this.layout.mixCellPath(entry.source, mix))) {
					throw new Error('send is absent from the current layout')
				}
				await this.relinkSends(entry.source, entry.mixes, entry.identity)
				guard()
				this.checkRecoveryIdentity(entry.identity)
				this.pendingRepair = this.pendingRepair.filter((e) => e !== entry)
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

	/** Sends into just one headphone bus. @param {number} n 1..4 */
	headphoneMixCells(n) {
		if (!Number.isInteger(n) || n < 1 || n > 4 || !this.ready) return []
		const cells = []
		for (let source = 0; source < this.layout.sourceCount; source++) {
			const path = this.layout.mixCellPath(source, n - 1)
			if (!path) continue
			cells.push({
				source,
				path,
				disabled: this.propBool(path, 'mixDisabled') === true,
				muted: this.propBool(path, 'mixMute'),
			})
		}
		return cells
	}

	/** True when every enabled send into this bus is muted. @param {number} n 1..4 */
	headphoneMixMuted(n) {
		const cells = this.headphoneMixCells(n)
		return cells.length > 0 && cells.every((c) => c.disabled || c.muted === true)
	}

	/** @returns {Array<{ headphone: number, sources: number[] }>} */
	headphoneMuteList() {
		return [...this.headphoneMutes].map(([headphone, sources]) => ({ headphone, sources: [...sources] }))
	}

	/** Restore ownership after a restart, without changing the desk. @param {Array<{ headphone: number, sources: number[] }>} list */
	setHeadphoneMutes(list) {
		this.headphoneMutes.clear()
		for (const entry of Array.isArray(list) ? list : []) {
			if (!entry || !Number.isInteger(entry.headphone) || entry.headphone < 1 || entry.headphone > 4) continue
			if (!Array.isArray(entry.sources)) continue
			const sources = this.headphoneMutes.get(entry.headphone) ?? new Set()
			for (const source of entry.sources) {
				if (Number.isInteger(source) && source >= 0) sources.add(source)
			}
			this.headphoneMutes.set(entry.headphone, sources)
		}
	}

	/**
	 * Mute one bus, preserving sends already muted by hand. Ownership is saved
	 * before each write: a rejected write might still have reached the desk.
	 * Panic uses strip/output mutes, so its restore never touches these cells.
	 * @param {number} n 1..4
	 * @param {boolean} muted
	 */
	async setHeadphoneMixMute(n, muted) {
		if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('headphone must be 1..4')
		const guard = this.connectionGuard()
		const operation = this.headphoneMuteQueue.then(async () => {
			try {
				guard()
				const cells = this.headphoneMixCells(n)
				let sources = this.headphoneMutes.get(n)
				if (!sources) {
					// An empty record is meaningful: an explicit mute acquired no
					// sends. Only an unmute with NO record gets the desk-mute fallback.
					sources = new Set(muted ? [] : cells.filter((c) => !c.disabled && c.muted !== false).map((c) => c.source))
					this.headphoneMutes.set(n, sources)
					this.emit('headphoneMutes', this.headphoneMuteList())
				}
				if (muted) {
					for (const cell of cells) {
						guard()
						// The desk may have changed a later cell while an earlier
						// write was awaiting HID. Respect its current state.
						if (this.propBool(cell.path, 'mixDisabled') === true || this.propBool(cell.path, 'mixMute') === true)
							continue
						if (!sources.has(cell.source)) {
							sources.add(cell.source)
							this.emit('headphoneMutes', this.headphoneMuteList())
						}
						// mixMute is a separate property from mixLink; do not borrow
						// the fader or alter any other output to mute this send.
						await this.write(cell.path, 'mixMute', V.bool(true), guard)
					}
				} else {
					for (const source of [...sources]) {
						guard()
						const path = this.layout.mixCellPath(source, n - 1)
						// Retain disabled or absent sends for a later restore.
						if (!path || this.propBool(path, 'mixDisabled') === true) continue
						// Even a locally unmuted send may have an uncertain mute write.
						await this.write(path, 'mixMute', V.bool(false), guard)
						sources.delete(source)
						this.emit('headphoneMutes', this.headphoneMuteList())
					}
					if (sources.size === 0) {
						this.headphoneMutes.delete(n)
						this.emit('headphoneMutes', this.headphoneMuteList())
					}
				}
			} finally {
				this.emit('update', 'monitor')
			}
		})
		this.headphoneMuteQueue = operation.catch(() => {})
		await operation
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
		await this.queuePanic(true)
	}

	async releasePanic() {
		await this.queuePanic(false)
	}

	/** Capture once, before any mute writes. A missing property is not an unmuted output. */
	capturePanic() {
		if (!this.ready || !this.transport.isOpen || !this.transport.device || !this.tree || !this.layout)
			throw new Error('panic: desk not connected; cannot capture original state')
		/** @type {Array<{ path: number[], name: string, node: import('./protocol/valuetree.js').ValueTree, muted: boolean | null }>} */
		const targets = []
		const capture = (path, name, included = true) => {
			const value = this.propBool(path, name)
			if (included && value === undefined) throw new Error(`panic: original ${name} is unknown`)
			if (included && !value) {
				targets.push({ path: [...path], name, node: this.tree.getByPath(path), muted: false })
			}
			return value ?? false
		}
		const strips = this.strips()
		return {
			strips: strips.map((s) => capture(this.channelPath(s.index), 'channelOutputMute', !!s.source)),
			monMute: capture(this.outputPath, 'outputMonMute'),
			btMute: capture(this.outputPath, 'outputBTMute'),
			phonesOff: capture(this.systemPath, 'disableAllHeadphoneOutputs'),
			targets,
			sources: strips.map((s) => s.sourceOrdinal),
			transport: this.transport,
			device: this.transport.device,
			info: this.transport.info,
			identity: { ...this.transport.info },
			generation: this.connectionGeneration,
			session: this.session,
			tree: this.tree,
			layout: this.layout,
		}
	}

	/** Never apply a retained snapshot to a replacement connection or an uncertain layout. */
	checkPanicIdentity(snap) {
		if (
			!this.ready ||
			!this.transport.isOpen ||
			this.transport !== snap.transport ||
			this.transport.device !== snap.device ||
			this.transport.info !== snap.info ||
			['path', 'serialNumber', 'productId'].some((key) => this.transport.info?.[key] !== snap.identity[key]) ||
			this.connectionGeneration !== snap.generation ||
			this.session !== snap.session ||
			this.tree !== snap.tree ||
			this.layout !== snap.layout ||
			this.stripCount !== snap.strips.length ||
			snap.sources.some((source, i) => this.stripSourceOrdinal(i) !== source) ||
			snap.targets.some((target) => this.tree.getByPath(target.path) !== target.node)
		) {
			throw new Error('panic recovery pending: original connection or layout is unavailable or changed')
		}
	}

	/** @param {boolean} muted */
	queuePanic(muted) {
		// The caller keeps its rejection; only the queue tail swallows it so a
		// later request can retry or reverse direction after a partial failure.
		const operation = this.panicQueue.then(async () => {
			try {
				if (!this.panicSnapshot) {
					if (!muted) return
					this.panicSnapshot = this.capturePanic()
					this.emit('update', 'all')
				}
				const snap = this.panicSnapshot
				const guard = () => this.checkPanicIdentity(snap)
				guard()
				for (const target of snap.targets) {
					if (target.muted === muted) continue
					guard()
					// A rejected write may still have reached the desk. Keep it
					// uncertain until an idempotent mute or restore is acknowledged.
					target.muted = null
					await this.write(target.path, target.name, V.bool(muted), guard)
					guard()
					target.muted = muted
				}
				if (!muted) this.panicSnapshot = null
			} finally {
				// Failures must also refresh panicActive feedback and partial state.
				this.emit('update', 'all')
			}
		})
		this.panicQueue = operation.catch(() => {})
		return operation
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
		if (existsSync(TRACE_FILE)) traceChange(this.tree, c, cell)
		if (cell) {
			if (name === 'mixLevelWithAnchor') this.onAnchorChange(cell, c.value)
			if (cell.mix < 4 && (name === 'mixMute' || name === 'mixDisabled')) this.emit('update', 'monitor')
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

/** The USB product ID identifies the model; paths and display names are not identity. */
function knownIdentity(identity) {
	return (
		typeof identity?.serialNumber === 'string' &&
		identity.serialNumber.trim().length > 0 &&
		Number.isInteger(identity.productId) &&
		identity.productId > 0 &&
		identity.productId <= 0xffff
	)
}

function sameIdentity(a, b) {
	return knownIdentity(a) && knownIdentity(b) && a.serialNumber === b.serialNumber && a.productId === b.productId
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

// Protocol discovery aid: while this file exists, every desk-originated
// property change (meters excluded) is appended to it as one JSON line.
const TRACE_FILE = '/tmp/rodecaster-trace.jsonl'

/** @param {any} tree @param {{ path: number[], name: string, value: any }} c @param {any} cell */
function traceChange(tree, c, cell) {
	try {
		const type = tree?.getByPath(c.path)?.type ?? null
		const line = JSON.stringify(
			{ t: new Date().toISOString(), path: c.path, type, cell, name: c.name, value: c.value },
			(_k, v) => (typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? v.toString('hex') : v),
		)
		appendFileSync(TRACE_FILE, line + '\n')
	} catch {
		// tracing must never disturb the desk session
	}
}
