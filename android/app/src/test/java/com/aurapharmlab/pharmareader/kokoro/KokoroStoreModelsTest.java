package com.aurapharmlab.pharmareader.kokoro;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

/**
 * The two-model side of {@link KokoroStore}: the int8 install must verify even though its
 * graph is only 114 MB, the pinned SHA-256 must reject the garbage-audio export, both models
 * must be able to live side by side, and deleting one must not touch the other.
 *
 * <p>Sizes come from the descriptors, and the big files are sparse (a length with no data),
 * so these run on the JVM in a second or two without a 300 MB write.
 */
public class KokoroStoreModelsTest {

    @Test
    public void int8DescriptorCarriesThePublishedNumbers() {
        KokoroModel.Descriptor int8 = KokoroModel.INT8;
        assertEquals("int8", int8.key());
        assertEquals("kokoro-int8-multi-lang-v1_0", int8.id());
        assertEquals("model.int8.onnx", int8.modelFile());
        assertEquals(132_353_410L, int8.archiveBytes());
        assertEquals(114_202_993L, 114_202_993L);
        assertEquals(
                "75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e",
                int8.sha256Model());
        assertTrue(int8.downloadUrl().endsWith("kokoro-int8-multi-lang-v1_0.tar.bz2"));
        assertEquals(int8.archiveBytes() + int8.extractedBytes(), int8.requiredFreeBytes());
        // The fp32 constant of the same name stays the fp32 number.
        assertEquals(349_886_476L, KokoroModel.ARCHIVE_BYTES);
        assertEquals("fp32", KokoroModel.FP32.key());
        assertEquals(KokoroModel.FP32, KokoroModel.forKey("fp32"));
        // fp32 is the default again (v0.3.3 defaulted to int8, whose audio was rejected):
        // an old caller that names no build must get the full model.
        assertEquals(KokoroModel.KEY_FP32, KokoroModel.DEFAULT_KEY);
        assertEquals(KokoroModel.FP32, KokoroModel.forKey(null));
        assertEquals(KokoroModel.FP32, KokoroModel.forKey("nonsense"));
        assertEquals(KokoroModel.FP32, KokoroModel.forKey(KokoroModel.DEFAULT_KEY));
        assertEquals(KokoroModel.INT8, KokoroModel.forKey("int8"));
        assertEquals(KokoroModel.FP32, KokoroModel.other(KokoroModel.INT8));
        assertEquals(KokoroModel.INT8, KokoroModel.other(KokoroModel.FP32));
    }

    @Test
    public void int8LayoutVerifiesEvenThoughTheGraphIsOnly114Megabytes() throws IOException {
        File root = Files.createTempDirectory("kokoro-int8-verify").toFile();
        try {
            File dir = new File(root, KokoroModel.INT8.id());
            assertTrue(dir.mkdirs());
            // The published layout: the graph is 114 202 993 B, not the 200 000 000 B floor
            // the fp32 descriptor uses.
            writeSparse(new File(dir, KokoroModel.INT8_MODEL_FILE), 114_202_993L);
            writeSparse(new File(dir, KokoroModel.VOICES_FILE), 28_200_960L);
            writeSmall(new File(dir, KokoroModel.TOKENS_FILE), 687);
            writeSparse(new File(dir, KokoroModel.LEXICON_FILE), 5_956_885L);
            File espeak = new File(dir, KokoroModel.ESPEAK_DIR);
            assertTrue(espeak.mkdirs());
            writeSmall(new File(espeak, "en_dict"), 32);
            KokoroStore.writeMarker(dir, KokoroModel.INT8);

            KokoroStore store = new KokoroStore(root, KokoroModel.INT8);
            assertNull("verify() must accept the int8 sizes: " + store.verify(dir), store.verify(dir));
            assertTrue(store.isDownloaded());
            assertEquals(new File(root, "kokoro-int8-multi-lang-v1_0"), store.modelDir());

            // The same files would not pass the fp32 descriptor: this is the regression the
            // old single MIN_BYTES[0] = 200 MB table caused.
            File fp32Dir = new File(root, KokoroModel.FP32.id());
            assertTrue(fp32Dir.mkdirs());
            copyLayout(dir, fp32Dir);
            KokoroStore fp32 = new KokoroStore(root, KokoroModel.FP32);
            assertNotNull(fp32.verify(fp32Dir));
        } finally {
            KokoroStore.deleteRecursively(root);
        }
    }

