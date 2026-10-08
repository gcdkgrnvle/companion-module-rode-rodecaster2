/**
 * Routing (per-output custom mix) over the MIX matrix and MIXMINUSES, written
 * the same way the desk's own routing screen writes it (captured 2026-10-08,
 * Pro II fw 1.7.3):
 *   mode    MIXMINUSES[o].outputMixMinus  0 Main Mix, 1 Mix-minus, 2 Custom
 *   link    mixDisabled false, mixMute false, mixLinkRequest
 *   unlink  mixUnlinkRequest
 *   off     mixDisabled true, mixMute true   (red X)
 *   level   mixLevelWithAnchor "level|anchor" (anchor kept)
 */
import { V, pressValue } from './protocol/index.js'
import { parseMixLevel, formatMixLevel, clamp01 } from './model.js'

export const MODES = ['main', 'mixminus', 'custom']

/** @param {import('./device.js').RodecasterDevice} dev @param {number} output */
export function mixMinusPath(dev, output) {
	if (!dev.ready) return null
	return dev.layout.runPath('mixMinuses', output)
}

/** @param {import('./device.js').RodecasterDevice} dev */
export function routingState(dev) {
	if (!dev.ready) return { ready: false }
	const L = dev.layout
	const outputs = []
	for (let o = 0; o < L.mixCountPerSource; o++) {
		const mp = mixMinusPath(dev, o)
		const mode = mp ? dev.propInt(mp, 'outputMixMinus') : null
		const cells = []
		for (let s = 0; s < L.sourceCount; s++) {
			const path = L.mixCellPath(s, o)
			if (!path) continue
			const lvl = parseMixLevel(dev.propString(path, 'mixLevelWithAnchor')) ?? { level: 0, anchor: 0 }
			cells.push({
				source: s,
				level: lvl.level,
				anchor: lvl.anchor,
				link: dev.propBool(path, 'mixLink') ?? null,
				disabled: dev.propBool(path, 'mixDisabled') ?? null,
				mute: dev.propBool(path, 'mixMute') ?? null,
			})
		}
		outputs.push({ output: o, mode, modeName: MODES[mode] ?? null, cells })
	}
	const strips = []
	for (let i = 0; i < L.channelCount; i++) {
		strips.push({ strip: i, source: dev.propInt(L.channelPath(i), 'channelInputSource') ?? -1 })
	}
	return { ready: true, outputs, strips }
}

/** @param {import('./device.js').RodecasterDevice} dev */
function cellPath(dev, source, output) {
	const p = dev.ready ? dev.layout.mixCellPath(source, output) : null
	if (!p) throw new Error(`no mix cell for source ${source} output ${output}`)
	return p
}

/** @param {import('./device.js').RodecasterDevice} dev @param {number} output @param {number} mode */
export async function setMode(dev, output, mode) {
	if (![0, 1, 2].includes(mode)) throw new Error('mode must be 0, 1 or 2')
	const p = mixMinusPath(dev, output)
	if (!p) throw new Error(`no MIXMINUSES node for output ${output}`)
	await dev.write(p, 'outputMixMinus', V.int(mode))
	dev.emit('update', 'monitor')
}

/** @param {import('./device.js').RodecasterDevice} dev @param {number} source @param {number} output @param {'link'|'unlink'|'off'} state */
export async function setCellState(dev, source, output, state) {
	const p = cellPath(dev, source, output)
	if (state === 'off') {
		await dev.write(p, 'mixDisabled', V.bool(true))
		await dev.write(p, 'mixMute', V.bool(true))
	} else if (state === 'link') {
		await dev.write(p, 'mixDisabled', V.bool(false))
		await dev.write(p, 'mixMute', V.bool(false))
		await dev.write(p, 'mixLinkRequest', pressValue())
		dev.tree.getByPath(p)?.properties.set('mixLink', V.bool(true))
	} else if (state === 'unlink') {
		await dev.write(p, 'mixUnlinkRequest', pressValue())
		dev.tree.getByPath(p)?.properties.set('mixLink', V.bool(false))
	} else throw new Error('state must be link, unlink or off')
	dev.emit('update', 'strips')
}

/** @param {import('./device.js').RodecasterDevice} dev @param {number} source @param {number} output @param {number} level 0..1 */
export async function setCellLevel(dev, source, output, level) {
	const p = cellPath(dev, source, output)
	const cur = parseMixLevel(dev.propString(p, 'mixLevelWithAnchor')) ?? { level: 0, anchor: 0 }
	await dev.write(p, 'mixLevelWithAnchor', V.string(formatMixLevel(clamp01(level), cur.anchor)))
	dev.emit('update', 'strips')
}
