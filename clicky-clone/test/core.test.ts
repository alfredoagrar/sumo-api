import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  captureSize,
  cleanSpoken,
  extractJsonObject,
  imagePointToScreen,
  parseAnswer,
  screenPointToImage
} from '../src/main/core/answer.ts'
import {
  buildClaudeAgentArgs,
  buildClaudeAskArgs,
  buildClaudeUserMessage,
  buildCodexAgentArgs,
  buildCodexAskArgs,
  quoteForCmd,
  subscriptionEnv
} from '../src/main/core/args.ts'
import { ANSWER_SCHEMA, buildAnswerSystemPrompt, buildAnswerUserPrompt, parseAgentIntent, slugify } from '../src/main/core/prompts.ts'
import { defaultSettings, mergeSettings } from '../src/main/core/settings-merge.ts'
import { friendlyCliError, parseClaudeAuthStatus, parseCodexLoginStatus } from '../src/main/core/status.ts'
import {
  LineSplitter,
  describeClaudeEvent,
  describeCodexEvent,
  readClaudeRateLimit,
  readClaudeResult,
  readCodexError,
  readCodexMessage
} from '../src/main/core/streams.ts'

describe('respuesta del modelo', () => {
  it('lee la salida estructurada', () => {
    const a = parseAnswer({ say: 'Pulsa **Guardar**.', point: { x: 680, y: 445, label: 'Guardar' } }, { width: 800, height: 500 })
    assert.equal(a.say, 'Pulsa Guardar.')
    assert.deepEqual(a.point, { x: 680, y: 445, label: 'Guardar' })
  })

  it('extrae JSON aunque venga con texto alrededor', () => {
    const raw = 'Claro:\n```json\n{"say":"Hola {amigo}","point":null}\n```'
    assert.deepEqual(extractJsonObject(raw), { say: 'Hola {amigo}', point: null })
    assert.equal(parseAnswer(raw).say, 'Hola {amigo}')
  })

  it('usa el texto tal cual si no hay JSON', () => {
    assert.deepEqual(parseAnswer('Solo texto'), { say: 'Solo texto', point: null })
  })

  it('descarta puntos fuera de la captura o inválidos', () => {
    assert.equal(parseAnswer({ say: 'x', point: { x: 900, y: 10, label: 'a' } }, { width: 800, height: 500 }).point, null)
    assert.equal(parseAnswer({ say: 'x', point: { x: 'a', y: 10, label: 'a' } }).point, null)
  })

  it('limpia markdown para leerlo en voz alta', () => {
    assert.equal(cleanSpoken('# Título\n- uno\n- `dos` [enlace](https://x.y)'), 'Título uno dos enlace')
  })
})

describe('coordenadas', () => {
  const display = { x: 1440, y: 0, width: 1512, height: 982 }
  it('convierte de la captura a la pantalla y de vuelta', () => {
    const img = captureSize(3024, 1964)
    const screen = imagePointToScreen({ x: img.width / 2, y: img.height / 2 }, img, display)
    assert.deepEqual(screen, { x: 1440 + 756, y: 491 })
    const back = screenPointToImage(screen, img, display)
    assert.ok(Math.abs(back.x - img.width / 2) < 1 && Math.abs(back.y - img.height / 2) < 1)
  })

  it('reduce la captura a ≤1.15 MP y ≤1568 px', () => {
    for (const [w, h] of [
      [3024, 1964],
      [5120, 2880],
      [1280, 800]
    ]) {
      const s = captureSize(w, h)
      assert.ok(s.width * s.height <= 1_150_000, `${w}x${h}`)
      assert.ok(Math.max(s.width, s.height) <= 1568)
      assert.ok(Math.abs(s.width / s.height - w / h) < 0.01)
    }
    assert.deepEqual(captureSize(800, 600), { width: 800, height: 600 })
  })
})

