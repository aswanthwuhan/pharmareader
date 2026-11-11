package com.aurapharmlab.pharmareader.kokoro;

/**
 * Description of the Kokoro-82M speech models that this plugin downloads at runtime.
 *
 * <p>Two builds of the same 53-speaker, 24000 Hz model can sit side by side on disk:
 *
 * <ul>
 *   <li>{@link #FP32} — {@code kokoro-multi-lang-v1_0}, the full-precision graph. It is
 *       what this plugin shipped first, what it speaks with, and the reference for quality;
 *       it is 310 MB of weights and heats a phone under load.
 *   <li>{@link #INT8} — {@code kokoro-int8-multi-lang-v1_0}, the int8-quantised graph
 *       (114 MB). Same voices, same speaker ids, same 24 kHz output. v0.3.3 defaulted to
 *       it, but its audio was rejected in use, so it is no longer offered: the entry stays
 *       only so the app can report and delete files an earlier version downloaded.
 * </ul>
 *
 * <p>Neither is <em>bundled</em> in the APK: the archives are 132 MB and 334 MB and
 * Google Play / the user's storage should decide. Each is unpacked into its own
 * {@code filesDir/kokoro/<id>/} directory so the two can coexist.
 *
 * <p>The plugin pairs the model with sherpa-onnx 1.13.8, whose Kokoro frontend uses
 * {@code lexicon-us-en.txt} first and espeak-ng (bundled, GPL-3.0) for every word the
 * lexicon does not know. That fallback is what keeps drug names such as "digoxin" or
 * "fluoxetine" pronounceable; newer sherpa-onnx releases dropped espeak-ng and silently
 * skip out-of-vocabulary words.
 *
 * <p>The per-model identity lives in the {@link Descriptor} table below: directory name,
 * archive size, unpacked size, graph file name, minimum file sizes and (for int8) the
 * SHA-256 of the graph. Nothing else in the plugin hardcodes a model size or file name.
 *
 * <p>The default build is fp32 and must stay first in {@link #ALL}: an old caller that
 * knows nothing about a model choice resolves to it.
 */
public final class KokoroModel {

    /** Key of the lighter int8 graph. Not offered any more; kept to find and delete it. */
    public static final String KEY_INT8 = "int8";

    /** Key the web layer uses for the full-precision graph, and its persisted setting. */
    public static final String KEY_FP32 = "fp32";

    /** Build a new install downloads and speaks with: the full-precision graph. */
    public static final String DEFAULT_KEY = KEY_FP32;

    /** Human readable source page for the models, shown in the panel. */
    public static final String SOURCE_URL =
            "https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models";

    /** Shown in the UI and in the license notice. */
    public static final String ATTRIBUTION =
            "Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)";

    public static final String VOICES_FILE = "voices.bin";
    public static final String TOKENS_FILE = "tokens.txt";
    public static final String LEXICON_FILE = "lexicon-us-en.txt";
    public static final String ESPEAK_DIR = "espeak-ng-data";
    public static final String MARKER_FILE = ".ready";

    /** Suffix of the partially downloaded archive kept for resume, per model directory. */
    public static final String ARCHIVE_PART_SUFFIX = ".tar.bz2.part";

    /** Directories that must exist inside every extracted model directory. */
    public static final String[] REQUIRED_DIRS = {ESPEAK_DIR};

    /** af_heart: the voice the Kokoro authors recommend for a neutral US English read. */
    public static final int DEFAULT_SID = 3;

    // ---------------------------------------------------------------------------------
    // fp32 (kokoro-multi-lang-v1_0): the model this plugin shipped before int8 existed.
    // ---------------------------------------------------------------------------------

    /** Directory name, archive name and reported model id of the fp32 build. */
    public static final String FP32_ID = "kokoro-multi-lang-v1_0";

    /** Graph file inside the fp32 model directory. */
    public static final String MODEL_FILE = "model.onnx";

    /** Exact byte size of the fp32 .tar.bz2 archive (used until HTTP confirms it). */
    public static final long ARCHIVE_BYTES = 349_886_476L;

    /** Rough size of the extracted fp32 model directory, for the "no space" pre-check. */
    public static final long EXTRACTED_BYTES = 420_000_000L;

    /**
     * Free storage the fp32 download needs: the archive is kept on disk (for resume) while
     * it is unpacked, so both exist at peak. ~734 MiB, i.e. "about 750 MB" in the UI.
     */
    public static final long REQUIRED_FREE_BYTES = ARCHIVE_BYTES + EXTRACTED_BYTES;

