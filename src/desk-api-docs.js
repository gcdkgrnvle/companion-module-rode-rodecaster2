/** The LAN API reference is served locally, without scripts or external assets. */
import { MixOutput, Source } from './protocol/names.js'

const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const array = (items) => ({ type: 'array', items })
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const request = (...args) => ({ ...object(...args), additionalProperties: false })
const number = { type: 'number' }
const boolean = { type: 'boolean' }
const string = { type: 'string' }
const level = { type: 'number', minimum: 0, maximum: 1 }
const percent = { type: 'number', minimum: 0, maximum: 100 }
const index = (maximum, minimum = 0) => ({ type: 'integer', minimum, maximum })
const toggle = request({ value: { oneOf: [boolean, { type: 'string', enum: ['toggle', 'on', 'off'] }] } })
const levelChange = {
	...request({ level, delta: { type: 'number', minimum: -1, maximum: 1 } }, []),
	oneOf: [{ required: ['level'] }, { required: ['delta'] }],
	description:
		'Supply exactly one of level (0..1) or delta (-1..1). A delta is added to the current level and clamped to 0..1.',
}
const brightness = {
	...request({ value: index(255), pct: percent }, []),
	oneOf: [{ required: ['value'] }, { required: ['pct'] }],
	description:
		'Supply exactly one of value (0..255) or pct (0..100). Percentages are converted to the desk brightness scale.',
}
const fxProperties = Object.fromEntries(
	['reverb', 'echo', 'pitchShift', 'distortion', 'robot', 'voiceDisguise'].map((effect) => [effect, boolean]),
)

const schemas = {
	Error: object({ error: string }),
	Health: object({ ok: boolean, connected: boolean }),
	Source: object({ index: index(Source.ALL.length - 1), name: { type: 'string', enum: Source.ALL } }),
	RoutingSource: object({
		source: index(Source.ALL.length - 1),
		name: { type: 'string', enum: Source.ALL },
		state: { type: 'string', enum: ['link', 'unlink', 'off'] },
		level,
		anchor: level,
		onFader: boolean,
	}),
	RoutingCell: {
		allOf: [
			ref('RoutingSource'),
			object({ output: index(MixOutput.ALL.length - 1), outputName: { type: 'string', enum: MixOutput.ALL } }),
		],
	},
	RoutingOutput: object({
		output: index(MixOutput.ALL.length - 1),
		name: { type: 'string', enum: MixOutput.ALL },
		mode: { type: ['string', 'null'], enum: ['main', 'mixminus', 'custom', null] },
		sources: array(ref('RoutingSource')),
	}),
	Routing: object({ outputs: array(ref('RoutingOutput')) }),
	Preset: object({ id: { type: 'string', format: 'uuid' }, name: string }),
	Presets: object({
		presets: array(ref('Preset')),
		active: {
			type: 'string',
			description: 'Name of the first matching saved preset, or an empty string if none matches.',
		},
	}),
	LoadedPreset: object({ active: string, outputs: array(ref('RoutingOutput')) }),
	Strip: object({
		strip: { type: 'integer', minimum: 1 },
		name: string,
		source: { oneOf: [ref('Source'), { type: 'null' }] },
		muted: boolean,
		listen: { type: 'boolean', description: 'Cue/listen state.' },
		level,
		levelPct: percent,
		fader: index(127),
		control: { type: 'string', enum: ['fader', 'dial', 'locked', 'none'] },
	}),
	Strips: object({ strips: array(ref('Strip')) }),
	Output: object({ level, levelPct: percent, muted: boolean }),
	Headphones: object({
		allOff: boolean,
		mixes: array(object({ headphone: index(4, 1), muted: boolean })),
	}),
	Recorder: object({
		state: { type: 'string', enum: ['stopped', 'paused', 'recording'] },
		elapsedMs: { type: 'number', minimum: 0, description: 'Elapsed time tracked by the module.' },
	}),
	Pad: object({ slot: index(8, 1), bank: index(8, 1), name: string, active: boolean, type: number, colour: number }),
	Pads: object({ bank: index(8, 1), pads: array(ref('Pad')) }),
	FxSlot: object({ slot: { type: 'integer', minimum: 1 }, ...fxProperties }),
	Fx: object({ slots: array(ref('FxSlot')) }),
	Panic: object({ active: boolean }),
	Display: object({ screenBrightness: index(255), buttonBrightness: index(255) }),
	Ducker: object({ depth: { type: 'number', minimum: -60, maximum: 0 } }),
	State: object({
		routing: ref('Routing'),
		presets: ref('Presets'),
		strips: ref('Strips'),
		monitor: ref('Output'),
		headphones: ref('Headphones'),
		bluetooth: ref('Output'),
		recorder: ref('Recorder'),
		pads: ref('Pads'),
		fx: ref('Fx'),
		panic: ref('Panic'),
		display: ref('Display'),
		ducker: ref('Ducker'),
	}),
	Toggle: toggle,
	LevelChange: levelChange,
	Brightness: brightness,
}

