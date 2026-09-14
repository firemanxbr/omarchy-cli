/**
 * The dashboard's diagrams, drawn on the server as inline SVG: the rings, the
 * factory's assembly line, the living system (packages and advisories moving
 * through the pipeline), and the architecture maintainers operate. Boxes are
 * sized from their text so nothing overflows; arrows are orthogonal and
 * labels sit beside a segment, never across one. A text with `live` carries
 * data-live="key": the page script fills it from the API.
 */

const CW = 6.6; // px per character at 11 px mono

interface Line { text: string; cls?: "live" | "amber"; live?: string }
interface Box { x: number; y: number; w: number; h: number; title: string; lines?: (string | Line)[]; cls?: string; tcls?: string; big?: boolean }

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
function lineOf(l: string | Line): Line {
  return typeof l === "string" ? { text: l } : l;
}
function fits(w: number, texts: string[]): number {
  return Math.max(w, ...texts.map((t) => Math.ceil(t.length * CW + 24)));
}
function dbox(o: Box): string {
  const lines = (o.lines ?? []).map(lineOf);
  const w = fits(o.w, lines.map((l) => l.text).concat([o.title]));
  const block = 13 + (lines.length ? 18 + 14 * (lines.length - 1) : 0);
  let top = o.y + (o.h - block) / 2 + 11;
  const cx = o.x + w / 2;
  let s = `<rect class="d-box ${o.cls ?? ""}" x="${o.x}" y="${o.y}" width="${w}" height="${o.h}"/>`;
  s += `<text class="d-t ${o.tcls ?? ""}" x="${cx}" y="${top}" text-anchor="middle"${o.big ? ' font-size="15"' : ""}>${esc(o.title)}</text>`;
  lines.forEach((l, i) => {
    top += i === 0 ? 18 : 14;
    s += `<text class="d-s${l.cls ? " " + l.cls : ""}" x="${cx}" y="${top}" text-anchor="middle"${l.live ? ` data-live="${l.live}"` : ""}>${esc(l.text)}</text>`;
  });
  return s;
}
function marker(cls?: string): string {
  return cls && cls.includes("hi") ? "arw-g" : cls && cls.includes("warn") ? "arw-a" : "arw";
}
function darrow(x1: number, y1: number, x2: number, y2: number, cls = "", both = false): string {
  return `<line class="d-l ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${marker(cls)})"${both ? ` marker-start="url(#${marker(cls)})"` : ""}/>`;
}
function dline(pts: number[], cls = ""): string {
  return `<polyline class="d-l ${cls}" points="${pts.join(" ")}"/>`;
}
function dpath(d: string, cls = "", arrow = false): string {
  return `<path class="d-l ${cls}" d="${d}"${arrow ? ` marker-end="url(#${marker(cls)})"` : ""}/>`;
}
function dlab(x: number, y: number, lines: string[], anchor = "middle", cls = ""): string {
  return lines.map((l, i) => `<text class="d-lab ${cls}" x="${x}" y="${y + i * 13}" text-anchor="${anchor}">${esc(l)}</text>`).join("");
}
/** A mark that rides a path (SMIL; the page pauses it under prefers-reduced-motion). */
function dot(path: string, color: string, dur: number, begin: number): string {
  return `<circle r="4" fill="${color}" stroke="#1a1b26" stroke-width="1.5"><animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}"/></circle>`;
}
const DEFS =
  '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b93b8"/></marker>' +
  '<marker id="arw-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#9ece6a"/></marker>' +
  '<marker id="arw-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e0af68"/></marker></defs>';
function svgo(w: number, h: number, label: string, cls = ""): string {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"${cls ? ` class="${cls}"` : ""}>${DEFS}`;
}

export type Stage = "sync" | "pin" | "promote" | "render" | "serve";

/**
 * Sources → pool → rings, with the rollback loop. `hi` lights one stage (the
 * docs' stepper shows the five variants); without it the packages move.
 */
