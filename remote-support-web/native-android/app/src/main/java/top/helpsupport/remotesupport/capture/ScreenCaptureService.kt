package top.helpsupport.remotesupport.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import top.helpsupport.remotesupport.MainActivity
import top.helpsupport.remotesupport.R
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

class ScreenCaptureService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var socket: WebSocket? = null
    private val client = OkHttpClient()

    private var width = 1080
    private var height = 1920
    private var density = 480
    private var frameSequence = 0
    private val sending = AtomicBoolean(false)
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendHeartbeat()
            heartbeatHandler.postDelayed(this, 10000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val serverUrl = intent?.getStringExtra(EXTRA_SERVER_URL).orEmpty()
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID).orEmpty()
        val token = intent?.getStringExtra(EXTRA_TOKEN).orEmpty()

        if (resultCode == 0 || resultData == null || serverUrl.isBlank() || sessionId.isBlank() || token.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }

        ensureNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        mediaProjection = projectionManager.getMediaProjection(resultCode, resultData)

        openSocket(serverUrl, sessionId, token)
        startCapture()
        heartbeatHandler.post(heartbeatRunnable)

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        heartbeatHandler.removeCallbacks(heartbeatRunnable)
        try { socket?.close(1000, "stop") } catch (_: Throwable) {}
        try { virtualDisplay?.release() } catch (_: Throwable) {}
        try { imageReader?.close() } catch (_: Throwable) {}
        try { mediaProjection?.stop() } catch (_: Throwable) {}
    }

    private fun startCapture() {
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "RemoteSupportCapture",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            null
        )

        imageReader?.setOnImageAvailableListener({ reader ->
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                sendFrame(image)
            } finally {
                image.close()
            }
        }, null)
    }

    private fun sendFrame(image: Image) {
        if (socket == null) return
        if (!sending.compareAndSet(false, true)) return
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * width

            val bitmap = Bitmap.createBitmap(
                width + rowPadding / pixelStride,
                height,
                Bitmap.Config.ARGB_8888
            )
            bitmap.copyPixelsFromBuffer(buffer)
            val cropped = Bitmap.createBitmap(bitmap, 0, 0, width, height)

            val out = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.JPEG, 85, out)
            val jpeg = out.toByteArray()
            val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)

            val payload = JSONObject()
                .put("sequence", frameSequence++)
                .put("width", width)
                .put("height", height)
                .put("format", "jpeg")
                .put("data", b64)

            val envelope = JSONObject()
                .put("type", "screen.frame")
                .put("payload", payload)

            socket?.send(envelope.toString())

            cropped.recycle()
            bitmap.recycle()
        } finally {
            sending.set(false)
        }
    }

    private fun sendHeartbeat() {
        val s = socket ?: return
        try {
            val payload = JSONObject()
                .put("platform", "android")
                .put("status", if (frameSequence > 0) "live" else "waiting_first_frame")
            val envelope = JSONObject()
                .put("type", "screen.heartbeat")
                .put("payload", payload)
            s.send(envelope.toString())
        } catch (_: Throwable) {}
    }

    private fun openSocket(serverUrl: String, sessionId: String, token: String) {
        val wsBase = if (serverUrl.startsWith("https://")) {
            "wss://${serverUrl.removePrefix("https://")}"
        } else if (serverUrl.startsWith("http://")) {
            "ws://${serverUrl.removePrefix("http://")}"
        } else {
            "wss://$serverUrl"
        }.trimEnd('/')

        val encodedSessionId = URLEncoder.encode(sessionId, StandardCharsets.UTF_8.toString())
        val encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8.toString())
        val wsUrl = "$wsBase/?role=customer&client=android-mobile-broadcast&sessionId=$encodedSessionId&token=$encodedToken"

        val request = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                val statusPayload = JSONObject()
                    .put("status", "starting")
                    .put("platform", "android")
                    .put("screenCapture", true)
                val msg = JSONObject()
                    .put("type", "screen.broadcast.status")
                    .put("payload", statusPayload)
                webSocket.send(msg.toString())
            }
        })
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Remote Support Capture",
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Remote Support")
            .setContentText("Sharing your screen with technician")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_SERVER_URL = "extra_server_url"
        const val EXTRA_SESSION_ID = "extra_session_id"
        const val EXTRA_TOKEN = "extra_token"

        private const val CHANNEL_ID = "remote_support_capture"
        private const val NOTIFICATION_ID = 2201
    }
}
