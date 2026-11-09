package com.aurapharmlab.pharmareader.kokoro;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Guards the download bookkeeping that decides whether a 334 MiB transfer resumes or starts
 * again, and the tar-entry path check that keeps an archive from writing outside its
 * scratch directory. These run on the JVM: no Android context and no network needed.
 */
public class KokoroStoreTest {

    // ------------------------------------------------------- Content-Range parsing

    @Test
    public void parsesTotalFromContentRange() {
        assertEquals(349_886_476L, KokoroStore.parseContentRangeTotal("bytes 0-99/349886476"));
        assertEquals(200L, KokoroStore.parseContentRangeTotal("bytes 100-199/200"));
        assertEquals(42L, KokoroStore.parseContentRangeTotal("bytes 0-0/42 "));
    }

    @Test
    public void rejectsUnparseableContentRange() {
        assertEquals(-1L, KokoroStore.parseContentRangeTotal(null));
        assertEquals(-1L, KokoroStore.parseContentRangeTotal(""));
        assertEquals(-1L, KokoroStore.parseContentRangeTotal("bytes 0-99/"));
        assertEquals(-1L, KokoroStore.parseContentRangeTotal("bytes 0-99"));
        assertEquals(-1L, KokoroStore.parseContentRangeTotal("bytes 0-99/*"));
    }

    // ------------------------------------------------------------- storage budget

    @Test
    public void requiresSpaceForArchiveAndUnpackedModel() {
        // The archive stays on disk (for resume) while it is unpacked, so both exist at peak.
        assertEquals(
                KokoroModel.ARCHIVE_BYTES + KokoroModel.EXTRACTED_BYTES,
                KokoroModel.REQUIRED_FREE_BYTES);
        assertTrue(
                "the pre-check must cover ~750 MB",
                KokoroModel.REQUIRED_FREE_BYTES >= 750_000_000L);
        assertTrue(KokoroModel.REQUIRED_FREE_BYTES > KokoroModel.EXTRACTED_BYTES);
    }

    @Test
    public void storageFailureIsAnIoFailure() {
        KokoroStore.StorageException failure = new KokoroStore.StorageException("no space");
        assertTrue(failure instanceof IOException);
        assertEquals("no space", failure.getMessage());
    }

    // --------------------------------------------------------------- tar entries

    @Test
    public void resolvesEntriesInsideTheScratchDirectory() throws IOException {
        File scratch = Files.createTempDirectory("kokoro-scratch").toFile();
        try {
            File entry = KokoroStore.safeResolve(scratch, "kokoro-multi-lang-v1_0/model.onnx");
            assertTrue(entry.getCanonicalPath().startsWith(scratch.getCanonicalPath()));
            assertEquals("model.onnx", entry.getName());
            // Absolute-looking names are treated as relative, never as absolute paths.
            File absolute = KokoroStore.safeResolve(scratch, "/etc/passwd");
            assertTrue(absolute.getCanonicalPath().startsWith(scratch.getCanonicalPath()));
        } finally {
            KokoroStore.deleteRecursively(scratch);
        }
    }

    @Test
    public void refusesEntriesThatEscapeTheScratchDirectory() throws IOException {
        File scratch = Files.createTempDirectory("kokoro-scratch").toFile();
        try {
            for (String hostile : new String[] {"../escape.bin", "a/../../escape.bin", "..\\..\\escape.bin"}) {
                try {
                    KokoroStore.safeResolve(scratch, hostile);
                    fail("accepted a path outside the scratch directory: " + hostile);
                } catch (IOException expected) {
                    assertNotNull(expected.getMessage());
                }
            }
        } finally {
            KokoroStore.deleteRecursively(scratch);
        }
    }

    // ------------------------------------------------------------- file helpers

    @Test
    public void directorySizeCountsNestedFiles() throws IOException {
        File root = Files.createTempDirectory("kokoro-size").toFile();
        try {
            writeFile(new File(root, "a.bin"), 10);
            File nested = new File(root, "espeak-ng-data");
            assertTrue(nested.mkdirs());
            writeFile(new File(nested, "b.bin"), 5);
            assertEquals(15L, KokoroStore.directorySize(root));
            assertEquals(0L, KokoroStore.directorySize(new File(root, "missing")));
        } finally {
            KokoroStore.deleteRecursively(root);
        }
    }

    @Test
    public void deleteRecursivelyRemovesEverythingAndIsIdempotent() throws IOException {
        File root = Files.createTempDirectory("kokoro-delete").toFile();
        File nested = new File(root, "a/b");
        assertTrue(nested.mkdirs());
        writeFile(new File(nested, "c.bin"), 3);
        KokoroStore.deleteRecursively(root);
        assertFalse(root.exists());
        KokoroStore.deleteRecursively(root); // second call must not throw
        KokoroStore.deleteRecursively(null);
    }

    private static void writeFile(File file, int bytes) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write("x".repeat(bytes).getBytes(StandardCharsets.UTF_8));
        }
    }
}
