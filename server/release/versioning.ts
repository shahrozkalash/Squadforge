/**
 * Phase 23: semantic versioning for desktop releases, plus stamping
 * the version into a .csproj so the built binary, the package and
 * the release manifest all agree.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemVer(text: string): SemVer {
  const m = text.trim().match(SEMVER_RE);
  if (!m) throw new Error(`Invalid semantic version: ${text}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] };
}

export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A release outranks its own prereleases; prereleases compare lexically (sufficient for channel bookkeeping).
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function bumpSemVer(v: SemVer, kind: 'major' | 'minor' | 'patch'): SemVer {
  switch (kind) {
    case 'major': return { major: v.major + 1, minor: 0, patch: 0 };
    case 'minor': return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'patch': return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

/** Replace or insert <Version> (and <FileVersion>) in a .csproj document. */
export function stampCsprojVersion(csprojXml: string, version: string): string {
  parseSemVer(version); // validates
  let out = csprojXml;
  if (/<Version>.*?<\/Version>/.test(out)) {
    out = out.replace(/<Version>.*?<\/Version>/, `<Version>${version}</Version>`);
  } else if (/<PropertyGroup>/.test(out)) {
    out = out.replace(/<PropertyGroup>/, `<PropertyGroup>\n    <Version>${version}</Version>`);
  } else {
    throw new Error('csproj has no PropertyGroup to stamp a version into');
  }
  if (/<FileVersion>.*?<\/FileVersion>/.test(out)) {
    out = out.replace(/<FileVersion>.*?<\/FileVersion>/, `<FileVersion>${version}</FileVersion>`);
  }
  return out;
}

export function readCsprojVersion(csprojXml: string): string | null {
  const m = csprojXml.match(/<Version>(.*?)<\/Version>/);
  return m ? m[1].trim() : null;
}
