package com.haejumi.app.data

import android.content.ContentResolver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import com.haejumi.app.core.SecureSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import kotlin.coroutines.coroutineContext

data class SelectedMedia(val uri: Uri, val name: String, val type: String, val size: Long)
data class UploadAttempt(val media: SelectedMedia, val itemId: String = UUID.randomUUID().toString(),
    val initKey: String = UUID.randomUUID().toString(), val partKey: String = UUID.randomUUID().toString(),
    val completeKey: String = UUID.randomUUID().toString())

class BackendClient(internal val settings: SecureSettings, private val resolver: ContentResolver) {
    @Volatile private var active: HttpsURLConnection? = null
    fun cancel() { active?.disconnect() }

    fun select(uri: Uri): SelectedMedia {
        require(uri.scheme == "content") { "선택한 파일을 읽을 수 없습니다." }
        var name: String? = null
        var size: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val s = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n)
                if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s)
            }
        }
        val fileName = name ?: throw IllegalArgumentException("파일 이름을 확인할 수 없습니다.")
        val length = size ?: throw IllegalArgumentException("파일 크기를 확인할 수 없습니다.")
        require(length > 0 && length <= 50L * 1024 * 1024) { "파일은 50 MiB 이하여야 합니다." }
        require(!fileName.contains('/') && !fileName.contains('\\')) { "파일 이름을 확인해 주세요." }
        val type = resolver.getType(uri) ?: ""
        require(type in setOf("image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime")) { "지원하지 않는 파일 형식입니다." }
        return SelectedMedia(uri, fileName, type, length)
    }

    suspend fun check() = withContext(Dispatchers.IO) { request("GET", "/capabilities") }
    suspend fun taskStatus(taskId: String) = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(taskId))
        request("GET", "/tasks/$taskId").getString("status")
    }
    suspend fun message(text: String) = withContext(Dispatchers.IO) {
        request("POST", "/assistant/messages", JSONObject().put("text", text).toString(), UUID.randomUUID().toString()).getString("reply")
    }
    suspend fun createProject(mediaId: String, key: String) = withContext(Dispatchers.IO) {
        request("POST", "/content/projects", JSONObject().put("media_ids", JSONArray().put(mediaId)).toString(), key).getString("task_id")
    }
    suspend fun createProject(mediaIds: List<String>, key: String) = withContext(Dispatchers.IO) {
        require(mediaIds.isNotEmpty() && mediaIds.size <= 30 && mediaIds.distinct().size == mediaIds.size)
        val ids = JSONArray(); mediaIds.forEach { ids.put(it) }
        request("POST", "/content/projects", JSONObject().put("media_ids", ids).toString(), key).getString("task_id")
    }

    suspend fun upload(attempt: UploadAttempt, progress: (Float) -> Unit): String = withContext(Dispatchers.IO) {
        val media = attempt.media
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        resolver.openInputStream(media.uri)?.use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                coroutineContext.ensureActive()
                val n = input.read(buffer); if (n < 0) break
                count += n; require(count <= media.size) { "파일 크기가 변경되었습니다." }; digest.update(buffer, 0, n)
            }
        } ?: error("선택한 파일을 열 수 없습니다.")
        require(count == media.size) { "파일 크기가 변경되었습니다." }
        val hash = digest.digest().hex()
        val item = JSONObject().put("client_item_id", attempt.itemId).put("file_name", media.name)
            .put("declared_media_type", media.type).put("size_bytes", media.size).put("sha256", hash)
        val init = request("POST", "/media/uploads", JSONObject().put("items", JSONArray().put(item)).toString(), attempt.initKey)
        val uploadId = init.getString("upload_id")
        require(Regex("^[0-9a-fA-F-]{36}$").matches(uploadId)) { "서버 응답을 확인할 수 없습니다." }
        request("PUT", "/media/uploads/$uploadId/parts/1", key = attempt.partKey, media = media, progress = progress)
        val manifestHash = UploadManifest.hash(attempt.itemId, hash, media.size)
        request("POST", "/media/uploads/$uploadId/complete", JSONObject().put("manifest_sha256", manifestHash).toString(), attempt.completeKey)
            .getJSONArray("media").getJSONObject(0).getString("media_id")
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
    internal fun request(method: String, path: String, body: String? = null, key: String? = null,
                        media: SelectedMedia? = null, progress: (Float) -> Unit = {}): JSONObject {
        val address = settings.address
        val token = settings.token()
        require(SecureSettings.validAddress(address) && !token.isNullOrBlank()) { "안전한 PC 연결을 먼저 설정해 주세요." }
        val host = URI(address).host.lowercase()
        if (host.endsWith(".ts.net")) {
            val addresses = InetAddress.getAllByName(host)
            require(addresses.isNotEmpty() && addresses.all {
                it is Inet4Address && (it.address[0].toInt() and 255) == 100 && (it.address[1].toInt() and 255) in 64..127
            }) { "사설 Tailscale 주소를 확인할 수 없습니다." }
        }
        val connection = URL("$address/api/v1$path").openConnection() as HttpsURLConnection
        active = connection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.requestMethod = method
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (key != null) connection.setRequestProperty("Idempotency-Key", key)
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            } else if (media != null) {
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/octet-stream")
                connection.setFixedLengthStreamingMode(media.size)
                resolver.openInputStream(media.uri)?.use { input -> connection.outputStream.use { output ->
                    val buffer = ByteArray(65536); var sent = 0L
                    while (true) {
                        if (Thread.currentThread().isInterrupted) throw InterruptedException()
                        val n = input.read(buffer); if (n < 0) break
                        sent += n; require(sent <= media.size) { "파일 크기가 변경되었습니다." }
                        output.write(buffer, 0, n)
                        Handler(Looper.getMainLooper()).post { progress(sent.toFloat() / media.size) }
                    }
                    require(sent == media.size) { "파일 크기가 변경되었습니다." }
                } } ?: error("선택한 파일을 열 수 없습니다.")
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                val code = runCatching { JSONObject(connection.errorStream?.bufferedReader()?.use { it.readText() } ?: "").optJSONObject("error")?.optString("code") }.getOrNull()
                throw ApiException(status, code)
            }
            val response = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            return if (response.isBlank()) JSONObject() else JSONObject(response)
        } finally { active = null; connection.disconnect() }
    }
}

class ApiException(val status: Int, val code: String? = null) : Exception()
