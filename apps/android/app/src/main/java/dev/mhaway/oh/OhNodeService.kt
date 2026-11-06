package dev.mhaway.oh

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

class OhNodeService : Service() {
    private var node: CompanionNode? = null

    override fun onCreate() {
        super.onCreate()
        NotifUtil.ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundWithNotif()
        val url = OhConfig.url(this)
        val token = OhConfig.token(this)
        if (url.isNotEmpty() && token.isNotEmpty()) {
            val n = node ?: CompanionNode(this).also { node = it }
            n.start(url, token, OhConfig.deviceId(this))
        } else if (node != null) {
            node?.stop()
            node = null
        }
        return START_STICKY
    }

    override fun onDestroy() {
        node?.stop()
        node = null
        super.onDestroy()
    }

    override fun onTaskRemoved(root: Intent?) {
        super.onTaskRemoved(root)
        // keep the session alive across swipe-away: the service restarts itself via START_STICKY
        val n = node
        if (n != null) { n.stop(); node = null }
        if (OhConfig.url(this).isNotEmpty()) startService(Intent(this, OhNodeService::class.java))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundWithNotif() {
        val b = androidx.core.app.NotificationCompat.Builder(this, NotifUtil.CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("O-Harness")
            .setContentText("" + CompanionNode.status)
            .setOngoing(true)
        startForeground(1, b.build())
    }
}
