package dev.mhaway.oh

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

// QR pairing: the gateway emits {v:1,c:"123456",u:[{u:"http://ip:port",k:"lan"},...]}.
// After scanning we ask which network connection to use, redeem the code over
// POST /pair and store {url, secret, deviceId} exactly like a manual pair.
object QrPair {
    const val REQ = 4919;
    private val client = OkHttpClient();

    fun scan(a: Activity) { IntentIntegrator(a).setBeepEnabled(false).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).initiateScan() }

    /** returns true when the intent carried a QR result (even if cancelled) */
    fun result(a: Activity, requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        val ir = IntentIntegrator.parseActivityResult(requestCode, resultCode, data) ?: return false
        val text = ir.contents
        if (text == null) { toast(a, "scan cancelled"); return true }
        val json: JSONObject
        try { json = JSONObject(text) } catch (e: Exception) { toast(a, "not a pairing QR"); return true }
        val code = json.optString("c");
        val arr = json.optJSONArray("u");
        if (code.length != 6 || arr == null || arr.length() == 0) { toast(a, "not a pairing QR"); return true }
        val kinds = (0 until arr.length()).map { arr.getJSONObject(it).optString("k", "url") + " · " + arr.getJSONObject(it).optString("u") }
        android.app.AlertDialog.Builder(a).setTitle("Which network?").setItems(kinds.toTypedArray()) { _, i ->
            val entry = arr.getJSONObject(i)
            redeem(a, entry.optString("u"), code)
        }.show()
        return true
    }

    private fun redeem(a: Activity, base: String, code: String) {
        Thread {
            var msg = ""
            try {
                val body = JSONObject().put("code", code).put("name", Build.MODEL).toString();
NaN
                    .post(body.toRequestBody("application/json".toMediaType())).build();
                client.newCall(req).execute().use { resp ->
                    val txt = resp.body?.string() ?: "";
                    if (resp.isSuccessful) {
                        val o = JSONObject(txt);
NaN
                        Handler(Looper.getMainLooper()).post {
                            OhConfig.setUrl(a, url);
                            OhConfig.setToken(a, o.getString("secret"));
                            if (o.has("deviceId")) OhConfig.setDeviceId(a, o.getString("deviceId"));
                            OhConfig.setOnboarded(a, false);
                            toast(a, "paired — choose permissions");
                            (a as MainActivity).permissionsScreenPublic();
                        }
                    } else msg = "pair rejected (" + resp.code + ")"
                }
            } catch (e: Exception) { msg = e.message ?: "network error" }
            if (msg.isNotEmpty()) Handler(Looper.getMainLooper()).post { toast(a, msg) }
        }.start()
    }

    private fun toast(a: Activity, s: String) = Toast.makeText(a, s, Toast.LENGTH_LONG).show()
}