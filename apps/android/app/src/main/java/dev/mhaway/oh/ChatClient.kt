package dev.mhaway.oh

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Client of the gateway API channel (/api) used by the chat screen.
 * Same auth as the node channel: pass the stored secret/token in ?token=.
 * rpc(method, params, ok, err) resolves on a background OkHttp thread;
 * callers must hop to the UI thread. onEvent(topic, data) receives
 * gateway events (chat.stream, sessions.changed, ...).
 */
class ChatClient(private val baseUrl: String, private val token: String) {
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val handler = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var running = false
    private var backoff = 1000L
    private val seq = AtomicLong(0)
    private val reqs = ConcurrentHashMap<String, Pair<(Any?) -> Unit, (String) -> Unit>>()

    @Volatile var onEvent: ((String, JSONObject) -> Unit)? = null
    @Volatile var onOpen: (() -> Unit)? = null
    @Volatile var status = "idle"
    @Volatile var ready = false

    fun start() {
        running = true
        connect()
    }

    fun stop() {
        running = false
        ready = false
        handler.removeCallbacksAndMessages(null)
        try { ws?.close(1000, "bye") } catch (_: Exception) {}
        ws = null
        status = "idle"
    }

    private fun apiUrl(): String {
        var u = baseUrl.trim().trimEnd('/')
        u = if (u.startsWith("https")) "wss" + u.substring(5) else "ws" + u.substring(4)
        return u + "/api?token=" + java.net.URLEncoder.encode(token, "utf-8")
    }

    private fun connect() {
        if (!running) return
        status = "connecting"
        try {
            val req = Request.Builder().url(apiUrl()).build()
            ws = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    status = "connected"; ready = true; backoff = 1000L
                    handler.post { onOpen?.invoke() }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val m = try { JSONObject(text) } catch (_: Exception) { return }
                    if (m.optString("type") == "rpc:res") {
                        val id = m.optString("id")
                        val cb = reqs.remove(id) ?: return
                        if (m.has("error")) handler.post { cb.second(m.optString("error")) }
                        else handler.post { cb.first(m.opt("result")) }
                    } else if (m.optString("type") == "event") {
                        val topic = m.optString("topic")
                        val data = m.optJSONObject("data") ?: JSONObject()
                        handler.post { onEvent?.invoke(topic, data) }
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    ready = false
                    if (running) scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ready = false
                    if (running) scheduleReconnect()
                }
            })
        } catch (e: Exception) {
            status = "error"
            if (running) scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(15000L)
    }

    fun rpc(method: String, params: JSONObject, ok: (JSONObject) -> Unit, err: (String) -> Unit) {
        val id = "c" + seq.incrementAndGet() + "-" + System.currentTimeMillis()
        reqs[id] = Pair(ok, err)
        val msg = JSONObject().put("type", "rpc:req").put("id", id).put("method", method).put("params", params)
        val w = ws
        if (w != null && ready) {
            try { w.send(msg.toString()) } catch (e: Exception) { reqs.remove(id); err(e.message ?: "send failed") }
        } else {
            // queue: retry once the socket opens; fail fast after the socket never opens
            handler.postDelayed({
                val cur = ws
                if (reqs.containsKey(id)) {
                    if (cur != null && ready) { try { cur.send(msg.toString()) } catch (e: Exception) { reqs.remove(id); err("send failed") } }
                    else if (running) { reqs.remove(id); err("not connected — check URL/token") }
                    else { reqs.remove(id); err("not connected") }
                }
            }, 8000)
            if (!running) { running = true; connect() }
        }
    }
}