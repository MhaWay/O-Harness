package dev.mhaway.oh

import android.content.Context
import android.content.SharedPreferences

object OhConfig {
    private const val PREFS = "oh"

    fun prefs(c: Context): SharedPreferences =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun url(c: Context): String = prefs(c).getString("url", "") ?: ""
    fun setUrl(c: Context, v: String) { prefs(c).edit().putString("url", v).apply() }

    fun token(c: Context): String = prefs(c).getString("token", "") ?: ""
    fun setToken(c: Context, v: String) { prefs(c).edit().putString("token", v).apply() }

    fun deviceId(c: Context): String = prefs(c).getString("deviceId", "") ?: ""
    fun setDeviceId(c: Context, v: String) { prefs(c).edit().putString("deviceId", v).apply() }

    fun onboarded(c: Context): Boolean = prefs(c).getBoolean("onboarded", false)
    fun setOnboarded(c: Context, v: Boolean) { prefs(c).edit().putBoolean("onboarded", v).apply() }
    fun wsUrl(base: String): String {
        var u = base.trim().trimEnd('/')
        u = if (u.startsWith("https")) "wss" + u.substring(5) else "ws" + u.substring(4)
        return u + "/node"
    }
}