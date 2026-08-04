#!/usr/bin/env node
/**
 * Every repo that names a registry app id must name the SAME live one.
 *
 * This exact drift has bitten twice. The second time, a grep for `768572968`
 * came back clean across the whole tree while `ripar-sdk/src/cli-chain.ts` sat
 * there reading a dead registry — because it spells the id `768_572_968`, with
 * JavaScript's numeric separators, and a plain grep for the digits does not
 * match. Nothing failed. The SDK reported `validated 0` for an agent with two
 * passing verdicts, which is indistinguishable from an agent nobody has ever
 * validated, and that is the worst possible failure for a reputation system:
 * not an error, an understatement.
 *
 * So this checks BOTH spellings, everywhere, and it does it by normalising
 * rather than by listing them: any `768`-series id is matched with optional
 * underscores between the groups and the underscores are stripped before
 * comparison. A third spelling — `0x2DCA...`, or a string — would still slip
 * past, and that is stated here rather than pretended away.
 *
 * ## Where the truth comes from
 *
 * `ripar-contracts/DEPLOYED.json`, and nothing else. The three live ids, the
 * escrow asset, and every superseded registry are all in that file already, so
 * this derives its allow-list and its deny-list from it instead of keeping a
 * second copy that could itself drift. Deploy a new generation, update
 * DEPLOYED.json, and this starts failing every repo that has not caught up —
 * which is precisely the alarm that was missing.
 *
 * ## What counts as a finding
 *
 *   DEAD    — the repo names a registry that has been superseded. This is the
 *             one that costs you: a dead registry answers reads, it just
 *             answers them with nothing.
 *   UNKNOWN — a 768-series id that is in no list. Probably a new deployment
 *             somebody forgot to record; possibly a typo. Either way nobody
 *             can say what it is, so it fails.
 *   MISSING — a repo that is expected to name the registries and names none.
 *
 * Usage:
 *   node scripts/check-registry-ids.mjs [rootDir]
 *
 * `rootDir` defaults to the parent of this repo — the directory the sibling
 * repos are checked out into. In CI they are checked out explicitly; locally
 * it is just the projects directory.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "..");
const ROOT = resolve(process.argv[2] ?? join(CONTRACTS, ".."));

// ---------------------------------------------------------------------------
// The truth, read out of DEPLOYED.json
// ---------------------------------------------------------------------------

const deployedPath = join(CONTRACTS, "DEPLOYED.json");
if (!existsSync(deployedPath)) {
  console.error(`::error::${deployedPath} is missing — there is nothing to check against.`);
  process.exit(1);
}
const deployedText = readFileSync(deployedPath, "utf8");
const deployed = JSON.parse(deployedText);

/** The three registries every other repo is supposed to be reading. */
const LIVE = new Map(
  Object.entries(deployed.registries).map(([name, r]) => [String(r.appId), name])
);

/**
 * Assets, not apps. `768547363` is the rUSDC ASA the escrow is denominated in
 * and it is in the same numeric range, so without this it would read as an
 * unrecognised registry in every repo that mentions it.
 */
const ASSETS = new Set(
  Object.values(deployed.registries)
    .flatMap((r) => [r.bootstrappedTo?.asset, r.bootstrappedTo?.escrowAsset])
    .filter(Boolean)
    .map(String)
);

/**
 * Everything else DEPLOYED.json mentions is a previous generation.
 *
 * Derived rather than listed: the file already records what these replaced and
 * which apps are stranded, so scraping the ids out of it means a future
 * generation is covered the moment it is written down.
 */
const ID_PATTERN = /\b(768[_]?\d{3}[_]?\d{3})\b/g;
const normalise = (s) => s.replace(/_/g, "");
const MENTIONED = new Set([...deployedText.matchAll(ID_PATTERN)].map((m) => normalise(m[1])));
const DEAD = new Set([...MENTIONED].filter((id) => !LIVE.has(id) && !ASSETS.has(id)));

// ---------------------------------------------------------------------------
// The repos, and which ones must name a registry at all
// ---------------------------------------------------------------------------

/**
 * `mustName` marks a repo that TALKS to the chain. A repo in that list which
 * names no registry is a finding in itself — it means the ids moved somewhere
 * this check cannot see, most likely into an environment variable, and an id
 * that is not in the tree is an id nobody reviews.
 */
const REPOS = [
  { dir: "ripar-contracts", mustName: true },
  { dir: "ripar-skills", mustName: true },
  { dir: "ripar-sdk", mustName: true },
  { dir: "ripar-agent", mustName: true },
  { dir: "ripar-explorer", mustName: true },
  { dir: "ripar-analytics", mustName: true },
  { dir: "ripar-docs", mustName: false },
  { dir: "ripar-app-x402", mustName: false },
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", ".venv", "venv",
  "__pycache__", ".turbo", ".vercel", "coverage", ".algokit",
]);
const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "skills-lock.json"]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".md", ".mdx",
  ".yml", ".yaml", ".toml", ".env", ".sh", ".teal",
]);