export function ringsDiagram(hi?: Stage): string {
  const H = (k: Stage) => (hi ? (hi === k ? " hi" : " dimmed") : "");
  let s = svgo(1280, 250, "Four upstream sources feed the pool, verified and stored once, then promoted through the edge, rc and stable rings; stable rolls back by itself when a health check fails.");
  const src: [string, string][] = [["Arch Linux", "core · extra · multilib"], ["Arch Linux ARM", "core · extra · alarm"], ["Omarchy", "OPR packages"], ["Factory", "built here, by the pool"]];
  src.forEach((r, i) => {
    const y = 30 + i * 54;
    s += dbox({ x: 20, y, w: 190, h: 42, title: r[0], lines: [r[1]], cls: (i === 3 ? "hi" : "") + H("sync") });
    s += dline([210, y + 21, 250, y + 21], H("sync"));
  });
  s += dline([250, 51, 250, 213], H("sync")) + darrow(250, 132, 300, 132, H("sync"));
  s += dbox({ x: 300, y: 92, w: 190, h: 80, title: "Pool", big: true, lines: ["signature-verified", "stored once on R2"], cls: "hi" + (hi && hi !== "sync" && hi !== "pin" ? " dimmed" : "") });
  s += darrow(490, 132, 590, 132, H("pin")) + dlab(540, 120, ["≤ 3 h"], "middle", hi === "pin" ? "hi" : "");
  s += dbox({ x: 590, y: 102, w: 140, h: 60, title: "edge", big: true, tcls: "edge", lines: ["follows upstream"], cls: "edge" + (hi && hi !== "pin" && hi !== "promote" && hi !== "render" ? " dimmed" : "") });
  s += darrow(730, 132, 850, 132, H("promote")) + dlab(790, 108, ["real pacman", "+ ABI check"], "middle", hi === "promote" ? "hi" : "");
  s += dbox({ x: 850, y: 102, w: 150, h: 60, title: "rc", big: true, tcls: "rc", lines: ["both architectures"], cls: "rc" + (hi && hi !== "promote" && hi !== "render" ? " dimmed" : "") });
  s += darrow(1000, 132, 1110, 132, H("promote")) + dlab(1055, 120, ["24 h healthy"], "middle", hi === "promote" ? "hi" : "");
  s += dbox({ x: 1110, y: 102, w: 150, h: 60, title: "stable", big: true, tcls: "stable", lines: ["what you run"], cls: "stable" + (hi && hi !== "promote" && hi !== "render" && hi !== "serve" ? " dimmed" : "") });
  s += dpath("M1150 102 C1150 48, 1220 48, 1220 102", "warn" + (hi && hi !== "promote" ? " dimmed" : ""), true) + dlab(1185, 24, ["rolls back by itself", "if a health check fails"]);
  s += dlab(660, 190, ["for CI and developers"]) + dlab(925, 190, ["for testers"]) + dlab(1185, 190, ["recommended · pacman -Syu"], "middle", hi === "serve" ? "hi" : "");
  if (hi === "render") s += dlab(790, 228, ["render: one signed database per ring and architecture, checked by a real pacman before it is served"], "middle", "hi");
  if (!hi) {
    const tail = " L250 132 L300 132 L490 132 L590 132 L730 132 L850 132 L1000 132 L1110 132 L1185 132";
    s += dot("M210 51 L250 51" + tail, "#9ece6a", 10, 0) + dot("M210 105 L250 105" + tail, "#9ece6a", 10, 3.3) + dot("M210 213 L250 213" + tail, "#9ece6a", 10, 6.6);
  }
  return s + "</svg>";
}

/**
 * The factory as an assembly line: stations above, the belt below. Packages
 * ride the belt and change colour at each station — grey registered, blue
 * built, amber staged for review, green approved. The people on the floor,
 * and the agents beside them.
 */