const parameters = {
	output: {
		description: `Zero-based output number (0..${MixOutput.ALL.length - 1}), or name: ${MixOutput.ALL.join(', ')}. Aliases include hp1..hp4, monitor/spk, rec, bt and cm1..cm3. Names ignore case, spaces, underscores and dashes.`,
		schema: { oneOf: [index(MixOutput.ALL.length - 1), string] },
		example: 'headphone3',
	},
	source: {
		description: `Zero-based source number (0..${Source.ALL.length - 1}), or name: ${Source.ALL.join(', ')}. Aliases include mic1..mic4, pads/pad, bt, virtualgame/vgame, virtualmusic/vmusic, va/a, vb/b and caller1..caller3/cm1..cm3. Names ignore case, spaces, underscores and dashes. Only sources present in the connected desk layout are available.`,
		schema: { oneOf: [index(Source.ALL.length - 1), string] },
		example: 'mic1',
	},
	n: {
		description: 'One-based strip number, matching Companion presets. Use GET /strips to discover available strips.',
		schema: { type: 'integer', minimum: 1 },
		example: 1,
	},
	headphone: { description: 'One-based headphone jack number.', schema: index(4, 1), example: 3 },
	pad: { description: 'One-based SMART pad slot in the selected bank.', schema: index(8, 1), example: 1 },
	slot: {
		description: 'One-based voice FX slot. Use GET /fx to discover the slots available on this desk.',
		schema: { type: 'integer', minimum: 1 },
		example: 1,
	},
	effect: {
		description:
			'Effect name; megaphone is an alias for distortion. The corresponding existing *On property names are also accepted.',
		schema: {
			type: 'string',
			enum: [...Object.keys(fxProperties), 'megaphone', ...Object.keys(fxProperties).map((effect) => `${effect}On`)],
		},
		example: 'reverb',
	},
	idOrName: {
		description:
			'Saved preset UUID or exact preset name. URL-encode names containing spaces or other reserved characters.',
		schema: string,
		example: 'Podcast',
	},
}

const errors = {
	400: 'Invalid JSON, body, parameter or unavailable routing edit. Select Custom before editing routing cells.',
	401: 'Missing or incorrect API key. Supply Authorization: Bearer <key> or X-API-Key: <key>.',
	404: 'Route or saved routing preset not found.',
	409: 'Conflict: channel level control is disabled, or a routing preset name already exists.',
	413: 'Request body exceeds 64 KiB (65,536 bytes).',
	503: 'Desk disconnected or its connection changed while processing the request.',
	500: 'The request could not be completed.',
}
const paths = {}
const emptyBody = { body: request({}), example: {}, optional: true }

function add(method, path, summary, response, options = {}) {
	const {
		body,
		example,
		description,
		public: isPublic = false,
		status = 200,
		conflict = false,
		optional = false,
	} = options
	const responses = {
		[status]: {
			description: 'Resulting state of the affected resource, read from the device model after any write.',
			content: { 'application/json': { schema: typeof response === 'string' ? ref(response) : response } },
		},
	}
	const codes = isPublic ? [400, 413] : [400, 401, 404, 413, 503, 500, ...(conflict ? [409] : [])]
	for (const code of codes)
		responses[code] = { description: errors[code], content: { 'application/json': { schema: ref('Error') } } }
	const operation = {
		operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
		summary,
		...(description ? { description } : {}),
		...(isPublic ? { security: [] } : {}),
		responses,
	}
	const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
	if (names.length)
		operation.parameters = names.map((name) => ({ name, in: 'path', required: true, ...parameters[name] }))
	if (body)
		operation.requestBody = {
			required: !optional,
			content: { 'application/json': { schema: body, example } },
		}
	paths[path] ??= {}
	paths[path][method] = operation
}

