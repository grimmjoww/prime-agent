import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
setInterval(() => {}, 1000);
