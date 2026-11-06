package dev.mhaway.oh

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

object NotifUtil {
    const val CHANNEL = "oh-events"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "O-Harness", NotificationManager.IMPORTANCE_DEFAULT)
                ch.description = "Notifications from your O-Harness gateway"
                nm.createNotificationChannel(ch)
            }
        }
    }

    fun post(ctx: Context, title: String, body: String) {
        ensureChannel(ctx)
        val b = androidx.core.app.NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
        val n = b.build()
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify((title + body).hashCode(), n)
    }
}
