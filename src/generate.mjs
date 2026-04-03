#!/usr/bin/env node
/**
 * depenoxx generator
 *
 * Builds two internal graphs from any workspace:
 * - repos: git-root -> git-root edges induced by internal package.json deps
 * - packages: package -> package internal deps
 *
 * Output (gitignored): dist/
 *
 * Env vars:
 *   WORKSPACE_ROOT  - root directory to scan (default: parent of this package)
 *   PROJECT_NAME    - display name (default: basename of workspace root)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(
  process.env.WORKSPACE_ROOT ? process.env.WORKSPACE_ROOT : path.join(serviceRoot, "..", ".."),
);
const projectName = process.env.PROJECT_NAME || path.basename(workspaceRoot);

const outRoot = path.join(serviceRoot, "dist");
const graphsRoot = path.join(outRoot, "graphs");
const reportsRoot = path.join(outRoot, "reports");

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".git",
  ".nx",
  ".opencode",
  ".sisyphus",
  ".worktrees",
  "worktrees",
  "tmp",
  "temp",
  "logs",
  ".cache",
  ".shadow-cljs",
  "__pycache__",
]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function stableColorForGroup(group) {
  let hash = 0;
  for (let i = 0; i < group.length; i += 1) {
    hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `"${hue} 0.28 0.96"`;
}

function dotQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function runDot(dotPath, svgPath, pngPath) {
  const svg = spawnSync("dot", ["-Tsvg", dotPath, "-o", svgPath], { stdio: "inherit" });
  if (svg.status !== 0) throw new Error(`dot -Tsvg failed: ${dotPath}`);
  const png = spawnSync("dot", ["-Tpng", dotPath, "-o", pngPath], { stdio: "inherit" });
  if (png.status !== 0) throw new Error(`dot -Tpng failed: ${dotPath}`);
}

async function walkForFiles(startAbs, targetBasename) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [startAbs];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith(".")) continue;
        stack.push(path.join(dir, ent.name));
        continue;
      }
      if (ent.isFile() && ent.name === targetBasename) {
        out.push(path.join(dir, ent.name));
      }
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walkForGitRoots(startAbs) {
  /** @type {Set<string>} */
  const roots = new Set();
  /** @type {string[]} */
  const stack = [startAbs];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some((e) => e.name === ".git")) {
      roots.add(dir);
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (IGNORE_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith(".")) continue;
      stack.push(path.join(dir, ent.name));
    }
  }

  return [...roots.values()].sort((a, b) => a.localeCompare(b));
}

const repoRootCache = new Map();

