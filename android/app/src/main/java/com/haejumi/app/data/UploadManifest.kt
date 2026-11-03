package com.haejumi.app.data

import java.security.MessageDigest

object UploadManifest {
    fun hash(itemId: String, sha256: String, size: Long): String {
        require(Regex("^[0-9a-f-]{36}$").matches(itemId) && Regex("^[0-9a-f]{64}$").matches(sha256) && size > 0)
        val json = "[{\"client_item_id\":\"$itemId\",\"sha256\":\"$sha256\",\"size_bytes\":$size}]"
        return MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
