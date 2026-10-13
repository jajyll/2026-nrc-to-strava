#!/usr/bin/env node
// nike-download.js
// Downloads your Nike Run Club history using the access_token from nike.com.
// Based on alexpryshchepa/nrc2strava and mxdc/nrc2strava (Nike's current endpoints), rewritten to:
//   - use the access_token directly (Nike's new login no longer works with the old refresh step)
//   - need no npm install (uses only what comes with Node.js 18+)
//   - download one run at a time, with retries, and pick up where it left off if stopped
//   - keep a full backup of every activity, plus a summary of all runs
// It only talks to api.nike.com. It never uploads anything anywhere.
//
// Run:  node nike-download.js        (needs Node.js 18 or later)
// Output: a folder called "nike-export" next to this file:
//   gpx/          one .gpx file per run that has GPS (these are what Strava imports)
//   raw/          Nike's full data for every activity (your backup, keep it)
//   summary.csv   one line per activity, including runs without GPS
//   failed.txt    any activities that could not be downloaded

"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API = process.env.NIKE_API_BASE || "https://api.nike.com";
const OUT = path.join(__dirname, "nike-export");
const RAW = path.join(OUT, "raw");
const GPX = path.join(OUT, "gpx");
const PAUSE_MS = 250; // gap between requests, to stay polite to Nike's servers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

class TokenExpired extends Error {}

