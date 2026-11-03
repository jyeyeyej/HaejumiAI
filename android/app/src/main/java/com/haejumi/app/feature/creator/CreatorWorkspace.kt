package com.haejumi.app.feature.creator

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.haejumi.app.core.SecureSettings
import com.haejumi.app.data.ApiException
import com.haejumi.app.data.BackendClient
import com.haejumi.app.data.CreatorApi
import com.haejumi.app.data.CreatorSnapshot
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

@Composable
fun CreatorWorkspace(client: BackendClient, settings: SecureSettings, taskId: String, modifier: Modifier = Modifier, onBack: () -> Unit) {
    val api = remember(client) { CreatorApi(client) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var snapshot by remember(taskId) { mutableStateOf<CreatorSnapshot?>(null) }
    var tab by remember(taskId) { mutableStateOf("plan") }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("현재 작업을 읽고 있습니다.") }
    var previewFile by remember(taskId) { mutableStateOf<File?>(null) }
    var previewHash by remember(taskId) { mutableStateOf("") }

    suspend fun refresh() {
        snapshot = api.snapshot(taskId, settings.lastJob)
        val current = snapshot?.task?.optString("content_hash") ?: ""
        if (previewHash != current) { previewFile = null; previewHash = "" }
    }
    fun issue(error: Exception) = when (error) {
        is ApiException -> when (error.status) {
            401 -> "인증이 필요합니다. PC 연결 토큰을 확인해 주세요."
            403 -> if (error.code == "RIGHTS_REVIEW_REQUIRED") "음원 또는 원본 오디오의 권리 증빙을 확인해 주세요." else "요청 권한이나 권리 조건이 충족되지 않았습니다."
            404 -> "작업을 찾을 수 없습니다. 소유권과 연결을 확인해 주세요."
            409 -> "버전 또는 승인 상태가 바뀌었습니다. 현재 작업을 다시 읽어 주세요. (${error.code ?: "충돌"})"
            else -> "요청에 실패했습니다. (HTTP ${error.status})"
        }
        is IllegalArgumentException -> error.message ?: "입력 내용을 확인해 주세요."
        else -> "PC 서버 연결이나 응답을 확인해 주세요."
    }
    fun action(success: String, operation: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try { operation(); refresh(); notice = success }
            catch (error: Exception) {
                notice = issue(error)
                if (error is ApiException && error.status == 409) runCatching { refresh() }
            } finally { busy = false }
        }
    }
    LaunchedEffect(taskId) {
        try { refresh(); notice = "현재 작업을 불러왔습니다." }
        catch (error: Exception) { notice = issue(error) }
    }
    val currentJob = snapshot?.job
    val jobStatus = currentJob?.optString("status")
    LaunchedEffect(taskId, currentJob?.optString("job_id"), jobStatus) {
        if (jobStatus == "queued" || jobStatus == "running") {
            while (true) {
                delay(2000)
                try {
                    val updated = api.job(currentJob.getString("job_id"))
                    snapshot = snapshot?.copy(job = updated)
                    if (updated.optString("status") !in listOf("queued", "running")) { refresh(); break }
                } catch (error: Exception) { notice = issue(error); break }
            }
        }
    }
    val data = snapshot
    Column(modifier) {
        TextButton(onClick = onBack, enabled = !busy) { Text("파일 선택으로 돌아가기") }
        Text("Creator 작업", style = MaterialTheme.typography.titleLarge)
        Text(notice)
        if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { action("현재 작업을 다시 읽었습니다.") {} }, enabled = !busy) { Text("최신 상태 확인") }
        if (data == null) return@Column
        Text("상태: ${data.task.optString("status")} · 버전 ${data.task.optInt("current_version")}")
        Text("이전 버전의 중간·최종 승인은 편집 후 무효화됩니다.")
        val items = listOf("plan" to "기획", "draft" to "자막·음악", "render" to "렌더·미리보기", "publish" to "게시 정보")
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            items.forEachIndexed { index, item ->
                SegmentedButton(shape = SegmentedButtonDefaults.itemShape(index, items.size), onClick = { tab = item.first },
                    selected = tab == item.first) { Text(item.second, maxLines = 1) }
            }
        }
        when (tab) {
            "plan" -> PlanPanel(data.task, data.plan, data.checkpoints, busy,
                onSave = { text -> action("새 버전의 기획안을 만들었습니다. 내용을 확인해 주세요.") {
                    api.createOrRevisePlan(taskId, data.task.getInt("current_version"), text)
                } },
                onSaveScenes = { scenes -> action("장면 순서와 길이를 저장했습니다. 새 버전의 기획을 다시 승인해 주세요.") {
                    api.updateScenes(taskId, data.task.getInt("current_version"), data.task.getString("content_hash"), scenes)
                } },
                onApprove = { checkpoint -> action("기획 중간 승인을 기록했습니다.") {
                    requireCurrent(data.task, checkpoint); api.approve(taskId, checkpoint)
                } })
            "draft" -> DraftPanel(data.task, data.draft, data.tracks, busy,
                onSave = { form -> action("자막·음악을 저장했습니다. 새 버전의 기획과 초안을 다시 승인해 주세요.") {
                    api.updateDraft(taskId, form.request(data.task.getInt("current_version"), data.task.getString("content_hash")))
                } },
                onApprove = { checkpoint -> action("초안 중간 승인을 기록했습니다.") {
                    requireCurrent(data.task, checkpoint); api.approve(taskId, checkpoint)
                } })
            "render" -> RenderPanel(data.task, currentJob, data.checkpoints, previewFile?.takeIf { previewHash == data.task.optString("content_hash") }, busy,
                onRender = { action("렌더 작업을 요청했습니다.") {
                    val job = api.render(taskId, data.task.getInt("current_version"), data.task.getString("content_hash"))
                    settings.lastJob = job.getString("job_id")
                } },
                onRefresh = { action("렌더 상태를 다시 읽었습니다.") {} },
                onCancel = { job -> action("렌더 취소를 요청했습니다.") { api.cancelJob(job.getString("job_id")) } },
                onPreview = { job -> action("인증된 MP4를 확인했습니다.") {
                    requireVerified(data.task, job)
                    previewFile = api.preview(context, taskId, data.task.getInt("current_version"), job.getString("artifact_sha256"))
                    previewHash = data.task.getString("content_hash")
                } },
                onApprove = { checkpoint -> action("미리보기 중간 승인을 기록했습니다.") {
                    requireCurrent(data.task, checkpoint)
                    require(previewFile != null && previewHash == data.task.getString("content_hash")) { "현재 미리보기를 먼저 확인해 주세요." }
                    api.approve(taskId, checkpoint)
                } })
            else -> PublicationPanel(data.task, currentJob, data.checkpoints, data.publications, busy,
                onSave = { existing, form, platform -> action("플랫폼 게시 정보를 저장했습니다. 해당 승인 상태를 다시 확인해 주세요.") {
                    api.savePublication(taskId, existing, form.request(platform))
                } },
                onApprove = { publication -> action("이 플랫폼의 최종 승인만 기록했습니다. SNS 게시는 실행되지 않았습니다.") {
                    val job = currentJob ?: error("현재 영상의 렌더 결과가 없습니다.")
                    api.approvePublication(taskId, publication, data.task, job)
                } })
        }
    }
}

private fun requireCurrent(task: JSONObject, checkpoint: JSONObject) {
    require(checkpoint.optString("status") == "pending" && CreatorGates.current(task.getInt("current_version"), task.getString("content_hash"),
        checkpoint.getInt("content_version"), checkpoint.getString("content_hash"))) { "승인 대상 버전이 현재 버전과 다릅니다." }
}

private fun requireVerified(task: JSONObject, job: JSONObject) {
    require(CreatorGates.verifiedPreview(task.getInt("current_version"), task.getString("content_hash"),
        job.getInt("content_version"), job.getString("content_hash"), job.getString("status"),
        job.optString("renderer_mode"), job.optBoolean("artifact_verified"))) { "현재 버전의 실제 FFmpeg 영상이 없습니다." }
}
