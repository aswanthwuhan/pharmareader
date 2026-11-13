#!/usr/bin/env node
/**
 * Pharmacy Reader — mobile Safari smoke test in a real iOS Simulator.
 *
 * Windows cannot run an iOS Simulator, so this runs on a GitHub macOS runner
 * against either the live site or a build of the pushed working tree served from
 * http://localhost:4173/pharmareader/ (see IOS_SIM_BUILD). It drives Safari through
 * Appium (XCUITest + WebDriverAgent builds itself on first use) or, when
 * IOS_SIM_DRIVER=safaridriver, through the WebDriver agent Apple ships with macOS.
 *
 * Nothing here may abort the run: every step is attempted, its screenshot and page
 * source land in ios-sim-artifacts/, and summary.json says what passed. The process
 * always exits 0 — a red run is the workflow's job, a readable report is this one's.
 *
 * Environment:
 *   IOS_SIM_URL               page to open (default: the live GitHub Pages build)
 *   IOS_SIM_BUILD             'true' when the workflow built the working tree and
 *                             serves it under /pharmareader/ on this Mac's port 4173
 *   IOS_SIM_DRIVER            appium | safaridriver
 *   IOS_SIM_UDID              simulator to drive (set by pick-sim.mjs)
 *   IOS_SIM_PLATFORM_VERSION  e.g. 18.5
 *   IOS_SIM_DEVICE_NAME       e.g. iPhone 16
 *   IOS_SIM_ARTIFACTS         output folder (default: ios-sim-artifacts)
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const ARTIFACTS = path.resolve(process.env.IOS_SIM_ARTIFACTS || 'ios-sim-artifacts');
const URL_BASE = process.env.IOS_SIM_URL || 'https://aswanthwuhan.github.io/pharmareader/';
const DRIVER = (process.env.IOS_SIM_DRIVER || 'appium').toLowerCase();
const UDID = process.env.IOS_SIM_UDID || '';
const PLATFORM_VERSION = process.env.IOS_SIM_PLATFORM_VERSION || '';
const DEVICE_NAME = process.env.IOS_SIM_DEVICE_NAME || 'iPhone';
const APPIUM_PORT = Number(process.env.IOS_SIM_APPIUM_PORT || 4723);
const SAFARIDRIVER_PORT = Number(process.env.IOS_SIM_SAFARIDRIVER_PORT || 4444);
const RUN_BUDGET_MS = Number(process.env.IOS_SIM_BUDGET_MS || 32 * 60 * 1000);
const LOCAL_BUILD = String(process.env.IOS_SIM_BUILD || '').toLowerCase() === 'true';

/* --- Fixtures --------------------------------------------------------------
   A text file the reader can speak, and a one-page PDF whose text layer says
   something a pharmacy student would recognise. The PDF is a hand-written
   document (Helvetica, one page, 95 characters) rather than a binary blob: it is
   verified to parse with the repo's pdfjs-dist, and 95 chars per page keeps the
   app above its "looks scanned" cut-off so the import takes the normal path.
   -------------------------------------------------------------------------- */
const TXT_NAME = 'ios-sim-notes.txt';
const TXT_TITLE = 'ios sim notes';
const TXT_BODY = [
  'Atropine is a muscarinic antagonist.',
  'It blocks the effects of acetylcholine at muscarinic receptors and is used for bradycardia.',
].join('\n\n');

const PDF_NAME = 'ios-sim-atropine.pdf';
const PDF_TITLE = 'ios sim atropine';
const PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNDEgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKEF0cm9waW5lIGJsb2NrcyBtdXNjYXJpbmljIHJlY2VwdG9ycykgVGogMCAtMjYgVGQgKEl0IGlzIGdpdmVuIGZvciBicmFkeWNhcmRpYSBhbmQgb3JnYW5vcGhvc3BoYXRlIHBvaXNvbmluZy4pIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwNDMyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNTI5CiUlRU9GCg==';

/* --- Logging --------------------------------------------------------------- */
const logLines = [];
const records = [];

function now() {
  return new Date().toISOString();
}

function message(error) {
  return error && error.message ? String(error.message) : String(error);
}

/** One JSON object per line on stdout: the workflow log is the primary record. */
function log(entry) {
  const line = JSON.stringify({ at: now(), ...entry });
  logLines.push(line);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --- Page scripts -----------------------------------------------------------
   Sent to Safari with executeScript. They must not close over anything from this
   module: WebDriver serialises the function body only, so every input is an
   argument and every output is plain JSON.
   -------------------------------------------------------------------------- */

/** Collects window errors for the rest of this document's life. */
function installCollector() {
  const state = window.__pharmareaderIosSim || (window.__pharmareaderIosSim = { errors: [], rejections: [] });
  if (!state.listening) {
    state.listening = true;
    window.addEventListener(
      'error',
      function (event) {
        const target = event && event.target;
        if (target && target !== window && target.tagName) {
          state.errors.push({ kind: 'resource', message: String(target.tagName) + ' ' + String(target.src || target.href || '') });
          return;
        }
        state.errors.push({
          kind: 'error',
          message: String((event && (event.message || (event.error && event.error.message))) || 'unknown error'),
          source: String((event && event.filename) || ''),
          line: Number((event && event.lineno) || 0),
        });
      },
      true,
    );
    window.addEventListener('unhandledrejection', function (event) {
      let reason = '';
      try {
        const raw = event && event.reason;
        reason = typeof raw === 'string' ? raw : String((raw && (raw.stack || raw.message)) || raw);
      } catch (error) {
        reason = 'unprintable rejection';
      }
      state.rejections.push({ message: reason.slice(0, 600) });
    });
  }
  return { ok: true, userAgent: navigator.userAgent, href: location.href };
}

/** Errors, user agent and service worker state for the document on screen now. */
function readPageState() {
  const state = window.__pharmareaderIosSim || { errors: [], rejections: [] };
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  return {
    ok: true,
    href: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    readyState: document.readyState,
    errors: (state.errors || []).slice(0, 25),
    rejections: (state.rejections || []).slice(0, 25),
    serviceWorker: sw
      ? {
          supported: true,
          controller: !!sw.controller,
          scriptUrl: sw.controller ? String(sw.controller.scriptURL) : null,
        }
      : { supported: false, controller: false, scriptUrl: null },
    online: navigator.onLine,
  };
}

/** True once the app shell has painted the Library page. */
function pageLibraryReady() {
  const root = document.getElementById('root');
  const text = root ? root.innerText || '' : '';
  return {
    ok: text.indexOf('Library') >= 0 && text.trim().length > 40 && document.readyState !== 'loading',
    href: location.href,
    readyState: document.readyState,
    rootText: text.replace(/\s+/g, ' ').trim().slice(0, 160),
  };
}

function pageAlive() {
  return { ok: !!document.body && document.readyState !== 'loading', href: location.href, readyState: document.readyState };
}

function pageHasFileInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  return {
    ok: inputs.length > 0 && !!document.querySelector('.library'),
    count: inputs.length,
    href: location.href,
  };
}

