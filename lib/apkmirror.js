const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { toApkMirrorVersion } = require("./versions");

async function downloadApk(version) {
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

    const outDir = path.resolve(__dirname, "..", "downloads");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

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

    const fileName = download.suggestedFilename();
    const filePath = path.join(outDir, fileName);

    await download.saveAs(filePath);

    console.log("📦 DONE:", filePath);

    return filePath;

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { downloadApk };
