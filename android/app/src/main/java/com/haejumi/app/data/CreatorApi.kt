package com.haejumi.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

data class CreatorSnapshot(
    val task: JSONObject,
    val plan: JSONObject?,
    val draft: JSONObject?,
    val checkpoints: JSONArray,
    val tracks: JSONArray,
    val publications: JSONArray,
    val job: JSONObject?,
)

class CreatorApi(private val client: BackendClient) {
    private val writeKeys = mutableMapOf<String, String>()
    private val uuid = Regex("^[0-9a-fA-F-]{36}$")

    private fun id(value: String): String {
        require(uuid.matches(value)) { "작업 식별자를 확인해 주세요." }
        return value
    }

    private fun write(method: String, path: String, body: JSONObject? = null): JSONObject {
        val serialized = body?.toString()
        val fingerprint = "$method:$path:${serialized ?: ""}"
        val key = writeKeys.getOrPut(fingerprint) { UUID.randomUUID().toString() }
        return client.request(method, path, serialized, key)
    }

    suspend fun snapshot(taskId: String, rememberedJobId: String? = null) = withContext(Dispatchers.IO) {
        val path = "/tasks/${id(taskId)}"
        val task = client.request("GET", path)
        val plan = runCatching { client.request("GET", "$path/plan") }.getOrElse { if (it is ApiException && it.status == 409) null else throw it }
        val draft = runCatching { client.request("GET", "$path/draft") }.getOrElse { if (it is ApiException && it.status == 409) null else throw it }
        val checkpoints = client.request("GET", "$path/checkpoints").getJSONArray("items")
        val tracks = client.request("GET", "/music/tracks").getJSONArray("items")
        val publications = client.request("GET", "$path/publications").getJSONArray("items")
        val active = task.optString("active_job_id").takeIf { it.isNotBlank() } ?: rememberedJobId
        val job = active?.let { client.request("GET", "/jobs/${id(it)}") }?.takeIf { it.optString("task_id") == taskId }
        CreatorSnapshot(task, plan, draft, checkpoints, tracks, publications, job)
    }

    suspend fun createOrRevisePlan(taskId: String, version: Int, requestText: String) = withContext(Dispatchers.IO) {
        require(requestText.isNotBlank()) { "기획 요청이나 수정 내용을 입력해 주세요." }
        write("POST", "/tasks/${id(taskId)}/plan", JSONObject().put("content_version", version).put("request_text", requestText.trim()))
    }
    suspend fun updateScenes(taskId: String, version: Int, hash: String, scenes: JSONArray) = withContext(Dispatchers.IO) {
        write("PUT", "/tasks/${id(taskId)}/plan", JSONObject().put("content_version", version).put("content_hash", hash).put("scenes", scenes))
    }

    suspend fun approve(taskId: String, checkpoint: JSONObject) = withContext(Dispatchers.IO) {
        require(checkpoint.getString("status") == "pending") { "현재 승인 대상을 다시 확인해 주세요." }
        val body = JSONObject().put("checkpoint_id", id(checkpoint.getString("checkpoint_id")))
            .put("content_version", checkpoint.getInt("content_version"))
            .put("content_hash", checkpoint.getString("content_hash"))
            .put("approval_scope", "continue")
        write("POST", "/tasks/${id(taskId)}/approvals", body)
    }

    suspend fun updateDraft(taskId: String, body: JSONObject) = withContext(Dispatchers.IO) {
        write("PATCH", "/tasks/${id(taskId)}/draft", body)
    }

    suspend fun render(taskId: String, version: Int, hash: String) = withContext(Dispatchers.IO) {
        write("POST", "/tasks/${id(taskId)}/render", JSONObject().put("content_version", version).put("content_hash", hash))
    }

    suspend fun job(jobId: String) = withContext(Dispatchers.IO) { client.request("GET", "/jobs/${id(jobId)}") }
    suspend fun cancelJob(jobId: String) = withContext(Dispatchers.IO) { write("POST", "/jobs/${id(jobId)}/cancel") }

