package com.nurion.arkaon.phonefriend

import com.nurion.arkaon.bridge.ContactAnalysisResponse
import com.nurion.arkaon.bridge.ContactSnapshot
import com.nurion.arkaon.bridge.DuplicateContactCandidate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class PhoneFriendApiClient(
    private val baseUrl: String,
    private val client: OkHttpClient =
        OkHttpClient
            .Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
) : ContactAnalyzeClient {

    override suspend fun analyzeContacts(
        snapshot: ContactSnapshot,
        method: String
    ): ContactAnalysisResponse =
        withContext(Dispatchers.IO) {

            if (!snapshot.permissionGranted) {
                throw IOException("READ_CONTACTS permission was not granted")
            }

            val contactsJson = JSONArray()

            snapshot.contacts.forEach { contact ->
                val phones = JSONArray()
                contact.phones.forEach { phones.put(it) }

                contactsJson.put(
                    JSONObject()
                        .put("id", contact.id)
                        .put("name", contact.name)
                        .put("phones", phones)
                )
            }

            val payload =
                JSONObject()
                    .put("client", "ANDROID")
                    .put("method", method)
                    .put("contacts", contactsJson)
                    .put("permission_granted", true)
                    .put("mutation_performed", false)
                    .put("authority_granted", false)

            val request =
                Request.Builder()
                    .url(
                        "${baseUrl.trimEnd('/')}/api/phone-friend/device/contact-analyze"
                    )
                    .post(
                        payload
                            .toString()
                            .toRequestBody(JSON)
                    )
                    .build()

            client
                .newCall(request)
                .execute()
                .use { response ->

                    val text =
                        response.body
                            ?.string()
                            .orEmpty()

                    if (!response.isSuccessful) {
                        throw IOException(
                            "ARKAON API ${response.code}"
                        )
                    }

                    parseResponse(JSONObject(text))
                }
        }

    private fun parseResponse(
        json: JSONObject
    ): ContactAnalysisResponse {

        val proposalsJson =
            json.optJSONArray("proposals") ?: JSONArray()

        val proposals =
            mutableListOf<DuplicateContactCandidate>()

        for (index in 0 until proposalsJson.length()) {
            val item = proposalsJson.getJSONObject(index)

            proposals +=
                DuplicateContactCandidate(
                    id = item.optString("id"),
                    contactIds =
                        item
                            .optJSONArray("contact_ids")
                            .toStringList(),
                    names =
                        item
                            .optJSONArray("names")
                            .toStringList(),
                    phones =
                        item
                            .optJSONArray("phones")
                            .toStringList(),
                    score = item.optDouble("score", 0.0),
                    level = item.optString("level", "LOW"),
                    proposalOnly =
                        item.optBoolean("proposal_only", true),
                    mergeAllowed =
                        item.optBoolean("merge_allowed", false),
                    deleteAllowed =
                        item.optBoolean("delete_allowed", false),
                    authorityGranted = false
                )
        }

        return ContactAnalysisResponse(
            ok = json.optBoolean("ok", false),
            method = json.optString("method", "DUPLICATES"),
            candidateCount = json.optInt("candidate_count", 0),
            proposals = proposals,
            mutated = false,
            authorityGranted = false,
            assistantText = json.optionalString("assistant_text"),
            error = json.optionalString("error")
        )
    }

    companion object {
        private val JSON =
            "application/json; charset=utf-8".toMediaType()
    }
}

private fun JSONObject.optionalString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = optString(key)
    return value.takeIf { it.isNotBlank() }
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    val values = mutableListOf<String>()
    for (i in 0 until length()) {
        val value = optString(i)
        if (value.isNotBlank()) {
            values += value
        }
    }
    return values
}
