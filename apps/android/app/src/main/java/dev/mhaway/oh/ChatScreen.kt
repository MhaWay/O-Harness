package dev.mhaway.oh

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The main-chat screen: talks to the gateway /api channel over ChatClient.
 * Same session the web UI uses ('main'), same streaming, same events.
 */
class ChatScreen(private val act: Activity) {
    private val root = LinearLayout(act)
    private var scroll: ScrollView? = null
    private var msgs: LinearLayout? = null
    private var input: EditText? = null
    private var hint: TextView? = null
    private var client: ChatClient? = null
    private val fmt = SimpleDateFormat("HH:mm", Locale.getDefault())
    @Volatile private var busy = false
    @Volatile private var live: TextView? = null
    @Volatile private var liveBuf = ""
    @Volatile private var steps = 0

    fun build(): android.view.View {
        val pad = (14 * act.resources.displayMetrics.density).toInt()
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(0, 0, 0, pad)

        val top = LinearLayout(act)
        top.orientation = LinearLayout.HORIZONTAL
        top.setPadding(pad, pad, pad, 6)
        hint = TextView(act)
        hint?.text = "gateway chat · tap → menu"
        hint?.textSize = 12f
        hint?.setTextColor(0xFF8B949E.toInt())
        val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        top.addView(hint, lp)
        val more = Button(act)
        more.text = "⊙"
        more.setOnClickListener { showMenu() }
        top.addView(more)
        root.addView(top)

        scroll = ScrollView(act)
        val slp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        scroll?.layoutParams = slp
        msgs = LinearLayout(act)
        msgs?.orientation = LinearLayout.VERTICAL
        msgs?.setPadding(pad, 4, pad, 4)
        scroll?.addView(msgs)
        root.addView(scroll, slp)

        val bar = LinearLayout(act)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.setPadding(pad, 6, pad, 6)
        input = EditText(act)
        input?.hint = "Ask the assistant…"
        input?.setTextColor(0xFFE6EDF3.toInt())
        input?.setSingleLine(true)
        input?.imeOptions = EditorInfo.IME_ACTION_SEND
        input?.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { send(); true } else false
        }
        bar.addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val go = Button(act)
        go.text = "↑"
        go.setOnClickListener { send() }
        bar.addView(go)
        root.addView(bar)

