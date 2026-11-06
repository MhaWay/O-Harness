package dev.mhaway.oh

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CompanionNode(private val ctx: Context) {
    companion object { const val TAG = "oh-node"; var status = "idle" }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private var running = false
    private var backoff = 1000L
    private val handler = Handler(Looper.getMainLooper())
    private val tools = OhTools(ctx)

    fun start(url: String, token: String, deviceId: String) {
        running = true
        status = "connecting"
        connect(url, token, deviceId)
    }

    fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        try { ws?.close(1000, "bye") } catch (_: Exception) {}
        ws = null
        status = "idle"
    }

    private fun connect(url: String, token: String, deviceId: String) {
        if (!running) return
        val full = OhConfig.wsUrl(url) + "?token=" + token
        val req = Request.Builder().url(full).build()
        status = "connecting"
        try {
            ws = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    status = "connected"
                    backoff = 1000L
                    val hello = JSONObject()
                    hello.put("type", "hello")
                        .put("protocol", 1)
                        .put("name", android.os.Build.MODEL)
                        .put("kind", "mobile")
                        .put("platform", "android/" + android.os.Build.VERSION.SDK_INT)
                        .put("hostname", android.os.Build.MODEL)
                        .put("capabilities", tools.capabilities())
                        .put("tools", tools.definitions())
                    if (deviceId.isNotEmpty()) hello.put("deviceId", deviceId)
                    webSocket.send(hello.toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val m = JSONObject(text)
                        if (m.optString("type") == "welcome") {
                            val nid = m.optString("nodeId")
                            if (nid.isNotEmpty()) OhConfig.setDeviceId(ctx, nid)
                            status = "connected"
                        } else if (m.optString("type") == "rpc:req") {
                            val id = m.optString("id")
                            val method = m.optString("method")
                            val params = m.optJSONObject("params") ?: JSONObject()
                            val res = JSONObject()
                            res.put("type", "rpc:res").put("id", id)
                            try {
                                res.put("result", dispatch(method, params))
                            } catch (e: Exception) {
                                res.put("error", e.message ?: e.toString())
                            }
                            webSocket.send(res.toString())
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "bad message", e)
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    status = "retry (" + (t.message ?: "err") + ")"
                    retry(url, token, deviceId)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (running) retry(url, token, deviceId)
                }
            })
        } catch (e: Exception) {
            status = "error: " + (e.message ?: e.toString())
            retry(url, token, deviceId)
        }
    }

    private fun retry(url: String, token: String, deviceId: String) {
        if (!running) return
        val wait = backoff
        backoff = (backoff * 2).coerceAtMost(30_000L)
        handler.postDelayed({ connect(url, token, deviceId) }, wait)
    }

    private fun dispatch(method: String, params: JSONObject): Any {
        return when (method) {
            "tool.invoke" -> tools.invoke(
                params.optString("tool"), params.optJSONObject("args") ?: JSONObject())
            "exec", "fs.read", "fs.write" ->
                throw UnsupportedOperationException("$method not supported by the Android companion (tools only)")
            else -> throw UnsupportedOperationException("unknown method '$method'")
        }
    }
}
