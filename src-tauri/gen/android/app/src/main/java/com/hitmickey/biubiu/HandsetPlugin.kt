package com.hitmickey.biubiu

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.DocumentsContract
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.core.graphics.ColorUtils
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@TauriPlugin
class HandsetPlugin(private val host: Activity) : Plugin(host) {
    private val io = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val docs = MusicDocuments(host)

    private fun result(invoke: Invoke, work: () -> Any?) {
        try {
            val value = work()
            when (value) { null, Unit -> invoke.resolve(); else -> invoke.resolveObject(value) }
        } catch (e: Exception) { invoke.reject(e.message ?: "Android 操作失败") }
    }
    private fun ui(invoke: Invoke, work: () -> Any?) = host.runOnUiThread { result(invoke, work) }

    @Command fun pickTree(invoke: Invoke) = host.runOnUiThread {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        try { startActivityForResult(invoke, intent, "picked") } catch (e: Exception) { invoke.reject(e.message) }
    }
    @ActivityCallback fun picked(invoke: Invoke, response: ActivityResult) = result(invoke) {
        val data = response.data
        val uri = data?.data
        if (response.resultCode != Activity.RESULT_OK || uri == null) null else {
            host.contentResolver.takePersistableUriPermission(uri, data.flags and
                (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            uri.toString()
        }
    }
    @Command fun exportFile(i: Invoke) = host.runOnUiThread {
        val args = i.getArgs()
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(args.optString("mime").ifEmpty { "application/octet-stream" }).putExtra(Intent.EXTRA_TITLE, args.getString("name"))
        try { startActivityForResult(i,intent,"exportPicked") } catch (e: Exception) { i.reject(e.message) }
    }
    @ActivityCallback fun exportPicked(i: Invoke, response: ActivityResult) {
        val uri = response.data?.data
        if (response.resultCode != Activity.RESULT_OK || uri == null) { i.resolveObject(false); return }
        io.execute { result(i) {
            File(i.getArgs().getString("path")).inputStream().use { input ->
                host.contentResolver.openOutputStream(uri,"wt")!!.use { input.copyTo(it) }
            }
            true
        } }
    }
    @Command fun scan(i: Invoke) = io.execute { result(i) { docs.scan(i.getArgs().getJSONArray("dirs"), i.getArgs().optJSONArray("ids")) } }
    @Command fun openDocument(i: Invoke) = result(i) { docs.fd(Uri.parse(i.getArgs().getString("uri"))) }
    @Command fun documentLyrics(i: Invoke) = io.execute { result(i) { docs.lyrics(Uri.parse(i.getArgs().getString("uri"))) } }
    @Command fun deleteDocument(i: Invoke) = io.execute { result(i) { docs.delete(Uri.parse(i.getArgs().getString("uri")), i.getArgs().getJSONArray("dirs")) } }
    @Command fun publishDownload(i: Invoke) = io.execute { result(i) { docs.publish(File(i.getArgs().getString("path")), i.getArgs().optString("directory")) } }
    @Command fun binaryDir(i: Invoke) = result(i) { host.applicationInfo.nativeLibraryDir }
    @Command fun systemBars(i: Invoke) = ui(i) {
        val hex = i.getArgs().getString("color").removePrefix("#")
        val color = Color.parseColor("#" + if (hex.length == 3) hex.map { "$it$it" }.joinToString("") else hex)
        host.findViewById<android.view.View>(android.R.id.content).setBackgroundColor(color)
        val light = ColorUtils.calculateLuminance(color) > 0.45
        WindowCompat.getInsetsController(host.window, host.window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
        Unit
    }
    @Command fun background(i: Invoke) = ui(i) { host.moveTaskToBack(true); Unit }
    @Command fun browse(i: Invoke) = ui(i) {
        val path = i.getArgs().optString("path")
        if (path.startsWith("content://")) {
            val tree = Uri.parse(path)
            val uri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            host.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } else host.startActivity(Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS))
    }
    @Command fun viewFile(i: Invoke) = ui(i) {
        val path = i.getArgs().getString("path")
        val uri = if (path.startsWith("content://")) Uri.parse(path) else FileProvider.getUriForFile(host, host.packageName + ".fileprovider", File(path))
        val mime = i.getArgs().optString("mime").ifEmpty { host.contentResolver.getType(uri) ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(File(path).extension) ?: "*/*" }
        host.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
    @Command fun credential(i: Invoke) = result(i) {
        synchronized(HandsetPlugin::class.java) {
            val alias = "biubiu.webdav"
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val key = (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generateKey()
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val value = i.getArgs().getString("value")
            if (i.getArgs().getString("operation") == "encrypt") {
                cipher.init(Cipher.ENCRYPT_MODE, key)
                "android:" + Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
            } else {
                require(value.startsWith("android:"))
                val bytes = Base64.decode(value.substringAfter(':'), Base64.NO_WRAP)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0,12)))
                String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
            }
        }
    }

    @Command fun syncMedia(i: Invoke) = ui(i) { PlaybackService.update(host, i.getArgs()) }
    override fun onDestroy(activity: AppCompatActivity) { io.shutdown(); super.onDestroy(activity) }
}