    /** Minimum plausible size per required fp32 file, to catch truncated extracts. */
    public static final long[] MIN_BYTES = {200_000_000L, 1_000_000L, 1L, 1_000_000L};

    /** Files that must exist (and be non-empty) inside every extracted model directory. */
    public static final String[] REQUIRED_FILES = {
            MODEL_FILE, VOICES_FILE, TOKENS_FILE, LEXICON_FILE
    };

    /** Legacy alias: the fp32 model id, still reported by older callers. */
    public static final String ID = FP32_ID;

    /** Legacy alias: where the fp32 archive is fetched from. */
    public static final String DOWNLOAD_URL = downloadUrl(FP32_ID);

    // ---------------------------------------------------------------------------------
    // int8 (kokoro-int8-multi-lang-v1_0): same voices, 114 MB graph, less heat.
    // ---------------------------------------------------------------------------------

    /** Directory name, archive name and reported model id of the int8 build. */
    public static final String INT8_ID = "kokoro-int8-multi-lang-v1_0";

    /** Graph file inside the int8 model directory. */
    public static final String INT8_MODEL_FILE = "model.int8.onnx";

    /** Exact byte size of the int8 archive. */
    public static final long INT8_ARCHIVE_BYTES = 132_353_410L;

    /**
     * Rough size of the extracted int8 model directory. The real tree is 189 878 541 B;
     * the extra head-room only makes the "no space" pre-check slightly conservative.
     */
    public static final long INT8_EXTRACTED_BYTES = 200_000_000L;

    /** Minimum plausible size per required int8 file (voices.bin is the big one here). */
    public static final long[] INT8_MIN_BYTES = {100_000_000L, 1_000_000L, 1L, 1_000_000L};

    /**
     * SHA-256 of {@code model.int8.onnx} in the published archive.
     *
     * <p>This is not paranoia: the int8 export published before 2026-10-26 produced NaN
     * activations on Android arm64 (sherpa-onnx PR #4087), i.e. a graph that loads, reports
     * the right sizes and plays loud garbage. A digest mismatch is refused with a message
     * telling the user to delete and download again.
     */
    public static final String INT8_MODEL_SHA256 =
            "75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e";

    // ---------------------------------------------------------------------------------
    // The descriptor table.
    // ---------------------------------------------------------------------------------

    /** Full-precision Kokoro v1.0. */
    public static final Descriptor FP32 = new Descriptor(
            KEY_FP32,
            FP32_ID,
            MODEL_FILE,
            ARCHIVE_BYTES,
            EXTRACTED_BYTES,
            MIN_BYTES,
            null,
            "Full precision");

    /** Int8-quantised Kokoro v1.0. No longer offered; kept so old files can be deleted. */
    public static final Descriptor INT8 = new Descriptor(
            KEY_INT8,
            INT8_ID,
            INT8_MODEL_FILE,
            INT8_ARCHIVE_BYTES,
            INT8_EXTRACTED_BYTES,
            INT8_MIN_BYTES,
            INT8_MODEL_SHA256,
            "Lighter (int8)");

    /** Every model this build can report and delete, default first. */
    public static final Descriptor[] ALL = {FP32, INT8};

    private KokoroModel() {}

    /**
     * One downloadable model: everything the store, the engine and the panel need to know
     * about it that is not shared with the other build.
     */
    public static final class Descriptor {

        private final String key;
        private final String id;
        private final String modelFile;
        private final long archiveBytes;
        private final long extractedBytes;
        private final long[] minBytes;
        private final String sha256Model;
        private final String label;

        Descriptor(
                String key,
                String id,
                String modelFile,
                long archiveBytes,
                long extractedBytes,
                long[] minBytes,
                String sha256Model,
                String label) {
            this.key = key;
            this.id = id;
            this.modelFile = modelFile;
            this.archiveBytes = archiveBytes;
            this.extractedBytes = extractedBytes;
            this.minBytes = minBytes.clone();
            this.sha256Model = sha256Model;
            this.label = label;
        }

        /** Short key the JS layer passes around ({@code "int8"} / {@code "fp32"}). */
        public String key() {
            return key;
        }

        /** Directory name under {@code filesDir/kokoro/}, archive name and reported id. */
        public String id() {
            return id;
        }

        /** Graph file name inside the model directory. */
        public String modelFile() {
            return modelFile;
        }

        public long archiveBytes() {
            return archiveBytes;
        }

        public long extractedBytes() {
            return extractedBytes;
        }

        /** Minimum plausible size per entry of {@link #requiredFiles()}. */
        public long[] minBytes() {
            return minBytes.clone();
        }

        /** SHA-256 of the graph file, or null when the build is not checked by digest. */
        public String sha256Model() {
            return sha256Model;
        }

