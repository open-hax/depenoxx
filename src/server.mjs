#!/usr/bin/env node
/**
 * depenoxx server
 *
 * - serves /public (tracked UI)
 * - serves /dist (generated graphs + manifest + reports)
 * - POST /api/generate to rebuild graphs
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(
  process.env.WORKSPACE_ROOT ? process.env.WORKSPACE_ROOT : path.join(serviceRoot, "..", ".."),
);

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "8798", 10);

const PUBLIC_DIR = path.join(serviceRoot, "public");
const DIST_DIR = path.join(serviceRoot, "dist");
const GENERATE_SCRIPT = path.join(serviceRoot, "src", "generate.mjs");

let generationInFlight = null;

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sanitizeUrlPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  decoded = decoded.replaceAll("\u0000", "");

  const parts = decoded.split("/").filter((p) => p.length > 0);
  const safe = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part);
  }
  return "/" + safe.join("/");
}

async function tryStat(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function serveFromDir(req, res, baseDir, urlPath) {
  const safePath = sanitizeUrlPath(urlPath);
  if (!safePath) {
    json(res, 400, { error: "bad_path" });
    return;
  }

  let target = safePath;
  if (target === "/") target = "/index.html";
  if (target.endsWith("/")) target = target + "index.html";

  const abs = path.resolve(baseDir, "." + target);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith(".." + path.sep) || rel === "..") {
    json(res, 403, { error: "forbidden" });
    return;
  }

  const st = await tryStat(abs);
  if (!st) {
    json(res, 404, { error: "not_found" });
    return;
  }

  if (st.isDirectory()) {
    const idx = path.join(abs, "index.html");
    const idxSt = await tryStat(idx);
    if (!idxSt || !idxSt.isFile()) {
      json(res, 404, { error: "not_found" });
      return;
    }
    res.writeHead(200, {
      "content-type": contentTypeForPath(idx),
      "content-length": String(idxSt.size),
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(idx).pipe(res);
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypeForPath(abs),
    "content-length": String(st.size),
    "cache-control": "no-cache",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(abs).pipe(res);
}

async function handleGenerate(res) {
  if (generationInFlight) {
    json(res, 409, { ok: false, error: "generation_in_flight" });
    return;
  }

  generationInFlight = new Promise((resolve) => {
    const child = spawn(process.execPath, [GENERATE_SCRIPT], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        WORKSPACE_ROOT: workspaceRoot,
      },
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({ code, output });
    });
  });

  const result = await generationInFlight;
  generationInFlight = null;

  // Try parse last JSON object printed.
  const lines = String(result.output || "").trim().split(/\r?\n/);
  const lastJsonLine = [...lines].reverse().find((line) => line.trim().startsWith("{")) ?? "";
  let summary = null;
  try {
    summary = lastJsonLine ? JSON.parse(lastJsonLine) : null;
  } catch {
    summary = null;
  }

  json(res, result.code === 0 ? 200 : 500, {
    ok: result.code === 0,
    exitCode: result.code,
    summary,
    output: result.output.slice(-60_000),
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        workspaceRoot: path.relative(process.cwd(), workspaceRoot),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(res);
      return;
    }

    if (url.pathname === "/api/report") {
      const reportPath = path.join(DIST_DIR, "report.json");
      const raw = await fsp.readFile(reportPath, "utf8").catch(() => null);
      if (!raw) {
        json(res, 404, { error: "report_not_found" });
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(raw);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (url.pathname.startsWith("/dist/")) {
      await serveFromDir(req, res, DIST_DIR, url.pathname.slice("/dist".length) || "/");
      return;
    }

    // public (UI)
    await serveFromDir(req, res, PUBLIC_DIR, url.pathname);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[depenoxx] listening on http://${HOST}:${PORT}`);
});
