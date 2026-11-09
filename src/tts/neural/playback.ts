/**
 * Raw-PCM playback for the neural engines.
 *
 * `FloatPlayer` plays model output through Web Audio (so `playbackRate` can
 * change speed without re-synthesising). It exposes pause/resume/stop because
 * `TtsEngine` does, and `play()` resolves when the audio ends — or when
 * `stop()`/`dispose()` is called, so a stopped utterance never looks like a hang.
 */

export class FloatPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private settle: (() => void) | null = null;
  /** Bumped by stop(); a play() that was awaiting ctx.resume() must not start. */
  private epoch = 0;
  private paused = false;
  /** Resolved by resume()/stop() so a play() parked on pause() can continue. */
  private gate: (() => void) | null = null;

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  /** Play one utterance; resolves when it ends or `stop()` is called. */
  async play(samples: Float32Array, sampleRate: number, rate = 1): Promise<void> {
    if (samples.length === 0) return;
    const ctx = this.context();
    const epoch = ++this.epoch;
    // Autoplay policy: the context starts suspended until a user gesture. Do not
    // undo an explicit pause() here — resume() is the only thing that may.
    if (ctx.state === 'suspended' && !this.paused) await ctx.resume().catch(() => {});
    if (this.paused) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    // stop()/dispose() may have landed while the context was resuming or paused.
    if (epoch !== this.epoch) return;

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
    this.paused = true;
    void this.ctx?.suspend().catch(() => {});
  }

  resume(): void {
    this.paused = false;
    this.gate?.();
    this.gate = null;
    void this.ctx?.resume().catch(() => {});
  }

  stop(): void {
    this.epoch++;
    this.paused = false;
    this.gate?.();
    this.gate = null;
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
