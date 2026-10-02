// Production hardening after `react-scripts build`: do not ship the developer-only chat test harness
// (it talks to localhost and is not part of the product) and make sure no source maps are published.
import fs from "node:fs";
import path from "node:path";
const build = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "build");
for (const f of ["chat-demo.html", "chat-demo.js", "socket.io.min.js"]) fs.rmSync(path.join(build, f), { force: true });
let maps = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".map")) (fs.rmSync(p), maps++);
  }
})(build);
console.log(`postbuild: removed chat-demo harness, ${maps} source map(s)`);
