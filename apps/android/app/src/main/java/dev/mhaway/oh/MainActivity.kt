package dev.mhaway.oh

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

// Post-pair permissions screen. Each row = one capability + the permission it needs,
// all optional. Granting a permission makes its tool available; the hello that the
// node sends re-advertises only granted tools. `available` reflects real grants.
class MainActivity : android.app.Activity() {
    private var statusLine: TextView? = null
    private var urlLine: TextView? = null
    private var root: LinearLayout? = null

    // (tool key, permission, one-line rationale). battery/device.info need nothing.
    private data class ToolRow(val title: String, val what: String, val permission: String, val label: String)
    private val rows: List<ToolRow> by lazy {
        val r = mutableListOf<ToolRow>()
        if (Build.VERSION.SDK_INT >= 33) r.add(ToolRow("Notifications", "The assistant can send you notifications.",
            Manifest.permission.POST_NOTIFICATIONS, "POST_NOTIFICATIONS"))
        r.add(ToolRow("Calendar (read)", "Read your upcoming events.",
            Manifest.permission.READ_CALENDAR, "READ_CALENDAR"))
        r.add(ToolRow("Calendar (write)", "Create events on your calendar.",
            Manifest.permission.WRITE_CALENDAR, "WRITE_CALENDAR"))
        r.add(ToolRow("Location", "Know where you are, when you ask.",
            Manifest.permission.ACCESS_FINE_LOCATION, "ACCESS_FINE_LOCATION"))
        r.add(ToolRow("Microphone", "Record short audio clips on request.",
            Manifest.permission.RECORD_AUDIO, "RECORD_AUDIO"))
        return@lazy r
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val lay = LinearLayout(this)
        lay.orientation = LinearLayout.VERTICAL
        lay.setPadding(pad, pad, pad, pad)
        val scroll = ScrollView(this)
        scroll.addView(lay)
        setContentView(scroll)
        root = lay
        urlLine = tv("gateway: (not set)")
        statusLine = tv("service: idle")
        val paired = OhConfig.url(this).isNotEmpty() && OhConfig.token(this).isNotEmpty()
        if (paired && !OhConfig.onboarded(this)) {
            permissionsScreen()
        } else {
            mainPanel()
        }
    }

    private fun tv(t: String, size: Float = 14f): TextView {
        val v = TextView(this)
        v.text = t
        v.textSize = size
        v.setTextColor(0xFFE6EDF3.toInt())
        v.setPadding(0, 8, 0, 8)
        root?.addView(v)
        return v
    }

    private fun btn(label: String, onClick: () -> Unit): Button {
        val v = Button(this)
        v.text = label
        v.setOnClickListener { onClick() }
        root?.addView(v)
        return v
    }

    private fun clearRoot() { root?.removeAllViews() }

    private fun permissionsScreen() {
        clearRoot()
        tv("Almost ready", 22f)
        tv("Pairing successful. Pick what the assistant may access on this phone \u2014 all optional. You can change any of these later.", 13f)
        for (row in rows) {
            val granted = checkSelfPermission(row.permission) == PackageManager.PERMISSION_GRANTED
            tv(row.title + (if (granted) "  \u2713 active" else ""), 16f)
            tv(row.what + "\npermission: " + row.label, 12f)
            if (!granted) btn("Allow " + row.title) { askPermission(row.permission) }
        }
        tv("Battery (level) and device info are always available and need no permission.", 12f)
        btn("Avanti \u2192") { finishOnboard() }
    }

    private fun mainPanel() {
        clearRoot()
        tv("O-Harness Companion", 22f)
        urlLine = tv("gateway: (not set)")
        statusLine = tv("service: idle")
        btn("Set gateway URL") { editUrl() }
        btn("Connect / reconnect") { saveAndStart() }
        btn("Tool permissions") { permissionsScreen() }
        btn("Open gateway web UI") { openWeb() }
        btn("Test notification") { NotifUtil.post(this, "O-Harness", "Companion is alive") }
        btn("Start service on boot") { bootInfo() }
        refresh()
    }

    private fun askPermission(perm: String) {
        try { requestPermissions(arrayOf(perm), 71) } catch (e: Exception) { toast("permission request failed: " + e.message) }
    }

    private fun finishOnboard() {
        OhConfig.setOnboarded(this, true)
        saveAndStart()
        handler().postDelayed({ mainPanel() }, 800)
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
            .setNegativeButton("Token\u2026", null)
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
        Toast.makeText(this, "Connecting\u2026", Toast.LENGTH_SHORT).show()
        handler().postDelayed({ refresh() }, 1500)
    }

    private fun handler() = android.os.Handler(mainLooper)

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
        if (OhConfig.url(this).isNotEmpty() && OhConfig.token(this).isNotEmpty() && !OhConfig.onboarded(this)) {
            permissionsScreen()
            return
        }
        val denied = permissions.filterIndexed { i, _ -> results.getOrNull(i) != PackageManager.PERMISSION_GRANTED }
        if (denied.isEmpty()) toast("permission granted \u2014 reconnect to re-advertise tools") else toast("denied: " + denied.joinToString(", "))
    }
}
