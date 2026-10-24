const fs = require("node:fs");

const path = process.argv[2];
if (!path) throw new Error("Pass the wasm-bindgen web JavaScript path");

const source = fs.readFileSync(path, "utf8");
const target = "new URL('halochat_e2ee_core_bg.wasm', import.meta.url)";
if (!source.includes(target)) throw new Error("Expected wasm-bindgen asset URL was not found");
fs.writeFileSync(path, source.replace(target, "'halochat_e2ee_core_bg.wasm'"));
