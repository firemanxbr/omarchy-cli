/**
 * The categories a package can belong to — what a person browsing the pool
 * looks for, not who reviews it (nobody reviews by area: every maintainer
 * reviews everything, docs/GOVERNANCE.md). The project's agent proposes one
 * from the evidence when it audits a staged build; a maintainer settles it at
 * review and may change it any time. A fixed list, so the dashboard and the
 * agent speak the same words.
 */
export const CATEGORIES = [
  "terminal", // terminals, shells, prompts, TUI tools
  "editors", // text editors and IDEs
  "development", // compilers, SDKs, build tools, version control
  "browsers",
  "communication", // chat, mail, video calls
  "media", // audio and video: players, editors, converters
  "graphics", // images, design, 3D
  "office", // documents, notes, calendars, productivity
  "games",
  "system", // daemons, drivers, firmware, utilities, monitors
  "networking", // VPNs, network tools, file transfer
  "security", // password managers, encryption, keys
  "fonts",
  "themes", // icons, cursors, themes, wallpapers
  "libraries", // dependencies nobody launches
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const isCategory = (s: unknown): s is Category => typeof s === "string" && (CATEGORIES as readonly string[]).includes(s);
