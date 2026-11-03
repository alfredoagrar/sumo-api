// Dictado de Apple (SpeechAnalyzer, en el equipo). Buddy manda el audio del micrófono mientras
// hablas y el ayudante devuelve el texto parcial al momento y el final al terminar.
import AVFoundation
import Foundation
import Speech

/// Una grabación en curso.
final class DictationSession: @unchecked Sendable {
    let sid: String
    let analyzer: SpeechAnalyzer
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let inputFormat: AVAudioFormat
    let analyzerFormat: AVAudioFormat
    var resultsTask: Task<Void, Never>?

    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var finalized = ""
    private var volatile = ""

    init(sid: String, analyzer: SpeechAnalyzer, continuation: AsyncStream<AnalyzerInput>.Continuation, inputFormat: AVAudioFormat, analyzerFormat: AVAudioFormat) {
        self.sid = sid
        self.analyzer = analyzer
        self.continuation = continuation
        self.inputFormat = inputFormat
        self.analyzerFormat = analyzerFormat
    }

    func transcript() -> String {
        lock.lock()
        defer { lock.unlock() }
        return (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func update(text: String, isFinal: Bool) {
        lock.lock()
        if isFinal {
            finalized += text
            volatile = ""
        } else {
            volatile = text
        }
        let current = (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        lock.unlock()
        Output.shared.event("stt.partial", ["sid": sid, "text": current])
    }

    /// Audio mono Float32 a la frecuencia del micrófono de Buddy.
    func append(samples: [Float]) {
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData
        else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { channel[0].update(from: base, count: samples.count) }
        }
        guard let converted = convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    /// Convierte al formato que pide el analizador (como el BufferConverter de los ejemplos de Apple).
    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if inputFormat == analyzerFormat { return buffer }
        if converter == nil {
            converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)
            // Sin "priming": perdemos calidad en las primeras muestras pero no se desplazan los tiempos.
            converter?.primeMethod = .none
        }
        guard let converter else { return nil }
        let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            log("audio conversion failed: \(error?.localizedDescription ?? "unknown")")
            return nil
        }
        return output
    }
}

final class Dictation: @unchecked Sendable {
    static let shared = Dictation()

    private let lock = NSLock()
    private var sessions: [String: DictationSession] = [:]

    static func status() -> JSON {
        ["available": true, "detail": SpeechTranscriber.isAvailable ? "SpeechTranscriber" : "DictationTranscriber"]
    }

    func begin(_ params: JSON) async throws -> JSON {
        guard let sid = params["sid"] as? String else { throw HelperFailure.invalid("Missing sid") }
        let requested = Locale(identifier: params["locale"] as? String ?? "es-MX")
        let sampleRate = (params["sampleRate"] as? NSNumber)?.doubleValue ?? 48_000
        let vocabulary = Array((params["contextualStrings"] as? [String] ?? []).prefix(100))

        // SpeechTranscriber (el modelo nuevo) si el equipo lo admite; si no, el dictado clásico.
        let module: any SpeechModule
        let moduleName: String
        let locale: Locale
        if SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: requested) {
            module = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
            moduleName = "speech"
            locale = supported
        } else if let supported = await DictationTranscriber.supportedLocale(equivalentTo: requested) {
            module = DictationTranscriber(
                locale: supported,
                contentHints: [.shortForm],
                transcriptionOptions: [.punctuation],
                reportingOptions: [.volatileResults],
                attributeOptions: []
            )
            moduleName = "dictation"
            locale = supported
        } else {
            throw HelperFailure(code: "unsupported_locale", message: "Apple dictation does not support \(requested.identifier).")
        }

        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                Output.shared.event("stt.assets", ["sid": sid, "state": "downloading"])
                try await request.downloadAndInstall()
            }
        } catch {
            throw HelperFailure(code: "assets", message: "Could not download the dictation model: \(error.localizedDescription)")
        }

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]),
              let inputFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        else {
            throw HelperFailure(code: "internal", message: "No compatible audio format for dictation.")
        }

        let analyzer = SpeechAnalyzer(modules: [module])
        if !vocabulary.isEmpty {
            // Nombres de rutinas y de la app: ayudan sobre todo al dictado clásico.
            let context = AnalysisContext()
            context.contextualStrings = [.general: vocabulary]
            do {
                try await analyzer.setContext(context)
            } catch {
                log("could not set the dictation context: \(error.localizedDescription)")
            }
        }

        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let session = DictationSession(sid: sid, analyzer: analyzer, continuation: continuation, inputFormat: inputFormat, analyzerFormat: analyzerFormat)
        session.resultsTask = Task {
            do {
                if let transcriber = module as? SpeechTranscriber {
                    for try await result in transcriber.results {
                        session.update(text: String(result.text.characters), isFinal: result.isFinal)
                    }
                } else if let transcriber = module as? DictationTranscriber {
                    for try await result in transcriber.results {
                        session.update(text: String(result.text.characters), isFinal: result.isFinal)
                    }
                }
            } catch {
                log("dictation results failed: \(error.localizedDescription)")
            }
        }
        try await analyzer.start(inputSequence: stream)

        store(session)
        return ["locale": locale.identifier(.bcp47), "module": moduleName]
    }

    /// Se llama en el hilo que lee stdin, en orden.
    func append(_ params: JSON) {
        guard let sid = params["sid"] as? String, let data = params["data"] as? String else { return }
        lock.lock()
        let session = sessions[sid]
        lock.unlock()
        session?.append(samples: decodeFloats(data))
    }

    func end(_ params: JSON) async throws -> JSON {
        guard let sid = params["sid"] as? String else { throw HelperFailure.invalid("Missing sid") }
        guard let session = take(sid) else { return ["text": ""] }
        session.continuation.finish()
        do {
            try await session.analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            log("could not finalize dictation: \(error.localizedDescription)")
        }
        // Esperamos los últimos resultados como mucho 2 s.
        if let task = session.resultsTask {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await task.value }
                group.addTask { try? await Task.sleep(nanoseconds: 2_000_000_000) }
                _ = await group.next()
                group.cancelAll()
            }
            task.cancel()
        }
        return ["text": session.transcript()]
    }

    func cancel(_ params: JSON) async {
        guard let sid = params["sid"] as? String, let session = take(sid) else { return }
        session.continuation.finish()
        await session.analyzer.cancelAndFinishNow()
        session.resultsTask?.cancel()
    }

    func cancelAll() {
        lock.lock()
        let all = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()
        for session in all { session.continuation.finish() }
    }

    // NSLock no puede usarse directamente dentro de funciones async: lo envolvemos en funciones síncronas.
    private func store(_ session: DictationSession) {
        lock.lock()
        sessions[session.sid] = session
        lock.unlock()
    }

    private func take(_ sid: String) -> DictationSession? {
        lock.lock()
        defer { lock.unlock() }
        return sessions.removeValue(forKey: sid)
    }
}

/// Audio Float32 little-endian en base64 → muestras.
func decodeFloats(_ base64: String) -> [Float] {
    guard let data = Data(base64Encoded: base64) else { return [] }
    var samples = [Float](repeating: 0, count: data.count / MemoryLayout<Float>.size)
    _ = samples.withUnsafeMutableBytes { data.copyBytes(to: $0) }
    return samples
}
