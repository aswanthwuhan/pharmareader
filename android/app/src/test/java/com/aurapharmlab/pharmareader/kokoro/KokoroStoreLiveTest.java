package com.aurapharmlab.pharmareader.kokoro;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

import org.junit.Assume;
import org.junit.Test;

/**
 * Drives the real 334 MiB download, bzip2/tar extraction and verification on the JVM.
 *
 * <p>These tests hit GitHub and touch ~1.5 GB of disk, so they are skipped unless a marker file
 * is present: create {@code .tmp/kokoro-debug/live} (or pass {@code -Dkokoro.live=true} to a
 * build that forwards system properties) to run them. A normal {@code gradlew test} stays
 * offline.
 *
 * <p>They exist because the phone path cannot be observed: this is the only way to see what
 * the user's download actually does — the redirect chain, the {@code Content-Length}/{@code
 * Content-Range} numbers, the resume request and whether the extracted tree passes
 * {@link KokoroStore#verify(File)}.
 */
public class KokoroStoreLiveTest {

    /** Same place the other debug workers write; never in the repo. */
    private static final File TMP = new File("../../.tmp/kokoro-debug").getAbsoluteFile();
    private static final File MARKER = new File(TMP, "live");
    /** Archive fetched with curl while investigating; only used to seed a resume. */
    private static final File REFERENCE_ARCHIVE = new File(TMP, "kokoro-multi-lang-v1_0.tar.bz2");

    private static void requireLive() {
        Assume.assumeTrue(
                "live download test disabled: create " + MARKER.getPath() + " to run it",
                MARKER.isFile() || Boolean.getBoolean("kokoro.live"));
    }

    /**
     * The half that runs after "100%": bzip2 + tar extraction, verification and the marker,
     * without touching the network. A complete {@code .part} makes {@code fetchArchive} skip the
     * transfer, which is exactly the state the phone is in when the download finishes.
     */
    @Test
    public void unpacksTheReferenceArchiveWithoutDownloading() throws Exception {
        requireLive();
        Assume.assumeTrue("reference archive not present", REFERENCE_ARCHIVE.isFile());
        assertEquals(
                "the reference archive must be the published one",
                KokoroModel.ARCHIVE_BYTES,
                REFERENCE_ARCHIVE.length());

        File root = new File(TMP, "live-extract");
        KokoroStore store = new KokoroStore(root);
        store.delete();
        assertTrue("expected at least 800 MB free", root.mkdirs() || root.isDirectory());

        File part = new File(root, ".model.tar.bz2.part");
        copyPrefix(REFERENCE_ARCHIVE, part, REFERENCE_ARCHIVE.length());
        assertEquals(KokoroModel.ARCHIVE_BYTES, store.partialBytes());

        long started = System.currentTimeMillis();
        long size = store.download(null);
        System.out.println("extracted and verified in " + (System.currentTimeMillis() - started)
                + " ms, " + size + " bytes");

        File modelDir = store.modelDir();
        assertNull("verify() reported: " + store.verify(modelDir), store.verify(modelDir));
        assertTrue(store.isDownloaded());
        assertTrue(new File(modelDir, KokoroModel.MARKER_FILE).isFile());
        assertEquals("the .part file must be removed after a success", 0L, store.partialBytes());
    }

    @Test
    public void downloadsExtractsAndVerifiesTheRealArchive() throws Exception {
        requireLive();
        File root = new File(TMP, "live-store");
        KokoroStore store = new KokoroStore(root);
        store.delete();
        assertEquals(0L, store.partialBytes());
        assertTrue(root.isDirectory() || root.mkdirs());
        assertTrue("expected at least 800 MB free", root.getUsableSpace() > 800_000_000L);

        long[] lastPercent = {-1};
        long size = store.download((fraction, bytes, total) -> {
            long percent = Math.round(fraction * 100);
            if (percent != lastPercent[0] && percent % 5 == 0) {
                lastPercent[0] = percent;
                System.out.println(String.format(
                        Locale.US, "download %3d%% %d/%d bytes", percent, bytes, total));
            }
        });
        System.out.println("download() returned " + size + " bytes");

        File modelDir = store.modelDir();
        assertNull("verify() reported: " + store.verify(modelDir), store.verify(modelDir));
        assertTrue(store.isDownloaded());
        assertTrue("marker missing", new File(modelDir, KokoroModel.MARKER_FILE).isFile());
        assertEquals("the .part file must be removed after a success", 0L, store.partialBytes());
        for (String name : KokoroModel.REQUIRED_FILES) {
            File f = new File(modelDir, name);
            System.out.println(name + " = " + f.length() + " bytes");
            assertTrue(name + " missing or empty", f.isFile() && f.length() > 0L);
        }
        assertTrue(new File(modelDir, KokoroModel.ESPEAK_DIR).isDirectory());
        assertEquals(size, store.sizeBytes());
    }

    @Test
    public void resumesAPartialArchiveWithARangeRequest() throws Exception {
        requireLive();
        Assume.assumeTrue("reference archive not present", REFERENCE_ARCHIVE.isFile());

        File root = new File(TMP, "live-resume");
        KokoroStore store = new KokoroStore(root);
        store.delete();
        assertTrue(root.isDirectory() || root.mkdirs());

        // Seed the .part with the real first 20 MiB so the Range request is servable and the
        // resulting archive is byte-identical to the published one.
        File part = new File(root, ".model.tar.bz2.part");
        long prefix = 20L * 1024 * 1024;
        copyPrefix(REFERENCE_ARCHIVE, part, prefix);
        assertEquals(prefix, store.partialBytes());

        long size = store.download(null);
        System.out.println("resumed download() returned " + size + " bytes");
        assertNull(store.verify(store.modelDir()));
        assertTrue(store.isDownloaded());
        assertEquals(0L, store.partialBytes());
    }

    private static void copyPrefix(File source, File target, long bytes) throws IOException {
        byte[] buffer = new byte[128 * 1024];
        long left = bytes;
        try (InputStream in = new FileInputStream(source);
             OutputStream out = new FileOutputStream(target)) {
            while (left > 0L) {
                int read = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                if (read < 0) {
                    break;
                }
                out.write(buffer, 0, read);
                left -= read;
            }
        }
        assertNotNull(target);
    }
}
