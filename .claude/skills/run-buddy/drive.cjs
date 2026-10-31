// Arranca Buddy (clicky-clone) en Electron, hace una pregunta real y guarda lo que se ve.
// Uso: xvfb-run -a -s "-screen 0 1440x900x24" node drive.cjs
// Variables: QUESTION, JEV=mock|off (mock por defecto), JEV_URL, OUT (/tmp/buddy-run).
const { _electron: electron } = require('playwright')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP = path.resolve(__dirname, '../../../clicky-clone')
const OUT = process.env.OUT || '/tmp/buddy-run'
const QUESTION = process.env.QUESTION || '¿Dónde cambio los atajos de teclado?'
const JEV = process.env.JEV || 'mock'
const JEV_URL = process.env.JEV_URL || 'http://127.0.0.1:47811'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const env = { ...process.env }
  if (JEV === 'mock') Object.assign(env, { TYPESAFE_API_KEY: 'ts-mock', TYPESAFE_BASE_URL: JEV_URL })
  const app = await electron.launch({
    executablePath: require(path.join(APP, 'node_modules/electron')),
    args: [APP, '--no-sandbox', '--show-panel'],
    cwd: APP,
    env
  })
  try {
    await wait(4000)
    const page = (name) => app.windows().find((w) => w.url().includes(name))
    const panel = page('panel.html')
    const overlay = page('overlay.html')
    const prompt = page('prompt.html')
    if (!panel || !overlay || !prompt) throw new Error(`Faltan ventanas: ${app.windows().map((w) => w.url()).join(', ')}`)
    for (const w of [panel, overlay, prompt]) w.on('pageerror', (e) => console.log(`[${w.url().split('/').pop()}] ERROR ${e.message}`))

    await panel.evaluate((engine) => window.buddy.setSettings({ language: 'es', onboarded: true, pointer: { engine } }), JEV === 'off' ? 'model' : 'jev')
    console.log('proveedores:', JSON.stringify((await panel.evaluate(() => window.buddy.getProviderStatus())).map((p) => `${p.id}: ${p.detail}`)))
    if (JEV !== 'off') console.log('jev:', JSON.stringify(await panel.evaluate(() => window.buddy.testJev())))

    // Sin gestor de ventanas, "siempre encima" no se respeta: volvemos a mostrar el panel para que quede encima del overlay.
    await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel.html'))
      p.hide()
      p.show()
    })
    await wait(1200)

    await overlay.evaluate(() => {
      window.__t0 = performance.now()
      window.__cmds = []
      window.buddy.onBuddy((c) => window.__cmds.push({ t: Math.round(performance.now() - window.__t0), ...c }))
    })
    const before = (await panel.evaluate(() => window.buddy.getHistory())).length
    await prompt.evaluate((q) => window.buddy.askText(q), QUESTION)
    let history = []
    for (let i = 0; i < 240 && history.length <= before; i++) {
      await wait(250)
      history = await panel.evaluate(() => window.buddy.getHistory())
    }
    if (history.length <= before) throw new Error('Buddy no respondió en 60 s (¿Claude Code tiene sesión? ejecuta: claude auth status)')
    await wait(1500)

    const timeline = (await overlay.evaluate(() => window.__cmds)).filter((c) => c.type !== 'level')
    console.log('cronología:', JSON.stringify(timeline.map(({ t, type, state, x, y, label }) => ({ t, type, state, x, y, label }))))
    console.log('respuesta:', JSON.stringify(history[history.length - 1]))

    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1440x900', '-i', process.env.DISPLAY, '-frames:v', '1', path.join(OUT, 'screen.png')])
    await overlay.screenshot({ path: path.join(OUT, 'overlay.png'), omitBackground: true })
    await panel.screenshot({ path: path.join(OUT, 'panel.png') })
    console.log(`capturas en ${OUT}: screen.png (pantalla X), overlay.png (buddy, transparente), panel.png`)
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error('FALLÓ:', e.message)
  process.exit(1)
})
