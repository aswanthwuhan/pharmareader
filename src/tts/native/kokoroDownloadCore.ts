/**
 * The native Kokoro download, outside any component.
 *
 * `KokoroNativePanel` and the reader's voice sheet both need the same download: the
 * plugin fetches the archive on its own io thread, loads it, and measures the speed.
 * The first began inside a Settings panel; the sheet must not grow a second copy of
 * that logic, so the run lives here and both callers pass it to `startDownload`.
 */
import type { DownloadReporter } from '../downloads';
import { measureRtf } from '../neural/benchmark';
import {
  DEFAULT_KOKORO_MODEL,
  kokoroNativeEngine,
} from './kokoroNativeEngine';
import {
  followRunningDownload,
  isBusyError,
  tagDownloadStage,
} from './kokoroDownload';
import type { KokoroStage } from './kokoroFailure';
import { Kokoro } from './kokoroPlugin';

/** The one native model download, shared by every mount of the Settings panel and the reader sheet. */
export const KOKORO_DOWNLOAD_ID = 'kokoro';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Download the archive, then load the model — outside the component, so leaving
 * Settings or closing the reader sheet cannot stop it. The native plugin downloads on
 * its own io thread and keeps going after the WebView stops listening.
 */
export async function runKokoroNativeDownload(report: DownloadReporter): Promise<void> {
  const forward = (stage: KokoroStage): void => {
    if (stage === 'download' || stage === 'unpack' || stage === 'load') report({ stage });
  };
  // The catch needs the stage that actually failed, not the last rendered one.
  let failedAt: KokoroStage = 'status';
  const attempt = async (): Promise<void> => {
    await kokoroNativeEngine.prepare(
      (value) => report({ fraction: clamp01(value) }),
      (next) => {
        failedAt = next;
        forward(next);
      }
    );
  };

  try {
    await attempt();
    // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
    void measureRtf(kokoroNativeEngine).catch(() => undefined);
    return;
  } catch (err) {
    // BUSY is not a failure: the plugin refused a second download because the
    // first one (a previous mount, or the native side itself) is still running.
    // Wait for that one instead of reporting "download error".
    if (!isBusyError(err)) throw tagDownloadStage(err, failedAt);
  }

  report({ stage: 'download' });
  try {
    await followRunningDownload({
      status: () => Kokoro.status({ model: DEFAULT_KOKORO_MODEL }),
      listen: async (onFraction) => {
        const handle = await Kokoro.addListener('downloadProgress', (progress) =>
          onFraction(progress.fraction)
        );
        return () => {
          void handle.remove().catch(() => undefined);
        };
      },
      onProgress: (value) => report({ fraction: value }),
      onUnpacking: () => {
        failedAt = 'unpack';
        forward('unpack');
      },
    });
    // The archive is complete; load it the way the first call would have.
    failedAt = 'load';
    await attempt();
  } catch (err) {
    throw tagDownloadStage(err, failedAt);
  }
}
