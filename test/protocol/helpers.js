/**
 * Shared synthetic trees and layout builders (port of the crate's
 * `src/test_fixtures.rs`). Node positions are deliberately NOT the real
 * firmware constants so tests fail if anything is hardcoded.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Layout } from '../../src/protocol/layout.js'
import { ValueTree } from '../../src/protocol/valuetree.js'

/** @typedef {import('../../src/protocol/juce-var.js').Value} Value */

/** Property-less node. @param {string} type */
export const n = (type) => new ValueTree(type)
/** Node with properties. @param {string} type @param {Record<string, Value>} props */
export const np = (type, props) => new ValueTree(type, props)
/** Node with children. @param {string} type @param {ValueTree[]} children */
export const nc = (type, children) => new ValueTree(type, {}, children)

/** @param {number} count @param {string} type */
export function repeat(count, type) {
	return Array.from({ length: count }, () => n(type))
}

/**
 * The canonical synthetic root used across command and event tests:
 * PHYSICALINTERFACE at 1 (FADER run starts at child 1, length 3), CHANNEL at
 * 2..4, 26 MIX (2 sources), 19 INPUTSOURCE, singletons, 2 HEADPHONE, 3
 * EFFECTS_PARAMETERS, GUI, SOUNDPADS with 3 PAD after a PADHEADER, SYSTEM.
 */
export function syntheticRoot() {
	const phys = nc('PHYSICALINTERFACE', [n('HEADER'), n('FADER'), n('FADER'), n('FADER')])
	const children = [n('OTHER'), phys, n('CHANNEL'), n('CHANNEL'), n('CHANNEL')]
	children.push(...repeat(26, 'MIX'))
	children.push(...repeat(19, 'INPUTSOURCE'))
	children.push(n('MASTERCHANNEL'), n('OUTPUT'), n('DUCKER'), n('RECORDER'), n('PLAYER'))
	children.push(n('HEADPHONE'), n('HEADPHONE'))
	children.push(n('EFFECTS_PARAMETERS'), n('EFFECTS_PARAMETERS'), n('EFFECTS_PARAMETERS'))
	children.push(n('GUI'))
	children.push(nc('SOUNDPADS', [n('PADHEADER'), n('PAD'), n('PAD'), n('PAD')]))
	children.push(n('SYSTEM'))
	return nc('DEVICE', children)
}

/** The standard layout from {@link syntheticRoot}. */
export function layout() {
	return Layout.fromFullSync(syntheticRoot())
}

/** Minimal tree with only the required base nodes. */
export function minimalRoot() {
	return nc('DEVICE', [nc('PHYSICALINTERFACE', [n('FADER')]), n('CHANNEL'), ...repeat(13, 'MIX')])
}

/** Minimal layout containing only the required base nodes. */
export function minimalLayout() {
	return Layout.fromFullSync(minimalRoot())
}

/**
 * Minimal tree plus the given extra root children (after the MIX run).
 * @param {ValueTree[]} extra
 */
export function minimalRootWith(extra) {
	const root = minimalRoot()
	root.children.push(...extra)
	return root
}

const FIXTURE = fileURLToPath(new URL('../fixtures/duo/fw-1.7.4/full-sync.frame', import.meta.url))

/** TCP magic header on the captured frame (`0xF2B49E2C` LE on the wire). */
export const TCP_MAGIC = 0xf2b49e2c

/** The raw captured Duo 1.7.4 TCP frame. */
export function duoFrame() {
	return readFileSync(FIXTURE)
}

/**
 * The full-sync body of the Duo fixture: the TCP frame is
 * `[u32 LE magic][u32 LE length][body]`.
 */
export function duoFullSyncBody() {
	const frame = duoFrame()
	if (frame.readUInt32LE(0) !== TCP_MAGIC) throw new Error('fixture magic mismatch')
	const len = frame.readUInt32LE(4)
	if (8 + len !== frame.length) throw new Error('fixture length mismatch')
	return frame.subarray(8)
}
