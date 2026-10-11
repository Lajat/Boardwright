import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

/**
 * Augments Express's Request type so `req.userId` is recognized by
 * TypeScript everywhere downstream, instead of every controller having to
 * cast `req` or use `any`.
 */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
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
 * On failure: responds 401 and does NOT call next() — the request stops here.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      // A misconfigured server is a 500, not a 401 — the client did nothing wrong.
      throw new Error("JWT_ACCESS_SECRET is not configured on the server");
    }
    const decoded = jwt.verify(token, secret) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Attaches a valid signed-in identity when present, without blocking public invite previews. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.accessToken;
  if (token) {
    try {
      const secret = process.env.JWT_ACCESS_SECRET;
      if (secret) {
        const decoded = jwt.verify(token, secret) as { userId: string };
        req.userId = decoded.userId;
      }
    } catch {
      // An invalid or expired cookie is equivalent to an anonymous preview.
    }
  }
  next();
}
