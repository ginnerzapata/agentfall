import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { adminAuthorized } from "../admin";
import { type AuthConfiguration, AuthError, AuthenticationService } from "../auth";
import { createAgentfallMcpHandler, D1McpGameplay } from "../mcp";
import { D1Seasons } from "../persistence";
import { D1RateLimiter, type RateLimitScope } from "../rate-limit";
import { failure } from "./errors";

type AuthBindings = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AGENTFALL_ORIGIN?: string;
  AUTH_STATE_SECRET?: string;
  CREDENTIAL_HASH_PEPPER?: string;
  ADMIN_BEARER_TOKEN?: string;
};
type ServerEnv = { Bindings: Env & AuthBindings };
const MAX_REQUEST_BYTES = 16 * 1024;

export function createHttpApp() {
  const app = new Hono<ServerEnv>();
  app.use("*", requestId());
  app.use("*", secureHeaders());
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (context) => failure(context, 413, "REQUEST_TOO_LARGE"),
    }),
  );
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (context) => failure(context, 413, "REQUEST_TOO_LARGE"),
    }),
  );
  app.use("/v1/*", async (context, next) => {
    const scope: RateLimitScope =
      context.req.method === "GET" ? "request" : "active-floor-mutation";
    const identity = context.req.header("cf-connecting-ip") ?? "anonymous";
    const allowed = await new D1RateLimiter(context.env.DB).allow(scope, identity, Date.now());
    if (!allowed) return failure(context, 429, "RATE_LIMITED");
    await next();
  });
  app.use("/mcp", async (context, next) => {
    const scope = await mcpRateLimitScope(context.req.raw);
    const identity = context.req.header("cf-connecting-ip") ?? "anonymous";
    const allowed = await new D1RateLimiter(context.env.DB).allow(scope, identity, Date.now());
    if (!allowed) return failure(context, 429, "RATE_LIMITED");
    await next();
  });

  app.get("/health", async (context) => {
    await context.env.DB.prepare("SELECT 1").first();
    return context.json({ status: "ok" });
  });
  app.get("/version", (context) =>
    context.json({ service: "agentfall", version: context.env.RELEASE_VERSION }),
  );
  app.get("/auth", async (context) => {
    context.header("cache-control", "no-store");
    if (await authenticatedAccount(context)) return context.html(credentialPortalPage());
    return context.html(loginPage(authConfigured(context.env)));
  });
  app.get("/auth/github", async (context) => {
    const auth = authentication(context);
    if (!auth) return failure(context, 503, "AUTH_UNAVAILABLE");
    const nonce = crypto.randomUUID();
    const url = await auth.githubAuthorizationUrl(nonce);
    context.header("cache-control", "no-store");
    context.header(
      "set-cookie",
      cookie("agentfall_oauth_nonce", nonce, 600, secureOrigin(context.env)),
    );
    return context.redirect(url, 302);
  });
  app.get("/auth/callback", async (context) => {
    const auth = authentication(context);
    const code = context.req.query("code");
    const state = context.req.query("state");
    const nonce = readCookie(context.req.header("cookie"), "agentfall_oauth_nonce");
    if (!auth || !code || !state || !nonce)
      return failure(context, 401, auth ? "AUTH_REQUIRED" : "AUTH_UNAVAILABLE");
    try {
      const result = await auth.authenticateGithubCallback({ code, state, nonce });
      const secure = secureOrigin(context.env);
      context.header("cache-control", "no-store");
      context.header(
        "set-cookie",
        cookie("agentfall_session", result.session, 8 * 60 * 60, secure),
      );
      context.header("set-cookie", expiredCookie("agentfall_oauth_nonce", secure), {
        append: true,
      });
      return context.redirect("/auth", 302);
    } catch (error) {
      return failure(context, 401, error instanceof AuthError ? "AUTH_REQUIRED" : "INTERNAL");
    }
  });
  app.all("/mcp", (context) =>
    createAgentfallMcpHandler(
      new D1McpGameplay(
        context.env.DB,
        context.req.header("authorization"),
        context.env.CREDENTIAL_HASH_PEPPER ?? "",
      ),
    ).fetch(context.req.raw),
  );

  app.get("/v1/credentials", async (context) => {
    const session = await authenticatedAccount(context);
    if (!session) return failure(context, 401, "AUTH_REQUIRED");
    context.header("cache-control", "no-store");
    return context.json({ credentials: await session.auth.listCredentials(session.accountId) });
  });
  app.post("/v1/credentials", async (context) => {
    const session = await authenticatedAccount(context);
    if (!session) return failure(context, 401, "AUTH_REQUIRED");
    const input = await jsonObject(context);
    if (!input || !optionalString(input.label) || !optionalString(input.expiresAt))
      return failure(context, 400, "BAD_REQUEST");
    try {
      const issued = await session.auth.createCredential(session.accountId, {
        label: input.label,
        expiresAt: input.expiresAt,
      });
      context.header("cache-control", "no-store");
      return context.json(issued, 201);
    } catch {
      return failure(context, 400, "BAD_REQUEST");
    }
  });
  app.post("/v1/credentials/:credentialId/revoke", async (context) => {
    const session = await authenticatedAccount(context);
    if (!session) return failure(context, 401, "AUTH_REQUIRED");
    const revoked = await session.auth.revokeCredential(
      session.accountId,
      context.req.param("credentialId"),
    );
    return revoked ? context.body(null, 204) : failure(context, 404, "NOT_FOUND");
  });
  app.post("/v1/credentials/:credentialId/rotate", async (context) => {
    const session = await authenticatedAccount(context);
    if (!session) return failure(context, 401, "AUTH_REQUIRED");
    const input = await jsonObject(context);
    if (!input || !optionalString(input.label) || !optionalString(input.expiresAt))
      return failure(context, 400, "BAD_REQUEST");
    try {
      const issued = await session.auth.rotateCredential(
        session.accountId,
        context.req.param("credentialId"),
        { label: input.label, expiresAt: input.expiresAt },
      );
      if (!issued) return failure(context, 404, "NOT_FOUND");
      context.header("cache-control", "no-store");
      return context.json(issued, 201);
    } catch {
      return failure(context, 400, "BAD_REQUEST");
    }
  });
  app.post("/v1/ranked-enrollment", async (context) => {
    const session = await authenticatedAccount(context);
    if (!session) return failure(context, 401, "AUTH_REQUIRED");
    const input = await jsonObject(context);
    if (!input || typeof input.displayName !== "string")
      return failure(context, 400, "BAD_REQUEST");
    try {
      context.header("cache-control", "no-store");
      return context.json(
        await session.auth.enrollRanked(session.accountId, input.displayName),
        201,
      );
    } catch (error) {
      const code = error instanceof AuthError ? error.code : "INTERNAL";
      return failure(
        context,
        code === "INVALID_DISPLAY_NAME"
          ? 400
          : code === "DISPLAY_NAME_TAKEN" || code === "ALREADY_ENROLLED"
            ? 409
            : 500,
        code === "INVALID_DISPLAY_NAME"
          ? "INVALID_DISPLAY_NAME"
          : code === "DISPLAY_NAME_TAKEN"
            ? "DISPLAY_NAME_TAKEN"
            : code === "ALREADY_ENROLLED"
              ? "ALREADY_ENROLLED"
              : "INTERNAL",
      );
    }
  });

  app.post("/v1/admin/seasons", async (context) => {
    if (!(await administrator(context))) return failure(context, 401, "AUTH_REQUIRED");
    const input = await jsonObject(context);
    if (
      !input ||
      !requiredString(input.id) ||
      !requiredString(input.seed) ||
      !requiredString(input.rulesetVersion) ||
      !requiredString(input.generatorVersion) ||
      !requiredString(input.contentVersion)
    )
      return failure(context, 400, "BAD_REQUEST");
    const seasons = new D1Seasons(context.env.DB);
    const now = new Date().toISOString();
    const created = await seasons.createDraft({
      id: input.id,
      rulesetVersion: input.rulesetVersion,
      generatorVersion: input.generatorVersion,
      contentVersion: input.contentVersion,
      now,
    });
    if (!created) return failure(context, 409, "INVALID_SEASON_TRANSITION");
    const generated = await seasons.generateTower({ id: input.id, seed: input.seed, now });
    if (!generated.accepted) return failure(context, 422, "INVALID_SEASON_TRANSITION");
    return context.json(await seasons.inspect(input.id), 201);
  });
  app.get("/v1/admin/seasons/:seasonId", async (context) => {
    if (!(await administrator(context))) return failure(context, 401, "AUTH_REQUIRED");
    const season = await new D1Seasons(context.env.DB).inspect(context.req.param("seasonId"));
    return season ? context.json(season) : failure(context, 404, "NOT_FOUND");
  });
  app.post("/v1/admin/seasons/:seasonId/validate", (context) =>
    advanceSeason(context, "validated"),
  );
  app.post("/v1/admin/seasons/:seasonId/activate", (context) => advanceSeason(context, "active"));
  app.post("/v1/admin/seasons/:seasonId/end", (context) => advanceSeason(context, "ended"));
  app.post("/v1/admin/seasons/:seasonId/publish", (context) =>
    advanceSeason(context, "published", true),
  );
  app.post("/v1/admin/seasons/:seasonId/reveal", (context) =>
    advanceSeason(context, "revealed", false),
  );

  app.notFound((context) => failure(context, 404, "NOT_FOUND"));
  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        event: "http_error",
        requestId: context.get("requestId"),
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    return failure(context, 500, "INTERNAL");
  });
  return app;
}

