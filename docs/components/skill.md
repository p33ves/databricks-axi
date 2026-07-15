# skill (SKILL.md generation)

Source: `src/skill.ts`. Tests: `test/skill.test.ts`.

Renders the installable `skills/databricks-axi/SKILL.md` from the CLI's own
`DESCRIPTION`/`TOP_HELP` strings, so the published skill file can never drift
from what `databricks-axi --help` actually prints. Regenerated via
`pnpm run build:skill`; never hand-edited (`.no-mistakes.yaml`'s `lint` step
runs `build:skill -- --check` and fails the gate if the committed copy is
stale).

## Exports

- `SKILL_DESCRIPTION` (module-private): the trigger string agent harnesses
  match against to auto-load the skill — the always-resident cost, loaded
  every session by the skill picker (the full per-domain verb list lives in
  the body's `## Commands` block instead, loaded only on activation). One
  line, trimmed to a capability statement plus every implemented domain
  noun (`home, doctor, whoami, jobs, clusters, sql, catalog, pipelines,
serving, workspace, fs, setup, api`) — dropping a noun risks activation
  rate, so trim prose, never nouns. Extended by hand as new domains land,
  not derived from `TOP_HELP`.
- `SKILL_AUTHOR` (module-private): `"Vignesh Perumal (p33ves)"`, written
  into frontmatter.
- `HERMES_TAGS` / `HERMES_CATEGORY` (module-private): extended frontmatter
  fields read by Nous Research's Hermes Agent harness (`category: "data"`,
  topical keyword list). Harnesses that don't know these fields, e.g.
  Claude Code, ignore them. Kept in sync with implemented domains the same
  way `SKILL_DESCRIPTION` is — by hand, not generated. None of these four
  are imported outside this file — only `extractCommandsBlock()` and
  `createSkillMarkdown()` (below) are actually exported.
- `extractCommandsBlock()`: regex-extracts the `commands[N]:\n  ...` block out
  of `TOP_HELP` (from `src/cli.ts`) so the command list embedded in SKILL.md
  is always the literal text `--help` prints, not a hand-copied duplicate.
  Throws if the block isn't found (`TOP_HELP` shape changed without this
  regex being updated).
- `createSkillMarkdown()`: assembles the full file — YAML frontmatter
  (`name`, `description`, `user-invocable: false`, `author`, `metadata.hermes`),
  the `DESCRIPTION` body, npx/PATH invocation guidance, a `## Status` line,
  the extracted `## Commands` block, and a `## Tips` block (follow response
  `help:` next-steps; treat names as literal and backtick-quote special
  characters; pass `--profile` explicitly and never auto-select one; use
  the least-privilege profile/token).

## Sharp edges

- `SKILL_DESCRIPTION` and `HERMES_TAGS` are maintained by hand, not derived
  from `COMMANDS`/`TOP_HELP` — adding a domain means updating both here and
  wiring it into `cli.ts`, or the skill's own trigger text undersells what
  the CLI can do.
- The invocation guidance baked into the rendered file tells agents to prefer
  an already-resolved `databricks-axi` on PATH over `npx -y databricks-axi`
  (a local install may be newer than npm), and to invoke any follow-up
  command from a response's `help:` output the same way they invoked the
  command that produced it.

## Tests

`test/skill.test.ts`: `extractCommandsBlock()` returns a
`commands[N]:`-prefixed block containing known entries (`(none)=home`,
`jobs list`, `jobs logs <run_id>`); every domain key in `COMMANDS` (from
`src/cli.ts`) appears in that block (`home` matched as `(none)=home`); and
`createSkillMarkdown()` starts with the expected frontmatter opening, contains
the `npx -y databricks-axi` guidance, embeds the same commands block
`extractCommandsBlock()` returns standalone, and keeps every `COMMANDS` domain
noun on the frontmatter `description:` line (the trimmed always-resident
trigger string must never drop a noun).
