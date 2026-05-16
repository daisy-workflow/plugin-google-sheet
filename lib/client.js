// Shared Google Sheets REST client. Service-account auth: sign a JWT
// with the private key from the customer's service-account JSON, swap
// it for an OAuth access token at oauth2.googleapis.com/token, cache
// the token for ~50 minutes, then use it as a Bearer credential on
// every Sheets API call.
//
// Why service accounts and not OAuth-user-consent?
//   For SaaS, service accounts are the only viable option. The
//   customer creates one in their own Google Cloud project, shares
//   each spreadsheet with that account's client_email, and Daisy
//   never sees a user's browser. No callback URL gymnastics, no
//   refresh token storage. The downside: the customer has to share
//   every spreadsheet they want Daisy to touch.

import crypto from "node:crypto";

const TOKEN_URL  = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4";
const SCOPES     = "https://www.googleapis.com/auth/spreadsheets";

// In-memory token cache. Keyed by clientEmail so two configs in the
// same workspace (different projects) don't clobber each other.
//
// Google access tokens last 3600s; we expire ours 600s early so a
// long-running batch doesn't break mid-flight on a stale token.
const tokenCache = new Map();   // clientEmail → { token, expiresAt }
const TOKEN_TTL_MS = 50 * 60 * 1000;

export function loadGoogleAuth(ctx, configName = "google") {
  const cfg = ctx?.config?.[configName];
  if (!cfg) {
    throw new Error(
      `Google config "${configName}" not found in workspace. ` +
      `Create a generic config with a credentialsJson field holding the service-account JSON.`,
    );
  }

  // Accept either credentialsJson (paste the file as-is) or split
  // fields. credentialsJson is preferred — fewer ways to typo.
  let clientEmail = cfg.clientEmail;
  let privateKey  = cfg.privateKey;
  if (cfg.credentialsJson) {
    try {
      const j = typeof cfg.credentialsJson === "string"
        ? JSON.parse(cfg.credentialsJson)
        : cfg.credentialsJson;
      clientEmail = clientEmail || j.client_email;
      privateKey  = privateKey  || j.private_key;
    } catch (e) {
      throw new Error(`credentialsJson is not valid JSON: ${e.message}`);
    }
  }

  if (!clientEmail) throw new Error(`Google config "${configName}" missing client_email (in credentialsJson).`);
  if (!privateKey)  throw new Error(`Google config "${configName}" missing private_key (in credentialsJson).`);

  // Some pastes turn the literal \n in the private key into the
  // characters \\n. Reverse that so crypto.createSign actually finds
  // a PEM block.
  privateKey = String(privateKey).replace(/\\n/g, "\n");

  return { clientEmail, privateKey };
}

// JWT header.claims.signature, base64url-encoded.
function signJwt(auth) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   auth.clientEmail,
    scope: SCOPES,
    aud:   TOKEN_URL,
    iat:   now,
    exp:   now + 3600,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(auth.privateKey)
    .toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${sig}`;
}

async function fetchAccessToken(auth, timeoutMs, signal) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`Google token request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onUpstream = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onUpstream, { once: true });
  }
  try {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  signJwt(auth),
    });
    const res = await fetch(TOKEN_URL, {
      method:  "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
      signal:  ac.signal,
    });
    const text = await res.text();
    let payload; try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    if (!res.ok) {
      const msg = payload?.error_description || payload?.error || `HTTP ${res.status}`;
      throw new Error(`Google OAuth token exchange failed: ${msg}`);
    }
    if (!payload?.access_token) throw new Error("Google OAuth returned no access_token");
    return payload.access_token;
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

async function getAccessToken(auth, timeoutMs, signal) {
  const cached = tokenCache.get(auth.clientEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = await fetchAccessToken(auth, timeoutMs, signal);
  tokenCache.set(auth.clientEmail, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Top-level fetch helper with two abort sources merged:
//   1. local per-call `timeoutMs` input
//   2. the engine's abort signal (workflow-level cancel)
export async function sheetsFetch(auth, path, init = {}, timeoutMs = 20000, signal) {
  const token = await getAccessToken(auth, timeoutMs, signal);

  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(new Error(`Google Sheets request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onUpstream = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onUpstream, { once: true });
  }

  try {
    const res = await fetch(`${SHEETS_API}${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept":        "application/json",
        "Content-Type":  "application/json",
        ...(init.headers || {}),
      },
      signal: ac.signal,
    });
    // 204 No Content is a possible reply on some clears — handle gracefully.
    const text = res.status === 204 ? "" : await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      // If the token was rejected (rotated key, revoked account), invalidate
      // our cache so the next call goes through a fresh OAuth exchange.
      if (res.status === 401) tokenCache.delete(auth.clientEmail);
      const err = new Error(`Google Sheets ${init.method || "GET"} ${path} failed: ${msg}`);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

// Convenience: build the editor deep-link for a spreadsheet.
export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

// Range encoding. Sheets accepts colons and bangs verbatim but spaces
// and special characters need URL encoding. encodeURIComponent does
// the right thing as long as we don't pre-encode the range.
export function encodeRange(range) {
  return encodeURIComponent(range);
}
