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
 * @typedef {{ path: string, serialNumber: string, product: string, productId: number }} ControlDeviceInfo
 */

/**
 * All RODECaster control interfaces currently attached.
 * @returns {ControlDeviceInfo[]}
 */
export function listControlDevices() {
	return HID.devices()
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
	constructor() {
		super()
		/** @type {import('node-hid').HIDAsync | null} */
		this.device = null
		/** @type {ControlDeviceInfo | null} */
		this.info = null
	}

	get isOpen() {
		return this.device !== null
	}

	/**
	 * Open the first matching desk (or the one with `serial`).
	 * @param {string} [serial]
	 * @returns {Promise<ControlDeviceInfo>}
	 */
	async open(serial) {
		const all = listControlDevices()
		const info = serial ? all.find((d) => d.serialNumber === serial) : all[0]
		if (!info) {
			throw new Error(
				all.length === 0
					? 'no RODECaster control interface found (desk off, on USB 2, or no permission on the hidraw node)'
					: `no RODECaster with serial ${serial} (attached: ${all.map((d) => d.serialNumber).join(', ')})`,
			)
		}
		const device = await HID.HIDAsync.open(info.path)
		this.device = device
		this.info = info
		device.on('data', (buf) => this.emit('report', buf))
		device.on('error', (err) => {
			this.emit('close', err instanceof Error ? err : new Error(String(err)))
			void this.close()
		})
		return info
	}

	/**
	 * @param {Buffer | number[]} report full HID output report, report id first
	 */
	async write(report) {
		if (!this.device) throw new Error('HID device is not open')
		await this.device.write(report)
	}

	async close() {
		const dev = this.device
		this.device = null
		this.info = null
		if (dev) {
			try {
				dev.removeAllListeners('data')
				await dev.close()
			} catch {
				/* already gone */
			}
		}
	}
}