export function factoryDiagram(): string {
  let s = svgo(1260, 330, "An assembly line: a contributor registers a package, it is built on their worker or on the community's shared workers, the evidence is staged, a maintainer rebuilds it from the recipe and approves it into the rings. Packages ride a conveyor belt below the stations.");
  s += dbox({ x: 20, y: 40, w: 170, h: 70, title: "You", big: true, lines: ["a GitHub account", "nothing else asked"] });
  s += darrow(190, 75, 250, 75) + dlab(220, 63, ["register"]);
  s += dbox({ x: 250, y: 40, w: 190, h: 70, title: "Your package", lines: ["repo URL · name · group", "PKGBUILD yours or drafted"] });
  s += darrow(440, 75, 500, 75) + dlab(470, 63, ["build"]);
  s += '<rect class="d-box" x="500" y="20" width="260" height="110"/><text class="d-t" x="630" y="40" text-anchor="middle">Build — your choice</text>';
  s += dbox({ x: 510, y: 50, w: 118, h: 70, title: "Your worker", lines: ["your machine", "your key"], tcls: "small" });
  s += dbox({ x: 632, y: 50, w: 118, h: 70, title: "Shared workers", lines: ["the community's", { text: "online now", cls: "live", live: "shared-online" }], tcls: "small" });
  s += darrow(760, 75, 820, 75) + dlab(790, 63, ["staged"]);
  s += dbox({ x: 820, y: 40, w: 180, h: 70, title: "Evidence", lines: ["PKGBUILD · log · manifest", "in your workspace"] });
  s += darrow(1000, 75, 1060, 75) + dlab(1030, 63, ["review"]);
  s += dbox({ x: 1060, y: 40, w: 180, h: 70, title: "Maintainer", lines: ["rebuilds your recipe", "on a trusted worker"], cls: "hi" });
  const drops: [number, string, string][] = [[345, "registered", "#8b93b8"], [630, "built", "#7aa2f7"], [910, "staged", "#e0af68"], [1150, "approved", "#9ece6a"]];
  for (const d of drops) s += dline([d[0], d[1] === "built" ? 130 : 110, d[0], 214], "dash") + `<text class="d-lab" x="${d[0] + 8}" y="176" style="fill:${d[2]}">${d[1]}</text>`;
  const person = (x: number, color: number | string, values: string, dur: number, extra = "") =>
    `<g transform="translate(${x} 142)"><circle cx="0" cy="0" r="8" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M-14 30 Q0 12 14 30" fill="none" stroke="${color}" stroke-width="1.5"/>${extra}<animateTransform attributeName="transform" type="translate" values="${values}" dur="${dur}s" repeatCount="indefinite"/></g>`;
  const agent = (x: number, begin: number) =>
    `<g transform="translate(${x} 142)"><rect x="-9" y="-7" width="18" height="15" rx="3" fill="none" stroke="#bb9af7" stroke-width="1.5"/><circle cx="-4" cy="0" r="1.7" fill="#bb9af7"/><circle cx="4" cy="0" r="1.7" fill="#bb9af7"/><line x1="0" y1="-7" x2="0" y2="-12" stroke="#bb9af7" stroke-width="1.5"/><circle cx="0" cy="-14" r="2" fill="#bb9af7"><animate attributeName="opacity" values="1;0.2;1" dur="1.2s" begin="${begin}s" repeatCount="indefinite"/></circle><path d="M-13 30 L-13 16 Q-13 12 -9 12 L9 12 Q13 12 13 16 L13 30" fill="none" stroke="#bb9af7" stroke-width="1.5"/></g>`;
  s += person(545, "#7aa2f7", "545 142;545 139;545 142", 1.4) + dlab(545, 190, ["contributor", "brings the recipe"]);
  s += agent(715, 0) + dlab(715, 190, ["agent", "drafts the PKGBUILD"]);
  s += agent(985, 0.6) + dlab(985, 190, ["agent", "audits the evidence"]);
  s += person(1100, "#9ece6a", "1100 142;1097 142;1100 142;1103 142;1100 142", 2.4, '<circle cx="18" cy="6" r="5" fill="none" stroke="#9ece6a" stroke-width="1.5"/><line x1="22" y1="10" x2="28" y2="16" stroke="#9ece6a" stroke-width="1.5"/>') + dlab(1100, 190, ["maintainer", "rebuilds it"]);
  s += '<rect x="20" y="222" width="1220" height="32" fill="#13141c" stroke="#2a2e3f"/><line x1="20" y1="222" x2="1240" y2="222" stroke="#8b93b8" stroke-width="1.5" stroke-dasharray="10 8"><animate attributeName="stroke-dashoffset" from="36" to="0" dur="1s" repeatCount="indefinite"/></line>';
  for (let x = 55; x < 1240; x += 70) s += `<g transform="translate(${x} 238)"><circle r="8" fill="#1f2230" stroke="#2a2e3f"/><line x1="-8" y1="0" x2="8" y2="0" stroke="#8b93b8"/><line x1="0" y1="-8" x2="0" y2="8" stroke="#8b93b8"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" additive="sum"/></g>`;
  for (let i = 0; i < 5; i++) s += `<g><rect x="-7" y="-14" width="14" height="14" fill="#8b93b8" stroke="#1a1b26" stroke-width="1.2"><animate attributeName="fill" values="#8b93b8;#8b93b8;#7aa2f7;#7aa2f7;#e0af68;#e0af68;#9ece6a;#9ece6a" keyTimes="0;0.49;0.5;0.72;0.73;0.92;0.93;1" dur="14s" begin="${i * 2.8}s" repeatCount="indefinite"/></rect><rect x="-3" y="-10" width="6" height="6" fill="#1a1b26"/><animateMotion dur="14s" begin="${i * 2.8}s" repeatCount="indefinite" path="M30 222 L1230 222"/></g>`;
  s += dlab(20, 296, ["the factory floor"], "start") + '<text x="1240" y="296" text-anchor="end" font-size="13" font-weight="600" font-family="Geist, sans-serif"><tspan fill="#8b93b8">off the belt → </tspan><tspan fill="#bb9af7">edge</tspan><tspan fill="#8b93b8"> → </tspan><tspan fill="#7aa2f7">rc</tspan><tspan fill="#8b93b8"> → </tspan><tspan fill="#9ece6a">stable</tspan><tspan fill="#8b93b8">, signed by the pool</tspan></text>';
  return s + "</svg>";
}

