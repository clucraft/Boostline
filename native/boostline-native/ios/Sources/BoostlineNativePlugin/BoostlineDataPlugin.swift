import Foundation
import Capacitor
import Compression
import CryptoKit
import SQLite3
import UIKit
import UniformTypeIdentifiers

/// BMW DME data import: downloads bmw-unified-db (bmw.sqlite.gz, ~130 MB), unpacks it to a
/// temporary SQLite file (~700 MB) and answers read-only queries from the shared import code
/// (src/core/bmwdata/importDb.ts). JS side: src/mobile/api.ts.
@objc(BoostlineDataPlugin)
public class BoostlineDataPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "BoostlineDataPlugin"
    public let jsName = "BoostlineData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openDownloaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openPicked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    /// Database work happens on this queue only.
    private let work = DispatchQueue(label: "app.boostline.data")
    private var db: OpaquePointer?
    private var tempFiles: [URL] = []
    private var downloader: Downloader?
    private var pickCall: CAPPluginCall?

    // MARK: - Methods

    @objc func openDownloaded(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url is required")
            return
        }
        let expected = call.getString("sha256")?.lowercased()
        let downloader = Downloader(url: url) { [weak self] received, total in
            self?.notifyListeners("progress", data: ["phase": "download", "received": Int(received), "total": Int(total)])
        } completion: { [weak self] result in
            guard let self = self else { return }
            self.downloader = nil
            switch result {
            case .failure(let error):
                call.reject("Download failed: \(error.localizedDescription)")
            case .success(let file):
                self.work.async {
                    do {
                        self.tempFiles.append(file)
                        if let expected = expected {
                            self.notifyListeners("progress", data: ["phase": "verify"])
                            guard try Self.sha256(of: file) == expected else {
                                throw ImportError.message("Checksum mismatch: the download is corrupt, try again")
                            }
                        }
                        self.notifyListeners("progress", data: ["phase": "unpack"])
                        try self.openDatabase(at: file)
                        call.resolve()
                    } catch {
                        self.cleanUp()
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
        self.downloader = downloader
        downloader.start()
    }

    @objc func openPicked(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view to present the file picker from")
                return
            }
            self.pickCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.data], asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenter.present(picker, animated: true)
        }
    }

    @objc func query(_ call: CAPPluginCall) {
        guard let sql = call.getString("sql") else {
            call.reject("sql is required")
            return
        }
        let params = call.getArray("params") ?? []
        work.async {
            do {
                let (columns, rows) = try self.run(sql: sql, params: params)
                call.resolve(["columns": columns, "rows": rows])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        work.async {
            self.cleanUp()
            call.resolve()
        }
    }

    // MARK: - Document picker

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall, let url = urls.first else { return }
        pickCall = nil
        work.async {
            do {
                self.tempFiles.append(url)
                self.notifyListeners("progress", data: ["phase": "unpack"])
                try self.openDatabase(at: url)
                call.resolve(["opened": true, "name": url.lastPathComponent])
            } catch {
                self.cleanUp()
                call.reject(error.localizedDescription)
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.resolve(["opened": false])
        pickCall = nil
    }

    // MARK: - Database

    enum ImportError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            switch self {
            case .message(let text): return text
            }
        }
    }

    /// Opens a .sqlite file, or unpacks a gzip file to a temporary .sqlite first. Runs on `work`.
    private func openDatabase(at file: URL) throws {
        cleanUpDatabase()
        var path = file
        if try Self.isGzip(file) {
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("boostline-bmwdb-\(UUID().uuidString).sqlite")
            tempFiles.append(out)
            try Self.gunzip(file, to: out)
            path = out
        }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path.path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let opened = handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(handle)
            throw ImportError.message("Not a SQLite database (\(message))")
        }
        db = opened
    }

    private func run(sql: String, params: [JSValue]) throws -> ([String], [[Any]]) {
        guard let db = db else { throw ImportError.message("No database is open") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let stmt = statement else {
            throw ImportError.message(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in params.enumerated() {
            let position = Int32(index + 1)
            if let text = value as? String {
                sqlite3_bind_text(stmt, position, text, -1, transient)
            } else if let number = value as? NSNumber {
                if CFNumberIsFloatType(number as CFNumber) {
                    sqlite3_bind_double(stmt, position, number.doubleValue)
                } else {
                    sqlite3_bind_int64(stmt, position, number.int64Value)
                }
            } else {
                sqlite3_bind_null(stmt, position)
            }
        }
        let count = sqlite3_column_count(stmt)
        let columns = (0..<count).map { column in sqlite3_column_name(stmt, column).map { String(cString: $0) } ?? "" }
        var rows: [[Any]] = []
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw ImportError.message(String(cString: sqlite3_errmsg(db))) }
            var row: [Any] = []
            row.reserveCapacity(Int(count))
            for column in 0..<count {
                switch sqlite3_column_type(stmt, column) {
                case SQLITE_INTEGER:
                    row.append(Int(sqlite3_column_int64(stmt, column)))
                case SQLITE_FLOAT:
                    row.append(sqlite3_column_double(stmt, column))
                case SQLITE_TEXT:
                    row.append(sqlite3_column_text(stmt, column).map { String(cString: $0) } ?? "")
                default:
                    row.append(NSNull())
                }
            }
            rows.append(row)
        }
        return (columns, rows)
    }

    private func cleanUpDatabase() {
        if let db = db { sqlite3_close(db) }
        db = nil
    }

    private func cleanUp() {
        cleanUpDatabase()
        for file in tempFiles { try? FileManager.default.removeItem(at: file) }
        tempFiles = []
    }

    // MARK: - Files

    private static func isGzip(_ file: URL) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let magic = handle.readData(ofLength: 2)
        return magic.count == 2 && magic[magic.startIndex] == 0x1f && magic[magic.startIndex + 1] == 0x8b
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = handle.readData(ofLength: 4 << 20)
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Unpacks a gzip file (one member) with Apple's raw DEFLATE decoder: the header is parsed
    /// here, only the compressed bytes are fed to the decoder (not the 8-byte trailer), and the
    /// result is checked against the size recorded in the trailer.
    private static func gunzip(_ source: URL, to destination: URL) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let fileSize = try Int(input.seekToEnd())
        guard fileSize > 18 else { throw ImportError.message("Not a gzip file") }
        try input.seek(toOffset: UInt64(fileSize - 4))
        let isizeBytes = [UInt8](input.readData(ofLength: 4))
        guard isizeBytes.count == 4 else { throw ImportError.message("Truncated gzip file") }
        let expectedSize = UInt32(isizeBytes[0]) | UInt32(isizeBytes[1]) << 8 | UInt32(isizeBytes[2]) << 16 | UInt32(isizeBytes[3]) << 24
        try input.seek(toOffset: 0)

        // Header (RFC 1952): magic, method 8 (deflate), flags, mtime, xfl, os, optional fields.
        let header = [UInt8](input.readData(ofLength: 10))
        guard header.count == 10, header[0] == 0x1f, header[1] == 0x8b, header[2] == 8 else {
            throw ImportError.message("Not a gzip file")
        }
        let flags = header[3]
        if flags & 0x04 != 0 {
            let lengthBytes = [UInt8](input.readData(ofLength: 2))
            guard lengthBytes.count == 2 else { throw ImportError.message("Truncated gzip header") }
            _ = input.readData(ofLength: Int(lengthBytes[0]) | Int(lengthBytes[1]) << 8)
        }
        for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 {
            while let byte = input.readData(ofLength: 1).first, byte != 0 {}
        }
        if flags & 0x02 != 0 { _ = input.readData(ofLength: 2) }
        let headerEnd = try Int(input.offset())
        var remaining = fileSize - 8 - headerEnd
        guard remaining > 0 else { throw ImportError.message("Truncated gzip file") }

        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        let bufferSize = 1 << 20
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destinationBuffer.deallocate() }
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw ImportError.message("Cannot start the decompressor")
        }
        defer { compression_stream_destroy(stream) }

        var totalOut: UInt64 = 0
        var ended = false
        while remaining > 0 && !ended {
            let chunk = input.readData(ofLength: min(bufferSize, remaining))
            guard !chunk.isEmpty else { throw ImportError.message("Truncated gzip file") }
            remaining -= chunk.count
            let processFlags: Int32 = remaining == 0 ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
            try chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) throws -> Void in
                guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
                stream.pointee.src_ptr = base
                stream.pointee.src_size = chunk.count
                while true {
                    let inputBefore = stream.pointee.src_size
                    stream.pointee.dst_ptr = destinationBuffer
                    stream.pointee.dst_size = bufferSize
                    let status = compression_stream_process(stream, processFlags)
                    let produced = bufferSize - stream.pointee.dst_size
                    if produced > 0 {
                        output.write(Data(bytes: destinationBuffer, count: produced))
                        totalOut += UInt64(produced)
                    }
                    if status == COMPRESSION_STATUS_END {
                        ended = true
                        return
                    }
                    guard status == COMPRESSION_STATUS_OK else {
                        throw ImportError.message("The download is not valid gzip data")
                    }
                    // Before the last chunk: move on once this chunk's input is used up and the output
                    // buffer wasn't filled. On the last chunk keep going: the decoder releases its final
                    // output only on further calls, until it reports the end.
                    if processFlags == 0 && stream.pointee.src_size == 0 && produced < bufferSize { return }
                    // No progress at all: stop rather than spin (the size check below decides).
                    if produced == 0 && stream.pointee.src_size == inputBefore { return }
                }
            }
        }
        guard UInt32(truncatingIfNeeded: totalOut) == expectedSize else {
            throw ImportError.message("The gzip data is incomplete (\(totalOut) bytes unpacked)")
        }
    }
}

