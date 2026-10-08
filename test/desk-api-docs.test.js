import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiDocsHtml, openApiDocument } from '../src/desk-api-docs.js'
import { MixOutput, Source } from '../src/protocol/names.js'

const expectedRoutes = {
	'/health': ['get'],
	'/state': ['get'],
	'/routing': ['get'],
	'/routing/outputs/{output}': ['get'],
	'/routing/outputs/{output}/mode': ['put'],
	'/routing/outputs/{output}/sources/{source}': ['get', 'patch'],
	'/routing/presets': ['get', 'post'],
	'/routing/presets/{idOrName}/load': ['post'],
	'/routing/presets/{idOrName}': ['patch', 'delete'],
	'/strips': ['get'],
	'/strips/{n}': ['get'],
	'/strips/{n}/mute': ['put'],
	'/strips/{n}/listen': ['put'],
	'/strips/{n}/level': ['put'],
	'/strips/restore': ['post'],
	'/monitor': ['get'],
	'/monitor/level': ['put'],
	'/monitor/mute': ['put'],
	'/headphones': ['get'],
	'/headphones/off': ['put'],
	'/headphones/{headphone}/mute': ['put'],
	'/bluetooth': ['get'],
	'/bluetooth/level': ['put'],
	'/bluetooth/mute': ['put'],
	'/recorder': ['get'],
	'/recorder/record': ['post'],
	'/recorder/pause': ['post'],
	'/recorder/stop': ['post'],
	'/recorder/marker': ['post'],
	'/pads': ['get'],
	'/pads/{pad}/press': ['post'],
	'/pads/bank': ['put'],
	'/fx': ['get'],
	'/fx/{slot}/{effect}': ['put'],
	'/panic': ['get', 'put'],
	'/display/screen-brightness': ['put'],
	'/display/button-brightness': ['put'],
	'/ducker/depth': ['put'],
	'/openapi.json': ['get'],
	'/docs': ['get'],
}