/**
 * The living system: packages flow from the sources through the rings, five
 * security feeds are matched against every ring, a confident fix skips the soak.
 */
export function liveDiagram(): string {
  let s = svgo(1300, 420, "Packages move from four upstream sources through the pool into the edge, rc and stable rings, while five security feeds are matched against every ring every three hours and confident fixes are fast-tracked from edge to stable.", "live");
  ["Arch Linux", "Arch Linux ARM", "Omarchy OPR", "Factory"].forEach((t, i) => {
    const y = 40 + i * 46;
    s += dbox({ x: 20, y, w: 190, h: 36, title: t }) + dline([210, y + 18, 250, y + 18]);
  });
  s += dline([250, 58, 250, 196]) + darrow(250, 127, 300, 127);
  s += dbox({ x: 300, y: 70, w: 200, h: 115, title: "Pool", big: true, lines: [{ text: "verified today: …", cls: "live", live: "verified-today" }, { text: "stored once: …", cls: "live", live: "stored-once" }, "every 3 h"] });
  s += darrow(500, 127, 600, 127) + dlab(550, 115, ["≤ 3 h"]);
  s += dbox({ x: 600, y: 97, w: 140, h: 60, title: "edge", big: true, tcls: "edge", cls: "edge", lines: [{ text: "follows upstream", live: "edge-head" }] });
  s += darrow(740, 127, 860, 127) + dlab(800, 115, ["pacman + ABI"]);
  s += dbox({ x: 860, y: 97, w: 150, h: 60, title: "rc", big: true, tcls: "rc", cls: "rc", lines: [{ text: "tested, both arches", live: "rc-head" }] });
  s += darrow(1010, 127, 1120, 127) + dlab(1065, 115, ["24 h soak"]);
  s += dbox({ x: 1120, y: 97, w: 160, h: 60, title: "stable", big: true, tcls: "stable", cls: "stable", lines: [{ text: "what you run", live: "stable-head" }] });
  s += dpath("M670 97 C670 40, 1200 40, 1200 97", "hi dash", true) + dlab(935, 34, ["fast-track: a confident fix in edge skips the soak"], "middle", "hi");
  ["Arch Security Tracker", "Debian Security Tracker", "OSV · Go modules, crates", "CISA KEV · exploited", "EPSS · likelihood"].forEach((t, i) => {
    const y = 262 + i * 32;
    s += `<rect class="d-chip" x="20" y="${y}" width="190" height="26"/><text class="d-s" x="115" y="${y + 17}" text-anchor="middle" style="fill:#a9b1d6">${esc(t)}</text>` + dline([210, y + 13, 250, y + 13]);
  });
  s += dline([250, 275, 250, 403]) + darrow(250, 339, 300, 339);
  s += dbox({ x: 300, y: 289, w: 200, h: 100, title: "Security scan", big: true, lines: [{ text: "advisories known: …", cls: "live", live: "advisories" }, { text: "open in stable: …", cls: "amber", live: "open-stable" }, "every 3 h, every ring"] });
  s += dline([500, 339, 560, 339, 560, 230, 1200, 230]) + darrow(670, 230, 670, 157) + darrow(935, 230, 935, 157) + darrow(1200, 230, 1200, 157);
  s += dlab(580, 248, ["matches open advisories against what each ring serves"], "start");
  const pkg = "M230 58 L250 58 L250 127 L300 127 L500 127 L600 127 L740 127 L860 127 L1010 127 L1120 127 L1200 127";
  s += dot(pkg, "#9ece6a", 9, 0) + dot(pkg, "#9ece6a", 9, 3) + dot(pkg, "#9ece6a", 9, 6);
  s += dot("M230 275 L250 275 L250 339 L300 339", "#e0af68", 3, 0.5) + dot("M230 371 L250 371 L250 339 L300 339", "#e0af68", 3, 2);
  s += dot("M500 339 L560 339 L560 230 L670 230 L670 157", "#e0af68", 4, 1) + dot("M500 339 L560 339 L560 230 L935 230 L935 157", "#e0af68", 5, 2.3) + dot("M500 339 L560 339 L560 230 L1200 230 L1200 157", "#e0af68", 6, 0.2);
  s += dot("M670 97 C670 40, 1200 40, 1200 97", "#9ece6a", 5, 4);
  return s + "</svg>";
}

