"use strict";

const crypto = require("crypto");

const SESSION_COOKIE = "stmem_web_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class WebAuthError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function isLoopbackHost(value) {
  const host = String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isLoopbackAddress(value) {
  return isLoopbackHost(value);
}

function hashToken(token) {
  return `sha256:${crypto.createHash("sha256").update(String(token), "utf8").digest("hex")}`;
}

function generateToken() {
  return `stmem_${crypto.randomBytes(32).toString("base64url")}`;
}

function verifyToken(token, verifier) {
  if (!token || typeof verifier !== "string" || !verifier.startsWith("sha256:")) return false;
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(verifier);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createMemorySessionStore({ now }) {
  const sessions = new Map();
  return {
    create({ tokenVerifier }) {
      const credential = crypto.randomBytes(32).toString("base64url");
      sessions.set(credential, { tokenVerifier, expiresAt:now() + SESSION_TTL_MS });
      return { credential, expiresAt:now() + SESSION_TTL_MS };
    },
    find(credential, { tokenVerifier }) {
      const session = sessions.get(credential);
      return session && session.tokenVerifier === tokenVerifier && session.expiresAt > now() ? session : null;
    },
  };
}

function configuredAuth(config) {
  const auth = config?.web?.auth;
  return auth && typeof auth.tokenVerifier === "string" && auth.tokenVerifier.startsWith("sha256:") ? auth : null;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map(item => item.trim().split(/=(.*)/s)).filter(([key]) => key).map(([key, value]) => [key, value || ""]));
}

function requestOrigins(req, webConfig) {
  const origins = new Set();
  const scheme = req.socket?.encrypted ? "https" : "http";
  if (req.headers.host) {
    origins.add(`${scheme}://${req.headers.host}`);
    origins.add(`http://${req.headers.host}`);
    origins.add(`https://${req.headers.host}`);
  }
  const configured = String(webConfig?.publicUrl || "").trim();
  if (configured) {
    try { origins.add(new URL(configured).origin); } catch {}
  }
  return origins;
}

function isRemoteRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return true;
  try {
    return !isLoopbackHost(new URL(`http://${req.headers.host || ""}`).hostname);
  } catch {
    return true;
  }
}

function isPublicWebApiRoute(method, pathname) {
  return (method === "GET" && pathname === "/api/auth/status")
    || (method === "POST" && pathname === "/api/auth/unlock");
}

function createWebAuth({ host, configProvider, now = () => Date.now(), sessionStore = null }) {
  const devices = sessionStore || createMemorySessionStore({ now });
  const config = () => configProvider() || {};
  const authConfig = () => configuredAuth(config());
  const requiresAuth = req => Boolean(authConfig()) || !isLoopbackHost(host) || (req ? isRemoteRequest(req) : false);

  function bearer(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function authenticate(req) {
    if (!requiresAuth(req)) return { kind: "none" };
    const auth = authConfig();
    if (!auth) throw new WebAuthError(503, "此监听地址需要先配置 Web API Token");
    if (verifyToken(bearer(req), auth.tokenVerifier)) return { kind: "bearer" };
    const credential = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = devices.find(credential, { tokenVerifier:auth.tokenVerifier });
    if (session) return { kind:"session", deviceId:session.deviceId || "", refreshCookie:session.refreshed ? sessionCookie(credential, req) : "" };
    throw new WebAuthError(401, "需要 Web API 访问令牌", { "www-authenticate": "Bearer" });
  }

  function assertSameOrigin(req, principal) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || principal.kind === "bearer") return;
    const origin = String(req.headers.origin || "");
    const expected = requestOrigins(req, config().web);
    // When authentication is disabled on a loopback-only listener, keep
    // non-browser local tooling working (it has no Origin) while rejecting a
    // browser request that declares a foreign Origin. Cookie sessions require
    // an explicit same Origin because browsers attach their credential for us.
    const requiresExplicitOrigin = principal.kind === "session";
    if ((requiresExplicitOrigin && !origin) || (origin && !expected.has(origin)) || req.headers["sec-fetch-site"] === "cross-site") {
      throw new WebAuthError(403, "浏览器会话只能从同一来源执行写操作");
    }
  }

  function sessionCookie(credential, req) {
    const origin = String(req.headers.origin || "");
    // A configured HTTPS entry must not mark cookies from a separate LAN HTTP
    // entry Secure. On refresh GETs Origin is absent; use publicUrl only when
    // its authority matches this request (including port).
    let configuredHttpsEntry = false;
    try {
      const publicUrl = new URL(String(config().web?.publicUrl || ""));
      configuredHttpsEntry = publicUrl.protocol === "https:" && publicUrl.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
    } catch {}
    const secure = Boolean(req.socket?.encrypted || (origin ? /^https:/i.test(origin) : configuredHttpsEntry));
    return `${SESSION_COOKIE}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
  }

  function unlock(token, req) {
    const auth = authConfig();
    if (!auth || !verifyToken(token, auth.tokenVerifier)) {
      throw new WebAuthError(401, "Web API 访问令牌无效", { "www-authenticate": "Bearer" });
    }
    const session = devices.create({ tokenVerifier:auth.tokenVerifier, request:req });
    return sessionCookie(session.credential, req);
  }

  return {
    requiresAuth,
    authenticate,
    assertSameOrigin,
    unlock,
    status: req => ({ authenticationRequired: requiresAuth(req), enabled: Boolean(authConfig()) }),
  };
}

module.exports = { WebAuthError, SESSION_COOKIE, SESSION_TTL_MS, isLoopbackHost, isLoopbackAddress, isRemoteRequest, hashToken, verifyToken, generateToken, configuredAuth, isPublicWebApiRoute, createWebAuth };
