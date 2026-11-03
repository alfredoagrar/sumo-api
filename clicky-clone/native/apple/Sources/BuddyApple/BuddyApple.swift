// Punto de entrada y protocolo: una petición JSON por línea en stdin, una respuesta o evento JSON
// por línea en stdout (ver src/main/core/apple-protocol.ts). Los registros van a stderr.
import Foundation

let helperVersion = "1.0.0"

typealias JSON = [String: Any]

struct HelperFailure: Error {
    let code: String
    let message: String

    static func invalid(_ message: String) -> HelperFailure {
        HelperFailure(code: "invalid_params", message: message)
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("buddy-apple: \(message)\n".utf8))
}

func elapsedMs(_ since: Date) -> Int {
    Int(Date().timeIntervalSince(since) * 1000)
}

/// Escribe en stdout de una en una línea (varias tareas responden a la vez).
final class Output: @unchecked Sendable {
    static let shared = Output()
    private let lock = NSLock()

    func send(_ object: JSON) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [])
        else {
            log("could not encode a message")
            return
        }
        data.append(0x0A)
        lock.lock()
        FileHandle.standardOutput.write(data)
        lock.unlock()
    }

    func result(_ id: Int, _ result: JSON) {
        send(["id": id, "result": result])
    }

    func error(_ id: Int, _ code: String, _ message: String) {
        send(["id": id, "error": ["code": code, "message": message]])
    }

    func event(_ name: String, _ params: JSON) {
        send(["event": name, "params": params])
    }
}

/// Tareas en curso, para poder cancelarlas cuando Buddy ya no espera la respuesta.
final class TaskRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [Int: Task<Void, Never>] = [:]

    func add(_ id: Int, _ task: Task<Void, Never>) {
        lock.lock()
        tasks[id] = task
        lock.unlock()
    }

    func remove(_ id: Int) {
        lock.lock()
        tasks[id] = nil
        lock.unlock()
    }

    func cancel(_ id: Int) {
        lock.lock()
        let task = tasks.removeValue(forKey: id)
        lock.unlock()
        task?.cancel()
    }
}

enum RPC {
    static let tasks = TaskRegistry()

    static func readLoop() {
        while let line = readLine(strippingNewline: true) {
            if !line.isEmpty { handle(line) }
        }
        // Buddy cerró stdin: terminamos.
        Dictation.shared.cancelAll()
        exit(0)
    }

    static func handle(_ line: String) {
        guard let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? JSON,
              let method = message["method"] as? String
        else { return }
        let params = message["params"] as? JSON ?? [:]
        let id = message["id"] as? Int

        // Estos mensajes se atienden en orden y en este mismo hilo (el audio no puede desordenarse).
        switch method {
        case "stt.audio":
            Dictation.shared.append(params)
            return
        case "cancel":
            if let target = params["id"] as? Int { tasks.cancel(target) }
            return
        default:
            break
        }
        guard let id else { return }

        let task = Task {
            do {
                let result = try await dispatch(method, params)
                if !Task.isCancelled { Output.shared.result(id, result) }
            } catch let failure as HelperFailure {
                Output.shared.error(id, failure.code, failure.message)
            } catch is CancellationError {
                // Buddy ya no espera esta respuesta.
            } catch {
                Output.shared.error(id, "internal", error.localizedDescription)
            }
            tasks.remove(id)
        }
        tasks.add(id, task)
    }

    static func dispatch(_ method: String, _ params: JSON) async throws -> JSON {
        switch method {
        case "hello", "status":
            return status()
        case "generate":
            return try await Intelligence.generate(params)
        case "prewarm":
            Intelligence.prewarm(params)
            return [:]
        case "ocr":
            return try await OCR.recognize(params)
        case "stt.begin":
            return try await Dictation.shared.begin(params)
        case "stt.end":
            return try await Dictation.shared.end(params)
        case "stt.cancel":
            await Dictation.shared.cancel(params)
            return [:]
        case "accessibility":
            return ["trusted": Input.trusted(prompt: params["prompt"] as? Bool ?? false)]
        case "frontmost":
            return await Input.frontmost()
        case "input.move", "input.click", "input.type", "input.key", "input.scroll":
            return try Input.perform(method, params)
        default:
            throw HelperFailure(code: "unknown_method", message: "Unknown method: \(method)")
        }
    }

    static func status() -> JSON {
        #if BUDDY_SDK_27
        let sdk27 = true
        #else
        let sdk27 = false
        #endif
        return [
            "version": helperVersion,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "sdk27": sdk27,
            "intelligence": Intelligence.status(),
            "speech": Dictation.status(),
            "ocr": true,
            "accessibility": Input.trusted(prompt: false)
        ]
    }
}

@main
struct BuddyAppleMain {
    static func main() {
        // Si Buddy se cierra mientras escribimos, que no nos mate SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        let reader = Thread { RPC.readLoop() }
        reader.start()
        // El hilo principal atiende la cola principal (AppKit) y Swift Concurrency.
        dispatchMain()
    }
}
