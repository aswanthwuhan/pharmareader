package com.aurapharmlab.pharmareader.kokoro;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

/**
 * On-device storage for the Kokoro model: runtime download, streaming
 * bzip2/tar extraction, verification, size accounting and deletion.
 *
 * <p>Everything lives under {@code context.filesDir/kokoro/}, i.e. app-private storage that
 * needs no permission and is removed with the app. Nothing is bundled in the APK.
 *
 * <p>The archive is extracted straight out of the HTTP stream (bzip2 -> tar), so a
 * 333&nbsp;MiB download never occupies the same space twice. Extraction happens in a
 * scratch directory which is only moved into place once the archive was read completely,
 * so a cancelled or broken download can never leave a half-model that looks installed.
 */
public final class KokoroStore {

    private static final String TAG = "KokoroStore";
    private static final String ROOT_DIR = "kokoro";
    private static final String SCRATCH_DIR = ".extract";
    private static final int HTTP_TIMEOUT_MS = 30_000;
    private static final int BUFFER_BYTES = 128 * 1024;

    /** Download progress callback; fractions run 0..1. Called on the worker thread. */
    public interface Progress {
        void onProgress(double fraction, long bytesRead, long totalBytes);
    }

    private final File root;

    public KokoroStore(Context context) {
        this.root = new File(context.getFilesDir(), ROOT_DIR);
    }

    public File rootDir() {
        return root;
    }

    public File modelDir() {
        return new File(root, KokoroModel.ID);
    }

    /** Cache directory for synthesized WAV files (one per spoken sentence). */
    public File audioCacheDir(Context context) {
        return new File(context.getCacheDir(), ROOT_DIR);
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
     * Downloads and extracts the model. Blocking; call from a worker thread.
     *
     * @return the number of bytes extracted into the model directory
     */
    public long download(Progress progress) throws IOException {
        long free = freeBytes();
        long needed = Math.max(KokoroModel.EXTRACTED_BYTES, KokoroModel.ARCHIVE_BYTES);
        if (free > 0 && free < needed) {
            throw new IOException(String.format(
                    Locale.US,
                    "Not enough free storage: %d MiB available, about %d MiB needed",
                    free / (1024 * 1024),
                    needed / (1024 * 1024)));
        }

        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Cannot create " + root.getAbsolutePath());
        }

        File scratch = new File(root, SCRATCH_DIR);
        deleteRecursively(scratch);
        if (!scratch.mkdirs() && !scratch.isDirectory()) {
            throw new IOException("Cannot create " + scratch.getAbsolutePath());
        }

        try {
            File extracted = extractArchive(scratch, progress);

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
            Log.i(TAG, "Kokoro model ready at " + target.getAbsolutePath());
            return sizeBytes();
        } finally {
            deleteRecursively(scratch);
        }
    }

    /** Remove the model from disk. */
    public void delete() throws IOException {
        deleteRecursively(modelDir());
        deleteRecursively(new File(root, SCRATCH_DIR));
        File[] leftovers = root.listFiles();
        if (leftovers != null) {
            for (File f : leftovers) {
                deleteRecursively(f);
            }
        }
    }

    // ---------------------------------------------------------------- extraction

    private File extractArchive(File scratch, Progress progress) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = openConnection(KokoroModel.DOWNLOAD_URL);
            int code = connection.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + code + " while downloading the model");
            }
            long total = connection.getContentLengthLong();
            if (total <= 0L) {
                total = KokoroModel.ARCHIVE_BYTES;
            }

            CountingInputStream counting =
                    new CountingInputStream(new BufferedInputStream(
                            connection.getInputStream(), BUFFER_BYTES));
            try (InputStream raw = counting;
                 BZip2CompressorInputStream bz =
                         new BZip2CompressorInputStream(raw, true);
                 TarArchiveInputStream tar = new TarArchiveInputStream(bz)) {

                ProgressReporter reporter = new ProgressReporter(progress, total);
                reporter.emit(0.0, 0L);
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
                        if (!target.isDirectory() && !target.mkdirs() && !target.isDirectory()) {
                            throw new IOException("Cannot create " + target.getAbsolutePath());
                        }
                        continue;
                    }
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()
                            && !parent.isDirectory()) {
                        throw new IOException("Cannot create " + parent.getAbsolutePath());
                    }
                    try (OutputStream out = new BufferedOutputStream(
                            new FileOutputStream(target), BUFFER_BYTES)) {
                        int read;
                        while ((read = tar.read(buffer)) > 0) {
                            out.write(buffer, 0, read);
                            reporter.emit(counting.count / (double) total, counting.count);
                        }
                    }
                }
                reporter.emit(1.0, total);
            }
            return findModelDir(scratch);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static HttpURLConnection openConnection(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(HTTP_TIMEOUT_MS);
        connection.setReadTimeout(HTTP_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/octet-stream,*/*");
        connection.setRequestProperty("User-Agent", "PharmaReader-Kokoro/1.0");
        return connection;
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
            Log.w(TAG, "Could not delete " + file.getAbsolutePath());
        }
    }

    private static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            if (!to.isDirectory() && !to.mkdirs() && !to.isDirectory()) {
                throw new IOException("Cannot create " + to.getAbsolutePath());
            }
            File[] children = from.listFiles();
            if (children != null) {
                for (File child : children) {
                    copyTree(child, new File(to, child.getName()));
                }
            }
            return;
        }
        File parent = to.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Cannot create " + parent.getAbsolutePath());
        }
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new BufferedOutputStream(new FileOutputStream(to))) {
            byte[] buffer = new byte[BUFFER_BYTES];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
        } catch (FileNotFoundException e) {
            throw new IOException("Cannot copy " + from.getAbsolutePath(), e);
        }
    }

    /** Counts bytes pulled off the network so progress can be reported while unpacking. */
    static final class CountingInputStream extends FilterInputStream {
        long count;

        CountingInputStream(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0) {
                count++;
            }
            return value;
        }

        @Override
        public int read(byte[] data, int offset, int length) throws IOException {
            int read = super.read(data, offset, length);
            if (read > 0) {
                count += read;
            }
            return read;
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
