package com.nurion.arkaon.bridge

import com.nurion.arkaon.contacts.AndroidContactsReader
import com.nurion.arkaon.permissions.PermissionController

sealed class ContactReadResult {

    data object PermissionRequired : ContactReadResult()

    data class Success(
        val snapshot: ContactSnapshot
    ) : ContactReadResult()

    data class Failure(
        val message: String
    ) : ContactReadResult()
}

fun interface DeviceContactReader {
    fun readContacts(): ContactReadResult
}

class ArkaonDeviceBridge(
    private val permissions: PermissionController,
    private val contactsReader: AndroidContactsReader
) : DeviceContactReader {

    override fun readContacts(): ContactReadResult {
        if (!permissions.hasReadContacts()) {
            return ContactReadResult.PermissionRequired
        }

        return try {
            val contacts = contactsReader.read()

            ContactReadResult.Success(
                ContactSnapshot(
                    contacts = contacts,
                    permissionGranted = true,
                    mutationPerformed = false,
                    authorityGranted = false
                )
            )
        } catch (error: Exception) {
            ContactReadResult.Failure(
                error.message ?: "연락처를 읽지 못했습니다."
            )
        }
    }
}
