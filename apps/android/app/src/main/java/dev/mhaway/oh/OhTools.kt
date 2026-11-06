package dev.mhaway.oh

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class OhTools(private val ctx: Context) {

    fun capabilities(): JSONArray =
        JSONArray().put("tools").put("tools:notify").put("tools:calendar")

    fun definitions(): JSONArray = JSONArray().apply {
        put(JSONObject().put("name", "notify")
            .put("description", "Show a notification on this phone. Args: {title?: string, body?: string}")
            .put("parameters", JSONObject().put("type", "object")
                .put("properties", JSONObject().put("title", JSONObject().put("type", "string"))
                    .put("body", JSONObject().put("type", "string")))))
        put(JSONObject().put("name", "calendar.list")
            .put("description", "List calendar events in a time window. Args: {days?: number, default 7}")
            .put("parameters", JSONObject().put("type", "object")
                .put("properties", JSONObject().put("days", JSONObject().put("type", "number")))))
        put(JSONObject().put("name", "calendar.create")
            .put("description", "Create a calendar event. Args: {title: string, startISO: string, endISO?: string, location?: string}")
            .put("parameters", JSONObject().put("type", "object")
                .put("properties", JSONObject().put("title", JSONObject().put("type", "string"))
                    .put("startISO", JSONObject().put("type", "string"))
                    .put("endISO", JSONObject().put("type", "string"))
                    .put("location", JSONObject().put("type", "string")))
                .put("required", JSONArray().put("title").put("startISO"))))
        put(JSONObject().put("name", "location.get")
            .put("description", "Return the phone current or last known GPS/network location. Args: {}")
            .put("parameters", JSONObject().put("type", "object")))
        put(JSONObject().put("name", "location.watch")
            .put("description", "Remember the last phone location for up to N minutes. Args: {minutes?: number, default 30}")
            .put("parameters", JSONObject().put("type", "object")
                .put("properties", JSONObject().put("minutes", JSONObject().put("type", "number")))))
        put(JSONObject().put("name", "battery.get")
            .put("description", "Battery level and charging state. Args: {}")
            .put("parameters", JSONObject().put("type", "object")))
        put(JSONObject().put("name", "record.audio")
            .put("description", "Record audio from the microphone and return base64. Args: {seconds?: number, default 5, max 30}")
            .put("parameters", JSONObject().put("type", "object")
                .put("properties", JSONObject().put("seconds", JSONObject().put("type", "number")))))
        put(JSONObject().put("name", "device.info")
            .put("description", "Phone model, android version, battery, battery saver, timezone. Args: {}")
            .put("parameters", JSONObject().put("type", "object")))
        put(JSONObject().put("name", "screenshot")
            .put("description", "Not available from the Android companion (needs media projection). Args: {}")
            .put("parameters", JSONObject().put("type", "object")))
    }

    private fun need(perm: String) {
        if (ctx.checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED)
            throw SecurityException("permission denied: $perm — grant it in the O-Harness companion app")
    }

    fun invoke(tool: String, args: JSONObject): Any = when (tool) {
        "notify" -> { NotifUtil.post(ctx, args.optString("title", "O-Harness"), args.optString("body", "")); JSONObject().put("ok", true) }
        "calendar.list" -> calendarList(args.optInt("days", 7))
        "calendar.create" -> calendarCreate(args)
        "location.get" -> locationGet()
        "location.watch" -> locationWatch(args.optInt("minutes", 30))
        "battery.get" -> batteryGet()
        "record.audio" -> recordAudio(args.optInt("seconds", 5))
        "device.info" -> deviceInfo()
        "screenshot" -> throw UnsupportedOperationException("screenshot requires MediaProjection, not implemented")
        else -> throw UnsupportedOperationException("unknown tool '$tool'")
    }

    private val ISO = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", java.util.Locale.US).apply {
        timeZone = TimeZone.getDefault()
    }

    private fun calendarList(days: Int): JSONArray {
        need(Manifest.permission.READ_CALENDAR)
        val now = System.currentTimeMillis()
        val until = now + days.toLong() * 86_400_000L
        val out = JSONArray()
        ctx.contentResolver.query(
            CalendarContract.INstances.CONTENT_URI,
            arrayOf(CalendarContract.INstances.CALENDAR_ID, CalendarContract.INstances.TITLE,
                CalendarContract.INstances.BEGIN_TIME, CalendarContract.INstances.END_TIME,
                CalendarContract.INstances.EVENT_LOCATION),
            CalendarContract.INstances.BEGIN_TIME + " >= ? AND " + CalendarContract.INstances.BEGIN_TIME + " < ?",
            arrayOf(now.toString(), until.toString()),
            CalendarContract.INstances.BEGIN_TIME + " ASC"
        )?.use { c ->
            while (c.moveToNext() && out.length() < 50) {
                val o = JSONObject()
                o.put("calendarId", c.getLong(0))
                o.put("title", c.getString(1) ?: "")
                o.put("start", ISO.format(c.getLong(2)))
                o.put("end", ISO.format(c.getLong(3)))
                o.put("location", c.getString(4) ?: "")
                out.put(o)
            }
        }
        return out
    }

    private fun calendarCreate(args: JSONObject): JSONObject {
        need(Manifest.permission.WRITE_CALENDAR)
        val title = args.optString("title").takeIf { it.isNotEmpty() }
            ?: throw IllegalArgumentException("calendar.create: title required")
        val start = parseISO(args.optString("startISO")) ?: throw IllegalArgumentException("bad startISO")
        val end = parseISO(args.optString("endISO")) ?: (start + 3_600_000L)
        val calId = firstCalendarId()
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calId)
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.DTSTART, start)
            put(CalendarContract.Events.DTEND, end)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
            if (args.optString("location").isNotEmpty()) put(CalendarContract.Events.EVENT_LOCATION, args.getString("location"))
        }
        val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
        val id = uri?.lastPathSegment ?: "-1"
        return JSONObject().put("ok", true).put("eventId", id).put("calendarId", calId)
    }

    private fun parseISO(s: String): Long? =
        if (s.isEmpty()) null else try { ISO.parse(s).time } catch (_: Exception) { null }

    private fun firstCalendarId(): Long {
        ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._id),
            CalendarContract.Calendars.VISIBLE + "=1", null, null)?.use { c ->
            if (c.moveToNext()) return c.getLong(0)
        }
        throw IllegalStateException("no visible calendar on this device")
    }

    private var watchStop: Runnable? = null

    private fun locationGet(): JSONObject {
        val saved = OhConfig.prefs(ctx).getString("watch.last", "")
        if (!saved.isNullOrEmpty()) {
            try { val w = JSONObject(saved); w.put("watched", true); return w } catch (_: Exception) {}
        }
        val p = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var best: Location? = null
        for (pr in p.allProviders) {
            try { best = p.getLastKnownLocation(pr); if (best != null) break } catch (_: Exception) {}
        }
        if (best == null && p.allProviders.isNotEmpty()) {
            val latch = java.util.concurrent.CountDownLatch(1)
            val ref = AtomicReference<Location?>()
            try {
                p.requestSingleUpdate(p.allProviders.first(), LocationListener { loc -> ref.set(loc); latch.countDown() }, null)
                latch.await(6, TimeUnit.SECONDS)
                best = ref.get()
            } catch (_: Exception) {}
        }
        return JSONObject().put("ok", true).put("lat", best?.latitude ?: 0.0)
            .put("lon", best?.longitude ?: 0.0).put("t", System.currentTimeMillis()).put("known", best != null))
    }

    private fun locationWatch(minutes: Int): JSONObject {
        need(Manifest.permission.ACCESS_FINE_LOCATION)
        val stop = watchStop
        if (stop != null) Handler(Looper.getMainLooper()).removeCallbacks(stop)
        val p = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val listener = LocationListener { loc ->
            val w = JSONObject().put("lat", loc.latitude).put("lon", loc.longitude).put("t", System.currentTimeMillis())
            OhConfig.prefs(ctx).edit().putString("watch.last", w.toString()).apply()
        }
        val provider = if (p.allProviders.contains(LocationManager.NETWORK_PROVIDER))
            LocationManager.NETWORK_PROVIDER else LocationManager.GPS_PROVIDER
        p.requestLocationUpdates(provider, 30_000L, 10f, listener, Looper.getMainLooper())
        val stopper = Runnable { try { p.removeUpdates(listener) } catch (_: Exception) {} }
        watchStop = stopper
        Handler(Looper.getMainLooper()).postDelayed(stopper, minutes.coerceIn(1, 60) * 60_000L)
        return JSONObject().put("ok", true).put("minutes", minutes).put("provider", provider)
            .put("note", "last location is stored; location.get returns it"))
    }

    private fun batteryGet(): JSONObject {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return JSONObject().put("level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", bm.isCharging).put("saver", isPowerSaver()).put("t", System.currentTimeMillis())
    }

    private fun isPowerSaver(): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE)
        return try { pm.javaClass.getMethod("isPowerSaveMode").invoke(pm) as Boolean } catch (_: Exception) { false }
    }

    private fun deviceInfo(): JSONObject {
        val b = batteryGet()
        return JSONObject()
            .put("model", Build.MODEL)
            .put("manufacturer", Build.MANUFACTURER)
            .put("android", Build.VERSION.SDK_INT)
            .put("battery", b.getInt("level"))
            .put("charging", b.getBoolean("charging"))
            .put("saver", b.getBoolean("saver"))
            .put("timezone", TimeZone.getDefault().id)
            .put("version", ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?")
    }

    private fun recordAudio(seconds: Int): JSONObject {
        need(Manifest.permission.RECORD_AUDIO)
        val sec = seconds.coerceIn(1, 30)
        val file = File.createTempFile("oh-rec", ".m4a", ctx.cacheDir)
        val rec = MediaRecorder()
        try {
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            Thread.sleep(sec * 1000L)
        } finally {
            try { rec.stop() } catch (_: Exception) {}
            rec.release()
        }
        val bytes = file.readBytes()
        file.delete()
        return JSONObject().put("ok", true).put("mimeType", "audio/mp4")
            .put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
    }
}
