package dev.mhaway.oh

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : android.app.Activity() {
    private var statusLine: TextView? = null
    private var urlLine: TextView? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(pad, pad, pad, pad)
        val scroll = ScrollView(this)
        scroll.addView(root)
        setContentView(scroll)
        fun tv(t: String, size: Float = 14f): TextView {
            val v = TextView(this)
            v.text = t
            v.textSize = size
            v.setTextColor(0xFFE6EDF3.toInt())
            v.setPadding(0, 8, 0, 8)
            root.addView(v)
            return v
        }
        fun btn(label: String, onClick: () -> Unit): Button {
            val v = Button(this)
            v.text = label
            v.setOnClickListener { onClick() }
            root.addView(v)
            return v
        }
        tv("O-Harness Companion", 22f)
        urlLine = tv("gateway: (not set)")
        statusLine = tv("service: idle")
        btn("Set gateway URL") { editUrl() }
        btn("Connect / reconnect") { saveAndStart() }
        btn("Request permissions") { requestPerms() }
        btn("Open gateway web UI") { openWeb() }
        btn("Test notification") {
            NotifUtil.post(this, "O-Harness", "Companion is alive")
        }
        btn("Start service on boot") { bootInfo() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val url = OhConfig.url(this)
        urlLine?.text = if (url.isEmpty()) "gateway: (not set)" else "gateway: $url (device " + OhConfig.deviceId(this) + ")"
        statusLine?.text = "service: " + CompanionNode.status
    }

    private fun editUrl() {
        val input = android.widget.EditText(this)
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        input.setText(OhConfig.url(this))
        input.hint = "http://192.168.50.97:18711 or wss://host"
        val dialog = android.app.AlertDialog.Builder(this)
            .setTitle("Gateway URL")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                OhConfig.setUrl(this, normalize(input.text.toString().trim()))
                refresh()
            }
            .setNegativeButton("Token…", null)
            .create()
        dialog.setOnDismissListener { askToken() }
        dialog.show()
    }

    private fun askToken() {
        val input = android.widget.EditText(this)
        input.inputType = InputType.TYPE_CLASS_TEXT
        input.setText(OhConfig.token(this))
        input.hint = "gateway token or 6-digit pair code"
        android.app.AlertDialog.Builder(this)
            .setTitle("Access token")
            .setMessage("Token from Settings in the web UI (long token), or a 6-digit pairing code from 'o-h pair create'.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                OhConfig.setToken(this, input.text.toString().trim())
                saveAndStart()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun normalize(v: String): String {
        var u = v.trim().trimEnd('/')
        if (u.isEmpty()) return u
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u
        return u
    }

    private fun saveAndStart() {
        if (OhConfig.url(this).isEmpty() || OhConfig.token(this).isEmpty()) {
            Toast.makeText(this, "Set URL and token first", Toast.LENGTH_LONG).show()
            return
        }
        val i = Intent(this, OhNodeService::class.java)
        try { startForegroundService(i) } catch (_: Exception) { startService(i) }
        Toast.makeText(this, "Connecting…", Toast.LENGTH_SHORT).show()
        handler().postDelayed({ refresh() }, 1500)
    }

    private fun handler() = android.os.Handler(mainLooper)

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        try {
            requestPermissions(perms.toTypedArray(), 42)
        } catch (e: Exception) {
            Toast.makeText(this, "permission request failed: " + e.message, Toast.LENGTH_LONG).show()
        }
    }

    private fun openWeb() {
        val url = OhConfig.url(this)
        if (url.isEmpty()) { Toast.makeText(this, "Set the gateway URL first", Toast.LENGTH_LONG).show(); return }
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { toast(e.message ?: "no browser") }
    }

    private fun bootInfo() {
        val msg = "Android does not allow auto-start without a launch. Open battery settings and set O-Harness to 'Unrestricted' so the session survives idle."
        android.app.AlertDialog.Builder(this).setTitle("Stay connected").setMessage(msg)
            .setPositiveButton("Battery settings") { _, _ ->
                try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {
                    try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName))) } catch (e2: Exception) { toast(e2.message ?: "") }
                }
            }
            .setNegativeButton("Close", null).show()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        val denied = permissions.filterIndexed { i, _ -> results.getOrNull(i) != android.content.pm.PackageManager.PERMISSION_GRANTED }
        if (denied.isEmpty()) toast("permissions granted") else toast("denied: " + denied.joinToString(", "))
        saveAndStart()
    }
}
