import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function checkDashKey(searchParams, secret) {
  if (!secret) return { ok: false, error: "DASHBOARD_KEY not set on server" };
  const key = searchParams.get("key") || "";
  const i = key.lastIndexOf("_");
  if (i < 0) return { ok: false };
  if (key.slice(0, i) !== secret) return { ok: false };
  const userId = key.slice(i + 1);
  if (!userId) return { ok: false };
  return { ok: true, userId };
}

function send(res, body, type) {
  res.writeHead(200, { "content-type": type + "; charset=utf-8" });
  res.end(body);
}

// files = { html, manifest, sw } كنصوص جاهزة
export function createDashHandler({ secret, apiSummary, apiStatement, files }) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/dash", "http://x");
    } catch {
      return false;
    }
    if (!url.pathname.startsWith("/dash")) return false;
    if (url.pathname === "/dash/manifest.json") return send(res, files.manifest, "application/manifest+json"), true;
    if (url.pathname === "/dash/sw.js") return send(res, files.sw, "application/javascript"), true;
    if (url.pathname === "/dash/api/summary" || url.pathname === "/dash/api/statement") {
      const auth = checkDashKey(url.searchParams, secret);
      if (!auth.ok) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return true;
      }
      try {
        const data = url.pathname.endsWith("summary")
          ? await apiSummary(auth.userId)
          : await apiStatement(auth.userId, url.searchParams.get("month") || "");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(e?.message || e).slice(0, 200) }));
      }
      return true;
    }
    if (url.pathname === "/dash" || url.pathname === "/dash/") {
      return send(res, files.html, "text/html"), true;
    }
    return false;
  };
}

export function loadDashFiles() {
  return {
    html: fs.readFileSync(path.join(here, "dash.html"), "utf8"),
    manifest: fs.readFileSync(path.join(here, "dash-manifest.json"), "utf8"),
    sw: fs.readFileSync(path.join(here, "dash-sw.js"), "utf8"),
  };
}
