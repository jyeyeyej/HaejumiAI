package com.haejumi.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID
import java.time.LocalDate

class PersonalApi(private val client: BackendClient) {
    private fun path(kind: String): String = when (kind) {
        "schedule" -> "/schedule/events"
        "wellness" -> "/wellness/entries"
        "diary" -> "/diaries/drafts"
        else -> throw IllegalArgumentException("허용되지 않은 기능입니다.")
    }
    suspend fun list(kind: String, date: String): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(date) && runCatching { LocalDate.parse(date) }.isSuccess)
        client.request("GET", "${path(kind)}?date=$date")
    }
    suspend fun create(kind: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        client.request("POST", path(kind), body.toString(), UUID.randomUUID().toString())
    }
    suspend fun savedDiaries(date: String): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(date) && runCatching { LocalDate.parse(date) }.isSuccess)
        client.request("GET", "/diaries/entries?date=$date")
    }
    suspend fun occurrences(date: String): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(date) && runCatching { LocalDate.parse(date) }.isSuccess)
        client.request("GET", "/schedule/occurrences?from=$date&to=$date")
    }
    suspend fun edit(kind: String, id: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(id))
        client.request("PATCH", "${path(kind)}/$id", body.toString(), UUID.randomUUID().toString())
    }
    suspend fun delete(kind: String, id: String, version: Int): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(id))
        val target = if (kind == "saved_diary") "/diaries/entries" else path(kind)
        client.request("DELETE", "$target/$id", JSONObject().put("version", version).toString(), UUID.randomUUID().toString())
    }
    suspend fun beginDiaryRevision(id: String, version: Int): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(id))
        client.request("POST", "/diaries/entries/$id/revisions", JSONObject().put("version", version).toString(), UUID.randomUUID().toString())
    }
    suspend fun approve(draftId: String, version: Int, hash: String, scope: String): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(draftId))
        client.request("POST", "/diaries/drafts/$draftId/approvals", JSONObject().put("content_version", version)
            .put("content_hash", hash).put("approval_scope", scope).toString(), UUID.randomUUID().toString())
    }
    suspend fun finalize(draftId: String, version: Int, hash: String, approvalId: String): JSONObject = withContext(Dispatchers.IO) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(draftId) && Regex("^[0-9a-fA-F-]{36}$").matches(approvalId))
        client.request("POST", "/diaries/drafts/$draftId/finalize", JSONObject().put("content_version", version)
            .put("content_hash", hash).put("approval_id", approvalId).toString(), UUID.randomUUID().toString())
    }
}
