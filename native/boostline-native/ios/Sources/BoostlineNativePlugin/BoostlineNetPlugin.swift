import Foundation
import Capacitor
import Network

/// TCP sockets for the vehicle connection (HSFZ to the ENET gateway or a WiFi adapter).
/// JS side: src/mobile/runtime.ts. Data crosses the bridge base64-encoded.
@objc(BoostlineNetPlugin)
public class BoostlineNetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BoostlineNetPlugin"
    public let jsName = "BoostlineNet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "tcpConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "interfaces", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchOptions", returnType: CAPPluginReturnPromise)
    ]

    /// All connection state is touched on this queue only.
    private let queue = DispatchQueue(label: "app.boostline.net")
    private var connections: [String: NWConnection] = [:]

    @objc func tcpConnect(_ call: CAPPluginCall) {
        guard let host = call.getString("host"),
              let port = call.getInt("port"),
              let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
            call.reject("host and port are required")
            return
        }
        let timeoutMs = max(500, call.getInt("timeoutMs") ?? 5000)

        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 5
        tcp.connectionTimeout = max(1, timeoutMs / 1000)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: NWParameters(tls: nil, tcp: tcp))
        let id = UUID().uuidString
        var settled = false

        let timeout = DispatchWorkItem {
            guard !settled else { return }
            settled = true
            connection.cancel()
            call.reject("No TCP connection to \(host):\(port) within \(timeoutMs) ms", "ETIMEDOUT")
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)

        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                guard !settled else { return }
                settled = true
                timeout.cancel()
                self.connections[id] = connection
                call.resolve(["id": id])
                self.receive(id: id, connection: connection)
            case .waiting(let error):
                // Refused / unreachable: NWConnection would keep retrying; report it like a failed connect.
                guard !settled else { return }
                settled = true
                timeout.cancel()
                connection.cancel()
                call.reject(self.describe(error, host: host, port: port), self.code(error))
            case .failed(let error):
                if !settled {
                    settled = true
                    timeout.cancel()
                    call.reject(self.describe(error, host: host, port: port), self.code(error))
                } else {
                    self.closed(id: id, error: error)
                }
            case .cancelled:
                if settled { self.closed(id: id, error: nil) }
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    @objc func tcpWrite(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("id and base64 data are required")
            return
        }
        queue.async {
            guard let connection = self.connections[id] else {
                call.reject("Socket is closed", "EPIPE")
                return
            }
            connection.send(content: data, completion: .contentProcessed { error in
                if let error = error {
                    call.reject(error.localizedDescription, self.code(error))
                } else {
                    call.resolve()
                }
            })
        }
    }

    @objc func tcpClose(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        queue.async {
            if let connection = self.connections.removeValue(forKey: id) {
                connection.cancel()
            }
            call.resolve()
        }
    }

    /// IPv4 addresses of the device's interfaces (WiFi en0, USB Ethernet, loopback…).
    @objc func interfaces(_ call: CAPPluginCall) {
        var list: [[String: Any]] = []
        var head: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&head) == 0 {
            var cursor = head
            while let entry = cursor {
                let ifa = entry.pointee
                if let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET), let mask = ifa.ifa_netmask {
                    list.append([
                        "name": String(cString: ifa.ifa_name),
                        "address": BoostlineNetPlugin.ipv4(addr),
                        "netmask": BoostlineNetPlugin.ipv4(mask),
                        "internal": (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) != 0
                    ])
                }
                cursor = ifa.ifa_next
            }
            freeifaddrs(head)
        }
        call.resolve(["interfaces": list])
    }

    /// Test hook for CI (src/mobile/smoke.ts): environment variables passed at launch, e.g.
    /// SIMCTL_CHILD_BOOSTLINE_AUTOCONNECT=... xcrun simctl launch ... Empty in normal use.
    @objc func launchOptions(_ call: CAPPluginCall) {
        let env = ProcessInfo.processInfo.environment
        var result: [String: Any] = [:]
        if let value = env["BOOSTLINE_AUTOCONNECT"] { result["autoconnect"] = value }
        if let value = env["BOOSTLINE_CAPTURE_SECONDS"] { result["captureSeconds"] = value }
        if let value = env["BOOSTLINE_IMPORT_BMW"] { result["importBmw"] = value }
        call.resolve(result)
    }

    // MARK: - Internals

    private func receive(id: String, connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                self.notifyListeners("tcpData", data: ["id": id, "data": data.base64EncodedString()])
            }
            if let error = error {
                self.closed(id: id, error: error)
                connection.cancel()
            } else if isComplete {
                self.closed(id: id, error: nil)
                connection.cancel()
            } else {
                self.receive(id: id, connection: connection)
            }
        }
    }

    /// Reports a connection that ended on its own (not through tcpClose). Runs on `queue`.
    private func closed(id: String, error: NWError?) {
        guard connections.removeValue(forKey: id) != nil else { return }
        var payload: [String: Any] = ["id": id]
        if let error = error {
            payload["error"] = error.localizedDescription
            if let code = code(error) { payload["code"] = code }
        }
        notifyListeners("tcpClose", data: payload)
    }

    private func describe(_ error: NWError, host: String, port: Int) -> String {
        "Cannot connect to \(host):\(port): \(error.localizedDescription)"
    }

    /// Node-style error codes, as the shared connection code expects (ECONNREFUSED, ...).
    private func code(_ error: NWError) -> String? {
        switch error {
        case .posix(let posix):
            switch posix {
            case .ECONNREFUSED: return "ECONNREFUSED"
            case .EHOSTUNREACH: return "EHOSTUNREACH"
            case .ENETUNREACH: return "ENETUNREACH"
            case .ENETDOWN: return "ENETDOWN"
            case .ETIMEDOUT: return "ETIMEDOUT"
            case .ECONNRESET: return "ECONNRESET"
            case .EPIPE: return "EPIPE"
            case .EHOSTDOWN: return "EHOSTDOWN"
            default: return "E\(posix.rawValue)"
            }
        case .dns:
            return "ENOTFOUND"
        default:
            return nil
        }
    }

    private static func ipv4(_ sa: UnsafeMutablePointer<sockaddr>) -> String {
        sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin -> String in
            var addr = sin.pointee.sin_addr
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            inet_ntop(AF_INET, &addr, &buffer, socklen_t(INET_ADDRSTRLEN))
            return String(cString: buffer)
        }
    }
}
