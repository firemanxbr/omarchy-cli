/**
 * R2 key layout — pacman-native, one directory per source, the way the
 * mirrors lay out `extra/os/x86_64/`: databases live beside the packages
 * and are served statically from the bucket's custom domain.
 *
 *   <source>/<repo_arch>/<filename>.pkg.tar.zst        package (immutable, uploaded once)
 *   <source>/<repo_arch>/<filename>.pkg.tar.zst.sig    detached signature
 *   <source>/<repo_arch>/<repo>.db | .db.sig           generated database of a ring, e.g.
 *   <source>/<repo_arch>/<repo>.files | .files.sig     extra/x86_64/omarchy-extra-stable.db
 *
 * `source` is the upstream repository the package was taken from (core,
 * extra, packages — the OPR —, asahi, factory, …) and `repo_arch` its
 * architecture (x86_64, aarch64). Two projects' builds of one filename
 * with different bytes — Arch's `asusctl-6.5.0-1` and the OPR's, Arch
 * Linux ARM's `libkrunfw` and Asahi's — are two objects in two
 * directories, each served by its own repository section; the pacman
 * include's order decides between them. Within one source a filename is
 * one object, uploaded once (an upstream that rebuilds the same version
 * with different bytes keeps the object already stored). An `any` package
 * lives in the directory of the repository it came from, likewise.
 *
 * The rows of the index carry their key (`packages.r2_key`): what reads an
 * object goes by the row, what stores one computes the key here.
 */

export const REPO_ARCHES = ["x86_64", "aarch64"] as const;
export type RepoArch = (typeof REPO_ARCHES)[number];

export function isRepoArch(s: string): s is RepoArch {
  return (REPO_ARCHES as readonly string[]).includes(s);
}

/** A source is a directory name: lower-case letters, digits and dashes. */
export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const packageKey = (source: string, repoArch: string, filename: string) => `${source}/${repoArch}/${filename}`;
export const signatureKey = (source: string, repoArch: string, filename: string) => `${source}/${repoArch}/${filename}.sig`;
export const artifactKey = (source: string, repoArch: string, repo: string, kind: string) => `${source}/${repoArch}/${repo}.${kind}`;
/** The directory of a key: what a repository section's `Server =` names. */
export const keyDir = (key: string) => key.slice(0, key.lastIndexOf("/"));

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT = "public, max-age=60";
