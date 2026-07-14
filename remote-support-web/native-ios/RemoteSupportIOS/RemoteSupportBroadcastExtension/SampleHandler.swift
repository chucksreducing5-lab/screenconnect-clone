import ReplayKit
import AVFoundation

final class SampleHandler: RPBroadcastSampleHandler {
    private let relay = IOSBroadcastRelay()

    override func broadcastStarted(withSetupInfo setupInfo: [String : NSObject]?) {
        relay.start()
        relay.sendStatus(status: "starting", platform: "ios", screenCapture: true)
    }

    override func broadcastPaused() {
        relay.sendStatus(status: "paused", platform: "ios", screenCapture: true)
    }

    override func broadcastResumed() {
        relay.sendStatus(status: "live", platform: "ios", screenCapture: true)
    }

    override func broadcastFinished() {
        relay.sendStatus(status: "stopped", platform: "ios", screenCapture: false)
        relay.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        relay.sendVideoSampleBuffer(sampleBuffer)
    }
}