/**
 * Is this id being USED, or being written about?
 *
 * The distinction is the whole difference between a bug and a comment. Both of
 * these mention a superseded registry:
 *
 *     const IDENTITY_APP = 768_547_159;              <- reads a dead registry
 *     // v1 (768547170) took the payment id as an ARGUMENT, so a score…
 *
 * The first is a live read against an app that answers with nothing. The second
 * is the record of WHY that app is dead, and deleting it to satisfy a linter
 * would delete the reason. So a dead id in a comment or in prose is reported —
 * it should not be invisible — but it does not fail the build.
 *
 * Block comments are tracked with a running `inBlock` flag rather than by
 * looking at each line alone, because a `/* … *\/` comment whose middle lines
 * are not `*`-prefixed is completely ordinary and reading those as code is a
 * false alarm on the exact prose that explains the dead id.
 *
 * This is still a scanner, not a parser: `/*` inside a string literal would
 * confuse it. That is a real limit and it is stated rather than papered over.
 * When in doubt it reports, because a false alarm costs a minute and a missed
 * dead registry cost a silent `validated 0`.
 */
function makeProseTest(file) {
  if (/\.(md|mdx)$/.test(file)) return () => true;
  let inBlock = false;
  return (line) => {
    const t = line.trim();
    const wasInBlock = inBlock;
    // Count block delimiters on THIS line before deciding, so a one-line
    // `/* … */` opens and closes without leaking into the next line.
    const opens = (line.match(/\/\*/g) ?? []).length;
    const closes = (line.match(/\*\//g) ?? []).length;
    if (opens > closes) inBlock = true;
    else if (closes > opens) inBlock = false;

    return (
      wasInBlock ||
      opens > 0 ||
      t.startsWith("//") ||
      t.startsWith("#") ||
      t.startsWith("*") ||
      t.startsWith('"""') ||
      // A JSON string value, which is how DEPLOYED.json records its own history.
      /^"[^"]*":\s*"/.test(t)
    );
  };
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf(".")))) {
      // A compiled TEAL file or a captured fixture can be enormous; an id
      // hiding in a 5 MB blob is not something a human is going to fix anyway.
      if (s.size <= 2_000_000) yield full;
    }
  }
}

// ---------------------------------------------------------------------------

const findings = [];
/** Real, but not fatal: a dead id somebody is explaining rather than reading. */
const notes = [];
const summary = [];

for (const repo of REPOS) {
  const dir = join(ROOT, repo.dir);
  if (!existsSync(dir)) {
    summary.push({ repo: repo.dir, state: "not checked out", hits: 0 });
    // Deliberately NOT an error. This script runs both locally, where a repo
    // may simply not be cloned, and in CI, where the checkout step decides
    // what is present. Failing on absence would make it useless in one of the
    // two. The summary says plainly which repos were actually examined, so a
    // clean run over nothing is impossible to mistake for a clean run.
    continue;
  }

  const perId = new Map();
  for (const file of walk(dir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("768")) continue;

    const rel = `${repo.dir}/${relative(dir, file)}`;
    const isProse = makeProseTest(rel);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // Called for EVERY line, not just matching ones — the block-comment flag
      // is a running state and skipping lines would desynchronise it.
      const prose = isProse(line);
      for (const m of line.matchAll(ID_PATTERN)) {
        const id = normalise(m[1]);
        if (ASSETS.has(id)) continue;
        if (!perId.has(id)) perId.set(id, []);
        perId.get(id).push({
          file: rel,
          line: i + 1,
          spelling: m[1],
          text: line.trim().slice(0, 140),
          prose,
        });
      }
    });
  }

  const live = [...perId.keys()].filter((id) => LIVE.has(id));
  const dead = [...perId.keys()].filter((id) => DEAD.has(id));
  const unknown = [...perId.keys()].filter((id) => !LIVE.has(id) && !DEAD.has(id));
  const hits = [...perId.values()].reduce((n, v) => n + v.length, 0);

  // A dead id in CODE is a live read against an app that answers with nothing.
  // The same id in a comment is the record of why it died — worth surfacing,
  // never worth failing a build over.
  const deadInCode = [];
  for (const id of dead) {
    for (const hit of perId.get(id)) {
      // DEPLOYED.json is where the DEAD list comes from in the first place, so
      // finding dead ids in it is the file doing its job. Flagging them would
      // make this script fail on its own source of truth.
      const isLedger = hit.file === "ripar-contracts/DEPLOYED.json";
      (hit.prose || isLedger ? notes : findings).push({
        level: "DEAD",
        repo: repo.dir,
        id,
        ...hit,
        why: hit.prose || isLedger
          ? `app ${id} is superseded and this line only records that fact — no read happens here.`
          : `app ${id} is a superseded registry. It still answers reads — with nothing — so code ` +
            `pointed at it reports an empty result rather than an error, which is the failure that ` +
            `looks like an answer.`,
      });
      if (!hit.prose && !isLedger && !deadInCode.includes(id)) deadInCode.push(id);
    }
  }
  for (const id of unknown) {
    for (const hit of perId.get(id)) {
      (hit.prose ? notes : findings).push({
        level: "UNKNOWN",
        repo: repo.dir,
        id,
        ...hit,
        why: `app ${id} is in neither the live set nor DEPLOYED.json's history, so nobody can say what it is.`,
      });
    }
  }
  if (repo.mustName && live.length === 0 && hits === 0) {
    findings.push({
      level: "MISSING",
      repo: repo.dir,
      id: "-",
      file: repo.dir,
      line: 0,
      spelling: "-",
      text: "",
      why:
        `this repo reads the chain but names no registry app id anywhere in its tree. Either the ` +
        `ids moved into configuration this check cannot see, or it stopped reading the chain.`,
    });
  }

  summary.push({
    repo: repo.dir,
    state: "checked",
    hits,
    live: live.sort(),
    dead: deadInCode.sort(),
    unknown: unknown.sort(),
    spellings: [...new Set([...perId.values()].flat().map((h) => (h.spelling.includes("_") ? "768_572_968" : "768572968")))],
  });
}

