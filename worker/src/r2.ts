/**
 * R2 key layout — the flat, pacman-native one: databases live beside the
 * packages and are served statically from the bucket's custom domain.
 *
 *   <arch>/<filename>.pkg.tar.zst           package (immutable, uploaded once)
 *   <arch>/<filename>.pkg.tar.zst.sig       detached signature
 *   <arch>/<repo>.db | .db.sig              generated database of a ring, e.g.
 *   <arch>/<repo>.files | .files.sig        omarchy-core-stable.db
 *
 * `any` packages are stored under every served architecture directory so that
 * pacman finds them beside the database it read.
 */

export const ARCH_DIRS = ["x86_64"] as const;

export function archDirsFor(arch: string): readonly string[] {
  return arch === "any" ? ARCH_DIRS : [arch];
}

export const packageKey = (archDir: string, filename: string) => `${archDir}/${filename}`;
export const signatureKey = (archDir: string, filename: string) => `${archDir}/${filename}.sig`;
export const artifactKey = (archDir: string, repo: string, kind: string) => `${archDir}/${repo}.${kind}`;

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT = "public, max-age=60";
