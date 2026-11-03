package com.haejumi.app.feature.creator

import org.json.JSONArray
import org.json.JSONObject

data class CaptionRow(val start: String, val end: String, val text: String)

data class DraftForm(
    val captions: List<CaptionRow>,
    val captionsEnabled: Boolean,
    val musicTrackId: String,
    val sourceVolume: String,
    val musicVolume: String,
    val fadeIn: String,
    val fadeOut: String,
) {
    fun request(version: Int, hash: String): JSONObject {
        require(captions.size <= 30) { "자막은 최대 30개입니다." }
        val rows = JSONArray()
        captions.forEachIndexed { index, row ->
            val start = row.start.toDoubleOrNull(); val end = row.end.toDoubleOrNull()
            require(start != null && end != null && start >= 0 && end > start && row.text.codePointCount(0, row.text.length) <= 80) {
                "자막의 시간과 길이를 확인해 주세요."
            }
            rows.put(JSONObject().put("order", index + 1).put("start_seconds", start).put("end_seconds", end).put("text", row.text))
        }
        fun number(value: String, max: Double, label: String): Double {
            val parsed = value.toDoubleOrNull()
            require(parsed != null && parsed.isFinite() && parsed in 0.0..max) { "$label 값을 확인해 주세요." }
            return parsed
        }
        return JSONObject().put("content_version", version).put("content_hash", hash)
            .put("captions", rows).put("captions_enabled", captionsEnabled)
            .put("music_track_id", if (musicTrackId.isBlank()) JSONObject.NULL else musicTrackId)
            .put("source_volume", number(sourceVolume, 2.0, "원음 음량"))
            .put("music_volume", number(musicVolume, 2.0, "음악 음량"))
            .put("fade_in_seconds", number(fadeIn, 10.0, "페이드 인"))
            .put("fade_out_seconds", number(fadeOut, 10.0, "페이드 아웃"))
    }

    companion object {
        fun from(draft: JSONObject): DraftForm {
            val composition = draft.optJSONObject("composition")
            val captions = draft.getJSONArray("captions")
            return DraftForm((0 until captions.length()).map { index ->
                val row = captions.getJSONObject(index)
                CaptionRow(row.getDouble("start_seconds").toString(), row.getDouble("end_seconds").toString(), row.getString("text"))
            }, composition?.optBoolean("captions_enabled") ?: true,
                composition?.optString("music_track_id")?.takeUnless { it == "null" } ?: "",
                (composition?.optDouble("source_volume") ?: 1.0).toString(),
                (composition?.optDouble("music_volume") ?: 0.5).toString(),
                (composition?.optDouble("fade_in_seconds") ?: 0.0).toString(),
                (composition?.optDouble("fade_out_seconds") ?: 0.0).toString())
        }
    }
}

data class PublicationForm(val accountId: String, val visibility: String, val title: String, val description: String, val hashtags: String) {
    fun request(platform: String): JSONObject {
        require(accountId.trim().isNotEmpty()) { "게시 계정 ID를 입력해 주세요." }
        require(title.length <= 200 && description.length <= 5000) { "제목 또는 설명이 너무 깁니다." }
        val tags = hashtags.split(',', ' ', '\n').map { it.trim().removePrefix("#") }.filter { it.isNotBlank() }.distinct()
        require(tags.size <= 30 && tags.all { it.length <= 100 }) { "해시태그를 확인해 주세요." }
        return JSONObject().put("platform", platform).put("account_id", accountId.trim())
            .put("visibility", visibility).put("title", title).put("description", description)
            .put("hashtags", JSONArray(tags))
    }

    companion object {
        fun from(record: JSONObject?): PublicationForm {
            val tags = record?.optJSONArray("hashtags")
            return PublicationForm(record?.optString("account_id") ?: "", record?.optString("visibility") ?: "private",
                record?.optString("title") ?: "", record?.optString("description") ?: "",
                if (tags == null) "" else (0 until tags.length()).joinToString(" ") { "#${tags.getString(it)}" })
        }
    }
}

object CreatorGates {
    fun current(version: Int, hash: String, checkpointVersion: Int, checkpointHash: String) =
        version == checkpointVersion && hash == checkpointHash
    fun verifiedPreview(taskVersion: Int, taskHash: String, jobVersion: Int, jobHash: String, status: String, mode: String, verified: Boolean) =
        current(taskVersion, taskHash, jobVersion, jobHash) && status == "succeeded" && mode == "ffmpeg" && verified
}
