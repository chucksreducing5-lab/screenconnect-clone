import Foundation
import AVFoundation
import UIKit
import CoreImage

final class IOSBroadcastRelay: NSObject {
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var sequence: Int = 0
    private var heartbeatTimer: Timer?

    func start() {
        let config = loadConfig()
        guard let wsUrl = buildWsUrl(config: config) else { return }

        let urlSession = URLSession(configuration: .default)
        self.session = urlSession
        let task = urlSession.webSocketTask(with: wsUrl)
        self.webSocketTask = task
        task.resume()
        startReceiveLoop()
        startHeartbeat()
    }

    func stop() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
    }

    func sendStatus(status: String, platform: String, screenCapture: Bool) {
        let obj: [String: Any] = [
            "type": "screen.broadcast.status",
            "payload": [
                "status": status,
                "platform": platform,
                "screenCapture": screenCapture
            ]
        ]
        send(json: obj)
    }

    func sendVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        let context = CIContext(options: nil)
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }

        let uiImage = UIImage(cgImage: cgImage)
        guard let jpegData = uiImage.jpegData(compressionQuality: 0.8) else { return }

        let width = Int(ciImage.extent.width)
        let height = Int(ciImage.extent.height)
        let b64 = jpegData.base64EncodedString()

        let obj: [String: Any] = [
            "type": "screen.frame",
            "payload": [
                "sequence": sequence,
                "width": width,
                "height": height,
                "format": "jpeg",
                "data": b64
            ]
        ]
        sequence += 1
        send(json: obj)
    }

    func sendHeartbeat() {
        let obj: [String: Any] = [
            "type": "screen.heartbeat",
            "payload": [
                "platform": "ios",
                "status": sequence > 0 ? "live" : "waiting_first_frame"
            ]
        ]
        send(json: obj)
    }

    private func send(json: [String: Any]) {
        guard let task = webSocketTask,
              let data = try? JSONSerialization.data(withJSONObject: json),
              let text = String(data: data, encoding: .utf8) else { return }

        task.send(.string(text)) { _ in }
    }

    private func loadConfig() -> (serverUrl: String, sessionId: String, token: String)? {
        let defaults = UserDefaults(suiteName: "group.top.helpsupport.remotesupport")
        let serverUrl = defaults?.string(forKey: "serverUrl") ?? ""
        let sessionId = defaults?.string(forKey: "sessionId") ?? ""
        let token = defaults?.string(forKey: "token") ?? ""
        guard !serverUrl.isEmpty, !sessionId.isEmpty, !token.isEmpty else { return nil }
        return (serverUrl, sessionId, token)
    }

    private func buildWsUrl(config: (serverUrl: String, sessionId: String, token: String)?) -> URL? {
        guard let config else { return nil }
        var base = config.serverUrl
        if base.hasPrefix("https://") {
            base = "wss://" + base.replacingOccurrences(of: "https://", with: "")
        } else if base.hasPrefix("http://") {
            base = "ws://" + base.replacingOccurrences(of: "http://", with: "")
        } else if !base.hasPrefix("ws://") && !base.hasPrefix("wss://") {
            base = "wss://" + base
        }
        base = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard
            let encodedSessionId = config.sessionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
            let encodedToken = config.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }

        let full = "\(base)/?role=customer&client=ios-mobile-broadcast&sessionId=\(encodedSessionId)&token=\(encodedToken)"
        return URL(string: full)
    }

    private func startReceiveLoop() {
        webSocketTask?.receive { [weak self] _ in
            guard let self else { return }
            self.startReceiveLoop()
        }
    }

    private func startHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.sendHeartbeat()
        }
    }
}
