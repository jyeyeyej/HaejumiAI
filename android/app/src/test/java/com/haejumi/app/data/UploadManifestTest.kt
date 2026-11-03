package com.haejumi.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadManifestTest {
    @Test fun matchesBackendJsonStringifyAndSha256() {
        assertEquals("ef53db4fea7608c67e5f3eaade92989e2027782c0ffd0bc8174edd4d398c078f",
            UploadManifest.hash("11111111-1111-4111-8111-111111111111", "a".repeat(64), 12))
    }
}
