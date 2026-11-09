import { parseArgs } from "node:util";
import { startStdio } from "./index.ts";
const { values } = parseArgs({ options: { config: { type: "string" } }, strict: true });
if (!values.config) throw new Error("--config is required");
startStdio({ configPath: values.config });