async function nikeGet(url, token) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (e) {
      if (attempt === 5) throw new Error(`network error: ${e.message}`);
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403) {
      const body = (await res.text()).slice(0, 300);
      throw new TokenExpired(`Nike refused the token (HTTP ${res.status}). ${body}`);
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 5000 * attempt;
      console.log(`  Nike asked us to slow down (HTTP ${res.status}), waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
      continue;
    }
    const body = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  throw new Error("gave up after 5 attempts");
}

// Nike's current activity list (same endpoint as mxdc/nrc2strava, Aug 2026)
async function listActivities(token) {
  const all = [];
  const ids = new Set();
  let before = "*";
  const seen = new Set();
  while (before && !seen.has(before)) {
    seen.add(before);
    const url = `${API}/plus/v3/activities/before_id/v3/${encodeURIComponent(before)}?limit=30&types=run%2Cjogging&include_deleted=false`;
    const data = await nikeGet(url, token);
    for (const a of data.activities || []) {
      if (a && a.id && !ids.has(a.id)) { ids.add(a.id); all.push(a); }
    }
    console.log(`  found ${all.length} activities so far...`);
    before = data.paging && data.paging.before_id;
    await sleep(PAUSE_MS);
  }
  return all;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "");
const stamp = (ms) => iso(ms).slice(0, 16).replace("T", "_").replace(":", ""); // 2024-05-01_0712
const metric = (a, type) => ((a.metrics || []).find((m) => m.type === type) || {}).values || [];
const hasGps = (a) => (a.metric_types || []).includes("latitude") && (a.metric_types || []).includes("longitude");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// value from `series` closest in time to `t` (series sorted by time)
function nearest(series, t, state) {
  if (!series.length) return undefined;
  while (state.i < series.length - 1 && Math.abs(series[state.i + 1].start_epoch_ms - t) <= Math.abs(series[state.i].start_epoch_ms - t)) state.i++;
  return series[state.i].value;
}

function toGpx(a) {
  const lats = metric(a, "latitude");
  const lons = metric(a, "longitude");
  const elev = metric(a, "elevation");
  const hr = metric(a, "heart_rate");
  const name = (a.tags && a.tags["com.nike.name"]) || `${new Date(a.start_epoch_ms).toLocaleDateString("en-GB", { weekday: "long" })} Run`;
  const es = { i: 0 }, hs = { i: 0 };
  const pts = [];
  const n = Math.min(lats.length, lons.length);
  for (let k = 0; k < n; k++) {
    const t = lats[k].start_epoch_ms;
    const lat = lats[k].value, lon = lons[k].value;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const e = nearest(elev, t, es);
    const h = nearest(hr, t, hs);
    let p = `      <trkpt lat="${lat}" lon="${lon}">`;
    if (typeof e === "number") p += `<ele>${e}</ele>`;
    p += `<time>${iso(t)}</time>`;
    if (typeof h === "number") p += `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${Math.round(h)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`;
    pts.push(p + `</trkpt>`);
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="nike-download" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">`,
    `  <metadata><name>${esc(name)}</name><time>${iso(a.start_epoch_ms)}</time></metadata>`,
    `  <trk><name>${esc(name)}</name><type>running</type><trkseg>`,
    ...pts,
    `  </trkseg></trk>`,
    `</gpx>`,
    ``,
  ].join("\n");
}

function summaryRow(a, gpxFile) {
  const dist = (a.summaries || []).find((s) => s.metric === "distance" && s.summary === "total");
  const cells = [
    a.id,
    iso(a.start_epoch_ms),
    a.end_epoch_ms ? iso(a.end_epoch_ms) : "",
    a.active_duration_ms ? (a.active_duration_ms / 60000).toFixed(1) : "",
    dist ? Number(dist.value).toFixed(2) : "",
    (a.tags && a.tags["com.nike.name"]) || "",
    a.type || "",
    hasGps(a) ? "yes" : "no",
    gpxFile || "",
    a.app_id || "",
    a.deleted ? "yes" : "",
  ];
  return cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
}

async function main() {
  console.log("Nike Run Club download\n");
  let token = process.env.NIKE_ACCESS_TOKEN || (await ask("Paste your Nike access_token and press Enter:\n> "));
  token = token.replace(/^"|"$/g, "");
  if (token.length < 20) return console.log("That doesn't look like a token. Copy the access_token value again and re-run.");

  [OUT, RAW, GPX].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  console.log("\nStep 1 of 2: listing your activities");
  const list = await listActivities(token);
  console.log(`  ${list.length} activities in your Nike account.\n`);

  console.log("Step 2 of 2: downloading each activity (already-downloaded ones are skipped)");
  const failed = [];
  let done = 0;
  for (const item of list) {
    done++;
    const rawFile = path.join(RAW, `${item.id}.json`);
    if (fs.existsSync(rawFile)) continue;
    try {
      const full = await nikeGet(`${API}/sport/v3/me/activity/${item.id}?metrics=ALL`, token);
      fs.writeFileSync(rawFile, JSON.stringify(full));
      if (done % 25 === 0 || done === list.length) console.log(`  ${done} of ${list.length}`);
    } catch (e) {
      if (e instanceof TokenExpired) {
        console.log(`\n${e.message}\nYour token has probably expired. Copy a fresh access_token from nike.com and run this again. It will carry on from activity ${done}.`);
        return;
      }
      failed.push(`${item.id}  ${iso(item.start_epoch_ms)}  ${e.message}`);
      console.log(`  could not download ${item.id}: ${e.message}`);
    }
    await sleep(PAUSE_MS);
  }

  // Build GPX files and summary from everything downloaded (including earlier runs of this script)
  const rows = [`"id","start_utc","end_utc","active_minutes","distance_km","name","type","has_gps","gpx_file","app_id","deleted"`];
  let gpxCount = 0;
  for (const item of list) {
    const rawFile = path.join(RAW, `${item.id}.json`);
    const a = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, "utf8")) : item;
    let gpxFile = "";
    if (a.type === "run" && hasGps(a) && Number.isFinite(a.start_epoch_ms) && metric(a, "latitude").length > 1) {
      gpxFile = `${stamp(a.start_epoch_ms)}_${String(a.id).slice(0, 8)}.gpx`;
      fs.writeFileSync(path.join(GPX, gpxFile), toGpx(a));
      gpxCount++;
    }
    rows.push(summaryRow(a, gpxFile));
  }
  fs.writeFileSync(path.join(OUT, "summary.csv"), rows.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "failed.txt"), failed.join("\n") + (failed.length ? "\n" : ""));

  console.log(`\nDone.`);
  console.log(`  Activities in Nike account: ${list.length}`);
  console.log(`  GPX files created (runs with GPS): ${gpxCount}`);
  console.log(`  Could not download: ${failed.length}${failed.length ? " (see failed.txt, re-run to retry)" : ""}`);
  console.log(`\nEverything is in: ${OUT}`);
}

main().catch((e) => {
  if (e instanceof TokenExpired) {
    console.log(`\n${e.message}\nNike didn't accept the token. Copy the access_token value again from nike.com (make sure you're logged in) and re-run.`);
    return;
  }
  console.log(`\nSomething went wrong: ${e.message}`);
  console.log("If this keeps happening, please open an issue on GitHub with this message.");
});
