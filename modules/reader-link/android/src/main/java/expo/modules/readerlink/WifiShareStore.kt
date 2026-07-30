package expo.modules.readerlink

import java.io.File
import java.io.IOException

/**
 * WifiShareStore — the one WiFi credential the phone is holding for the reader, read off disk.
 *
 * WHY A FILE AND NOT A START OPTION. Same rule as [LocalOutbox]: this module takes PATHS, never
 * values. A passphrase passed as a `ProxyOptions` field would sit in a Record that any validation
 * message could echo, would be visible to anything that ever dumps the options for a bug report,
 * and would have to be handed across the bridge on every session whether or not one was staged.
 * The JS half writes two lines into the app's own document directory, this reads them, and the
 * DELETE ack removes the file.
 *
 * FILE FORMAT, matching `serializeWifiCredential` in src/services/wifi_share.ts byte for byte:
 *
 *     {ssid}\n{psk}\n
 *
 * An EMPTY second line means an open network. A trailing CR is tolerated on both lines and
 * anything after the second line is ignored, so a text editor or a CRLF normalising copy cannot
 * break a credential. The values are RE-EMITTED from the parsed fields rather than relayed, so
 * trailing junk in the file can never reach the wire.
 *
 * CONFINEMENT IS DUPLICATED FROM [LocalOutbox] ON PURPOSE, and stricter here. This resolver
 * refuses a percent escape outright instead of decoding it: the outbox has to accept a copied
 * book's escaped filename, while this file has ONE fixed ASCII name inside the app's own document
 * directory, so an escape can only mean the path is not the one this module expects. Sharing a
 * helper would mean loosening it to the outbox's needs, which is the wrong direction for the file
 * that holds a secret.
 *
 * API surface used here is plain `java.io`, checked against the JDK the module already compiles
 * against: `File.canonicalFile`, `File.isFile`, `File.length`, `File.readBytes`, `File.delete`.
 */
internal class StagedWifi(val ssid: String, val password: String) {
  /**
   * The bytes the reader gets. Built from the validated fields, never from the raw file, so the
   * response is exactly two lines whatever the file happened to contain.
   */
  fun body(): ByteArray = (ssid + "\n" + password + "\n").toByteArray(Charsets.UTF_8)
}

internal class WifiShareStore(rawPath: String, roots: List<File>) {

  private val file: File? = resolveWithinAppStorage(rawPath, roots)

  /** Where this store is reading from, for diagnostics. Empty when the path was refused. */
  val path: String
    get() = file?.path ?: ""

  /**
   * The staged credential, or null for every reason that is not an error: no file, a file the
   * session is not allowed to read, an empty one, a partial write, or one whose contents do not
   * satisfy the same bounds the JS half validated against.
   *
   * NULL IS ALWAYS A 404, never a 5xx. A reader that asks for a credential and is told there is
   * none simply carries on with the sync; a 5xx would make a normal state look like a failure of
   * the whole session.
   */
  fun read(): StagedWifi? {
    val source = file ?: return null
    val length = try {
      if (!source.isFile) return null
      source.length()
    } catch (e: SecurityException) {
      return null
    }
    if (length <= 0L || length > ProxyContract.WIFI_FILE_MAX_BYTES.toLong()) return null

    val text = try {
      String(source.readBytes(), Charsets.UTF_8)
    } catch (e: IOException) {
      return null
    } catch (e: SecurityException) {
      return null
    } catch (e: OutOfMemoryError) {
      // Cannot happen under the cap above; caught because the alternative is killing the
      // connection worker, and this whole endpoint is optional.
      return null
    }

    val lines = text.split('\n')
    val ssid = trimCr(lines.getOrNull(0) ?: return null)
    val password = trimCr(lines.getOrNull(1) ?: "")
    if (!isValidSsid(ssid)) return null
    if (!isValidPassword(password)) return null
    return StagedWifi(ssid, password)
  }

  /**
   * THE ACK, and the single serve guarantee.
   *
   * Deleting the file is what stops the credential being served twice: the next GET in the same
   * session reads nothing and answers 404, whether or not the JS half ever hears the event. Returns
   * true when there was something to remove, which is what decides whether a `delivered` state is
   * emitted at all — a DELETE of nothing is not a handover.
   */
  fun consume(): Boolean {
    val source = file ?: return false
    return try {
      if (!source.isFile) return false
      source.delete()
    } catch (e: SecurityException) {
      false
    }
  }

  private fun trimCr(line: String): String =
    if (line.endsWith("\r")) line.substring(0, line.length - 1) else line

  private fun isValidSsid(ssid: String): Boolean {
    if (ssid.isEmpty()) return false
    if (hasControlChar(ssid)) return false
    return ssid.toByteArray(Charsets.UTF_8).size <= ProxyContract.WIFI_SSID_MAX_BYTES
  }

  /** Empty is VALID and means an open network. Anything else must satisfy WPA2's own bound. */
  private fun isValidPassword(password: String): Boolean {
    if (password.isEmpty()) return true
    if (hasControlChar(password)) return false
    return password.length >= ProxyContract.WIFI_PSK_MIN_CHARS &&
      password.length <= ProxyContract.WIFI_PSK_MAX_CHARS
  }

  private fun hasControlChar(value: String): Boolean {
    for (c in value) {
      if (c.code < 0x20 || c.code == 0x7F) return true
    }
    return false
  }
}

/**
 * Resolves the staged credential path to a real file inside this app's own storage, or null.
 *
 * Accepts the `file://` URI shape expo-file-system hands out and the plain POSIX form. Refuses:
 * a relative path, a percent escape (see the class KDoc), a NUL (which truncates the name at the
 * syscall boundary, so a path carrying one can name a file other than the one it reads like), a
 * space (the app's own document directory never contains one, and neither does the fixed filename),
 * and anything whose canonical form does not sit strictly under one of [roots].
 */
private fun resolveWithinAppStorage(raw: String, roots: List<File>): File? {
  var path = raw.trim()
  if (path.isEmpty()) return null
  if (path.startsWith("file://")) path = path.substring(7)
  if (!path.startsWith("/")) return null
  if (path.indexOf('%') >= 0) return null
  if (path.indexOf('\u0000') >= 0) return null
  if (path.indexOf(' ') >= 0) return null

  val canonical = try {
    File(path).canonicalFile
  } catch (e: IOException) {
    return null
  } catch (e: SecurityException) {
    return null
  }

  for (root in roots) {
    val canonicalRoot = try {
      root.canonicalFile
    } catch (e: IOException) {
      continue
    } catch (e: SecurityException) {
      continue
    }
    if (canonical.path.startsWith(canonicalRoot.path + File.separator)) return canonical
  }
  return null
}
