import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { UserModel } from "../models/User";
import type { User } from "@boardwright/shared-types";
import { sendEmail, passwordResetEmailHtml } from "../lib/email";

const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:3000";
const SALT_ROUNDS = 10;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes — sent with every request
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — only used to mint new access tokens
const ACCESS_TOKEN_TTL_JWT = "15m";
const REFRESH_TOKEN_TTL_JWT = "30d";
const SOCKET_TICKET_TTL_SECONDS = 60;
const REFRESH_COOKIE_PATH = "/api-proxy/auth/refresh";

const isProd = process.env.NODE_ENV === "production";
const authCookieOptions = isProd
  ? ({ secure: true, sameSite: "none" } as const)
  : ({ secure: false, sameSite: "lax" } as const);

/**
 * Converts a Mongoose UserDocument into the public `User` shape from
 * @boardwright/shared-types — deliberately excludes passwordHash, so it's
 * structurally impossible to accidentally leak it in an API response by
 * forgetting to strip a field somewhere.
 */
function toUserResponse(doc: any): User {
  return {
    id: doc._id.toString(),
    email: doc.email,
    displayName: doc.displayName,
    avatarUrl: doc.avatarUrl,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Signs a short-lived access token and a long-lived refresh token for a
 * given user id. Kept as one helper so both signup and login mint tokens
 * identically — no risk of the two flows drifting apart over time.
 */
function issueTokens(userId: string) {
  const accessSecret = process.env.JWT_ACCESS_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;

  if (!accessSecret || !refreshSecret) {
    throw new Error("JWT secrets are not configured on the server");
  }

  const accessToken = jwt.sign({ userId }, accessSecret, { expiresIn: ACCESS_TOKEN_TTL_JWT });
  const refreshToken = jwt.sign({ userId }, refreshSecret, { expiresIn: REFRESH_TOKEN_TTL_JWT });

  return { accessToken, refreshToken };
}

/**
 * Writes both tokens as httpOnly cookies on the response — this is the
 * one thing that actually changed in the localStorage → cookie migration:
 * neither token is ever present in a JSON response body or readable by
 * frontend JavaScript, which is what closes off the XSS-token-theft path
 * that localStorage-based storage was exposed to.
 *
 * The two cookies deliberately have different scopes:
 *  - accessToken: path "/" (sent with every request, since every
 *    authenticated route needs it)
 *  - refreshToken: path "/api-proxy/auth/refresh" ONLY (sent with nothing
 *    else) —
 *    this means even if an attacker found a way to read response
 *    headers/cookies for some OTHER endpoint, the long-lived refresh
 *    token was never exposed there in the first place. Scoping it this
 *    narrowly is the main extra protection a refresh token gets beyond
 *    just being httpOnly.
 * REST calls are proxied through the frontend's same origin. Socket.IO
 * connects directly to the API using a short-lived ticket; SameSite=None
 * remains for compatibility with direct API clients and cookie handshakes.
 */
function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    ...authCookieOptions,
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: "/",
  });
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    ...authCookieOptions,
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: REFRESH_COOKIE_PATH,
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", {
    path: REFRESH_COOKIE_PATH,
  });
}

/**
 * POST /auth/signup
 * Creates a new user account and immediately logs them in (sets auth cookies).
 */
export async function signup(req: Request, res: Response) {
  const { email, password, displayName } = req.body;

  if (!email || !password || !displayName) {
    return res.status(400).json({ error: "email, password, and displayName are required" });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const existing = await UserModel.findOne({ email: email.toLowerCase() });
  if (existing) {
    // Deliberately generic message — confirming "this email is taken" to an
    // unauthenticated caller is a minor account-enumeration leak.
    return res.status(409).json({ error: "unable to create account with these details" });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await UserModel.create({ email, passwordHash, displayName });

  const { accessToken, refreshToken } = issueTokens(user._id.toString());
  setAuthCookies(res, accessToken, refreshToken);

  res.status(201).json({ user: toUserResponse(user) });
}

/**
 * POST /auth/login
 * Verifies credentials and sets a fresh pair of auth cookies.
 */
export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await UserModel.findOne({ email: email.toLowerCase() });

  // Same error message whether the email doesn't exist or the password is
  // wrong — again, avoids confirming which emails have accounts.
  const invalidCredentialsError = { error: "invalid email or password" };

  if (!user) {
    return res.status(401).json(invalidCredentialsError);
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json(invalidCredentialsError);
  }

  const { accessToken, refreshToken } = issueTokens(user._id.toString());
  setAuthCookies(res, accessToken, refreshToken);

  res.json({ user: toUserResponse(user) });
}

/**
 * POST /auth/refresh
 * Exchanges the refreshToken cookie for a new pair of tokens, written back
 * as cookies. Refresh tokens are stateless JWTs here, so issuing a new pair
 * does not revoke the token that was used.
 * The frontend calls this with no body at all — the refresh token itself
 * is never something frontend code reads or sends explicitly, since it's
 * httpOnly and scoped to only be sent to this one path automatically.
 */
export async function refresh(req: Request, res: Response) {
  const refreshToken = req.cookies?.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: "no refresh token" });
  }

  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!refreshSecret) {
    throw new Error("JWT_REFRESH_SECRET is not configured on the server");
  }

  try {
    const decoded = jwt.verify(refreshToken, refreshSecret) as { userId: string };
    const tokens = issueTokens(decoded.userId);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.json({ success: true });
  } catch (err) {
    clearAuthCookies(res); // an invalid/expired refresh token can't be used again — don't leave a dead cookie sitting there
    res.status(401).json({ error: "invalid or expired refresh token" });
  }
}