        /** Short human label used by the panel ("Lighter (int8)", "Full precision"). */
        public String label() {
            return label;
        }

        /** Where the archive is fetched from. */
        public String downloadUrl() {
            return KokoroModel.downloadUrl(id);
        }

        /** Archive plus unpacked tree: both exist while the archive is unpacked. */
        public long requiredFreeBytes() {
            return archiveBytes + extractedBytes;
        }

        /** Files that must exist (and be non-empty) inside this model's directory. */
        public String[] requiredFiles() {
            return new String[] {modelFile, VOICES_FILE, TOKENS_FILE, LEXICON_FILE};
        }

        /** Partially downloaded archive kept for resume, inside this model's parent. */
        public String archivePartName() {
            return id + ARCHIVE_PART_SUFFIX;
        }

        /** True when this descriptor is the int8 build (used for the digest and the copy). */
        public boolean isInt8() {
            return KEY_INT8.equals(key);
        }

        @Override
        public String toString() {
            return key + " (" + id + ")";
        }
    }

    /** The archive URL for a model id. */
    public static String downloadUrl(String modelId) {
        return "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                + modelId + ".tar.bz2";
    }

    /**
     * Descriptor for a key or model id, case insensitive. A null, blank or unknown value
     * resolves to the default model ({@link #FP32}) so an old caller that knows nothing
     * about model choice still speaks the build this plugin ships with.
     */
    public static Descriptor forKey(String key) {
        if (key != null) {
            String trimmed = key.trim();
            for (Descriptor descriptor : ALL) {
                if (descriptor.key.equalsIgnoreCase(trimmed) || descriptor.id.equalsIgnoreCase(trimmed)) {
                    return descriptor;
                }
            }
        }
        return FP32;
    }

    /** The other model of the pair (fp32 for int8, int8 for fp32). */
    public static Descriptor other(Descriptor descriptor) {
        return descriptor != null && descriptor.isInt8() ? FP32 : INT8;
    }

    public static int count() {
        return VOICE_NAMES.length;
    }

    /** Speaker name for an id, or "speaker-N" when the id is outside the table. */
    public static String nameFor(int sid) {
        if (sid >= 0 && sid < VOICE_NAMES.length) {
            return VOICE_NAMES[sid];
        }
        return "speaker-" + sid;
    }

    /** Speaker id for a name (case insensitive), or -1. */
    public static int idFor(String name) {
        if (name == null) {
            return -1;
        }
        for (int i = 0; i < VOICE_NAMES.length; i++) {
            if (VOICE_NAMES[i].equalsIgnoreCase(name.trim())) {
                return i;
            }
        }
        return -1;
    }

    /**
     * BCP-47-ish language tag derived from the Kokoro voice prefix
     * (af/am = en-US, bf/bm = en-GB, ef/em = es, ff = fr, hf/hm = hi, if/im = it,
     * jf/jm = ja, pf/pm = pt, zf/zm = zh).
     */
    public static String langFor(int sid) {
        if (sid < 0 || sid >= VOICE_NAMES.length) {
            return "";
        }
        char prefix = VOICE_NAMES[sid].charAt(0);
        switch (prefix) {
            case 'a':
                return "en-US";
            case 'b':
                return "en-GB";
            case 'e':
                return "es";
            case 'f':
                return "fr";
            case 'h':
                return "hi";
            case 'i':
                return "it";
            case 'j':
                return "ja";
            case 'p':
                return "pt";
            case 'z':
                return "zh";
            default:
                return "";
        }
    }

    /** True when the speaker speaks English (either accent). */
    public static boolean isEnglish(int sid) {
        String lang = langFor(sid);
        return lang.startsWith("en");
    }

    /** The English voices, in model order — what the reader offers for pharmacology text. */
    public static int[] englishSids() {
        int n = 0;
        for (int i = 0; i < VOICE_NAMES.length; i++) {
            if (isEnglish(i)) {
                n++;
            }
        }
        int[] out = new int[n];
        int k = 0;
        for (int i = 0; i < VOICE_NAMES.length; i++) {
            if (isEnglish(i)) {
                out[k++] = i;
            }
        }
        return out;
    }

    /** Speaker id -> speaker name, in model order (ids 0..52). */
    public static final String[] VOICE_NAMES = {
            "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
            "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
            "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
            "am_onyx", "am_puck", "am_santa",
            "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
            "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
            "ef_dora", "em_alex", "ff_siwis",
            "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
            "if_sara", "im_nicola",
            "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
            "pf_dora", "pm_alex", "pm_santa",
            "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
            "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    };
}
