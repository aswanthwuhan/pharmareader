package com.aurapharmlab.pharmareader.kokoro;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.Locale;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

/**
 * On-device storage for the Kokoro model: resumable runtime download, streaming
 * bzip2/tar extraction, verification, size accounting and deletion.
 *
 * <p>Everything lives under {@code context.filesDir/kokoro/}, i.e. app-private storage that
 * needs no permission and is removed with the app. Nothing is bundled in the APK.
 *
 * <p>The 334&nbsp;MiB archive is first written to a {@code .part} file so an interrupted
 * download (a dropped mobile connection, the app being killed in the background) resumes
 * with an HTTP {@code Range} request instead of starting again. Only once the archive is
 * complete is it unpacked, into a scratch directory that is moved into place atomically, so
 * a cancelled or broken download can never leave a half-model that looks installed.
 *
 * <p>Integrity: the download is checked against the size the server reported, and bzip2
 * carries a CRC32 per block, so a truncated or corrupted archive fails to unpack rather
 * than producing a silently broken model. There is no published SHA-256 for the release
 * asset (GitHub reports {@code digest: null}), so none is pinned here.
 */
public final class KokoroStore {

    private static final String TAG = "KokoroStore";
    private static final String ROOT_DIR = "kokoro";
    private static final String SCRATCH_DIR = ".extract";
    private static final String ARCHIVE_PART = ".model.tar.bz2.part";
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final int BUFFER_BYTES = 128 * 1024;
    /** One automatic retry; the {@code .part} file makes it resume where it stopped. */
    private static final int MAX_ATTEMPTS = 2;
    /** Head-room so a "just fits" pre-check does not fail halfway through the last file. */
    private static final long SPACE_MARGIN = 20_000_000L;
    /** HttpURLConnection has no constant for 416 Range Not Satisfiable. */
    private static final int HTTP_RANGE_NOT_SATISFIABLE = 416;

    /** Download progress callback; fractions run 0..1. Called on the worker thread. */
    public interface Progress {
        void onProgress(double fraction, long bytesRead, long totalBytes);
    }

    /** A failure the user can only fix by freeing storage: never worth retrying. */
    static final class StorageException extends IOException {
        StorageException(String message) {
            super(message);
        }
    }

    private final File root;

    public KokoroStore(Context context) {
        this(new File(context.getFilesDir(), ROOT_DIR));
    }

    /**
     * Rooted at an explicit directory instead of {@code filesDir}. The download, extraction and
     * verification are plain {@code java.io}, so the JVM tests drive this constructor to run the
     * real thing on a desktop.
     */
    KokoroStore(File root) {
        this.root = root;
    }

    /** {@code android.util.Log} is a stub in the JVM tests; fall back to the console there. */
    private static void info(String message) {
        try {
            Log.i(TAG, message);
        } catch (Throwable notAndroid) {
            System.out.println(TAG + ": " + message);
        }
    }

    private static void warn(String message) {
        try {
            Log.w(TAG, message);
        } catch (Throwable notAndroid) {
            System.err.println(TAG + ": " + message);
        }
    }

    public File rootDir() {
        return root;
    }

    public File modelDir() {
        return new File(root, KokoroModel.ID);
    }

    /** True when a complete, verified model is present. */
    public boolean isDownloaded() {
        File dir = modelDir();
        if (!dir.isDirectory() || !new File(dir, KokoroModel.MARKER_FILE).isFile()) {
            return false;
        }
        return verify(dir) == null;
    }

    /** Bytes used by the extracted model (0 when absent). */
    public long sizeBytes() {
        long total = 0L;
        File dir = modelDir();
        if (!dir.isDirectory()) {
            return 0L;
        }
        for (String name : KokoroModel.REQUIRED_FILES) {
            File f = new File(dir, name);
            if (f.isFile()) {
                total += f.length();
            }
        }
        total += directorySize(new File(dir, KokoroModel.ESPEAK_DIR));
        return total;
    }

    /** Bytes of a partially downloaded archive that the next download will resume from. */
    public long partialBytes() {
        File part = new File(root, ARCHIVE_PART);
        return part.isFile() ? part.length() : 0L;
    }

    public long freeBytes() {
        File probe = root.isDirectory() ? root : root.getParentFile();
        return probe == null ? 0L : probe.getUsableSpace();
    }

