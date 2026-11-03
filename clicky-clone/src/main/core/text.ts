// Utilidades de texto para comparar nombres y textos de pantalla sin importar acentos ni mayúsculas.

/** Minúsculas, sin acentos, solo letras y números separados por un espacio. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function tokens(text: string): string[] {
  const n = normalizeText(text)
  return n ? n.split(' ') : []
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>()
  const t = s.replace(/\s+/g, ' ')
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** Coeficiente de Dice sobre bigramas (0-1): tolera errores de dictado pequeños. */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const ga = bigrams(x)
  const gb = bigrams(y)
  let overlap = 0
  let total = 0
  for (const n of ga.values()) total += n
  for (const n of gb.values()) total += n
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0)
  return (2 * overlap) / total
}

/** Parecido entre lo que se busca y un texto: igualdad, contención o bigramas. */
export function matchScore(query: string, candidate: string): number {
  const q = normalizeText(query)
  const c = normalizeText(candidate)
  if (!q || !c) return 0
  if (q === c) return 1
  const sim = similarity(q, c)
  // "ajustes" dentro de "abrir ajustes": buena señal, mejor cuanto más se parezcan las longitudes.
  const contains = c.includes(q) || q.includes(c) ? 0.75 + 0.2 * (Math.min(q.length, c.length) / Math.max(q.length, c.length)) : 0
  return Math.max(sim, contains)
}
