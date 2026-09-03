import { rmSync } from "node:fs";

const generatedDevVars = new URL("../dist/server/.dev.vars", import.meta.url);

rmSync(generatedDevVars, { force: true });