add('get', '/health', 'Server and desk connection status', 'Health', { public: true })
add('get', '/state', 'All desk resources', 'State')
add('get', '/routing', 'All routing outputs and sources', 'Routing')
add('get', '/routing/outputs/{output}', 'One routing output', 'RoutingOutput')
add('put', '/routing/outputs/{output}/mode', 'Select an output routing mode', 'RoutingOutput', {
	body: request({ mode: { oneOf: [{ type: 'string', enum: ['main', 'mixminus', 'custom'] }, index(2)] } }),
	example: { mode: 'custom' },
	description: 'Mode numbers are 0 = main, 1 = mixminus, 2 = custom. Outputs whose mode is null have no writable mode.',
})
add('get', '/routing/outputs/{output}/sources/{source}', 'One routing source cell', 'RoutingCell')
add('patch', '/routing/outputs/{output}/sources/{source}', 'Change a routing source cell', 'RoutingCell', {
	body: {
		...request({ state: { type: 'string', enum: ['link', 'unlink', 'off'] }, level, ensureCustom: boolean }, []),
		anyOf: [{ required: ['state'] }, { required: ['level'] }],
	},
	example: { state: 'unlink', level: 0.5, ensureCustom: true },
	description:
		'Supply state, level, or both. The output must be Custom; otherwise the error asks to select Custom first. ensureCustom: true selects Custom before editing. Routing writes use the same queue as Companion routing actions and the routing page.',
})
add('get', '/routing/presets', 'Saved routing presets and the matching name', 'Presets')
const nameBody = request({ name: { type: 'string', minLength: 1, maxLength: 80 } })
add('post', '/routing/presets', 'Save current routing as a named preset', 'Presets', {
	body: nameBody,
	example: { name: 'Podcast' },
	status: 201,
	conflict: true,
})
add('post', '/routing/presets/{idOrName}/load', 'Load a saved routing preset', 'LoadedPreset', emptyBody)
add('patch', '/routing/presets/{idOrName}', 'Rename a routing preset', 'Presets', {
	body: nameBody,
	example: { name: 'Podcast live' },
	conflict: true,
})
add(
	'delete',
	'/routing/presets/{idOrName}',
	'Delete a routing preset and return the remaining presets',
	'Presets',
	emptyBody,
)
add('get', '/strips', 'All channel strips', 'Strips')
add('get', '/strips/{n}', 'One channel strip', 'Strip')
for (const control of ['mute', 'listen'])
	add('put', `/strips/{n}/${control}`, `Set or toggle channel ${control}`, 'Strip', {
		body: ref('Toggle'),
		example: { value: 'toggle' },
	})
add('put', '/strips/{n}/level', 'Set or adjust channel level', 'Strip', {
	body: ref('LevelChange'),
	example: { level: 0.5 },
	conflict: true,
	description:
		'Requires Let Companion drive channel levels. Returns 409 when disabled. Uses the same fader borrowing and restoration rules as Companion actions; linked sends are borrowed until the physical fader moves or faders are restored.',
})
add('post', '/strips/restore', 'Restore all borrowed physical faders', 'Strips', emptyBody)
for (const output of ['monitor', 'bluetooth']) {
	add('get', `/${output}`, `Current ${output} level and mute`, 'Output')
	add('put', `/${output}/level`, `Set or adjust ${output} level`, 'Output', {
		body: ref('LevelChange'),
		example: { delta: -0.05 },
	})
	add('put', `/${output}/mute`, `Set or toggle ${output} mute`, 'Output', {
		body: ref('Toggle'),
		example: { value: 'toggle' },
	})
}
add('get', '/headphones', 'All headphone mute states', 'Headphones')
add('put', '/headphones/off', 'Set or toggle all headphones off', 'Headphones', {
	body: ref('Toggle'),
	example: { value: false },
})
add('put', '/headphones/{headphone}/mute', 'Set or toggle one headphone mix mute', 'Headphones', {
	body: ref('Toggle'),
	example: { value: 'toggle' },
	description:
		'Uses the Companion headphone mix mute method and its persistent restore memory. Unmuting restores only the sends muted by that operation.',
})
add('get', '/recorder', 'Recorder state and elapsed time', 'Recorder')
for (const action of ['record', 'pause', 'stop', 'marker'])
	add('post', `/recorder/${action}`, `Recorder: ${action}`, 'Recorder', {
		...emptyBody,
		description:
			'Returns the module recorder model. Recorder elapsed time is counted by the module; a marker command does not change the recording state.',
	})
