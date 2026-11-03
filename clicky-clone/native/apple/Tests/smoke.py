"""Prueba de humo del ayudante compilado: habla con él por stdin/stdout como lo hace Buddy."""
import json
import queue
import subprocess
import sys
import threading
import time

binary, image = sys.argv[1], sys.argv[2]
proc = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, bufsize=1)
messages: "queue.Queue[dict]" = queue.Queue()
threading.Thread(target=lambda: [messages.put(json.loads(line)) for line in proc.stdout], daemon=True).start()


def call(msg_id, method, params=None, timeout=30):
    proc.stdin.write(json.dumps({"id": msg_id, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = messages.get(timeout=max(0.1, deadline - time.time()))
        except queue.Empty:
            break
        if msg.get("id") == msg_id:
            print(f"{method}: {json.dumps(msg, ensure_ascii=False)[:400]}")
            return msg
    sys.exit(f"Sin respuesta a {method}")


status = call(1, "status")
assert "result" in status and "intelligence" in status["result"], status

ocr = call(2, "ocr", {"imagePath": image, "languages": ["es-ES", "en-US"]})
text = " ".join(line["text"] for line in ocr["result"]["lines"])
assert "Guardar" in text, f"El OCR no leyó el texto: {text!r}"
line = ocr["result"]["lines"][0]
assert 0 <= line["x"] < 640 and 0 <= line["y"] < 200, line
print(f"OCR con {ocr['result']['engine']}")

click = call(3, "input.click", {"x": 5, "y": 5})
assert "result" in click or click["error"]["code"] == "not_trusted", click

schema = {
    "name": "Smoke",
    "properties": [
        {"name": "say", "type": "string", "description": "A greeting"},
        {"name": "intent", "type": "string", "enum": ["answer", "complex"]},
        {"name": "confident", "type": "boolean"},
        {"name": "score", "type": "number"},
        {"name": "count", "type": "integer", "optional": True},
        {"name": "items", "type": "array", "items": {"type": "string"}, "maxItems": 2},
        {"name": "point", "type": "object", "properties": [{"name": "x", "type": "number"}, {"name": "y", "type": "number"}]},
    ],
}
generated = call(4, "generate", {"instructions": "Answer briefly.", "prompt": "Say hi", "schema": schema}, timeout=90)
# En los runners no hay Apple Intelligence: basta con que el esquema sea válido.
assert "result" in generated or generated["error"]["code"] in ("unavailable", "generation"), generated

front = call(5, "frontmost")
assert "result" in front, front

unknown = call(6, "nope")
assert unknown["error"]["code"] == "unknown_method", unknown

bad_schema = call(7, "generate", {"prompt": "x", "schema": {"name": "Bad", "properties": [{"name": "a", "type": "date"}]}})
assert bad_schema["error"]["code"] == "invalid_params", bad_schema

# Dictado: voz sintetizada con `say` en Float32 a 16 kHz, enviada en trozos como lo hace Buddy.
# Es informativo: en las máquinas virtuales puede faltar el modelo de dictado, y eso no es un fallo del ayudante.
if len(sys.argv) > 3:
    import base64
    import struct

    with open(sys.argv[3], "rb") as f:
        wav = f.read()
    data_at = wav.find(b"data")
    size = struct.unpack("<I", wav[data_at + 4 : data_at + 8])[0]
    pcm = wav[data_at + 8 : data_at + 8 + size]
    locale = sys.argv[4] if len(sys.argv) > 4 else "es-MX"
    begin = call(8, "stt.begin", {"sid": "smoke", "locale": locale, "sampleRate": 16000, "contextualStrings": ["rutina", "Buddy"]}, timeout=240)
    if "result" in begin:
        chunk = 1600 * 4
        for i in range(0, len(pcm), chunk):
            proc.stdin.write(json.dumps({"method": "stt.audio", "params": {"sid": "smoke", "data": base64.b64encode(pcm[i : i + chunk]).decode()}}) + "\n")
        proc.stdin.flush()
        end = call(9, "stt.end", {"sid": "smoke"}, timeout=60)
        heard = end.get("result", {}).get("text", "")
        print(f"Dictado ({begin['result']['module']}, {begin['result']['locale']}): {heard!r}")
        expected = "rutina" if locale.startswith("es") else "routine"
        print(f"{'Bien' if expected in heard.lower() else 'Aviso'}: {'reconoció' if expected in heard.lower() else 'no reconoció'} «{expected}»")
    else:
        assert begin["error"]["code"] in ("unsupported_locale", "assets", "internal"), begin
        print(f"Dictado no disponible en esta máquina: {begin['error']['message']}")

proc.stdin.close()
proc.wait(timeout=10)
print("Prueba de humo superada")
