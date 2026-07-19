#!/usr/bin/env node
// GraveLens release helper.
//
//   npm run release              -> auto MINOR bump (0.3.0 -> 0.4.0)
//   npm run release -- 1.0.0     -> explicit version (major / manual)
//   npm run release -- major     -> explicit major bump (0.4.0 -> 1.0.0)
//
// Rule: no number specified  = automatic minor bump.
//       a number specified   = that exact version (reserved for major releases).
//
// It bumps package.json, commits the bump, and pushes. Vercel then builds the
// pushed commit, and next.config.ts bakes the new version into the footer.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// Anything the caller passed after `--` is the explicit version / bump keyword.
const arg = process.argv[2]?.trim();
const bump = arg && arg.length ? arg : "minor";

// Refuse to run on a dirty tree so the release commit only ever contains the
// version bump (commit your feature work first, then release).
const dirty = out("git status --porcelain");
if (dirty) {
  console.error(
    "✋ Working tree has uncommitted changes. Commit or stash them first,\n" +
      "   then run the release so the bump commit stays clean.\n\n" +
      dirty
  );
  process.exit(1);
}

const pkgUrl = new URL("../package.json", import.meta.url);
const before = JSON.parse(readFileSync(pkgUrl, "utf8")).version;

// Bump package.json only (no tag, no commit yet).
run(`npm version ${bump} --no-git-tag-version`);

const after = JSON.parse(readFileSync(pkgUrl, "utf8")).version;

const files = ["package.json"];
if (existsSync(new URL("../package-lock.json", import.meta.url))) {
  files.push("package-lock.json");
}

run(`git add ${files.join(" ")}`);
run(`git commit -m "chore(release): v${after}"`);
run("git push");

console.log(`\n✅ Released v${before} -> v${after}. Vercel is deploying this commit.`);
