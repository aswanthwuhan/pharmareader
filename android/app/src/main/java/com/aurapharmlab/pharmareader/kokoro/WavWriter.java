package com.aurapharmlab.pharmareader.kokoro;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * Writes Kokoro's float samples as a 16-bit PCM mono WAV file.
 *
 * <p>Deliberately Android-free so it can be unit tested on the JVM: 16-bit mono is what
 * every Android/WebView decoder accepts without questions, and a hand-written header is
 * cheaper and more predictable than going through {@code GeneratedAudio.save()}.
 */
public final class WavWriter {

    public static final int HEADER_BYTES = 44;
    private static final int BITS_PER_SAMPLE = 16;
    private static final short PCM_FORMAT = 1;

    private WavWriter() {}

    /** Size of the WAV produced for {@code sampleCount} samples at 16-bit mono. */
    public static int byteSize(int sampleCount) {
        return HEADER_BYTES + sampleCount * 2;
    }

    /** Duration of {@code sampleCount} samples in milliseconds (truncating). */
    public static long durationMs(int sampleCount, int sampleRate) {
        if (sampleRate <= 0) {
            return 0L;
        }
        return Math.round(sampleCount * 1000.0 / sampleRate);
    }

    /** Clamp a float sample to [-1, 1] and convert it to signed 16-bit PCM. */
    public static short toPcm16(float sample) {
        if (Float.isNaN(sample)) {
            return 0;
        }
        float clamped = sample > 1f ? 1f : (sample < -1f ? -1f : sample);
        // 32767 rather than 32768 keeps the mapping symmetric.
        int value = Math.round(clamped * 32767f);
        if (value > Short.MAX_VALUE) {
            value = Short.MAX_VALUE;
        } else if (value < Short.MIN_VALUE) {
            value = Short.MIN_VALUE;
        }
        return (short) value;
    }

    /** Encode samples as a complete WAV file in memory. */
    public static byte[] toBytes(float[] samples, int sampleRate) {
        int sampleCount = samples == null ? 0 : samples.length;
        ByteBuffer buffer =
                ByteBuffer.allocate(byteSize(sampleCount)).order(ByteOrder.LITTLE_ENDIAN);
        int dataBytes = sampleCount * 2;

        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(36 + dataBytes);
        buffer.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buffer.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(16); // PCM chunk size
        buffer.putShort(PCM_FORMAT);
        buffer.putShort((short) 1); // mono
        buffer.putInt(sampleRate);
        buffer.putInt(sampleRate * 2); // byte rate = rate * channels * bytesPerSample
        buffer.putShort((short) 2); // block align
        buffer.putShort((short) BITS_PER_SAMPLE);
        buffer.put("data".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(dataBytes);
        for (int i = 0; i < sampleCount; i++) {
            buffer.putShort(toPcm16(samples[i]));
        }
        return buffer.array();
    }

    /** Encode and write straight to a file, creating parent directories. */
    public static void write(File file, float[] samples, int sampleRate) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
            throw new IOException("Cannot create directory " + parent.getAbsolutePath());
        }
        byte[] bytes = toBytes(samples, sampleRate);
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
            out.write(bytes);
        }
    }
}
