#!/usr/bin/env node
// strava-upload.js
// Uploads your Nike Run Club history (downloaded with nike-download.js) to Strava.
//   - runs with GPS are uploaded as GPX files (map, pace, heart rate, elevation)
//   - runs without GPS (treadmill, old sensor runs) are created as manual runs (distance and time only)
//   - runs that are already on Strava are skipped, so it is safe to use alongside an existing account
//   - runs that are on Strava WITHOUT a map (e.g. imported from Apple Health) but have GPS in Nike
//     are listed in nike-export/_strava/mapless_on_strava.html so you can replace them
// Progress is saved after every run, so you can stop it and run it again at any time.
// It only talks to strava.com.
//
// Put this file next to nike-download.js (and the nike-export folder), then run:
//   node strava-upload.js --test    uploads ONE run so you can check it on Strava
//   node strava-upload.js           uploads the rest
// Needs Node.js 18 or later. No npm install.

"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { exec } = require("child_process");

const EXPORT = path.join(__dirname, "nike-export");
const WORK = path.join(EXPORT, "_strava");
const LOG = path.join(WORK, "upload_log.jsonl");
const AUTH = path.join(WORK, "strava_auth.json");
const NAMES = path.join(WORK, "keep_names.json");
const REPORT = path.join(WORK, "mapless_on_strava.html");
const API = process.env.STRAVA_API_BASE || "https://www.strava.com";
const PORT = 8723;
const REDIRECT = `http://localhost:${PORT}/callback`;
const DESCRIPTION = "Imported from Nike Run Club";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Stop extends Error {}

// ---------- terminal input ----------
let rl, lines = [], waiting = [], inputClosed = false;
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
    rl.on("line", (l) => (waiting.length ? waiting.shift()(l.trim()) : lines.push(l.trim())));
    rl.on("close", () => { inputClosed = true; while (waiting.length) waiting.shift()(""); });
  }
  process.stdout.write(q);
  return new Promise((res) => (lines.length ? res(lines.shift()) : inputClosed ? res("") : waiting.push(res)));
}
const closeAsk = () => { if (rl) { rl.close(); rl = null; inputClosed = false; } };

// ---------- reading the Nike export ----------
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const pad = (n) => String(n).padStart(2, "0");
function localIso(ms) { // start time in this computer's time zone, as Strava expects for manual runs
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadNikeRuns() {
  const csv = path.join(EXPORT, "summary.csv");
  if (!fs.existsSync(csv)) throw new Stop("Can't find nike-export/summary.csv. Run nike-download.js first, from the same folder as this script.");
  const seen = new Set(), runs = [];
  for (const r of parseCsv(fs.readFileSync(csv, "utf8"))) {
    const rawFile = path.join(EXPORT, "raw", `${r.id}.json`);
    if (!fs.existsSync(rawFile)) continue;
    const a = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    if (a.type !== "run" || a.deleted || a.delete_indicator) continue;
    const km = parseFloat(r.distance_km);
    if (!(km > 0) || !Number.isFinite(a.start_epoch_ms)) continue;
    const key = `${a.start_epoch_ms}`;
    if (seen.has(key)) continue; // Nike sometimes holds two copies of the same run
    seen.add(key);
    const tags = a.tags || {};
    const weekday = new Date(a.start_epoch_ms).toLocaleDateString("en-GB", { weekday: "long" });
    runs.push({
      nike_id: r.id,
      start_ms: a.start_epoch_ms,
      km,
      name: tags["com.nike.name"] || `${weekday} Run`,
      gpx: r.gpx_file ? path.join(EXPORT, "gpx", r.gpx_file) : null,
      elapsed: Math.round((a.active_duration_ms || (a.end_epoch_ms - a.start_epoch_ms)) / 1000),
      indoor: String(tags.location || "").toLowerCase() === "indoors",
    });
  }
  return runs.sort((x, y) => y.start_ms - x.start_ms); // newest first
}

// ---------- progress log ----------
function readLog() {
  const done = new Map();
  if (!fs.existsSync(LOG)) return done;
  for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); done.set(e.nike_id, e); } catch {}
  }
  return done;
}
const writeLog = (e) => fs.appendFileSync(LOG, JSON.stringify({ ...e, at: new Date().toISOString() }) + "\n");
const isFinished = (e) => e && (e.status === "ok" || e.status === "duplicate");

