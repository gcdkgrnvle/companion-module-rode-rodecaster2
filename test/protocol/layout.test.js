import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { V } from '../../src/protocol/juce-var.js'
import { Layout, LayoutError, MIX_COUNT_PER_SOURCE } from '../../src/protocol/layout.js'
import { n, nc, np, repeat } from './helpers.js'

/**
 * Synthetic tree with PHYSICALINTERFACE / CHANNEL / MIX at non-default
 * positions (port of the Rust layout_tests synthetic_tree).
 */
function syntheticTree() {
	const phys = nc('PHYSICALINTERFACE', [n('HEADER'), n('FADER'), n('FADER'), n('FADER'), n('FOOTER')])
	const children = [n('OTHER1'), n('OTHER2'), phys, n('OTHER3'), n('CHANNEL'), n('CHANNEL'), n('CHANNEL'), n('OTHER4')]
	children.push(...repeat(26, 'MIX')) // 8..33
	children.push(...repeat(4, 'INPUTSOURCE')) // 34..37
	children.push(n('MASTERCHANNEL'), n('OUTPUT'), n('DUCKER'), n('RECORDER'), n('PLAYER')) // 38..42
	children.push(n('HEADPHONE'), n('HEADPHONE')) // 43, 44
	children.push(n('EFFECTS_PARAMETERS'), n('EFFECTS_PARAMETERS'), n('EFFECTS_PARAMETERS')) // 45..47
	children.push(n('GUI')) // 48
	children.push(nc('SOUNDPADS', [n('PADHEADER'), n('PAD'), n('PAD'), n('PAD')])) // 49
	children.push(n('SYSTEM')) // 50
	return nc('DEVICE', children)
}

const minimal = () => nc('DEVICE', [nc('PHYSICALINTERFACE', [n('FADER')]), n('CHANNEL'), ...repeat(13, 'MIX')])

