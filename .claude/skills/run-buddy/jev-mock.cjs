// Servidor que imita la API de TypeSafe (Jev) para probar Buddy sin red ni API key.
// Variables: PORT (47811), DELAY_MS (150), CONF (0.84), NEEDS (0.93),
// BOX="top,bottom,left,right" en fracciones (por defecto: "Ajustes" en la barra lateral del panel).
// Guarda su PID en PID_FILE (/tmp/jev-mock.pid) para poder detenerlo con: kill "$(cat /tmp/jev-mock.pid)"
const fs = require('node:fs')
const http = require('node:http')

const pidFile = process.env.PID_FILE || '/tmp/jev-mock.pid'

const port = Number(process.env.PORT || 47811)
const delay = Number(process.env.DELAY_MS || 150)
const [top, bottom, left, right] = (process.env.BOX || '0.356,0.38,0.165,0.215').split(',').map(Number)

http
  .createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} auth=${Boolean(req.headers.authorization)} images=${req.headers['typesafe-danger-zone-images'] || '-'}`)
      if (req.url === '/v1/models') return send(200, { models: [{ name: 'jev-preview', description: 'mock', release_date: '2026-09-01' }] })
      if (req.url !== '/v1/systemone') return send(404, { error: 'not found' })
      setTimeout(
        () =>
          send(200, {
            model: 'jev-preview',
            answers: {
              needsPoint: { type: 'noul', noul: Number(process.env.NEEDS || 0.93) },
              target: { type: 'box', box: { top, bottom, left, right }, confidence: Number(process.env.CONF || 0.84) }
            },
            usage: { input_tokens: 900, output_tokens: 3 }
          }),
        delay
      )
    })
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`El puerto ${port} ya está en uso: ¿quedó otro jev-mock? Detenlo con: kill "$(cat ${pidFile})"`)
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
  .listen(port, '127.0.0.1', () => {
    fs.writeFileSync(pidFile, String(process.pid))
    console.log(`jev-mock escuchando en http://127.0.0.1:${port} (pid ${process.pid})`)
  })
