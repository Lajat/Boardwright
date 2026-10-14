import { WorkspaceModel, WorkspaceDocument } from "../models/Workspace";
import { BoardModel, BoardDocument } from "../models/Board";
import { ListModel } from "../models/List";

/** Card-level permissions — the shape both a workspace member and a board-only guest end up with, regardless of how they got access. */
export interface CardPermissions {
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * What a board guest gets when nobody picked a role explicitly — whether
 * that's an owner inviting by email without touching the permission
 * toggles, or someone joining through the board's general share link (which
 * has no per-invite role picker at all). This is deliberately the
 * "Contributor" preset (matches MembersModal's PermissionPreset of the same
 * name) rather than full access: a guest is, by definition, someone outside
 * the workspace, and granting delete rights to anyone who merely holds a
 * link is a much easier mistake to make than granting it to someone you
 * named by email with the role picker open in front of you.
 */
export const DEFAULT_GUEST_CARD_PERMISSIONS: CardPermissions = {
  canAdd: true,
  canEdit: true,
  canDelete: false,
};

/** A workspace member additionally has workspace-scoped permissions on both axes: board-level and card-level. */
export interface WorkspacePermissions extends CardPermissions {
  canEditWorkspace: boolean;
  canAddBoards: boolean;
  canEditBoards: boolean;
  canDeleteBoards: boolean;
  canAddCards: boolean;
  canEditCards: boolean;
  canDeleteCards: boolean;
}

/**
 * What resolveBoardAccess returns — deliberately a tagged union rather
 * than one flat object, so a caller that only cares about card-level
 * actions (list/card/comment controllers) can use `.cardPermissions`
 * without caring which scope it came from, while a caller that needs
 * board-level actions (boardController) can check `.scope === "workspace"`
 * first, since a guest NEVER has board-level rights by design — only a
 * workspace member can create/rename/delete a board at all.
 */
export type BoardAccess =
  | { scope: "workspace"; workspace: WorkspaceDocument; cardPermissions: CardPermissions; boardPermissions: { canAddBoards: boolean; canEditBoards: boolean; canDeleteBoards: boolean } }
  | { scope: "guest"; cardPermissions: CardPermissions }
  | null;

/** True if the user is a member of this workspace (owner included — see Workspace.ts on why the owner is always mirrored into memberIds). */
export function isWorkspaceMember(workspace: WorkspaceDocument, userId: string): boolean {
  return workspace.memberIds.some((id) => id.toString() === userId);
}

/**
 * A workspace member's effective workspace-, board-, and card-level
 * permissions. Returns null
 * if they're not a member at all — callers that already know the user is
 * a member (having just checked isWorkspaceMember) can safely assert this
 * away, but the null case exists so this function is safe to call
 * defensively too.
 *
 * Handles two backward-compatibility cases so nobody's access silently
 * changed when the two-axis model shipped:
 * - No entry in workspace.memberPermissions at all → full board/card
 *   access (the long-standing default); workspace rename remains owner-only.
 * - An entry that predates the two-axis model (only has the old
 *   canAdd/canEdit/canDelete fields, not the newer permission fields) → that single
 *   restriction is mapped onto BOTH axes uniformly, since that's the
 *   closest equivalent to what the owner originally intended before
 *   board-level and card-level permissions were split apart.
 */
