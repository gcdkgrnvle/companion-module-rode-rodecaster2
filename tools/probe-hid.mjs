import HID from 'node-hid'
try { HID.setDriverType('hidraw') } catch (e) { console.log('setDriverType:', e.message) }
const devs = HID.devices().filter(d => d.vendorId === 0x19f7)
console.log('RODE devices:', devs.map(d => ({ path: d.path, product: d.product, interface: d.interface, usagePage: d.usagePage, usage: d.usage, serial: d.serialNumber })))
const ctl = devs.find(d => d.interface === 9 || d.usagePage === 0xff00)
if (!ctl) { console.log('no control interface found'); process.exit(1) }
const dev = await HID.HIDAsync.open(ctl.path)
let n = 0, bytes = 0, ids = {}
const t0 = Date.now(); let last = t0
dev.on('data', (buf) => { n++; bytes += buf.length; ids[buf[0]] = (ids[buf[0]] || 0) + 1; last = Date.now(); if (n === 1) console.log('first:', buf.subarray(0, 24).toString('hex'), 'len', buf.length) })
dev.on('error', (e) => console.log('error:', e.message))
await dev.write([0x01, 0x4e, ...new Array(62).fill(0)])
await dev.write([0x03, 4, 0, 0, 0, 0xad, 0x10, 0xa7, 0xb0, ...new Array(247).fill(0)])
await new Promise(r => setTimeout(r, 3000))
console.log({ reports: n, bytes, ids, ms: last - t0 })
await dev.close()
