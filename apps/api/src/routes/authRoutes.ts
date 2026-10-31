import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { rateLimit } from "../lib/rateLimit";
import {
  signup,
  login,
  refresh,
  logout,
  getCurrentUser,
  createSocketTicket,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";

const router = Router();

// Public — no access token required to sign up, log in, or refresh.
// (refresh instead requires the separate, narrowly-scoped refreshToken
// cookie — see authController.refresh.)
router.post("/auth/signup", signup);
// 10 attempts per 15 minutes, per IP — generous enough that a real person
// mistyping their password a few times never hits it, tight enough to
// blunt a brute-force/credential-stuffing run against login, and to stop
// someone from using forgot-password to mass-probe which emails exist or
// to spam an inbox with reset links.
router.post("/auth/login", rateLimit("login", 10, 15 * 60 * 1000), login);
router.post("/auth/refresh", refresh);
router.post("/auth/logout", logout);
router.post("/auth/forgot-password", rateLimit("forgot-password", 10, 15 * 60 * 1000), forgotPassword);
router.post("/auth/reset-password", resetPassword);

// Requires a valid access token — this is the simplest possible route to
// sanity-check that requireAuth + a real login are working together.
router.get("/auth/me", requireAuth, getCurrentUser);
router.post("/auth/socket-ticket", requireAuth, createSocketTicket);

export default router;
