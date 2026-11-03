// Apple Intelligence: el modelo de Apple que corre en el equipo (Foundation Models).
// Buddy lo usa para corregir el dictado, decidir quién atiende cada petición y responder lo
// sencillo. Con el SDK de macOS 27 también puede ver la captura de pantalla.
import CoreGraphics
import Foundation
import FoundationModels

enum Intelligence {
    /// Sesión precalentada para que la primera petición no espere a que cargue el modelo.
    nonisolated(unsafe) static var warmSession: LanguageModelSession?

    static var imageInput: Bool {
        #if BUDDY_SDK_27
        if #available(macOS 27.0, *) { return true }
        #endif
        return false
    }

    static func status() -> JSON {
        switch SystemLanguageModel.default.availability {
        case .available:
            return ["available": true, "imageInput": imageInput]
        case .unavailable(let reason):
            return ["available": false, "reason": describe(reason), "imageInput": false]
        }
    }

    static func describe(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
        switch reason {
        case .deviceNotEligible: return "deviceNotEligible"
        case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
        case .modelNotReady: return "modelNotReady"
        @unknown default: return "unavailable"
        }
    }

    static func prewarm(_ params: JSON) {
        guard SystemLanguageModel.default.isAvailable else { return }
        let session = LanguageModelSession(model: SystemLanguageModel.default, tools: [], instructions: params["instructions"] as? String)
        session.prewarm(promptPrefix: nil)
        warmSession = session
    }

    static func generate(_ params: JSON) async throws -> JSON {
        guard let prompt = params["prompt"] as? String, !prompt.isEmpty else {
            throw HelperFailure.invalid("Missing prompt")
        }
        // El esquema se valida antes de mirar la disponibilidad, así un esquema mal formado falla
        // igual en cualquier Mac (también en la integración continua, sin Apple Intelligence).
        let schema = try (params["schema"] as? JSON).map(SchemaBuilder.generationSchema)
        guard SystemLanguageModel.default.isAvailable else {
            throw HelperFailure(code: "unavailable", message: "Apple Intelligence is not available on this Mac.")
        }
        let instructions = params["instructions"] as? String ?? ""
        let sampling: GenerationOptions.SamplingMode? = (params["greedy"] as? Bool ?? true) ? .greedy : nil
        #if BUDDY_SDK_27
        let options = GenerationOptions(samplingMode: sampling, temperature: nil, maximumResponseTokens: params["maxTokens"] as? Int)
        #else
        let options = GenerationOptions(sampling: sampling, temperature: nil, maximumResponseTokens: params["maxTokens"] as? Int)
        #endif
        // Una sesión nueva por petición: el contexto del modelo es pequeño y no queremos historial.
        let session = LanguageModelSession(model: SystemLanguageModel.default, tools: [], instructions: instructions)
        let started = Date()
        do {
            if let schema {
                #if BUDDY_SDK_27
                if #available(macOS 27.0, *), let path = params["imagePath"] as? String, let image = loadCGImage(path) {
                    let response = try await session.respond(schema: schema, includeSchemaInPrompt: true, options: options) {
                        prompt
                        Attachment(image)
                    }
                    return ["json": response.content.jsonString, "ms": elapsedMs(started), "usedImage": true]
                }
                #endif
                let response = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
                return ["json": response.content.jsonString, "ms": elapsedMs(started), "usedImage": false]
            }
            let response = try await session.respond(to: prompt, options: options)
            return ["text": response.content, "ms": elapsedMs(started), "usedImage": false]
        } catch let error as LanguageModelSession.GenerationError {
            throw HelperFailure(code: "generation", message: error.localizedDescription)
        }
    }
}

/// Convierte el esquema de Buddy (ver AppleSchema en apple-protocol.ts) en un esquema de
/// generación guiada. Los campos se generan en el orden en que vienen.
enum SchemaBuilder {
    static func generationSchema(_ json: JSON) throws -> GenerationSchema {
        let name = json["name"] as? String ?? "Output"
        let root = try object(name: name, description: json["description"] as? String, fields: json["properties"] as? [JSON] ?? [])
        do {
            return try GenerationSchema(root: root, dependencies: [])
        } catch {
            throw HelperFailure.invalid("Invalid schema: \(error.localizedDescription)")
        }
    }

    static func object(name: String, description: String?, fields: [JSON]) throws -> DynamicGenerationSchema {
        let properties = try fields.map { field -> DynamicGenerationSchema.Property in
            guard let fieldName = field["name"] as? String else {
                throw HelperFailure.invalid("Schema field without a name")
            }
            return DynamicGenerationSchema.Property(
                name: fieldName,
                description: field["description"] as? String,
                schema: try schema(field, path: "\(name)_\(fieldName)"),
                isOptional: field["optional"] as? Bool ?? false
            )
        }
        return DynamicGenerationSchema(name: name, description: description, properties: properties)
    }

    static func schema(_ field: JSON, path: String) throws -> DynamicGenerationSchema {
        switch field["type"] as? String ?? "string" {
        case "string":
            if let choices = field["enum"] as? [String], !choices.isEmpty {
                return DynamicGenerationSchema(type: String.self, guides: [.anyOf(choices)])
            }
            return DynamicGenerationSchema(type: String.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        case "array":
            let items = field["items"] as? JSON ?? ["type": "string"]
            return DynamicGenerationSchema(
                arrayOf: try schema(items, path: "\(path)_item"),
                minimumElements: field["minItems"] as? Int,
                maximumElements: field["maxItems"] as? Int
            )
        case "object":
            return try object(name: path, description: field["description"] as? String, fields: field["properties"] as? [JSON] ?? [])
        case let other:
            throw HelperFailure.invalid("Unsupported schema type: \(other)")
        }
    }
}
