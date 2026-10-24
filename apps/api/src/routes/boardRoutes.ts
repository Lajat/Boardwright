import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  createBoard,
  listBoardsForWorkspace,
  getBoard,
  updateBoard,
  deleteBoard,
  listBoardGuests,
  listAssignablePeople,
  addBoardGuest,
  updateBoardGuestPermissions,
  removeBoardGuest,
  getBoardInviteLink,
  regenerateBoardInviteLink,
} from "../controllers/boardController";

const router: Router = Router();

router.use(requireAuth);

router.post("/workspaces/:workspaceId/boards", createBoard);
router.get("/workspaces/:workspaceId/boards", listBoardsForWorkspace);
router.get("/boards/:boardId", getBoard);
router.patch("/boards/:boardId", updateBoard);
router.delete("/boards/:boardId", deleteBoard);

// Single-board guests — see BoardGuestEntry (models/Board.ts) for why
// these are deliberately separate from the workspace-level member routes
// in workspaceRoutes.ts, not a variant of them.
router.get("/boards/:boardId/guests", listBoardGuests);
// Open to any caller with board access at all, member or guest — see
// listAssignablePeople's own doc comment for why this is a separate,
// narrower endpoint rather than widening listBoardGuests/listMembers.
router.get("/boards/:boardId/assignable-people", listAssignablePeople);
router.post("/boards/:boardId/guests", addBoardGuest);
router.patch("/boards/:boardId/guests/:userId", updateBoardGuestPermissions);
router.delete("/boards/:boardId/guests/:userId", removeBoardGuest);
router.get("/boards/:boardId/invite-link", getBoardInviteLink);
router.post("/boards/:boardId/invite-link/regenerate", regenerateBoardInviteLink);

export default router;
