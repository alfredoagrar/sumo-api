---
name: run-buddy
description: Ejecuta y maneja Buddy (clicky-clone, Electron + React) en un contenedor Linux sin pantalla, con Xvfb y Playwright. Hace una pregunta real con Claude Code (y opcionalmente Jev simulado para señalar), imprime la cronología del buddy y guarda capturas. Úsala para "ejecuta la app", "pruébala de verdad" o para ver un cambio de clicky-clone funcionando.
---

# Ejecutar Buddy (clicky-clone)

Todo se ejecuta desde la raíz del repositorio. Los scripts están junto a este archivo.

## 1. Requisitos (una vez)

```bash
cd clicky-clone && npm install && cd ..
which xvfb-run ffmpeg                      # Xvfb para la pantalla, ffmpeg para capturarla
node -e "require('playwright')"            # Playwright con Chromium ya instalado en el contenedor
claude auth status                         # Claude Code con sesión: responde las preguntas
```

Si `require('playwright')` falla, instálalo fuera del repo (`npm i -g playwright`); **no** ejecutes `playwright install`.

## 2. Compilar

`drive.cjs` arranca lo compilado en `clicky-clone/out/`, así que compila después de cada cambio:

```bash
(cd clicky-clone && npm run build)
```

## 3. Ejecutar y hacer una pregunta

Con Jev simulado (por defecto), en una sola orden que arranca y detiene el servidor que lo imita:

```bash
S=.claude/skills/run-buddy
node $S/jev-mock.cjs > /tmp/jev-mock.log 2>&1 &
sleep 1; cat /tmp/jev-mock.log            # debe decir "jev-mock escuchando…"
xvfb-run -a -s "-screen 0 1440x900x24" node $S/drive.cjs
kill "$(cat /tmp/jev-mock.pid)"           # el mock guarda su propio PID
python3 $S/compose.py /tmp/buddy-run      # composite.png: la pantalla con el buddy encima
```

Ejecuta cada línea por separado. No pongas la compilación del paso 2 en la misma cadena que termina en `&`: la compilación vacía `clicky-clone/out/renderer` y, si coincide con el arranque, el panel muestra "Not found".

Variables útiles:

| Variable | Para qué |
|---|---|
| `QUESTION="…"` | Cambia la pregunta (por defecto: "¿Dónde cambio los atajos de teclado?") |
| `JEV=off` | Sin Jev: señala solo el modelo principal (no hace falta el servidor simulado) |
| `CONF=0.2` (servidor) | Jev poco seguro: debe usarse el punto de Claude |
| `DELAY_MS`, `BOX`, `NEEDS` (servidor) | Latencia, caja y probabilidad de "hay que señalar" de Jev |
| `OUT=/ruta` | Carpeta de las capturas (por defecto `/tmp/buddy-run`) |

## 4. Qué comprobar

- `proveedores:` muestra Claude con "Sesión iniciada con tu cuenta de Claude".
- `cronología:` lista los comandos del buddy con su tiempo en ms. Con Jev seguro aparece `point` a los ~300 ms, y `label` y `speaking` cuando responde Claude (3–4 s). Si Claude decide que no hay que señalar, aparece `unpoint`.
- `respuesta:` es la entrada del historial, con `pointSource`, `jevMs` y `jevDeltaPx`.
- **Mira** `composite.png`: el buddy (flecha azul pequeña) debe estar sobre el elemento, con su etiqueta y el subtítulo.

## Lo que ya se sabe de este entorno

- **Sin gestor de ventanas**, "siempre encima" no se respeta y los overlays transparentes no se componen: el overlay queda detrás del panel y la pantalla X no lo muestra. Por eso `drive.cjs` vuelve a mostrar el panel y captura el overlay aparte con `omitBackground`; `compose.py` los junta.
- Electron como root necesita `--no-sandbox` (ya va en `drive.cjs`).
- **huggingface.co está bloqueado**: el modelo de voz (Whisper) falla con "Failed to fetch". Es normal; por eso la pregunta se hace con `window.buddy.askText` (la barra de texto) y no por voz.
- Xvfb no tiene voces de sistema: Buddy no habla, solo muestra el subtítulo (la app lo detecta y espera el tiempo de lectura).
- `api.typesafe.ai` también está bloqueado y no hay API key: por eso Jev se prueba con `jev-mock.cjs` (`TYPESAFE_BASE_URL`). Su precisión real no se puede medir aquí.
- No busques el mock con `pkill -f` ni `ps | grep` por su nombre: el patrón también coincide con la línea de comandos de tu propia shell (incluido el texto de un heredoc) y la mata. Usa el PID que guarda el propio mock en `/tmp/jev-mock.pid`. Si el mock dice que el puerto está en uso, quedó otro vivo: detenlo con ese PID o búscalo por puerto con `lsof -ti tcp:47811` (no hay `ss` ni `netstat` en el contenedor).
- Cada ejecución gasta una petición real de tu plan de Claude.