async function findRepoRoot(dirAbs) {
  const start = dirAbs;
  if (repoRootCache.has(start)) return repoRootCache.get(start);

  const visited = [];
  let cur = start;

  while (true) {
    if (repoRootCache.has(cur)) {
      const found = repoRootCache.get(cur);
      for (const v of visited) repoRootCache.set(v, found);
      repoRootCache.set(start, found);
      return found;
    }

    visited.push(cur);

    try {
      const st = await fsp.stat(path.join(cur, ".git"));
      if (st.isDirectory() || st.isFile()) {
        for (const v of visited) repoRootCache.set(v, cur);
        repoRootCache.set(start, cur);
        return cur;
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(cur);
    if (parent === cur) {
      for (const v of visited) repoRootCache.set(v, workspaceRoot);
      repoRootCache.set(start, workspaceRoot);
      return workspaceRoot;
    }

    if (cur === workspaceRoot) {
      for (const v of visited) repoRootCache.set(v, workspaceRoot);
      repoRootCache.set(start, workspaceRoot);
      return workspaceRoot;
    }

    cur = parent;
  }
}

function groupForRepo(relPosix) {
  if (!relPosix || relPosix === ".") return "root";
  const parts = relPosix.split("/").filter(Boolean);
  if (parts[0] === "orgs" && parts.length >= 2) {
    return `orgs/${parts[1]}`;
  }
  return parts[0] || "root";
}

function buildDot({ title, nodes, edges, groupBy }) {
  const lines = [];
  lines.push("digraph G {");
  lines.push(`  graph [rankdir=LR, bgcolor="#fcfcff", fontname="Helvetica", fontsize=18, labelloc="t", labeljust="l", label=${dotQuote(title)}];`);
  lines.push("  node  [shape=box, style=\"rounded,filled\", fontname=\"Helvetica\", fontsize=10, color=\"#c8c8d0\", fillcolor=\"#f4f4fb\"]; ");
  lines.push("  edge  [color=\"#777788\", arrowsize=0.7];");
  lines.push("");

  const groups = new Map();
  for (const node of nodes) {
    const g = groupBy(node.id);
    const arr = groups.get(g) ?? [];
    arr.push(node);
    groups.set(g, arr);
  }

  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const g of groupNames) {
    const clusterName = `cluster_${g.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
    const color = stableColorForGroup(g);
    lines.push(`  subgraph ${clusterName} {`);
    lines.push("    style=\"rounded,filled\";");
    lines.push("    color=\"#e6e6ef\";");
    lines.push(`    fillcolor=${color};`);
    lines.push("    fontname=\"Helvetica\";");
    lines.push("    fontsize=12;");
    lines.push(`    label=${dotQuote(g)};`);

    const items = (groups.get(g) ?? []).sort((a, b) => a.label.localeCompare(b.label));
    for (const n of items) {
      lines.push(`    ${dotQuote(n.id)} [label=${dotQuote(n.label)}];`);
    }
    lines.push("  }");
    lines.push("");
  }

  for (const e of edges) {
    const attrs = [];
    if (e.label) attrs.push(`label=${dotQuote(String(e.label))}`);
    if (e.penwidth) attrs.push(`penwidth=${String(e.penwidth)}`);
    lines.push(`  ${dotQuote(e.from)} -> ${dotQuote(e.to)}${attrs.length ? " [" + attrs.join(",") + "]" : ""};`);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function computeComponents(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, new Set());
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }

  const visited = new Set();
  const comps = [];
  for (const n of nodes) {
    if (visited.has(n)) continue;
    const q = [n];
    visited.add(n);
    const comp = [];
    while (q.length) {
      const cur = q.shift();
      comp.push(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (visited.has(nxt)) continue;
        visited.add(nxt);
        q.push(nxt);
      }
    }
    comps.push(comp);
  }

  comps.sort((a, b) => b.length - a.length);
  return comps;
}

function computeIsolates(nodes, edges) {
  const deg = new Map(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    if (deg.has(e.from)) deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    if (deg.has(e.to)) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return nodes.filter((n) => (deg.get(n) ?? 0) === 0);
}

async function main() {
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();

  await ensureDir(outRoot);
  await ensureDir(graphsRoot);
  await ensureDir(reportsRoot);

  const scanRoots = [
    path.join(workspaceRoot, "packages"),
    path.join(workspaceRoot, "services"),
    path.join(workspaceRoot, "orgs"),
  ].filter((p) => fs.existsSync(p));

  const packageJsonPaths = [];
  if (fs.existsSync(path.join(workspaceRoot, "package.json"))) {
    packageJsonPaths.push(path.join(workspaceRoot, "package.json"));
  }

  for (const r of scanRoots) {
    const found = await walkForFiles(r, "package.json");
    for (const p of found) packageJsonPaths.push(p);
  }

  // git roots
  const gitRootsAbs = new Set([workspaceRoot]);
  for (const r of scanRoots) {
    const roots = await walkForGitRoots(r);
    for (const abs of roots) gitRootsAbs.add(abs);
  }

  // Parse packages
  /** @type {Array<{name:string, dirAbs:string, dirRel:string, repoAbs:string, repoRel:string, deps:string[]}>} */
  const packages = [];

  for (const pkgPath of packageJsonPaths) {
    let raw;
    try {
      raw = await fsp.readFile(pkgPath, "utf8");
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const name = typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
    if (!name) continue;

    const dirAbs = path.dirname(pkgPath);
    const dirRel = toPosix(path.relative(workspaceRoot, dirAbs) || ".");

    const buckets = [parsed.dependencies ?? {}, parsed.devDependencies ?? {}, parsed.peerDependencies ?? {}, parsed.optionalDependencies ?? {}];
    const depNames = new Set();
    for (const b of buckets) {
      if (!b || typeof b !== "object") continue;
      for (const k of Object.keys(b)) depNames.add(k);
    }

    const repoAbs = await findRepoRoot(dirAbs);
    const repoRel = toPosix(path.relative(workspaceRoot, repoAbs) || ".");

    packages.push({
      name,
      dirAbs,
      dirRel,
      repoAbs,
      repoRel,
      deps: [...depNames.values()].sort((a, b) => a.localeCompare(b)),
    });
  }

  // index packages by name
  const packagesByName = new Map();
  for (const pkg of packages) {
    const arr = packagesByName.get(pkg.name) ?? [];
    arr.push(pkg);
    packagesByName.set(pkg.name, arr);
  }

  const duplicateNames = [...packagesByName.entries()].filter(([, arr]) => arr.length > 1).map(([name]) => name);
  const uniquePackages = packages.filter((p) => (packagesByName.get(p.name) ?? []).length === 1);

  const uniqueByName = new Map(uniquePackages.map((p) => [p.name, p]));

  // package edges (unique names only)
  /** @type {Array<{from:string,to:string}>} */
  const pkgEdges = [];
  for (const pkg of uniquePackages) {
    for (const depName of pkg.deps) {
      if (!uniqueByName.has(depName)) continue;
      if (depName === pkg.name) continue;
      pkgEdges.push({ from: pkg.name, to: depName });
    }
  }

  // repo edges derived from package edges
  const repoEdgeCounts = new Map();
  for (const e of pkgEdges) {
    const fromPkg = uniqueByName.get(e.from);
    const toPkg = uniqueByName.get(e.to);
    if (!fromPkg || !toPkg) continue;
    if (fromPkg.repoRel === toPkg.repoRel) continue;
    const key = `${fromPkg.repoRel}→${toPkg.repoRel}`;
    repoEdgeCounts.set(key, (repoEdgeCounts.get(key) ?? 0) + 1);
  }

  const repoEdges = [...repoEdgeCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split("→");
    const penwidth = Math.min(8, 1 + Math.log10(count + 1) * 3);
    return { from, to, label: count, penwidth };
  });

  // Repo nodes: all git roots (so we can find isolates even for non-node repos)
  const repoNodes = [...gitRootsAbs.values()]
    .map((abs) => toPosix(path.relative(workspaceRoot, abs) || "."))
    .sort((a, b) => a.localeCompare(b));

  const reposWithPackages = new Set(packages.map((p) => p.repoRel));
  const reposWithoutPackages = repoNodes.filter((r) => !reposWithPackages.has(r));

  // Build DOT + render
  const projectDir = projectName.toLowerCase().replaceAll(/\s+/g, "-");
  await ensureDir(path.join(graphsRoot, projectDir));

  const repoDot = buildDot({
    title: `${projectName} · repo dependency graph (${generatedAt})`,
    nodes: repoNodes.map((id) => ({ id, label: id })),
    edges: repoEdges,
    groupBy: groupForRepo,
  });

  const repoDotPath = path.join(graphsRoot, projectDir, "repos.dot");
  const repoSvgPath = path.join(graphsRoot, projectDir, "repos.svg");
  const repoPngPath = path.join(graphsRoot, projectDir, "repos.png");
  await fsp.writeFile(repoDotPath, repoDot, "utf8");
  runDot(repoDotPath, repoSvgPath, repoPngPath);

  const pkgDot = buildDot({
    title: `${projectName} · package dependency graph (${generatedAt})`,
    nodes: uniquePackages.map((p) => ({ id: p.name, label: p.name })),
    edges: pkgEdges.map((e) => ({ ...e })),
    groupBy: (pkgName) => {
      const pkg = uniqueByName.get(pkgName);
      return pkg ? groupForRepo(pkg.repoRel) : "unknown";
    },
  });

  const pkgDotPath = path.join(graphsRoot, projectDir, "packages.dot");
  const pkgSvgPath = path.join(graphsRoot, projectDir, "packages.svg");
  const pkgPngPath = path.join(graphsRoot, projectDir, "packages.png");
  await fsp.writeFile(pkgDotPath, pkgDot, "utf8");
  runDot(pkgDotPath, pkgSvgPath, pkgPngPath);

  // Analysis
  const repoComponents = computeComponents(repoNodes, repoEdges);
  const repoIsolates = computeIsolates(repoNodes, repoEdges);

  const pkgNames = uniquePackages.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  const pkgComponents = computeComponents(pkgNames, pkgEdges);
  const pkgIsolates = computeIsolates(pkgNames, pkgEdges);

  const report = {
    generatedAt,
    durationMs: Date.now() - startedAt,
    repos: {
      count: repoNodes.length,
      withPackages: reposWithPackages.size,
      withoutPackages: reposWithoutPackages,
      edges: repoEdges.length,
      isolates: repoIsolates,
      components: repoComponents.map((nodes) => ({ size: nodes.length, nodes })),
    },
    packages: {
      count: pkgNames.length,
      edges: pkgEdges.length,
      isolates: pkgIsolates.map((name) => ({ name, repo: uniqueByName.get(name)?.repoRel ?? "?" })),
      components: pkgComponents.map((nodes) => ({ size: nodes.length, nodes })),
      duplicateNames,
    },
  };

  await fsp.writeFile(path.join(outRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const mdLines = [];
  mdLines.push(`# ${projectName} Dependency Report`);
  mdLines.push("");
  mdLines.push(`_generatedAt: ${generatedAt}_`);
  mdLines.push("");
  mdLines.push(`- repos: ${report.repos.count} (with package.json: ${report.repos.withPackages})`);
  mdLines.push(`- repo edges: ${report.repos.edges}`);
  mdLines.push(`- repo isolates: ${report.repos.isolates.length}`);
  mdLines.push(`- packages (unique names): ${report.packages.count}`);
  mdLines.push(`- package edges: ${report.packages.edges}`);
  mdLines.push(`- package isolates: ${report.packages.isolates.length}`);
  mdLines.push("");

  mdLines.push("## Repo isolates (no internal edges)");
  mdLines.push("");
  for (const r of report.repos.isolates.slice(0, 400)) {
    const note = report.repos.withoutPackages.includes(r) ? " (no package.json found)" : "";
    mdLines.push('- `' + r + '`' + note);
  }
  if (report.repos.isolates.length > 400) {
    mdLines.push("");
    mdLines.push(`… (${report.repos.isolates.length - 400} more)`);
  }
  mdLines.push("");

  mdLines.push("## Largest repo components");
  mdLines.push("");
  for (const c of report.repos.components.slice(0, 20)) {
    const preview = c.nodes.slice(0, 12).map((n) => '`' + n + '`').join(", ");
    mdLines.push(`- size ${c.size}: ${preview}${c.nodes.length > 12 ? ", …" : ""}`);
  }
  mdLines.push("");

  mdLines.push("## Duplicate package names (ambiguous)");
  mdLines.push("");
  if (duplicateNames.length === 0) {
    mdLines.push("- none");
  } else {
    for (const name of duplicateNames) {
      mdLines.push('- `' + name + '`');
    }
  }
  mdLines.push("");

  await fsp.writeFile(path.join(reportsRoot, "report.md"), mdLines.join("\n") + "\n", "utf8");

  // Manifest for UI
  const manifest = {
    generatedAt,
    projectName,
    projects: [
      {
        id: projectDir,
        title: projectName,
        subtitle: "Repo + package dependency graphs",
        description: `Internal dependency atlas for ${projectName} derived from package.json (internal deps only).`,
        tags: ["workspace", "dependencies", "graph"],
        graphs: [
          {
            id: "repos",
            title: "Repo dependency graph",
            kind: "subsystems",
            svg: `/dist/graphs/${projectDir}/repos.svg`,
            png: `/dist/graphs/${projectDir}/repos.png`,
            json: null,
          },
          {
            id: "packages",
            title: "Package dependency graph",
            kind: "files",
            svg: `/dist/graphs/${projectDir}/packages.svg`,
            png: `/dist/graphs/${projectDir}/packages.png`,
            json: null,
          },
        ],
      },
    ],
  };

  await fsp.writeFile(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ ok: true, generatedAt, durationMs: report.durationMs, repos: report.repos, packages: { count: report.packages.count, edges: report.packages.edges } }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