/** What maintainers operate: the brain, the queue, the three worker roles, R2, the rings, GitHub. */
export function archDiagram(): string {
  let s = svgo(1280, 390, "Upstream mirrors and GitHub feed the brain, a Cloudflare Worker with the index in D1; it queues jobs that pool, review and community workers claim with a lease and report back; objects are stored on R2 and rendered into signed ring databases served to pacman.");
  s += dbox({ x: 20, y: 50, w: 200, h: 86, title: "Upstream", big: true, lines: ["Arch · Arch ARM · OPR", { text: "synced …", cls: "live", live: "last-sync" }] });
  s += darrow(220, 93, 300, 93) + dlab(260, 81, ["sync jobs"]);
  s += dbox({ x: 300, y: 30, w: 330, h: 150, title: "Brain", big: true, cls: "hi", lines: ["Cloudflare Worker · index in D1", "schedules sync · promote · health", "security · gc · builds", "signs databases and factory packages", { text: "API …", cls: "live", live: "api" }] });
  s += darrow(630, 93, 730, 93) + dlab(680, 81, ["index ↔ objects"]);
  s += dbox({ x: 730, y: 50, w: 185, h: 86, title: "Pool · R2", big: true, lines: ["each package stored once", { text: "…", cls: "live", live: "pool-size" }] });
  s += darrow(915, 93, 1025, 93) + dlab(970, 81, ["rendered, signed"]);
  s += dbox({ x: 1025, y: 50, w: 240, h: 86, title: "Rings", big: true, lines: ["pacman DBs, both arches", { text: "edge · rc · stable", cls: "live", live: "heads" }] });
  s += darrow(1145, 136, 1145, 170) + dlab(1145, 186, ["served to every pacman -Syu"]);
  s += darrow(465, 180, 465, 215);
  s += '<rect class="d-queue" x="300" y="215" width="700" height="30"/><text class="d-t small" x="314" y="234">job queue</text><text class="d-s live" x="400" y="234" data-live="queue">…</text>';
  for (const x of [410, 670, 930]) s += darrow(x, 300, x, 245, "", true) + dlab(x + 10, 276, ["claim · report"], "start");
  s += dbox({ x: 300, y: 300, w: 220, h: 70, title: "Pool workers", lines: ["the project's host · trusted", { text: "…", cls: "live", live: "w-pool" }] });
  s += dbox({ x: 560, y: 300, w: 220, h: 70, title: "Review worker", lines: ["rebuilds + audits · agent key", { text: "…", cls: "live", live: "w-review" }] });
  s += dbox({ x: 820, y: 300, w: 220, h: 70, title: "Community workers", lines: ["owned by contributors", { text: "…", cls: "live", live: "w-community" }] });
  s += dbox({ x: 20, y: 300, w: 200, h: 70, title: "GitHub", lines: ["OAuth · MAINTAINERS.toml", "releases · worker image"] });
  s += dline([220, 320, 260, 320, 260, 150], "dash") + darrow(260, 150, 300, 150, "dash") + dlab(266, 270, ["who may approve"], "start");
  return s + "</svg>";
}