export function getMemberPermissions(workspace: WorkspaceDocument, userId: string): WorkspacePermissions | null {
  if (!isWorkspaceMember(workspace, userId)) return null;

  const entry = workspace.memberPermissions.find((p) => p.userId.toString() === userId);

  if (!entry) {
    return {
      canEditWorkspace: workspace.ownerId.toString() === userId,
      canAddBoards: true, canEditBoards: true, canDeleteBoards: true,
      canAddCards: true, canEditCards: true, canDeleteCards: true,
      canAdd: true, canEdit: true, canDelete: true,
    };
  }

  // New-shape entry: at least one current permission field is actually
  // present (not undefined) — use them directly, falling back to true
  // for any that were somehow left unset.
  const hasNewShape =
    entry.canEditWorkspace !== undefined ||
    entry.canAddBoards !== undefined || entry.canEditBoards !== undefined || entry.canDeleteBoards !== undefined ||
    entry.canAddCards !== undefined || entry.canEditCards !== undefined || entry.canDeleteCards !== undefined;

  if (hasNewShape) {
    return {
      canEditWorkspace:
        workspace.ownerId.toString() === userId || entry.canEditWorkspace === true,
      canAddBoards: entry.canAddBoards ?? true,
      canEditBoards: entry.canEditBoards ?? true,
      canDeleteBoards: entry.canDeleteBoards ?? true,
      canAddCards: entry.canAddCards ?? true,
      canEditCards: entry.canEditCards ?? true,
      canDeleteCards: entry.canDeleteCards ?? true,
      canAdd: entry.canAddCards ?? true,
      canEdit: entry.canEditCards ?? true,
      canDelete: entry.canDeleteCards ?? true,
    };
  }

  // Old-shape entry (pre-dates the two-axis model): map the single
  // restriction onto both axes uniformly.
  const canAdd = entry.canAdd ?? true;
  const canEdit = entry.canEdit ?? true;
  const canDelete = entry.canDelete ?? true;
  return {
    canEditWorkspace: workspace.ownerId.toString() === userId,
    canAddBoards: canAdd, canEditBoards: canEdit, canDeleteBoards: canDelete,
    canAddCards: canAdd, canEditCards: canEdit, canDeleteCards: canDelete,
    canAdd, canEdit, canDelete,
  };
}

/**
 * The one function every list/card/comment controller should call to
 * find out "can this user act here at all, and with what card-level
 * permissions" — resolves BOTH possible paths to a board (workspace
 * membership, or a single-board guest entry) so callers never need to
 * know or care which one applies. Returns null if neither applies at
 * all, which every call site treats as a 404 (not 403) — matching the
 * existing pattern of not confirming a board/workspace exists to someone
 * with no access to it.
 */
export async function resolveBoardAccess(board: BoardDocument, userId: string): Promise<BoardAccess> {
  const workspace = await WorkspaceModel.findById(board.workspaceId);

  if (workspace && isWorkspaceMember(workspace, userId)) {
    const permissions = getMemberPermissions(workspace, userId)!;
    return {
      scope: "workspace",
      workspace,
      cardPermissions: { canAdd: permissions.canAdd, canEdit: permissions.canEdit, canDelete: permissions.canDelete },
      boardPermissions: {
        canAddBoards: permissions.canAddBoards,
        canEditBoards: permissions.canEditBoards,
        canDeleteBoards: permissions.canDeleteBoards,
      },
    };
  }

  const guestEntry = board.guestPermissions.find((g) => g.userId.toString() === userId);
  if (guestEntry) {
    return {
      scope: "guest",
      cardPermissions: {
        canAdd: guestEntry.canAddCards,
        canEdit: guestEntry.canEditCards,
        canDelete: guestEntry.canDeleteCards,
      },
    };
  }

  return null;
}

/**
 * Same resolution as resolveBoardAccess, but starting from a listId —
 * the shape every list/card/comment controller actually has on hand,
 * since none of them are passed a boardId directly.
 */
export async function resolveListAccess(listId: string, userId: string): Promise<BoardAccess> {
  const list = await ListModel.findById(listId);
  if (!list) return null;
  const board = await BoardModel.findById(list.boardId);
  if (!board) return null;
  return resolveBoardAccess(board, userId);
}

/** Same resolution, starting from a boardId — for listController, which operates on boards directly rather than through a list. */
export async function resolveBoardAccessById(boardId: string, userId: string): Promise<BoardAccess> {
  const board = await BoardModel.findById(boardId);
  if (!board) return null;
  return resolveBoardAccess(board, userId);
}

/**
 * Kept for the handful of call sites that only need to know "is this
 * workspace member's permission level X" without needing the board-guest
 * path at all (e.g. workspaceController itself, which only ever operates
 * on workspace members). New list/card/comment code should prefer
 * resolveBoardAccess/resolveListAccess instead, since those also cover
 * board-only guests.
 */
export async function loadWorkspaceForList(listId: string): Promise<WorkspaceDocument | null> {
  const list = await ListModel.findById(listId);
  if (!list) return null;
  const board = await BoardModel.findById(list.boardId);
  if (!board) return null;
  return WorkspaceModel.findById(board.workspaceId);
}
