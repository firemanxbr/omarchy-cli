import type { Env } from "./index";

export const REPO_URL = "https://github.com/firemanxbr/omarchy-pool";
export const DASHBOARD_HOST = "omarchy-pool.firemanxbr.org";
export const LEGACY_DASHBOARD_HOST = "dashboard-omarchy.firemanxbr.org";

export interface RunningVersion {
  version: string;
  commit: string | null;
  deployed_at: string | null;
  release_url: string | null;
  commit_url: string | null;
}

/** What is running: the release tag, its commit and when it was deployed. */
export function version(env: Env): RunningVersion {
  const v = env.POOL_VERSION || "dev";
  const commit = env.POOL_COMMIT || null;
  return {
    version: v,
    commit,
    deployed_at: env.POOL_DEPLOYED_AT || null,
    release_url: v === "dev" ? null : `${REPO_URL}/releases/tag/${v}`,
    commit_url: commit ? `${REPO_URL}/commit/${commit}` : null,
  };
}

/**
 * Every upstream repository the pipeline mirrors (the SOURCES table of
 * SYNC_SOURCES in scheduler.ts), so the dashboard can show what has not been synced yet.
 */
export const EXPECTED_SOURCES: { source: string; arch: string; upstream: string; optional?: boolean; title: string }[] = [
  { source: "core", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux core" },
  { source: "extra", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux extra" },
  { source: "multilib", arch: "x86_64", upstream: "mirror.omarchy.org", title: "Arch Linux multilib" },
  { source: "packages", arch: "x86_64", upstream: "pkgs.omarchy.org", title: "Omarchy (OPR), the ring's channel" },
  { source: "chaotic", arch: "x86_64", upstream: "builds.garudalinux.org", optional: true, title: "chaotic-aur: prebuilt AUR packages (only names no other source provides)" },
  { source: "core", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM core" },
  { source: "extra", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM extra" },
  { source: "alarm", arch: "aarch64", upstream: "os.archlinuxarm.org", title: "Arch Linux ARM alarm" },
  { source: "packages", arch: "aarch64", upstream: "pkgs.omarchy.org", title: "Omarchy (OPR), the ring's channel" },
  { source: "asahi", arch: "aarch64", upstream: "github.com/maralcbr/omarchy-pkgs", title: "Omarchy for Apple Silicon: the fork's newest stable snapshot" },
  { source: "asahi-alarm", arch: "aarch64", upstream: "github.com/asahi-alarm/asahi-alarm", title: "Asahi Linux for Arch Linux ARM: kernel, graphics, firmware" },
  { source: "aur", arch: "aarch64", upstream: "os.archlinuxarm.org", optional: true, title: "Arch Linux ARM's prebuilt AUR selection (only names no other source provides)" },
  { source: "factory", arch: "x86_64", upstream: "the factory", title: "Built by the factory from reviewed PKGBUILDs (factory/pkgbuilds)" },
  { source: "factory", arch: "aarch64", upstream: "the factory", title: "Built by the factory from reviewed PKGBUILDs (factory/pkgbuilds)" },
];
