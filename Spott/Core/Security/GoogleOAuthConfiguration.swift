import Foundation

struct GoogleOAuthConfiguration: Equatable, Sendable {
    enum ConfigurationError: Error, Equatable, Sendable {
        case missing(String)
        case invalid(String)
        case callbackSchemeMismatch
    }

    let clientID: String
    let serverClientID: String
    let reversedClientID: String

    init(values: [String: Any]) throws {
        clientID = try Self.value(named: "GIDClientID", in: values)
        serverClientID = try Self.value(named: "GIDServerClientID", in: values)
        reversedClientID = try Self.value(named: "GIDReversedClientID", in: values)

        guard Self.isGoogleClientID(clientID) else {
            throw ConfigurationError.invalid("GIDClientID")
        }
        guard Self.isGoogleClientID(serverClientID) else {
            throw ConfigurationError.invalid("GIDServerClientID")
        }
        guard reversedClientID == clientID.split(separator: ".").reversed().joined(separator: ".") else {
            throw ConfigurationError.callbackSchemeMismatch
        }
    }

    init(bundle: Bundle = .main) throws {
        try self.init(values: bundle.infoDictionary ?? [:])
    }

    private static func value(named key: String, in values: [String: Any]) throws -> String {
        guard let raw = values[key] as? String else {
            throw ConfigurationError.missing(key)
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !value.isEmpty,
            !value.contains("SET_GOOGLE"),
            !value.contains("SET-GOOGLE"),
            !value.contains("$(")
        else {
            throw ConfigurationError.invalid(key)
        }
        return value
    }

    private static func isGoogleClientID(_ value: String) -> Bool {
        value.hasSuffix(".apps.googleusercontent.com") && value.count > ".apps.googleusercontent.com".count
    }
}
