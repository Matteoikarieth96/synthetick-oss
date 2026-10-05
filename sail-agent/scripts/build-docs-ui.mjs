#!/usr/bin/env node
/**
 * Build ui/dist for the Sailor dashboard: the stock UI plus this project's
 * documentation page.
 *
 * The dashboard server (sailor ui start) serves static files from
 * SAILOR_UI_DIST when set (real files win over the SPA catch-all), so:
 *   1. copy the package's built dashboard (node_modules/.../packages/ui/dist),
 *   2. render docs/HOW-IT-WORKS.md into a standalone how-it-works.html.
 *
 * Run via `npm run ui` (builds, then starts the dashboard pointed here).
 * Re-run after editing docs/HOW-IT-WORKS.md or updating @sail.money/sailor.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = path.join(root, "node_modules", "@sail.money", "sailor", "packages", "ui", "dist");
const out = path.join(root, "ui", "dist");

if (!existsSync(path.join(src, "index.html"))) {
  console.error(`No dashboard build at ${src} — is @sail.money/sailor installed?`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

// ── Minimal markdown renderer — covers exactly what HOW-IT-WORKS.md uses:
// headers, paragraphs, bold, inline code, links, tables, unordered/ordered lists.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, href) =>
      /^https?:/.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${t}</a>` : t,
    );

function mdToHtml(md) {
  const lines = md.split("\n");
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,3} /.test(line)) {
      const level = line.match(/^#+/)[0].length;
      parts.push(`<h${level}>${inline(line.replace(/^#+ /, ""))}</h${level}>`);
      i++;
    } else if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.split("|").slice(1, -1).map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      parts.push(
        `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
    } else if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (i < lines.length && (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i])))
        items.push(lines[i++].replace(/^([-*]|\d+\.) /, ""));
      const tag = ordered ? "ol" : "ul";
      parts.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
    } else if (line.trim() === "") {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||[-*] |\d+\. )/.test(lines[i])) para.push(lines[i++]);
      parts.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return parts.join("\n");
}

const md = readFileSync(path.join(root, "docs", "HOW-IT-WORKS.md"), "utf-8");
const body = mdToHtml(md);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>How this agent works — Sailor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #d7dce6; font: 15px/1.65 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
  .top { display: flex; align-items: baseline; gap: 14px; margin-bottom: 6px; }
  .top a { color: #7aa2f7; text-decoration: none; font-size: 13px; }
  h1 { font-size: 26px; color: #fff; margin: 8px 0 4px; }
  h2 { font-size: 19px; color: #fff; margin: 34px 0 8px; border-bottom: 1px solid #1e2635; padding-bottom: 6px; }
  h3 { font-size: 16px; color: #e6ebf5; margin: 22px 0 6px; }
  p { margin: 10px 0; }
  a { color: #7aa2f7; }
  code { background: #161c28; border: 1px solid #232c3d; border-radius: 4px; padding: 1px 5px; font-size: 13px; color: #9ecbff; word-break: break-all; }
  .tbl { overflow-x: auto; margin: 12px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { border: 1px solid #232c3d; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #121826; color: #fff; }
  ul, ol { margin: 10px 0; padding-left: 22px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a href="/#/dashboard">← back to dashboard</a> · <a href="/overview.html">agent overview</a></div>
${body}
</div>
</body>
</html>
`;

writeFileSync(path.join(out, "how-it-works.html"), html);
// The overview page (portfolio, transactions, activity log) — a plain static
// file; its data sidecar is produced by scripts/build-overview-data.mjs.
cpSync(path.join(root, "ui", "overview.html"), path.join(out, "overview.html"));

// Surface the overview inside the dashboard SPA itself: a fixed pill link
// injected into the copied index.html (the SPA is compiled, so its nav can't
// be edited — this floats above every route and is re-applied on each build).
const indexPath = path.join(out, "index.html");
const pill =
  `<style>#agent-overview-pill{position:fixed;right:18px;bottom:18px;z-index:2147483000;` +
  `background:#10151f;border:1px solid #2a3550;color:#7aa2f7;padding:9px 16px;border-radius:99px;` +
  `font:13px/1 -apple-system,"Segoe UI",Roboto,sans-serif;text-decoration:none;` +
  `box-shadow:0 4px 16px rgba(0,0,0,.45)}#agent-overview-pill:hover{border-color:#7aa2f7;color:#a7c1ff}</style>` +
  `<a id="agent-overview-pill" href="/overview.html">📊 Agent overview</a>`;
writeFileSync(indexPath, readFileSync(indexPath, "utf-8").replace("</body>", `${pill}</body>`));
console.log(`built ${out} (stock dashboard + how-it-works.html + overview.html)`);
