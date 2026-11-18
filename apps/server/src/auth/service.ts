import type { D1Database } from "../persistence";

export type AuthConfiguration = {
  githubClientId: string;
  githubClientSecret: string;
  origin: string;
  stateSecret: string;
  credentialHashPepper: string;
};

type AccountRow = { id: string };
type CredentialRow = {
  id: string;
  label: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

const credentialPrefix = "af_";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

/** Identity and credential boundary. GitHub access tokens never leave this service. */
export class AuthenticationService {
  constructor(
    private readonly database: D1Database,
    private readonly configuration: AuthConfiguration,
  ) {}

  async githubAuthorizationUrl(nonce: string, now = Date.now()): Promise<string> {
    const state = await signState(
      { nonce, expiresAt: now + 10 * 60 * 1000 },
      this.configuration.stateSecret,
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.configuration.githubClientId);
    url.searchParams.set(
      "redirect_uri",
      new URL("/auth/callback", this.configuration.origin).toString(),
    );
    // `read:user` is the minimum OAuth scope that provides GitHub's immutable numeric id.
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async authenticateGithubCallback(input: {
    code: string;
    state: string;
    nonce: string;
    now?: Date;
  }): Promise<{ accountId: string; session: string }> {
    const now = input.now ?? new Date();
    const state = await verifyState(input.state, this.configuration.stateSecret);
    if (
      !state ||
      state.nonce !== input.nonce ||
      typeof state.expiresAt !== "number" ||
      state.expiresAt < now.getTime()
    )
      throw new AuthError("INVALID_STATE");

    const accessToken = await exchangeGithubCode(input.code, this.configuration);
    // Deliberately scoped to this block: no token is persisted, logged, or returned.
    const githubUser = await githubIdentity(accessToken);
    const accountId = await this.upsertAccount(githubUser.id, now.toISOString());
    return { accountId, session: await this.createSession(accountId, now.getTime()) };
  }

  async createCredential(accountId: string, input: { label?: string; expiresAt?: string } = {}) {
    const expiresAt = validateExpiry(input.expiresAt);
    const now = new Date().toISOString();
    const token = `${credentialPrefix}${randomBase64Url(32)}`;
    const id = crypto.randomUUID();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO credentials (id, account_id, token_hash, label, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          accountId,
          await credentialHash(token, this.configuration.credentialHashPepper),
          input.label?.trim() || null,
          expiresAt,
          now,
          now,
        ),
    ]);
    return {
      credential: { id, label: input.label?.trim() || null, expiresAt, createdAt: now },
      token,
    };
  }

  async listCredentials(accountId: string) {
    const rows = await this.database
      .prepare(
        `SELECT id, label, expires_at, revoked_at, created_at, last_used_at FROM credentials
         WHERE account_id = ? ORDER BY created_at DESC`,
      )
      .bind(accountId)
      .all<CredentialRow>();
    return rows.results.map((row) => ({
      id: row.id,
      label: row.label,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  async revokeCredential(accountId: string, credentialId: string) {
    const now = new Date().toISOString();
    const result = await this.database.batch([
      this.database
        .prepare(
          "UPDATE credentials SET revoked_at = ?, updated_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
        )
        .bind(now, now, credentialId, accountId),
    ]);
    return (result[0]?.meta?.changes ?? 0) > 0;
  }

  async rotateCredential(
    accountId: string,
    credentialId: string,
    input: { label?: string; expiresAt?: string } = {},
  ) {
    const existing = await this.database
      .prepare("SELECT id FROM credentials WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .bind(credentialId, accountId)
      .first<{ id: string }>();
    if (!existing) return null;
    const issued = await this.createCredential(accountId, input);
    await this.revokeCredential(accountId, credentialId);
    return issued;
  }

  async enrollRanked(accountId: string, displayName: string) {
    const normalized = displayName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{2,23}$/.test(normalized))
      throw new AuthError("INVALID_DISPLAY_NAME");
    const now = new Date().toISOString();
    try {
      const result = await this.database.batch([
        this.database
          .prepare(
            "UPDATE accounts SET display_name = ?, ranked_enrolled_at = ?, updated_at = ? WHERE id = ? AND ranked_enrolled_at IS NULL",
          )
          .bind(normalized, now, now, accountId),
      ]);
      if ((result[0]?.meta?.changes ?? 0) === 0) throw new AuthError("ALREADY_ENROLLED");
    } catch (error) {
      if (isUniqueConstraint(error)) throw new AuthError("DISPLAY_NAME_TAKEN");
      throw error;
    }
    return { displayName: normalized, enrolledAt: now };
  }

  async accountFromSession(session: string): Promise<string | null> {
    const payload = await verifyState(session, this.configuration.stateSecret);
    return payload &&
      typeof payload.accountId === "string" &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt >= Date.now()
      ? payload.accountId
      : null;
  }

  private async createSession(accountId: string, now: number) {
    return signState(
      { accountId, expiresAt: now + sessionLifetimeMs },
      this.configuration.stateSecret,
    );
  }

  private async upsertAccount(githubUserId: string, now: string) {
    const found = await this.database
      .prepare("SELECT id FROM accounts WHERE github_user_id = ?")
      .bind(githubUserId)
      .first<AccountRow>();
    if (found) return found.id;
    const id = crypto.randomUUID();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO accounts (id, github_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id, githubUserId, now, now),
    ]);
    return id;
  }
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | "INVALID_STATE"
      | "INVALID_DISPLAY_NAME"
      | "DISPLAY_NAME_TAKEN"
      | "ALREADY_ENROLLED"
      | "GITHUB_AUTH_FAILED",
  ) {
    super(code);
  }
}

export async function credentialHash(token: string, pepper: string) {
  return sha256(`${pepper}:${token}`);
}

async function exchangeGithubCode(code: string, configuration: AuthConfiguration) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: configuration.githubClientId,
      client_secret: configuration.githubClientSecret,
      code,
      redirect_uri: new URL("/auth/callback", configuration.origin).toString(),
    }),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!response.ok || !body || typeof body.access_token !== "string")
    throw new AuthError("GITHUB_AUTH_FAILED");
  return body.access_token;
}

async function githubIdentity(accessToken: string) {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
  });
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (!response.ok || !body || (typeof body.id !== "number" && typeof body.id !== "string"))
    throw new AuthError("GITHUB_AUTH_FAILED");
  return { id: String(body.id) };
}

function validateExpiry(expiresAt: string | undefined) {
  if (!expiresAt) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d\.\d{3}Z$/.test(expiresAt) || Date.parse(expiresAt) <= Date.now())
    throw new AuthError("INVALID_STATE");
  return expiresAt;
}
function isUniqueConstraint(error: unknown) {
  return error instanceof Error && /unique/i.test(error.message);
}
function randomBase64Url(bytes: number) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function signState(payload: Record<string, string | number>, secret: string) {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${signature}`;
}
async function verifyState(
  value: string,
  secret: string,
): Promise<Record<string, string | number> | null> {
  const [encoded, signature, extra] = value.split(".");
  if (
    !encoded ||
    !signature ||
    extra ||
    !(await timingSafeEqual(signature, await hmac(encoded, secret)))
  )
    return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    return payload && typeof payload === "object"
      ? (payload as Record<string, string | number>)
      : null;
  } catch {
    return null;
  }
}
async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
  );
}
async function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
function bytesToBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function base64UrlToBytes(value: string) {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