        start()
        return root
    }

    private fun start() {
        val c = ChatClient(OhConfig.url(act), OhConfig.token(act))
        c.onOpen = { render(); pull() }
        c.onEvent = { topic, data -> onEvent(topic, data) }
        c.start()
        client = c
        pull()
    }

    fun close() {
        client?.stop()
        client = null
    }

    private fun onEvent(topic: String, data: JSONObject) {
        when (topic) {
            "chat.stream" -> {
                val s = live
                if (s != null) {
                    liveBuf += data.optString("tok", "")
                    s.text = liveBuf
                    scrollToBottom()
                } else if (data.optString("sessionId") == sessionId) {
                    beginLive()
                }
            }
            "chat.tool" -> {
                if (data.optString("sessionId") == sessionId) {
                    val label = data.optString("tool") + (if (data.has("result")) "" else " ◐")
                    steps++
                    setHint("running: " + label + " (" + steps + " steps)")
                }
            }
            "sessions.changed" -> if (!busy) pull()
        }
    }

    private var sessionId: String = "main"

    fun useSession(id: String) {
        if (id.isNotEmpty() && id != sessionId) {
            sessionId = id
            busy = false
            live = null
            pull()
        }
    }

    fun rpcPublic(method: String, params: JSONObject, ok: (Any?) -> Unit, err: (String) -> Unit) {
        val c = client ?: return err("not connected")
        c.rpc(method, params, ok, err)
    }

    private fun pull() {
        val c = client ?: return
        if (busy) return
        c.rpc("chat.history", JSONObject().put("sessionId", sessionId).put("limit", 60), { res ->
            val arr = if (res is JSONArray) res else JSONArray()
            render(arr)
        }, { e -> setHint("history failed: " + e) })
    }

    private fun render(arr: JSONArray) {
        val m = msgs ?: return
        m.removeAllViews()
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            val role = e.optString("role")
            val text = e.optString("text")
            if (role == "assistant" && text.isEmpty()) continue
            addBubble(role, text, e.optString("ts"), e.optJSONArray("steps")?.length() ?: 0)
        }
        scrollToBottom()
    }

    private fun render() {
        val m = msgs ?: return
        m.removeAllViews()
    }

    private fun send() {
        val text = input?.text?.toString()?.trim() ?: return
        if (text.isEmpty()) return
        val c = client ?: return
        hideKeyboard()
        addBubble("user", text, System.currentTimeMillis().toString(), 0)
        input?.setText("")
        busy = true
        steps = 0
        setHint("assistant is thinking…")
        beginLive()
        c.rpc("chat.send", JSONObject().put("sessionId", sessionId).put("message", text), { res ->
            busy = false
            val o = res as? JSONObject
            finishLive(o?.optString("text", liveBuf) ?: liveBuf)
            setHint("")
            scrollToBottom()
        }, { e ->
            busy = false
            finishLive("(error: " + e + ")")
            setHint("")
        })
    }

    private fun beginLive() {
        liveBuf = ""
        val tv = TextView(act)
        tv.setTextColor(0xFFE6EDF3.toInt())
        tv.setTextSize(15f)
        tv.text = "○"
        bubbleWrap(tv, false)
        msgs?.addView(tv)
        live = tv
    }

    private fun finishLive(finalText: String) {
        val s = live ?: return
        val t = finalText.ifEmpty { liveBuf }
        s.text = t
        live = null
    }

    private fun addBubble(role: String, text: String, ts: String, nsteps: Int) {
        val tv = TextView(act)
        tv.text = text
        tv.textSize = 15f
        tv.setTextColor(if (role == "user") 0xFFFFFFFF.toInt() else 0xFFE6EDF3.toInt())
        bubbleWrap(tv, role == "user")
        msgs?.addView(tv)
        if (nsteps > 0) {
            val st = TextView(act)
            st.text = "⚙ ran " + nsteps + " step" + (if (nsteps > 1) "s" else "")
            st.textSize = 11f
            st.setTextColor(0xFF8B949E.toInt())
            st.setPadding((14 * act.resources.displayMetrics.density).toInt(), 0, 0, 6)
            msgs?.addView(st)
        }
    }

    private fun bubbleWrap(tv: TextView, mine: Boolean) {
        val pad = (10 * act.resources.displayMetrics.density).toInt()
        tv.setPadding(pad + 4, pad, pad + 4, pad)
        tv.setBackgroundColor(if (mine) 0xFF1F6FEB.toInt() else 0x14FFFFFF)
        val p = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        p.setMargins(0, 6, 0, 6)
        p.gravity = if (mine) Gravity.END else Gravity.START
        tv.layoutParams = p
    }

    private fun setHint(s: String) {
        hint?.text = if (s.isEmpty()) "gateway chat" else s
    }

    private fun scrollToBottom() {
        scroll?.post { scroll?.fullScroll(android.view.View.FOCUS_DOWN) }
    }

    private fun hideKeyboard() {
        val im = act.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        input?.let { im?.hideSoftInputFromWindow(it.windowToken, 0) }
    }

    private fun showMenu() {
        val items = arrayOf("Tool permissions", "Sessions", "Open gateway web UI", "Back to panel")
        android.app.AlertDialog.Builder(act)
            .setTitle("O-Harness")
            .setItems(items) { _, i ->
                when (i) {
                    0 -> (act as? MainActivity)?.permissionsScreenPublic()
                    1 -> (act as? MainActivity)?.sessionsScreenPublic()
                    2 -> (act as? MainActivity)?.openWebPublic()
                    3 -> (act as? MainActivity)?.panelScreenPublic()
                }
            }
            .show()
    }
}