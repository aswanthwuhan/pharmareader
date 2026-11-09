package com.aurapharmlab.pharmareader.kokoro;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Guards the speaker table against a copy/paste slip: ids here are sent to sherpa-onnx. */
public class KokoroModelTest {

    @Test
    public void speakerTableMatchesTheModelCard() {
        assertEquals(53, KokoroModel.count());
        assertEquals("af_alloy", KokoroModel.nameFor(0));
        assertEquals("af_heart", KokoroModel.nameFor(3));
        assertEquals("am_adam", KokoroModel.nameFor(11));
        assertEquals("bm_lewis", KokoroModel.nameFor(27));
        assertEquals("zm_yunyang", KokoroModel.nameFor(52));
        assertEquals("speaker-99", KokoroModel.nameFor(99));
        assertEquals(3, KokoroModel.DEFAULT_SID);
    }

    @Test
    public void namesRoundTripToIds() {
        for (int sid = 0; sid < KokoroModel.count(); sid++) {
            assertEquals(sid, KokoroModel.idFor(KokoroModel.nameFor(sid)));
        }
        assertEquals(-1, KokoroModel.idFor("af_nobody"));
        assertEquals(-1, KokoroModel.idFor(null));
        assertEquals(3, KokoroModel.idFor("af_heart"));
    }

    @Test
    public void languagesComeFromTheVoicePrefix() {
        assertEquals("en-US", KokoroModel.langFor(0));
        assertEquals("en-GB", KokoroModel.langFor(20));
        assertEquals("es", KokoroModel.langFor(28));
        assertEquals("fr", KokoroModel.langFor(30));
        assertEquals("hi", KokoroModel.langFor(31));
        assertEquals("it", KokoroModel.langFor(35));
        assertEquals("ja", KokoroModel.langFor(37));
        assertEquals("pt", KokoroModel.langFor(42));
        assertEquals("zh", KokoroModel.langFor(45));
        assertTrue(KokoroModel.isEnglish(27));
        assertFalse(KokoroModel.isEnglish(28));
        assertEquals(28, KokoroModel.englishSids().length);
    }

    @Test
    public void requiredFilesCoverTheModelDirectory() {
        assertEquals(4, KokoroModel.REQUIRED_FILES.length);
        assertEquals(KokoroModel.REQUIRED_FILES.length, KokoroModel.MIN_BYTES.length);
        assertTrue(KokoroModel.ARCHIVE_BYTES > 300_000_000L);
        assertTrue(KokoroModel.DOWNLOAD_URL.endsWith("kokoro-multi-lang-v1_0.tar.bz2"));
    }
}
