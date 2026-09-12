/**
 * R2 key layout — the flat, pacman-native one: databases live beside the
 * packages and are served statically from the bucket's custom domain.
 *
 *   <repo_arch>/<filename>.pkg.tar.zst        package (immutable, uploaded once)
 *   <repo_arch>/<filename>.pkg.tar.zst.sig    detached signature
 *   <repo_arch>/<repo>.db | .db.sig           generated database of a ring, e.g.
 *   <repo_arch>/<repo>.files | .files.sig     omarchy-core-stable.db
 *
 * `repo_arch` is the architecture of the upstream repository the package was
 * taken from (x86_64, aarch64). An `any` package lives in the directory of the
 * repository it came from; a different upstream's build of the same `any`
 * package is a different object in a different directory.
 */

export const REPO_ARCHES = ["x86_64", "aarch64"] as const;
export type RepoArch = (typeof REPO_ARCHES)[number];

export function isRepoArch(s: string): s is RepoArch {
  return (REPO_ARCHES as readonly string[]).includes(s);
}

export const packageKey = (repoArch: string, filename: string) => `${repoArch}/${filename}`;
export const signatureKey = (repoArch: string, filename: string) => `${repoArch}/${filename}.sig`;
export const artifactKey = (repoArch: string, repo: string, kind: string) => `${repoArch}/${repo}.${kind}`;

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT = "public, max-age=60";