test('OpenAPI 3.1 covers every versioned route and method, including resulting-state responses', () => {
	assert.equal(openApiDocument.openapi, '3.1.0')
	assert.equal(openApiDocument.info.version, '1.0.0')
	assert.equal(openApiDocument.servers[0].url, '/api/v1')
	assert.deepEqual(Object.keys(openApiDocument.paths).sort(), Object.keys(expectedRoutes).sort())
	const ids = new Set()
	for (const [path, methods] of Object.entries(expectedRoutes)) {
		assert.deepEqual(Object.keys(openApiDocument.paths[path]).sort(), methods.sort(), path)
		for (const method of methods) {
			const operation = openApiDocument.paths[path][method]
			assert.ok(operation.summary, `${method} ${path} has a summary`)
			assert.ok(!ids.has(operation.operationId), `unique operationId: ${operation.operationId}`)
			ids.add(operation.operationId)
			const status = path === '/routing/presets' && method === 'post' ? 201 : 200
			const content = operation.responses[status]?.content
			assert.ok(content?.[path === '/docs' ? 'text/html' : 'application/json'], `${method} ${path} response`)
			if (path !== '/docs' && path !== '/openapi.json')
				assert.match(content['application/json'].schema.$ref, /^#\/components\/schemas\/\w+$/)
		}
	}
})

test('only health and HTML docs bypass either API key header; API keys are never query parameters', () => {
	assert.deepEqual(openApiDocument.security, [{ bearerAuth: [] }, { apiKeyAuth: [] }])
	const schemes = openApiDocument.components.securitySchemes
	assert.equal(schemes.bearerAuth.type, 'http')
	assert.equal(schemes.bearerAuth.scheme, 'bearer')
	assert.deepEqual(
		{ type: schemes.apiKeyAuth.type, in: schemes.apiKeyAuth.in, name: schemes.apiKeyAuth.name },
		{ type: 'apiKey', in: 'header', name: 'X-API-Key' },
	)
	for (const [path, methods] of Object.entries(openApiDocument.paths)) {
		for (const operation of Object.values(methods)) {
			if (path === '/health' || path === '/docs') assert.deepEqual(operation.security, [])
			else {
				assert.equal(operation.security, undefined, path)
				assert.ok(operation.responses[401], path)
			}
			assert.ok(operation.parameters?.every((parameter) => parameter.in !== 'query') ?? true)
		}
	}
})

test('OpenAPI references resolve and path parameters are required and described', () => {
	const serialized = JSON.parse(JSON.stringify(openApiDocument))
	function visit(value) {
		if (!value || typeof value !== 'object') return
		if (value.$ref) {
			assert.ok(value.$ref.startsWith('#/'))
			const resolved = value.$ref
				.slice(2)
				.split('/')
				.reduce((node, key) => node?.[key], serialized)
			assert.ok(resolved, `unresolved schema reference: ${value.$ref}`)
		}
		Object.values(value).forEach(visit)
	}
	visit(serialized)
	for (const [path, methods] of Object.entries(openApiDocument.paths)) {
		const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
		for (const operation of Object.values(methods)) {
			assert.deepEqual(
				(operation.parameters ?? []).map((param) => param.name),
				names,
			)
			for (const param of operation.parameters ?? []) {
				assert.equal(param.required, true)
				assert.equal(param.in, 'path')
				assert.ok(param.description && param.schema)
			}
		}
	}
})

test('OpenAPI documents indexing, aliases, toggle inputs, Custom requirement and level-control conflict', () => {
	const paths = openApiDocument.paths
	const output = paths['/routing/outputs/{output}'].get.parameters[0]
	const source = paths['/routing/outputs/{output}/sources/{source}'].get.parameters[1]
	assert.equal(output.schema.oneOf[0].minimum, 0)
	assert.equal(output.schema.oneOf[0].maximum, MixOutput.ALL.length - 1)
	assert.match(output.description, /hp1.*monitor.*bt/)
	assert.equal(source.schema.oneOf[0].maximum, Source.ALL.length - 1)
	assert.match(source.description, /mic1.*pads/)
	assert.equal(paths['/strips/{n}'].get.parameters[0].schema.minimum, 1)
	assert.equal(paths['/strips/{n}'].get.parameters[0].schema.maximum, undefined)
	assert.equal(paths['/headphones/{headphone}/mute'].put.parameters[0].schema.minimum, 1)
	assert.equal(paths['/pads/{pad}/press'].post.parameters[0].schema.minimum, 1)
	assert.equal(paths['/fx/{slot}/{effect}'].put.parameters[0].schema.minimum, 1)
	assert.deepEqual(openApiDocument.components.schemas.Toggle.properties.value.oneOf, [
		{ type: 'boolean' },
		{ type: 'string', enum: ['toggle', 'on', 'off'] },
	])
	const cell = paths['/routing/outputs/{output}/sources/{source}'].patch
	assert.match(cell.description, /select Custom first/)
	assert.equal(cell.requestBody.content['application/json'].schema.properties.ensureCustom.type, 'boolean')
	assert.ok(paths['/strips/{n}/level'].put.responses[409])
	assert.match(paths['/strips/{n}/level'].put.description, /borrowing/)
	assert.ok(paths['/routing/presets'].post.responses[409])
	assert.ok(paths['/routing/presets/{idOrName}'].patch.responses[409])
	assert.ok(!paths['/openapi.json'].get.responses[503])
})

test('request schemas provide bounds, mutually exclusive level inputs and concrete examples', () => {
	for (const methods of Object.values(openApiDocument.paths)) {
		for (const operation of Object.values(methods)) {
			if (!operation.requestBody) continue
			const body = operation.requestBody.content['application/json']
			assert.ok(body.schema)
			const schema = body.schema.$ref
				? openApiDocument.components.schemas[body.schema.$ref.split('/').at(-1)]
				: body.schema
			assert.equal(schema.additionalProperties, false)
			assert.ok(body.example && !Array.isArray(body.example))
			assert.ok(operation.responses[400])
			assert.ok(operation.responses[413])
		}
	}
	const levels = openApiDocument.components.schemas.LevelChange
	assert.deepEqual(levels.oneOf, [{ required: ['level'] }, { required: ['delta'] }])
	assert.equal(levels.properties.level.minimum, 0)
	assert.equal(levels.properties.level.maximum, 1)
	assert.equal(levels.properties.delta.minimum, -1)
	assert.equal(levels.properties.delta.maximum, 1)
	const brightness = openApiDocument.components.schemas.Brightness
	assert.equal(brightness.properties.value.maximum, 255)
	assert.equal(brightness.properties.pct.maximum, 100)
	const ducker = openApiDocument.paths['/ducker/depth'].put.requestBody.content['application/json'].schema
	assert.equal(ducker.properties.value.minimum, -60)
	assert.equal(ducker.properties.value.maximum, 0)
	assert.equal(openApiDocument.paths['/pads/{pad}/press'].post.requestBody.required, false)
	const bank = openApiDocument.paths['/pads/bank'].put.requestBody.content['application/json'].schema
	assert.equal(bank.properties.delta.minimum, -8)
	assert.equal(bank.properties.delta.maximum, 8)
	for (const path of ['/health', '/docs']) {
		assert.ok(openApiDocument.paths[path].get.responses[400])
		assert.ok(openApiDocument.paths[path].get.responses[413])
	}
})

test('HTML reference is self-contained and includes every route with placeholder-key curl examples', () => {
	assert.match(apiDocsHtml, /^<!doctype html>/)
	assert.match(apiDocsHtml, /<html lang="en">/)
	assert.doesNotMatch(apiDocsHtml, /<script\b|<iframe\b|<link\b|<img\b|@import|url\(/i)
	assert.match(apiDocsHtml, /Authorization: Bearer \$RODE_API_KEY/)
	assert.match(apiDocsHtml, /X-API-Key: \$RODE_API_KEY/)
	assert.match(apiDocsHtml, /65,536/)
	assert.match(apiDocsHtml, /No CORS/)
	assert.match(apiDocsHtml, /Stream Deck/)
	assert.match(apiDocsHtml, /optimistically/)
	assert.match(apiDocsHtml, /127\.0\.0\.1:8000/)
	for (const [path, methods] of Object.entries(openApiDocument.paths)) {
		assert.ok(apiDocsHtml.includes(`/api/v1${path}`), path)
		for (const [method, operation] of Object.entries(methods)) {
			assert.ok(apiDocsHtml.includes(`id="${operation.operationId}"`))
			assert.ok(apiDocsHtml.includes(`curl -sS -X ${method.toUpperCase()}`))
		}
	}
	assert.doesNotMatch(apiDocsHtml, /\?(?:key|api_key|token)=/i)
})