/** Hands a File to the import <input>, the way a picked file would arrive. */
function deliverFile(spec) {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const input = inputs.find((node) => node.closest && node.closest('.library')) || inputs[0];
  if (!input) return { ok: false, why: 'no-file-input', count: inputs.length };
  if (typeof DataTransfer !== 'function') return { ok: false, why: 'no-DataTransfer' };

  let file;
  try {
    if (spec.base64) {
      const raw = atob(spec.base64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      file = new File([bytes], spec.name, { type: spec.mime, lastModified: Date.now() });
    } else {
      file = new File([spec.text], spec.name, { type: spec.mime, lastModified: Date.now() });
    }
  } catch (error) {
    return { ok: false, why: 'build-file-failed', message: String((error && error.message) || error) };
  }

  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) {
    return { ok: false, why: 'deliver-failed', message: String((error && error.message) || error) };
  }

  return { ok: true, name: file.name, size: file.size, accepted: input.files ? input.files.length : 0 };
}

/** Where the import went: reader, book card, or an error banner. */
function importOutcome(title) {
  const errorBanner = document.querySelector('.banner-error');
  if (errorBanner) {
    return {
      ok: true,
      how: 'error',
      href: location.href,
      error: (errorBanner.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    };
  }
  if (/\/read\//.test(location.pathname)) return { ok: true, how: 'navigated', href: location.href };

  const cards = Array.from(document.querySelectorAll('a.lib-open, .lib-row'));
  const wanted = String(title).toLowerCase();
  const hit = cards.find((card) => (card.innerText || '').toLowerCase().indexOf(wanted) >= 0);
  if (hit) {
    return {
      ok: true,
      how: 'card',
      href: location.href,
      card: (hit.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  }

  const status = document.querySelector('.lib-status');
  return {
    ok: false,
    href: location.href,
    cards: cards.length,
    status: status ? (status.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null,
  };
}

function clickByText(selector, text) {
  const nodes = Array.from(document.querySelectorAll(selector));
  const wanted = String(text).toLowerCase();
  const hit = nodes.find((node) => (node.innerText || node.textContent || '').toLowerCase().indexOf(wanted) >= 0);
  if (!hit) return { ok: false, count: nodes.length };
  hit.click();
  return { ok: true, text: (hit.innerText || hit.textContent || '').trim().slice(0, 60) };
}

function clickSelector(selector) {
  const node = document.querySelector(selector);
  if (!node) return { ok: false };
  node.click();
  return { ok: true };
}

/** What the reader is showing: title, first of the text, PDF canvas state. */
function readerState() {
  const bar = document.querySelector('.rd-bar-title');
  const text = document.querySelector('.rd-text');
  const canvas = document.querySelector('canvas.rd-pdf-canvas');
  const errorBanner = document.querySelector('.banner-error');
  const body = text ? (text.innerText || '').replace(/\s+/g, ' ').trim() : '';
  return {
    ok: (!!bar || !!text) && body.length > 40,
    href: location.href,
    title: bar ? (bar.innerText || '').trim() : null,
    textLength: body.length,
    textPreview: body.slice(0, 240),
    error: errorBanner ? (errorBanner.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240) : null,
    hasCanvas: !!canvas,
    canvasWidth: canvas ? canvas.width : 0,
    canvasHeight: canvas ? canvas.height : 0,
    viewModes: Array.from(document.querySelectorAll('[aria-label="View mode"] button')).map((node) =>
      (node.textContent || '').trim(),
    ),
  };
}

/** Player bar text plus what the browser's own speech synthesis thinks it is doing. */
function playerState() {
  const dock = document.querySelector('[aria-label="Read aloud"]');
  const synth = window.speechSynthesis || null;
  const labels = dock
    ? Array.from(dock.querySelectorAll('button[aria-label]')).map((node) => node.getAttribute('aria-label'))
    : [];
  const count = dock ? dock.querySelector('.rd-player-count') : null;
  const generating = dock ? dock.querySelector('.rd-gen') : null;
  const banner = document.querySelector('.banner-error');
  let voices = 0;
  try {
    voices = synth && synth.getVoices ? synth.getVoices().length : 0;
  } catch (error) {
    voices = -1;
  }
  return {
    ok: !!dock,
    labels: labels,
    playLabel: labels.filter((label) => label === 'Play' || label === 'Pause' || label === 'Resume')[0] || null,
    count: count ? (count.innerText || '').replace(/\s+/g, ' ').trim() : null,
    generating: generating ? (generating.innerText || '').replace(/\s+/g, ' ').trim() : null,
    dockText: dock ? (dock.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 320) : null,
    speech: synth
      ? {
          supported: true,
          speaking: !!synth.speaking,
          pending: !!synth.pending,
          paused: !!synth.paused,
          voices: voices,
        }
      : { supported: false },
    error: banner ? (banner.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240) : null,
  };
}

/**
 * Is there ink on the PDF canvas? The page is painted into canvas.rd-pdf-canvas by
 * pdf.js; a blank canvas means the stored file could not be read back (the
 * transferToFixedLength bug), so a single dark pixel is the proof we want.
 * The canvas is sampled through a 120x160 thumb nail: transferring a full-page
 * getImageData over WebDriver on iOS is slow enough to time the command out.
 */
function pageCanvasInk() {
  const canvas = document.querySelector('canvas.rd-pdf-canvas');
  if (!canvas) return { ok: false, why: 'no-canvas', href: location.href };
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return { ok: false, why: 'zero-size', width: width, height: height };

  const probe = document.createElement('canvas');
  probe.width = 120;
  probe.height = 160;
  const context = probe.getContext('2d');
  if (!context) return { ok: false, why: 'no-2d-context' };

  let data;
  try {
    context.drawImage(canvas, 0, 0, probe.width, probe.height);
    data = context.getImageData(0, 0, probe.width, probe.height).data;
  } catch (error) {
    return { ok: false, why: 'read-failed', message: String((error && error.message) || error) };
  }

  let inkPixels = 0;
  let opaque = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha > 8) opaque += 1;
    if (alpha > 8 && (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245)) inkPixels += 1;
  }
  const sampled = probe.width * probe.height;
  return {
    ok: inkPixels > 0,
    width: width,
    height: height,
    sampled: sampled,
    opaque: opaque,
    inkPixels: inkPixels,
    inkRatio: Math.round((inkPixels / sampled) * 1000) / 1000,
  };
}

function settingsSnapshot() {
  const page = document.querySelector('.settings-page');
  if (!page) return { ok: false, href: location.href };
  const text = (page.innerText || '').replace(/\u00a0/g, ' ');
  return {
    ok: text.length > 40,
    href: location.href,
    toc: Array.from(document.querySelectorAll('.settings-toc a')).map((node) => (node.textContent || '').trim()),
    headings: Array.from(page.querySelectorAll('h1, h2, h3')).map((node) => (node.innerText || '').trim()),
    text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2400),
  };
}

/* --- TTS probe --------------------------------------------------------------
   On iOS 26 mobile Safari the player dock flips to Pause when Play is tapped, yet
   speechSynthesis.speaking/.pending stay false, the sentence never advances and no
   error is reported. Two explanations survive that evidence: the app's chain never
   reaches speak(), or WebKit swallows the speak(). These scripts separate them.

     installTtsProbe()  wraps speak/cancel/resume/pause and tags every utterance that
                        reaches speak() with start/end/error/boundary listeners, so
                        the app's own calls are timestamped in window.__ttsProbe.
     installCanary()    a real tap that speaks through the same document: proves the
                        wrapper is live in the world the app runs its scripts in.
     probeReset/Watch/Result  one control experiment on <base>?probe=1, each started
                        by a real tap (P1 direct, P2 cancel-then-speak, P3 app-like,
                        P4 unlock-then-later).

   Every function is plain JSON in and out and closes over nothing: WebDriver only
   ships the function body, and these run inside Safari, not Node.
   -------------------------------------------------------------------------- */

/** Timestamps every speechSynthesis call the app makes, plus its utterance events. */
function installTtsProbe() {
  var synth = window.speechSynthesis;
  if (!synth) return { ok: false, why: 'no-speechSynthesis' };

  var state = window.__ttsProbe;
  if (!state) {
    state = window.__ttsProbe = {
      log: [],
      utterances: [],
      dropped: 0,
      boundaries: 0,
      wrapped: false,
      probeError: null,
    };
  }
  if (state.wrapped) return { ok: true, wrapped: true, already: true, entries: state.log.length };

  var originalSpeak = synth.speak;
  var originalCancel = synth.cancel;
  var originalResume = synth.resume;
  var originalPause = synth.pause;
  if (typeof originalSpeak !== 'function' || typeof originalCancel !== 'function') {
    return { ok: false, why: 'speak-not-callable' };
  }

  var stamp = function () {
    return Math.round(performance.now() * 10) / 10;
  };

  var push = function (entry) {
    // A chatty page must not turn into a 10 MB WebDriver reply.
    if (state.log.length >= 800) {
      state.dropped += 1;
      return;
    }
    state.log.push(entry);
  };

  var record = function (op, text, utterance, extra) {
    var entry = { t: stamp(), op: op, text: text === null ? null : String(text).slice(0, 140) };
    entry.voice = null;
    entry.lang = null;
    if (utterance) {
      try {
        entry.voice = utterance.voice && utterance.voice.name ? String(utterance.voice.name) : null;
        entry.lang = utterance.lang ? String(utterance.lang) : null;
      } catch (error) {
        entry.voice = null;
        entry.lang = null;
      }
    }
    try {
      entry.speaking = !!synth.speaking;
      entry.pending = !!synth.pending;
      entry.paused = !!synth.paused;
    } catch (error) {
      entry.speaking = null;
      entry.pending = null;
      entry.paused = null;
    }
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) entry[key] = extra[key];
      }
    }
    push(entry);
    return entry;
  };

  var listen = function (utterance, text) {
    utterance.addEventListener('start', function () {
      record('start', text, utterance, null);
    });
    utterance.addEventListener('end', function () {
      record('end', text, utterance, null);
    });
    utterance.addEventListener('error', function (event) {
      var code = null;
      try {
        code = event && (event.error || event.errorCode) ? String(event.error || event.errorCode) : null;
      } catch (error) {
        code = null;
      }
      record('error', text, utterance, { error: code });
    });
    utterance.addEventListener('boundary', function (event) {
      // one sentence is dozens of boundaries; the first few are the whole signal
      if (state.boundaries >= 60) return;
      state.boundaries += 1;
      var charIndex = null;
      try {
        charIndex = event && typeof event.charIndex === 'number' ? event.charIndex : null;
      } catch (error) {
        charIndex = null;
      }
      record('boundary', text, utterance, { charIndex: charIndex });
    });
  };

  synth.speak = function (utterance) {
    // The probe must never be why the app fails: instrument in a try/catch and hand
    // the call to WebKit untouched, whatever happened above.
    try {
      var text = '';
      try {
        text = utterance && utterance.text !== undefined ? String(utterance.text) : '';
      } catch (error) {
        text = '<unreadable>';
      }
      record('speak', text, utterance, null);
      if (utterance && typeof utterance.addEventListener === 'function') {
        listen(utterance, text);
        // WebKit drops an utterance that has been collected before it starts.
        state.utterances.push(utterance);
        if (state.utterances.length > 40) state.utterances.shift();
      }
    } catch (error) {
      try {
        state.probeError = String((error && error.message) || error);
      } catch (ignored) {
        state.probeError = 'unprintable-probe-error';
      }
    }
    return originalSpeak.apply(synth, arguments);
  };

  synth.cancel = function () {
    try {
      record('cancel', null, null, null);
    } catch (error) {
      state.probeError = String((error && error.message) || error);
    }
    return originalCancel.apply(synth, arguments);
  };

  if (typeof originalResume === 'function') {
    synth.resume = function () {
      try {
        record('resume', null, null, null);
      } catch (error) {
        state.probeError = String((error && error.message) || error);
      }
      return originalResume.apply(synth, arguments);
    };
  }
  if (typeof originalPause === 'function') {
    synth.pause = function () {
      try {
        record('pause', null, null, null);
      } catch (error) {
        state.probeError = String((error && error.message) || error);
      }
      return originalPause.apply(synth, arguments);
    };
  }

  state.wrapped = true;
  var voices = -1;
  try {
    voices = typeof synth.getVoices === 'function' ? synth.getVoices().length : -1;
  } catch (error) {
    voices = -1;
  }
  return { ok: true, wrapped: true, voices: voices, speaking: !!synth.speaking, pending: !!synth.pending };
}