    /**
     * Returns null when the model directory is complete, otherwise a human readable reason.
     */
    public String verify(File dir) {
        if (dir == null || !dir.isDirectory()) {
            return "model directory missing";
        }
        for (int i = 0; i < KokoroModel.REQUIRED_FILES.length; i++) {
            File f = new File(dir, KokoroModel.REQUIRED_FILES[i]);
            if (!f.isFile()) {
                return "missing " + KokoroModel.REQUIRED_FILES[i];
            }
            long min = KokoroModel.MIN_BYTES[i];
            if (f.length() < min) {
                return String.format(
                        Locale.US, "%s is too small (%d bytes)", f.getName(), f.length());
            }
        }
        for (String name : KokoroModel.REQUIRED_DIRS) {
            File d = new File(dir, name);
            if (!d.isDirectory() || directorySize(d) <= 0L) {
                return "missing " + name + "/";
            }
        }
        return null;
    }

    /**
     * Downloads and extracts the model, resuming a previous partial download. Blocking;
     * call from a worker thread.
     *
     * @return the number of bytes extracted into the model directory
     */
    public long download(Progress progress) throws IOException {
        long needed = KokoroModel.REQUIRED_FREE_BYTES + SPACE_MARGIN;
        long free = freeBytes();
        if (free > 0 && free < needed) {
            throw new StorageException(String.format(
                    Locale.US,
                    "Not enough free storage: %d MB available, about %d MB needed "
                            + "(the download plus the unpacked model). Free some space and try again.",
                    free / (1024 * 1024),
                    needed / (1024 * 1024)));
        }
        ensureDir(root, "model storage");

        File part = new File(root, ARCHIVE_PART);
        File scratch = new File(root, SCRATCH_DIR);
        boolean success = false;
        try {
            long archiveBytes = fetchArchive(part, progress);
            // Unpacking takes a while on a phone and produces no byte progress of its own, so
            // report the archive as complete first; the panel switches to "Unpacking…" at 100 %.
            if (progress != null) {
                progress.onProgress(1d, archiveBytes, archiveBytes);
            }
            info("archive ready: " + archiveBytes + " bytes");

            long freeAfterDownload = freeBytes();
            if (freeAfterDownload > 0
                    && freeAfterDownload < KokoroModel.EXTRACTED_BYTES + SPACE_MARGIN) {
                throw new StorageException(String.format(
                        Locale.US,
                        "Not enough free storage to unpack the model: %d MB available, "
                                + "about %d MB needed. The download was kept and will be "
                                + "unpacked once space is free.",
                        freeAfterDownload / (1024 * 1024),
                        KokoroModel.EXTRACTED_BYTES / (1024 * 1024)));
            }

            deleteRecursively(scratch);
            ensureDir(scratch, "model scratch");

            File extracted;
            try {
                extracted = extractArchive(part, scratch);
            } catch (IOException e) {
                // A truncated or corrupt archive fails identically on every retry, so drop it
                // unless the failure looks like a full disk (then keeping it saves 334 MiB).
                if (freeBytes() > SPACE_MARGIN) {
                    deleteRecursively(part);
                }
                throw new IOException(
                        "The model archive could not be unpacked ("
                                + e.getMessage()
                                + "). Please try the download again.",
                        e);
            }

            String problem = verify(extracted);
            if (problem != null) {
                throw new IOException("Downloaded model is incomplete: " + problem);
            }

            File target = modelDir();
            deleteRecursively(target);
            if (!extracted.renameTo(target)) {
                copyTree(extracted, target);
                deleteRecursively(extracted);
            }
            writeMarker(target);
            success = true;
            info("Kokoro model ready at " + target.getAbsolutePath());
            return sizeBytes();
        } finally {
            deleteRecursively(scratch);
            if (success) {
                deleteRecursively(part);
            }
        }
    }

    /** Remove the model and any partial download from disk. */
    public void delete() throws IOException {
        deleteRecursively(modelDir());
        deleteRecursively(new File(root, SCRATCH_DIR));
        deleteRecursively(new File(root, ARCHIVE_PART));
        File[] leftovers = root.listFiles();
        if (leftovers != null) {
            for (File f : leftovers) {
                deleteRecursively(f);
            }
        }
    }

    // ---------------------------------------------------------------- download

