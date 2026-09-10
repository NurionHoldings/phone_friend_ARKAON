package com.nurion.arkaon.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class DeviceBridgeModelsTest {

    @Test
    fun snapshotNeverGrantsAuthorityByDefault() {
        val snapshot = ContactSnapshot(
            contacts = listOf(
                DeviceContact(
                    id = "1",
                    name = "홍길동",
                    phones = listOf("010-1234-5678")
                )
            )
        )

        assertFalse(snapshot.authorityGranted)
        assertFalse(snapshot.mutationPerformed)
        assertFalse(snapshot.permissionGranted)
    }

    @Test
    fun proposalDefaultsAreSafe() {
        val proposal = DuplicateContactCandidate(
            id = "dup:1:2",
            contactIds = listOf("1", "2"),
            names = listOf("홍길동", "홍길동"),
            phones = listOf("01012345678"),
            score = 0.95,
            level = "HIGH"
        )

        assertEquals(true, proposal.proposalOnly)
        assertFalse(proposal.mergeAllowed)
        assertFalse(proposal.deleteAllowed)
        assertFalse(proposal.authorityGranted)
    }

    @Test
    fun analysisResponseAuthorityAlwaysFalseDefault() {
        val response = ContactAnalysisResponse(
            ok = true,
            method = "DUPLICATES",
            candidateCount = 1,
            proposals = emptyList()
        )

        assertFalse(response.authorityGranted)
        assertFalse(response.mutated)
    }
}
