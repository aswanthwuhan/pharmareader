/**
 * Both model libraries report download progress per file (label + loaded/total
 * bytes). `prepare(onProgress)` only receives a single 0..1 fraction, so fold
 * the per-file reports into one: files that have not started yet contribute
 * nothing, which means the bar never jumps ahead of the bytes actually fetched.
 */
export interface FileProgress {
  label?: string;
  loaded?: number;
  total?: number;
}

export function createProgressAggregator(
  onProgress?: (fraction: number) => void
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
    let sum = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      sum += file.total;
    }
    // Cap below 1: a later file's total is unknown until it starts.
    const fraction = sum > 0 ? Math.min(loaded / sum, 0.99) : 0;
    if (fraction > last) {
      last = fraction;
      onProgress(fraction);
    }
  };
}
