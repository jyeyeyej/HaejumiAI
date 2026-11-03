package com.haejumi.app.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class SecureSettings(context: Context) {
    private val prefs = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val alias = "haejumi.connection.v1"
    val address: String get() = prefs.getString("address", "") ?: ""
    var lastTask: String?
        get() = prefs.getString("last_task", null)
        set(value) { prefs.edit().putString("last_task", value).apply() }
    var lastJob: String?
        get() = prefs.getString("last_job", null)
        set(value) { prefs.edit().putString("last_job", value).apply() }

    fun save(address: String, token: String) {
        require(validAddress(address) && token.isNotBlank() && !token.contains('\n') && !token.contains('\r'))
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey(alias, null) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString("address", address.trim().trimEnd('/'))
            .putString("token", Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)).apply()
    }

    fun token(): String? { return try {
        val bytes = Base64.decode(prefs.getString("token", null) ?: return null, Base64.NO_WRAP)
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    } catch (_: Exception) { null } }

    companion object {
        fun validAddress(value: String): Boolean { return try {
            val uri = URI(value.trim())
            val host = uri.host?.lowercase() ?: return false
            val octets = host.split('.').mapNotNull { it.toIntOrNull() }
            val privateIp = octets.size == 4 && host == octets.joinToString(".") && octets.all { it in 0..255 } &&
                (octets[0] == 10 || (octets[0] == 172 && octets[1] in 16..31) ||
                    (octets[0] == 192 && octets[1] == 168) || (octets[0] == 100 && octets[1] in 64..127))
            val tailnet = host.endsWith(".ts.net") && host.length > ".ts.net".length
            uri.scheme == "https" && uri.userInfo == null && uri.query == null && uri.fragment == null &&
                (uri.path.isNullOrEmpty() || uri.path == "/") && uri.port in -1..65535 && (privateIp || tailnet)
        } catch (_: Exception) { false } }
    }
}
