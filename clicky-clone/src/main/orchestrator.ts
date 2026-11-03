// Claude como orquestador: para las tareas largas y complejas, Claude Code (con tu suscripción)
// decide qué hacer y usa las herramientas rápidas de Buddy por MCP (Jev para mirar, el ayudante
// para hacer clic y escribir). Lo que funciona lo puede guardar como rutina para repetirlo rápido.
import { screen } from 'electron'
import type { AgentTask } from '../shared/types'
import type { AgentManager } from './agents'
import type { AppleServices } from './apple'
import type { Shot } from './capture'
import { findBinary } from './cli'
import { imagePointToScreen, screenPointToImage } from './core/answer'
import { argNumber, argString, textResult, type McpTool, type McpToolResult } from './core/mcp'
import { describeStep, matchRoutine, normalizeRoutine, STEP_KINDS } from './core/routines'
import { pickInputBackend, type InputBackend } from './input-backend'
import { BuddyMcpServer } from './mcp-server'
import { openTarget } from './open-target'
import type { RoutineHost, RoutineManager } from './routines'
import { ScreenGuard } from './screen-guard'
import type { SettingsStore } from './settings'
import type { ScreenVision } from './vision'

const READ_ONLY = { type: 'object', properties: {}, additionalProperties: false }

export function orchestratorInstructions(lang: 'es' | 'en', screenControl: boolean): string {
  const tools = [
    '- screen_check(condition): yes/no question about the screen, answered by a fast vision model (~0.3 s). Use it to verify states.',
    '- screen_find(target): locate an element; returns its position.',
    '- wait_for(condition, timeout_seconds): wait until something is visible.',
    '- screen_look(): a screenshot for you to see (slower; use it to understand the screen and when something unexpected happens).',
    '- screen_read(): visible text with coordinates (on-device OCR, macOS only).',
    '- say(text): tell the user something short, out loud.',
    '- list_routines(), run_routine(name), save_routine(name, description, steps): saved routines.'
  ]
  if (screenControl) {
    tools.splice(3, 0, '- click(target | x,y), type_text(text, target?), press_keys(keys), scroll(direction), open(target): act on the screen.')
  }
  return [
    lang === 'es'
      ? 'Modo orquestador de Buddy: el usuario te pidió una tarea que se hace en su pantalla.'
      : "Buddy orchestrator mode: the user asked for a task that happens on their screen.",
    'You have fast MCP tools from Buddy (mcp__buddy__*):',
    ...tools,
    screenControl
      ? 'Work step by step: look at the screen first, act, and verify each result with screen_check or wait_for before continuing. Prefer click with a short visual "target" description in English; use x,y (pixels of your latest screen_look) only when there is no good description.'
      : 'You cannot click or type on this computer (no permission): look, point with screen_find and tell the user what to do with say.',
    'If the task is repeatable (a QA check, a flow the user will run again), once it works save it with save_routine so Buddy can repeat it fast without you. Write "target" and "condition" in English as short visual descriptions.',
    'Never do destructive actions (delete, pay, send messages to other people) unless the user explicitly asked for them.',
    'If the user presses Esc or moves the mouse, the task stops: that is expected.',
    lang === 'es'
      ? 'Al terminar responde con un resumen muy breve (1-2 frases, sin markdown) de lo que hiciste y si guardaste una rutina: se leerá en voz alta.'
      : 'When done, reply with a very short summary (1-2 sentences, no markdown) of what you did and whether you saved a routine: it will be read aloud.'
  ].join('\n')
}

export class Orchestrator {
  private readonly server: BuddyMcpServer
  private lastShot: Shot | null = null
  private active: { taskId: string; guard: ScreenGuard | null } | null = null
  private readonly deps: {
    settings: SettingsStore
    apple: AppleServices
    vision: ScreenVision
    routines: RoutineManager
    agents: AgentManager
    host: () => RoutineHost | null
  }

  constructor(deps: Orchestrator['deps']) {
    this.deps = deps
    this.server = new BuddyMcpServer(
      {
        name: 'buddy',
        version: '1.0.0',
        instructions: 'Buddy: fast screen tools (Jev vision, on-device OCR, keyboard and mouse) and saved routines.'
      },
      () => this.tools()
    )
    deps.agents.on('finished', (task: AgentTask) => {
      if (this.active?.taskId !== task.id) return
      this.active.guard?.stop()
      this.active = null
      const host = this.deps.host()
      host?.buddy({ type: 'unpoint' }, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id)
    })
  }

