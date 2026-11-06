package dev.mhaway.oh

import android.content.Context
import android.content.SharedPreferences

object OhConfig {
    private const val PREFS = "oh"

    fun prefs(c: Context): SharedPreferences =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var Context.baseUrl: String
        get() = prefs(this).getString("url", "") ?: ""
        set(v) { prefs(this).edit().putString("url", v).apply() }

    var Context.token: String
        get() = prefs(this).getString("token", "") ?: ""
        set(v) { prefs(this).edit().putString("token", v).apply() }

    var Context.deviceId: String
        get() = prefs(this).getString("deviceId", "") ?: ""
        set(v) { prefs(this).edit().putString("deviceId", v).apply() }

    fun wsUrl(base: String): String {
        var u = base.trim().trimEnd('/')
        u = if (u.startsWith("https")) "wss" + u.substring(5) else "ws" + u.substring(4)
        return u + "/node"
    }
}
