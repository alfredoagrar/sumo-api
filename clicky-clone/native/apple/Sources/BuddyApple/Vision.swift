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
    static func recognize(_ params: JSON) throws -> JSON {
        guard let path = params["imagePath"] as? String, let image = loadCGImage(path) else {
            throw HelperFailure.invalid("Could not read the image")
        }
        let started = Date()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = (params["fast"] as? Bool ?? false) ? .fast : .accurate
        request.usesLanguageCorrection = params["languageCorrection"] as? Bool ?? false
        if let languages = params["languages"] as? [String], !languages.isEmpty {
            request.recognitionLanguages = languages
        }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw HelperFailure(code: "internal", message: "OCR failed: \(error.localizedDescription)")
        }
        let width = Double(image.width)
        let height = Double(image.height)
        var lines: [JSON] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            // Vision usa coordenadas normalizadas con el origen abajo a la izquierda.
            let box = observation.boundingBox
            lines.append([
                "text": candidate.string,
                "x": Double(box.minX) * width,
                "y": (1 - Double(box.maxY)) * height,
                "w": Double(box.width) * width,
                "h": Double(box.height) * height,
                "confidence": Double(candidate.confidence)
            ])
        }
        return ["lines": lines, "width": width, "height": height, "ms": elapsedMs(started)]
    }
}
