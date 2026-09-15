/**
 * Shared page frame of the dashboard: styles (omarchy.org's Tokyo Night look),
 * the header with navigation, live status and running version, the footer,
 * and the small helpers every page script uses. No build step: each page is a
 * string with a <script> that reads /api/v1/stats.
 */
import type { RunningVersion } from "../meta";

export const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const CSS = String.raw`
  :root {
    --bg: #1a1b26; --bg-deep: #0e0e14; --panel: #1f2230; --panel-2: #13141c; --line: #2a2e3f;
    --text: #c0caf5; --muted: #a9b1d6; --dim: #8b93b8; --green: #9ece6a; --green-ink: #0c0e10;
    --amber: #e0af68; --red: #f7768e; --blue: #7aa2f7;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; } /* a class with its own display (.gate is a grid) must not undo hidden — the Factory's sign-in gate stayed visible after signing in */
  html { color-scheme: dark; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--text); }
  h1, h2, h3 { font-family: Geist, "JetBrains Mono", sans-serif; letter-spacing: -0.02em; margin: 0; }
  h1 { font-size: 30px; font-weight: 600; }
  h2 { font-size: 22px; font-weight: 600; }
  h3 { font-size: 16px; font-weight: 600; }
  code, .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
  .num { font-variant-numeric: tabular-nums; }

  header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 24px; padding: 14px 32px; border-bottom: 1px solid var(--line); background: var(--bg-deep); }
  header .hmid { display: flex; align-items: center; gap: 34px; justify-self: center; }
  header .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; color: var(--text); text-decoration: none; }
  header .brand .mark { width: 22px; height: 22px; background: var(--green); display: grid; place-items: center; color: var(--green-ink); font-size: 12px; font-weight: 700; }
  header nav { display: flex; gap: 22px; font-size: 14px; }
  header nav a { color: var(--muted); text-decoration: none; padding-bottom: 2px; border-bottom: 1px solid transparent; }
  header nav a:hover { color: var(--text); }
  header nav a.active { color: var(--text); border-bottom-color: var(--green); }
  header .account { font-size: 13px; border: 1px solid var(--line); padding: 5px 11px; white-space: nowrap; display: inline-flex; align-items: center; max-width: min(46vw, 420px); justify-self: end; }
  header .account #account { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  /* A long GitHub login never wraps the header: the name is cut with an ellipsis (the full one is the link's title). */
  header .account b { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header #status { margin-left: 0; }
  header .account:hover { border-color: var(--green); }
  header .account a { color: var(--text); text-decoration: none; }
  header .account .who { color: var(--muted); }
  header .account #signout { color: var(--muted); margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line); }
  header .account #signout:hover { color: var(--text); }
  .gh { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); text-decoration: none; font-size: 13.5px; }
  .gh:hover { color: var(--text); }
  .gh svg { width: 18px; height: 18px; fill: currentColor; }
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); text-decoration: none; }
  .status .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); box-shadow: 0 0 0 0 rgba(158,206,106,0); }
  .status.online .led { background: var(--green); animation: pulse 2.4s ease-out infinite; }
  .status.online { color: var(--green); }
  .status.degraded .led { background: var(--amber); } .status.degraded { color: var(--amber); }
  .status.offline .led { background: var(--red); } .status.offline { color: var(--red); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(158,206,106,.55); } 70% { box-shadow: 0 0 0 7px rgba(158,206,106,0); } 100% { box-shadow: 0 0 0 0 rgba(158,206,106,0); } }
  .v.bump { animation: bump .5s ease-out; } @keyframes bump { 0% { color: var(--green); } 100% { color: inherit; } }
  .ring .desc { font-size: 13px; color: var(--muted); line-height: 1.5; }
  .ring .cta { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .ring .cta a { font-size: 13px; color: var(--green); text-decoration: none; }
  .ring .cta a:hover { text-decoration: underline; }
  .pill.rec { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .steps { display: grid; gap: 16px; max-width: 900px; }
  .step { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; }
  .step h3 { margin-bottom: 6px; }
  .step p { color: var(--muted); font-size: 14px; margin: 0 0 10px; }
  .choice { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
  .choice button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .choice button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .step pre { position: relative; padding-right: 76px; white-space: pre-wrap; word-break: break-all; }
  .copy { position: absolute; right: 8px; top: 8px; font-size: 12px; color: var(--dim); cursor: pointer; border: 1px solid var(--line); padding: 1px 8px; background: var(--panel); }
  .copy:hover { color: var(--text); }
  footer .sep { color: var(--line); }
  .searchbar { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
  .searchbar input { flex: 1 1 380px; font: inherit; font-size: 15px; padding: 9px 12px; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
  .searchbar input:focus { outline: none; border-color: var(--green); }
  .searchbar .choice { margin: 0; }
  .crumbs { color: var(--dim); font-size: 13px; margin: 0 0 6px; } .crumbs a { color: var(--muted); text-decoration: none; }
  .docs-bar { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 13.5px; margin: -8px 0 22px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .docs-bar a { color: var(--muted); text-decoration: none; padding: 2px 0; border-bottom: 1px solid transparent; }
  .docs-bar a:hover { color: var(--text); } .docs-bar a.on { color: var(--text); border-bottom-color: var(--green); }
  .docs-bar a:first-child { color: var(--dim); } .docs-bar a:first-child::after { content: " ›"; }
  .doc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; }
  .doc-cards a { display: block; border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; text-decoration: none; color: var(--text); }
  .doc-cards a:hover { border-color: var(--green); } .doc-cards h3 { margin: 0 0 6px; } .doc-cards p { color: var(--muted); font-size: 14px; margin: 0; }
  .shot { border: 1px solid var(--line); background: var(--panel-2); padding: 14px 16px; color: var(--dim); font-size: 13px; margin: 8px 0 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; color: var(--muted); margin: 10px 0 36px; }
  .meta .sep { color: var(--line); }
  ul.plain { list-style: none; margin: 0; padding: 0; font-size: 13.5px; line-height: 1.8; }
  ul.plain.cols { columns: 2; column-gap: 24px; } ul.plain li { break-inside: avoid; }
  ul.plain a { text-decoration: none; color: var(--text); border-bottom: 1px dotted var(--dim); } ul.plain a:hover { color: var(--green); }
  #graph svg { width: 100%; height: auto; display: block; } #graph a { cursor: pointer; } #graph a:hover rect { stroke-width: 2; }
  .choice-btn { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; vertical-align: middle; margin-left: 8px; }
  #files { max-height: 420px; overflow: auto; }
  footer .gh { font-size: 13px; }
  header .spacer { display: none; }
  .btn { background: var(--green); color: var(--green-ink); font-weight: 500; padding: 6px 14px; text-decoration: none; font-size: 14px; }
  .btn:hover { filter: brightness(1.08); }
  .ver { font-size: 12.5px; letter-spacing: .04em; color: var(--green); border: 1px solid var(--green); padding: 2px 8px; text-decoration: none; white-space: nowrap; }
  .ver:hover { background: var(--green); color: var(--green-ink); }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 64px; }
  .lede { color: var(--muted); margin: 8px 0 0; max-width: 78ch; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 28px 0 40px; }
  .tile { background: var(--panel); padding: 18px 20px; }
  .tile .k { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .tile .v { font-family: Geist, sans-serif; font-size: 30px; font-weight: 600; margin-top: 4px; }
  .tile .s { font-size: 13px; color: var(--muted); margin-top: 2px; }

  section { margin: 0 0 44px; }
  section > h2 { margin-bottom: 4px; }
  section > p.sub { color: var(--muted); margin: 0 0 16px; font-size: 14px; }

  .rings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; }
  .ring { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
  .ring .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .ring .name { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; }
  .ring .rel { color: var(--muted); font-size: 13px; }
  button.small { font-size: 12px; padding: 2px 8px; margin-left: 6px; }
  .pill { display: inline-block; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 8px; border: 1px solid var(--line); color: var(--muted); }
  .pill.ok { color: var(--green); border-color: var(--green); }
  .pill.warn { color: var(--amber); border-color: var(--amber); }
  .pill.error { color: var(--red); border-color: var(--red); }
  .pill.none { color: var(--dim); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13.5px; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; }
  .sources { display: flex; flex-wrap: wrap; gap: 6px; }
  .arch { border-top: 1px solid var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .archhead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .archname { font-family: "JetBrains Mono", monospace; font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  pre .c { color: var(--dim); }
  .howto { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 16px; }
  .howto .arch { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; }
  .src { border: 1px solid var(--line); padding: 2px 8px; font-size: 12.5px; background: var(--panel-2); }
  pre { margin: 0; background: var(--bg-deep); border: 1px solid var(--line); padding: 10px 12px; font-size: 12.5px; overflow-x: auto; color: var(--muted); }
  pre b { color: var(--green); font-weight: 500; }

  /* Loading: a thin bar at the top while any request is in flight, and
     skeleton rows/tiles so a page never looks frozen or jumps in from nothing. */
  #progress { position: fixed; top: 0; left: 0; height: 2px; width: 0; background: var(--green); z-index: 50; opacity: 0; transition: opacity .2s; }
  #progress.on { opacity: 1; animation: progress 1.6s ease-in-out infinite; }
  @keyframes progress { 0% { width: 0; margin-left: 0 } 50% { width: 60%; margin-left: 20% } 100% { width: 0; margin-left: 100% } }
  /* .skl is the shimmering bar; .skel marks a placeholder row or tile (removed when data lands). */
  .skl { display: inline-block; height: 12px; width: 70%; border-radius: 2px; background: linear-gradient(90deg, var(--line) 25%, var(--panel-2) 50%, var(--line) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; vertical-align: middle; }
  tr.skel td:nth-child(2n) .skl { width: 45%; } tr.skel td:nth-child(3n) .skl { width: 30%; }
  .tile.skel .v .skl { height: 26px; width: 55%; } .tile.skel .s .skl { width: 80%; }
  @keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
  .empty.loading { color: var(--dim); }
  .empty.loading::after { content: "…"; animation: dots 1.2s steps(4, end) infinite; }
  @keyframes dots { 0% { content: "" } 25% { content: "." } 50% { content: ".." } 75% { content: "..." } }

  .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px 18px; align-items: end; margin: 14px 0; }
  .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  .form label .choice label { flex-direction: row; text-transform: none; letter-spacing: 0; font-size: 13.5px; color: var(--text); align-items: center; gap: 6px; }
  .form .checklist { grid-column: 1 / -1; display: grid; gap: 7px; padding: 10px 12px; border: 1px solid var(--line); background: var(--bg-deep); }
  .form .checklist label { flex-direction: row; align-items: flex-start; gap: 9px; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--muted); line-height: 1.45; } .form .checklist input { margin-top: 3px; flex: none; }
  .form details.form-more { grid-column: 1 / -1; } .form details.form-more summary { cursor: pointer; font-size: 12.5px; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  .request-panel { max-width: 860px; } .request-panel .form { margin-top: 4px; } .request-panel .done { border: 1px solid var(--green); background: var(--panel-2); padding: 14px 16px; font-size: 13.5px; margin-top: 12px; } .request-panel .done b { color: var(--text); }
  .form details.form-more[open] { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px 18px; } .form details.form-more[open] summary { grid-column: 1 / -1; }
  .form input[type="text"], .form input[type="url"], .form select, .searchbar input[type="password"] { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 8px 10px; font: inherit; font-size: 13.5px; }
  .form button, .searchbar button, table button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 8px 14px; font: inherit; font-size: 13.5px; cursor: pointer; }
  .form button:hover, .searchbar button:hover, table button:hover { border-color: var(--green); }
  table button { padding: 3px 9px; font-size: 12.5px; }

  a.button { display: inline-block; border: 1px solid var(--green); padding: 8px 14px; text-decoration: none; color: var(--text); }
  a.button:hover { background: var(--panel-2); }
  .pager { display: flex; gap: 10px; align-items: center; margin: 10px 0 6px; font-size: 12.5px; color: var(--dim); flex-wrap: wrap; }
  .pager input { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 5px 9px; font: inherit; font-size: 12.5px; min-width: 200px; }
  .pager select { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 5px 6px; font: inherit; font-size: 12.5px; }
  .pager .count { margin-left: auto; }
  select.cat { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 2px 4px; font: inherit; font-size: 12px; margin-top: 3px; }

  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: middle; background: var(--dim); }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--amber); } .dot.error { background: var(--red); }
  .kind { display: inline-block; min-width: 68px; color: var(--blue); }
  .when { color: var(--dim); white-space: nowrap; }
  .muted { color: var(--muted); }
  footer { border-top: 1px solid var(--line); background: var(--bg-deep); padding: 22px 32px; font-size: 13px; color: var(--dim); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px 24px; }
  footer .more { justify-self: center; } footer .gh { justify-self: end; }
  footer a { color: var(--muted); text-decoration: none; }

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 16px; margin: 16px 0; }
  .chart { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; min-width: 0; }
  .chart h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .chart h3 span { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 400; color: var(--dim); }
  .chart .sub { font-size: 12.5px; color: var(--dim); margin: 2px 0 8px; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .chart .empty { color: var(--dim); font-size: 13px; padding: 24px 0; text-align: center; }
  .bar { display: inline-block; height: 8px; background: var(--panel-2); border: 1px solid var(--line); width: 140px; vertical-align: middle; position: relative; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .bar i.partial { background: var(--amber); }
  .pct { font-size: 12px; color: var(--muted); margin-left: 8px; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 6px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: middle; }
  a.run { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--dim); }
  a.run:hover { color: var(--text); }
  #graph { overflow-x: auto; } #graph svg { min-width: 720px; }
  @media (max-width: 720px) {
    header { grid-template-columns: 1fr auto; grid-template-areas: "brand account" "mid mid"; gap: 10px 12px; padding: 12px 16px; }
    header .brand { grid-area: brand; } header .account { grid-area: account; max-width: 60vw; }
    header .hmid { grid-area: mid; justify-self: stretch; gap: 16px; overflow-x: auto; white-space: nowrap; padding-bottom: 4px; margin: 0 -16px; padding-left: 16px; padding-right: 16px; scrollbar-width: none; }
    header .hmid::-webkit-scrollbar { display: none; }
    header nav { gap: 16px; }
    footer { grid-template-columns: 1fr; justify-items: start; }
    main { padding: 20px 16px 40px; }
    h1 { font-size: 22px; line-height: 1.25; } h2 { font-size: 19px; }
    .lede { font-size: 14px; }
    .tile .v { font-size: 24px; }
    .searchbar input { flex-basis: 100%; }
    .meta { margin-bottom: 24px; }
    ul.plain.cols { columns: 1; }
    .step pre { padding-right: 12px; padding-top: 34px; } .copy { top: 6px; }
    footer { padding: 18px 16px; gap: 10px 14px; }
    section { margin-bottom: 32px; }
  }
  /* ---- the three doors: heroes, diagrams, cards, live pieces (v2 of the dashboard) ---- */
  :root { --lilac: #bb9af7; --edge: var(--lilac); --rc: var(--blue); --stable: var(--green); }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  h1, h2, h3 { text-wrap: balance; }
  header .brand { white-space: nowrap; } header .account { flex: none; } header nav { gap: 18px; }
  header .account .avatar { width: 22px; height: 22px; font-size: 10.5px; margin-right: 8px; vertical-align: middle; }
  header nav a small { color: var(--dim); font-size: 11px; margin-left: 5px; letter-spacing: .06em; text-transform: uppercase; }
  footer .fleft { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; } footer .fnote { font-size: 12px; color: var(--dim); }
  footer .fbadge { display: inline-flex; align-items: center; } footer .fbadge svg { display: block; height: 20px; width: auto; } footer .fbadge:hover svg { filter: brightness(1.1); }
  footer .more { display: inline-flex; gap: 10px 14px; flex-wrap: wrap; } footer .more a.active { color: var(--green); }
  .hero { display: grid; gap: 14px; margin: 0 0 32px; max-width: 900px; }
  .hero h1 { font-size: 34px; line-height: 1.15; max-width: 22ch; }
  .hero.compact { margin-bottom: 22px; } .hero.compact h1 { font-size: 28px; }
  .eyebrow { margin: 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--green); }
  .hero .lede { margin: 0; max-width: 70ch; font-size: 15.5px; }
  .cta-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
  .btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); } .btn.ghost:hover { border-color: var(--green); filter: none; }
  .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--green); cursor: pointer; font: inherit; font-size: 14px; }
  .btn svg { width: 16px; height: 16px; fill: currentColor; }
  .hint { font-size: 13px; color: var(--dim); }
  .h2row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; } .h2row h2 { margin: 0; }
  .more-link { font-size: 13px; color: var(--green); text-decoration: none; } .more-link:hover { text-decoration: underline; }
  .sub a, .lede a { color: var(--green); text-decoration: none; } .sub a:hover, .lede a:hover { text-decoration: underline; }
  .tile .v.ok { color: var(--green); } .tile .v.warn { color: var(--amber); }
  .tiles.six { grid-template-columns: repeat(auto-fit, minmax(min(172px, 100%), 1fr)); }
  .tiles.five { grid-template-columns: repeat(auto-fit, minmax(min(188px, 100%), 1fr)); }
  .tiles.four { grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); margin: 16px 0; } .tiles.four .tile .v { font-size: 40px; line-height: 1.1; margin-top: 6px; }
  a.tile { color: inherit; text-decoration: none; display: block; } a.tile:hover { background: var(--panel-2); } a.tile:hover .v { color: var(--green); }
  .feed-box { border: 1px solid var(--line); background: var(--panel); padding: 16px 20px; }
  .pill.blue { color: var(--blue); border-color: var(--blue); } .pill.lilac { color: var(--lilac); border-color: var(--lilac); }
  .dot.blue { background: var(--blue); }
  .dim { color: var(--dim); }
  .searchbar input[type="search"], .searchbar input[type="text"] { -webkit-appearance: none; appearance: none; border-radius: 0; background: var(--bg-deep); font-size: 14px; padding: 10px 14px; }
  .searchbar input::placeholder { color: var(--dim); } .searchbar input::-webkit-search-decoration, .searchbar input::-webkit-search-cancel-button { -webkit-appearance: none; }
  .searchbar input:focus { box-shadow: 0 0 0 3px rgba(158,206,106,.14); }
  .pool-search { position: relative; flex: 1 1 440px; max-width: 640px; }
  .pool-search svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); width: 17px; height: 17px; fill: none; stroke: var(--dim); stroke-width: 2; stroke-linecap: round; pointer-events: none; }
  .searchbar .pool-search input[type="search"] { width: 100%; padding: 11px 14px 11px 42px; font-size: 15px; }
  .pool-search:focus-within svg { stroke: var(--green); }
  /* What the box answers as you type: a package a line, the full search last. */
  .suggest { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0, 0, 0, .45); text-align: left; }
  .suggest a { display: grid; grid-template-columns: minmax(120px, auto) auto auto minmax(0, 1fr); gap: 12px; align-items: center; padding: 9px 14px; color: var(--text); text-decoration: none; border-bottom: 1px solid var(--line); font-size: 13px; }
  .suggest a:last-child { border-bottom: 0; } .suggest a:hover, .suggest a:focus { background: var(--panel-2); outline: none; }
  .suggest a b { font-weight: 600; color: var(--green); } .suggest a .d { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .suggest a.all { display: block; color: var(--green); font-size: 12.5px; padding: 10px 14px; }
  .suggest .none { padding: 10px 14px; color: var(--dim); font-size: 12.5px; }

  figure.diagram { margin: 0; border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; overflow-x: auto; }
  figure.diagram svg { display: block; width: 100%; height: auto; min-width: 760px; font-family: "JetBrains Mono", ui-monospace, monospace; }
  figure.diagram.live-diagram svg { min-width: 820px; }
  figure.diagram figcaption { font-size: 12.5px; color: var(--dim); margin-top: 8px; }
  .d-box { fill: var(--panel-2); stroke: var(--line); stroke-width: 1.2; } .d-box.hi { stroke: var(--green); }
  .d-box.edge { stroke: var(--edge); } .d-box.rc { stroke: var(--rc); } .d-box.stable { stroke: var(--stable); }
  .d-box.dimmed { opacity: .45; } .d-l.dimmed { opacity: .35; }
  .d-t { fill: var(--text); font-size: 13px; font-weight: 600; font-family: Geist, "JetBrains Mono", sans-serif; } .d-t.small { font-size: 12.5px; }
  .d-t.edge { fill: var(--edge); } .d-t.rc { fill: var(--rc); } .d-t.stable { fill: var(--stable); }
  .d-s { fill: var(--dim); font-size: 11px; } .d-s.live { fill: var(--green); font-weight: 500; } .d-s.amber { fill: var(--amber); }
  .d-lab { fill: var(--muted); font-size: 11px; } .d-lab.hi { fill: var(--green); }
  .d-l { stroke: var(--dim); stroke-width: 1.2; fill: none; } .d-l.hi { stroke: var(--green); } .d-l.dash { stroke-dasharray: 4 4; } .d-l.warn { stroke: var(--amber); }
  .d-queue { fill: var(--bg-deep); stroke: var(--line); } .d-chip { fill: var(--panel-2); stroke: var(--line); }

  .rings .ring { border-top: 3px solid var(--line); gap: 10px; } .ring.stable { border-top-color: var(--stable); } .ring.rc { border-top-color: var(--rc); } .ring.edge { border-top-color: var(--edge); }
  .ring .health { display: flex; gap: 8px; flex-wrap: wrap; } .ring .lag { font-size: 12px; color: var(--dim); } .ring .desc b { color: var(--text); } .ring .head .rel { white-space: nowrap; font-size: 12px; } .ring .cta a { white-space: nowrap; }
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
  .feature { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 8px; align-content: start; }
  .feature .ic { width: 28px; height: 28px; color: var(--green); } .feature .ic svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .feature h3 { margin: 4px 0 0; } .feature p { margin: 0; font-size: 13.5px; color: var(--muted); }
  .feature a { color: var(--green); text-decoration: none; font-size: 13px; } .feature a:hover { text-decoration: underline; }
  .feature .proof { font-size: 12.5px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 8px; margin-top: 4px; } .feature .proof b { color: var(--text); font-weight: 500; }
  .ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 16px; }
  .way { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 8px; align-content: start; }
  .way .tag { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); display: flex; justify-content: space-between; } .way p { margin: 0; font-size: 13.5px; color: var(--muted); } .way .go { margin-top: 6px; }
  .start-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 16px; align-items: stretch; }
  .start-cmd h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .mini.five { grid-template-columns: repeat(5, 1fr); }
  .people-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12.5px; }
  .people-row .person { padding: 3px 8px 3px 3px; font-size: 12.5px; } .people-row .person .avatar { width: 22px; height: 22px; font-size: 10px; }
  .people-row a:not(.person) { margin-left: auto; }
  .cov { display: grid; gap: 7px; font-size: 12.5px; }
  .cov-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) 156px minmax(0, 1fr) 156px; gap: 10px; align-items: center; }
  .cov-row.head { margin-bottom: 2px; } .cov-row .k { margin: 0; }
  .cov-row .l { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cov-row .bar { height: 8px; width: auto; background: var(--panel-2); border: 1px solid var(--line); position: relative; display: block; } .cov-row .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); } .cov-row .bar i.partial { background: var(--amber); }
  .cov-row .p { text-align: right; color: var(--muted); white-space: nowrap; }
  .open-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; }
  .ring-heads { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 12px 0 10px; }
  .ring-head { background: var(--panel-2); padding: 8px 10px; display: grid; gap: 1px; text-decoration: none; color: inherit; min-width: 0; } .ring-head:hover { background: var(--panel); }
  .ring-head .k { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; } .ring-head b { font-family: Geist, sans-serif; font-size: 20px; font-weight: 600; line-height: 1.15; } .ring-head .s { font-size: 11.5px; color: var(--dim); line-height: 1.4; }
  .feed a.row { text-decoration: none; color: inherit; cursor: pointer; }
  tr.project-row td { background: var(--panel-2); } tr.project-row td:first-child { box-shadow: inset 3px 0 0 var(--green); } .feed a.row:hover .what { color: var(--text); }
  .charts.three { grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); }
  .charts.three .chart { display: flex; flex-direction: column; } .charts.three .chart > .mini { margin-top: auto; }
  .charts.three #c-sec { display: flex; flex-direction: column; flex: 1; } .charts.three #c-sec .hrows { flex: 1; align-content: space-evenly; } .charts.three #c-sec > p { margin-top: auto; }
  .coverage-box { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 10px 28px; margin: 16px 0; }
  .coverage-box .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
  .start-side { display: grid; gap: 16px; grid-template-rows: auto 1fr; }
  .cli-card, .community-card { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 10px; align-content: start; }
  .community-card { border-color: var(--green); }
  .cli-card h3, .community-card h3 { display: flex; justify-content: space-between; align-items: baseline; } .cli-card p, .community-card p { margin: 0; font-size: 13px; color: var(--muted); }
  .cli-card pre, .share pre, .doc-sec pre { position: relative; white-space: pre-wrap; word-break: normal; overflow-wrap: anywhere; } .cli-card pre, .share pre { padding-right: 76px; }
  .community-card .big { font-family: Geist, sans-serif; font-size: 40px; font-weight: 600; line-height: 1.05; color: var(--green); }
  .community-card .people { margin-top: 4px; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
  .tabs button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; } .tabs button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; font-size: 11.5px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .mini b { display: block; font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: 0; text-transform: none; line-height: 1.2; }
  .mini-list { margin-top: 12px; display: grid; gap: 5px; font-size: 12.5px; } .mini-list .k { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 2px; }
  .hrows { display: grid; gap: 7px; font-size: 12.5px; }
  .hrow { display: grid; grid-template-columns: 150px 1fr 52px; gap: 10px; align-items: center; }
  .hrow .l { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .hrow .l small { color: var(--dim); }
  .hrow .bar { height: 10px; width: auto; background: var(--panel-2); border: 1px solid var(--line); position: relative; display: block; } .hrow .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); } .hrow .bar i.partial { background: var(--amber); }
  .hrow .p { text-align: right; color: var(--muted); }
  .tip { position: fixed; pointer-events: none; background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); font-size: 12px; padding: 5px 9px; z-index: 30; white-space: nowrap; display: none; }
  .ax { fill: var(--dim); font-size: 10.5px; } .grid { stroke: var(--line); stroke-width: 1; } .mark { cursor: default; } .mark:hover { opacity: .8; }
  .heat { display: grid; gap: 3px; font-size: 11px; } .heat .r { display: grid; grid-template-columns: 110px repeat(14, 1fr); gap: 3px; align-items: center; }
  .heat .r .l { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .heat .c { aspect-ratio: 1; background: var(--line); min-width: 0; }
  .heat .c.ok { background: var(--green); opacity: .75; } .heat .c.warn { background: var(--amber); } .heat .c.error { background: var(--red); } .heat .c:hover { outline: 1px solid var(--text); }
  .heat .days { display: grid; grid-template-columns: 110px repeat(14, 1fr); gap: 3px; color: var(--dim); font-size: 10px; } .heat .days span { text-align: center; }

  .avatar { display: inline-grid; place-items: center; width: 28px; height: 28px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); font-size: 12px; font-weight: 600; font-family: Geist, sans-serif; flex: none; text-decoration: none; }
  .avatar.lg { width: 64px; height: 64px; font-size: 24px; border-color: var(--green); } .avatar.m { background: var(--green); color: var(--green-ink); border-color: var(--green); }
  .people { display: flex; flex-wrap: wrap; gap: 10px; }
  .person { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--panel); padding: 5px 10px 5px 5px; text-decoration: none; color: var(--text); font-size: 13px; max-width: 100%; } .person:hover { border-color: var(--green); } .person > b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .person .r { color: var(--dim); font-size: 11.5px; }
  .landed { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
  .land { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: center; }
  .land .avatar { grid-row: span 2; } .land .n { font-weight: 500; display: flex; justify-content: space-between; gap: 8px; align-items: baseline; } .land .n .v { color: var(--dim); font-size: 12px; }
  .land .b { font-size: 12.5px; color: var(--dim); } .land .b a { color: var(--muted); text-decoration: none; }
  .community { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; align-items: start; }
  .community .box { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; display: grid; gap: 12px; align-content: start; } .community .box p { margin: 0; font-size: 13.5px; color: var(--muted); }
  .community .stats { display: flex; gap: 22px; flex-wrap: wrap; } .community .stats a { color: inherit; text-decoration: none; } .community .stats a:hover b { color: var(--green); } .community .stats > * b { display: block; font-family: Geist, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.1; } .community .stats > * span { font-size: 12px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .sponsor { border: 1px solid var(--green); background: var(--panel); padding: 18px 20px; display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; align-items: center; margin-top: 16px; }
  .sponsor p { margin: 0; font-size: 13.5px; color: var(--muted); max-width: 72ch; } .sponsor p b { color: var(--text); }
  .sponsor .needs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .sponsor .mail { font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; color: var(--green); text-decoration: none; white-space: nowrap; } .sponsor .mail:hover { text-decoration: underline; }
  .sponsor .side { display: grid; gap: 8px; justify-items: end; } .sponsor .promise { font-size: 12px; color: var(--dim); text-align: right; max-width: 30ch; }
  .sponsor.compact { padding: 14px 18px; }

  .gate { border: 1px dashed var(--line); background: var(--panel); padding: 24px; display: grid; grid-template-columns: 1fr auto; gap: 18px 28px; align-items: center; }
  .gate h3 { margin-bottom: 6px; } .gate p { margin: 0; color: var(--muted); font-size: 13.5px; max-width: 70ch; }
  .gate ul { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted); display: flex; gap: 6px 18px; flex-wrap: wrap; } .gate ul li::before { content: "▸ "; color: var(--green); }
  .gate .lock, .private-head .lock { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .private-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 28px; margin-bottom: 18px; }
  .private-head .lock { border: 1px solid var(--line); padding: 2px 8px; } .private-head h2 { margin: 0; } .private-head .right { margin-left: auto; display: flex; gap: 12px; align-items: center; }
  .two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
  .panel { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; min-width: 0; }
  .panel h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .panel h3 a, .panel h3 button { font-family: "JetBrains Mono", monospace; font-size: 12.5px; font-weight: 400; color: var(--green); text-decoration: none; background: none; border: 0; cursor: pointer; padding: 0; } .panel h3 a:hover, .panel h3 button:hover { text-decoration: underline; }
  .panel table { font-size: 13px; } .panel th, .panel td { padding: 6px 8px; }
  .wcards { display: grid; gap: 10px; }
  .wcard { border: 1px solid var(--line); background: var(--panel-2); padding: 10px 12px; display: grid; grid-template-columns: auto 1fr auto; gap: 2px 12px; align-items: center; font-size: 13px; }
  .wcard .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); grid-row: span 2; } .wcard .led.on { background: var(--green); } .wcard .led.busy { background: var(--blue); }
  .wcard b { font-weight: 500; } .wcard .m { font-size: 12px; color: var(--dim); grid-column: 2; } .wcard .pill { grid-row: span 2; }
  .small-btn { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); padding: 3px 9px; font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: none; } .small-btn:hover { border-color: var(--green); }

  .state-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 24px; }
  .ticker { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; display: grid; gap: 6px; font-size: 13px; min-height: 230px; align-content: start; }
  .ticker .row { display: grid; grid-template-columns: 78px 92px 1fr auto; gap: 12px; align-items: baseline; animation: tick .5s ease-out; }
  .ticker .row .what { color: var(--blue); } .ticker .row .where { color: var(--dim); } .ticker .row .when { color: var(--dim); font-size: 12px; white-space: nowrap; }
  .ticker .head { display: flex; justify-content: space-between; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 4px; }
  .live { color: var(--green); display: inline-flex; align-items: center; gap: 6px; } .live i { width: 7px; height: 7px; border-radius: 50%; background: var(--green); animation: pulse 2.4s ease-out infinite; }
  @keyframes tick { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  /* The Pool's feed: one line per event, the newest on top, cut at the box's edge (the full text on hover and on click). */
  .feed { display: grid; gap: 0; font-size: 12.5px; }
  .feed .row { display: grid; grid-template-columns: 44px 76px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--line); cursor: default; }
  .feed .row:last-child { border-bottom: 0; } .feed .row.new { animation: tick .6s ease-out; }
  .feed .when { color: var(--dim); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .feed .kind { min-width: 0; font-size: 12px; } .feed .kind .dot { margin-right: 6px; }
  .feed .what { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .feed .row.open .what { white-space: normal; overflow-wrap: anywhere; }
  .feed-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; } .feed-head b { color: var(--text); } .feed-head .live { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; flex: none; }
  .live-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; }
  .counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .counters div { background: var(--panel); padding: 12px 14px; } .counters b { display: block; font-family: Geist, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.1; } .counters span { font-size: 11.5px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; } .counters b.ok { color: var(--green); }
  .flow { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding-bottom: 4px; }
  .flow .st { border: 1px solid var(--line); background: var(--panel); padding: 12px 16px; min-width: 150px; display: grid; gap: 2px; align-content: start; }
  .flow .st b { font-family: Geist, sans-serif; font-size: 26px; font-weight: 600; line-height: 1.1; } .flow .st .k { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); } .flow .st .s { font-size: 12px; color: var(--muted); }
  .flow .st.hum { border-color: var(--amber); } .flow .st.hum .k { color: var(--amber); } .flow .st.you { border-color: var(--green); } .flow .ar { display: grid; place-items: center; color: var(--dim); padding: 0 8px; font-size: 18px; }
  .roles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
  .role { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; gap: 8px; align-content: start; border-top: 3px solid var(--line); }
  .role.pool { border-top-color: var(--green); } .role.review { border-top-color: var(--blue); } .role.shared { border-top-color: var(--lilac); } .role.own { border-top-color: var(--dim); }
  .role h3 { display: flex; justify-content: space-between; align-items: baseline; } .role h3 span { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 400; color: var(--dim); } .role p { margin: 0; font-size: 12.5px; color: var(--muted); }
  .role .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 12.5px; } .role .kv dt { color: var(--dim); } .role .kv dd { margin: 0; text-align: right; }
  .maint-list { display: grid; gap: 8px; } .maint-list .m { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
  .maint-list .m .bar { height: 8px; width: auto; display: block; background: var(--panel-2); border: 1px solid var(--line); position: relative; } .maint-list .m .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .queue-pos { border: 1px solid var(--green); background: var(--panel-2); padding: 12px 14px; font-size: 13px; display: grid; gap: 4px; } .queue-pos b { font-family: Geist, sans-serif; font-size: 20px; }
  .budget { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: center; }
  .budget .bar { grid-column: 1 / -1; height: 12px; width: auto; display: block; background: var(--panel-2); border: 1px solid var(--line); position: relative; } .budget .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--green); }
  .budget .bar em { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--amber); } .budget .bar em::after { content: "guard"; position: absolute; top: -16px; left: -14px; font-size: 10px; color: var(--amber); font-style: normal; }
  .budget b { font-family: Geist, sans-serif; font-size: 22px; font-weight: 600; } .budget .k { font-size: 12px; color: var(--dim); }
  .heads { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 12px; }
  .headc { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; display: grid; gap: 4px; font-size: 13px; border-left: 3px solid var(--line); }
  .headc.stable { border-left-color: var(--stable); } .headc.rc { border-left-color: var(--rc); } .headc.edge { border-left-color: var(--edge); }
  .headc .n { display: flex; justify-content: space-between; align-items: baseline; } .headc .n b { font-family: Geist, sans-serif; font-size: 17px; } .headc .m { color: var(--dim); font-size: 12px; } .headc .acts { display: flex; gap: 6px; margin-top: 4px; }
  .svc { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0 0 36px; }
  .svc div { background: var(--panel); padding: 12px 14px; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; font-size: 13px; }
  .svc .led { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); grid-row: span 2; } .svc .led.ok { background: var(--green); animation: pulse 2.4s ease-out infinite; } .svc .led.warn { background: var(--amber); } .svc .led.error { background: var(--red); }
  .svc span { grid-column: 2; color: var(--dim); font-size: 12px; }
  .feeds { display: grid; gap: 8px; margin-top: 8px; } .feed { display: grid; grid-template-columns: 1fr; gap: 1px; font-size: 12.5px; border-bottom: 1px solid var(--line); padding-bottom: 6px; } .feed span { color: var(--muted); } .feed:last-child { border-bottom: 0; }

  .profile-head { display: grid; grid-template-columns: auto 1fr auto; gap: 18px 22px; align-items: center; margin-bottom: 24px; }
  .profile-head h1 { font-size: 30px; max-width: none; } .profile-head .line { color: var(--muted); font-size: 13.5px; margin: 4px 0 0; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .share { border: 1px solid var(--green); background: var(--panel); padding: 18px 20px; display: grid; grid-template-columns: 1fr; gap: 12px; }
  .share p { margin: 0; font-size: 13.5px; color: var(--muted); } .share pre { position: relative; padding-right: 76px; white-space: pre-wrap; word-break: break-all; } .share .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .score { display: grid; grid-template-columns: auto 1fr; gap: 4px 18px; align-items: center; } .score b { font-family: Geist, sans-serif; font-size: 44px; font-weight: 600; color: var(--green); line-height: 1; } .score .f { font-size: 12.5px; color: var(--dim); } .score .f code { color: var(--muted); }
  .activity { display: flex; align-items: flex-end; gap: 3px; height: 54px; } .activity i { flex: 1; background: var(--green); opacity: .75; min-height: 2px; } .activity i:hover { opacity: 1; }
  .who { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; }
  .whoc { border: 1px solid var(--line); background: var(--panel); padding: 16px 18px; display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center; text-decoration: none; color: var(--text); }
  a.whoc:hover { border-color: var(--green); } .whoc .k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); } .whoc b { display: block; font-family: Geist, sans-serif; font-size: 18px; font-weight: 600; } .whoc span { font-size: 12.5px; color: var(--muted); }
  .whoc.wait { border-color: var(--amber); border-style: dashed; }
  .whorow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin: -4px 0 12px; } .whorow .avatar { width: 24px; height: 24px; font-size: 10.5px; }
  .pkname { font-weight: 600; color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--dim); } .pkname:hover { color: var(--green); border-bottom-color: var(--green); } .pkname .go { color: var(--green); font-weight: 400; }
  .by { display: inline-flex; gap: 4px; } .by .avatar { width: 24px; height: 24px; font-size: 10.5px; }
  .pk-grid { grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); align-items: start; margin-top: 4px; }
  /* The results: the page's search box is the search, so the table's own filter stays hidden; its size and count remain. A description is two lines at most; who made it stays on one. */
  .pk-results .pager { margin: 0 0 6px; } .pk-results .pager input { display: none; }
  .pk-results td:nth-child(4) { white-space: nowrap; } .pk-results .clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .pk-grid + .tiles { margin-top: 28px; }
  #results tr.sel td { background: var(--panel-2); }

  .docs { display: grid; grid-template-columns: 230px 1fr; gap: 24px; align-items: start; }
  .docs-side { position: sticky; top: 16px; display: grid; gap: 10px; }
  .docs-side input { background: var(--bg-deep); border: 1px solid var(--line); color: var(--text); padding: 8px 10px; font: inherit; font-size: 13.5px; width: 100%; } .docs-side input:focus { outline: none; border-color: var(--green); }
  .docs-nav { display: grid; gap: 2px; } .docs-nav button { text-align: left; background: transparent; border: 0; border-left: 2px solid transparent; color: var(--muted); padding: 6px 10px; font: inherit; font-size: 13.5px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
  .docs-nav button:hover { color: var(--text); } .docs-nav button.on { color: var(--text); border-left-color: var(--green); background: var(--panel); } .docs-nav button small { color: var(--dim); font-size: 11px; }
  .docs-hint { font-size: 12px; color: var(--dim); padding: 0 10px; } .docs-main { min-width: 0; }
  .docs-main h2 { margin-bottom: 4px; } .docs-main h3 { margin: 22px 0 8px; } .docs-main p { color: var(--muted); font-size: 14px; max-width: 78ch; margin: 0 0 10px; } .docs-main p code, .docs-main li code { color: var(--text); }
  .docs-main ul { margin: 0 0 12px; padding-left: 18px; color: var(--muted); font-size: 13.5px; }
  .doc-sec { border: 1px solid var(--line); background: var(--panel); padding: 18px 20px; margin-bottom: 16px; } .doc-sec h3:first-child { margin-top: 0; }
  .hits { display: grid; gap: 8px; } .hit { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; cursor: pointer; } .hit:hover { border-color: var(--green); }
  .hit .ch { font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--green); } .hit b { display: block; margin: 2px 0; } .hit span { font-size: 13px; color: var(--muted); }
  mark { background: rgba(224,175,104,.35); color: var(--text); padding: 0 2px; }
  .stepper { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 0 0 12px; }
  .stepper button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 8px 10px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; display: grid; gap: 2px; } .stepper button small { color: var(--dim); font-size: 11px; }
  .stepper button.on { border-color: var(--green); color: var(--text); } .stepper button.on small { color: var(--green); }
  .quiz { display: grid; gap: 10px; } .quiz .q { display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 13.5px; color: var(--muted); flex-wrap: wrap; }
  .quiz .q .yn { display: flex; gap: 4px; } .quiz .q .yn button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; } .quiz .q .yn button.on { color: var(--green-ink); background: var(--green); border-color: var(--green); }
  .verdict { border: 1px solid var(--green); background: var(--panel-2); padding: 12px 14px; font-size: 13.5px; } .verdict b { font-family: Geist, sans-serif; font-size: 20px; }
  .cando { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .cando ul { list-style: none; padding: 0; margin: 0; font-size: 13.5px; } .cando li { padding: 4px 0; border-bottom: 1px solid var(--line); }
  .cando .yes li::before { content: "✓ "; color: var(--green); } .cando .no li::before { content: "✕ "; color: var(--red); } .cando h4 { margin: 0 0 6px; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .ep { border: 1px solid var(--line); background: var(--panel-2); margin-bottom: 6px; } .ep summary { list-style: none; cursor: pointer; padding: 8px 12px; display: grid; grid-template-columns: 62px 1fr auto; gap: 12px; align-items: center; font-size: 13px; } .ep summary::-webkit-details-marker { display: none; }
  .ep .m { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; } .ep .m.get { color: var(--green); } .ep .m.post { color: var(--blue); } .ep .m.del, .ep .m.put { color: var(--amber); } .ep .who { font-size: 11px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
  .ep .body { padding: 0 12px 12px; display: grid; gap: 8px; } .ep .body p { margin: 0; font-size: 13px; } .ep[open] summary { border-bottom: 1px solid var(--line); }
  .gloss { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; } .gloss button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; } .gloss button.on { border-color: var(--green); color: var(--text); }
  .srcs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 8px; margin-bottom: 12px; } .srcs button { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); padding: 10px 12px; font: inherit; font-size: 13px; cursor: pointer; text-align: left; } .srcs button.on { border-color: var(--green); color: var(--text); }
  .timeline { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; } .timeline div { border: 1px solid var(--line); background: var(--panel-2); padding: 12px 14px; font-size: 13px; color: var(--muted); } .timeline b { display: block; color: var(--text); margin-bottom: 4px; }
  @media (max-width: 900px) {
    .community, .two, .profile-head, .live-grid, .docs, .cando, .start-grid, .pk-grid, .open-grid { grid-template-columns: 1fr; }
    .docs-side { position: static; } .stepper { grid-template-columns: repeat(2, 1fr); } .timeline { grid-template-columns: 1fr; }
    .gate, .sponsor { grid-template-columns: 1fr; } .sponsor .side { justify-items: start; } .sponsor .promise { text-align: left; }
    .heat .r, .heat .days { grid-template-columns: 80px repeat(14, 1fr); }
  }
  .live-grid > * { min-width: 0; } .ticker .row > span { min-width: 0; overflow-wrap: anywhere; }
  #seal .mono, .meta .mono, .kv dd .mono, .whorow, .whoc span { overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .hero h1 { font-size: 24px; } .hrow { grid-template-columns: 110px 1fr 46px; }
    .ticker .row { grid-template-columns: 1fr; gap: 1px; padding-bottom: 6px; border-bottom: 1px solid var(--line); } .ticker .row .when { font-size: 11px; }
    .flow .st { min-width: 130px; } .roles-grid { grid-template-columns: 1fr; }
  }
`;

