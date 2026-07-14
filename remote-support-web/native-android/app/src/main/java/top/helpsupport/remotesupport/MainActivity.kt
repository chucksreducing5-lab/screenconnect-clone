package top.helpsupport.remotesupport

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import top.helpsupport.remotesupport.capture.ScreenCaptureService
import top.helpsupport.remotesupport.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var mediaProjectionManager: MediaProjectionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        mediaProjectionManager = getSystemService(MediaProjectionManager::class.java)
        restoreSavedFields()

        binding.startButton.setOnClickListener {
            persistFields()
            val serverUrl = binding.serverUrlInput.text?.toString()?.trim().orEmpty()
            val sessionId = binding.sessionIdInput.text?.toString()?.trim().orEmpty()
            val token = binding.tokenInput.text?.toString()?.trim().orEmpty()

            if (serverUrl.isBlank() || sessionId.isBlank() || token.isBlank()) {
                Toast.makeText(
                    this,
                    "Enter Server URL, Session ID, and Token before starting broadcast.",
                    Toast.LENGTH_LONG
                ).show()
                return@setOnClickListener
            }

            val consentIntent = mediaProjectionManager.createScreenCaptureIntent()
            startActivityForResult(consentIntent, REQ_CAPTURE)
        }

        binding.stopButton.setOnClickListener {
            stopService(Intent(this, ScreenCaptureService::class.java))
            Toast.makeText(this, "Broadcast stopped.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onPause() {
        super.onPause()
        persistFields()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return

        if (resultCode != Activity.RESULT_OK || data == null) {
            Toast.makeText(
                this,
                "Screen share permission denied. Please allow to start broadcast.",
                Toast.LENGTH_LONG
            ).show()
            return
        }

        val launch = Intent(this, ScreenCaptureService::class.java).apply {
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(ScreenCaptureService.EXTRA_SERVER_URL, binding.serverUrlInput.text?.toString()?.trim().orEmpty())
            putExtra(ScreenCaptureService.EXTRA_SESSION_ID, binding.sessionIdInput.text?.toString()?.trim().orEmpty())
            putExtra(ScreenCaptureService.EXTRA_TOKEN, binding.tokenInput.text?.toString()?.trim().orEmpty())
        }
        startForegroundService(launch)

        Toast.makeText(
            this,
            "Broadcast permission granted. Starting screen share…",
            Toast.LENGTH_SHORT
        ).show()
    }

    private fun restoreSavedFields() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        binding.serverUrlInput.setText(prefs.getString(KEY_SERVER_URL, ""))
        binding.sessionIdInput.setText(prefs.getString(KEY_SESSION_ID, ""))
        binding.tokenInput.setText(prefs.getString(KEY_TOKEN, ""))
    }

    private fun persistFields() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        prefs.edit()
            .putString(KEY_SERVER_URL, binding.serverUrlInput.text?.toString()?.trim().orEmpty())
            .putString(KEY_SESSION_ID, binding.sessionIdInput.text?.toString()?.trim().orEmpty())
            .putString(KEY_TOKEN, binding.tokenInput.text?.toString()?.trim().orEmpty())
            .apply()
    }

    companion object {
        private const val REQ_CAPTURE = 9910
        private const val PREFS = "remote_support_android"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_SESSION_ID = "session_id"
        private const val KEY_TOKEN = "token"
    }
}