add('get', '/pads', 'All eight SMART pads in the current bank', 'Pads')
add('post', '/pads/{pad}/press', 'Press a SMART pad, optionally switching bank first', 'Pads', {
	body: request({ bank: index(8, 1) }, []),
	example: { bank: 1 },
	optional: true,
	description:
		'Slots and banks are one-based. The response is the current bank state from the model; pad playback notifications may arrive after the press response.',
})
add('put', '/pads/bank', 'Select or step the current SMART pad bank', 'Pads', {
	body: {
		...request({ bank: index(8, 1), delta: index(8, -8) }, []),
		oneOf: [{ required: ['bank'] }, { required: ['delta'] }],
	},
	example: { delta: 1 },
	description: 'Supply exactly one of bank (1..8) or integer delta (-8..8). Relative changes wrap through banks 1..8.',
})
add('get', '/fx', 'All voice FX slots', 'Fx')
add('put', '/fx/{slot}/{effect}', 'Set or toggle one voice effect', 'FxSlot', {
	body: ref('Toggle'),
	example: { value: 'toggle' },
})
add('get', '/panic', 'Current panic mute state', 'Panic')
add('put', '/panic', 'Set or toggle panic mute', 'Panic', { body: ref('Toggle'), example: { value: 'toggle' } })
for (const control of ['screen', 'button'])
	add('put', `/display/${control}-brightness`, `Set ${control} brightness`, 'Display', {
		body: ref('Brightness'),
		example: { pct: 50 },
	})
add('put', '/ducker/depth', 'Set ducker depth in decibels', 'Ducker', {
	body: request({ value: { type: 'number', minimum: -60, maximum: 0 } }),
	example: { value: -20 },
})
add(
	'get',
	'/openapi.json',
	'OpenAPI 3.1 API document',
	{ type: 'object' },
	{
		description: 'Available with a valid API key even while the desk is disconnected.',
	},
)
delete paths['/openapi.json'].get.responses[503]
add('get', '/docs', 'Self-contained HTML API reference', { type: 'string' }, { public: true })
paths['/docs'].get.responses[200] = {
	description: 'HTML reference with route descriptions, request schemas and curl examples; no external assets.',
	content: { 'text/html': { schema: string } },
}

export const openApiDocument = {
	openapi: '3.1.0',
	info: {
		title: 'RØDECaster desk API',
		version: '1.0.0',
		description:
			'A key-protected API on the module’s own HTTP server, separate from Companion’s loopback admin server. Desk resource reads and writes return JSON state from the device model. Property writes update that model optimistically because the desk does not echo host writes; responses do not independently confirm physical hardware behavior. Request bodies are limited to 64 KiB. No CORS headers are sent. API keys are accepted only in headers, never in query strings. Strips, headphone jacks, pad slots/banks and FX slots are one-based; routing output/source numbers are zero-based. GET /health and GET /docs are public. All other routes require an API key.',
	},
	servers: [{ url: '/api/v1', description: 'This module’s configured API host and port; default port 8765.' }],
	security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
	paths,
	components: {
		securitySchemes: {
			bearerAuth: {
				type: 'http',
				scheme: 'bearer',
				description: 'The API key from this Companion connection’s secret API key field.',
			},
			apiKeyAuth: {
				type: 'apiKey',
				in: 'header',
				name: 'X-API-Key',
				description: 'Alternative to Authorization: Bearer <key>.',
			},
		},
		schemas,
	},
}

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
	)
}

function exampleCurl(method, path, operation) {
	const examplePath = path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(parameters[name].example))
	const parts = [`curl -sS -X ${method.toUpperCase()} "$RODE_API_URL${examplePath}"`]
	if (!operation.security) parts.push('-H "Authorization: Bearer $RODE_API_KEY"')
	const body = operation.requestBody?.content['application/json']
	if (body) parts.push("-H 'Content-Type: application/json'", `--data '${JSON.stringify(body.example)}'`)
	return parts.join(' \\\n  ')
}

