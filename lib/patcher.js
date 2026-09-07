const { spawn } = require("child_process");
const fs = require("fs");

function patchApk(desktop, patches, apk) {
  console.log("\n🛠️ Patching APK...\n");

  return new Promise((resolve, reject) => {
    const child = spawn("java", [
      "-jar",
      desktop,
      "patch",
      "--patches",
      patches,
      apk,
    ]);

    let output = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start java: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Patch failed with exit code ${code}`));
        return;
      }

      const match = output.match(
        /INFO:\s+Saved to\s+([^\r\n]+\.apk)/i
      );

      if (!match) {
        reject(
          new Error(
            `Cannot find patched APK path in output:\n${output}`
          )
        );
        return;
      }

      const patchedApk = match[1].trim();

      if (!fs.existsSync(patchedApk)) {
        reject(
          new Error(
            `Patched APK does not exist:\n${patchedApk}`
          )
        );
        return;
      }

      console.log("\n✅ Patch done");
      console.log("📦 Output:", patchedApk);

      resolve(patchedApk);
    });
  });
}

module.exports = { patchApk };