    suspend fun savePublication(taskId: String, existing: JSONObject?, body: JSONObject) = withContext(Dispatchers.IO) {
        val path = "/tasks/${id(taskId)}/publications"
        if (existing == null) write("POST", path, body)
        else write("PATCH", "$path/${id(existing.getString("publication_id"))}", JSONObject(body.toString()).put("revision", existing.getInt("revision")))
    }

    suspend fun approvePublication(taskId: String, publication: JSONObject, task: JSONObject, job: JSONObject) = withContext(Dispatchers.IO) {
        require(task.optString("status") == "preview_approved" && job.optString("status") == "succeeded" &&
            job.optString("renderer_mode") == "ffmpeg" && job.optBoolean("artifact_verified") &&
            job.optInt("content_version") == task.getInt("current_version") && job.optString("content_hash") == task.getString("content_hash")) {
            "현재 영상의 실제 렌더와 미리보기 승인이 필요합니다."
        }
        val body = JSONObject().put("content_version", task.getInt("current_version"))
            .put("content_hash", task.getString("content_hash"))
            .put("artifact_sha256", job.getString("artifact_sha256"))
            .put("publication_revision", publication.getInt("revision"))
            .put("publication_hash", publication.getString("metadata_hash"))
        write("POST", "/tasks/${id(taskId)}/publications/${id(publication.getString("publication_id"))}/approvals", body)
    }

    suspend fun preview(context: Context, taskId: String, version: Int, expectedSha256: String): File = withContext(Dispatchers.IO) {
        require(Regex("^[a-fA-F0-9]{64}$").matches(expectedSha256)) { "검증된 영상 해시가 없습니다." }
        val address = client.settings.address
        val token = client.settings.token()
        require(com.haejumi.app.core.SecureSettings.validAddress(address) && !token.isNullOrBlank()) { "안전한 PC 연결을 설정해 주세요." }
        val host = URI(address).host.lowercase()
        if (host.endsWith(".ts.net")) {
            val resolved = InetAddress.getAllByName(host)
            require(resolved.isNotEmpty() && resolved.all {
                it is Inet4Address && (it.address[0].toInt() and 255) == 100 && (it.address[1].toInt() and 255) in 64..127
            }) { "사설 Tailscale 주소를 확인할 수 없습니다." }
        }
        val connection = URL("$address/api/v1/tasks/${id(taskId)}/preview?content_version=$version").openConnection() as HttpsURLConnection
        var file: File? = null
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000; connection.readTimeout = 60000
            connection.setRequestProperty("Authorization", "Bearer $token")
            val status = connection.responseCode
            if (status !in 200..299) throw ApiException(status)
            require(connection.contentType?.substringBefore(';') == "video/mp4" && connection.getHeaderField("X-Haejumi-Render-Mode") == "ffmpeg") {
                "실제 MP4 렌더 결과가 아닙니다."
            }
            val limit = 512L * 1024 * 1024
            require(connection.contentLengthLong in 1..limit) { "미리보기 파일 크기를 확인할 수 없습니다." }
            file = File.createTempFile("haejumi-preview-", ".mp4", context.cacheDir)
            val digest = MessageDigest.getInstance("SHA-256")
            var size = 0L
            connection.inputStream.use { input -> file.outputStream().use { output ->
                val buffer = ByteArray(65536)
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    size += count; require(size <= limit) { "미리보기 파일이 너무 큽니다." }
                    digest.update(buffer, 0, count); output.write(buffer, 0, count)
                }
            } }
            require(size == connection.contentLengthLong && digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }.equals(expectedSha256, true)) {
                "미리보기 영상 해시가 서버 결과와 다릅니다."
            }
            file
        } catch (error: Throwable) { file?.delete(); throw error }
        finally { connection.disconnect() }
    }
}
