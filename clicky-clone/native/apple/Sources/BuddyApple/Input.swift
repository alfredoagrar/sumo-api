// Teclado y ratón para las rutinas (CGEvent). Necesita el permiso de Accesibilidad de la app que
// lanza el ayudante (Buddy). Las coordenadas son las globales de macOS en puntos, con el origen
// arriba a la izquierda de la pantalla principal (las mismas que usa Electron).
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum Input {
    nonisolated(unsafe) static let source = CGEventSource(stateID: .hidSystemState)

    /// Códigos de tecla (posiciones ANSI de Carbon, kVK_*).
    static let keyCodes: [String: CGKeyCode] = [
        "enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
        "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50
    ]

    static func trusted(prompt: Bool) -> Bool {
        // "AXTrustedCheckOptionPrompt" es el valor de kAXTrustedCheckOptionPrompt.
        AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": prompt] as CFDictionary)
    }

    static func perform(_ method: String, _ params: JSON) throws -> JSON {
        guard trusted(prompt: false) else {
            throw HelperFailure(
                code: "not_trusted",
                message: "Buddy needs the Accessibility permission to click and type (System Settings → Privacy & Security → Accessibility)."
            )
        }
        switch method {
        case "input.move":
            move(try point(params))
        case "input.click":
            click(try point(params), double: params["double"] as? Bool ?? false)
        case "input.type":
            type(params["text"] as? String ?? "")
        case "input.key":
            try key(params["key"] as? String ?? "", modifiers: params["modifiers"] as? [String] ?? [])
        case "input.scroll":
            scroll(up: (params["direction"] as? String) == "up", amount: params["amount"] as? Int ?? 5)
        default:
            throw HelperFailure(code: "unknown_method", message: "Unknown method: \(method)")
        }
        return ["ok": true]
    }

    static func point(_ params: JSON) throws -> CGPoint {
        guard let x = (params["x"] as? NSNumber)?.doubleValue, let y = (params["y"] as? NSNumber)?.doubleValue else {
            throw HelperFailure.invalid("Missing x or y")
        }
        return CGPoint(x: x, y: y)
    }

    static func move(_ point: CGPoint) {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    static func click(_ point: CGPoint, double: Bool) {
        move(point)
        usleep(20_000)
        for clickCount in 1...(double ? 2 : 1) {
            let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            down?.post(tap: .cghidEventTap)
            usleep(30_000)
            let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            up?.post(tap: .cghidEventTap)
            usleep(40_000)
        }
    }

    /// Escribe carácter a carácter con su texto Unicode (no depende de la distribución del teclado).
    static func type(_ text: String) {
        for character in text {
            if character == "\n" || character == "\r" {
                press(36, flags: [])
                continue
            }
            if character == "\t" {
                press(48, flags: [])
                continue
            }
            var units = Array(String(character).utf16)
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            down?.flags = []
            down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            down?.post(tap: .cghidEventTap)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            up?.flags = []
            up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            up?.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }

    static func key(_ name: String, modifiers: [String]) throws {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case "cmd": flags.insert(.maskCommand)
            case "ctrl": flags.insert(.maskControl)
            case "alt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: break
            }
        }
        if let code = keyCodes[name.lowercased()] {
            press(code, flags: flags)
        } else if name.count == 1, flags.isEmpty {
            type(name)
        } else {
            throw HelperFailure.invalid("Unknown key: \(name)")
        }
    }

    static func press(_ code: CGKeyCode, flags: CGEventFlags) {
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        down?.flags = flags
        down?.post(tap: .cghidEventTap)
        usleep(15_000)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        up?.flags = flags
        up?.post(tap: .cghidEventTap)
        usleep(15_000)
    }

    static func scroll(up: Bool, amount: Int) {
        let lines = Int32(max(1, min(amount, 30)))
        CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: up ? lines : -lines, wheel2: 0, wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    @MainActor static func frontmostOnMain() -> JSON {
        let app = NSWorkspace.shared.frontmostApplication
        return ["app": app?.localizedName ?? "", "bundleId": app?.bundleIdentifier ?? ""]
    }

    static func frontmost() async -> JSON {
        await frontmostOnMain()
    }
}
