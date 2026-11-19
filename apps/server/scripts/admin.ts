type Command =
  | {
      operation: "generate";
      id: string;
      seed: string;
      rulesetVersion: string;
      generatorVersion: string;
      contentVersion: string;
    }
  | { operation: "validate" | "activate" | "end"; id: string }
  | { operation: "publish"; id: string; seed: string; confirm: true }
  | { operation: "reveal"; id: string; seed: string }
  | { operation: "inspect"; id: string };

const usage = `Usage:
  bun run admin:season generate --id ID --seed SECRET --ruleset-version VERSION --generator-version VERSION --content-version VERSION
  bun run admin:season validate --id ID
  bun run admin:season publish --id ID --seed SECRET --confirm
  bun run admin:season activate --id ID
  bun run admin:season end --id ID
  bun run admin:season reveal --id ID --seed SECRET
  bun run admin:season inspect --id ID

Required environment: AGENTFALL_ADMIN_URL and ADMIN_BEARER_TOKEN.`;

export function parseCommand(arguments_: string[]): Command | null {
  const [operation, ...rest] = arguments_;
  if (!operation || operation === "--help" || operation === "help") return null;
  const values = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument?.startsWith("--")) return null;
    const name = argument.slice(2);
    if (name === "confirm") {
      values.set(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) return null;
    values.set(name, value);
    index += 1;
  }
  const id = stringValue(values, "id");
  if (!id) return null;
  switch (operation) {
    case "generate": {
      const seed = stringValue(values, "seed");
      const rulesetVersion = stringValue(values, "ruleset-version");
      const generatorVersion = stringValue(values, "generator-version");
      const contentVersion = stringValue(values, "content-version");
      return seed && rulesetVersion && generatorVersion && contentVersion
        ? { operation, id, seed, rulesetVersion, generatorVersion, contentVersion }
        : null;
    }
    case "publish": {
      const seed = stringValue(values, "seed");
      return seed && values.get("confirm") === true ? { operation, id, seed, confirm: true } : null;
    }
    case "reveal": {
      const seed = stringValue(values, "seed");
      return seed ? { operation, id, seed } : null;
    }
    case "validate":
    case "activate":
    case "end":
    case "inspect":
      return { operation, id };
    default:
      return null;
  }
}

async function main() {
  const command = parseCommand(Bun.argv.slice(2));
  const baseUrl = Bun.env.AGENTFALL_ADMIN_URL;
  const token = Bun.env.ADMIN_BEARER_TOKEN;
  if (!command || !baseUrl || !token) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const request = requestFor(command);
  const response = await fetch(new URL(request.path, baseUrl), {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.body ? { "content-type": "application/json" } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok) process.exitCode = 1;
}

function requestFor(command: Command) {
  const path = `/v1/admin/seasons/${encodeURIComponent(command.id)}`;
  switch (command.operation) {
    case "generate":
      return { method: "POST", path: "/v1/admin/seasons", body: command };
    case "inspect":
      return { method: "GET", path };
    case "validate":
    case "activate":
    case "end":
      return { method: "POST", path: `${path}/${command.operation}` };
    case "publish":
    case "reveal":
      return { method: "POST", path: `${path}/${command.operation}`, body: command };
  }
}

function stringValue(values: Map<string, string | true>, name: string): string | null {
  const value = values.get(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

if (import.meta.main) await main();