  get busy(): boolean {
    return this.active !== null
  }

  private get es(): boolean {
    return this.deps.settings.get().language === 'es'
  }

  private screenControl(): InputBackend | null {
    if (!this.deps.settings.get().orchestrator.screenControl) return null
    return pickInputBackend(this.deps.apple).backend
  }

  /** Lanza a Claude como orquestador (o el proveedor elegido si Claude no está instalado). */
  async start(prompt: string, shot: Shot | null): Promise<AgentTask> {
    const s = this.deps.settings.get()
    if (this.active) throw new Error(this.es ? 'Ya hay una tarea usando la pantalla.' : 'A task is already using the screen.')
    if (!this.deps.apple.trusted && this.deps.apple.hasHelper) await this.deps.apple.refresh()
    const hasClaude = Boolean(findBinary('claude', s.claude.binary))
    if (!hasClaude) {
      // Sin Claude Code no hay MCP: queda como agente normal en segundo plano.
      return this.deps.agents.start(prompt, shot)
    }
    await this.server.start()
    const control = this.screenControl()
    const task = this.deps.agents.start(prompt, shot, {
      provider: 'claude',
      mcp: { config: this.server.config(), allowedTools: ['mcp__buddy'], instructions: orchestratorInstructions(s.language, Boolean(control)) }
    })
    const guard = control
      ? new ScreenGuard({
          onStop: (why) => {
            // También la rutina que Claude haya lanzado, si sigue en marcha.
            this.deps.routines.stop(why)
            this.deps.agents.cancel(task.id)
            this.deps.host()?.announce(why)
          },
          watchMouse: s.routines.stopOnMouseMove,
          es: s.language === 'es'
        })
      : null
    this.active = { taskId: task.id, guard }
    return task
  }

  stop(): void {
    if (this.active) this.deps.agents.cancel(this.active.taskId)
  }

  private display() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  private async look(): Promise<Shot> {
    const host = this.deps.host()
    if (!host) throw new Error('Buddy todavía está arrancando.')
    const shot = await host.capture(this.display())
    this.lastShot = shot
    return shot
  }

  private input(): InputBackend {
    const backend = this.screenControl()
    if (!backend) {
      throw new Error(this.es ? 'No puedo hacer clics ni escribir en este equipo (falta permiso o está desactivado).' : 'I cannot click or type on this computer.')
    }
    return this.active?.guard?.wrap(backend) ?? backend
  }

  private where(shot: Shot, p: { x: number; y: number }): string {
    const img = screenPointToImage(p, shot, shot.display.bounds)
    return `screen (${Math.round(p.x)}, ${Math.round(p.y)}), latest screenshot pixels (${Math.round(img.x)}, ${Math.round(img.y)})`
  }

  private async find(target: string, signal: AbortSignal): Promise<{ shot: Shot; point: { x: number; y: number }; detail: string }> {
    const shot = await this.look()
    const loc = await this.deps.vision.locate(shot, target, signal)
    if (!loc) throw new Error(`Not found on screen: "${target}". Try screen_look to see the screen.`)
    if (loc.confidence !== null && loc.confidence < 0.5) {
      throw new Error(`Not sure where "${target}" is (confidence ${loc.confidence.toFixed(2)}). Try screen_look, or describe it differently.`)
    }
    this.deps.host()?.pointScreen(loc.point, target, shot.display.id)
    const conf = loc.confidence !== null ? `, confidence ${loc.confidence.toFixed(2)}` : ''
    return { shot, point: loc.point, detail: `Found "${target}" (${loc.via}${conf}) at ${this.where(shot, loc.point)}.` }
  }

