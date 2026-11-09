package com.aurapharmlab.pharmareader.kokoro;

/**
 * Static description of the Kokoro-82M speech model that this plugin downloads at
 * runtime.
 *
 * <p>Model choice: {@code kokoro-multi-lang-v1_0} (fp32, 53 speakers, 24000 Hz) from the
 * official sherpa-onnx {@code tts-models} release. It is Kokoro v1.0, i.e. the quality
 * generation after the original v0.19, and unlike the int8 variants the fp32 graph runs
 * faster on phone CPUs. The archive is <em>not</em> bundled in the APK: it is 333.7 MiB
 * and Google Play / the user's storage should decide.
 *
 * <p>The plugin pairs this model with sherpa-onnx 1.13.8, whose Kokoro frontend uses
 * {@code lexicon-us-en.txt} first and espeak-ng (bundled, GPL-3.0) for every word the
 * lexicon does not know. That fallback is what keeps drug names such as "digoxin" or
 * "fluoxetine" pronounceable; newer sherpa-onnx releases dropped espeak-ng and silently
 * skip out-of-vocabulary words.
 */
public final class KokoroModel {

    /** Identifier reported to the web layer (also stored in the ".ready" marker). */
    public static final String ID = "kokoro-multi-lang-v1_0";

    /** Where the archive is fetched from. */
    public static final String DOWNLOAD_URL =
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                    + ID + ".tar.bz2";

    /** Human readable source page for the model, shown in the panel. */
    public static final String SOURCE_URL =
            "https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models";

    /** Exact byte size of the .tar.bz2 archive (used until the HTTP response confirms it). */
    public static final long ARCHIVE_BYTES = 349_886_476L;

    /** Rough size of the extracted model directory, for the "no space" pre-check (bytes). */
    public static final long EXTRACTED_BYTES = 420_000_000L;

    /**
     * Free storage the download needs: the archive is kept on disk (for resume) while it is
     * unpacked, so both exist at peak. ~734 MiB, i.e. "about 750 MB" in the UI.
     */
    public static final long REQUIRED_FREE_BYTES = ARCHIVE_BYTES + EXTRACTED_BYTES;

    /** Shown in the UI and in the license notice. */
    public static final String ATTRIBUTION =
            "Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)";

    public static final String MODEL_FILE = "model.onnx";
    public static final String VOICES_FILE = "voices.bin";
    public static final String TOKENS_FILE = "tokens.txt";
    public static final String LEXICON_FILE = "lexicon-us-en.txt";
    public static final String ESPEAK_DIR = "espeak-ng-data";
    public static final String MARKER_FILE = ".ready";

    /** Files that must exist (and be non-empty) inside the extracted model directory. */
    public static final String[] REQUIRED_FILES = {
            MODEL_FILE, VOICES_FILE, TOKENS_FILE, LEXICON_FILE
    };

    /** Directories that must exist inside the extracted model directory. */
    public static final String[] REQUIRED_DIRS = {ESPEAK_DIR};

    /** Minimum plausible size per required file, to catch truncated/interrupted extracts. */
    public static final long[] MIN_BYTES = {200_000_000L, 1_000_000L, 1L, 1_000_000L};

    /** af_heart: the voice the Kokoro authors recommend for a neutral US English read. */
    public static final int DEFAULT_SID = 3;

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

    private KokoroModel() {}

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
}