/** Helpers shared by every page script; runs before the page's own script. */
const HELPERS = String.raw`
  var POOL = "__POOL_URL__";
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bytes(n) { n = Number(n || 0); var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + " " + u[i]; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function ago(iso) { if (!iso) return "—"; var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
  function dur(ms) { if (ms == null) return ""; if (ms < 1000) return ms + " ms"; if (ms < 60000) return (ms / 1000).toFixed(1) + " s"; return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; }
  function latest(list, kind, ring, source) {
    for (var i = 0; i < list.length; i++) { var e = list[i]; if (e.kind === kind && (ring == null || e.ring === ring) && (source == null || e.source === source)) return e; }
    if (source === "x86_64") for (var j = 0; j < list.length; j++) { var f = list[j]; if (f.kind === kind && (ring == null || f.ring === ring) && !f.source) return f; }
    return null;
  }
  // Header pill = the service: online when the API answers and it can reach
  // the index and the pool right now (/api/v1/status measures both), degraded
  // when one of them fails, offline when the API itself does not answer.
  // Whether the pipeline is keeping up is a different question (problemsOf).
  function setStatus(state, title) { var el = $("#status"); if (!el) return; el.className = "status " + state; el.querySelector("span").textContent = state; el.title = title || ""; }
  function serviceStatus() {
    fetch("/api/v1/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var why = [];
      if (!s.index.ok) why.push("index: " + (s.index.error || "failed"));
      if (!s.pool.ok) why.push("pool: " + (s.pool.error || "failed"));
      setStatus(s.ok ? "online" : "degraded", s.ok ? "API, index (" + s.index.ms + " ms) and pool (" + s.pool.ms + " ms) answering" : why.join(" · "));
    }).catch(function (e) { setStatus("offline", "API not answering: " + e); });
  }
  // What is wrong, if anything: no sync for four hours (they run every three), a source not synced
  // for six (a long import holds the pipeline's queue, so small sources wait),
  // or a ring whose latest health check failed. The header pill and the
  // status page use the same list.
  function problemsOf(d) {
    var sync = latest(d.events || [], "sync"), why = [];
    if (!sync || Date.now() - Date.parse(sync.created_at) > 4 * 3600e3) why.push("no sync for " + (sync ? ago(sync.created_at).replace(" ago", "") : "ever"));
    var late = (d.coverage || []).filter(function (c) { return c.last_sync && Date.now() - Date.parse(c.last_sync) > 9 * 3600e3; });
    if (late.length) why.push(late.length + " source(s) not synced for 9 h");
    (d.latest || []).forEach(function (e) { if (e.kind === "health" && e.status === "error") why.push(e.ring + " " + (e.source || "x86_64") + " failed its health check"); });
    return why;
  }
  // Pipeline pill (where a page has one): keeping up, or what is behind.
  function pipelineFrom(d) {
    var el = $("#pipeline-state"); if (!el) return;
    var why = problemsOf(d);
    el.className = "pill " + (why.length ? "warn" : "ok");
    el.textContent = why.length ? "pipeline behind: " + why.join(" · ") : "pipeline keeping up";
  }
  // Every table: the first 10 rows, a page size (10/25/50/100) and a filter,
  // so a page never renders hundreds of rows at once. State survives the
  // periodic refreshes. text(row) is what the filter matches; empty is the
  // message for no rows.
  function pager(sel, rows, render, opts) {
    opts = opts || {}; var table = document.querySelector(sel); if (!table) return;
    pager.state = pager.state || {}; var st = pager.state[sel] = pager.state[sel] || { n: opts.n || 10, q: "" };
    var wrap = table.parentElement, bar = wrap.previousElementSibling;
    if (!bar || !bar.classList.contains("pager")) {
      bar = document.createElement("div"); bar.className = "pager";
      bar.innerHTML = '<input type="search" placeholder="filter this table…" aria-label="filter"> <select aria-label="rows per page"><option>10</option><option>25</option><option>50</option><option>100</option></select> <span class="count"></span>';
      wrap.parentElement.insertBefore(bar, wrap);
      bar.querySelector("input").oninput = function () { st.q = this.value.toLowerCase(); draw(); };
      bar.querySelector("select").onchange = function () { st.n = Number(this.value); draw(); };
      bar.querySelector("select").value = String(st.n);
    }
    function text(r) { return (opts.text ? opts.text(r) : JSON.stringify(r)).toLowerCase(); }
    function draw() {
      var f = st.q ? rows.filter(function (r) { return text(r).indexOf(st.q) >= 0; }) : rows;
      table.tBodies[0].innerHTML = f.slice(0, st.n).map(render).join("") || '<tr><td colspan="99" class="muted">' + (opts.empty || "nothing here") + '</td></tr>';
      bar.querySelector(".count").textContent = f.length > st.n ? "showing " + st.n + " of " + f.length : f.length + (f.length === 1 ? " row" : " rows");
      if (opts.after) opts.after();
    }
    draw();
  }
  // The agent a worker reports ("<provider>/<model>"), or a dash: the key never leaves the worker, only its name does.
  function agentCell(w) {
    if (!w.agent) return '<span class="muted">—</span>';
    var i = w.agent.indexOf("/");
    return '<span class="mono" title="' + esc(w.agent) + '">' + esc(i > 0 ? w.agent.slice(i + 1) : w.agent) + '</span>' + (i > 0 ? ' <span class="muted">' + esc(w.agent.slice(0, i)) + '</span>' : '');
  }
  // Who is signed in (the omc cookie): the header shows the login and role.
  var ME = null;
  function whoami(cb) {
    fetch("/auth/me", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
      ME = me; var a = $("#account"); if (!a) return;
      if (me) {
        a.innerHTML = '<span class="avatar' + (me.role === "maintainer" ? " m" : "") + '">' + esc(String(me.login).slice(0, 2)) + '</span><b>' + esc(me.login) + '</b>'; a.href = "/user/" + encodeURIComponent(me.login); a.title = esc(me.login) + " · " + esc(me.role) + " — signed in with GitHub as " + me.login + (me.areas && me.areas.length ? " (" + me.areas.join(", ") + ")" : "");
        // Sign out is on every page: the cookie is cleared by /auth/logout,
        // the older local-storage token (a CLI token pasted into the page) with it.
        var out = $("#signout"); if (out) { out.hidden = false; out.onclick = function () { try { localStorage.removeItem("omc_token"); localStorage.removeItem("omc_login"); } catch (e) {} location.href = "/auth/logout"; return false; }; }
      }
      if (cb) cb(me);
    }).catch(function () { if (cb) cb(null); });
  }
  whoami();
  // SMIL animations (the diagrams) stop when the viewer asked for less motion.
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) document.querySelectorAll("svg").forEach(function (s) { if (s.pauseAnimations) s.pauseAnimations(); });
  // Charts and bars carry their value in data-tip; one fixed box follows the pointer.
  (function () {
    var tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip);
    document.addEventListener("mousemove", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!t) { tip.style.display = "none"; return; }
      tip.textContent = t.getAttribute("data-tip"); tip.style.display = "block";
      var x = e.clientX + 14, y = e.clientY + 14; if (x + tip.offsetWidth > innerWidth - 8) x = e.clientX - tip.offsetWidth - 10;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
  })();
  // A person, as an icon: two letters, green for a maintainer. No photos anywhere on the dashboard.
  function avatar(login, role, cls) { return '<a class="avatar ' + (cls || "") + (role === "maintainer" ? " m" : "") + '" href="/user/' + encodeURIComponent(login) + '" title="' + esc(login) + (role ? " · " + esc(role) : "") + '">' + esc(String(login).slice(0, 2)) + '</a>'; }
  // The same icon with no link of its own — for inside a link (a chip), where a nested anchor would split.
  function avatarIcon(login, role) { return '<span class="avatar' + (role === "maintainer" ? " m" : "") + '">' + esc(String(login).slice(0, 2)) + '</span>'; }
  // A person as a chip: the icon carries the role (green = maintainer), the whole chip is the link to the profile.
  // A worker's id is "<owner>-<name>-<arch>-<4 random>" (POST /factory/workers): the tables
  // show the name — the owner and the architecture have columns of their own — and keep the id on hover.
  function workerName(w) {
    var id = String(w.id || ""), s = id;
    if (w.owner && s.indexOf(w.owner + "-") === 0) s = s.slice(w.owner.length + 1);
    s = s.replace(/-[a-z0-9]{4}$/, "");
    if (w.arch && s.endsWith("-" + w.arch)) s = s.slice(0, -(w.arch.length + 1));
    return '<span class="mono" title="' + esc(id) + '">' + esc(s || id) + '</span>';
  }
  function personChip(login, role, extra) { return '<a class="person" href="/user/' + encodeURIComponent(login) + '" title="' + esc(login) + ' · ' + esc(role) + '">' + avatarIcon(login, role) + '<b>' + esc(login) + '</b>' + (extra ? ' <span class="r">' + extra + '</span>' : '') + '</a>'; }
  function tile(k, v, s, cls) { return '<div class="tile"><div class="k">' + k + '</div><div class="v num' + (cls ? " " + cls : "") + '">' + v + '</div><div class="s">' + s + '</div></div>'; }
  // A tile with a fifth element is a link: the number, and the page that proves it.
  function setTiles(sel, list) { var el = $(sel); if (!el) return; list.forEach(function (t, i) { var cell = el.children[i], tag = t[4] ? "A" : "DIV"; if (!cell || cell.tagName !== tag) { var made = document.createElement(tag); made.className = "tile"; if (cell) { made.innerHTML = cell.innerHTML; el.replaceChild(made, cell); } else el.appendChild(made); cell = made; } if (t[4]) cell.href = t[4]; setTile(cell, '<div class="k">' + t[0] + '</div><div class="v num' + (t[3] ? " " + t[3] : "") + '">' + t[1] + '</div><div class="s">' + t[2] + '</div>'); }); while (el.children.length > list.length) el.removeChild(el.lastChild); }
  // Every fetch a page starts goes through busy(): the bar at the top stays
  // on while at least one is in flight.
  function busy(p) {
    var el = $("#progress"); busy.n = (busy.n || 0) + 1; if (el) el.classList.add("on");
    return p.finally(function () { busy.n = Math.max(0, (busy.n || 1) - 1); if (!busy.n && el) el.classList.remove("on"); });
  }
  // Placeholders until the first data arrives: rows for a table, cells for
  // tiles. A render replaces a placeholder's content and drops the mark;
  // endSkeleton() removes whatever placeholders are left over.
  function skeletonRows(tableSel, cols, rows) {
    var tb = document.querySelector(tableSel + " tbody"); if (!tb || tb.children.length) return;
    var row = '<tr class="skel">' + new Array(cols + 1).join('<td><span class="skl"></span></td>') + '</tr>';
    tb.innerHTML = new Array((rows || 4) + 1).join(row);
  }
  function skeletonTiles(sel, n) {
    var el = $(sel); if (!el || el.children.length) return;
    el.innerHTML = new Array((n || 4) + 1).join('<div class="tile skel"><div class="k"><span class="skl"></span></div><div class="v"><span class="skl"></span></div><div class="s"><span class="skl"></span></div></div>');
  }
  function skeletonText(sel) { var el = $(sel); if (el && !el.textContent.trim()) { el.classList.add("empty", "loading"); el.textContent = "Loading"; } }
  function endSkeleton() { document.querySelectorAll(".skel").forEach(function (el) { el.remove(); }); document.querySelectorAll(".empty.loading").forEach(function (el) { el.classList.remove("empty", "loading"); if (el.textContent === "Loading") el.textContent = ""; }); }
  // Numbers that change between refreshes flash briefly, so the page reads as live.
  function setTile(el, html) { el.classList.remove("skel"); if (el.innerHTML !== html) { el.innerHTML = html; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); } }
  function liveStats(render, everyMs) {
    function load() {
      serviceStatus();
      busy(fetch("/api/v1/stats")).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { pipelineFrom(d); render(d); endSkeleton(); })
        .catch(function () {});
    }
    load();
    setInterval(load, everyMs || 20000);
  }
`;

