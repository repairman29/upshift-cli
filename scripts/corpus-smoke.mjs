#!/usr/bin/env node
/**
 * Shallow-clone pinned repos from tests/corpus/repos.json and run read-only upshift commands.
 * Usage (from repo root): npm run build && npm run test:corpus
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "tests/corpus/repos.json");
const cliPath = path.join(repoRoot, "dist/cli.js");

function runProcess(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? repoRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

function isSha(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

async function shallowClone(url, ref, dest) {
  if (isSha(ref)) {
    mkdirSync(dest, { recursive: true });
    await runProcess("git", ["init"], { cwd: dest, timeoutMs: 30_000 });
    await runProcess("git", ["remote", "add", "origin", url], { cwd: dest, timeoutMs: 30_000 });
    const fetch = await runProcess("git", ["fetch", "--depth", "1", "origin", ref], {
      cwd: dest,
      timeoutMs: 180_000,
    });
    if (fetch.code !== 0) {
      return { ok: false, err: fetch.stderr || fetch.stdout };
    }
    const co = await runProcess("git", ["checkout", "FETCH_HEAD"], { cwd: dest, timeoutMs: 60_000 });
    if (co.code !== 0) {
      return { ok: false, err: co.stderr || co.stdout };
    }
    return { ok: true };
  }
  const clone = await runProcess(
    "git",
    ["clone", "--depth", "1", "--branch", ref, url, dest],
    { cwd: repoRoot, timeoutMs: 180_000 }
  );
  if (clone.code !== 0) {
    return { ok: false, err: clone.stderr || clone.stdout };
  }
  return { ok: true };
}

async function main() {
  if (!existsSync(cliPath)) {
    console.error("Corpus smoke: run npm run build first (dist/cli.js missing).");
    process.exit(1);
  }
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const defaults = manifest.defaults ?? {};
  const timeoutDefault = defaults.timeoutMs ?? 180_000;
  const repos = manifest.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    console.error("Corpus smoke: tests/corpus/repos.json has no repos.");
    process.exit(1);
  }

  const tmpRoot = mkdtempSync(path.join(tmpdir(), "upshift-corpus-"));
  let failed = 0;

  try {
    for (const entry of repos) {
      const name = entry.name ?? "unnamed";
      const url = entry.url;
      const ref = entry.ref;
      const commands = entry.commands ?? [["scan"]];
      const timeoutMs = entry.timeoutMs ?? timeoutDefault;
      if (!url || !ref) {
        console.error(`SKIP ${name}: missing url or ref`);
        failed++;
        continue;
      }
      const dest = path.join(tmpRoot, name.replace(/[^a-zA-Z0-9_-]/g, "_"));
      console.log(`Corpus: cloning ${name} (${ref})…`);
      const cloned = await shallowClone(url, ref, dest);
      if (!cloned.ok) {
        console.error(`FAIL ${name}: clone — ${cloned.err}`);
        failed++;
        continue;
      }
      for (const args of commands) {
        const label = [name, ...args].join(" ");
        console.log(`Corpus: upshift ${args.join(" ")} in ${name}…`);
        const r = await runProcess(process.execPath, [cliPath, ...args], {
          cwd: dest,
          timeoutMs,
        });
        if (r.code !== 0) {
          console.error(`FAIL ${label}: exit ${r.code}\n${r.stderr || r.stdout}`);
          failed++;
        } else {
          console.log(`OK ${label}`);
        }
      }
    }
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (failed > 0) {
    console.error(`\nCorpus smoke: ${failed} failure(s).`);
    process.exit(1);
  }
  console.log("\nCorpus smoke: all repos passed.");
}

main().catch((e) => {
  console.error("Corpus smoke error:", e);
  process.exit(1);
});
