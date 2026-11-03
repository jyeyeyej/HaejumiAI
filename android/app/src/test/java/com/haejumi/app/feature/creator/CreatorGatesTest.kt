package com.haejumi.app.feature.creator

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CreatorGatesTest {
    @Test fun staleCheckpointCannotApprove() {
        val hash = "a".repeat(64)
        assertTrue(CreatorGates.current(2, hash, 2, hash))
        assertFalse(CreatorGates.current(2, hash, 1, hash))
        assertFalse(CreatorGates.current(2, hash, 2, "b".repeat(64)))
    }

    @Test fun onlyCurrentVerifiedFfmpegJobCanSupplyPreview() {
        val hash = "a".repeat(64)
        assertTrue(CreatorGates.verifiedPreview(2, hash, 2, hash, "succeeded", "ffmpeg", true))
        assertFalse(CreatorGates.verifiedPreview(2, hash, 2, hash, "simulated", "test", false))
        assertFalse(CreatorGates.verifiedPreview(2, hash, 1, hash, "succeeded", "ffmpeg", true))
        assertFalse(CreatorGates.verifiedPreview(2, hash, 2, hash, "succeeded", "ffmpeg", false))
    }
}
