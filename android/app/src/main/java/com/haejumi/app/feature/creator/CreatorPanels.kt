package com.haejumi.app.feature.creator

import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

private fun checkpoint(items: JSONArray, kind: String, task: JSONObject): JSONObject? = items.objects().lastOrNull {
    it.optString("kind") == kind && it.optInt("content_version") == task.optInt("current_version") &&
        it.optString("content_hash") == task.optString("content_hash") && it.optString("status") in listOf("pending", "approved")
}

@Composable
fun PlanPanel(task: JSONObject, plan: JSONObject?, checkpoints: JSONArray, busy: Boolean,
              onSave: (String) -> Unit, onSaveScenes: (JSONArray) -> Unit, onApprove: (JSONObject) -> Unit) {
    var requestText by remember(task.optInt("current_version")) { mutableStateOf("") }
    val current = checkpoint(checkpoints, "plan", task)
    Section("쇼츠 기획안") {
        if (plan == null) Text("아직 기획안이 없습니다. 선택한 파일을 바탕으로 로컬 규칙 기획을 요청해 주세요.")
        else {
            val board = plan.getJSONObject("plan")
            Text("제목 제안: ${board.optString("title_idea")}")
            Text("화면 ${board.optString("aspect_ratio")} · ${board.optInt("target_seconds")}초 · 버전 ${plan.optInt("content_version")}")
            Text("생성 출처: ${plan.optJSONObject("generation")?.optString("source") ?: "local_rules"}")
            if (board.has("theme")) Text("주제 ${board.optString("theme")} · 분위기 ${board.optString("mood")} · 오프닝 ${board.optString("opening_hook")}")
            board.optJSONArray("media_insights")?.objects()?.forEachIndexed { index, insight ->
                Text("미디어 ${index + 1}: ${insight.optString("description")} · ${insight.optString("category", "unknown")} · ${insight.optString("orientation", "unknown")}")
            }
            board.optJSONArray("scenes")?.objects()?.forEach { scene ->
                Text("장면 ${scene.optInt("order")}: ${scene.optDouble("start_seconds")}~${scene.optDouble("end_seconds")}초")
                Text(scene.optString("visual_direction"))
                Text("제안 자막: ${scene.optString("caption_text")}")
                Text("효과 ${scene.optString("framing", "inherit")} · ${scene.optString("motion", "static")} · ${scene.optString("transition", "cut")}")
            }
            val initialScenes = remember(plan.optInt("content_version")) { board.getJSONArray("scenes").objects().map { scene ->
                SceneEditRow(scene.getString("media_id"), scene.getString("media_type"),
                    "%.2f".format(java.util.Locale.US, scene.getDouble("end_seconds") - scene.getDouble("start_seconds")),
                    scene.optDouble("trim_start_seconds", 0.0).toString(),
                    if (scene.has("trim_end_seconds")) scene.optDouble("trim_end_seconds").toString() else "",
                    scene.optString("framing", "inherit"), scene.optString("motion", "static"),
                    scene.optString("transition", "cut"), scene.optString("subtitle_style", "default")) } }
            var sceneRows by remember(plan.optInt("content_version")) { mutableStateOf(initialScenes) }
            val durationSum = sceneRows.sumOf { it.duration.toDoubleOrNull() ?: 0.0 }
            Text("장면 순서·길이 수정 · 합계 ${"%.2f".format(java.util.Locale.US, durationSum)}/${board.optInt("target_seconds")}초")
            sceneRows.forEachIndexed { index, row ->
                Text("${index + 1}. ${if (row.mediaType.startsWith("video/")) "영상" else "사진"} · ${row.mediaId.take(8)}")
                OutlinedTextField(row.duration, { text -> sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(duration = text) } }, label = { Text("재생 초") })
                if (row.mediaType.startsWith("video/")) OutlinedTextField(row.trimStart, { text -> sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(trimStart = text) } }, label = { Text("영상 시작 위치(초)") })
                if (row.mediaType.startsWith("video/")) OutlinedTextField(row.trimEnd, { text -> sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(trimEnd = text) } }, label = { Text("영상 종료 위치(초, 선택)") })
                TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(framing = nextEffect(row.framing, listOf("inherit", "fit_pad", "fill_crop", "blur_pad"))) } }, enabled = !busy) { Text("화면: ${row.framing}") }
                TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(motion = nextEffect(row.motion, listOf("static", "zoom_in", "zoom_out", "pan_left", "pan_right"))) } }, enabled = !busy) { Text("움직임: ${row.motion}") }
                TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(transition = nextEffect(row.transition, listOf("cut", "fade"))) } }, enabled = !busy) { Text("전환: ${row.transition}") }
                TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { it[index] = row.copy(subtitleStyle = nextEffect(row.subtitleStyle, listOf("default", "emphasis", "information"))) } }, enabled = !busy) { Text("자막 스타일: ${row.subtitleStyle}") }
                Row {
                    TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { val prior = it[index - 1]; it[index - 1] = it[index]; it[index] = prior } }, enabled = !busy && index > 0) { Text("위로") }
                    TextButton(onClick = { sceneRows = sceneRows.toMutableList().also { val next = it[index + 1]; it[index + 1] = it[index]; it[index] = next } }, enabled = !busy && index < sceneRows.lastIndex) { Text("아래로") }
                }
            }
            val validScenes = kotlin.math.abs(durationSum - board.optInt("target_seconds")) <= 0.01 && sceneRows.all { row ->
                (row.duration.toDoubleOrNull() ?: 0.0) >= 0.1 && (!row.mediaType.startsWith("video/") ||
                    (row.trimStart.toDoubleOrNull() ?: -1.0) in 0.0..3600.0 &&
                    (row.trimEnd.isBlank() || (row.trimEnd.toDoubleOrNull() ?: -1.0) <= 3600.0 &&
                        (row.trimEnd.toDoubleOrNull() ?: -1.0) - (row.trimStart.toDoubleOrNull() ?: 0.0) + 0.001 >= (row.duration.toDoubleOrNull() ?: 0.0))) }
            Button(onClick = { val rows = JSONArray(); sceneRows.forEach { row -> rows.put(JSONObject().put("media_id", row.mediaId).put("duration_seconds", row.duration.toDouble())
                .put("framing", row.framing).put("motion", row.motion).put("transition", row.transition).put("subtitle_style", row.subtitleStyle)
                .apply { if (row.mediaType.startsWith("video/")) { put("trim_start_seconds", row.trimStart.toDouble())
                    if (row.trimEnd.isNotBlank()) put("trim_end_seconds", row.trimEnd.toDouble()) } }) }; onSaveScenes(rows) },
                enabled = !busy && validScenes && sceneRows != initialScenes) { Text("장면 구성 저장") }
            Text("기획 확인: ${current?.optString("status") ?: "현재 승인 없음"}")
        }
        OutlinedTextField(requestText, { requestText = it }, label = { Text(if (plan == null) "기획 요청" else "기획 수정 요청") },
            modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 5)
        Button(onClick = { onSave(requestText) }, enabled = !busy && requestText.isNotBlank()) { Text(if (plan == null) "기획안 만들기" else "수정 기획안 만들기") }
        Text("수정 요청은 새 콘텐츠 버전을 만들고 기존 승인을 무효화합니다. 외부 AI 동의는 이 화면에서 보내지 않습니다.")
        if (plan != null && current?.optString("status") == "pending") {
            Button(onClick = { onApprove(current) }, enabled = !busy) { Text("이 버전 기획 중간 승인") }
        }
    }
}

