import { runDatabricks } from "../databricks.js";
import {
  assertObject,
  domainHelpers,
  profileSuffix,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs } = domainHelpers("whoami");

export const WHOAMI_HELP = `usage: databricks-axi whoami [--profile <name>]
Caller's own identity (SCIM Me): user name, display name, active state,
group memberships, and entitlements.
examples:
  databricks-axi whoami
notes:
  read-only — no SCIM admin surface (users/groups/service-principals);
  see the roadmap
`;

type RawGroup = { display?: string; type?: string } & Record<string, unknown>;
type RawEntitlement = { value?: string } & Record<string, unknown>;
type RawMe = {
  userName?: string;
  displayName?: string;
  active?: boolean;
  groups?: RawGroup[];
  entitlements?: RawEntitlement[];
} & Record<string, unknown>;

// Single-object view: no --fields (house convention — the object is ~8
// keys, every useful one already ships in the default). Keys are
// hand-enumerated and renamed to snake_case; SCIM's own id/$ref/emails/
// schemas are dropped as noise the rare caller can still get via
// `api get /api/2.0/preview/scim/v2/Me`.
export async function whoamiCommand(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  if (positional.length > 0) {
    throw usage(`whoami takes no arguments, got: ${positional[0]}`);
  }
  const p = profileSuffix(flags.get("profile"));
  const me = assertObject<RawMe>(
    await runDatabricks(["current-user", "me"], spawnOpts(flags)),
    "databricks current-user me",
  );
  const out: AxiStructuredOutput = { user_name: me.userName };
  if (me.displayName) {
    out.display_name = me.displayName;
  }
  out.active = me.active;
  out.groups = (me.groups ?? []).map((g) => ({
    display: g.display,
    type: g.type,
  }));
  out.entitlements = (me.entitlements ?? [])
    .map((e) => e.value)
    .filter((v): v is string => typeof v === "string");
  out.help = [`databricks-axi home${p}`];
  return out;
}