  tools(): McpTool[] {
    const control = Boolean(this.screenControl())
    const tools: McpTool[] = [
      {
        name: 'screen_look',
        description: 'Screenshot of the screen under the cursor, for you to look at. Slower than screen_check; use it to understand the screen.',
        inputSchema: READ_ONLY,
        readOnly: true,
        handler: async (): Promise<McpToolResult> => {
          const shot = await this.look()
          return {
            content: [
              { type: 'image', data: shot.base64, mimeType: shot.mime },
              { type: 'text', text: `Screenshot ${shot.width}x${shot.height} px. click accepts x,y in these pixels.` }
            ]
          }
        }
      },
      {
        name: 'screen_check',
        description: 'Ask a yes/no question about the current screen with a fast vision model (~0.3 s). Returns the probability that it is true.',
        inputSchema: {
          type: 'object',
          properties: { condition: { type: 'string', description: 'Short visual description in English, e.g. "a green Saved message".' } },
          required: ['condition']
        },
        readOnly: true,
        handler: async (args, signal) => {
          const condition = argString(args, 'condition', true, 300)
          const shot = await this.look()
          const c = await this.deps.vision.check(shot, condition, signal)
          return textResult(`Probability ${c.probability.toFixed(2)} (${c.via}, ${c.ms} ms): ${c.probability >= 0.6 ? 'yes' : c.probability <= 0.4 ? 'no' : 'unsure'}.`)
        }
      },
      {
        name: 'screen_find',
        description: 'Locate an element on screen and point the buddy at it. Returns its position.',
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string', description: 'Short visual description in English, e.g. "the blue Save button".' } },
          required: ['target']
        },
        readOnly: true,
        handler: async (args, signal) => textResult((await this.find(argString(args, 'target', true, 200), signal)).detail)
      },
      {
        name: 'wait_for',
        description: 'Wait until a condition is visible on screen (checks every ~0.4 s).',
        inputSchema: {
          type: 'object',
          properties: {
            condition: { type: 'string' },
            timeout_seconds: { type: 'number', description: 'Default 15, max 120.' }
          },
          required: ['condition']
        },
        readOnly: true,
        handler: async (args, signal) => {
          const condition = argString(args, 'condition', true, 300)
          const timeout = Math.min(120, Math.max(1, argNumber(args, 'timeout_seconds') ?? 15)) * 1000
          const started = Date.now()
          let last = 0
          while (Date.now() - started < timeout) {
            const c = await this.deps.vision.check(await this.look(), condition, signal)
            last = c.probability
            if (c.probability >= 0.6) return textResult(`Visible after ${((Date.now() - started) / 1000).toFixed(1)} s (probability ${c.probability.toFixed(2)}).`)
            await new Promise((r) => setTimeout(r, 400))
            if (signal.aborted) throw new Error('Cancelled')
          }
          return textResult(`Not visible after ${timeout / 1000} s (last probability ${last.toFixed(2)}).`, true)
        }
      },
      {
        name: 'screen_read',
        description: 'Visible text on screen with positions (pixels of the screenshot), using on-device OCR. macOS only.',
        inputSchema: READ_ONLY,
        readOnly: true,
        handler: async (_args, signal) => {
          if (!this.deps.apple.ocrAvailable) throw new Error('OCR is only available on macOS with the Buddy helper. Use screen_look instead.')
          const shot = await this.look()
          const ocr = await this.deps.apple.ocr(shot.path, signal)
          const lines = ocr.lines.slice(0, 250).map((l) => `"${l.text}" @ (${Math.round(l.x + l.w / 2)}, ${Math.round(l.y + l.h / 2)})`)
          return textResult(lines.length ? `Screenshot ${shot.width}x${shot.height} px:\n${lines.join('\n')}` : 'No text found.')
        }
      },
      {
        name: 'say',
        description: 'Say something short to the user, out loud (progress or a question you cannot resolve).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: async (args) => {
          this.deps.host()?.say(argString(args, 'text', true, 400))
          return textResult('Said.')
        }
      },
      {
        name: 'list_routines',
        description: 'List the saved routines (repeatable QA checks and flows).',
        inputSchema: READ_ONLY,
        readOnly: true,
        handler: async () => {
          const list = this.deps.routines.list()
          if (!list.length) return textResult('No saved routines yet.')
          return textResult(
            list
              .map((r) => `- ${r.name} (${r.steps.length} steps${r.lastRun ? `, last run: ${r.lastRun.status}` : ''}): ${r.description}`)
              .join('\n')
          )
        }
      },
      {
        name: 'run_routine',
        description: 'Run a saved routine by name and get its report (fast: no model calls unless a step needs one).',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        handler: async (args, signal) => {
          const name = argString(args, 'name', true, 120)
          const routine = matchRoutine(name, this.deps.routines.list())
          if (!routine) throw new Error(`No routine called "${name}". Use list_routines.`)
          // Si Claude se detiene (Esc, cancelación), la rutina también.
          const onAbort = (): void => this.deps.routines.stop()
          signal.addEventListener('abort', onAbort, { once: true })
          const run = await this.deps.routines.run(routine.id, 'orchestrator').finally(() => signal.removeEventListener('abort', onAbort))
          const lines = run.steps.map((st) => `${st.index + 1}. [${st.status}] ${routine.steps[st.index] ? describeStep(routine.steps[st.index], 'en') : ''} ${st.detail}`)
          return textResult(`${run.status.toUpperCase()}: ${run.summary ?? ''}\n${lines.join('\n')}`, run.status !== 'passed')
        }
      },
      {
        name: 'save_routine',
        description:
          'Save a repeatable routine so Buddy can run it fast later without you. Steps use kinds: open, click, type, key, scroll, wait, waitFor, check, point, say, ask.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name (2-5 words) in the user language.' },
            description: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: [...STEP_KINDS] },
                  target: { type: 'string', description: 'click/point/type: element; open: URL or app.' },
                  text: { type: 'string', description: 'type: text ({{aleatorio}}, {{fecha}} allowed); say: sentence.' },
                  keys: { type: 'string', description: 'key: e.g. "enter", "cmd+s".' },
                  condition: { type: 'string', description: 'check/waitFor: what must be visible; ask: question.' },
                  expect: { type: 'boolean', description: 'check: false = must NOT be visible.' },
                  seconds: { type: 'number' },
                  direction: { type: 'string', enum: ['up', 'down'] },
                  note: { type: 'string' }
                },
                required: ['kind']
              }
            }
          },
          required: ['name', 'steps']
        },
        handler: async (args) => {
          const { routine, warnings } = normalizeRoutine(args)
          if (!routine.steps.length) throw new Error('The routine has no valid steps.')
          const saved = this.deps.routines.add(routine, 'orchestrator')
          return textResult(`Saved routine "${saved.name}" with ${saved.steps.length} steps.${warnings.length ? ` Warnings: ${warnings.join(' ')}` : ''}`)
        }
      }
    ]
    if (!control) return tools
    const acting: McpTool[] = [
      {
        name: 'click',
        description: 'Click an element. Prefer "target" (short visual description in English); x,y are pixels of your latest screen_look.',
        inputSchema: {
          type: 'object',
          properties: { target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } },
          additionalProperties: false
        },
        handler: async (args, signal) => {
          const double = args.double === true
          const target = argString(args, 'target', false, 200)
          if (target) {
            const found = await this.find(target, signal)
            await this.input().click(found.point, double)
            return textResult(`Clicked. ${found.detail}`)
          }
          const x = argNumber(args, 'x')
          const y = argNumber(args, 'y')
          if (x === null || y === null) throw new Error('Pass "target" or x and y.')
          if (!this.lastShot) throw new Error('Call screen_look first: x,y are pixels of that screenshot.')
          const p = imagePointToScreen({ x, y }, this.lastShot, this.lastShot.display.bounds)
          this.deps.host()?.pointScreen(p, '', this.lastShot.display.id)
          await this.input().click(p, double)
          return textResult(`Clicked at ${this.where(this.lastShot, p)}.`)
        }
      },
      {
        name: 'type_text',
        description: 'Type text. If "target" is given, click it first to focus it.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' }, target: { type: 'string' } }, required: ['text'] },
        handler: async (args, signal) => {
          const text = argString(args, 'text', true, 4000)
          const target = argString(args, 'target', false, 200)
          if (target) await this.input().click((await this.find(target, signal)).point, false)
          await this.input().type(text)
          return textResult(`Typed ${text.length} characters.`)
        }
      },
      {
        name: 'press_keys',
        description: `Press a key or combination, e.g. "enter", "tab", "escape", "${process.platform === 'darwin' ? 'cmd' : 'ctrl'}+s".`,
        inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
        handler: async (args) => {
          const keys = argString(args, 'keys', true, 60)
          await this.input().key(keys)
          return textResult(`Pressed ${keys}.`)
        }
      },
      {
        name: 'scroll',
        description: 'Scroll the area under the cursor.',
        inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] },
        handler: async (args) => {
          const direction = args.direction === 'up' ? 'up' : 'down'
          await this.input().scroll(direction)
          return textResult(`Scrolled ${direction}.`)
        }
      },
      {
        name: 'open',
        description: 'Open a URL (or an app by name on macOS).',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        handler: async (args) => {
          const target = argString(args, 'target', true, 500)
          await openTarget(target, this.es)
          return textResult(`Opened ${target}. Use wait_for before interacting.`)
        }
      }
    ]
    return [...tools, ...acting]
  }
}
