// OCR de la captura con Vision, en el equipo. Da a Apple Intelligence el texto visible y a Buddy
// las coordenadas para señalar ese texto.
import CoreGraphics
import Foundation
import ImageIO
import Vision

func loadCGImage(_ path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

enum OCR {
    struct Line {
        let text: String
        /// Normalizado, con el origen abajo a la izquierda (como lo da Vision).
        let box: CGRect
        let confidence: Float
    }

    static func recognize(_ params: JSON) async throws -> JSON {
        guard let path = params["imagePath"] as? String, let image = loadCGImage(path) else {
            throw HelperFailure.invalid("Could not read the image")
        }
        let started = Date()
        let fast = params["fast"] as? Bool ?? false
        let correction = params["languageCorrection"] as? Bool ?? false
        let languages = params["languages"] as? [String] ?? []

        // Probamos la API moderna de Vision y, si falla (pasa en algunas máquinas virtuales), la clásica;
        // primero con el nivel pedido y después con el rápido.
        let attempts: [(String, Bool)] = fast ? [("modern", true), ("classic", true)] : [("modern", false), ("classic", false), ("modern", true), ("classic", true)]
        var failures: [String] = []
        for (engine, quick) in attempts {
            do {
                let lines = engine == "modern"
                    ? try await modern(image, fast: quick, correction: correction, languages: languages)
                    : try classic(image, fast: quick, correction: correction, languages: languages)
                return result(lines, image: image, engine: "\(engine)-\(quick ? "fast" : "accurate")", started: started)
            } catch {
                failures.append("\(engine)-\(quick ? "fast" : "accurate"): \(error.localizedDescription)")
            }
        }
        throw HelperFailure(code: "internal", message: "OCR failed (\(failures.joined(separator: "; ")))")
    }

    static func modern(_ image: CGImage, fast: Bool, correction: Bool, languages: [String]) async throws -> [Line] {
        var request = RecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = correction
        if !languages.isEmpty { request.recognitionLanguages = languages.map { Locale.Language(identifier: $0) } }
        let observations = try await request.perform(on: image, orientation: nil)
        return observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return Line(text: candidate.string, box: observation.boundingBox.cgRect, confidence: candidate.confidence)
        }
    }

    static func classic(_ image: CGImage, fast: Bool, correction: Bool, languages: [String]) throws -> [Line] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = correction
        if !languages.isEmpty { request.recognitionLanguages = languages }
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            return Line(text: candidate.string, box: observation.boundingBox, confidence: candidate.confidence)
        }
    }

    static func result(_ lines: [Line], image: CGImage, engine: String, started: Date) -> JSON {
        let width = Double(image.width)
        let height = Double(image.height)
        let json: [JSON] = lines.map { line in
            [
                "text": line.text,
                "x": Double(line.box.minX) * width,
                "y": (1 - Double(line.box.maxY)) * height,
                "w": Double(line.box.width) * width,
                "h": Double(line.box.height) * height,
                "confidence": Double(line.confidence)
            ]
        }
        return ["lines": json, "width": width, "height": height, "ms": elapsedMs(started), "engine": engine]
    }
}
