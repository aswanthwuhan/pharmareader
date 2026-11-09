/**
 * Both model libraries report download progress per file (label + loaded/total
 * bytes). `prepare(onProgress)` only receives a single 0..1 fraction, so fold
 * the per-file reports into one.
 *
 * The trap: a file's total is unknown until that file starts, so dividing by
 * "sum of the files seen so far" makes the bar read 99% the moment the small
 * first file (bundle.json, 24 KB) finishes — and stay there for the rest of a
 * 127 MB download. Passing the model's known download size keeps the bar honest
 * while files are still queued; without it the sum of the started files is the
 * best available guess.
 */
export interface FileProgress {
  label?: string;
  loaded?: number;
  total?: number;
}

export function createProgressAggregator(
  onProgress?: (fraction: number) => void,
  expectedTotalBytes = 0
): (info: FileProgress) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  let last = 0;

  return (info: FileProgress) => {
    if (!onProgress) return;
    const label = info.label;
    const total = info.total ?? 0;
    if (!label || total <= 0) return; // status pings carry no bytes to count
    files.set(label, { loaded: info.loaded ?? 0, total });

    let loaded = 0;
    let started = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      started += file.total;
    }
    const overall = Math.max(started, expectedTotalBytes, 1);
    // Cap below 1: `prepare()` emits the real 1 once the model is usable.
    const fraction = Math.min(loaded / overall, 0.99);
    if (fraction > last) {
      last = fraction;
      onProgress(fraction);
    }
  };
}