describe('prompts', () => {
  it('detecta peticiones de agente', () => {
    assert.equal(parseAgentIntent('Agente, investiga vuelos a Madrid'), 'investiga vuelos a Madrid')
    assert.equal(parseAgentIntent('oye agente: crea una página'), 'crea una página')
    assert.equal(parseAgentIntent('Hey agent build me an app'), 'build me an app')
    assert.equal(parseAgentIntent('¿Qué es un agente de viajes?'), null)
    assert.equal(parseAgentIntent('agente'), null)
  })

  it('genera nombres de carpeta seguros', () => {
    assert.equal(slugify('Investiga: ¿cuál es el mejor café?'), 'investiga-cual-es-el-mejor-cafe')
    assert.ok(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30)).length <= 40)
    assert.equal(slugify('!!!'), 'tarea')
  })

  it('incluye tamaño de la captura, cursor e historial', () => {
    const sys = buildAnswerSystemPrompt('es', { width: 1344, height: 840, cursor: { x: 10.4, y: 20.6 } }, true)
    assert.match(sys, /1344×840/)
    assert.match(sys, /\(10, 21\)/)
    assert.match(sys, /No ejecutes comandos/)
    const user = buildAnswerUserPrompt('es', ' ¿y ahora? ', [{ question: 'hola', answer: 'qué tal' }])
    assert.match(user, /Usuario: hola\nBuddy: qué tal/)
    assert.match(user, /"¿y ahora\?"$/)
  })

  it('el esquema cumple el modo estricto de OpenAI', () => {
    assert.equal(ANSWER_SCHEMA.additionalProperties, false)
    assert.deepEqual([...ANSWER_SCHEMA.required].sort(), Object.keys(ANSWER_SCHEMA.properties).sort())
    const point = ANSWER_SCHEMA.properties.point.anyOf[1]
    assert.deepEqual([...point.required].sort(), Object.keys(point.properties).sort())
  })
})

describe('argumentos de las CLIs', () => {
  it('claude -p sin herramientas y con esquema', () => {
    const args = buildClaudeAskArgs({ systemPrompt: 'S', schema: { type: 'object' }, model: 'haiku' })
    assert.equal(args[0], '-p')
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}')
    assert.equal(args[args.indexOf('--model') + 1], 'haiku')
    assert.ok(!buildClaudeAskArgs({ systemPrompt: 'S', schema: {} }).includes('--model'))
  })

  it('el agente de Claude solo usa Bash si se permite', () => {
    const off = buildClaudeAgentArgs({ appendSystemPrompt: 'x', allowShell: false })
    const on = buildClaudeAgentArgs({ appendSystemPrompt: 'x', allowShell: true })
    assert.ok(!off[off.indexOf('--tools') + 1].includes('Bash'))
    assert.ok(on[on.indexOf('--allowedTools') + 1].includes('Bash'))
  })

  it('mensaje stream-json con imagen antes del texto', () => {
    const msg = JSON.parse(buildClaudeUserMessage('hola', { base64: 'AAAA', mime: 'image/jpeg' }))
    assert.equal(msg.type, 'user')
    assert.equal(msg.message.content[0].type, 'image')
    assert.equal(msg.message.content[1].text, 'hola')
  })

  it('codex: --image nunca va justo antes del prompt "-"', () => {
    const ask = buildCodexAskArgs({ cwd: '/t', imagePath: '/t/a.jpg', schemaPath: '/t/s.json', outputPath: '/t/o.json', reasoningEffort: 'low' })
    assert.equal(ask.at(-1), '-')
    assert.notEqual(ask.at(-3), '--image')
    assert.equal(ask[ask.indexOf('--sandbox') + 1], 'read-only')
    assert.ok(ask.includes('model_reasoning_effort=low'))
    const agent = buildCodexAgentArgs({ cwd: '/w', imagePath: '/w/c.jpg', outputPath: '/t/o.txt' })
    assert.equal(agent.at(-1), '-')
    assert.notEqual(agent.at(-3), '--image')
    assert.equal(agent[agent.indexOf('--sandbox') + 1], 'workspace-write')
  })

  it('quita las API keys para usar la suscripción', () => {
    const env = subscriptionEnv('claude', { ANTHROPIC_API_KEY: 'k', PATH: '/bin', OPENAI_API_KEY: 'o' })
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, 'o')
    assert.equal(env.PATH, '/bin')
    assert.equal(subscriptionEnv('codex', { OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c' }).CODEX_API_KEY, undefined)
  })

  it('cita argumentos para cmd.exe', () => {
    assert.equal(quoteForCmd(''), '""')
    assert.equal(quoteForCmd('exec'), 'exec')
    assert.equal(quoteForCmd('C:\\Users\\Ana María\\a.jpg'), '"C:\\Users\\Ana María\\a.jpg"')
  })
})

describe('salida en streaming', () => {
  it('parte por líneas aunque lleguen trozos', () => {
    const lines: string[] = []
    const s = new LineSplitter((l) => lines.push(l))
    s.push('{"a":1}\n{"b"')
    s.push(':2}\n\n{"c":3}')
    s.flush()
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('lee el resultado y los límites de Claude', () => {
    assert.deepEqual(readClaudeResult({ type: 'result', subtype: 'success', is_error: false, result: 'ok', structured_output: { say: 'hi' } }), {
      isError: false,
      text: 'ok',
      structured: { say: 'hi' },
      subtype: 'success'
    })
    assert.equal(readClaudeResult({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '' })?.isError, true)
    assert.match(readClaudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) ?? '', /límite/)
    assert.equal(readClaudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null)
  })

  it('describe eventos de Claude', () => {
    const notes = describeClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Voy' }, { type: 'tool_use', name: 'Write', input: { file_path: '/w/a.md' } }] }
    })
    assert.deepEqual(notes, [
      { kind: 'text', text: 'Voy' },
      { kind: 'tool', text: 'Write: /w/a.md' }
    ])
  })

  it('describe eventos de Codex', () => {
    assert.deepEqual(describeCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }), [
      { kind: 'tool', text: 'Ejecutando: ls' }
    ])
    assert.equal(readCodexMessage({ type: 'item.completed', item: { type: 'agent_message', text: 'Listo' } }), 'Listo')
    assert.equal(readCodexError({ type: 'turn.failed', error: { message: 'boom' } }), 'boom')
    assert.equal(readCodexError({ type: 'error', message: 'Reconnecting... 2/5' }), null)
  })
})

