package com.aurapharmlab.pharmareader.kokoro;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** The WAV container is written by hand, so its header is worth pinning down. */
public class WavWriterTest {

    private static final int SAMPLE_RATE = 24000;

    @Test
    public void headerDescribes16BitMonoPcm() {
        float[] samples = new float[100];
        byte[] wav = WavWriter.toBytes(samples, SAMPLE_RATE);
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);

        assertEquals("RIFF", ascii(wav, 0, 4));
        assertEquals(36 + samples.length * 2, buffer.getInt(4));
        assertEquals("WAVE", ascii(wav, 8, 4));
        assertEquals("fmt ", ascii(wav, 12, 4));
        assertEquals(16, buffer.getInt(16));
        assertEquals(1, buffer.getShort(20)); // PCM
        assertEquals(1, buffer.getShort(22)); // mono
        assertEquals(SAMPLE_RATE, buffer.getInt(24));
        assertEquals(SAMPLE_RATE * 2, buffer.getInt(28)); // byte rate
        assertEquals(2, buffer.getShort(32)); // block align
        assertEquals(16, buffer.getShort(34)); // bits per sample
        assertEquals("data", ascii(wav, 36, 4));
        assertEquals(samples.length * 2, buffer.getInt(40));
        assertEquals(WavWriter.byteSize(samples.length), wav.length);
    }

    @Test
    public void samplesAreClampedAndScaled() {
        assertEquals(0, WavWriter.toPcm16(0f));
        assertEquals(32767, WavWriter.toPcm16(1f));
        assertEquals(-32767, WavWriter.toPcm16(-1f));
        assertEquals(32767, WavWriter.toPcm16(4f)); // clipping, not wrapping
        assertEquals(-32767, WavWriter.toPcm16(-4f));
        assertEquals(0, WavWriter.toPcm16(Float.NaN));
        assertEquals(16384, WavWriter.toPcm16(0.5f));

        byte[] wav = WavWriter.toBytes(new float[] {1f, -1f}, SAMPLE_RATE);
        ByteBuffer buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(32767, buffer.getShort(44));
        assertEquals(-32767, buffer.getShort(46));
    }

    @Test
    public void durationFollowsSampleRate() {
        assertEquals(1000L, WavWriter.durationMs(SAMPLE_RATE, SAMPLE_RATE));
        assertEquals(500L, WavWriter.durationMs(SAMPLE_RATE / 2, SAMPLE_RATE));
        assertEquals(0L, WavWriter.durationMs(1000, 0));
    }

    @Test
    public void writeCreatesParentDirectories() throws Exception {
        File dir = Files.createTempDirectory("kokoro-wav").toFile();
        File target = new File(new File(dir, "nested"), "sentence.wav");
        try {
            WavWriter.write(target, new float[] {0f, 0.25f}, SAMPLE_RATE);
            assertTrue(target.isFile());
            assertEquals(WavWriter.byteSize(2), target.length());
            byte[] onDisk = Files.readAllBytes(target.toPath());
            assertArrayEquals(WavWriter.toBytes(new float[] {0f, 0.25f}, SAMPLE_RATE), onDisk);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            //noinspection ResultOfMethodCallIgnored
            target.getParentFile().delete();
            //noinspection ResultOfMethodCallIgnored
            dir.delete();
        }
    }

    private static String ascii(byte[] data, int offset, int length) {
        return new String(data, offset, length, StandardCharsets.US_ASCII);
    }
}