function authentication(context: { env: Env & AuthBindings }) {
  const configuration = authConfiguration(context.env);
  return configuration ? new AuthenticationService(context.env.DB, configuration) : null;
}
async function authenticatedAccount(context: Context<ServerEnv>) {
  const auth = authentication(context);
  const token = readCookie(context.req.header("cookie"), "agentfall_session");
  const accountId = auth && token ? await auth.accountFromSession(token) : null;
  return auth && accountId ? { auth, accountId } : null;
}
async function administrator(context: Context<ServerEnv>) {
  return adminAuthorized(context.req.header("authorization"), context.env.ADMIN_BEARER_TOKEN);
}
function authConfiguration(env: AuthBindings): AuthConfiguration | null {
  const {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    AGENTFALL_ORIGIN,
    AUTH_STATE_SECRET,
    CREDENTIAL_HASH_PEPPER,
  } = env;
  return GITHUB_CLIENT_ID &&
    GITHUB_CLIENT_SECRET &&
    AGENTFALL_ORIGIN &&
    AUTH_STATE_SECRET &&
    CREDENTIAL_HASH_PEPPER
    ? {
        githubClientId: GITHUB_CLIENT_ID,
        githubClientSecret: GITHUB_CLIENT_SECRET,
        origin: AGENTFALL_ORIGIN,
        stateSecret: AUTH_STATE_SECRET,
        credentialHashPepper: CREDENTIAL_HASH_PEPPER,
      }
    : null;
}
function authConfigured(env: AuthBindings) {
  return authConfiguration(env) !== null;
}
function readCookie(header: string | undefined, name: string) {
  return header
    ?.split(/;\s*/)
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function secureOrigin(env: AuthBindings) {
  return Boolean(env.AGENTFALL_ORIGIN?.startsWith("https://"));
}
function cookie(name: string, value: string, seconds: number, secure: boolean) {
  return `${name}=${value}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${seconds}`;
}
function expiredCookie(name: string, secure: boolean) {
  return `${name}=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=0`;
}
async function jsonObject(context: { req: { json(): Promise<unknown> } }) {
  try {
    const value = await context.req.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= 100);
}
function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

async function advanceSeason(
  context: Context<ServerEnv>,
  to: "validated" | "published" | "active" | "ended" | "revealed",
  needsConfirmation = false,
) {
  if (!(await administrator(context))) return failure(context, 401, "AUTH_REQUIRED");
  let input: Record<string, unknown> | null = null;
  if (to === "published" || to === "revealed") {
    input = await jsonObject(context);
    if (!input || !requiredString(input.seed)) return failure(context, 400, "BAD_REQUEST");
  }
  if (needsConfirmation && input?.confirm !== true) return failure(context, 400, "BAD_REQUEST");
  const result = await new D1Seasons(context.env.DB).advance({
    id: context.req.param("seasonId"),
    to,
    now: new Date().toISOString(),
    ...(input && requiredString(input.seed) ? { seed: input.seed } : {}),
  });
  return result.accepted
    ? context.json(result)
    : failure(context, result.reason === "not-found" ? 404 : 409, "INVALID_SEASON_TRANSITION");
}
const ACTIVE_FLOOR_MCP_MUTATIONS = new Set(["floor_action", "floor_abandon", "floor_end"]);
async function mcpRateLimitScope(request: Request): Promise<RateLimitScope> {
  if (request.method !== "POST") return "request";
  try {
    const payload = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    if (
      payload?.method === "tools/call" &&
      typeof payload.params?.name === "string" &&
      ACTIVE_FLOOR_MCP_MUTATIONS.has(payload.params.name)
    )
      return "active-floor-mutation";
  } catch {
    return "request";
  }
  return "request";
}

function loginPage(configured: boolean) {
  return `<!doctype html><title>Agentfall sign in</title><main><h1>Agentfall</h1>${configured ? '<a href="/auth/github">Continue with GitHub</a>' : "<p>Authentication is not configured for this environment.</p>"}</main>`;
}
function credentialPortalPage() {
  return `<!doctype html>
<title>Agentfall credentials</title>
<main style="font-family:system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.5">
  <h1>Agentfall Account &amp; Credentials</h1>
  <p>Credentials are shown only once when created or rotated. Store your bearer token in a secret environment variable (<code>AGENTFALL_TOKEN</code>), never in prompts or git.</p>

  <section>
    <h2>1. Ranked Enrollment (Optional)</h2>
    <form id="enroll-form">
      <input id="display-name" name="displayName" placeholder="Display name (3-24 chars)" minlength="3" maxlength="24" required />
      <button type="submit">Enroll for Ranked</button>
    </form>
    <p id="enroll-status"></p>
  </section>

  <section>
    <h2>2. Create MCP Bearer Credential</h2>
    <form id="create-form">
      <input id="cred-label" name="label" placeholder="Label (e.g. codex-local)" maxlength="100" />
      <button type="submit">Create Credential</button>
    </form>
    <pre id="new-token" style="background:#111;color:#0f0;padding:0.75rem;display:none;overflow:auto"></pre>
  </section>

  <section>
    <h2>3. Active &amp; Historical Credentials</h2>
    <ul id="cred-list"></ul>
  </section>
</main>
<script>
const enrollForm = document.getElementById("enroll-form");
const enrollStatus = document.getElementById("enroll-status");
const createForm = document.getElementById("create-form");
const newToken = document.getElementById("new-token");
const credList = document.getElementById("cred-list");

async function loadCredentials() {
  const res = await fetch("/v1/credentials");
  if (!res.ok) return;
  const data = await res.json();
  credList.replaceChildren();
  for (const c of data.credentials) {
    const li = document.createElement("li");
    const status = c.revokedAt ? "revoked" : "active";
    li.textContent = (c.label || "unlabeled") + " (" + status + ", created " + c.createdAt + ") ";
    if (!c.revokedAt) {
      const rotateBtn = document.createElement("button");
      rotateBtn.textContent = "Rotate";
      rotateBtn.onclick = async () => {
        const r = await fetch("/v1/credentials/" + encodeURIComponent(c.id) + "/rotate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: c.label || undefined }),
        });
        const body = await r.json();
        if (r.ok) showToken(body.token);
        await loadCredentials();
      };
      const revokeBtn = document.createElement("button");
      revokeBtn.textContent = "Revoke";
      revokeBtn.onclick = async () => {
        await fetch("/v1/credentials/" + encodeURIComponent(c.id) + "/revoke", { method: "POST" });
        await loadCredentials();
      };
      li.append(rotateBtn, " ", revokeBtn);
    }
    credList.append(li);
  }
}

function showToken(token) {
  newToken.style.display = "block";
  newToken.textContent = "export AGENTFALL_TOKEN=" + JSON.stringify(token);
}

enrollForm.onsubmit = async (event) => {
  event.preventDefault();
  const displayName = document.getElementById("display-name").value;
  const res = await fetch("/v1/ranked-enrollment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const body = await res.json();
  enrollStatus.textContent = res.ok ? "Enrolled as " + body.displayName : "Error: " + (body.error?.code || res.status);
};

createForm.onsubmit = async (event) => {
  event.preventDefault();
  const label = document.getElementById("cred-label").value.trim();
  const res = await fetch("/v1/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(label ? { label } : {}),
  });
  const body = await res.json();
  if (res.ok) showToken(body.token);
  await loadCredentials();
};

loadCredentials();
</script>`;
}
