/** Texto legible de un acelerador de Electron ("CommandOrControl+Shift+Space" → "⌘⇧Espacio"). */
export function prettyAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin'
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) => {
      switch (part) {
        case 'CommandOrControl':
        case 'CmdOrCtrl':
          return mac ? '⌘' : 'Ctrl'
        case 'Command':
        case 'Cmd':
        case 'Super':
        case 'Meta':
          return mac ? '⌘' : 'Win'
        case 'Control':
        case 'Ctrl':
          return mac ? '⌃' : 'Ctrl'
        case 'Alt':
        case 'Option':
          return mac ? '⌥' : 'Alt'
        case 'Shift':
          return mac ? '⇧' : 'Shift'
        case 'Space':
          return mac ? 'Espacio' : 'Space'
        case 'Return':
        case 'Enter':
          return '↩'
        default:
          return part
      }
    })
    .join(mac ? '' : '+')
}