/** The probe timeline so far, newest `limit` entries. */
function readTtsLog(limit) {
  var state = window.__ttsProbe || { log: [], dropped: 0 };
  var log = state.log || [];
  var max = Number(limit) > 0 ? Number(limit) : 120;
  var counts = {};
  for (var index = 0; index < log.length; index += 1) {
    var op = String(log[index].op || '?');
    counts[op] = (counts[op] || 0) + 1;
  }
  return {
    ok: true,
    wrapped: !!state.wrapped,
    entries: log.length,
    dropped: state.dropped || 0,
    counts: counts,
    probeError: state.probeError || null,
    log: log.slice(Math.max(0, log.length - max)),
  };
}

/**
 * A button in the app's own document that speaks on a real tap. If its speak() lands
 * in the log, the wrapper is live alongside the app's scripts — so an empty log
 * after tapping Play means the app never reached speak(), not that we missed it.
 */
function installCanary() {
  var old = document.getElementById('tts-probe-canary');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var button = document.createElement('button');
  button.id = 'tts-probe-canary';
  button.type = 'button';
  button.textContent = 'probe';
  button.setAttribute('aria-label', 'probe canary');
  button.setAttribute(
    'style',
    [
      'position:fixed',
      'right:10px',
      'top:45%',
      'z-index:2147483647',
      'width:76px',
      'height:56px',
      'padding:0',
      'font:16px -apple-system,system-ui,sans-serif',
      'border:2px solid #0f4c5c',
      'border-radius:10px',
      'background:#e8f4f6',
      'color:#0f4c5c',
    ].join(';'),
  );
  button.addEventListener('click', function () {
    var state = window.__ttsProbe;
    try {
      if (state) state.log.push({ t: Math.round(performance.now() * 10) / 10, op: 'canary-tap', text: null });
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('probe canary'));
    } catch (error) {
      if (state) state.log.push({ t: 0, op: 'canary-error', text: String((error && error.message) || error) });
    }
  });
  document.body.appendChild(button);
  return { ok: true, id: button.id, href: location.href };
}