// ---------- Strava sign-in ----------
const saveAuth = (a) => fs.writeFileSync(AUTH, JSON.stringify(a, null, 1), { mode: 0o600 });

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Stop(`Strava sign-in failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== "/callback") { res.writeHead(404); return res.end(); }
      const code = u.searchParams.get("code");
      const scope = u.searchParams.get("scope") || "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (code && scope.includes("activity:write") && scope.includes("activity:read_all")) {
        res.end("<h2>Connected to Strava.</h2><p>You can close this tab and go back to the terminal.</p>");
        server.close(); resolve(code);
      } else {
        res.end("<h2>Not connected.</h2><p>Run the script again and leave all the permission boxes ticked.</p>");
        server.close(); reject(new Stop("Strava permissions were not granted. Run again and leave all the boxes ticked on the Strava page."));
      }
    });
    server.on("error", (e) => reject(new Stop(`Could not start the sign-in helper on port ${PORT}: ${e.message}`)));
    server.listen(PORT); // listens on both IPv4 and IPv6 'localhost'
  });
}

function openBrowser(url) {
  if (process.env.NO_BROWSER) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${cmd} "${url}"`, () => {});
}

async function getAuth() {
  let a = fs.existsSync(AUTH) ? JSON.parse(fs.readFileSync(AUTH, "utf8")) : null;
  if (!a || !a.refresh_token) {
    console.log("First, connect this script to your Strava account (see README, 'Create a Strava API app').\n");
    const client_id = (a && a.client_id) || (await ask("Client ID (from strava.com/settings/api): "));
    const client_secret = (a && a.client_secret) || (await ask("Client Secret: "));
    closeAsk();
    if (!/^\d+$/.test(client_id) || client_secret.length < 20) {
      fs.rmSync(AUTH, { force: true });
      throw new Stop("That Client ID or Secret doesn't look right. The ID is a number; the Secret is a long code (click 'show' on strava.com/settings/api). Run again.");
    }
    saveAuth({ client_id, client_secret });
    const url = `${API}/oauth/authorize?client_id=${encodeURIComponent(client_id)}&response_type=code` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&approval_prompt=force&scope=activity:write,activity:read_all`;
    console.log("\nA Strava page will open in your browser. Click Authorize.\nIf it doesn't open, copy this link into your browser:\n" + url + "\n");
    const codeP = waitForCode();
    openBrowser(url);
    const code = await codeP;
    const t = await tokenRequest({ client_id, client_secret, code, grant_type: "authorization_code" });
    a = { client_id, client_secret, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at };
    saveAuth(a);
    console.log("Connected to Strava.\n");
  }
  return a;
}

async function accessToken(a) {
  if (Date.now() / 1000 > (a.expires_at || 0) - 300) {
    const t = await tokenRequest({ client_id: a.client_id, client_secret: a.client_secret, grant_type: "refresh_token", refresh_token: a.refresh_token });
    Object.assign(a, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at });
    saveAuth(a);
  }
  return a.access_token;
}

// ---------- Strava API with rate-limit handling ----------
function nextQuarterHour() {
  if (process.env.SHORT_WAIT) return 1000;
  const d = new Date(); const m = d.getUTCMinutes();
  d.setUTCMinutes(m - (m % 15) + 15, 5, 0);
  return d.getTime() - Date.now();
}

async function checkLimits(res) {
  for (const [lim, use] of [["x-ratelimit-limit", "x-ratelimit-usage"], ["x-readratelimit-limit", "x-readratelimit-usage"]]) {
    const L = (res.headers.get(lim) || "").split(",").map(Number);
    const U = (res.headers.get(use) || "").split(",").map(Number);
    if (L.length < 2 || U.length < 2 || !L[0]) continue;
    if (U[1] >= L[1] - 3) throw new Stop("Strava's daily limit for this app has been reached. Run the same command again tomorrow (it resets at midnight UTC) and it will carry on.");
    if (U[0] >= L[0] - 3) {
      const w = nextQuarterHour();
      console.log(`  pausing ${Math.ceil(w / 60000)} min for Strava's 15-minute limit...`);
      await sleep(w);
    }
  }
}

