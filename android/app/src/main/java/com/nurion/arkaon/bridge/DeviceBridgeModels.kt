package com.nurion.arkaon.bridge

data class DeviceContact(
    val id: String,
    val name: String,
    val phones: List<String>
)

data class ContactSnapshot(
    val contacts: List<DeviceContact>,
    /** Explicit OS READ_CONTACTS result. False is fail-closed at the API. */
    val permissionGranted: Boolean = false,
    val mutationPerformed: Boolean = false,
    val authorityGranted: Boolean = false
)

data class DuplicateContactCandidate(
    val id: String,
    val contactIds: List<String>,
    val names: List<String>,
    val phones: List<String>,
    val score: Double,
    val level: String,
    val proposalOnly: Boolean = true,
    val mergeAllowed: Boolean = false,
    val deleteAllowed: Boolean = false,
    val authorityGranted: Boolean = false
)

data class ContactAnalysisResponse(
    val ok: Boolean,
    val method: String,
    val candidateCount: Int,
    val proposals: List<DuplicateContactCandidate>,
    val mutated: Boolean = false,
    val authorityGranted: Boolean = false,
    val assistantText: String? = null,
    val error: String? = null
)