export interface PageOptions {
  title: string;
  description: string;
  /** Which of the three doors (or the docs) is highlighted; detail pages highlight none. */
  active: "pool" | "factory" | "pipeline" | "docs" | "none";
  /** Documentation pages: which chapter, for the section's own navigation. */
  doc?: DocKey;
  body: string;
  script?: string;
  poolUrl: string;
  version: RunningVersion;
}

/** Three doors — use it, contribute to it, watch it run — and the documentation. Everything else is one link away in the footer. */
export const NAV: { key: PageOptions["active"]; href: string; label: string; sub?: string }[] = [
  { key: "pool", href: "/", label: "Pool", sub: "use" },
  { key: "factory", href: "/factory", label: "Factory", sub: "contribute" },
  { key: "pipeline", href: "/pipeline", label: "Pipeline", sub: "live" },
  { key: "docs", href: "/docs", label: "Docs" },
];

/** The detail pages, pushed to the side: linked from the footer and from the doors. */
export const MORE: { href: string; label: string }[] = [
  { href: "/packages", label: "Packages" },
  { href: "/security", label: "Security" },
  { href: "/status", label: "Status" },
  { href: "/journal", label: "Journal" },
  { href: "/review", label: "Review" },
  { href: "/api", label: "API" },
];

/** One badge in the footer: this is built for Omarchy, and the link goes there. */
const BUILT_FOR_OMARCHY =
  '<svg viewBox="0 0 156 20" width="156" height="20" role="img" aria-label="built for Omarchy"><rect width="86" height="20" fill="#2a2e3f"/><rect x="86" width="70" height="20" fill="#9ece6a"/><rect x="6" y="5" width="10" height="10" fill="#9ece6a"/><rect x="9" y="8" width="4" height="4" fill="#2a2e3f"/><text x="21" y="14" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c0caf5">built for</text><text x="121" y="14" text-anchor="middle" font-family="Geist, sans-serif" font-size="11" font-weight="700" fill="#0c0e10">Omarchy</text></svg>';

