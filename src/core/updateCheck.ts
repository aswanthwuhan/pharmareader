/**
 * The one network call this app makes on its own — and only after the reader
 * turns it on in Settings → About.
 *
 * It asks GitHub's public API for the latest PharmaReader release. No account,
 * no key, no identifier and no other data: one GET a day at most, with only an
 * Accept header. Every failure (offline, timeout, rate limit, a malformed
 * release list) is silent — an update is a convenience, never an error the
 * reader has to see.
 */
import { getSetting, setSetting } from './settings';
import { APP_VERSION, compareVersions, parseSemver } from './version';

export const UPDATE_CHECK_KEY = 'app.updateCheck';
export const UPDATE_CHECKED_AT_KEY = 'app.updateCheckedAt';
export const UPDATE_DISMISSED_KEY = 'app.updateDismissed';

/** One check per day is plenty: releases are not hourly news. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A slow mobile network must not hold the app open. */
export const UPDATE_TIMEOUT_MS = 10_000;
export const RELEASES_URL = 'https://api.github.com/repos/aswanthwuhan/pharmareader/releases?per_page=5';

/** A release newer than the running app, as the Library banner needs it. */
export interface UpdateRelease {
  /** `0.4.0` — tag_name without its leading v. */
  version: string;
  /** The release page, opened in the system browser by the shells. */
  url: string;
}

/** `v0.4.0` → `0.4.0`; anything else is returned trimmed, without its v. */
export function releaseVersion(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

/**
 * The newest published release newer than `current`, or null.
 *
 * Drafts are skipped because they are not downloadable yet; pre-releases count
 * (every PharmaReader release so far is one). Tags that are not semver are
 * ignored rather than shown as an update.
 */
export function pickNewerRelease(releases: unknown, current: string = APP_VERSION): UpdateRelease | null {
  if (!Array.isArray(releases)) return null;

  let newest: UpdateRelease | null = null;
  for (const entry of releases) {
    if (!entry || typeof entry !== 'object') continue;
    const release = entry as { draft?: unknown; tag_name?: unknown; html_url?: unknown };
    if (release.draft === true) continue;
    if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') continue;
    // The link is rendered as an anchor: only a GitHub https page may become one.
    if (!release.html_url.startsWith('https://github.com/')) continue;

    const version = releaseVersion(release.tag_name);
    if (!parseSemver(version)) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (!newest || compareVersions(version, newest.version) > 0) {
      newest = { version, url: release.html_url };
    }
  }
  return newest;
}

/** True when the toggle is on and the last attempt is at least a day old. */
export function isUpdateCheckDue(enabled: boolean, lastCheckedAt: number | undefined, now: number): boolean {
  if (!enabled) return false;
  if (lastCheckedAt === undefined) return true;
  // A clock set back must not turn the check into a background poller.
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export interface CheckOptions {
  /** Current time, injectable for tests. */
  now?: number;
  /** The 10 s abort budget, injectable for tests. */
  timeoutMs?: number;
}

/**
 * Ask GitHub for a newer release, if the reader opted in and a day has passed.
 * Resolves to null for every "no banner" case, including every failure.
 */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateRelease | null> {
  const now = options.now ?? Date.now();

  const enabled = await getSetting<boolean>(UPDATE_CHECK_KEY, false);
  const lastCheckedAt = await getSetting<number | undefined>(UPDATE_CHECKED_AT_KEY, undefined);
  if (!isUpdateCheckDue(enabled, lastCheckedAt, now)) return null;
  if (!online()) return null;

  // Stamp the attempt before the request: a timeout, a rate limit or an offline
  // blip still costs the day, so opening the app five times does not mean five
  // requests.
  await setSetting(UPDATE_CHECKED_AT_KEY, now).catch(() => undefined);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const release = pickNewerRelease(await response.json());
    if (!release) return null;

    const dismissed = await getSetting<string | undefined>(UPDATE_DISMISSED_KEY, undefined);
    if (dismissed === release.version) return null;
    return release;
  } catch {
    // Offline, DNS failure, abort, bad JSON: nothing for the reader to do.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "Not now": never show this version again. */
export async function dismissUpdate(version: string): Promise<void> {
  await setSetting(UPDATE_DISMISSED_KEY, version);
}
