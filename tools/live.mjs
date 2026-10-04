#!/usr/bin/env node
/**
 * Hardware harness: open the desk's HID session, print decoded changes live,
 * and optionally write properties or typed commands.
 *
 *   node tools/live.mjs watch [seconds]                 print every change (meters filtered)
 *   node tools/live.mjs dump                            print the discovered layout/capabilities
 *   node tools/live.mjs get  <TYPE[n]/TYPE[n]...> [prop]  read a node (or one property)
 *   node tools/live.mjs set  <TYPE[n]/...> <prop> <value> [seconds]
 *        value: true|false|<int>|<float>|"string"|press (the 2-bool trigger pulse)
 *   node tools/live.mjs cmd  '<json command>' [seconds]  typed command for commands.js
 *
 * Node paths name root children by ValueTree type, e.g. CHANNEL[0], OUTPUT,
 * PHYSICALINTERFACE/PADBUTTON[3], SOUNDPADS/PAD[0]. Writes are verified by
 * waiting for the desk's own echo of the property.
 */
import HID from 'node-hid'
import {
	ProtocolSession,
	Reassembler,
	encodeReports,
	REPORT_ID_OUT,
	modeNormalReport,
	sessionOpenReport,
	HANDSHAKE_PAUSE_MS,
	encodePropertyChanged,
	V,
	pressValue,
} from '../src/protocol/index.js'

const [, , mode = 'watch', ...args] = process.argv
const NOISY = new Set(['meterLevelL', 'meterLevelR', 'meterPeakL', 'meterPeakR'])

HID.setDriverType('hidraw')
const info = HID.devices().find((d) => d.vendorId === 0x19f7 && (d.interface === 9 || d.usagePage === 0xff00))
if (!info) {
	console.error('no RODECaster control interface found')
	process.exit(1)
}
const dev = await HID.HIDAsync.open(info.path)
const session = new ProtocolSession()
const reasm = new Reassembler()
let ready = false

/** @param {number[]} path */
function describePath(path) {
	let node = session.tree
	const parts = []
	for (const idx of path) {
		if (!node) break
		const child = node.children[idx]
		if (!child) {
			parts.push(`?${idx}`)
			break
		}
		const type = child.type
		const nth = node.children.slice(0, idx).filter((c) => c.type === type).length
		parts.push(`${type}[${nth}]`)
		node = child
	}
	return parts.join('/')
}

/** @param {string} spec e.g. CHANNEL[0] or PHYSICALINTERFACE/PADBUTTON[3] */
function resolve(spec) {
	let node = session.tree
	const path = []
	for (const part of spec.split('/')) {
		const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(part)
		if (!m) throw new Error(`bad path part ${part}`)
		const [, type, nStr] = m
		const n = nStr ? Number(nStr) : 0
		let seen = -1
		let idx = -1
		for (let i = 0; i < node.children.length; i++) {
			if (node.children[i].type === type && ++seen === n) {
				idx = i
				break
			}
		}
		if (idx < 0) throw new Error(`no ${type}[${n}] under ${path.length ? describePath(path) : 'root'}`)
		path.push(idx)
		node = node.children[idx]
	}
	return { path, node }
}

function fmt(v) {
	if (v == null) return 'null'
	if (typeof v === 'object' && 'type' in v)
		return v.type === 'binary' ? `bin:${Buffer.from(v.value).toString('hex')}` : `${v.type}:${String(v.value)}`
	return String(v)
}

function parseValue(s) {
	if (s === 'true') return V.bool(true)
	if (s === 'false') return V.bool(false)
	if (s === 'press') return pressValue()
	if (s.startsWith('bin:')) return V.binary(Buffer.from(s.slice(4), 'hex'))
	if (/^-?\d+$/.test(s)) return V.int(Number(s))
	if (/^-?\d*\.\d+$/.test(s)) return V.double(Number(s))
	return V.string(s.replace(/^"|"$/g, ''))
}

const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(3).padStart(8)

session.on('change', (c) => {
	if (NOISY.has(c.name)) return
	console.log(`${stamp()}  ${describePath(c.path)}.${c.name}: ${fmt(c.oldValue)} -> ${fmt(c.value)}`)
})

dev.on('data', (report) => {
	for (const body of reasm.push(report)) {
		try {
			session.ingest(body)
		} catch (err) {
			console.log(`${stamp()}  ingest error: ${err.message}`)
		}
	}
})
dev.on('error', (e) => console.log('hid error', e.message))

const readyPromise = new Promise((res) => session.once('ready', res))
await dev.write(modeNormalReport())
await new Promise((r) => setTimeout(r, HANDSHAKE_PAUSE_MS))
await dev.write(sessionOpenReport())
await readyPromise
ready = true
const caps = session.capabilities
console.log(
	`${stamp()}  ready: ${caps.model} fw ${caps.firmware} faders=${caps.faders.length} channels=${caps.channelCount} pads=${caps.padCount} effects=${caps.effectsCount}`,
)

async function writeBodies(bodies) {
	for (const body of bodies) for (const rep of encodeReports(body, REPORT_ID_OUT)) await dev.write(rep)
}

/** Wait for an echo of `name` on `path`, or time out. */
function waitEcho(path, name, ms = 1500) {
	return new Promise((res) => {
		const key = path.join('.')
		const on = (c) => {
			if (c.name === name && c.path.join('.') === key) {
				session.off('change', on)
				res(c.value)
			}
		}
		session.on('change', on)
		setTimeout(() => {
			session.off('change', on)
			res(undefined)
		}, ms)
	})
}

const linger = (secs) => new Promise((r) => setTimeout(r, secs * 1000))

switch (mode) {
	case 'watch':
		await linger(Number(args[0] ?? 30))
		break
	case 'dump': {
		console.log(JSON.stringify(caps, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
		const root = session.tree
		const counts = {}
		for (const c of root.children) counts[c.type] = (counts[c.type] ?? 0) + 1
		console.log('root children:', counts)
		break
	}
	case 'get': {
		const { node } = resolve(args[0])
		if (args[1]) console.log(fmt(node.properties.get(args[1])))
		else for (const [k, v] of node.properties) console.log(`  ${k} = ${fmt(v)}`)
		break
	}
	case 'set': {
		const [spec, name, valueStr, secs] = args
		const { path, node } = resolve(spec)
		if (!node.properties.has(name)) {
			console.error(`refusing: ${spec} has no property ${name} (a write would create it permanently)`)
			break
		}
		const value = parseValue(valueStr)
		console.log(`${stamp()}  write ${spec}.${name} = ${fmt(value)} (was ${fmt(node.properties.get(name))})`)
		const echo = waitEcho(path, name)
		await writeBodies([encodePropertyChanged(path, name, value)])
		const got = await echo
		console.log(`${stamp()}  echo: ${got === undefined ? 'NONE within 1.5 s' : fmt(got)}`)
		await linger(Number(secs ?? 1))
		break
	}
	case 'cmd': {
		const command = JSON.parse(args[0])
		const bodies = session.encode(command)
		console.log(`${stamp()}  command ${command.type}: ${bodies.length} frame(s)`)
		await writeBodies(bodies)
		await linger(Number(args[1] ?? 2))
		break
	}
	default:
		console.error(`unknown mode ${mode}`)
}
await dev.close()
process.exit(0)
