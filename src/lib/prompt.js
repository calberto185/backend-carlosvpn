// Lee un secreto sin mostrarlo en pantalla ni dejarlo en el historial del shell.
// Con terminal: pide el valor sin eco. Sin terminal (tubería): lee todo stdin.
function readSecret(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (buf += c));
      stdin.on("end", () => resolve(buf.trim()));
      stdin.on("error", reject);
      return;
    }
    process.stderr.write(question);
    let val = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\u0003") { stdin.setRawMode(false); process.stderr.write("\n"); process.exit(130); }
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(val.trim());
        }
        if (c === "\u007f" || c === "\b") val = val.slice(0, -1);
        else val += c;
      }
    };
    stdin.on("data", onData);
  });
}
module.exports = { readSecret };
