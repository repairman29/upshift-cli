import semver from "semver";

/** Classify semver delta between locked/current and target versions (used by plan and tests). */
export function getUpgradeType(current: string, target: string): "major" | "minor" | "patch" {
  const c = semver.coerce(current)?.version;
  const t = semver.coerce(target)?.version;
  if (!c || !t) return "major";
  if (semver.major(t) > semver.major(c)) return "major";
  if (semver.minor(t) > semver.minor(c)) return "minor";
  return "patch";
}
