import { Request, Response, NextFunction } from "express";

/**
 * A small hand-rolled rate limiter rather than pulling in
 * express-rate-limit: adding a new dependency here would need
 * pnpm-lock.yaml regenerated too (a `pnpm install` with network access),
 * which isn't something this change can safely do blind. This covers the
 * two endpoints that actually need it — login and forgot-password — with
 * a plain in-memory counter per IP+route.
 *
 * In-memory means per-process: fine for a single-instance deployment
 * (what this project's Dockerfile/Elastic Beanstalk setup already is), but
 * if this ever runs as multiple instances behind a load balancer, each
 * instance would count separately — worth moving to a shared store (Redis,
 * or the Mongo database already in use) at that point rather than before
 * it's actually needed.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Buckets never explicitly deleted after they expire — this periodic sweep
// is what keeps the Map from growing forever as new IPs show up over the
// process's lifetime.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function rateLimit(routeKey: string, maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${routeKey}:${req.ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "Too many attempts. Please try again later." });
    }

    bucket.count++;
    next();
  };
}
