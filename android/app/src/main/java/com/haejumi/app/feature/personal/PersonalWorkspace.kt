package com.haejumi.app.feature.personal

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.haejumi.app.data.BackendClient
import com.haejumi.app.data.PersonalApi
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

@Composable
fun PersonalWorkspace(client: BackendClient, kind: String, onBack: () -> Unit) {
    val api = remember(client) { PersonalApi(client) }
    val scope = rememberCoroutineScope()
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var title by remember { mutableStateOf("") }
    var start by remember { mutableStateOf("") }
    var end by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var mood by remember { mutableStateOf("neutral") }
    var sleepHours by remember { mutableStateOf("") }
    var activityMinutes by remember { mutableStateOf("") }
    var items by remember { mutableStateOf(JSONArray()) }
    var saved by remember { mutableStateOf(JSONArray()) }
    var occurrences by remember { mutableStateOf(JSONArray()) }
    var recurrence by remember { mutableStateOf("none") }
    var recurrenceUntil by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var editText by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<JSONObject?>(null) }
    var notice by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    fun refresh() { scope.launch { busy = true; try { items = api.list(kind, date).getJSONArray("items")
        if (kind == "diary") saved = api.savedDiaries(date).getJSONArray("items")
        if (kind == "schedule") occurrences = api.occurrences(date).getJSONArray("items")
        notice = "서버 기록을 불러왔습니다." }
        catch (_: Exception) { notice = "기록을 불러오지 못했습니다. 연결과 인증을 확인해 주세요." } finally { busy = false } } }
    LaunchedEffect(kind, date) { try { items = api.list(kind, date).getJSONArray("items")
        if (kind == "diary") saved = api.savedDiaries(date).getJSONArray("items")
        if (kind == "schedule") occurrences = api.occurrences(date).getJSONArray("items")
    } catch (_: Exception) { notice = "기록을 불러오지 못했습니다." } }
    Text(when (kind) { "schedule" -> "일정 관리"; "wellness" -> "생활 기록"; else -> "일기" }, style = MaterialTheme.typography.titleLarge)
    Text("PC 서버의 같은 데이터를 사용합니다. 충돌 시 다시 조회해 주세요.")
    OutlinedTextField(date, { date = it }, label = { Text("날짜 YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
    if (kind == "schedule") {
        OutlinedTextField(title, { title = it }, label = { Text("일정 제목") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(start, { start = it }, label = { Text("시작 YYYY-MM-DDTHH:MM") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(end, { end = it }, label = { Text("종료 YYYY-MM-DDTHH:MM") }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("none", "daily", "weekly", "monthly").forEach { value -> FilterChip(selected = recurrence == value, onClick = { recurrence = value }, label = { Text(value) }) }
        }
        if (recurrence != "none") OutlinedTextField(recurrenceUntil, { recurrenceUntil = it }, label = { Text("반복 종료일 YYYY-MM-DD") })
        Text("반복 발생일을 조회합니다. 알림은 실행하지 않습니다.")
    }
    if (kind == "wellness") {
        Text("기분")
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("low", "neutral", "good").forEach { value -> FilterChip(selected = mood == value, onClick = { mood = value }, label = { Text(value) }) }
        }
        OutlinedTextField(sleepHours, { sleepHours = it }, label = { Text("수면 시간") })
        OutlinedTextField(activityMinutes, { activityMinutes = it }, label = { Text("활동 시간(분)") })
        Text("생활 기록이며 의료 진단이나 치료 권고가 아닙니다.")
    }
    if (kind != "schedule") OutlinedTextField(note, { note = it }, label = { Text(if (kind == "diary") "직접 적은 내용" else "메모") }, modifier = Modifier.fillMaxWidth())
    if (kind == "diary") Text("현재 Android 초안은 사용자가 입력한 내용만 포함합니다. 다른 기록을 포함하려면 PC 웹에서 명시적으로 선택해 주세요.")
    Button(onClick = { scope.launch {
        busy = true
        try {
            val body = when (kind) {
                "schedule" -> JSONObject().put("title", title).put("start_at", OffsetDateTime.of(java.time.LocalDateTime.parse(start), ZoneId.systemDefault().rules.getOffset(java.time.Instant.now())).toString())
                    .put("end_at", OffsetDateTime.of(java.time.LocalDateTime.parse(end), ZoneId.systemDefault().rules.getOffset(java.time.Instant.now())).toString())
                    .apply { if (recurrence != "none") put("recurrence", JSONObject().put("frequency", recurrence).put("interval", 1).put("until", recurrenceUntil)) }
                "wellness" -> JSONObject().put("date", date).put("mood", mood).put("note", note)
                    .apply { if (sleepHours.isNotBlank()) put("sleep_hours", sleepHours.toDouble())
                        if (activityMinutes.isNotBlank()) put("activity_minutes", activityMinutes.toInt()) }
                else -> JSONObject().put("date", date).put("allowed_source_ids", JSONArray()).put("user_notes", note)
            }
            api.create(kind, body); items = api.list(kind, date).getJSONArray("items"); notice = if (kind == "diary") "초안만 생성했습니다. 정식 저장에는 별도 승인이 필요합니다." else "서버에 저장했습니다."
        } catch (_: Exception) { notice = "저장하지 못했습니다. 입력과 연결을 확인해 주세요." } finally { busy = false }
    } }, enabled = !busy) { Text(if (kind == "diary") "초안 생성" else "기록 저장") }
    OutlinedButton(onClick = { refresh() }, enabled = !busy) { Text("다시 조회") }
    for (index in 0 until items.length()) {
        val item = items.getJSONObject(index)
        ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
            Text(item.optString("title", item.optString("body", item.optString("mood", "기록"))))
            Text("버전 ${item.optInt("content_version", item.optInt("version"))} · ${item.optString("status")}")
            if (item.optString("status") != "finalized") TextButton(onClick = {
                editing = item; editText = if (kind == "schedule") item.optString("title") else if (kind == "wellness") item.optString("note") else item.optString("body")
            }) { Text("수정") }
            if (kind != "diary") TextButton(onClick = { deleting = item }) { Text("삭제") }
            if (kind == "diary" && item.optString("status") != "finalized") {
                TextButton(onClick = { scope.launch { try { api.approve(item.getString("draft_id"), item.getInt("content_version"), item.getString("content_hash"), "continue"); notice = "중간 승인했습니다." }
                    catch (_: Exception) { notice = "중간 승인에 실패했습니다." } } }) { Text("중간 승인") }
                Button(onClick = { scope.launch { try { val approval = api.approve(item.getString("draft_id"), item.getInt("content_version"), item.getString("content_hash"), "final_diary")
                    api.finalize(item.getString("draft_id"), item.getInt("content_version"), item.getString("content_hash"), approval.getString("approval_id")); refresh(); notice = "정식 저장했습니다." }
                    catch (_: Exception) { notice = "최종 승인이 필요하거나 버전이 변경됐습니다. 다시 조회해 주세요." } } }) { Text("최종 승인 및 저장") }
            }
        } }
    }
    if (kind == "schedule") {
        Text("선택한 날짜의 발생 일정", style = MaterialTheme.typography.titleMedium)
        for (index in 0 until occurrences.length()) {
            val occurrence = occurrences.getJSONObject(index)
            Text("${occurrence.optString("title")} · ${occurrence.optString("start_at")}")
        }
    }
    if (kind == "diary") {
        Text("정식 저장된 일기", style = MaterialTheme.typography.titleMedium)
        for (index in 0 until saved.length()) {
            val entry = saved.getJSONObject(index)
            ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                Text(entry.optString("body")); Text("버전 ${entry.optInt("version")}")
                TextButton(onClick = { editing = entry; editText = entry.optString("body") }) { Text("수정 초안 만들기") }
                TextButton(onClick = { deleting = entry }) { Text("삭제") }
            } }
        }
    }
    editing?.let { item -> AlertDialog(onDismissRequest = { editing = null }, title = { Text("수정 확인") },
        text = { OutlinedTextField(editText, { editText = it }, label = { Text("수정 내용") }) },
        confirmButton = { TextButton(onClick = { scope.launch {
            busy = true
            try {
                if (kind == "diary" && item.has("entry_id")) {
                    val draft = api.beginDiaryRevision(item.getString("entry_id"), item.getInt("version"))
                    api.edit("diary", draft.getString("draft_id"), JSONObject().put("base_content_version", draft.getInt("content_version")).put("feedback", editText))
                    notice = "저장본 수정 초안을 만들었습니다. 중간·최종 승인을 다시 진행해 주세요."
                } else {
                    val id = item.optString("event_id", item.optString("entry_id", item.optString("draft_id")))
                    val body = when (kind) {
                        "schedule" -> JSONObject().put("version", item.getInt("version")).put("title", editText)
                        "wellness" -> JSONObject().put("version", item.getInt("version")).put("note", editText)
                        else -> JSONObject().put("base_content_version", item.getInt("content_version")).put("feedback", editText)
                    }
                    api.edit(kind, id, body); notice = "수정했습니다. 이전 일기 승인은 무효화됩니다."
                }
                editing = null; refresh()
            } catch (_: Exception) { notice = "수정하지 못했습니다. 버전 또는 입력을 확인해 주세요." } finally { busy = false }
        } }, enabled = !busy && editText.isNotBlank()) { Text("저장") } },
        dismissButton = { TextButton(onClick = { editing = null }) { Text("취소") } }) }
    deleting?.let { item -> AlertDialog(onDismissRequest = { deleting = null }, title = { Text("기록 삭제") },
        text = { Text("이 기록을 삭제하시겠습니까?") },
        confirmButton = { TextButton(onClick = { scope.launch {
            busy = true
            try {
                val savedDiary = kind == "diary" && item.has("entry_id")
                val id = item.optString("event_id", item.optString("entry_id"))
                api.delete(if (savedDiary) "saved_diary" else kind, id, item.getInt("version"))
                deleting = null; refresh(); notice = "삭제했습니다."
            } catch (_: Exception) { notice = "삭제하지 못했습니다. 최신 상태를 다시 조회해 주세요." } finally { busy = false }
        } }, enabled = !busy) { Text("삭제") } }, dismissButton = { TextButton(onClick = { deleting = null }) { Text("취소") } }) }
    if (notice.isNotBlank()) Text(notice)
    TextButton(onClick = onBack) { Text("홈으로") }
}
