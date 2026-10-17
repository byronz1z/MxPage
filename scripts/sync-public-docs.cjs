const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
// Keep one editable AI documentation index; the public copy ships in desktop/web builds.
fs.copyFileSync(path.join(root, "llms.txt"), path.join(root, "public", "llms.txt"));
console.log("Synced llms.txt to the public documentation endpoint.");
