const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { toApkMirrorVersion } = require("./versions");

const CACHE_DIR = path.resolve(__dirname, "..", "downloads");

// A cached APK smaller than this is treated as corrupt/truncated.
const MIN_APK_SIZE = 1024 * 1024; // 1 MB

// Canonical cache location for an unpatched YouTube APK of a given version.
// Reusing this file means we only hit APKMirror when the version changes.
function getApkCachePath(version) {
  return path.join(CACHE_DIR, `youtube-${version}-universal.apk`);
}

function isValidApk(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size >= MIN_APK_SIZE;
  } catch {
    return false;
  }
}

// Keep only the APK we are going to reuse; drop cached APKs of older
// versions and stale partial downloads so the cache stays small.
function pruneApkCache(keepPath) {
  if (!fs.existsSync(CACHE_DIR)) return;

  const keep = path.resolve(keepPath);

  for (const name of fs.readdirSync(CACHE_DIR)) {
    const full = path.resolve(CACHE_DIR, name);
    const isApk = name.toLowerCase().endsWith(".apk");
    const isPart = name.toLowerCase().endsWith(".part");

    if ((isApk || isPart) && full !== keep) {
      try {
        fs.unlinkSync(full);
        console.log("🧹 Pruned cached APK:", name);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// Return the cached unpatched APK for `version` if we already have it.
// Checks the canonical name first, then any APK whose name embeds the
// version (covers files saved under their original APKMirror name).
function findCachedApk(version) {
  const canonical = getApkCachePath(version);

  if (isValidApk(canonical)) return canonical;

  if (!fs.existsSync(CACHE_DIR)) return null;

  const prefixes = [
    `youtube-${version}-`,
    `com.google.android.youtube_${version}`,
    `YouTube_${version}`,
  ];

  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.toLowerCase().endsWith(".apk")) continue;
    if (!prefixes.some((p) => name.startsWith(p))) continue;

    const full = path.join(CACHE_DIR, name);
    if (isValidApk(full)) return full;
  }

  return null;
}

async function downloadApk(version) {
  // 1. Reuse a previously downloaded APK when the version is unchanged.
  const cached = findCachedApk(version);

  if (cached) {
    console.log(`⚡ Cache hit: reuse APK ${version}`);
    console.log("📦 CACHED APK:", cached);
    pruneApkCache(cached);
    return cached;
  }

  console.log(`📥 Cache miss: download APK ${version}`);

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36"
  });

  const page = await context.newPage();

  const cachePath = getApkCachePath(version);
  const tempPath = `${cachePath}.part`;

  try {
    const versionSlug = toApkMirrorVersion(version);

    const listUrl = `https://www.apkmirror.com/apk/google-inc/youtube/youtube-${versionSlug}-release/`;

    console.log("🌐 LIST:", listUrl);

    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".table-row");

    const variantUrl = await page.evaluate(() => {
      const rows = document.querySelectorAll(".table-row");
      const target = "universal";

      for (const row of rows) {
        const text = row.innerText.toLowerCase();

        if (!text.includes("apk")) continue;
        if (text.includes("bundle")) continue;
        if (!text.includes(target)) continue;
        if (!text.includes("nodpi")) continue;

        const link = row.querySelector("a.accent_color");
        return link ? link.href : null;
      }

      return null;
    });

    if (!variantUrl) throw new Error("No variant found");

    console.log("➡️ VARIANT:", variantUrl);

    await page.goto(variantUrl, { waitUntil: "domcontentloaded" });

    await page.waitForSelector("a.downloadButton");

    const downloadPromise = page.waitForEvent("download").catch(() => null);

    console.log("⬇️ Clicking main download...");
    await page.click("a.downloadButton");

    let download = await downloadPromise;

    if (!download) {
      console.log("⚠️ Main download failed → fallback link");

      const fallbackUrl = await page.$eval(
        "#download-link",
        (el) => el.href
      );

      console.log("🔁 Fallback URL:", fallbackUrl);

      const page2 = await context.newPage();
      const downloadPromise2 = page2.waitForEvent("download");

      await page2.goto(fallbackUrl, { waitUntil: "domcontentloaded" });

      download = await downloadPromise2;

      await page2.close();
    }

    // Save to a temp file first so an interrupted download never leaves a
    // half-written APK behind under the canonical cache name.
    await download.saveAs(tempPath);

    if (!isValidApk(tempPath)) {
      throw new Error(`Downloaded APK is invalid/too small: ${tempPath}`);
    }

    fs.renameSync(tempPath, cachePath);

    console.log("💾 Cached APK:", cachePath);

    pruneApkCache(cachePath);

    return cachePath;

  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup errors
      }
    }

    console.error("❌ ERROR:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { downloadApk, findCachedApk, getApkCachePath };