private data class SceneEditRow(val mediaId: String, val mediaType: String, val duration: String, val trimStart: String, val trimEnd: String,
    val framing: String, val motion: String, val transition: String, val subtitleStyle: String)
private fun nextEffect(current: String, options: List<String>): String = options[(options.indexOf(current) + 1).mod(options.size)]

@Composable
fun DraftPanel(task: JSONObject, draft: JSONObject?, tracks: JSONArray, busy: Boolean,
               onSave: (DraftForm) -> Unit, onApprove: (JSONObject) -> Unit) {
    if (draft == null) {
        Section("자막·음악 확인") { Text("현재 버전의 기획안을 승인하면 자막 초안을 확인할 수 있습니다.") }
        return
    }
    val initial = remember(draft.optInt("content_version"), draft.optString("content_hash")) { DraftForm.from(draft) }
    var form by remember(draft.optInt("content_version"), draft.optString("content_hash")) { mutableStateOf(initial) }
    val current = draft.getJSONObject("checkpoint")
    Section("자막·음악 확인") {
        Text("콘텐츠 버전 ${draft.optInt("content_version")} · 초안 ${current.optString("status")}")
        Text("자막 초안은 직접 수정한 뒤 저장해 주세요. 저장하면 새 버전의 기획·초안을 다시 승인해야 합니다.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Checkbox(checked = form.captionsEnabled, onCheckedChange = { form = form.copy(captionsEnabled = it) })
            Text("자막을 영상에 합성", modifier = Modifier.padding(top = 12.dp))
        }
        form.captions.forEachIndexed { index, row ->
            Text("자막 ${index + 1}")
            OutlinedTextField(row.text, { text -> form = form.copy(captions = form.captions.toMutableList().also { it[index] = row.copy(text = text) }) },
                label = { Text("자막 문구") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(row.start, { start -> form = form.copy(captions = form.captions.toMutableList().also { it[index] = row.copy(start = start) }) },
                    label = { Text("시작 초") }, modifier = Modifier.weight(1f))
                OutlinedTextField(row.end, { end -> form = form.copy(captions = form.captions.toMutableList().also { it[index] = row.copy(end = end) }) },
                    label = { Text("끝 초") }, modifier = Modifier.weight(1f))
            }
            TextButton(onClick = { form = form.copy(captions = form.captions.filterIndexed { i, _ -> i != index }) }, enabled = !busy) { Text("이 자막 삭제") }
        }
        TextButton(onClick = { form = form.copy(captions = form.captions + CaptionRow("0", "3", "")) }, enabled = !busy && form.captions.size < 30) { Text("자막 추가") }
        Text("배경음악: 사용자가 PC 로컬 라이브러리에 등록한 음원만 선택할 수 있습니다.")
        FilterChip(selected = form.musicTrackId.isBlank(), onClick = { form = form.copy(musicTrackId = "") }, label = { Text("음악 없음") })
        tracks.objects().filter { it.optString("status") == "available" }.forEach { track ->
            FilterChip(selected = form.musicTrackId == track.optString("track_id"),
                onClick = { form = form.copy(musicTrackId = track.getString("track_id")) },
                label = { Text("${track.optString("title")} · ${track.optString("artist")}") })
            val rights = track.optJSONObject("rights")
            Text(if (rights?.optBoolean("explicitly_verified") == true && rights.optBoolean("commercial_allowed"))
                "사용자 권리 확인 기록 있음 · 플랫폼별 사용 범위는 최종 승인 시 서버가 검사합니다."
            else "권리 미확인: 비공개 미리보기만 가능합니다.")
        }
        if (tracks.length() == 0) Text("등록된 로컬 음원이 없습니다.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(form.sourceVolume, { form = form.copy(sourceVolume = it) }, label = { Text("원음 0~2") }, modifier = Modifier.weight(1f))
            OutlinedTextField(form.musicVolume, { form = form.copy(musicVolume = it) }, label = { Text("BGM 0~2") }, modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(form.fadeIn, { form = form.copy(fadeIn = it) }, label = { Text("페이드 인 초") }, modifier = Modifier.weight(1f))
            OutlinedTextField(form.fadeOut, { form = form.copy(fadeOut = it) }, label = { Text("페이드 아웃 초") }, modifier = Modifier.weight(1f))
        }
        Text("원본 영상 소리를 게시에 사용하려면 플랫폼별 권리 증빙이 필요합니다. 미확인인 경우 원음 음량을 0으로 설정해 주세요.")
        Button(onClick = { onSave(form) }, enabled = !busy && (form != initial || draft.optJSONObject("composition") == null)) { Text("자막·음악 구성 저장") }
        if (current.optString("status") == "pending") {
            Button(onClick = { onApprove(current) }, enabled = !busy && form == initial) { Text("이 버전 초안 중간 승인") }
            if (form != initial) Text("수정한 값을 저장해야 현재 초안을 승인할 수 있습니다.")
        }
    }
}

@Composable
fun RenderPanel(task: JSONObject, job: JSONObject?, checkpoints: JSONArray, preview: File?, busy: Boolean,
                onRender: () -> Unit, onRefresh: () -> Unit, onCancel: (JSONObject) -> Unit,
                onPreview: (JSONObject) -> Unit, onApprove: (JSONObject) -> Unit) {
    val current = checkpoint(checkpoints, "preview", task)
    val verified = job != null && CreatorGates.verifiedPreview(task.optInt("current_version"), task.optString("content_hash"),
        job.optInt("content_version"), job.optString("content_hash"), job.optString("status"), job.optString("renderer_mode"), job.optBoolean("artifact_verified"))
    Section("렌더·미리보기") {
        Text("공통 영상 규격: 9:16 · 1080×1920 · 30fps · H.264/AAC · 3~59초")
        Text("현재 작업: ${task.optString("status")}")
        Button(onClick = onRender, enabled = !busy && task.optString("status") == "render_ready") { Text("현재 버전 렌더 요청") }
        if (job != null) {
            Text("렌더 상태: ${job.optString("status")} · ${job.optInt("progress_percent")}%")
            if (job.optString("safe_error_code").isNotEmpty()) Text("오류 코드: ${job.optString("safe_error_code")}")
            Text("렌더러: ${job.optString("renderer_mode", "확인 중")} · 검증: ${if (verified) "실제 FFmpeg MP4" else "미검증"}")
            OutlinedButton(onClick = onRefresh, enabled = !busy) { Text("상태 새로고침") }
            if (job.optString("status") in listOf("queued", "running")) {
                OutlinedButton(onClick = { onCancel(job) }, enabled = !busy) { Text("렌더 취소") }
            }
            if (verified) Button(onClick = { onPreview(job) }, enabled = !busy) { Text("인증된 MP4 불러오기") }
        }
        if (preview != null && verified) {
            key(preview.absolutePath) {
                AndroidView(factory = { context -> VideoView(context).apply {
                    setMediaController(MediaController(context))
                    setVideoPath(preview.absolutePath)
                    start()
                } }, modifier = Modifier.fillMaxWidth().height(360.dp))
            }
            Text("현재 영상 버전 ${task.optInt("current_version")} · 미리보기 확인 ${current?.optString("status") ?: "대기"}")
            if (current?.optString("status") == "pending") {
                Button(onClick = { onApprove(current) }, enabled = !busy) { Text("이 영상 미리보기 중간 승인") }
            }
        } else if (job?.optString("status") == "simulated") Text("테스트 렌더는 실제 MP4가 아니므로 재생·최종 승인에 사용할 수 없습니다.")
    }
}

@Composable
fun PublicationPanel(task: JSONObject, job: JSONObject?, checkpoints: JSONArray, records: JSONArray, busy: Boolean,
                     onSave: (JSONObject?, PublicationForm, String) -> Unit, onApprove: (JSONObject) -> Unit) {
    val previewApproved = checkpoint(checkpoints, "preview", task)?.optString("status") == "approved"
    val verified = job != null && CreatorGates.verifiedPreview(task.optInt("current_version"), task.optString("content_hash"),
        job.optInt("content_version"), job.optString("content_hash"), job.optString("status"), job.optString("renderer_mode"), job.optBoolean("artifact_verified"))
    Section("플랫폼별 게시 정보") {
        Text("제목·설명·해시태그·계정·공개범위를 플랫폼마다 별도로 저장합니다. 최종 승인은 실제 SNS 게시를 실행하지 않습니다.")
        Text("현재 영상 버전 ${task.optInt("current_version")} · 영상 확인 ${if (verified && previewApproved) "완료" else "대기"}")
        listOf("youtube" to "YouTube Shorts", "tiktok" to "TikTok", "instagram" to "Instagram Reels").forEach { (platform, title) ->
            PublicationCard(platform, title, task, job, records.objects().find { it.optString("platform") == platform },
                verified && previewApproved && task.optString("status") == "preview_approved", busy,
                onSave = onSave, onApprove = onApprove)
        }
    }
}

@Composable
private fun PublicationCard(platform: String, label: String, task: JSONObject, job: JSONObject?, record: JSONObject?, canApprove: Boolean,
                            busy: Boolean, onSave: (JSONObject?, PublicationForm, String) -> Unit, onApprove: (JSONObject) -> Unit) {
    val original = remember(record?.optInt("revision"), record?.optString("metadata_hash")) { PublicationForm.from(record) }
    var form by remember(record?.optInt("revision"), record?.optString("metadata_hash")) { mutableStateOf(original) }
    var confirmed by remember(record?.optInt("revision"), task.optInt("current_version")) { mutableStateOf(false) }
    val dirty = form != original
    ElevatedCard(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            Text("상태: ${if (record?.optString("status") == "publish_ready") "이 플랫폼만 최종 승인 준비" else "최종 승인 없음 또는 무효화"}")
            if (record != null) Text("게시 정보 수정 번호 ${record.optInt("revision")}")
            OutlinedTextField(form.accountId, { form = form.copy(accountId = it) }, label = { Text("대상 게시 계정 ID") }, modifier = Modifier.fillMaxWidth())
            Text("공개범위")
            listOf(listOf("private", "unlisted"), listOf("public", "followers")).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { row.forEach { visibility ->
                    FilterChip(selected = form.visibility == visibility, onClick = { form = form.copy(visibility = visibility) }, label = { Text(visibility) })
                } }
            }
            OutlinedTextField(form.title, { form = form.copy(title = it) }, label = { Text("제목") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(form.description, { form = form.copy(description = it) }, label = { Text("설명·권리 표시") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            OutlinedTextField(form.hashtags, { form = form.copy(hashtags = it) }, label = { Text("해시태그, 공백 또는 쉼표로 구분") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { onSave(record, form, platform) }, enabled = !busy && (record == null || dirty)) { Text(if (record == null) "이 플랫폼 정보 만들기" else "이 플랫폼 정보 저장") }
            if (record != null) {
                Text("최종 승인 대상: 영상 v${task.optInt("current_version")}, $label, 계정 ${record.optString("account_id")}, 공개범위 ${record.optString("visibility")}")
                Text("영상 SHA-256: ${job?.optString("artifact_sha256") ?: "렌더 대기"}")
                Row {
                    Checkbox(checked = confirmed, onCheckedChange = { confirmed = it }, enabled = canApprove && !dirty && record.optString("status") != "publish_ready")
                    Text("이 영상 버전과 게시 대상·문구를 확인했습니다.", modifier = Modifier.padding(top = 12.dp))
                }
                Button(onClick = { onApprove(record) }, enabled = !busy && canApprove && !dirty && confirmed && record.optString("status") != "publish_ready") {
                    Text("$label 최종 승인")
                }
                if (dirty) Text("수정한 게시 정보를 저장해야 최종 승인할 수 있습니다.")
                if (!canApprove) Text("실제 MP4와 현재 버전의 미리보기 승인이 필요합니다.")
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        content()
    }
}
