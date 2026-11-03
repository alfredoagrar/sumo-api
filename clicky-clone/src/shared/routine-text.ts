// Texto legible de los pasos de una rutina. Lo usan el proceso principal (hint del buddy, resúmenes)
// y el panel.
import type { RoutineSchedule, RoutineStep } from './types'

/** Descripción legible de un paso (para el panel y el hint del buddy). */
export function describeStep(step: RoutineStep, lang: 'es' | 'en' = 'es'): string {
  const es = lang === 'es'
  switch (step.kind) {
    case 'open':
      return `${es ? 'Abrir' : 'Open'} ${step.target}`
    case 'click':
      return `${es ? 'Clic en' : 'Click'} «${step.target}»`
    case 'type':
      return step.target
        ? `${es ? 'Escribir' : 'Type'} «${step.text}» ${es ? 'en' : 'into'} «${step.target}»`
        : `${es ? 'Escribir' : 'Type'} «${step.text}»`
    case 'key':
      return `${es ? 'Pulsar' : 'Press'} ${step.keys}`
    case 'scroll':
      return es ? `Desplazar hacia ${step.direction === 'up' ? 'arriba' : 'abajo'}` : `Scroll ${step.direction ?? 'down'}`
    case 'wait':
      return `${es ? 'Esperar' : 'Wait'} ${step.seconds} s`
    case 'waitFor':
      return `${es ? 'Esperar a que' : 'Wait until'}: ${step.condition}`
    case 'check':
      return step.expect === false ? `${es ? 'Comprobar que NO' : 'Check NOT'}: ${step.condition}` : `${es ? 'Comprobar' : 'Check'}: ${step.condition}`
    case 'point':
      return `${es ? 'Señalar' : 'Point at'} «${step.target}»`
    case 'say':
      return `${es ? 'Decir' : 'Say'} «${step.text}»`
    case 'ask':
      return `${es ? 'Preguntar al modelo' : 'Ask the model'}: ${step.condition}`
  }
}

/** "Cada 30 min", "Cada día a las 09:30"… */
export function describeSchedule(schedule: RoutineSchedule | null): string {
  if (!schedule) return 'Sin programar'
  const parts: string[] = []
  if (schedule.everyMinutes) parts.push(schedule.everyMinutes % 60 === 0 ? `Cada ${schedule.everyMinutes / 60} h` : `Cada ${schedule.everyMinutes} min`)
  if (schedule.dailyAt) parts.push(`Cada día a las ${schedule.dailyAt}`)
  return parts.join(' · ') || 'Sin programar'
}