/**
 * POST /auth/logout
 * Clears both auth cookies server-side. Plain localStorage-based logout
 * could just delete a browser-side value and be done; httpOnly cookies
 * are invisible to JavaScript by design, so clearing them has to be a
 * request the server responds to with a Set-Cookie that expires them.
 */
export async function logout(req: Request, res: Response) {
  clearAuthCookies(res);
  res.json({ success: true });
}

/**
 * GET /auth/me
 * Returns the currently logged-in user's profile. Sits behind requireAuth,
 * so req.userId is guaranteed to be set by the time this runs.
 */
export async function getCurrentUser(req: Request, res: Response) {
  const user = await UserModel.findById(req.userId);
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }
  res.json(toUserResponse(user));
}

/**
 * POST /auth/socket-ticket
 * Issues a short-lived credential for the direct Socket.IO connection.
 * The browser obtains it through the same-origin REST proxy, where its
 * httpOnly access cookie is available, then sends it only in the socket
 * handshake instead of relying on a cross-site cookie.
 */
export function createSocketTicket(req: Request, res: Response) {
  if (!req.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error("JWT_ACCESS_SECRET is not configured on the server");
  }

  const ticket = jwt.sign(
    { userId: req.userId, purpose: "socket" },
    secret,
    { expiresIn: SOCKET_TICKET_TTL_SECONDS, audience: "boardwright-socket" }
  );
  res.set("Cache-Control", "no-store");
  res.json({ ticket });
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * POST /auth/forgot-password
 * Generates a one-time, expiring password-reset token. The current app
 * returns the token to the caller because it does not yet have an email
 * delivery service; the token is still stored with a one-hour expiry.
 */
export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const user = await UserModel.findOne({ email: email.toLowerCase() });

  // Same generic message whether the account exists or not — including in
  // timing-sensitive terms, the real work below (hashing isn't involved
  // here, but the token write + email send are) only happens on the
  // `user` branch, so avoid doing anything that'd make the two paths
  // visibly take different amounts of time where that's easy to avoid.
  const message = "If an account exists with that email, a reset link has been sent to it.";

  if (!user) {
    return res.json({ message });
  }

  user.resetToken = crypto.randomBytes(32).toString("hex");
  user.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  // The token is NEVER returned in this response — it previously was,
  // which meant anyone who merely knew (or guessed, or found in a breach
  // dump) a registered email address could call this endpoint and get back
  // the literal credential needed to take over that account, with no
  // access to the victim's inbox required. It only ever goes to the
  // account's own email address now.
  const resetLink = `${WEB_ORIGIN}/reset-password/${user.resetToken}`;
  await sendEmail({
    to: user.email,
    subject: "Reset your Boardwright password",
    html: passwordResetEmailHtml(resetLink),
  });

  res.json({ message });
}

/**
 * POST /auth/reset-password
 * Consumes a reset token (from forgotPassword above) and sets a new
 * password. The token is single-use — cleared immediately after a
 * successful reset — and expires after an hour even if unused.
 */
export async function resetPassword(req: Request, res: Response) {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "token and newPassword are required" });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const user = await UserModel.findOne({ resetToken: token });

  if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "this reset link is invalid or has expired" });
  }

  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  user.resetToken = undefined;
  user.resetTokenExpiresAt = undefined;
  await user.save();

  res.json({ success: true });
}