describe('Layout discovery', () => {
	test('discovers bases from tree positions, not constants', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.equal(l.physicalInterfaceIdx, 2)
		assert.equal(l.firstFaderInPhys, 1)
		assert.equal(l.faderCount, 3)
		assert.equal(l.firstChannel, 4)
		assert.equal(l.channelCount, 3)
		assert.equal(l.firstMix, 8)
		assert.equal(l.sourceCount, 2)
		assert.equal(l.mixCountPerSource, 13)
		assert.equal(MIX_COUNT_PER_SOURCE, 13)
	})

	test('channel paths use the discovered first channel', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.deepEqual(l.channelPath(0), [4])
		assert.deepEqual(l.channelPath(2), [6])
		assert.equal(l.channelPath(3), null)
		assert.equal(l.channelIndexFromPath([4]), 0)
		assert.equal(l.channelIndexFromPath([6]), 2)
		assert.equal(l.channelIndexFromPath([7]), null)
		assert.equal(l.channelIndexFromPath([3]), null)
		assert.equal(l.channelIndexFromPath([4, 0]), null)
	})

	test('fader paths are two-level through PHYSICALINTERFACE', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.deepEqual(l.faderPath(0), [2, 1])
		assert.deepEqual(l.faderPath(2), [2, 3])
		assert.equal(l.faderPath(3), null)
		assert.equal(l.faderIndexFromPath([2, 1]), 0)
		assert.equal(l.faderIndexFromPath([2, 3]), 2)
		assert.equal(l.faderIndexFromPath([2, 4]), null)
		assert.equal(l.faderIndexFromPath([0, 1]), null)
		assert.equal(l.faderIndexFromPath([1]), null)
	})

	test('mix cell paths are source-major', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.deepEqual(l.mixCellPath(0, 0), [8])
		assert.deepEqual(l.mixCellPath(0, 12), [20])
		assert.deepEqual(l.mixCellPath(1, 0), [21])
		assert.deepEqual(l.mixCellPath(1, 12), [33])
		assert.equal(l.mixCellPath(2, 0), null)
		assert.equal(l.mixCellPath(0, 13), null)
		assert.deepEqual(l.mixCellFromPath([8]), { source: 0, mix: 0 })
		assert.deepEqual(l.mixCellFromPath([20]), { source: 0, mix: 12 })
		assert.deepEqual(l.mixCellFromPath([21]), { source: 1, mix: 0 })
		assert.deepEqual(l.mixCellFromPath([33]), { source: 1, mix: 12 })
		assert.equal(l.mixCellFromPath([34]), null)
		assert.equal(l.mixCellFromPath([7]), null)
		assert.equal(l.mixCellFromPath([8, 0]), null)
	})

	test('input source run', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.equal(l.firstInputSource, 34)
		assert.equal(l.inputSourceCount, 4)
		assert.deepEqual(l.inputSourcePath(0), [34])
		assert.deepEqual(l.inputSourcePath(3), [37])
		assert.equal(l.inputSourcePath(4), null)
		assert.equal(l.inputSourceIndexFromPath([34]), 0)
		assert.equal(l.inputSourceIndexFromPath([37]), 3)
		assert.equal(l.inputSourceIndexFromPath([38]), null)
		assert.equal(l.inputSourceIndexFromPath([33]), null)
		assert.equal(l.inputSourceIndexFromPath([34, 0]), null)
	})

	test('singletons use discovered positions', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.equal(l.masterChannel, 38)
		assert.equal(l.output, 39)
		assert.deepEqual(l.masterChannelPath(), [38])
		assert.deepEqual(l.outputPath(), [39])
		assert.ok(l.isMasterChannelPath([38]))
		assert.ok(!l.isMasterChannelPath([39]))
		assert.ok(!l.isMasterChannelPath([38, 0]))
		assert.ok(l.isOutputPath([39]))
		assert.ok(!l.isOutputPath([38]))
		assert.equal(l.ducker, 40)
		assert.equal(l.recorder, 41)
		assert.equal(l.player, 42)
		assert.deepEqual(l.duckerPath(), [40])
		assert.deepEqual(l.recorderPath(), [41])
		assert.deepEqual(l.playerPath(), [42])
		assert.ok(l.isDuckerPath([40]) && !l.isDuckerPath([41]))
		assert.ok(l.isRecorderPath([41]) && !l.isRecorderPath([42]))
		assert.ok(l.isPlayerPath([42]) && !l.isPlayerPath([40]) && !l.isPlayerPath([42, 0]))
		assert.equal(l.gui, 48)
		assert.deepEqual(l.guiPath(), [48])
		assert.ok(l.isGuiPath([48]) && !l.isGuiPath([47]) && !l.isGuiPath([48, 0]))
		assert.equal(l.system, 50)
		assert.deepEqual(l.systemPath(), [50])
		assert.ok(l.isSystemPath([50]) && !l.isSystemPath([49]) && !l.isSystemPath([50, 0]))
		assert.deepEqual(l.singletonPath('gui'), [48])
		assert.throws(() => l.singletonPath('nope'), RangeError)
	})

	test('headphone and effects runs', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.equal(l.firstHeadphone, 43)
		assert.equal(l.headphoneCount, 2)
		assert.deepEqual(l.headphonePath(0), [43])
		assert.deepEqual(l.headphonePath(1), [44])
		assert.equal(l.headphonePath(2), null)
		assert.equal(l.headphoneIndexFromPath([43]), 0)
		assert.equal(l.headphoneIndexFromPath([44]), 1)
		assert.equal(l.headphoneIndexFromPath([45]), null)
		assert.equal(l.headphoneIndexFromPath([42]), null)
		assert.equal(l.headphoneIndexFromPath([43, 0]), null)
		assert.equal(l.firstEffects, 45)
		assert.equal(l.effectsCount, 3)
		assert.deepEqual(l.effectsPath(0), [45])
		assert.deepEqual(l.effectsPath(2), [47])
		assert.equal(l.effectsPath(3), null)
		assert.equal(l.effectsIndexFromPath([45]), 0)
		assert.equal(l.effectsIndexFromPath([47]), 2)
		assert.equal(l.effectsIndexFromPath([48]), null)
		assert.equal(l.effectsIndexFromPath([44]), null)
		assert.equal(l.effectsIndexFromPath([45, 0]), null)
	})

	test('pad paths are two-level through SOUNDPADS', () => {
		const l = Layout.fromFullSync(syntheticTree())
		assert.equal(l.soundpads, 49)
		assert.equal(l.firstPad, 1)
		assert.equal(l.padCount, 3)
		assert.deepEqual(l.padPath(0), [49, 1])
		assert.deepEqual(l.padPath(2), [49, 3])
		assert.equal(l.padPath(3), null)
		assert.equal(l.padIndexFromPath([49, 1]), 0)
		assert.equal(l.padIndexFromPath([49, 3]), 2)
		assert.equal(l.padIndexFromPath([49, 4]), null)
		assert.equal(l.padIndexFromPath([49, 0]), null)
		assert.equal(l.padIndexFromPath([2, 1]), null)
		assert.equal(l.padIndexFromPath([49]), null)
	})

	test('absent optional families yield null / 0, never throw', () => {
		const l = Layout.fromFullSync(minimal())
		assert.equal(l.masterChannel, null)
		assert.equal(l.output, null)
		assert.equal(l.masterChannelPath(), null)
		assert.ok(!l.isMasterChannelPath([0]))
		assert.equal(l.ducker, null)
		assert.equal(l.recorder, null)
		assert.equal(l.player, null)
		assert.equal(l.firstHeadphone, null)
		assert.equal(l.headphoneCount, 0)
		assert.equal(l.headphonePath(0), null)
		assert.equal(l.headphoneIndexFromPath([0]), null)
		assert.equal(l.firstEffects, null)
		assert.equal(l.effectsCount, 0)
		assert.equal(l.gui, null)
		assert.ok(!l.isGuiPath([0]))
		assert.equal(l.soundpads, null)
		assert.equal(l.padCount, 0)
		assert.equal(l.padPath(0), null)
		assert.equal(l.padIndexFromPath([0, 0]), null)
		assert.equal(l.system, null)
		assert.equal(l.systemPath(), null)
		assert.equal(l.firstInputSource, null)
		assert.equal(l.inputSourceCount, 0)
		assert.equal(l.inputSourcePath(0), null)
		assert.equal(l.runCount('sipCallSlots'), 0)
		assert.equal(l.runPath('show', 0), null)
		assert.equal(l.model, 'pro2')
	})

	test('a container with no children of the run type keeps parent presence', () => {
		const root = minimal()
		root.children.push(nc('SOUNDPADS', [n('PADHEADER')]))
		const l = Layout.fromFullSync(root)
		assert.equal(l.soundpads, root.children.length - 1)
		assert.equal(l.padCount, 0)
		assert.equal(l.padPath(0), null)
	})

	test('fails loudly on missing required nodes', () => {
		assert.throws(
			() => Layout.fromFullSync(nc('DEVICE', [n('CHANNEL'), n('MIX')])),
			(e) => e instanceof LayoutError && e.code === 'missingNode' && e.what === 'PHYSICALINTERFACE under root',
		)
		assert.throws(
			() =>
				Layout.fromFullSync(nc('DEVICE', [nc('PHYSICALINTERFACE', [n('HEADER')]), n('CHANNEL'), ...repeat(13, 'MIX')])),
			(e) => e.code === 'missingNode' && e.what === 'FADER under PHYSICALINTERFACE',
		)
		assert.throws(
			() => Layout.fromFullSync(nc('DEVICE', [nc('PHYSICALINTERFACE', [n('FADER')]), ...repeat(13, 'MIX')])),
			(e) => e.code === 'missingNode' && e.what === 'CHANNEL under root',
		)
		assert.throws(
			() => Layout.fromFullSync(nc('DEVICE', [nc('PHYSICALINTERFACE', [n('FADER')]), n('CHANNEL')])),
			(e) => e.code === 'missingNode' && e.what === 'MIX under root',
		)
		assert.throws(
			() =>
				Layout.fromFullSync(nc('DEVICE', [nc('PHYSICALINTERFACE', [n('FADER')]), n('CHANNEL'), ...repeat(14, 'MIX')])),
			(e) => e.code === 'shapeMismatch' && e.what === 'MIX',
		)
	})

	test('model detection from SYSTEM', () => {
		const withSystem = (props) =>
			nc('DEVICE', [np('SYSTEM', props), nc('PHYSICALINTERFACE', [n('FADER')]), n('CHANNEL'), ...repeat(13, 'MIX')])
		assert.equal(Layout.fromFullSync(minimal()).model, 'pro2')
		assert.equal(Layout.fromFullSync(withSystem({ boardType: V.int(0) })).model, 'pro2')
		assert.equal(Layout.fromFullSync(withSystem({ boardType: V.int(1) })).model, 'duo')
		assert.equal(Layout.fromFullSync(withSystem({ systemName: V.string('RODECaster Duo') })).model, 'duo')
		assert.equal(
			Layout.fromFullSync(withSystem({ boardType: V.int(0), systemName: V.string('RODECaster Duo') })).model,
			'pro2',
		)
	})

	test('toJSON summarises discovered positions', () => {
		const j = Layout.fromFullSync(syntheticTree()).toJSON()
		assert.equal(j.firstChannel, 4)
		assert.equal(j.singletons.gui, 48)
		assert.deepEqual(j.runs.pad, { parent: 49, first: 1, count: 3 })
		assert.deepEqual(j.runs.headphone, { first: 43, count: 2 })
	})
})
