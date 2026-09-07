const fs = require("fs");
const path = require("path");
const https = require("https");
const { chromium } = require("playwright");

const BASE = "https://youtube.en.uptodown.com/android";

function fetch(url, headers = {}, isBinary = false) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
          ...headers,
        },
      },
      (res) => {
        let data = [];
        res.on("data", (c) => data.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(data);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: isBinary ? buffer : buffer.toString(),
          });
        });
      }
    ).on("error", reject);
  });
}

async function downloadFromUptodown(version) {
  try {
    console.log("🌐 BASE:", BASE);
    console.log("🔎 VERSION:", version);

    // 1. Find appCode
    console.log("⬇️ Fetch versions page...");
    const html = (await fetch(`${BASE}/versions`)).body;

    const codeMatch = html.match(
      /id="detail-app-name"[^>]*data-code="(\d+)"/
    );
    if (!codeMatch) throw new Error("No appCode found");

    const appCode = codeMatch[1];
    console.log("🧩 APP CODE:", appCode);

    // 2. Find versionId
    let pageNum = 1;
    let versionId = null;

    while (pageNum < 10) {
      const apiUrl = `${BASE}/apps/${appCode}/versions/${pageNum}`;
      console.log("🌐 PAGE:", apiUrl);

      const res = await fetch(apiUrl);
      const json = JSON.parse(res.body);

      if (!json.data || json.data.length === 0) break;

      const target = json.data.find(
        (item) =>
          item.version === version && item.kindFile === "apk"
      );

      if (target) {
        versionId = target.versionURL.versionID;
        break;
      }

      pageNum++;
    }

    if (!versionId) throw new Error("No version found");

    console.log("➡️ VERSION ID:", versionId);

    // 3. Use Playwright to download (Turnstile-based flow)
    const pageUrl = `${BASE}/download/${versionId}`;
    console.log("🌐 DOWNLOAD PAGE:", pageUrl);

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
    });

    const page = await context.newPage();

    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

      // Wait for download button
      await page.waitForSelector("#detail-download-button", {
        timeout: 15000,
      });

      const outDir = path.resolve(__dirname, "..", "downloads");
      if (!fs.existsSync(outDir))
        fs.mkdirSync(outDir, { recursive: true });

      const downloadPromise = page.waitForEvent("download", {
        timeout: 60000,
      }).catch(() => null);

      console.log("⬇️ Clicking download...");
      await page.click("#detail-download-button");

      let download = await downloadPromise;

      if (!download) {
        throw new Error("No download event triggered");
      }

      const fileName = download.suggestedFilename();
      const filePath = path.join(outDir, fileName);

      await download.saveAs(filePath);

      console.log("📦 DONE:", filePath);
      return filePath;
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    throw err;
  }
}

module.exports = { downloadFromUptodown };