const routeHtml = Object.entries(paths)
	.flatMap(([path, methods]) =>
		Object.entries(methods).map(([method, operation]) => {
			const body = operation.requestBody?.content['application/json']
			const params = operation.parameters
				?.map((param) => `<li><code>${escapeHtml(param.name)}</code>: ${escapeHtml(param.description)}</li>`)
				.join('')
			const responses = Object.entries(operation.responses)
				.map(([code, response]) => `<li><strong>${code}</strong>: ${escapeHtml(response.description)}</li>`)
				.join('')
			return `<article id="${operation.operationId}">
<h2><span>${method.toUpperCase()}</span> <code>/api/v1${escapeHtml(path)}</code></h2>
<p>${escapeHtml(operation.summary)}${operation.security ? ' (No API key required.)' : ''}</p>
${operation.description ? `<p>${escapeHtml(operation.description)}</p>` : ''}
${params ? `<ul>${params}</ul>` : ''}
<pre><code>${escapeHtml(exampleCurl(method, path, operation))}</code></pre>
${body ? `<details><summary>JSON request body${operation.requestBody.required ? '' : ' (optional)'}</summary><pre>${escapeHtml(JSON.stringify(body.schema, null, 2))}</pre></details>` : ''}
<details><summary>Responses</summary><ul>${responses}</ul><pre>${escapeHtml(JSON.stringify(operation.responses[201]?.content ?? operation.responses[200].content, null, 2))}</pre></details>
</article>`
		}),
	)
	.join('\n')

export const apiDocsHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RØDECaster HTTP API</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#20252c;background:#fafbfd}
h1,h2{line-height:1.3}h2{font-size:1.05rem;overflow-wrap:anywhere}h2 span{color:#156445}a{color:#1354a0}
article{padding:1rem 0;border-top:1px solid #ccd3dc}pre{padding:1rem;overflow:auto;background:#eef1f5;border-radius:6px}
code{font-family:ui-monospace,monospace;font-size:.9em}summary{cursor:pointer}li{margin:.25rem 0}
</style></head><body>
<h1>RØDECaster HTTP API v1</h1>
<p>The API runs on its own server (default port 8765). Companion’s administration server stays on <code>127.0.0.1:8000</code>; the routing page is available there only.</p>
<p>Enable <strong>HTTP API</strong> in the Companion connection settings and set its secret API key. Set the bind address (default <code>0.0.0.0</code>) and port as needed. An empty key prevents the API server from starting. Allow access only from the trusted home LAN; this HTTP connection does not encrypt the key.</p>
<p>Set <code>RODE_API_KEY</code> in the caller’s environment to the configured key, and set the API address below. Examples contain only the placeholder <code>$RODE_API_KEY</code>.</p>
<pre><code>export RODE_API_URL='http://companion-host:8765/api/v1'</code></pre>
<p>Use <code>Authorization: Bearer $RODE_API_KEY</code> or <code>X-API-Key: $RODE_API_KEY</code>. Query-string keys are never accepted. Only <code>GET /api/v1/health</code> and this page are public. The <a href="openapi.json">OpenAPI 3.1 document</a> requires a key.</p>
<p>Requests and resource responses use JSON. Bodies are limited to 64 KiB (65,536 bytes). No CORS headers are sent. Unknown routes return 404; invalid input returns 400; missing/wrong keys return 401; disabled channel level control or duplicate preset names return 409; oversized bodies return 413; disconnected desk requests return 503 with <code>{"error":"desk disconnected"}</code>.</p>
<p>Every successful desk call returns the affected resource’s resulting state. Writes use the same device methods and queues as Companion actions. Property writes update the local model optimistically; the response does not independently confirm physical hardware behavior. Recorder time is tracked by the module, and pad playback notifications may follow the press response. For Stream Deck buttons, set the button state from response fields such as <code>muted</code>, <code>listen</code> or <code>active</code>, then poll the corresponding GET route to follow changes made at the desk.</p>
<p>Strips, headphone jacks, pad slots/banks and FX slots are <strong>one-based</strong>, matching Companion’s button labels. Routing output/source numbers are <strong>zero-based</strong>. Routing accepts names and aliases such as <code>headphone3</code>/<code>hp3</code>, <code>speaker</code>/<code>monitor</code>, <code>combo1</code>/<code>mic1</code> and <code>soundpad</code>/<code>pads</code>. Responses include the numeric index and canonical name. On/off writes accept <code>{"value":true}</code>, <code>false</code>, <code>"on"</code>, <code>"off"</code> or <code>"toggle"</code> as the value.</p>
${routeHtml}
<h2>Shared JSON schemas</h2>
<p>References beginning <code>#/components/schemas/</code> above refer to these schemas.</p>
<pre>${escapeHtml(JSON.stringify(schemas, null, 2))}</pre>
</body></html>`