    /** Resume the archive download until it is complete, retrying once on a network error. */
    private long fetchArchive(File part, Progress progress) throws IOException {
        if (part.isFile() && part.length() >= KokoroModel.ARCHIVE_BYTES) {
            info("archive already downloaded: " + part.length() + " bytes");
            return part.length();
        }
        IOException last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return fetchOnce(part, progress);
            } catch (StorageException e) {
                throw e;
            } catch (IOException e) {
                last = e;
                warn("download attempt " + attempt + " failed: " + e);
                if (attempt == MAX_ATTEMPTS) {
                    break;
                }
            }
        }
        long kept = part.isFile() ? part.length() : 0L;
        throw new IOException(describeDownloadFailure(last, kept), last);
    }

    /**
     * One HTTP request. Appends to {@code part} when the server honours the {@code Range}
     * header, restarts from zero when it does not.
     */
    private long fetchOnce(File part, Progress progress) throws IOException {
        long existing = part.isFile() ? part.length() : 0L;
        if (existing > KokoroModel.ARCHIVE_BYTES) {
            // Left over from a different (larger) archive: not resumable.
            deleteRecursively(part);
            existing = 0L;
        }
        long total = KokoroModel.ARCHIVE_BYTES;

        HttpURLConnection connection = openConnection(KokoroModel.DOWNLOAD_URL);
        try {
            if (existing > 0L) {
                connection.setRequestProperty("Range", "bytes=" + existing + "-");
            }
            int code = connection.getResponseCode();
            if (code == HttpURLConnection.HTTP_PARTIAL) {
                long reported = parseContentRangeTotal(connection.getHeaderField("Content-Range"));
                if (reported > 0L) {
                    total = reported;
                }
            } else if (code == HttpURLConnection.HTTP_OK) {
                // The server ignored the Range header; appending would duplicate bytes.
                existing = 0L;
                long length = connection.getContentLengthLong();
                if (length > 0L) {
                    total = length;
                }
            } else if (code == HTTP_RANGE_NOT_SATISFIABLE) {
                // The saved .part no longer lines up with what the server has. Drop it; the
                // retry loop in fetchArchive() starts again from zero.
                deleteRecursively(part);
                throw new IOException(
                        "the saved partial download did not match the file on the server");
            } else {
                throw new IOException("HTTP " + code + " while downloading the model");
            }
            info(String.format(
                    Locale.US,
                    "GET model -> %d, resuming at %d of %d bytes", code, existing, total));
            copyToPart(connection.getInputStream(), part, existing, total, progress);
        } finally {
            connection.disconnect();
        }

        long size = part.length();
        if (size != total) {
            throw new IOException(String.format(
                    Locale.US, "the connection closed after %d of %d bytes", size, total));
        }
        return size;
    }

    private static void copyToPart(
            InputStream in, File part, long existing, long total, Progress progress)
            throws IOException {
        ProgressReporter reporter = new ProgressReporter(progress, total);
        reporter.emit(existing / (double) total, existing);
        byte[] buffer = new byte[BUFFER_BYTES];
        long written = existing;
        try (InputStream source = new BufferedInputStream(in, BUFFER_BYTES);
             OutputStream out = new BufferedOutputStream(
                     new FileOutputStream(part, existing > 0L), BUFFER_BYTES)) {
            int read;
            while ((read = source.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                written += read;
                reporter.emit(written / (double) total, written);
            }
            out.flush();
        }
    }

    private static String describeDownloadFailure(IOException error, long keptBytes) {
        String detail;
        if (error instanceof SocketTimeoutException) {
            detail = "the connection stalled for "
                    + (READ_TIMEOUT_MS / 1000)
                    + " s with no data";
        } else if (error == null) {
            detail = "unknown error";
        } else {
            detail = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        }
        String resume = keptBytes > 0L
                ? String.format(
                        Locale.US,
                        " The %d MB already downloaded were kept and resume next time.",
                        keptBytes / (1024 * 1024))
                : " Please try again.";
        return "Model download failed: " + detail + "." + resume;
    }

    private static HttpURLConnection openConnection(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/octet-stream,*/*");
        connection.setRequestProperty("User-Agent", "PharmaReader-Kokoro/1.0");
        return connection;
    }

    /** {@code Content-Range: bytes 100-199/200} -> 200; -1 when absent or unparseable. */
    static long parseContentRangeTotal(String header) {
        if (header == null) {
            return -1L;
        }
        int slash = header.lastIndexOf('/');
        if (slash < 0 || slash == header.length() - 1) {
            return -1L;
        }
        try {
            return Long.parseLong(header.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    // ---------------------------------------------------------------- extraction

    private File extractArchive(File archive, File scratch) throws IOException {
        try {
            return extractArchiveNow(archive, scratch);
        } catch (NoClassDefFoundError error) {
            // commons-compress loads its stream plumbing (bit/byte counters) from commons-io. When
            // that jar is missing from the APK, the tar reader dies with
            // "org/apache/commons/io/input/CountingInputStream" *after* the 334 MB download has
            // finished, which reads to the user as a failed download. Say what is actually wrong.
            throw new IOException(unpackerMessage(error), error);
        }
    }

    private File extractArchiveNow(File archive, File scratch) throws IOException {
        try (InputStream raw = new BufferedInputStream(new FileInputStream(archive), BUFFER_BYTES);
             BZip2CompressorInputStream bz = new BZip2CompressorInputStream(raw, true);
             TarArchiveInputStream tar = new TarArchiveInputStream(bz)) {

            byte[] buffer = new byte[BUFFER_BYTES];
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                String name = entry.getName();
                if (name == null || name.isEmpty()) {
                    continue;
                }
                if (entry.isSymbolicLink() || entry.isLink()) {
                    continue;
                }
                File target = safeResolve(scratch, name);
                if (entry.isDirectory()) {
                    ensureDir(target, "model directory");
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null) {
                    ensureDir(parent, "model directory");
                }
                try (OutputStream out = new BufferedOutputStream(
                        new FileOutputStream(target), BUFFER_BYTES)) {
                    int read;
                    while ((read = tar.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                    }
                }
            }
        }
        return findModelDir(scratch);
    }

    /**
     * Message for a missing unpacker support class. {@code NoClassDefFoundError} only carries the
     * class name, which is meaningless to a reader, so name the cause and the missing piece.
     */
    static String unpackerMessage(Throwable error) {
        String missing = error.getMessage();
        if (missing == null || missing.isEmpty()) {
            missing = error.getClass().getName();
        }
        return "The app is missing part of its archive unpacker (" + missing.replace('/', '.')
                + "). Reinstall the app: the build has to ship commons-io next to commons-compress.";
    }

    /** The archive contains a single {@code kokoro-multi-lang-v1_0/} directory. */
    private File findModelDir(File scratch) throws IOException {
        File expected = new File(scratch, KokoroModel.ID);
        if (expected.isDirectory()) {
            return expected;
        }
        File[] children = scratch.listFiles();
        File onlyDir = null;
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) {
                    if (onlyDir != null) {
                        onlyDir = null;
                        break;
                    }
                    onlyDir = child;
                }
            }
        }
        if (onlyDir == null) {
            throw new IOException("Archive did not contain a model directory");
        }
        return onlyDir;
    }

    /** Resolve a tar entry name under {@code base}, refusing anything that escapes it. */
    static File safeResolve(File base, String name) throws IOException {
        String cleaned = name.replace('\\', '/');
        while (cleaned.startsWith("/")) {
            cleaned = cleaned.substring(1);
        }
        File resolved = new File(base, cleaned);
        String basePath = base.getCanonicalPath() + File.separator;
        if (!resolved.getCanonicalPath().startsWith(basePath)) {
            throw new IOException("Refusing tar entry outside the target directory: " + name);
        }
        return resolved;
    }

    private void writeMarker(File dir) throws IOException {
        File marker = new File(dir, KokoroModel.MARKER_FILE);
        try (OutputStream out = new FileOutputStream(marker)) {
            out.write((KokoroModel.ID + "\n").getBytes("UTF-8"));
        }
    }

    // ---------------------------------------------------------------- file helpers

    private static void ensureDir(File dir, String what) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException(
                    "Cannot create the " + what + " directory " + dir.getAbsolutePath());
        }
    }

    static long directorySize(File dir) {
        if (dir == null || !dir.isDirectory()) {
            return 0L;
        }
        long total = 0L;
        File[] children = dir.listFiles();
        if (children == null) {
            return 0L;
        }
        for (File child : children) {
            total += child.isDirectory() ? directorySize(child) : child.length();
        }
        return total;
    }

    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!file.delete() && file.exists()) {
            warn("Could not delete " + file.getAbsolutePath());
        }
    }

    private static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            ensureDir(to, "model");
            File[] children = from.listFiles();
            if (children != null) {
                for (File child : children) {
                    copyTree(child, new File(to, child.getName()));
                }
            }
            return;
        }
        File parent = to.getParentFile();
        if (parent != null) {
            ensureDir(parent, "model");
        }
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new BufferedOutputStream(new FileOutputStream(to), BUFFER_BYTES)) {
            byte[] buffer = new byte[BUFFER_BYTES];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        }
    }

    /** Coalesces progress callbacks to whole percentage points. */
    private static final class ProgressReporter {
        private final Progress listener;
        private final long total;
        private int lastPercent = -1;

        ProgressReporter(Progress listener, long total) {
            this.listener = listener;
            this.total = total;
        }

        void emit(double fraction, long bytesRead) {
            if (listener == null) {
                return;
            }
            double clamped = fraction < 0 ? 0 : (fraction > 1 ? 1 : fraction);
            int percent = (int) Math.floor(clamped * 100.0);
            if (percent == lastPercent && percent != 100) {
                return;
            }
            lastPercent = percent;
            listener.onProgress(clamped, bytesRead, total);
        }
    }
}
