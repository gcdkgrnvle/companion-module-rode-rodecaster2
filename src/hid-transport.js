/**
 * node-hid transport for the RODECaster control interface.
 *
 * Finds the desk by vendor id and interface, keeps a read loop alive for as
 * long as the device is open (the firmware blocks when nobody reads), and
 * re-emits every inbound report. Emits:
 *  - 'report' (Buffer)  one HID input report, report id in byte 0
 *  - 'close'  (Error?)  the device went away
 */
import { EventEmitter } from 'node:events'
import HID from 'node-hid'

export const RODE_VENDOR_ID = 0x19f7
const CONTROL_INTERFACE = 9
const CONTROL_USAGE_PAGE = 0xff00

if (process.platform === 'linux') {
	try {
		HID.setDriverType('hidraw')
	} catch {
		/* already set or unsupported: keep the default */
	}
}

/**
 * @typedef {{ path: string, serialNumber: string, product: string, productId: number | null }} ControlDeviceInfo
 * @typedef {{ serialNumber: string, productId: number | null }} DeviceIdentity
 */

/**
 * All RODECaster control interfaces currently attached.
 * @returns {ControlDeviceInfo[]}
 */
export function listControlDevices(hid = HID) {
	return hid
		.devices()
		.filter(
			(d) => d.vendorId === RODE_VENDOR_ID && (d.interface === CONTROL_INTERFACE || d.usagePage === CONTROL_USAGE_PAGE),
		)
		.map((d) => ({
			path: d.path ?? '',
			serialNumber: d.serialNumber ?? '',
			product: d.product ?? 'RODECaster',
			productId: d.productId,
		}))
		.filter((d) => d.path)
}

export class HidTransport extends EventEmitter {
	constructor(hid = HID) {
		super()
		this.hid = hid
		this.generation = 0
		this.opening = null
		this.closing = null
		/** @type {import('node-hid').HIDAsync | null} */
		this.device = null
		/** @type {ControlDeviceInfo | null} */
		this.info = null
	}

	get isOpen() {
		return this.device !== null
	}

	/** A snapshot of the opened handle's identity, never the configured selector. */
	get identity() {
		if (!this.isOpen || !this.info) return null
		return { serialNumber: this.info.serialNumber, productId: this.info.productId }
	}

	/**
	 * Open the first matching desk (or the one with `serial`).
	 * @param {string} [serial]
	 * @returns {Promise<ControlDeviceInfo>}
	 */
	open(serial) {
		if (this.device) return Promise.resolve(this.info)
		if (this.opening) return this.opening.promise
		const generation = ++this.generation
		const opening = { promise: null }
		this.opening = opening
		this.closing = null
		opening.promise = this._open(serial, generation).finally(() => {
			if (this.opening === opening) this.opening = null
		})
		return opening.promise
	}

	async _open(serial, generation) {
		const all = listControlDevices(this.hid)
		const info = serial ? all.find((d) => d.serialNumber === serial) : all[0]
		if (!info) {
			throw new Error(
				all.length === 0
					? 'no RODECaster control interface found (desk off, on USB 2, or no permission on the hidraw node)'
					: `no RODECaster with serial ${serial} (attached: ${all.map((d) => d.serialNumber).join(', ')})`,
			)
		}
		const device = await this.hid.HIDAsync.open(info.path)
		const isCurrent = () => this.device === device && this.generation === generation
		device.on('data', (buf) => {
			if (isCurrent()) this.emit('report', buf)
		})
		device.on('error', (err) => {
			if (!isCurrent()) return
			// Detach before notifying listeners: a listener may immediately reopen.
			void this.close()
			this.emit('close', err instanceof Error ? err : new Error(String(err)))
		})
		let openedInfo
		try {
			// A discovered path can be reused before open completes. Only the
			// opened handle can identify the desk whose sends we may recover.
			openedInfo = await device.getDeviceInfo?.()
		} catch (err) {
			await this._closeDevice(device)
			throw err
		}
		if (this.generation !== generation) {
			await this._closeDevice(device)
			throw new Error('HID open cancelled')
		}
		this.device = device
		this.info = {
			...info,
			serialNumber: openedInfo?.serialNumber ?? '',
			productId: openedInfo?.productId ?? null,
			product: openedInfo?.product ?? info.product,
		}
		return this.info
	}

	/**
	 * @param {Buffer | number[]} report full HID output report, report id first
	 */
	async write(report) {
		if (!this.device) throw new Error('HID device is not open')
		await this.device.write(report)
	}

	close() {
		if (!this.device && !this.opening) return this.closing ?? Promise.resolve()
		++this.generation
		const dev = this.device
		this.device = null
		this.info = null
		this.opening = null
		this.closing = dev ? this._closeDevice(dev) : Promise.resolve()
		return this.closing
	}

	_closeDevice(dev) {
		return Promise.resolve()
			.then(() => {
				dev.removeAllListeners('data')
				// Keep the guarded error listener to absorb late native errors.
				return dev.close()
			})
			.catch(() => {
				/* already gone */
			})
	}
}
