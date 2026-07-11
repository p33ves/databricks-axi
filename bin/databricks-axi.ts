#!/usr/bin/env node
// Last-resort catch: anything that escapes the SDK's own error handling
// (including cli.ts module-load failures) must still exit with a structured
// error on stdout, never a raw stack trace (AGENTS.md sharp edge).
try {
  const { main } = await import("../src/cli.js");
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let safe: string;
  try {
    // Redact even here — this is the one stdout write outside the taxonomy.
    // If errors.js itself failed to load, print nothing message-shaped.
    const { redactSecrets } = await import("../src/errors.js");
    safe = redactSecrets(message);
  } catch {
    safe = "unexpected startup failure";
  }
  process.stdout.write(`error: ${safe}\ncode: INTERNAL_ERROR\n`);
  process.exitCode = 1;
}
