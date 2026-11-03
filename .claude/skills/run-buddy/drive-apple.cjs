// Prueba de punta a punta de la rama de Apple Intelligence + rutinas + orquestador, con el ayudante
// de macOS simulado (test/fixtures/fake-apple-helper.mjs) y Jev simulado (jev-mock.cjs).
// Uso: xvfb-run -a -s "-screen 0 1440x900x24" node drive-apple.cjs
// Variables: STEPS="fast,voice,complex,create,run,orchestrate" (por defecto: fast,voice,run),
//            OUT (/tmp/buddy-apple), JEV=mock|off, JEV_URL.
// "complex", "create" y "orchestrate" usan Claude de verdad (gastan peticiones de tu plan).
const { _electron: electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP = path.resolve(__dirname, '../../../clicky-clone')
const OUT = process.env.OUT || '/tmp/buddy-apple'
const STEPS = (process.env.STEPS || 'fast,voice,run').split(',').map((s) => s.trim())
const JEV = process.env.JEV || 'mock'
const JEV_URL = process.env.JEV_URL || 'http://127.0.0.1:47811'
const FAKE_LOG = path.join(OUT, 'fake-apple.log')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Una rutina de ejemplo que no necesita a Claude (la que usaría "create" la define Claude). */
// Inofensiva en un equipo real: escribe en el cuadro de tareas de Agentes pero no lo envía.
const SAMPLE = {
  name: 'Revisar Agentes',
  description: 'Abre Agentes en el panel de Buddy, escribe una tarea de prueba sin enviarla y comprueba que no hay errores.',
  steps: [
    { kind: 'click', target: 'the Agentes item in the left sidebar' },
    { kind: 'waitFor', condition: 'a page titled Agentes', seconds: 5 },
    { kind: 'type', target: 'the task description text box', text: 'prueba qa-{{aleatorio}}' },
    { kind: 'key', keys: 'tab' },
    { kind: 'check', condition: 'a Lanzar agente button' },
    { kind: 'check', condition: 'an error message', expect: false }
  ]
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.rmSync(FAKE_LOG, { force: true })
  const env = {
    ...process.env,
    BUDDY_E2E: '1',
    BUDDY_APPLE_HELPER: path.join(APP, 'test/fixtures/fake-apple-helper.mjs'),
    FAKE_APPLE_LOG: FAKE_LOG,
    FAKE_APPLE_STT_TEXT: process.env.FAKE_APPLE_STT_TEXT || 'ejecuta la rutina revisar agentes'
  }
  if (JEV === 'mock') Object.assign(env, { TYPESAFE_API_KEY: 'ts-mock', TYPESAFE_BASE_URL: JEV_URL })
  const app = await electron.launch({
    executablePath: require(path.join(APP, 'node_modules/electron')),
    // Micrófono simulado de Chromium (un pitido) para probar el dictado en streaming.
    args: [APP, '--no-sandbox', '--show-panel', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: APP,
    env
  })
  const logs = []
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  try {
    await wait(4000)
    const page = (name) => app.windows().find((w) => w.url().includes(name))
    const panel = page('panel.html')
    const overlay = page('overlay.html')
    const prompt = page('prompt.html')
    if (!panel || !overlay || !prompt) throw new Error(`Faltan ventanas: ${app.windows().map((w) => w.url()).join(', ')}`)
    for (const w of [panel, overlay, prompt]) w.on('pageerror', (e) => console.log(`[${w.url().split('/').pop()}] ERROR ${e.message}`))

    await panel.evaluate(
      (engine) => window.buddy.setSettings({ language: 'es', onboarded: true, pointer: { engine }, stt: { engine: 'auto' }, apple: { enabled: true, fastAnswers: true } }),
      JEV === 'off' ? 'model' : 'jev'
    )
    console.log('apple:', JSON.stringify(await panel.evaluate(() => window.buddy.getAppleStatus())))

    const reshowPanel = () =>
      app.evaluate(({ BrowserWindow }) => {
        const p = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel.html'))
        p.hide()
        p.show()
      })
    await reshowPanel()
    await wait(800)

    await overlay.evaluate(() => {
      window.__t0 = performance.now()
      window.__cmds = []
      window.buddy.onBuddy((c) => window.__cmds.push({ t: Math.round(performance.now() - window.__t0), ...c }))
    })
    const resetTimeline = () => overlay.evaluate(() => ((window.__t0 = performance.now()), (window.__cmds = [])))
    const timeline = async () =>
      (await overlay.evaluate(() => window.__cmds))
        .filter((c) => c.type !== 'level' && c.type !== 'hide-for-capture' && c.type !== 'show-after-capture')
        .map(({ t, type, state, text, x, y, label }) => ({ t, type, state, text, x, y, label }))
    const history = () => panel.evaluate(() => window.buddy.getHistory())
    const waitHistory = async (before, ms = 60_000) => {
      for (let i = 0; i < ms / 250; i++) {
        const h = await history()
        if (h.length > before) return h[h.length - 1]
        await wait(250)
      }
      throw new Error('Buddy no respondió a tiempo')
    }
    const ask = async (q) => {
      await resetTimeline()
      const before = (await history()).length
      await prompt.evaluate((text) => window.buddy.askText(text), q)
      const turn = await waitHistory(before)
      await wait(1200)
      return turn
    }

    if (STEPS.includes('fast')) {
      console.log('\n== Pregunta sencilla: Apple Intelligence responde y señala (Jev u OCR)')
      const turn = await ask('¿Dónde cambio los atajos de teclado?')
      console.log('cronología:', JSON.stringify(await timeline()))
      console.log('respuesta:', JSON.stringify(turn))
    }

    if (STEPS.includes('complex')) {
      console.log('\n== Pregunta compleja: Apple Intelligence la pasa a Claude')
      const turn = await ask('Explícame con detalle qué puedo configurar en esta pantalla y por qué')
      console.log('respuesta:', JSON.stringify(turn))
    }

    // Una rutina para "voice" y "run": la de ejemplo, o la que define Claude con "create".
    let routine
    if (STEPS.includes('create')) {
      console.log('\n== Crear una rutina con Claude')
      const started = Date.now()
      routine = await panel.evaluate(
        (d) => window.buddy.createRoutine(d),
        'En el panel de Buddy: haz clic en Ajustes en la barra lateral, espera a que cargue la página y comprueba que aparece la sección de atajos de teclado y que no hay ningún error.'
      )
      console.log(`rutina (${((Date.now() - started) / 1000).toFixed(1)} s):`, JSON.stringify({ name: routine.name, steps: routine.steps }))
    } else if (STEPS.includes('voice') || STEPS.includes('run')) {
      routine = await app.evaluate((_e, sample) => {
        const { routines } = globalThis.__buddyE2E
        return routines.list().find((r) => r.name === sample.name) ?? routines.add(sample, 'manual')
      }, SAMPLE)
    }

    if (STEPS.includes('voice')) {
      console.log('\n== Dictado de Apple en streaming (micrófono simulado) → "ejecuta la rutina …"')
      await resetTimeline()
      await app.evaluate(() => globalThis.__buddyE2E.assistant.toggleTalk())
      await wait(3000)
      await app.evaluate(() => globalThis.__buddyE2E.assistant.toggleTalk())
      for (let i = 0; i < 160; i++) {
        const runs = await panel.evaluate(() => window.buddy.listRuns())
        if (runs[0] && runs[0].trigger === 'voice' && runs[0].status !== 'running') break
        await wait(250)
      }
      const tl = await timeline()
      console.log('hints mientras hablaba:', JSON.stringify(tl.filter((c) => c.state === 'listening' && c.text).map((c) => c.text)))
      const runs = await panel.evaluate(() => window.buddy.listRuns())
      console.log('ejecución por voz:', JSON.stringify(runs[0] && { status: runs[0].status, trigger: runs[0].trigger, summary: runs[0].summary }))
    }

    if (STEPS.includes('run')) {
      console.log('\n== Ejecutar la rutina desde el panel')
      await resetTimeline()
      const started = Date.now()
      await panel.evaluate((id) => window.buddy.runRoutine(id), routine.id)
      let run
      for (let i = 0; i < 240; i++) {
        await wait(250)
        const runs = await panel.evaluate(() => window.buddy.listRuns())
        run = runs.find((r) => r.trigger === 'manual')
        if (run && run.status !== 'running') break
      }
      console.log(`informe (${((Date.now() - started) / 1000).toFixed(1)} s):`, JSON.stringify({ status: run.status, summary: run.summary }))
      for (const st of run.steps) console.log(`  ${st.index + 1}. [${st.status}] ${st.detail} ${st.via ? `(${st.via}, ${st.ms} ms)` : `(${st.ms} ms)`}`)
      const actions = fs.existsSync(FAKE_LOG)
        ? fs
            .readFileSync(FAKE_LOG, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
            .filter((e) => e.method.startsWith('input.'))
        : []
      console.log('acciones de teclado/ratón:', JSON.stringify(actions.map(({ method, x, y, text, key, modifiers }) => ({ method, x, y, text, key, modifiers }))))
    }

    if (STEPS.includes('orchestrate')) {
      console.log('\n== Claude como orquestador con las herramientas de Buddy (MCP)')
      const before = (await panel.evaluate(() => window.buddy.listAgents())).length
      await prompt.evaluate(
        (text) => window.buddy.askText(text),
        'Hazlo tú: comprueba con screen_check si en la pantalla hay una barra lateral con la opción Ajustes y ejecuta la rutina Revisar Agentes. No hagas nada más.'
      )
      let task
      for (let i = 0; i < 720; i++) {
        await wait(500)
        const tasks = await panel.evaluate(() => window.buddy.listAgents())
        task = tasks.length > before ? tasks[0] : undefined
        if (task && task.status !== 'running') break
      }
      console.log('tarea:', JSON.stringify(task && { kind: task.kind, status: task.status, result: task.result }))
      for (const e of task?.events ?? []) if (e.kind === 'tool' || e.kind === 'error') console.log(`  ${e.kind}: ${e.text}`)
    }

    await panel.evaluate(() => document.querySelectorAll('.nav-item')[2]?.click())
    await wait(600)
    await panel.evaluate(() => document.querySelector('.routine .task-head')?.click())
    await wait(400)
    await panel.evaluate(() => document.querySelector('.routine')?.scrollIntoView({ block: 'start' }))
    await reshowPanel()
    await wait(600)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1440x900', '-i', process.env.DISPLAY, '-frames:v', '1', path.join(OUT, 'screen.png')])
    await overlay.screenshot({ path: path.join(OUT, 'overlay.png'), omitBackground: true })
    await panel.screenshot({ path: path.join(OUT, 'panel.png') })
    console.log(`\ncapturas en ${OUT}: screen.png, overlay.png, panel.png (página Rutinas)`)
  } finally {
    fs.writeFileSync(path.join(OUT, 'app.log'), logs.join(''))
    await app.close()
  }
}

main().catch((e) => {
  console.error('FALLÓ:', e.message)
  process.exit(1)
})
