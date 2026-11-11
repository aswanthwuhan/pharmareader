// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TtsEngine } from '../core/types';
import { db } from '../core/db';
import VoiceTest, { VOICE_TEST_SENTENCE, type VoiceTestProps } from './VoiceTest';

/** The smallest engine that can speak: only `stop` is ever called by the test. */
function fakeEngine(synthesize?: TtsEngine['synthesize']): TtsEngine {
  return {
    id: 'pocket',
    label: 'Fake engine',
    capabilities: { streaming: true, prerender: false, wordBoundaries: false, needsDownload: true },
    isReady: () => Promise.resolve(true),
    prepare: () => Promise.resolve(),
    listVoices: () => Promise.resolve([]),
    speak: () => Promise.resolve(),
    stop: vi.fn(),
    pause: () => undefined,
    resume: () => undefined,
    ...(synthesize ? { synthesize } : {}),
  };
}

/**
 * jsdom has no media stack: `Audio` is a stub that records play/pause and can
 * fire the events the component listens for, so "second tap stops it" is a fact
 * about the component rather than about jsdom's silence.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = false;
  playing = false;
  private listeners = new Map<string, () => void>();

  constructor(src?: string) {
    this.src = src ?? '';
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  play(): Promise<void> {
    this.paused = false;
    this.playing = true;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.playing = false;
  }

  end(): void {
    this.listeners.get('ended')?.();
  }

  error(): void {
    this.listeners.get('error')?.();
  }
}

type UrlStatics = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

const savedCreate = (URL as unknown as UrlStatics).createObjectURL;
const savedRevoke = (URL as unknown as UrlStatics).revokeObjectURL;
const revokeObjectURL = vi.fn();

let root: Root | null = null;
let container: HTMLDivElement;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Poll inside act() until `check` passes; the lexicon seed is asynchronous. */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await settle(25);
  }
  expect(check()).toBe(true);
}

async function show(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root!.render(node);
  });
  await settle();
}

async function mount(props: VoiceTestProps): Promise<void> {
  await show(<VoiceTest {...props} />);
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent === label);
}

function button(label: string): HTMLButtonElement {
  return buttons(label)[0];
}

function status(): string {
  return container.querySelector('.tts-status')?.textContent ?? '';
}

function lastAudio(): FakeAudio {
  const audio = FakeAudio.instances.at(-1);
  if (!audio) throw new Error('no audio element was created');
  return audio;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
  await settle();
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeAudio.instances = [];
  revokeObjectURL.mockClear();
  vi.stubGlobal('Audio', FakeAudio);
  (URL as unknown as UrlStatics).createObjectURL = vi.fn(() => 'blob:sample');
  (URL as unknown as UrlStatics).revokeObjectURL = revokeObjectURL;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await db.settings.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  if (savedCreate) (URL as unknown as UrlStatics).createObjectURL = savedCreate;
  else delete (URL as unknown as UrlStatics).createObjectURL;
  if (savedRevoke) (URL as unknown as UrlStatics).revokeObjectURL = savedRevoke;
  else delete (URL as unknown as UrlStatics).revokeObjectURL;
});

