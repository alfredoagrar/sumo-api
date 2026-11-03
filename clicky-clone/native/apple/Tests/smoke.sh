#!/bin/sh
# Prueba de humo del ayudante ya compilado (./build.sh). Se usa en la integración continua.
set -e
cd "$(dirname "$0")/.."
BIN="$(pwd)/bin/buddy-apple"
TMP=$(mktemp -d)
xcrun swiftc -swift-version 5 Tests/render-text.swift -o "$TMP/render-text"
"$TMP/render-text" "$TMP/texto.png"
python3 Tests/smoke.py "$BIN" "$TMP/texto.png"
