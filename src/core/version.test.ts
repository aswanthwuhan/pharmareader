import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { APP_VERSION, changelogSection, compareVersions, parseChangelog, parseSemver, shouldShowWhatsNew } from './version';

describe('semver', () => {
  it('parses plain, v-prefixed and pre-release versions', () => {
    expect(parseSemver('0.3.0')).toEqual({ major: 0, minor: 3, patch: 0, pre: [] });
    expect(parseSemver('v1.2.10')).toEqual({ major: 1, minor: 2, patch: 10, pre: [] });
    expect(parseSemver('0.4.0-rc.2')?.pre).toEqual(['rc', '2']);
    // Build metadata is allowed and ignored.
    expect(parseSemver('0.4.0+build.7')?.pre).toEqual([]);
  });

  it('rejects anything that is not a version', () => {
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('0.3')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('orders by number, not by string', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
  });

  it('ranks a pre-release below its final release', () => {
    expect(compareVersions('0.4.0-rc.1', '0.4.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0-rc.1')).toBe(1);
    expect(compareVersions('0.4.0-rc.2', '0.4.0-rc.1')).toBe(1);
    expect(compareVersions('0.4.0-beta', '0.4.0-rc.1')).toBe(-1);
  });

  it('treats unparsable input as equal rather than as an update', () => {
    expect(compareVersions('not-a-version', '0.3.0')).toBe(0);
  });
});

describe('the running version', () => {
  it('comes from package.json through the build', () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });
});

describe('changelog parsing', () => {
  const sections = parseChangelog(
    [
      '# Changelog',
      '',
      '## 0.3.0 — 2026-11-10',
      'One short intro.',
      'That wraps onto a second line.',
      '',
      '**Fixed — your data**',
      '- A bullet.',
      '- Another bullet that carries on',
      '  onto its next line.',
      '',
      '**Known limits**',
      '- One limit.',
      '',
      '## 0.1.0 — 2026-11-09',
      '- Unheaded bullet.',
    ].join('\n'),
  );

  it('splits at ## headings and keeps the intro apart from the groups', () => {
    expect(sections.map((section) => section.version)).toEqual(['0.3.0', '0.1.0']);
    expect(sections[0].intro).toEqual(['One short intro. That wraps onto a second line.']);
  });

  it('keeps group headings, bullets and wrapped bullet lines in order', () => {
    expect(sections[0].groups.map((group) => group.title)).toEqual(['Fixed — your data', 'Known limits']);
    expect(sections[0].groups[0].bullets).toEqual(['A bullet.', 'Another bullet that carries on onto its next line.']);
    expect(sections[0].groups[1].bullets).toEqual(['One limit.']);
  });

  it('gives an unheaded list a group with no title', () => {
    expect(sections[1].groups).toEqual([{ title: null, bullets: ['Unheaded bullet.'] }]);
  });
});

describe('the real CHANGELOG.md', () => {
  const section = changelogSection('0.3.0');

  it('has a section for the running version', () => {
    expect(section).not.toBeNull();
    expect(section?.version).toBe('0.3.0');
  });

  it('reads the 0.3.0 intro, groups and bullets', () => {
    expect(section?.intro.join(' ')).toContain('full audit of 0.2.0');
    expect(section?.groups.map((group) => group.title)).toEqual([
      'Fixed — your data',
      'Fixed — listening',
      'New',
      'Known limits',
    ]);
    // Counts follow the changelog; only require every group to have bullets.
    expect(section?.groups.every((group) => group.bullets.length > 0)).toBe(true);
    expect(section?.groups[0].bullets[0]).toContain('Restoring a backup failed');
  });

  it('renders no markdown emphasis or backticks, only words', () => {
    const text = (section?.groups ?? []).flatMap((group) => group.bullets).join('\n');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
  });

  it('accepts a v prefix and returns null for a version it does not know', () => {
    expect(changelogSection('v0.3.0')?.version).toBe('0.3.0');
    expect(changelogSection('9.9.9')).toBeNull();
    expect(changelogSection('not-a-version')).toBeNull();
  });

  it('still parses the oldest, unheaded release notes', () => {
    const oldest = changelogSection('0.1.0');
    expect(oldest?.groups[0].title).toBeNull();
    expect(oldest?.groups[0].bullets.length).toBe(8);
  });
});

describe('whether to show What’s new', () => {
  it('stays quiet on a fresh install (no books, no stored version)', () => {
    expect(shouldShowWhatsNew(undefined, 0)).toBe(false);
  });

  it('greets an existing library that predates the feature', () => {
    expect(shouldShowWhatsNew(undefined, 2)).toBe(true);
  });

  it('shows after a version bump and not again for the same version', () => {
    expect(shouldShowWhatsNew('0.2.0', 3)).toBe(true);
    expect(shouldShowWhatsNew(packageJson.version, 3)).toBe(false);
  });

  it('does not show when the stored version is newer (a rollback)', () => {
    expect(shouldShowWhatsNew('9.0.0', 3)).toBe(false);
  });
});