export type DocKey = "index" | "get-started" | "workers" | "how-it-works" | "governance" | "api";

/** The documentation's chapters, in reading order; every docs page carries this bar. */
export const DOCS: { key: DocKey; href: string; label: string; blurb: string }[] = [
  { key: "get-started", href: "/docs/get-started", label: "Get started", blurb: "Point pacman at a ring: the key, the Server line, the upgrade." },
  { key: "workers", href: "/docs/workers", label: "Run a worker", blurb: "One image on GitHub Packages, with Docker Desktop or Podman: your own packages, donated compute, the project's builds — the registration decides." },
  { key: "how-it-works", href: "/docs/how-it-works", label: "How it works", blurb: "The pool, the rings, promotion by evidence, the factory, signing." },
  { key: "governance", href: "/docs/governance", label: "Governance", blurb: "Contributors and maintainers, categories, and how a pull request is the only way to become a maintainer." },
  { key: "api", href: "/api", label: "API", blurb: "Every endpoint the dashboard and the tools use." },
];

function docsBar(current: DocKey | undefined): string {
  if (!current) return "";
  const items = [{ key: "index" as DocKey, href: "/docs", label: "Documentation" }, ...DOCS].map(
    (d) => `<a href="${d.href}"${d.key === current ? ' class="on"' : ""}>${d.label}</a>`,
  );
  return `<nav class="docs-bar" aria-label="Documentation">${items.join("")}</nav>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function page(o: PageOptions): string {
  const v = o.version;
  const tag = escapeHtml(v.version);
  const chip = v.release_url
    ? `<a class="ver" href="${escapeHtml(v.release_url)}" title="running release">${tag}</a>`
    : `<span class="ver" title="local build">${tag}</span>`;
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === o.active ? ' class="active"' : ""}>${n.label}${n.sub ? `<small>${n.sub}</small>` : ""}</a>`).join("\n    ");
  const more = MORE.map((m) => `<a href="${m.href}">${m.label}</a>`).join("");
  const docs = docsBar(o.doc);
  const pool = o.poolUrl.replace(/\/$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<meta name="description" content="${escapeHtml(o.description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%239ece6a'/%3E%3Crect x='9' y='9' width='14' height='14' rx='1.5' fill='%230c0e10'/%3E%3Crect x='13' y='13' width='6' height='6' fill='%239ece6a'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@500;600;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<div id="progress"></div>
<header>
  <a class="brand" href="/"><span class="mark">▣</span> omarchy-pool</a>
  <div class="hmid">
    ${chip}
    <nav>
      ${nav}
    </nav>
    <a id="status" class="status" href="/status" title="checking"><i class="led"></i><span>checking</span></a>
  </div>
  <span class="account"><a id="account" href="/auth/github?next=${escapeHtml(o.active === "pipeline" ? "/pipeline" : "/factory")}" title="contributors and maintainers sign in with GitHub">Sign in</a><a id="signout" href="/auth/logout" hidden title="sign out of the dashboard on this browser">sign out</a></span>
</header>

<main>
${docs}
${o.body}
</main>

<footer>
  <span class="fleft"><a class="fbadge" href="https://omarchy.org/" title="Built for Omarchy">${BUILT_FOR_OMARCHY}</a><span class="fnote">a community pool — not official Omarchy</span></span>
  <span class="more">${more}</span>
  <a class="gh" href="https://github.com/firemanxbr/omarchy-pool" title="omarchy-pool on GitHub">${GITHUB_ICON} GitHub</a>
</footer>

<script>
(function () {
  document.querySelectorAll("footer .more a").forEach(function (a) { if (a.getAttribute("href") === location.pathname) a.classList.add("active"); });
${HELPERS.split("__POOL_URL__").join(pool)}
${o.script ?? ""}
})();
</script>
</body>
</html>`;
}
