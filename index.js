const fs = require("fs");
const path = require("path");

const {
  downloadLatestGithubAsset,
  downloadLatestGithubAssetWithMeta,
} = require("./lib/github");
const {
  extractYoutubeVersions,
  pickLatestVersion,
} = require("./lib/versions");

const { downloadApk } = require("./lib/apkmirror");
const { downloadFromUptodown } = require("./lib/uptodown");
const { patchApk } = require("./lib/patcher");
const { uploadApkRelease } = require("./lib/release");
const { isPatchesVersionAlreadyReleased } = require("./lib/state");

(async () => {
  try {
    console.log("🚀 START\n");

    // 1. Download desktop cli
    console.log("🌐 FETCH: morphe-desktop");
    const desktop = await downloadLatestGithubAsset({
      owner: "MorpheApp",
      repo: "morphe-desktop",
      match: (n) => n.includes("desktop") && n.endsWith(".jar"),
    });

    console.log("📦 desktop:", desktop);

    // 2. Download patches (with release metadata: tag + changelog body)
    console.log("🌐 FETCH: morphe-patches");
    const {
      path: patches,
      release: patchesRelease,
    } = await downloadLatestGithubAssetWithMeta({
      owner: "MorpheApp",
      repo: "morphe-patches",
      match: (n) => n.endsWith(".mpp"),
    });

    console.log("📦 PATCHES:", patches);

    const patchesTag = patchesRelease?.tag_name || null;
    const patchesInfo = { tagName: patchesTag, body: patchesRelease?.body || "" };

    console.log("🏷️ Patches version:", patchesTag || "unknown");

    // 2b. Skip early if this exact patches version was already released before
    const alreadyReleased = await isPatchesVersionAlreadyReleased(patchesTag);

    if (alreadyReleased) {
      console.log(
        `\n⏭️ SKIP: patches ${patchesTag} đã được release trước đó (không có gì mới).`
      );
      console.log("──────────────");
      return;
    }

    // 3. Extract versions
    console.log("⬇️ Extract versions (list-versions)...");

    const { execSync } = require("child_process");

    const output = execSync(
      `java -jar "${desktop}" list-versions -f com.google.android.youtube --patches="${patches}"`,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
      }
    );

    const versions = extractYoutubeVersions(output);

    if (!versions.length) {
      throw new Error("No versions found from desktop");
    }

    console.log("📋 ALL VERSIONS:");

    versions.forEach((v) => {
      console.log(" -", v);
    });

    const selectedVersion = pickLatestVersion(versions);

    if (!selectedVersion) {
      throw new Error("Failed to pick latest version");
    }

    console.log("\n➡️ TARGET:", selectedVersion);

    // 4. Download APK
    let apkPath;

    try {
      console.log("🌐 SOURCE: APKMirror");
      apkPath = await downloadApk(selectedVersion);
    } catch (apkMirrorError) {
      console.log("❌ APKMIRROR FAIL:", apkMirrorError.message);

      console.log("🔁 FALLBACK: Uptodown");

      try {
        console.log("🌐 SOURCE: Uptodown");
        apkPath = await downloadFromUptodown(selectedVersion);
      } catch (uptodownError) {
        console.log("❌ UPTODOWN FAIL:", uptodownError.message);
        throw new Error("All sources failed");
      }
    }

    console.log("📦 APK:", apkPath);

    // 5. Patch
    console.log("⬇️ PATCHING...");

    const actualPatched = patchApk(
      desktop,
      patches,
      apkPath
    );

    console.log("📦 PATCHED:", actualPatched);

    if (!fs.existsSync(actualPatched)) {
      throw new Error(
        `Patched APK not found: ${actualPatched}`
      );
    }

    // 6. Rename / Copy
    const dir = process.cwd();

    const finalName = `youtube-${selectedVersion}-morphe.apk`;
    const finalPath = path.join(dir, finalName);

    fs.copyFileSync(actualPatched, finalPath);

    console.log("📝 FINAL:", finalPath);

    // 7. Upload Release
    console.log("🚀 UPLOAD RELEASE...");

    await uploadApkRelease({
      version: selectedVersion,
      apkPath: finalPath,
      patches: patchesInfo,
    });

    // 8. Done
    console.log("\n🎉 DONE");
    console.log("──────────────");

    console.log("➡️ VERSION:", selectedVersion);
    console.log("📦 desktop-cli:", desktop);
    console.log("📦 PATCHES:", patches);
    console.log("📦 ORIGINAL:", apkPath);
    console.log("📦 PATCHED:", actualPatched);
    console.log("📦 OUTPUT:", finalPath);
  } catch (err) {
    console.error("\n❌ ERROR:", err.message);

    if (err.stdout || err.stderr) {
      console.error(
        "STDOUT:",
        err.stdout?.toString() || ""
      );

      console.error(
        "STDERR:",
        err.stderr?.toString() || ""
      );
    }

    process.exit(1);
  }
})();
