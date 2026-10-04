/**
 * Device capability discovery: what the connected console exposes.
 *
 * Port of `rodecaster-protocol/src/capabilities.rs` (MIT, Yeradon).
 *
 * @module protocol/capabilities
 */

import { Fader, MixOutput, Source } from './names.js'

/** @typedef {import('./valuetree.js').ValueTree} ValueTree */
/** @typedef {import('./layout.js').Layout} Layout */

/**
 * @typedef {object} DeviceCapabilities
 * @property {import('./names.js').DeviceModelId} model
 * @property {string | null} firmware `systemFirmwareVersion`, when present
 * @property {import('./names.js').FaderId[]} faders addressable strips in wire order
 * @property {import('./names.js').SourceId[]} sources addressable sources in protocol order
 * @property {import('./names.js').MixOutputId[]} mixOutputs mix buses in protocol order
 * @property {number} channelCount
 * @property {number} inputSourceCount
 * @property {number} headphoneCount
 * @property {number} effectsCount
 * @property {number} padCount
 * @property {number} sipCallSlotsCount
 * @property {number} sipRegistrationCount
 * @property {number} physicalComboCount XLR combo jacks on the hardware (2 Duo, 4 Pro II)
 * @property {number} physicalHeadphoneCount headphone jacks on the hardware (2 Duo, 4 Pro II)
 * @property {boolean} isInSetup initial setup mode (outputs or controls disabled)
 * @property {(fader: string) => boolean} supportsFader
 */

/**
 * First Bool-typed property of this name, searching this node then children
 * depth-first (a same-named property of another type is skipped).
 * @param {ValueTree} node
 * @param {string} name
 * @returns {boolean | null}
 */
function findBoolProperty(node, name) {
	const own = node.properties.get(name)
	if (own && own.type === 'bool') return own.value
	for (const child of node.children) {
		const v = findBoolProperty(child, name)
		if (v !== null) return v
	}
	return null
}

/**
 * First String-typed property of this name, depth-first.
 * @param {ValueTree} node
 * @param {string} name
 * @returns {string | null}
 */
function findStringProperty(node, name) {
	const own = node.properties.get(name)
	if (own && own.type === 'string') return own.value
	for (const child of node.children) {
		const v = findStringProperty(child, name)
		if (v !== null) return v
	}
	return null
}

/**
 * Discover capabilities from a fullSync root and its layout.
 * @param {ValueTree} root
 * @param {Layout} layout
 * @returns {DeviceCapabilities}
 */
export function discoverCapabilities(root, layout) {
	const model = layout.model
	const isInSetup =
		(findBoolProperty(root, 'disableAllPhysicalButtons') ?? false) ||
		((findBoolProperty(root, 'disableAllLineoutOutputs') ?? false) &&
			(findBoolProperty(root, 'disableAllHeadphoneOutputs') ?? false))

	/** @type {import('./names.js').FaderId[]} */
	const faders = []
	for (let i = 0; i < layout.faderCount; i++) {
		const f = Fader.fromIndex(model, i)
		if (f) faders.push(f)
	}
	/** @type {import('./names.js').SourceId[]} */
	const sources = []
	for (let i = 0; i < layout.sourceCount; i++) {
		const s = Source.fromProtocol(i)
		if (s) sources.push(s)
	}
	/** @type {import('./names.js').MixOutputId[]} */
	const mixOutputs = []
	for (let i = 0; i < layout.mixCountPerSource; i++) {
		const m = MixOutput.fromProtocol(i)
		if (m) mixOutputs.push(m)
	}
	const faderSet = new Set(faders)

	return Object.freeze({
		model,
		firmware: findStringProperty(root, 'systemFirmwareVersion'),
		faders,
		sources,
		mixOutputs,
		channelCount: layout.channelCount,
		inputSourceCount: layout.inputSourceCount,
		headphoneCount: layout.headphoneCount,
		effectsCount: layout.effectsCount,
		padCount: layout.padCount,
		sipCallSlotsCount: layout.sipCallSlotsCount,
		sipRegistrationCount: layout.sipRegistrationCount,
		physicalComboCount: model === 'duo' ? 2 : 4,
		physicalHeadphoneCount: model === 'duo' ? 2 : 4,
		isInSetup,
		supportsFader: (fader) => faderSet.has(/** @type {any} */ (fader)),
	})
}
