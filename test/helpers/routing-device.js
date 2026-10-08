import { EventEmitter } from 'node:events'
import { V } from '../../src/protocol/juce-var.js'
import { Layout } from '../../src/protocol/layout.js'
import { formatMixLevel, parseMixLevel } from '../../src/model.js'
import { n, nc, np, repeat } from '../protocol/helpers.js'

/** A complete local routing tree; no transport, discovery, or hardware access. */
export class RoutingDevice extends EventEmitter {
	constructor({ sourceCount = 19 } = {}) {
		super()
		this.ready = true
		this.tree = nc('DEVICE', [
			nc('PHYSICALINTERFACE', [n('FADER')]),
			np('CHANNEL', { channelInputSource: V.int(0) }),
			...repeat(sourceCount * 13, 'MIX'),
			...repeat(sourceCount, 'INPUTSOURCE'),
			...repeat(10, 'MIXMINUSES'),
		])
		this.layout = Layout.fromFullSync(this.tree)
		this.writes = []
		this.beforeWrite = async () => {}
		this.afterWrite = async () => {}
		for (let output = 0; output < 13; output++) {
			if (output < 10) this.setOutputMode(output, 2)
			for (let source = 0; source < sourceCount; source++) {
				this.setCell(source, output, { state: 'link', level: 0.6, anchor: 0.6 })
			}
		}
	}

	cell(source, output) {
		return this.tree.getByPath(this.layout.mixCellPath(source, output))
	}

	setCell(source, output, { state = 'link', level = 0.6, anchor = 0.6 } = {}) {
		const cell = this.cell(source, output)
		cell.properties.set('mixLink', V.bool(state === 'link'))
		cell.properties.set('mixDisabled', V.bool(state === 'off'))
		cell.properties.set('mixMute', V.bool(state === 'off'))
		cell.properties.set('mixLevelWithAnchor', V.string(formatMixLevel(level, anchor)))
	}

	setOutputMode(output, mode) {
		this.tree.getByPath(this.layout.runPath('mixMinuses', output)).properties.set('outputMixMinus', V.int(mode))
	}

	prop(path, name) {
		return path ? this.tree.getByPath(path)?.properties.get(name)?.value : undefined
	}

	propBool(path, name) {
		return this.prop(path, name)
	}

	propInt(path, name) {
		return this.prop(path, name)
	}

	propString(path, name) {
		return this.prop(path, name)
	}

	async write(path, name, value, guard) {
		guard?.()
		if (!this.ready) throw new Error('desk disconnected')
		const request = { path, name, value: value.value }
		await this.beforeWrite(request)
		guard?.()
		this.writes.push(request)
		const node = this.tree.getByPath(path)
		node.properties.set(name, value)
		if (name === 'mixLinkRequest') {
			const { anchor } = parseMixLevel(this.propString(path, 'mixLevelWithAnchor'))
			node.properties.set('mixLevelWithAnchor', V.string(formatMixLevel(anchor, anchor)))
		}
		await this.afterWrite(request)
		guard?.()
	}
}
