#!/usr/bin/env node
import { collectLive } from "./adapters.js";
import { interpretRequest } from "./agent.js";
import { analyze } from "./engine.js";

const target = process.argv[2];
if (!target) { console.error("Usage: pharos-risk <address> [send|approve|interact] [question]"); process.exit(2); }
const action = process.argv[3];
const question = process.argv.slice(4).join(" ");
const agent = interpretRequest({ action, question });
const snapshot = await collectLive(target);
console.log(JSON.stringify({ agent, snapshot, analysis: analyze(snapshot, { action: agent.action, question }) }, null, 2));