/** Four buttons for the control experiments, on a page in the app's own origin. */
function installProbeButtons() {
  var sentence = 'Atropine blocks muscarinic receptors.';
  var old = document.getElementById('tts-probe-page');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var host = document.createElement('div');
  host.id = 'tts-probe-page';
  host.setAttribute(
    'style',
    [
      'position:fixed',
      'left:0',
      'top:0',
      'right:0',
      'bottom:0',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:column',
      'gap:12px',
      'padding:24px 16px',
      'box-sizing:border-box',
      'background:#ffffff',
      'font:16px -apple-system,system-ui,sans-serif',
    ].join(';'),
  );

  var heading = document.createElement('p');
  heading.setAttribute('style', 'margin:0 0 4px;font:14px -apple-system,system-ui,sans-serif;color:#555');
  heading.textContent = 'TTS probe — tap one button';
  host.appendChild(heading);

  var note = function (op, text) {
    var state = window.__ttsProbe;
    if (!state) return;
    state.log.push({ t: Math.round(performance.now() * 10) / 10, op: op, text: text === undefined ? null : text });
  };

  // Sampling starts inside the tap, not on the next WebDriver round trip: the
  // sentence lasts about a second and a remote call would miss the whole thing.
  var startSampling = function () {
    var state = window.__ttsProbe;
    if (!state || state.samplesStart) return;
    var synth = window.speechSynthesis;
    state.samples = [];
    state.samplesStart = Math.round(performance.now() * 10) / 10;
    state.watching = true;
    state.samplesDone = false;
    var sample = function () {
      state.samples.push({
        t: Math.round(performance.now() - state.samplesStart),
        speaking: synth ? synth.speaking === true : false,
        pending: synth ? synth.pending === true : false,
        paused: synth ? synth.paused === true : false,
      });
    };
    sample();
    var timer = setInterval(sample, 250);
    setTimeout(function () {
      clearInterval(timer);
      sample();
      state.watching = false;
      state.samplesDone = true;
    }, 3250);
  };

  var add = function (id, label, handler) {
    var button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.setAttribute(
      'style',
      [
        'display:block',
        'width:100%',
        'min-height:56px',
        'padding:14px 16px',
        'font:18px -apple-system,system-ui,sans-serif',
        'text-align:left',
        'border:1px solid #99aabb',
        'border-radius:12px',
        'background:#f5f7f8',
        'color:#112233',
      ].join(';'),
    );
    button.addEventListener('click', function () {
      note('probe-tap', id);
      startSampling();
      try {
        handler();
      } catch (error) {
        note('probe-handler-error', String((error && error.message) || error));
      }
    });
    host.appendChild(button);
    return button;
  };

  add('tts-probe-p1', 'P1 direct', function () {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(sentence));
  });
  add('tts-probe-p2', 'P2 cancel-then-speak', function () {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(sentence));
  });
  add('tts-probe-p3', 'P3 app-like', function () {
    // what the app does: an empty utterance in the gesture, then cancel + speak later
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    setTimeout(function () {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(sentence));
    }, 300);
  });
  add('tts-probe-p4', 'P4 unlock-then-later', function () {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    setTimeout(function () {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(sentence));
    }, 300);
  });

  document.body.appendChild(host);
  return {
    ok: true,
    buttons: ['tts-probe-p1', 'tts-probe-p2', 'tts-probe-p3', 'tts-probe-p4'],
    href: location.href,
  };
}

/** Clear the timeline and stop anything still queued, before one experiment. */
function probeReset(name) {
  var synth = window.speechSynthesis;
  var state = window.__ttsProbe;
  if (!synth || !state) return { ok: false, why: 'no-probe-state' };
  try {
    synth.cancel();
  } catch (error) {
    // nothing to cancel is the normal case
  }
  // assign a new array: the wrappers look the log up on every call
  state.log = [];
  state.dropped = 0;
  state.boundaries = 0;
  state.probeError = null;
  state.name = String(name || '');
  state.samples = [];
  state.samplesStart = 0;
  state.watching = false;
  state.samplesDone = false;
  var voices = -1;
  try {
    voices = typeof synth.getVoices === 'function' ? synth.getVoices().length : -1;
  } catch (error) {
    voices = -1;
  }
  return { ok: true, name: state.name, voices: voices };
}

/** Sample speaking/pending every 250 ms for 3.25 s, in the page (one round trip). */
function probeWatch() {
  var synth = window.speechSynthesis;
  var state = window.__ttsProbe;
  if (!synth || !state) return { ok: false, why: 'no-probe-state' };
  // installProbeButtons starts sampling inside the tap; nothing to do then.
  if (state.samplesStart) {
    return { ok: true, watching: state.watching === true, already: true, samples: (state.samples || []).length };
  }
  if (state.watching) return { ok: true, watching: true, already: true, samples: (state.samples || []).length };

  state.samples = [];
  state.samplesStart = performance.now();
  state.watching = true;
  state.samplesDone = false;

  var sample = function () {
    state.samples.push({
      t: Math.round(performance.now() - state.samplesStart),
      speaking: !!synth.speaking,
      pending: !!synth.pending,
      paused: !!synth.paused,
    });
  };
  sample();
  var timer = setInterval(sample, 250);
  setTimeout(function () {
    clearInterval(timer);
    sample();
    state.watching = false;
    state.samplesDone = true;
  }, 3250);
  return { ok: true, watching: true, samples: 1 };
}

/** What one experiment did: the timeline, the samples, and the flags that matter. */
function probeResult(name) {
  var synth = window.speechSynthesis;
  var state = window.__ttsProbe;
  if (!state) return { ok: false, why: 'no-probe-state' };
  var log = state.log || [];
  var samples = state.samples || [];

  var count = function (op) {
    var total = 0;
    for (var index = 0; index < log.length; index += 1) if (log[index].op === op) total += 1;
    return total;
  };
  var first = function (op) {
    for (var index = 0; index < log.length; index += 1) if (log[index].op === op) return log[index];
    return null;
  };
  var at = function (flag) {
    var out = [];
    for (var index = 0; index < samples.length; index += 1) if (samples[index][flag]) out.push(samples[index].t);
    return out;
  };

  var start = first('start');
  var end = first('end');
  var failure = first('error');
  var speakingAt = at('speaking');
  var pendingAt = at('pending');
  var voices = -1;
  try {
    voices = typeof synth.getVoices === 'function' ? synth.getVoices().length : -1;
  } catch (error) {
    voices = -1;
  }

  return {
    ok: true,
    name: String(name || state.name || ''),
    voices: voices,
    samplesDone: !!state.samplesDone,
    samples: samples.length,
    speakingEver: speakingAt.length > 0,
    speakingAt: speakingAt,
    pendingEver: pendingAt.length > 0,
    pendingAt: pendingAt,
    startFired: !!start,
    startAt: start ? start.t : null,
    endFired: !!end,
    endAt: end ? end.t : null,
    errorCode: failure ? failure.error || 'no-code' : null,
    spoke: count('speak'),
    cancelled: count('cancel'),
    boundaries: count('boundary'),
    taps: count('probe-tap'),
    log: log,
    sampleList: samples,
  };
}