async function strava(auth, method, p, body) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/api/v3${p}`, { method, headers: { Authorization: `Bearer ${await accessToken(auth)}` }, body });
    } catch (e) {
      if (attempt === 6) throw e;
      await sleep(5000 * attempt); continue;
    }
    if (res.status === 429) {
      const w = nextQuarterHour();
      console.log(`  Strava says slow down, pausing ${Math.ceil(w / 60000)} min...`);
      await sleep(w); continue;
    }
    if (res.status === 401) throw new Stop(`Strava rejected the sign-in. Delete ${path.relative(process.cwd(), AUTH)} and run again to reconnect.`);
    if (res.status >= 500) { await sleep(10000 * attempt); continue; }
    const json = await res.json().catch(() => ({}));
    await checkLimits(res);
    return { status: res.status, json };
  }
  throw new Error("Strava did not respond after several attempts");
}

// ---------- what is already on Strava ----------
async function stravaRuns(auth) {
  const all = [];
  for (let page = 1; ; page++) {
    const { status, json } = await strava(auth, "GET", `/athlete/activities?per_page=200&page=${page}`);
    if (status !== 200 || !Array.isArray(json)) throw new Error(`Could not read your Strava activities (HTTP ${status})`);
    for (const a of json) {
      if (!/run/i.test(a.sport_type || a.type || "")) continue;
      all.push({
        id: String(a.id),
        start_ms: Date.parse(a.start_date),
        km: (a.distance || 0) / 1000,
        name: a.name,
        hasMap: !!(a.map && a.map.summary_polyline),
      });
    }
    if (json.length < 200) break;
  }
  return all;
}

// Same run = starts within 3 minutes and distance within 8% (or 300 m)
function findMatch(run, onStrava) {
  return onStrava.find((s) => Math.abs(s.start_ms - run.start_ms) <= 3 * 60000 &&
    Math.abs(s.km - run.km) <= Math.max(0.3, 0.08 * run.km));
}

function writeReport(list) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const items = list.map(({ run, s }) =>
    `<li><label><input type="checkbox" data-id="${s.id}"> <a href="${API}/activities/${s.id}" target="_blank">${esc(new Date(run.start_ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))} &middot; ${s.km.toFixed(2)} km &middot; ${esc(s.name)}</a></label></li>`).join("\n");
  fs.writeFileSync(REPORT, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runs without maps</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#222;background:#fff}li{margin:6px 0;list-style:none}ul{padding:0}a{color:#0b57d0}input:checked+a{color:#999;text-decoration:line-through}</style></head><body>
<h1>${list.length} run${list.length === 1 ? "" : "s"} on Strava without a map</h1>
<p>Nike has GPS for each of these, so they can be replaced with versions that have a map, pace and heart rate. Strava doesn't let apps delete activities, so: open each link, click the &middot;&middot;&middot; button on Strava and choose <b>Delete</b>, tick the box here, then run <code>node strava-upload.js</code> again. The replacements keep the titles shown here.</p>
<ul>
${items}
</ul>
<script>document.querySelectorAll('input').forEach(c=>{try{c.checked=localStorage.getItem(c.dataset.id)==='1'}catch(e){};c.onchange=()=>{try{localStorage.setItem(c.dataset.id,c.checked?'1':'0')}catch(e){}}});</script>
</body></html>\n`);
}

// ---------- uploading ----------
async function uploadGpx(auth, run, name) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(run.gpx)]), path.basename(run.gpx));
  fd.append("data_type", "gpx");
  fd.append("name", name);
  fd.append("description", DESCRIPTION);
  fd.append("external_id", `nike-${run.nike_id}.gpx`);
  let { status, json } = await strava(auth, "POST", "/uploads", fd);
  if (status >= 400 || !json.id) return { status: "error", error: `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}` };
  const uploadId = json.id_str || json.id;
  for (let i = 0; i < 12; i++) {
    if (json.activity_id) return { status: "ok", activity_id: json.activity_id };
    if (json.error) {
      if (/duplicate/i.test(json.error)) return { status: "duplicate" };
      return { status: "error", error: json.error };
    }
    await sleep(process.env.SHORT_WAIT ? 100 : 4000);
    ({ json } = await strava(auth, "GET", `/uploads/${uploadId}`));
  }
  return { status: "pending", upload_id: uploadId };
}

