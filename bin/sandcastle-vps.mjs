#!/usr/bin/env node
// The package ships TypeScript and runs it through tsx — the same way the
// Harness container runs the server, so a Target and this CLI are never two
// toolchains. Nothing is built before publishing, and nothing can be stale.
import { register } from "tsx/esm/api";

register();

const { runCli } = await import(new URL("../src/cli/main.ts", import.meta.url).href);
process.exitCode = await runCli(process.argv.slice(2));