    @Test
    public void rejectsAFileThatDoesNotMatchThePinnedDigest() throws IOException {
        File root = Files.createTempDirectory("kokoro-digest").toFile();
        try {
            // A small descriptor with its own pin, so the test does not hash 114 MB.
            File dir = new File(root, "small-model");
            assertTrue(dir.mkdirs());
            File graph = new File(dir, "model.onnx");
            writeSmall(graph, 64);
            String good = KokoroStore.sha256(graph);
            KokoroModel.Descriptor pinned = new KokoroModel.Descriptor(
                    "test",
                    "small-model",
                    "model.onnx",
                    100L,
                    100L,
                    new long[] {1L, 1L, 1L, 1L},
                    good,
                    "Test");
            assertNull(KokoroStore.verifyDigest(dir, pinned));

            KokoroModel.Descriptor wrong = new KokoroModel.Descriptor(
                    "test",
                    "small-model",
                    "model.onnx",
                    100L,
                    100L,
                    new long[] {1L, 1L, 1L, 1L},
                    "0000000000000000000000000000000000000000000000000000000000000000",
                    "Test");
            String problem = KokoroStore.verifyDigest(dir, wrong);
            assertNotNull(problem);
            assertTrue(problem, problem.contains("SHA-256"));
            assertTrue(problem, problem.contains("Delete the model and download it again"));

            // The real int8 pin must reject a file that is not the published graph.
            writeSmall(new File(dir, KokoroModel.INT8_MODEL_FILE), 64);
            String int8Problem = new KokoroStore(root, KokoroModel.INT8).verifyDigest(dir);
            assertNotNull(int8Problem);
            assertTrue(int8Problem, int8Problem.contains(KokoroModel.INT8_MODEL_SHA256));
        } finally {
            KokoroStore.deleteRecursively(root);
        }
    }

    @Test
    public void bothModelsLiveSideBySideAndDeleteRemovesOnlyOne() throws IOException {
        File root = Files.createTempDirectory("kokoro-both").toFile();
        try {
            install(root, KokoroModel.FP32);
            install(root, KokoroModel.INT8);
            KokoroStore fp32 = new KokoroStore(root, KokoroModel.FP32);
            KokoroStore int8 = new KokoroStore(root, KokoroModel.INT8);
            assertTrue(fp32.isDownloaded());
            assertTrue(int8.isDownloaded());
            assertFalse(fp32.modelDir().equals(int8.modelDir()));
            // Each build keeps its own partial archive name.
            assertFalse(fp32.partFile().equals(int8.partFile()));

            int8.delete();

            assertFalse("int8 dir must be gone", int8.modelDir().exists());
            assertTrue("fp32 must survive deleting int8", fp32.isDownloaded());
            assertTrue(fp32.modelDir().isDirectory());

            // And the fp32 store deletes only its own directory.
            fp32.delete();
            assertFalse(fp32.modelDir().exists());
        } finally {
            KokoroStore.deleteRecursively(root);
        }
    }

    @Test
    public void aPartialFp32DownloadFromTheOldNameIsStillCounted() throws IOException {
        File root = Files.createTempDirectory("kokoro-legacy-part").toFile();
        try {
            File legacy = new File(root, ".model.tar.bz2.part");
            writeSmall(legacy, 1024);
            // The one-argument constructor is the fp32 store the live tests build.
            KokoroStore fp32 = new KokoroStore(root);
            assertEquals(KokoroModel.FP32, fp32.descriptor());
            assertEquals(1024L, fp32.partialBytes());
            // int8 must not adopt the fp32 archive.
            assertEquals(0L, new KokoroStore(root, KokoroModel.INT8).partialBytes());
        } finally {
            KokoroStore.deleteRecursively(root);
        }
    }

    // ------------------------------------------------------------------ helpers

    /** A complete install with the smallest file contents the descriptor accepts. */
    private static void install(File root, KokoroModel.Descriptor model) throws IOException {
        File dir = new File(root, model.id());
        assertTrue(dir.isDirectory() || dir.mkdirs());
        String[] files = model.requiredFiles();
        long[] min = model.minBytes();
        for (int i = 0; i < files.length; i++) {
            writeSparse(new File(dir, files[i]), Math.max(1L, i < min.length ? min[i] : 1L));
        }
        File espeak = new File(dir, KokoroModel.ESPEAK_DIR);
        assertTrue(espeak.isDirectory() || espeak.mkdirs());
        writeSmall(new File(espeak, "en_dict"), 16);
        KokoroStore.writeMarker(dir, model);
    }

    private static void copyLayout(File from, File to) throws IOException {
        File[] children = from.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            File target = new File(to, child.getName());
            if (child.isDirectory()) {
                assertTrue(target.isDirectory() || target.mkdirs());
                copyLayout(child, target);
            } else {
                writeSparse(target, Math.max(1L, child.length()));
            }
        }
    }

    /** A file of {@code length} bytes with no data written (cheap even at 200 MB). */
    private static void writeSparse(File file, long length) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory()) {
            assertTrue(parent.mkdirs());
        }
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.setLength(length);
        }
    }

    private static void writeSmall(File file, int bytes) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory()) {
            assertTrue(parent.mkdirs());
        }
        try (OutputStream out = new FileOutputStream(file)) {
            out.write("x".repeat(bytes).getBytes(StandardCharsets.UTF_8));
        }
    }
}
