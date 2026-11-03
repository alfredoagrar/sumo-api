#!/bin/sh
# Compila el ayudante nativo de macOS (Xcode 26 o superior, o sus Command Line Tools) y lo deja en
# native/apple/bin/buddy-apple, donde lo busca Buddy.
# Con el SDK de macOS 27 activa BUDDY_SDK_27: Apple Intelligence también ve la captura.
set -e
cd "$(dirname "$0")"
SDK_VERSION=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)
MAJOR=${SDK_VERSION%%.*}
if [ "${MAJOR:-0}" -ge 27 ]; then
  set -- -Xswiftc -DBUDDY_SDK_27 "$@"
fi
swift build -c release "$@"
# La carpeta de salida cambia entre versiones de SwiftPM (.build/release o .build/out/Products/Release).
BIN_DIR=$(swift build -c release "$@" --show-bin-path)
mkdir -p bin
cp "$BIN_DIR/buddy-apple" bin/buddy-apple
echo "Ayudante listo: $(pwd)/bin/buddy-apple (SDK de macOS $SDK_VERSION)"
