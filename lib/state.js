const https = require("https");

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

const MARKER_PREFIX = "<!-- patches-version:";
const MARKER_SUFFIX = "-->";

function request(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

const headers = {
  "User-Agent": "node",
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
};

// Hidden marker embedded in the release body so future runs can detect
// "we already built this exact patches version".
function buildPatchesMarker(patchesTag) {
  return `${MARKER_PREFIX} ${patchesTag} ${MARKER_SUFFIX}`;
}

// Scan existing releases of THIS repo (paginated) looking for the marker
// of `patchesTag`. Returns true if found => patches version is old/duplicate.
async function isPatchesVersionAlreadyReleased(patchesTag, { maxPages = 5 } = {}) {
  if (!patchesTag) return false;

  if (!TOKEN || !REPO) {
    console.log("⚠️ Missing GITHUB_TOKEN/GITHUB_REPOSITORY - bỏ qua kiểm tra patch cũ/mới");
    return false;
  }

  const marker = buildPatchesMarker(patchesTag);

  for (let page = 1; page <= maxPages; page++) {
    const releases = await request({
      hostname: "api.github.com",
      path: `/repos/${REPO}/releases?per_page=30&page=${page}`,
      method: "GET",
      headers,
    });

    if (!Array.isArray(releases) || releases.length === 0) break;

    const found = releases.find((r) => (r.body || "").includes(marker));
    if (found) return true;

    if (releases.length < 30) break; // last page
  }

  return false;
}

module.exports = {
  buildPatchesMarker,
  isPatchesVersionAlreadyReleased,
};