async function createManual(auth, run, name) {
  const body = new URLSearchParams({
    name, sport_type: "Run", start_date_local: localIso(run.start_ms),
    elapsed_time: String(run.elapsed), distance: String(Math.round(run.km * 1000)),
    description: DESCRIPTION, trainer: run.indoor ? "1" : "0",
  });
  const { status, json } = await strava(auth, "POST", "/activities", body);
  if (status < 300 && json.id) return { status: "ok", activity_id: json.id };
  if (status === 409) return { status: "duplicate" };
  return { status: "error", error: `HTTP ${status} ${JSON.stringify(json).slice(0, 200)}` };
}

async function main() {
  const test = process.argv.includes("--test");
  fs.mkdirSync(WORK, { recursive: true });
  const nike = loadNikeRuns();
  const auth = await getAuth();
  const done = readLog();
  const keepNames = fs.existsSync(NAMES) ? JSON.parse(fs.readFileSync(NAMES, "utf8")) : {};

  console.log("Checking which runs are already on Strava...");
  const onStrava = await stravaRuns(auth);
  const todo = [], mapless = [];
  let already = 0;
  for (const run of nike) {
    if (isFinished(done.get(run.nike_id))) { already++; continue; }
    const s = findMatch(run, onStrava);
    if (s) {
      if (!s.hasMap && run.gpx) { mapless.push({ run, s }); keepNames[run.nike_id] = s.name; }
      else already++;
      continue;
    }
    todo.push(run);
  }
  fs.writeFileSync(NAMES, JSON.stringify(keepNames, null, 1));
  if (mapless.length) writeReport(mapless);

  console.log(`${nike.length} runs in your Nike export, ${already} already on Strava, ${todo.length} to upload.`);
  if (mapless.length) console.log(`${mapless.length} run${mapless.length === 1 ? " is" : "s are"} on Strava without a map but ${mapless.length === 1 ? "has" : "have"} GPS in Nike. See ${path.relative(process.cwd(), REPORT)} if you want to replace them.`);
  console.log("");

  let list = todo;
  if (test) {
    list = todo.filter((r) => r.gpx).slice(0, 1);
    if (!list.length) list = todo.slice(0, 1);
    if (!list.length) return console.log("Nothing left to upload.");
  }

  let ok = 0, dup = 0, err = 0, n = 0;
  for (const run of list) {
    n++;
    const name = keepNames[run.nike_id] || run.name;
    const label = `${localIso(run.start_ms).slice(0, 10)} ${name}`;
    try {
      const r = run.gpx ? await uploadGpx(auth, run, name) : await createManual(auth, run, name);
      writeLog({ nike_id: run.nike_id, kind: run.gpx ? "gpx" : "manual", ...r });
      if (r.status === "ok") ok++; else if (r.status === "duplicate") dup++; else err++;
      const tag = r.status === "ok" ? "uploaded" : r.status === "duplicate" ? "already on Strava" : `${r.status}: ${r.error || ""}`;
      console.log(`  [${n}/${list.length}] ${label} - ${tag}`);
      if (test && r.activity_id) {
        const { json } = await strava(auth, "GET", `/activities/${r.activity_id}`);
        console.log(`\nTest upload: ${API}/activities/${r.activity_id}`);
        console.log(`  type: ${json.sport_type || json.type}, distance: ${((json.distance || 0) / 1000).toFixed(2)} km, start: ${json.start_date_local}, map: ${json.map && json.map.summary_polyline ? "yes" : "no"}`);
        console.log("\nOpen the link to check it. If it looks right, run:  node strava-upload.js");
      }
    } catch (e) {
      if (e instanceof Stop) { console.log(`\n${e.message}`); break; }
      writeLog({ nike_id: run.nike_id, kind: run.gpx ? "gpx" : "manual", status: "error", error: e.message });
      err++; console.log(`  [${n}/${list.length}] ${label} - error: ${e.message}`);
    }
  }
  const left = todo.length - ok - dup;
  console.log(`\nThis session: ${ok} uploaded, ${dup} already on Strava, ${err} problems.`);
  if (test) return;
  console.log(left > 0 ? `${left} still to do. Run the same command again to carry on${err ? " (problem ones are retried)" : ""}.` : "All done. Every run from your Nike export is now on Strava.");
  if (left <= 0) console.log(`When you're finished: revoke the app at strava.com/settings/apps and delete ${path.relative(process.cwd(), AUTH)}.`);
}

main().catch((e) => {
  if (e instanceof Stop) return console.log(`\n${e.message}`);
  console.log(`\nSomething went wrong: ${e.message}\nIf this keeps happening, please open an issue on GitHub with this message.`);
});
