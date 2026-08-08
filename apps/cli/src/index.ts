#!/usr/bin/env bun
import { consoleWriter } from "./output.ts";
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), consoleWriter);
