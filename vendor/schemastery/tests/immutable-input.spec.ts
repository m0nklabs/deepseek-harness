import { expect, test } from 'vitest'
import Schema from '../src/index'

test('dict resolver accepts frozen input without mutating it', () => {
  const env = Object.freeze({ COMFY_BIN: '/home/flip/venvs/comfy-mcp/bin/comfy' })
  const schema = Schema.object({ env: Schema.dict(Schema.string()) })
  const result = schema['~standard'].validate({ env })
  expect(result.issues).toBeUndefined()
  expect(result.value.env).toEqual({ COMFY_BIN: '/home/flip/venvs/comfy-mcp/bin/comfy' })
  expect(Object.isFrozen(env)).toBe(true)
  expect(Object.keys(env)).toEqual(['COMFY_BIN'])
})

test('dict resolver preserves ordinary mutable input behavior', () => {
  const schema = Schema.dict(Schema.string())
  const input = { some_key: 'value' }
  const result = schema['~standard'].validate(input)
  expect(result.issues).toBeUndefined()
  expect(result.value.some_key).toBe('value')
})

test('union failure message includes the collected branch errors', () => {
  const schema = Schema.union([
    Schema.object({ transport: Schema.const('stdio'), command: Schema.string().required() }),
    Schema.object({ transport: Schema.const('streamable-http'), url: Schema.string().required() }),
  ])
  const result = schema['~standard'].validate({ transport: 'stdio' })
  expect(result.issues).toBeDefined()
  const message = result.issues![0].message
  expect(message).toContain('branch error')
  expect(message).toContain('missing required value')
})
