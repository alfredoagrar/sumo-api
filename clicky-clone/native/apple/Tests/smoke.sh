#!/bin/sh
# Prueba de humo del ayudante ya compilado (./build.sh). Se usa en la integración continua.
set -e
cd "$(dirname "$0")/.."
BIN="$(pwd)/bin/buddy-apple"
TMP=$(mktemp -d)
xcrun swiftc -swift-version 5 Tests/render-text.swift -o "$TMP/render-text"
"$TMP/render-text" "$TMP/texto.png"
# Voz sintetizada para probar el dictado (en español si hay una voz instalada; si no, en inglés).
# El nombre de la voz puede tener espacios, p. ej. "Eddy (Spanish (Mexico))": lo cogemos entero.
VOICE=$(say -v '?' 2>/dev/null | sed -nE 's/^(.*[^ ]) +es_(MX|ES) +#.*/\1/p' | head -n 1)
echo "Voz para la prueba de dictado: ${VOICE:-ninguna en español}"
if [ -n "$VOICE" ] && say -v "$VOICE" -o "$TMP/voz.aiff" "Ejecuta la rutina de inicio de sesión"; then
  LOCALE=es-MX
else
  say -o "$TMP/voz.aiff" "Run the login routine"
  LOCALE=en-US
fi
afconvert -f WAVE -d LEF32@16000 -c 1 "$TMP/voz.aiff" "$TMP/voz.wav"
python3 Tests/smoke.py "$BIN" "$TMP/texto.png" "$TMP/voz.wav" "$LOCALE"
