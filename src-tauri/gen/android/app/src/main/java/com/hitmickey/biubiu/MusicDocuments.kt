package com.hitmickey.biubiu

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.util.LruCache
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document as Doc
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import org.json.JSONArray
import java.io.File
import java.security.MessageDigest

/** All music operations use grants returned by the system directory picker. */
internal class MusicDocuments(private val context: Context) {
    private val resolver get() = context.contentResolver
    private val audio = setOf("mp3","flac","wav","m4a","aac","ogg","oga","opus","wma","aiff")
    private fun tree(uri: Uri, write: Boolean = false): Uri {
        require(uri.scheme == ContentResolver.SCHEME_CONTENT && DocumentsContract.isTreeUri(uri))
        return resolver.persistedUriPermissions.firstOrNull {
            it.isReadPermission && (!write || it.isWritePermission) && it.uri.authority == uri.authority &&
                DocumentsContract.getTreeDocumentId(it.uri) == DocumentsContract.getTreeDocumentId(uri)
        }?.uri ?: error("请在本地音乐中重新授权这个目录")
    }
    private data class Entry(val uri: Uri, val name: String, val size: Long, val time: Long)
    private fun entries(root: Uri): List<Entry> {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, DocumentsContract.getTreeDocumentId(root))
        val result = mutableListOf<Entry>()
        resolver.query(children, arrayOf(Doc.COLUMN_DOCUMENT_ID, Doc.COLUMN_DISPLAY_NAME, Doc.COLUMN_SIZE, Doc.COLUMN_LAST_MODIFIED),
            null, null, null)?.use { c ->
            while (c.moveToNext()) result.add(Entry(DocumentsContract.buildDocumentUriUsingTree(root, c.getString(0)),
                c.getString(1) ?: continue, c.getLong(2), c.getLong(3)))
        }
        return result
    }
    private data class Tags(val title: String, val duration: Double)
    private val tags = LruCache<String, Tags>(512)
    private fun readTags(entry: Entry): Tags {
        val key = "${entry.uri}:${entry.size}:${entry.time}"
        tags.get(key)?.let { return it }
        val fallback = entry.name.substringBeforeLast('.')
        val retriever = MediaMetadataRetriever()
        val value = try {
            retriever.setDataSource(context, entry.uri)
            Tags(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.takeIf { it.isNotBlank() } ?: fallback,
                (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0) / 1000.0)
        } catch (_: RuntimeException) { Tags(fallback, 0.0) }
        finally { retriever.release() }
        tags.put(key,value)
        return value
    }
    fun scan(dirs: JSONArray, ids: JSONArray?): List<Map<String, Any>> {
        val wanted = ids?.let { a -> (0 until a.length()).mapTo(HashSet()) { a.getString(it) } }
        val result = mutableListOf<Map<String, Any>>()
        val md = MessageDigest.getInstance("MD5")
        for (i in 0 until dirs.length()) {
            val root = resolver.persistedUriPermissions.firstOrNull {
                it.isReadPermission && it.uri.toString() == dirs.getString(i)
            }?.uri ?: continue
            val files = try { entries(root) } catch (_: SecurityException) { continue }
            for (entry in files) {
                val ext = entry.name.substringAfterLast('.', "").lowercase()
                if (ext !in audio) continue
                val path = entry.uri.toString()
                val id = java.math.BigInteger(1, md.digest(path.toByteArray())).toString(16).padStart(32, '0')
                if (wanted != null && id !in wanted) continue
                result.add(if (wanted != null) mapOf("id" to id, "path" to path)
                else readTags(entry).let { tag -> mapOf("id" to id, "path" to path, "dir" to root.toString(), "title" to tag.title, "duration" to tag.duration,
                    "format" to ext, "size" to entry.size, "createdTime" to entry.time) })
            }
        }
        return result
    }
    fun fd(uri: Uri): Int {
        tree(uri)
        return resolver.openFileDescriptor(uri, "r")?.use { it.detachFd() } ?: error("无法打开音频文件")
    }
    fun delete(uri: Uri, dirs: JSONArray): Boolean {
        val root = tree(uri, true)
        require((0 until dirs.length()).any { dirs.getString(it) == root.toString() })
        val item = entries(root).firstOrNull { it.uri == uri } ?: return false
        return item.name.substringAfterLast('.', "").lowercase() in audio && DocumentsContract.deleteDocument(resolver, uri)
    }
    fun lyrics(uri: Uri): List<String> {
        val siblings = entries(tree(uri))
        val stem = siblings.firstOrNull { it.uri == uri }?.name?.substringBeforeLast('.') ?: return emptyList()
        return listOf("spl", "lrc").mapNotNull { ext ->
            siblings.firstOrNull { it.name.equals("$stem.$ext", ignoreCase = true) }?.uri?.toString()
        }
    }
    fun publish(file: File, directory: String?): String {
        require(file.canonicalFile.toPath().startsWith(File(context.filesDir, "downloads").canonicalFile.toPath())) { "无法读取应用的下载暂存文件" }
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension) ?: "application/octet-stream"
        val uri = if (directory?.startsWith("content://") == true) {
            val root = tree(Uri.parse(directory), true)
            val parent = DocumentsContract.buildDocumentUriUsingTree(root, DocumentsContract.getTreeDocumentId(root))
            DocumentsContract.createDocument(resolver, parent, mime, file.name)
        } else if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/BiuBiu")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } else return file.absolutePath
        requireNotNull(uri) { "无法创建下载文件" }
        try {
            resolver.openOutputStream(uri, "w")!!.use { out -> file.inputStream().use { it.copyTo(out) } }
            if (Build.VERSION.SDK_INT >= 29 && uri.authority == MediaStore.AUTHORITY)
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
        return uri.toString()
    }
}
