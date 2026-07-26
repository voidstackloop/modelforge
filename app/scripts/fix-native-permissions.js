#!/usr/bin/env node
// node-pty ships a `spawn-helper` executable in its darwin/linux prebuilds —
// used to fork+exec pty child processes (macOS specifically needs a separate
// exec'd helper rather than a plain fork, since forking a process that has
// loaded Objective-C runtime frameworks is unsafe). Some npm install/tar
// extraction paths don't preserve the executable bit on packed binaries,
// which makes node-pty fail with "posix_spawnp failed" the moment a terminal
// is created — reproduced on a plain `npm ci` in this repo's own CI. This is
// a no-op if the permission is already correct.
const fs = require("fs");
const path = require("path");

const prebuildsDir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");
if (fs.existsSync(prebuildsDir)) {
    for (const platformDir of fs.readdirSync(prebuildsDir)) {
        const helperPath = path.join(prebuildsDir, platformDir, "spawn-helper");
        if (fs.existsSync(helperPath)) {
            fs.chmodSync(helperPath, 0o755);
            console.log(`[fix-native-permissions] chmod +x ${path.relative(process.cwd(), helperPath)}`);
        }
    }
}
