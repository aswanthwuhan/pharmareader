/**
 * The running version, and the CHANGELOG section that describes it.
 *
 * The version comes from `package.json` through `define` in vite.config.ts (see
 * `__APP_VERSION__`), never from a fetch: the What's new sheet must work with
 * the network off, so CHANGELOG.md is bundled at build time with `?raw` and
 * parsed here as plain text. Nothing in this file touches the database or the
 * network; App decides when to show the sheet.
 */
import changelogMarkdown from '../../CHANGELOG.md?raw';

/** Set by the build; the fallback only covers a tool that skips Vite's define. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; empty for a final release. */
  pre: string[];
}

/** `v0.3.0`, `0.3.0-rc.1` and `0.3.0+build` all parse; junk returns null. */
export function parseSemver(input: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Numeric identifiers sort numerically, alphanumeric ones lexically. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: string[], b: string[]): number {
  // A final release outranks any pre-release of the same core version.
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const order = compareIdentifiers(a[i], b[i]);
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Semver order: -1 when `a` is older, 0 when equal, 1 when newer.
 * Two unparsable strings compare equal, so callers filter them out first.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/** Last version whose What's new sheet the reader has seen (or skipped). */
export const LAST_SEEN_VERSION_KEY = 'app.lastSeenVersion';

/** One "**Fixed — …**" block (or the unheaded list some releases use). */
export interface ChangelogGroup {
  title: string | null;
  bullets: string[];
}

/** One `## <version>` section of CHANGELOG.md, as the sheet renders it. */
export interface ChangelogSection {
  version: string;
  /** The plain sentences between the heading and the first group. */
  intro: string[];
  groups: ChangelogGroup[];
}

const SECTION_HEADING = /^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const GROUP_HEADING = /^\*\*([^*]+)\*\*\s*:?\s*$/;
const BULLET = /^[-*]\s+(.*)$/;

/** Markdown emphasis is not rendered (no markdown library): keep the words. */
function plain(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split CHANGELOG.md into its version sections. Only the shapes the file itself
 * uses are understood: `## 0.3.0 — date`, `**Group**` lines, `- ` bullets and
 * plain intro sentences. Anything else is kept as text, never as HTML.
 */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let section: ChangelogSection | null = null;
  let group: ChangelogGroup | null = null;
  let introOpen = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith('## ')) {
      const heading = SECTION_HEADING.exec(line);
      section = heading ? { version: heading[1], intro: [], groups: [] } : null;
      if (section) sections.push(section);
      group = null;
      introOpen = false;
      continue;
    }
    if (!section) continue;

    if (!line) {
      introOpen = false;
      continue;
    }

    const groupHeading = GROUP_HEADING.exec(line);
    if (groupHeading) {
      group = { title: plain(groupHeading[1]), bullets: [] };
      section.groups.push(group);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      if (!group) {
        group = { title: null, bullets: [] };
        section.groups.push(group);
      }
      group.bullets.push(plain(bullet[1]));
      introOpen = false;
      continue;
    }

    // A wrapped bullet continues the bullet above it; otherwise it is intro prose.
    const lastGroup = section.groups[section.groups.length - 1];
    if (lastGroup && lastGroup.bullets.length > 0) {
      const at = lastGroup.bullets.length - 1;
      lastGroup.bullets[at] = `${lastGroup.bullets[at]} ${plain(line)}`;
    } else if (introOpen) {
      section.intro[section.intro.length - 1] += ` ${plain(line)}`;
    } else {
      section.intro.push(plain(line));
      introOpen = true;
    }
  }

  return sections;
}

/** The section for one version (either spelling, `v0.3.0` or `0.3.0`). */
export function changelogSection(version: string, markdown: string = changelogMarkdown): ChangelogSection | null {
  if (!parseSemver(version)) return null;
  for (const section of parseChangelog(markdown)) {
    if (compareVersions(section.version, version) === 0) return section;
  }
  return null;
}

/**
 * Whether to open the What's new sheet on launch.
 *
 * A fresh install (no books, no stored version) has nothing to be told: record
 * the version quietly. A library that predates this feature does, and so does
 * every later upgrade.
 */
export function shouldShowWhatsNew(lastSeen: string | undefined, bookCount: number): boolean {
  if (!lastSeen) return bookCount > 0;
  return compareVersions(APP_VERSION, lastSeen) > 0;
}
