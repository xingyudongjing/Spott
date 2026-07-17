import Foundation

protocol AuthoritativeTimeProviding: Sendable {
    func authoritativeNow() -> Date
}

extension AuthoritativeTimeProviding {
    func authoritativeNow() -> Date { .now }
}

final class ServerTimeAuthority: @unchecked Sendable {
    private struct Calibration {
        let serverTime: Date
        let monotonicTime: TimeInterval
    }

    private let lock = NSLock()
    private let wallClock: @Sendable () -> Date
    private let monotonicClock: @Sendable () -> TimeInterval
    private var calibration: Calibration?

    init(
        wallClock: @escaping @Sendable () -> Date = { .now },
        monotonicClock: @escaping @Sendable () -> TimeInterval = {
            ProcessInfo.processInfo.systemUptime
        }
    ) {
        self.wallClock = wallClock
        self.monotonicClock = monotonicClock
    }

    func now() -> Date {
        let monotonicNow = monotonicClock()
        return lock.withLock {
            guard let calibration else { return wallClock() }
            return calibration.serverTime.addingTimeInterval(
                max(0, monotonicNow - calibration.monotonicTime)
            )
        }
    }

    @discardableResult
    func calibrate(serverTime: Date) -> Bool {
        let monotonicNow = monotonicClock()
        return lock.withLock {
            if let calibration {
                let projected = calibration.serverTime.addingTimeInterval(
                    max(0, monotonicNow - calibration.monotonicTime)
                )
                guard serverTime >= projected.addingTimeInterval(-2) else {
                    return false
                }
            }
            calibration = .init(
                serverTime: serverTime,
                monotonicTime: monotonicNow
            )
            return true
        }
    }

    @discardableResult
    func calibrate(httpDate: String?) -> Bool {
        guard let httpDate,
              let serverTime = Self.httpDateParser.parse(httpDate) else {
            return false
        }
        return calibrate(serverTime: serverTime)
    }

    private static let httpDateParser = HTTPDateParser()
}

/// HTTP dates are English, Gregorian and GMT regardless of the device's
/// language, calendar or time zone. `DateFormatter` is mutable and is not safe
/// to share without synchronization, so all access to the cached formatters is
/// serialized here.
private final class HTTPDateParser: @unchecked Sendable {
    private let lock = NSLock()
    private let formatters: [DateFormatter] = [
        "EEE, dd MMM yyyy HH:mm:ss 'GMT'",      // IMF-fixdate / RFC 1123
        "EEEE, dd-MMM-yy HH:mm:ss 'GMT'",      // obsolete RFC 850
        "EEE MMM d HH:mm:ss yyyy",             // obsolete ANSI C asctime
    ].map { format in
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
    }

    func parse(_ rawValue: String) -> Date? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }

        return lock.withLock {
            for formatter in formatters {
                if let date = formatter.date(from: value) {
                    return date
                }
            }
            return nil
        }
    }
}
