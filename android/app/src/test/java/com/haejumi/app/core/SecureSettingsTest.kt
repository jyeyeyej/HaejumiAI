package com.haejumi.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureSettingsTest {
    @Test fun permitsOnlyEncryptedPrivateEndpoints() {
        assertTrue(SecureSettings.validAddress("https://192.168.1.20:8443"))
        assertTrue(SecureSettings.validAddress("https://pc.example.ts.net"))
        assertFalse(SecureSettings.validAddress("http://192.168.1.20"))
        assertFalse(SecureSettings.validAddress("https://example.com"))
        assertFalse(SecureSettings.validAddress("https://pc.example.ts.net.evil.test"))
        assertFalse(SecureSettings.validAddress("https://user:password@pc.example.ts.net"))
        assertFalse(SecureSettings.validAddress("https://192.168.1.20/api"))
        assertFalse(SecureSettings.validAddress("https://127.0.0.1"))
    }
}
