import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { isSessionCurrent } from "../lib/session";

/**
 * Augments Express's Request type so `req.userId` is recognized by
 * TypeScript everywhere downstream, instead of every controller having to
 * cast `req` or use `any`.
 */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      // The tokenVersion the caller's access token was issued under, so
      // createSocketTicket can stamp the same one onto the ticket it mints.
      tokenVersion?: number;
    }
  }
}

/**
 * Verifies the accessToken httpOnly cookie and attaches the decoded user
 * id to `req.userId`. Any route that needs to know "who is making this
 * request" should sit behind this middleware.
 *
 * Reads from the cookie (set by authController on login/signup/refresh)
 * rather than an `Authorization: Bearer` header — the browser attaches it
 * automatically on every request to this API's origin, so the frontend
 * never has to read, store, or manually attach the token itself, and it's
 * never reachable by JavaScript at all (see cookie's httpOnly flag).
 *
 * Beyond the signature and expiry, it also confirms the token's
 * tokenVersion still matches the user's (see lib/session) — one small
 * database read per request — so a password reset kills sessions that were
 * already open instead of letting them run out their 15-minute access
 * tokens.
 *
 * On failure: responds 401 and does NOT call next() — the request stops here.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    // A misconfigured server is a 500, not a 401 — the client did nothing wrong.
    return res.status(500).json({ error: "Server authentication is not configured" });
  }

  let decoded: { userId: string; tv?: number };
  try {
    decoded = jwt.verify(token, secret) as { userId: string; tv?: number };
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    if (!(await isSessionCurrent(decoded.userId, decoded.tv))) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  } catch (err) {
    // The lookup itself failed (database down) — that says nothing about the
    // token, so it must not look like a bad one: a 401 here would make the
    // client try a refresh and then log the person out over an outage.
    return next(err);
  }

  req.userId = decoded.userId;
  req.tokenVersion = decoded.tv ?? 0;
  next();
}

/** Attaches a valid signed-in identity when present, without blocking public invite previews. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;
  const secret = process.env.JWT_ACCESS_SECRET;
  if (token && secret) {
    try {
      const decoded = jwt.verify(token, secret) as { userId: string; tv?: number };
      // A session killed by a password reset is anonymous here too, same as
      // an expired one — it shouldn't be treated as signed in just because
      // this route happens not to require it.
      if (await isSessionCurrent(decoded.userId, decoded.tv)) {
        req.userId = decoded.userId;
      }
    } catch {
      // An invalid or expired cookie is equivalent to an anonymous preview.
    }
  }
  next();
}
