/**
 * Two small playback helpers shared by the neural engines.
 *
 * FloatPlayer plays raw PCM from the models through Web Audio (so `playbackRate`
 * can change speed without re-synthesising); ElementPlayer streams the MP3 the
 * Kokoro server returns. Both expose pause/resume/stop because `TtsEngine` does,
 * and both resolve their `play()` promise when the audio ends or is stopped.
 */

export class FloatPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private settle: (() => void) | null = null;

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  /** Play one utterance; resolves when it ends or `stop()` is called. */
  async play(samples: Float32Array, sampleRate: number, rate = 1): Promise<void> {
    if (samples.length === 0) return;
    const ctx = this.context();
    // Autoplay policy: the context starts suspended until a user gesture.
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(ctx.destination);
    this.source = source;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        source.disconnect();
        if (this.source === source) this.source = null;
        if (this.settle === done) this.settle = null;
        resolve();
      };
      this.settle = done;
      source.onended = done;
      source.start();
    });
  }

  pause(): void {
    void this.ctx?.suspend().catch(() => {});
  }

  resume(): void {
    void this.ctx?.resume().catch(() => {});
  }

  stop(): void {
    const source = this.source;
    this.source = null;
    try {
      source?.stop(); // silence immediately; `done` will also fire from onended
    } catch {
      // Already stopped — nothing to release.
    }
    this.settle?.(); // resolve first so a stopped utterance never looks like a hang
  }

  async dispose(): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close().catch(() => {});
  }
}

export class ElementPlayer {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private settle: (() => void) | null = null;

  /** Play one blob; resolves when it ends, fails or `stop()` is called. */
  async play(blob: Blob): Promise<void> {
    this.release();
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.preload = 'auto';
    el.playbackRate = 1;
    this.el = el;
    this.url = url;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.settle === done) this.settle = null;
        if (this.el === el) this.el = null;
        this.release();
        resolve();
      };
      this.settle = done;
      el.onended = done;
      el.onerror = done;
      void el.play().catch(done); // autoplay refusal is reported by the engine
    });
  }

  pause(): void {
    this.el?.pause();
  }

  resume(): void {
    void this.el?.play().catch(() => {});
  }

  stop(): void {
    this.settle?.();
    this.el?.pause();
    this.el = null;
    this.release();
  }

  dispose(): void {
    this.stop();
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    if (this.el) {
      this.el.onended = null;
      this.el.onerror = null;
      this.el.src = '';
      this.el = null;
    }
  }
}
