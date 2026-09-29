// The built app (dist/app), public: it is built from tracked files with no env and holds no
// secret. Hashed assets are immutable; index.html is never cached; a path with
// no extension falls back to index.html (the SPA routes by hash anyway). Nothing outside the root.
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  cache: string,
): void {
  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    "cache-control": cache,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** GET or HEAD under `root`. */
export function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const base = resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://edge").pathname,
    );
  } catch {
    plain(res, 400, "bad path");
    return;
  }
  if (pathname.includes("\0")) {
    plain(res, 400, "bad path");
    return;
  }
  const file = resolve(base, `.${sep}${normalize(pathname)}`);
  if (file !== base && !file.startsWith(`${base}${sep}`)) {
    plain(res, 404, "not found");
    return;
  }
  if (pathname !== "/" && isFile(file)) {
    const immutable = pathname.startsWith("/assets/");
    sendFile(
      req,
      res,
      file,
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return;
  }
  if (extname(pathname) !== "") {
    plain(res, 404, "not found");
    return;
  }
  const index = join(base, "index.html");
  if (!isFile(index)) {
    plain(res, 503, "the app is not built");
    return;
  }
  sendFile(req, res, index, "no-store");
}
