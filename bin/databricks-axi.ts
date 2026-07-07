#!/usr/bin/env node
// Last-resort catch: anything that escapes the SDK's own error handling
// (including cli.ts module-load failures) must still exit with a structured
// error on stdout, never a raw stack trace (AGENTS.md sharp edge).
try {
  const { main } = await import("../src/cli.js");
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`error: ${message}\ncode: INTERNAL_ERROR\n`);
  process.exitCode = 1;
}