/** Voices listed and the buttons up: the page is ready for an experiment. */
function probeReady() {
  var synth = window.speechSynthesis;
  var voices = 0;
  try {
    voices = synth && typeof synth.getVoices === 'function' ? synth.getVoices().length : 0;
  } catch (error) {
    voices = -1;
  }
  var buttons = document.querySelectorAll('#tts-probe-page button').length;
  // Voices are not required: Safari fills getVoices() lazily (it was 0 before the
  // first tap and 68 after on iOS 26), and speak() works with the default voice.
  return {
    ok: buttons === 4,
    voices: voices,
    buttons: buttons,
    href: location.href,
  };
}

/** Stop whatever the experiment left queued, before the next one. */
function probeCancel() {
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) };
  }
  return { ok: true };
}

function removeProbeElements() {
  var ids = ['tts-probe-page', 'tts-probe-canary'];
  for (var index = 0; index < ids.length; index += 1) {
    var node = document.getElementById(ids[index]);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
  return { ok: true };
}

/** Filled in by c.play-tts and c2.tts-probe, printed by writeSummary. */
const ttsReport = { app: null, probes: [] };

function yes(value) {
  return value ? 'yes' : 'no';
}

/** One line per probe entry, for the step summary's <details> block. */
function ttsLogLines(entries, limit = 60) {
  const lines = [];
  for (const entry of entries.slice(-limit)) {
    const flags = `speaking=${entry.speaking === true} pending=${entry.pending === true}`;
    const text = entry.text ? ` ${JSON.stringify(String(entry.text).slice(0, 56))}` : '';
    const extra = entry.error ? ` error=${entry.error}` : entry.message ? ` ${entry.message}` : '';
    lines.push(`${String(entry.t)}ms ${String(entry.op)}${text}${extra} ${flags}`);
  }
  return lines;
}

/* --- WebDriver plumbing ---------------------------------------------------- */

let browser = null;
let shotCount = 0;

async function startSession() {
  let remote;
  try {
    ({ remote } = await import('webdriverio'));
  } catch (error) {
    throw new Error(`webdriverio is not installed in scripts/ios-sim (run "npm ci" there): ${message(error)}`);
  }

  const common = {
    hostname: '127.0.0.1',
    path: '/',
    logLevel: process.env.IOS_SIM_WDIO_LOG || 'warn',
    // The first XCUITest session builds WebDriverAgent from source: 5-10 minutes
    // before Safari answers, and that build time is inside the session request.
    connectionRetryTimeout: DRIVER === 'appium' ? 900000 : 180000,
    connectionRetryCount: 1,
  };

  if (DRIVER === 'safaridriver') {
    const port = SAFARIDRIVER_PORT;
    log({ event: 'session-request', driver: DRIVER, port: port });
    return remote({
      ...common,
      port: port,
      capabilities: {
        browserName: 'Safari',
        platformName: 'iOS',
        'safari:useSimulator': true,
        'safari:deviceUDID': UDID || undefined,
        'safari:automaticInspection': false,
      },
    });
  }

  log({ event: 'session-request', driver: DRIVER, port: APPIUM_PORT });
  return remote({
    ...common,
    port: APPIUM_PORT,
    capabilities: {
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:udid': UDID || undefined,
      'appium:deviceName': DEVICE_NAME,
      'appium:platformVersion': PLATFORM_VERSION || undefined,
      'appium:wdaLaunchTimeout': 240000,
      'appium:newCommandTimeout': 600,
      'appium:wdaStartupRetries': 2,
      'appium:wdaStartupRetryInterval': 20000,
      'appium:showXcodeLog': true,
      'appium:autoAcceptAlerts': true,
      'appium:noReset': true,
      'appium:safariInitialUrl': URL_BASE,
    },
  });
}

async function setTimeouts() {
  // webdriverio 9 takes the three timeouts as positional numbers; the object form
  // is rejected client-side with `Malformed type for "implicit" parameter`.
  try {
    if (typeof browser.setTimeouts === 'function') {
      await browser.setTimeouts(0, 180000, 120000);
    }
  } catch (error) {
    log({ event: 'timeouts-warning', error: message(error) });
  }
}

/** executeScript with a function; WDIO serialises the body and the arguments. */
async function runScript(fn, ...args) {
  if (!browser) throw new Error('no browser session');
  return browser.execute(fn, ...args);
}

async function waitFor(what, fn, args = [], options = {}) {
  const timeout = options.timeout || 60000;
  const interval = options.interval || 500;
  const startedAt = Date.now();
  let last = null;
  let attempts = 0;
  while (Date.now() - startedAt < timeout) {
    attempts += 1;
    try {
      last = await runScript(fn, ...args);
    } catch (error) {
      // The document can be mid-navigation: the old context is gone and Safari
      // answers with a failed command. That is not a failure of the wait, it is
      // the page being replaced, so keep polling.
      last = { ok: false, why: 'script-error', message: message(error) };
    }
    if (last && last.ok) return last;
    await sleep(interval);
  }
  let seen = 'nothing';
  try {
    seen = String(JSON.stringify(last) ?? 'undefined');
  } catch (error) {
    seen = 'unprintable';
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}; last=${seen.slice(0, 600)}`);
}

/** Navigate and wait for a usable document; a failed pageLoad is not fatal. */
async function goto(url) {
  log({ event: 'navigate', url: url });
  try {
    await browser.navigateTo(url);
  } catch (error) {
    log({ event: 'navigate-warning', url: url, error: message(error) });
  }
  await waitFor(`document ready at ${url}`, pageAlive, [], { timeout: 90000, interval: 500 });
  const installed = await runScript(installCollector);
  log({ event: 'collector-installed', url: url, userAgent: installed && installed.userAgent });
  return installed;
}

function pageUrl(rel) {
  const base = new URL(URL_BASE);
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  return new URL(String(rel).replace(/^\/+/, ''), base).href;
}

async function capture(label) {
  if (!browser) return null;
  shotCount += 1;
  const stem = `${String(shotCount).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-')}`;
  const png = path.join(ARTIFACTS, `${stem}.png`);
  try {
    await browser.saveScreenshot(png);
    log({ event: 'screenshot', file: path.relative(process.cwd(), png) });
  } catch (error) {
    log({ event: 'screenshot-fail', label: label, error: message(error) });
  }
  try {
    const html = await browser.getPageSource();
    await writeFile(path.join(ARTIFACTS, `${stem}.html`), html);
  } catch (error) {
    log({ event: 'pagesource-fail', label: label, error: message(error) });
  }
  return png;
}

/** A real finger tap (element click), falling back to a synthetic click. */
async function tap(selector, label) {
  try {
    const element = await browser.$(selector);
    if (await element.isExisting()) {
      await element.click();
      log({ event: 'tap', target: label, how: 'wda-tap', selector: selector });
      return 'wda-tap';
    }
  } catch (error) {
    log({ event: 'tap-warning', target: label, how: 'wda-tap', error: message(error) });
  }
  const clicked = await runScript(clickSelector, selector);
  if (!clicked || !clicked.ok) throw new Error(`could not tap ${label} (${selector})`);
  log({ event: 'tap', target: label, how: 'script-click', selector: selector });
  return 'script-click';
}

/** Each step is independent: a throw is recorded, then the run continues. */
async function step(name, fn) {
  const startedAt = Date.now();
  log({ event: 'step-start', step: name });
  try {
    const result = await fn();
    const record = {
      name: name,
      ok: !result || result.ok !== false,
      ms: Date.now() - startedAt,
      detail: result && result.detail !== undefined ? result.detail : result || null,
      error: null,
    };
    records.push(record);
    log({ event: 'step-pass', step: record.name, ms: record.ms, detail: record.detail });
    await capture(name);
    return record;
  } catch (error) {
    const record = { name: name, ok: false, ms: Date.now() - startedAt, detail: null, error: message(error) };
    records.push(record);
    log({ event: 'step-fail', step: record.name, ms: record.ms, error: record.error });
    await capture(`${name}-failed`);
    return record;
  }
}

async function simctlScreenshot() {
  if (process.platform !== 'darwin') return { ok: false, why: 'not-macos' };
  const targets = [UDID, 'booted'].filter(Boolean);
  for (const target of targets) {
    const file = path.join(ARTIFACTS, target === 'booted' ? 'simctl-booted.png' : 'simctl-device.png');
    try {
      await execFile('xcrun', ['simctl', 'io', target, 'screenshot', file], { timeout: 60000 });
      log({ event: 'simctl-screenshot', udid: target, file: path.relative(process.cwd(), file) });
      return { ok: true, udid: target, file: path.basename(file) };
    } catch (error) {
      log({ event: 'simctl-screenshot-fail', udid: target, error: message(error) });
    }
  }
  return { ok: false, why: 'simctl-failed' };
}

async function writeSummary(extra = {}) {
  const passed = records.filter((record) => record.ok).length;
  const summary = {
    url: URL_BASE,
    urlTested: URL_BASE,
    mode: LOCAL_BUILD ? 'local-build' : 'live-url',
    driver: DRIVER,
    device: {
      udid: UDID || null,
      name: DEVICE_NAME,
      platformVersion: PLATFORM_VERSION || null,
      simulatorRuntime: process.env.IOS_SIM_RUNTIME || null,
    },
    startedAt: startedAt,
    finishedAt: now(),
    passed: passed,
    failed: records.length - passed,
    steps: records,
    ttsProbe: {
      instrumented: ttsReport.app ? ttsReport.app.instrumented : null,
      canary: ttsReport.app ? ttsReport.app.canary : null,
      appLogAt3s: ttsReport.app ? ttsReport.app.at3s : null,
      appLogAt9s: ttsReport.app ? ttsReport.app.at9s : null,
      experiments: ttsReport.probes,
    },
    ...extra,
  };
  try {
    await writeFile(path.join(ARTIFACTS, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    log({ event: 'summary-write-fail', error: message(error) });
  }
  try {
    await writeFile(path.join(ARTIFACTS, 'run.log'), `${logLines.join('\n')}\n`);
  } catch (error) {
    log({ event: 'log-write-fail', error: message(error) });
  }

  const lines = [
    `### iOS Simulator — mobile Safari (driver: \`${DRIVER}\`)`,
    '',
    `Device: **${DEVICE_NAME}** · iOS ${PLATFORM_VERSION || 'unknown'} · \`${UDID || 'no udid'}\``,
    `URL: ${URL_BASE}${LOCAL_BUILD ? ' — **local build**' : ''}`,
    '',
    `**${passed} passed, ${records.length - passed} failed**`,
    '',
    '| step | result | time | note |',
    '| --- | --- | --- | --- |',
  ];
  for (const record of records) {
    const note = record.ok ? '' : String(record.error || '').replace(/\|/g, '\\|').slice(0, 180);
    lines.push(`| ${record.name} | ${record.ok ? 'pass' : '**FAIL**'} | ${Math.round(record.ms / 1000)} s | ${note} |`);
  }

  // The TTS probe is the reason this run exists right now, so it gets its own
  // section: one row per control experiment, then the app's own speak() timeline.
  if (ttsReport.probes.length) {
    lines.push(
      '',
      '### TTS probe — control experiments',
      '',
      '| probe | tap | start | speaking seen | pending seen | end | error | speak() | cancel() |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const probe of ttsReport.probes) {
      const spoke = typeof probe.spoke === 'number' ? probe.spoke : '-';
      const cancelled = typeof probe.cancelled === 'number' ? probe.cancelled : '-';
      lines.push(
        `| ${probe.name} | ${probe.tap || probe.tapError || '-'} | ${yes(probe.startFired)} | ${yes(probe.speakingEver)} | ${yes(
          probe.pendingEver,
        )} | ${yes(probe.endFired)} | ${probe.errorCode || '-'} | ${spoke} | ${cancelled} |`,
      );
    }
    const app = ttsReport.app;
    if (app && app.canary) {
      const canary = app.canary;
      const verdict =
        canary.ok === false
          ? `could not tap it — ${String(canary.message || 'unknown').replace(/\|/g, '\\|')}`
          : canary.speakLogged
            ? `speak() logged${canary.startLogged ? ' and it started' : ', never started'} (${canary.tap})`
            : `NOT logged (${canary.tap})`;
      lines.push('', `Canary speak on the app's own page: **${verdict}**`);
    }
    if (app && app.at9s) {
      const log = app.at9s;
      const entries = Array.isArray(log.log) ? log.log : [];
      const total = typeof log.entries === 'number' ? log.entries : entries.length;
      const counts = log.counts ? Object.keys(log.counts).map((key) => `${key}=${log.counts[key]}`).join(' ') : '';
      lines.push(
        '',
        `<details><summary>App <code>__ttsLog</code> — ${total} entries${counts ? ` (${counts})` : ''}${
          log.dropped ? `, ${log.dropped} dropped` : ''
        }</summary>`,
        '',
        '```text',
        ...ttsLogLines(entries),
        '```',
        '',
        '</details>',
      );
    }
  }
  if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    } catch (error) {
      log({ event: 'step-summary-fail', error: message(error) });
    }
  }
  for (const record of records.filter((entry) => !entry.ok)) {
    // A warning annotation, not an error one: the report is the product here.
    console.log(`::warning title=iOS ${record.name}::${String(record.error || 'failed').replace(/[\r\n]+/g, ' ')}`);
  }
  console.log(lines.join('\n'));
  return summary;
}

/* --- The run --------------------------------------------------------------- */

const startedAt = now();

const watchdog = setTimeout(() => {
  log({ event: 'watchdog', budgetMs: RUN_BUDGET_MS });
  void writeSummary({ watchdog: true }).finally(() => process.exit(0));
}, RUN_BUDGET_MS);
watchdog.unref?.();

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  log({
    event: 'start',
    url: URL_BASE,
    mode: LOCAL_BUILD ? 'local-build' : 'live-url',
    driver: DRIVER,
    artifacts: path.relative(process.cwd(), ARTIFACTS),
    node: process.version,
    platform: process.platform,
  });

  await step('0.session', async () => {
    browser = await startSession();
    await setTimeouts();
    const capabilities = browser.capabilities || {};
    const sessionId = browser.sessionId;
    log({ event: 'session-created', sessionId: sessionId, capabilities: capabilities });
    // iOS puts consent alerts in front of the first Safari tab on a fresh device.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await browser.acceptAlert();
        log({ event: 'alert-accepted', attempt: attempt });
      } catch (error) {
        // No alert is the normal case.
        break;
      }
    }
    return {
      ok: true,
      detail: {
        sessionId: sessionId,
        udid: UDID || null,
        platformVersion: PLATFORM_VERSION || null,
        deviceName: DEVICE_NAME,
        browserVersion: capabilities.browserVersion || null,
        platform: capabilities.platformName || capabilities.platform || null,
      },
    };
  });

  // (a) The live library on a real device, and what the shell reported while it loaded.
  await step('a.library-load', async () => {
    if (!browser) throw new Error('no browser session');
    await goto(URL_BASE);
    const firstPaint = await waitFor('library root text', pageLibraryReady, [], { timeout: 120000, interval: 500 });
    const firstState = await runScript(readPageState);

    // The service worker only controls a document after a navigation it served,
    // so reload until it does (twice is plenty for a first visit).
    let controllerAfterReloads = false;
    let reloads = 0;
    while (!controllerAfterReloads && reloads < 2) {
      reloads += 1;
      try {
        await browser.refresh();
      } catch (error) {
        log({ event: 'refresh-warning', attempt: reloads, error: message(error) });
      }
      await waitFor('library after reload', pageLibraryReady, [], { timeout: 120000, interval: 500 });
      await runScript(installCollector);
      const state = await runScript(readPageState);
      controllerAfterReloads = !!(state && state.serviceWorker && state.serviceWorker.controller);
    }
    const afterReload = await runScript(readPageState);

    return {
      ok: true,
      detail: {
        firstPaint: firstPaint,
        firstState: firstState,
        reloads: reloads,
        controllerAfterReloads: controllerAfterReloads,
        afterReload: afterReload,
      },
    };
  });

  // (b) Import a text file the way the page's own file input would deliver it.
  await step('b.import-text', async () => {
    if (!browser) throw new Error('no browser session');
    await goto(URL_BASE);
    await waitFor('library file input', pageHasFileInput, [], { timeout: 60000 });

    const delivered = await runScript(deliverFile, { name: TXT_NAME, mime: 'text/plain', text: TXT_BODY });
    log({ event: 'file-delivered', file: TXT_NAME, delivered: delivered });
    if (!delivered || !delivered.ok) throw new Error(`could not deliver the file to the import input: ${JSON.stringify(delivered)}`);

    const outcome = await waitFor(`text import of ${TXT_NAME}`, importOutcome, [TXT_TITLE], {
      timeout: 180000,
      interval: 1000,
    });
    if (outcome.how === 'error') throw new Error(`import failed: ${outcome.error}`);

    let opened = 'auto-navigated';
    if (outcome.how === 'card') {
      const clicked = await runScript(clickByText, 'a.lib-open', TXT_TITLE);
      if (!clicked || !clicked.ok) throw new Error('book card appeared but could not be clicked');
      opened = 'card-click';
    }

    const reader = await waitFor('reader text', readerState, [], { timeout: 120000, interval: 750 });
    return { ok: reader.textLength >= 40, detail: { delivered: delivered, outcome: outcome, opened: opened, reader: reader } };
  });

  // (c) Press Play in the player dock. The simulator often has no voices; that is
  //     a result, not a failure, so everything it reports is recorded verbatim.
  //     speak()/cancel() are wrapped *before* the tap, so the app's own calls are
  //     timestamped and its utterances' start/end/error events land in __ttsProbe.
  await step('c.play-tts', async () => {
    if (!browser) throw new Error('no browser session');
    const before = await runScript(playerState);
    if (!before || !before.ok) throw new Error('no player bar on the reader page');

    const instrumented = await runScript(installTtsProbe);
    log({ event: 'tts-instrumented', instrumented: instrumented });

    const how = await tap(
      '[aria-label="Read aloud"] [aria-label="Play"], [aria-label="Read aloud"] [aria-label="Pause"], [aria-label="Read aloud"] [aria-label="Resume"]',
      'play',
    );
    await sleep(3000);
    const after3s = await runScript(playerState);
    const errorsAt3s = await runScript(readPageState);
    const ttsAt3s = await runScript(readTtsLog, 40);
    await sleep(6000);
    const after9s = await runScript(playerState);
    const ttsAt9s = await runScript(readTtsLog, 160);

    // Positive control, after the app has had its 9 s: a real tap that speaks
    // through the same document. If this is logged, the wrapper is live in the
    // world the app's scripts run in, so an app timeline with no speak() at all
    // means the chain never reached speak() — not that the probe missed it.
    let canary = null;
    try {
      await runScript(installCanary);
      const canaryTap = await tap('#tts-probe-canary', 'canary');
      await sleep(2000);
      const canaryLog = await runScript(readTtsLog, 40);
      const entries = canaryLog.log || [];
      const spoke = entries.filter((entry) => entry.op === 'speak' && /probe canary/i.test(String(entry.text || '')));
      const started = entries.filter((entry) => entry.op === 'start' && /probe canary/i.test(String(entry.text || '')));
      canary = {
        ok: true,
        tap: canaryTap,
        speakLogged: spoke.length > 0,
        startLogged: started.length > 0,
        entries: canaryLog.entries,
        entry: spoke[0] || null,
      };
      log({ event: 'tts-canary', canary: canary });
      await runScript(removeProbeElements);
    } catch (error) {
      canary = { ok: false, message: message(error) };
      log({ event: 'tts-canary-fail', error: message(error) });
    }

    ttsReport.app = { instrumented: instrumented, at3s: ttsAt3s, at9s: ttsAt9s, canary: canary };

    return {
      ok: true,
      detail: {
        before: before,
        instrumented: instrumented,
        tap: how,
        after3s: after3s,
        after9s: after9s,
        errorsAt3s: errorsAt3s,
        ttsAt3s: ttsAt3s,
        ttsAt9s: ttsAt9s,
        canary: canary,
      },
    };
  });

  // (c2) Control experiments on one fresh document in the app's own origin, each
  //      started by a real tap. They decide between the two surviving explanations
  //      for the bug: iOS 26 Safari cannot speak a sentence at all from a page like
  //      this, or it only drops the speak() that follows a cancel() (or that comes
  //      300 ms after an empty unlock utterance), or the app's chain never gets there.
  await step('c2.tts-probe', async () => {
    if (!browser) throw new Error('no browser session');
    // ?probe=1 keeps the same origin (and so the same service worker and secure
    // context) while giving the experiments a document of their own.
    await goto(pageUrl('?probe=1'));

    const instrumented = await runScript(installTtsProbe);
    const buttons = await runScript(installProbeButtons);
    log({ event: 'probe-page-ready', instrumented: instrumented, buttons: buttons });

    let ready = null;
    try {
      ready = await waitFor('probe page voices', probeReady, [], { timeout: 20000, interval: 500 });
    } catch (error) {
      log({ event: 'probe-voices-warning', error: message(error) });
      ready = await runScript(probeReady);
    }

    const experiments = [
      { id: 'tts-probe-p1', name: 'P1 direct' },
      { id: 'tts-probe-p2', name: 'P2 cancel-then-speak' },
      { id: 'tts-probe-p3', name: 'P3 app-like' },
      { id: 'tts-probe-p4', name: 'P4 unlock-then-later' },
    ];
    const results = [];

    for (const experiment of experiments) {
      const reset = await runScript(probeReset, experiment.name);
      let how = null;
      let tapError = null;
      try {
        how = await tap(`#${experiment.id}`, experiment.id);
      } catch (error) {
        tapError = message(error);
        log({ event: 'probe-tap-fail', probe: experiment.name, error: tapError });
      }
      // The tap's handler ran synchronously inside that tap, so the watch window
      // starts after speak()/cancel() were already called.
      const watching = await runScript(probeWatch);
      await sleep(3600);
      const result = await runScript(probeResult, experiment.name);
      await runScript(probeCancel);
      await sleep(1000);

      const timed = (result && result.sampleList) || [];
      const last = timed.length ? timed[timed.length - 1] : null;
      const entry = {
        name: experiment.name,
        tap: how,
        tapError: tapError,
        voices: result ? result.voices : reset && reset.voices,
        startFired: !!(result && result.startFired),
        startAt: result ? result.startAt : null,
        speakingEver: !!(result && result.speakingEver),
        pendingEver: !!(result && result.pendingEver),
        endFired: !!(result && result.endFired),
        endAt: result ? result.endAt : null,
        errorCode: result ? result.errorCode : null,
        spoke: result ? result.spoke : 0,
        cancelled: result ? result.cancelled : 0,
        boundaries: result ? result.boundaries : 0,
        lastSample: last,
        reset: reset,
        watching: watching,
        log: result ? result.log : [],
        samples: timed,
      };
      results.push(entry);
      log({
        event: 'probe-result',
        probe: entry.name,
        tap: entry.tap,
        startFired: entry.startFired,
        speakingEver: entry.speakingEver,
        speakingAt: timed.filter((sample) => sample.speaking).map((sample) => sample.t),
        endFired: entry.endFired,
        errorCode: entry.errorCode,
        spoke: entry.spoke,
        cancelled: entry.cancelled,
      });
    }

    ttsReport.probes = results;

    return {
      ok: true,
      detail: {
        instrumented: instrumented,
        buttons: buttons,
        ready: ready,
        experiments: results,
      },
    };
  });

  // (d) The same import for a PDF, then the page view: this is the check that the
  //     file survived storage and that pdf.js can still render it on iOS Safari.
  await step('d.import-pdf', async () => {
    if (!browser) throw new Error('no browser session');
    await goto(URL_BASE);
    await waitFor('library file input', pageHasFileInput, [], { timeout: 60000 });

    const delivered = await runScript(deliverFile, { name: PDF_NAME, mime: 'application/pdf', base64: PDF_BASE64 });
    log({ event: 'file-delivered', file: PDF_NAME, delivered: delivered });
    if (!delivered || !delivered.ok) throw new Error(`could not deliver the PDF to the import input: ${JSON.stringify(delivered)}`);

    const outcome = await waitFor(`pdf import of ${PDF_NAME}`, importOutcome, [PDF_TITLE], {
      timeout: 240000,
      interval: 1000,
    });
    if (outcome.how === 'error') throw new Error(`import failed: ${outcome.error}`);

    let opened = 'auto-navigated';
    if (outcome.how === 'card') {
      const clicked = await runScript(clickByText, 'a.lib-open', PDF_TITLE);
      if (!clicked || !clicked.ok) throw new Error('book card appeared but could not be clicked');
      opened = 'card-click';
    }

    const reader = await waitFor('pdf reader', readerState, [], { timeout: 120000, interval: 750 });
    const textPreview = reader.textPreview || '';
    const textLayerOk = /atropine blocks muscarinic receptors/i.test(textPreview);

    // A PDF opens in text view; the canvas only exists in page view.
    const switched = await runScript(clickByText, '[aria-label="View mode"] button', 'Page');
    log({ event: 'view-mode-switch', switched: switched });
    if (!switched || switched.ok !== true) {
      throw new Error(`the reader has no "Page" view button to switch to: ${JSON.stringify(switched)}`);
    }

    const ink = await waitFor('painted pdf canvas', pageCanvasInk, [], { timeout: 150000, interval: 1000 });
    // A blank <canvas> still exists; only the pixels tell the pdf.js render apart
    // from an empty element (the live Chromium run measures ~300 ink pixels here).
    if (ink.inkPixels < 25) {
      throw new Error(
        `the PDF page canvas stayed blank: ${ink.inkPixels} ink pixels of ${ink.sampled} probed (canvas ${ink.width}x${ink.height}, ${ink.opaque} opaque)`,
      );
    }
    return {
      ok: !!ink.ok,
      detail: {
        delivered: delivered,
        outcome: outcome,
        opened: opened,
        textLayerOk: textLayerOk,
        reader: reader,
        switched: switched,
        ink: ink,
      },
    };
  });

  // (e) Settings has the TTS controls behind the same React code the voice uses.
  await step('e.settings-tts', async () => {
    if (!browser) throw new Error('no browser session');
    const url = pageUrl('settings');
    await goto(url);
    const snapshot = await waitFor('settings page', settingsSnapshot, [], { timeout: 120000, interval: 750 });
    return { ok: true, detail: snapshot };
  });

  // (f) A screenshot taken by the simulator itself, not by WebDriver: it proves
  //     the window really was up, and it survives a broken WebDriver session.
  await step('f.simulator-artifacts', async () => {
    const shot = await simctlScreenshot();
    return { ok: !!shot.ok, detail: shot };
  });
}

try {
  await main();
} catch (error) {
  log({ event: 'fatal', error: message(error), stack: error && error.stack ? String(error.stack).slice(0, 2000) : null });
  records.push({ name: 'fatal', ok: false, ms: 0, detail: null, error: message(error) });
} finally {
  if (browser) {
    try {
      await browser.deleteSession();
      log({ event: 'session-deleted' });
    } catch (error) {
      log({ event: 'session-delete-fail', error: message(error) });
    }
    browser = null;
  }
  // The step list is the report; a numeric exit code would hide the artifacts.
  await writeSummary();
  process.exitCode = 0;
}
