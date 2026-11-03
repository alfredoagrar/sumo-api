#!/bin/sh
# Compila el ayudante nativo de macOS (Xcode 26 o superior, o sus Command Line Tools).
# Con el SDK de macOS 27 activa BUDDY_SDK_27: Apple Intelligence también ve la captura.
set -e
cd "$(dirname "$0")"
SDK_VERSION=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)
MAJOR=${SDK_VERSION%%.*}
if [ "${MAJOR:-0}" -ge 27 ]; then
  set -- -Xswiftc -DBUDDY_SDK_27 "$@"
fi
swift build -c release "$@"
echo "Ayudante listo: $(swift build -c release --show-bin-path)/buddy-apple (SDK de macOS $SDK_VERSION)"
