import { Router } from "express";
import { previewInvite, respondToInvite } from "../controllers/invitationController";
import { optionalAuth, requireAuth } from "../middleware/requireAuth";

const router: Router = Router();

router.get("/invites/:token/preview", optionalAuth, previewInvite);
router.post("/invites/:token/respond", requireAuth, respondToInvite);

export default router;
