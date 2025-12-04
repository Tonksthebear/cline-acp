#!/usr/bin/env node

/**
 * Cline ACP Agent - Entry point for Zed editor integration
 *
 * Requires a running Cline instance. Start one with: `cline instance new`
 */

// stdout is used to send messages to the client
// we redirect everything else to stderr to make sure it doesn't interfere with ACP
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { runClineAcp } from "./cline-acp.js";
runClineAcp();

// Keep process alive
process.stdin.resume();