describe('VoiceTest', () => {
  it('speaks a short sample with the engine, the chosen voice and the current rate', async () => {
    const synthesize = vi.fn(async (text: string, _opts?: { voiceId?: string; rate?: number }) => {
      void text;
      return new Blob(['wav']);
    });
    await mount({ engine: fakeEngine(synthesize), voiceId: 'af_bella', rate: 1.25 });

    await click('Test voice');
    await waitFor(() => synthesize.mock.calls.length > 0);

    expect(synthesize).toHaveBeenCalledWith(expect.any(String), {
      voiceId: 'af_bella',
      rate: 1.25,
    });
    // The spoken text is the short sample, not the engine's default paragraph.
    expect(String(synthesize.mock.calls[0]?.[0])).toContain('This is how your book will sound');

    await waitFor(() => buttons('Stop test').length === 1);
    expect(status()).toBe('Playing the sample.');

    // A voice check must not add anything to the audio cache.
    expect(await db.audioCache.count()).toBe(0);

    await act(async () => lastAudio().end());
    await settle();
    expect(button('Test voice')).toBeDefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample');
  });

  it('says it is preparing while the model synthesises', async () => {
    let release!: (blob: Blob) => void;
    const synthesize = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve;
        })
    );
    await mount({ engine: fakeEngine(synthesize), voiceId: 'pocket_default', rate: 1 });

    await click('Test voice');
    await waitFor(() => buttons('Preparing…').length === 1);
    expect(status()).toBe('Preparing the sample…');
    // A second tap must remain possible while the model is busy.
    expect(button('Preparing…').disabled).toBe(false);

    await act(async () => release(new Blob(['wav'])));
    await waitFor(() => buttons('Stop test').length === 1);
  });

  it('stops the sample on a second tap', async () => {
    const engine = fakeEngine(async () => new Blob(['wav']));
    await mount({ engine, voiceId: 'af_bella', rate: 1 });

    await click('Test voice');
    await waitFor(() => buttons('Stop test').length === 1);
    const audio = lastAudio();
    expect(audio.playing).toBe(true);

    await click('Stop test');
    expect(audio.paused).toBe(true);
    expect(engine.stop).toHaveBeenCalled();
    expect(button('Test voice')).toBeDefined();
    expect(status()).toBe('');
  });

  it('plays one sample at a time across panels', async () => {
    const first = fakeEngine(async () => new Blob(['wav']));
    const second = fakeEngine(async () => new Blob(['wav']));
    await show(
      <>
        <VoiceTest engine={first} voiceId="af_bella" rate={1} />
        <VoiceTest engine={second} voiceId="am_adam" rate={1} />
      </>
    );

    await act(async () => buttons('Test voice')[0]!.click());
    await waitFor(() => buttons('Stop test').length === 1);
    const firstAudio = lastAudio();
    expect(firstAudio.playing).toBe(true);

    // Starting the other panel's test stops the first one, which goes back to
    // "Test voice" instead of claiming to own audio that is now someone else's.
    await act(async () => buttons('Test voice')[0]!.click());
    await settle(25);
    expect(firstAudio.paused).toBe(true);
    expect(first.stop).toHaveBeenCalled();
    expect(buttons('Test voice').length).toBe(1);
    expect(buttons('Stop test').length).toBe(1);
  });

  it('is disabled with a one-line reason when the model is not ready', async () => {
    const synthesize = vi.fn(async () => new Blob(['wav']));
    await mount({
      engine: fakeEngine(synthesize),
      voiceId: 'af_bella',
      rate: 1,
      disabledReason: 'Download the model first',
    });

    const test = button('Test voice');
    expect(test.disabled).toBe(true);
    expect(container.textContent).toContain('Download the model first');
    const reason = container.querySelector('.field-hint');
    expect(reason?.textContent).toBe('Download the model first');
    expect(test.getAttribute('aria-describedby')).toBe(reason?.id);

    await act(async () => test.click());
    await settle(25);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('speaks through the platform for an engine without synthesize()', async () => {
    let finish!: () => void;
    const engine = fakeEngine();
    engine.speak = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await mount({ engine, voiceId: '', rate: 1.5, sample: 'This is how your book will sound.' });

    await click('Test voice');
    await waitFor(() => buttons('Stop test').length === 1);
    expect(engine.speak).toHaveBeenCalledWith(
      [{ id: 'voice-test', text: VOICE_TEST_SENTENCE }],
      { voiceId: undefined, rate: 1.5 },
      expect.anything()
    );

    await act(async () => finish());
    await settle();
    expect(button('Test voice')).toBeDefined();
    expect(await db.audioCache.count()).toBe(0);
  });

  it('stops the sample when the panel unmounts', async () => {
    await mount({ engine: fakeEngine(async () => new Blob(['wav'])), voiceId: 'af_bella', rate: 1 });
    await click('Test voice');
    await waitFor(() => buttons('Stop test').length === 1);
    const audio = lastAudio();

    await act(async () => root?.unmount());
    root = null;
    expect(audio.paused).toBe(true);
  });

  it('keeps Stop available when the model goes away mid-sample', async () => {
    // Deleting the model, or switching the app to another engine, disables the
    // button while the sample is still talking. A disabled "Stop test" would
    // leave the reader with audio it cannot silence until the clip ends.
    const engine = fakeEngine(async () => new Blob(['wav']));
    await mount({ engine, voiceId: 'af_bella', rate: 1 });
    await click('Test voice');
    await waitFor(() => buttons('Stop test').length === 1);
    const audio = lastAudio();

    await show(
      <VoiceTest
        engine={engine}
        voiceId="af_bella"
        rate={1}
        disabledReason="Download the model first"
      />
    );

    const stop = button('Stop test');
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(audio.paused).toBe(true);
    expect(button('Test voice').disabled).toBe(true);
    expect(status()).toBe('');
  });

  it('shows why the sample failed and leaves the button ready to retry', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('The model failed to load.');
    });
    await mount({ engine: fakeEngine(synthesize), voiceId: 'af_bella', rate: 1 });

    await click('Test voice');
    await waitFor(() => status() === 'The model failed to load.');

    expect(FakeAudio.instances).toHaveLength(0);
    expect(button('Test voice').disabled).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('reports playback the browser refuses to start', async () => {
    class BlockedAudio extends FakeAudio {
      play(): Promise<void> {
        return Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
      }
    }
    vi.stubGlobal('Audio', BlockedAudio);
    await mount({ engine: fakeEngine(async () => new Blob(['wav'])), voiceId: 'af_bella', rate: 1 });

    await click('Test voice');
    await waitFor(() => status() === 'The browser blocked playback.');

    // A refused sample must not leave a claimed "Stop test" behind.
    expect(button('Test voice')).toBeDefined();
    expect(lastAudio().paused).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sample');
  });

  it('does not start playing a sample whose preparation was stopped', async () => {
    let release!: (blob: Blob) => void;
    const synthesize = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve;
        })
    );
    await mount({ engine: fakeEngine(synthesize), voiceId: 'af_bella', rate: 1 });

    await click('Test voice');
    await waitFor(() => buttons('Preparing…').length === 1);
    await click('Preparing…');

    await act(async () => release(new Blob(['wav'])));
    await settle(25);

    expect(FakeAudio.instances).toHaveLength(0);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(button('Test voice')).toBeDefined();
  });

  it('stops playing once the sample ends', async () => {
    await mount({ engine: fakeEngine(async () => new Blob(['wav'])), voiceId: 'af_bella', rate: 1 });
    await click('Test voice');
    await waitFor(() => buttons('Stop test').length === 1);

    await act(async () => lastAudio().end());
    await settle();
    expect(button('Test voice')).toBeDefined();
    expect(status()).toBe('');
  });
});