/// URLSession download with progress, saved to a temporary file the caller owns.
private final class Downloader: NSObject, URLSessionDownloadDelegate {
    private let url: URL
    private let progress: (Int64, Int64) -> Void
    private let completion: (Result<URL, Error>) -> Void
    private var session: URLSession?
    private var lastReport: Int64 = 0
    private var done = false

    init(url: URL, progress: @escaping (Int64, Int64) -> Void, completion: @escaping (Result<URL, Error>) -> Void) {
        self.url = url
        self.progress = progress
        self.completion = completion
    }

    func start() {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.session = session
        session.downloadTask(with: url).resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesWritten - lastReport >= 1 << 20 || totalBytesWritten == totalBytesExpectedToWrite else { return }
        lastReport = totalBytesWritten
        progress(totalBytesWritten, max(totalBytesExpectedToWrite, 0))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The system deletes `location` when this method returns: move it first.
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("boostline-bmwdb-\(UUID().uuidString).sqlite.gz")
        do {
            if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw BoostlineDataPlugin.ImportError.message("HTTP \(http.statusCode)")
            }
            try FileManager.default.moveItem(at: location, to: file)
            finish(.success(file))
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error { finish(.failure(error)) }
    }

    private func finish(_ result: Result<URL, Error>) {
        guard !done else { return }
        done = true
        session?.finishTasksAndInvalidate()
        session = nil
        completion(result)
    }
}
