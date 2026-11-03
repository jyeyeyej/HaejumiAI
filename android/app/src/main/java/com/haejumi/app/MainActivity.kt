package com.haejumi.app

import android.os.Bundle
import android.os.Build
import android.util.Size
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.Image
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.haejumi.app.core.SecureSettings
import com.haejumi.app.data.ApiException
import com.haejumi.app.data.BackendClient
import com.haejumi.app.data.UploadAttempt
import com.haejumi.app.feature.creator.CreatorWorkspace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = SecureSettings(applicationContext)
        val client = BackendClient(settings, contentResolver)
        setContent { MaterialTheme { HaejumiHome(settings, client) } }
    }
}

@Composable
private fun HaejumiHome(settings: SecureSettings, client: BackendClient) {
    val scope = rememberCoroutineScope()
    DisposableEffect(client) { onDispose { client.cancel() } }
    var page by remember { mutableStateOf("home") }
    var address by remember { mutableStateOf(settings.address) }
    var token by remember { mutableStateOf("") }
    var connection by remember { mutableStateOf("연결을 확인하지 않았습니다.") }
    var message by remember { mutableStateOf("") }
    var reply by remember { mutableStateOf("안녕하세요. 예투입니다. 무엇을 도와드릴까요?") }
    val attempts = remember { mutableStateListOf<UploadAttempt>() }
    val uploadedIds = remember { mutableStateMapOf<String, String>() }
    var failedItemId by remember { mutableStateOf<String?>(null) }
    var uploadState by remember { mutableStateOf("사진이나 영상을 선택해 주세요.") }
    var progress by remember { mutableFloatStateOf(0f) }
    val maxSelectedMedia = BuildConfig.MAX_SELECTED_MEDIA
    var taskId by remember { mutableStateOf(settings.lastTask) }
    var taskStatus by remember { mutableStateOf("상태를 확인하지 않았습니다.") }
    var projectKey by remember { mutableStateOf(UUID.randomUUID().toString()) }
    var running by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    fun errorText(error: Throwable): String = when (error) {
        is ApiException -> when (error.status) {
            401 -> "인증에 실패했습니다. 토큰을 확인해 주세요."
            413 -> "서버에서 허용하는 파일 크기를 초과했습니다."
            415, 422 -> "서버에서 파일이나 요청 형식을 허용하지 않았습니다."
            409 -> "요청 상태가 변경되었습니다. 다시 확인해 주세요."
            else -> "서버 요청에 실패했습니다. (HTTP ${error.status})"
        }
        is IllegalArgumentException -> error.message ?: "입력 내용을 확인해 주세요."
        else -> "서버에 연결할 수 없습니다. PC 상태와 안전한 연결 경로를 확인해 주세요."
    }
    fun launchAction(action: suspend () -> Unit) {
        if (running) return
        running = true
        job = scope.launch {
            try { action() } catch (_: CancellationException) { uploadState = "업로드를 취소했습니다. 같은 파일로 다시 시도할 수 있습니다." }
            catch (error: Exception) { val text = errorText(error); if (page == "creator") uploadState = text else connection = text }
            finally { running = false }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxSelectedMedia)) { uris ->
        try {
            require(attempts.size + uris.size <= maxSelectedMedia) { "최대 ${maxSelectedMedia}개까지 선택할 수 있습니다." }
            val selected = uris.map { UploadAttempt(client.select(it)) }
            attempts.addAll(selected); progress = 0f; projectKey = UUID.randomUUID().toString()
            uploadState = "선택한 파일과 순서를 확인한 뒤 업로드해 주세요."
        } catch (error: Exception) { uploadState = errorText(error) }
    }
    Scaffold { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("해주미", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            when (page) {
                "settings" -> {
                    Text("PC 연결 설정", style = MaterialTheme.typography.titleLarge)
                    Text("PC의 안전한 HTTPS 주소와 인증 토큰을 입력해 주세요. PC 서버는 직접 연결할 수 없으므로 신뢰할 수 있는 암호화 경로를 먼저 준비해 주세요.")
                    OutlinedTextField(address, { address = it }, label = { Text("사설 HTTPS 주소") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(token, { token = it }, label = { Text("인증 토큰") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        try { settings.save(address, token); token = ""; connection = "설정이 저장되었습니다. 연결을 확인해 주세요." }
                        catch (_: Exception) { connection = "사설 HTTPS 주소와 인증 토큰을 확인해 주세요." }
                    }, enabled = !running) { Text("안전하게 저장") }
                    OutlinedButton(onClick = { launchAction { client.check(); connection = "인증된 PC 서버에 연결되었습니다." } }, enabled = !running) { Text("연결 확인") }
                    Text(connection)
                    TextButton(onClick = { page = "home" }, enabled = !running) { Text("홈으로") }
                }
                "workspace" -> {
                    val current = taskId
                    if (current == null) { Text("제작 작업을 먼저 선택해 주세요.") }
                    else CreatorWorkspace(client, settings, current, Modifier.fillMaxWidth()) { page = "creator" }
                }
                "creator" -> {
                    Text("쇼츠 만들기", style = MaterialTheme.typography.titleLarge)
                    Text("직접 선택한 사진과 영상만 PC로 보냅니다. 최대 ${maxSelectedMedia}개입니다.")
                    OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }, enabled = !running) { Text("사진 또는 영상 선택") }
                    attempts.forEachIndexed { index, item ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            SelectedThumbnail(item.media.uri, item.media.type)
                            Text("${item.media.name} · ${if (item.media.type.startsWith("image/")) "사진" else "영상"} · ${item.media.size / 1024} KiB · ${if (uploadedIds.containsKey(item.itemId)) "완료" else if (failedItemId == item.itemId) "실패 · 재시도 가능" else "대기"}")
                        }
                        Row {
                            TextButton(onClick = { val previous = attempts[index - 1]; attempts[index - 1] = attempts[index]; attempts[index] = previous; projectKey = UUID.randomUUID().toString() }, enabled = !running && index > 0) { Text("위로") }
                            TextButton(onClick = { val next = attempts[index + 1]; attempts[index + 1] = attempts[index]; attempts[index] = next; projectKey = UUID.randomUUID().toString() }, enabled = !running && index < attempts.lastIndex) { Text("아래로") }
                            TextButton(onClick = { uploadedIds.remove(item.itemId); attempts.remove(item); projectKey = UUID.randomUUID().toString() }, enabled = !running) { Text("제외") }
                        }
                    }
                    TextButton(onClick = { attempts.clear(); uploadedIds.clear(); projectKey = UUID.randomUUID().toString() }, enabled = !running && attempts.isNotEmpty()) { Text("전체 선택 취소") }
                    Text(uploadState)
                    if (running) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                    Button(onClick = {
                        if (attempts.isEmpty()) return@Button
                        launchAction {
                            for (selected in attempts.toList()) {
                                if (uploadedIds.containsKey(selected.itemId)) continue
                                uploadState = "${selected.media.name} 업로드 중"
                                try { uploadedIds[selected.itemId] = client.upload(selected) { progress = it }; failedItemId = null }
                                catch (error: Exception) { failedItemId = selected.itemId; throw error }
                            }
                            uploadState = "업로드가 완료되었습니다. 예투: 선택하신 파일로 쇼츠를 만들어 드릴까요?"
                        }
                    }, enabled = attempts.isNotEmpty() && attempts.any { !uploadedIds.containsKey(it.itemId) } && !running) { Text(if (progress > 0f) "업로드 다시 시도" else "확인 후 업로드") }
                    if (running) TextButton(onClick = { client.cancel(); job?.cancel() }) { Text("취소") }
                    if (attempts.isNotEmpty() && attempts.all { uploadedIds.containsKey(it.itemId) }) Button(onClick = {
                        launchAction { taskId = client.createProject(attempts.map { uploadedIds.getValue(it.itemId) }, projectKey); settings.lastTask = taskId; taskStatus = "프로젝트 생성됨"; uploadState = "제작 프로젝트를 만들었습니다. 기획안을 확인해 주세요."; page = "workspace" }
                    }, enabled = !running) { Text("쇼츠 제작 시작") }
                    if (taskId != null) OutlinedButton(onClick = { page = "workspace" }, enabled = !running) { Text("최근 Creator 작업 열기") }
                    Text("실제 SNS 게시 기능은 연결되어 있지 않습니다.")
                    TextButton(onClick = { page = "home" }, enabled = !running) { Text("홈으로") }
                }
                else -> {
                    Text(reply, style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(message, { message = it }, label = { Text("예투에게 무엇을 부탁할까요?") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { val text = message.trim(); if (text.isNotEmpty()) launchAction { reply = client.message(text); message = "" } }, enabled = !running && message.isNotBlank()) { Text("보내기") }
                        OutlinedButton(onClick = {}, enabled = false) { Text("음성 입력 준비 중") }
                    }
                    AgentCard("쇼츠 만들기", "Creator", true) { page = "creator" }
                    AgentCard("일정 관리", "Schedule · 준비 중", false) {}
                    AgentCard("생활·건강 관리", "Wellness · 준비 중", false) {}
                    AgentCard("일기 작성", "Diary · 준비 중", false) {}
                    Text("최근 작업", style = MaterialTheme.typography.titleMedium)
                    Text(if (taskId == null) "기록된 제작 작업이 없습니다." else "최근 제작 작업: $taskStatus")
                    if (taskId != null) TextButton(onClick = { launchAction { taskStatus = client.taskStatus(taskId!!) } }, enabled = !running) { Text("작업 상태 확인") }
                    if (taskId != null) OutlinedButton(onClick = { page = "workspace" }, enabled = !running) { Text("최근 Creator 작업 열기") }
                    Text("PC 서버: $connection")
                    OutlinedButton(onClick = { page = "settings" }, enabled = !running) { Text("PC 연결 설정") }
                }
            }
        }
    }
}

@Composable
private fun AgentCard(title: String, subtitle: String, enabled: Boolean, onClick: () -> Unit) {
    ElevatedCard(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); Text(subtitle) }
    }
}

@Composable
private fun SelectedThumbnail(uri: Uri, type: String) {
    val context = LocalContext.current
    val thumbnail by produceState<Bitmap?>(null, uri) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                if (Build.VERSION.SDK_INT >= 29) context.contentResolver.loadThumbnail(uri, Size(80, 80), null)
                else if (type.startsWith("image/")) context.contentResolver.openInputStream(uri)?.use {
                    BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 8 })
                }
                else MediaMetadataRetriever().use { retriever -> retriever.setDataSource(context, uri); retriever.getFrameAtTime(0) }
            }.getOrNull()
        }
    }
    if (thumbnail != null) Image(bitmap = thumbnail!!.asImageBitmap(), contentDescription = "선택한 미디어 썸네일",
        modifier = Modifier.size(52.dp), contentScale = ContentScale.Crop)
    else Text(if (type.startsWith("image/")) "사진" else "영상")
}