// ---------------------------------------------------------------------------

console.log("Canonical registries, from ripar-contracts/DEPLOYED.json:");
for (const [id, name] of LIVE) console.log(`  ${name.padEnd(20)} ${id}`);
console.log(`  (escrow assets, allowed: ${[...ASSETS].join(", ") || "none"})`);
console.log(`  (superseded, must not appear: ${[...DEAD].sort().join(", ")})`);
console.log("");

const width = Math.max(...summary.map((s) => s.repo.length));
for (const s of summary) {
  if (s.state !== "checked") {
    console.log(`  ${s.repo.padEnd(width)}  — not checked out, skipped`);
    continue;
  }
  const bits = [
    `${s.hits} reference(s)`,
    s.live.length ? `live: ${s.live.join(",")}` : "names no live registry",
    s.dead.length ? `DEAD: ${s.dead.join(",")}` : null,
    s.unknown.length ? `UNKNOWN: ${s.unknown.join(",")}` : null,
    s.spellings.length > 1 ? "both spellings" : s.spellings[0] === "768_572_968" ? "underscored spelling" : null,
  ].filter(Boolean);
  console.log(`  ${s.repo.padEnd(width)}  ${bits.join("  |  ")}`);
}

/**
 * Do the repos that name live registries agree with each other?
 *
 * Naming a subset is fine — ripar-agent only needs identity — but naming a
 * DIFFERENT id for the same registry is the drift this exists to catch, and it
 * is already covered by the DEAD/UNKNOWN classes above, since any id that is
 * not the current one is either superseded or unrecognised.
 */
const namedLive = new Set(summary.filter((s) => s.state === "checked").flatMap((s) => s.live ?? []));
const unreferenced = [...LIVE.keys()].filter((id) => !namedLive.has(id));
if (unreferenced.length) {
  console.log(
    `\n  note: no repo checked out here names ${unreferenced
      .map((id) => `${LIVE.get(id)} (${id})`)
      .join(", ")}.`
  );
}

// Printed always, and before the verdict, so a clean run still shows what was
// deliberately tolerated. A check whose "OK" hides eight mentions of dead
// registries is a check nobody can calibrate against.
if (notes.length) {
  console.log(`\n${notes.length} superseded id(s) mentioned in comments or prose — not failures:`);
  for (const n of notes) console.log(`  ${n.file}:${n.line}  ${n.id}  ${n.text}`);
}

if (findings.length === 0) {
  const checked = summary.filter((s) => s.state === "checked");
  console.log(
    `\nOK — ${checked.length} repo(s) checked, every registry id named IN CODE is a live one, in both spellings.`
  );
  process.exit(0);
}

console.log(`\n${findings.length} finding(s):\n`);
for (const f of findings) {
  // GitHub renders `::error file=…,line=…::` as an annotation on the diff.
  console.log(`::error file=${f.file},line=${f.line}::[${f.level}] ${f.why}`);
  console.log(`  ${f.level.padEnd(7)} ${f.file}:${f.line}  (spelled "${f.spelling}")`);
  if (f.text) console.log(`          ${f.text}`);
  console.log(`          ${f.why}`);
}
process.exit(1);