describe('estado de sesión', () => {
  it('Claude con suscripción, API key o sin sesión', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}').usingSubscription, true)
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}').usingSubscription, true)
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}').usingSubscription, false)
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"x","apiProvider":"bedrock"}').usingSubscription, false)
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false}').loggedIn, false)
    assert.equal(parseClaudeAuthStatus('no json').loggedIn, false)
  })

  it('Codex con ChatGPT, API key o sin sesión', () => {
    assert.equal(parseCodexLoginStatus(0, 'Logged in using ChatGPT').usingSubscription, true)
    const key = parseCodexLoginStatus(0, 'Logged in using an API key - sk-proj-abc123')
    assert.equal(key.usingSubscription, false)
    assert.ok(!key.detail.includes('abc123'))
    assert.equal(parseCodexLoginStatus(1, 'Not logged in').loggedIn, false)
  })

  it('mensajes de error claros', () => {
    assert.match(friendlyCliError('claude', "error: unknown option '--json-schema'"), /claude update/)
    assert.match(friendlyCliError('codex', '401 Unauthorized'), /codex login/)
    assert.match(friendlyCliError('claude', 'API Error: 429 rate limit'), /límite/)
  })
})

describe('ajustes', () => {
  it('mezcla solo claves conocidas y valida valores', () => {
    const base = defaultSettings('/w')
    const merged = mergeSettings(base, {
      provider: 'gemini',
      language: 'en',
      voice: { rate: 9, enabled: 'yes' },
      claude: { model: ' haiku ' },
      unknown: 1
    })
    assert.equal(merged.provider, 'claude')
    assert.equal(merged.language, 'en')
    assert.equal(merged.voice.rate, 2)
    assert.equal(merged.voice.enabled, true)
    assert.equal(merged.claude.model, 'haiku')
    assert.ok(!('unknown' in merged))
    assert.equal(mergeSettings(base, null), base)
    assert.equal(base.pointer.engine, 'model')
    assert.equal(mergeSettings(base, { pointer: { engine: 'jev' } }).pointer.engine, 'jev')
    assert.equal(mergeSettings(base, { pointer: { engine: 'magia' } }).pointer.engine, 'model')
  })
})
