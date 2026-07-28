const fs = require("fs");
const path = require("path");
const { request } = require("./http");

// ================= UTIL =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function jitter(ms) {
  return ms + Math.floor(Math.random() * 300);
}

async function withRetry(fn, retries = 5, baseDelay = 1000) {
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const delay = jitter(baseDelay * Math.pow(2, i));
      console.log(`🔁 Retry ${i + 1}/${retries} in ${delay}ms - ${err.message}`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

// ================= GITHUB API =================
async function fetchLatestRelease(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  return withRetry(async () => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "node",
        "Accept": "application/vnd.github+json"
      }
    });

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status}`);
    }

    return res.json();
  });
}

// ================= DOWNLOAD CORE =================
function downloadFilePro(url, outputPath, expectedSize = null) {
  return new Promise((resolve, reject) => {
    const filePath = path.resolve(outputPath);
    const tempPath = filePath + ".part";

    let downloaded = 0;

    if (fs.existsSync(tempPath)) {
      downloaded = fs.statSync(tempPath).size;
    }

    const headers = {
      "User-Agent": "node",
      "Accept": "*/*"
    };

    if (downloaded > 0) {
      headers["Range"] = `bytes=${downloaded}-`;
      console.log(`↩️ Resume at ${downloaded} bytes`);
    }

    request(url, headers)
      .then(res => {
        const file = fs.createWriteStream(tempPath, {
          flags: downloaded > 0 ? "a" : "w"
        });

        let failed = false;

        res.on("response", r => {
          if (r.statusCode >= 400) {
            failed = true;
            reject(new Error(`HTTP ${r.statusCode}`));
            res.destroy();
          }
        });

        res.on("data", chunk => {
          downloaded += chunk.length;
        });

        res.pipe(file);

        file.on("finish", () => {
          file.close();

          if (failed) return;

          // verify size if provided
          if (expectedSize && downloaded !== expectedSize) {
            fs.unlinkSync(tempPath);
            return reject(
              new Error(`Size mismatch: ${downloaded}/${expectedSize}`)
            );
          }

          fs.renameSync(tempPath, filePath);
          resolve(filePath);
        });

        file.on("error", err => {
          fs.unlinkSync(tempPath);
          reject(err);
        });
      })
      .catch(reject);
  });
}

// ================= MAIN FUNCTION =================
// Returns { path, release } so callers can inspect release.tag_name / release.body
// (needed to embed changelog + detect duplicate/old patch versions).
async function downloadLatestGithubAssetWithMeta({ owner, repo, match }) {
  console.log(`\n📦 Fetch release: ${owner}/${repo}`);

  const release = await fetchLatestRelease(owner, repo);

  if (!release.assets?.length) {
    throw new Error(`Repo ${owner}/${repo} không có assets`);
  }

  const asset = release.assets.find(a => match(a.name));
  if (!asset) throw new Error(`❌ Không tìm thấy asset`);

  console.log("🎯 Selected:", asset.name);

  // cache check + auto cleanup corrupted file
  if (fs.existsSync(asset.name)) {
    const size = fs.statSync(asset.name).size;

    if (size < 1024) {
      console.log("🧹 Corrupt cache removed");
      fs.unlinkSync(asset.name);
    } else {
      console.log("⚡ Skip cached:", asset.name);
      return { path: asset.name, release, asset };
    }
  }

  await withRetry(async () => {
    await downloadFilePro(
      asset.browser_download_url,
      asset.name,
      asset.size
    );
  });

  console.log("✅ Done:", asset.name);
  return { path: asset.name, release, asset };
}

// Backwards-compatible helper: same as before, just returns the file path.
async function downloadLatestGithubAsset(opts) {
  const { path } = await downloadLatestGithubAssetWithMeta(opts);
  return path;
}

module.exports = {
  downloadLatestGithubAsset,
  downloadLatestGithubAssetWithMeta,
  fetchLatestRelease,
};
