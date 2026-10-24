import { Request, Response } from "express";
import { Types } from "mongoose";
import { BoardModel } from "../models/Board";
import { WorkspaceModel } from "../models/Workspace";
import { ListModel } from "../models/List";
import { CardModel } from "../models/Card";
import { UserModel } from "../models/User";
import type { Board } from "@boardwright/shared-types";
import { SocketEvents } from "@boardwright/shared-types";
import { DEFAULT_GUEST_CARD_PERMISSIONS, getMemberPermissions, isWorkspaceMember, resolveBoardAccess } from "../lib/permissions";
import { generateKeyPrefix } from "../lib/taskId";
import { createNotification, emitNotification, notificationResponse, notifyUser } from "../lib/notify";
import { InvitationModel } from "../models/Invitation";
import { NotificationModel } from "../models/Notification";
import crypto from "crypto";

/** Converts a Mongoose BoardDocument into the shared `Board` shape. */
function toBoardResponse(doc: any): Board {
  return {
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    title: doc.title,
    listOrder: doc.listOrder.map((id: any) => id.toString()),
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * POST /workspaces/:workspaceId/boards
 * Creates a new board inside a workspace the user has "add" permission
 * in. Also generates the board's task-ID key prefix from its title right
 * away (see lib/taskId) — cards created on it will need this immediately,
 * so there's no reason to defer it the way Workspace.inviteToken is
 * deferred (which only needs generating if the owner actually opens the
 * invite panel).
 */
export async function createBoard(req: Request, res: Response) {
  const { workspaceId } = req.params;
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const permissions = getMemberPermissions(workspace, req.userId!);
  if (!permissions) {
    return res.status(404).json({ error: "workspace not found" });
  }
  if (!permissions.canAddBoards) {
    return res.status(403).json({ error: "you don't have permission to create boards in this workspace" });
  }

  const board = await BoardModel.create({
    workspaceId,
    title,
    listOrder: [],
    keyPrefix: generateKeyPrefix(title),
    cardCounter: 0,
  });
  const boardResponse = toBoardResponse(board);
  req.app.get("io").to(`workspace:${workspaceId}`).emit(SocketEvents.BOARD_CREATED, boardResponse);
  res.status(201).json(boardResponse);
}

/**
 * GET /workspaces/:workspaceId/boards
 * Lists every board in a workspace the user belongs to. Plain membership
 * is enough here — viewing doesn't require any specific permission, only
 * mutating does.
 */
export async function listBoardsForWorkspace(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const isMember = isWorkspaceMember(workspace, req.userId!);
  const boards = await BoardModel.find(
    isMember
      ? { workspaceId }
      : { workspaceId, guestPermissions: { $elemMatch: { userId: req.userId } } }
  );
  if (!isMember && boards.length === 0) {
    return res.status(404).json({ error: "workspace not found" });
  }

  // Same myPermissions getBoard attaches for a single board, added here too
  // so a board-guest workspace entry can show each board's REAL access
  // level (the workspace detail page does, next to each board) instead of
  // a generic placeholder — previously this list never carried it at all,
  // only GET /boards/:id did. Resolved inline rather than by calling
  // resolveBoardAccess per board: that would refetch this same workspace
  // document once per board (N+1), and a member's card permissions are
  // uniform across every board in their workspace, so there's nothing
  // board-specific to look up for that branch anyway. Only a guest's
  // permissions are genuinely per-board, and those are already embedded on
  // each board document (guestPermissions), no extra query needed.
  const memberCardPermissions = isMember ? getMemberPermissions(workspace, req.userId!) : null;
  const items = boards.map((board) => {
    const myPermissions = isMember
      ? memberCardPermissions && {
          canAdd: memberCardPermissions.canAdd,
          canEdit: memberCardPermissions.canEdit,
          canDelete: memberCardPermissions.canDelete,
        }
      : (() => {
          const guestEntry = board.guestPermissions.find((g) => g.userId.toString() === req.userId);
          return (
            guestEntry && {
              canAdd: guestEntry.canAddCards,
              canEdit: guestEntry.canEditCards,
              canDelete: guestEntry.canDeleteCards,
            }
          );
        })();
    return { ...toBoardResponse(board), myPermissions: myPermissions ?? undefined };
  });
  res.json({ items });
}

/**
 * GET /boards/:boardId
 * Returns a single board — if the user belongs to its workspace, OR is a
 * single-board guest with explicit access to this exact board (see
 * Board.guestPermissions). A guest reaching this endpoint is the normal
 * case, not an edge case: it's how they view the one board they were
 * invited to.
 */
export async function getBoard(req: Request, res: Response) {
  const { boardId } = req.params;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const access = await resolveBoardAccess(board, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }

  res.json({ ...toBoardResponse(board), myPermissions: access.cardPermissions });
}

/**
 * PATCH /boards/:boardId
 * Renames a board — requires "edit" permission in its workspace. Only
 * title is editable here — moving a board between workspaces isn't
 * supported, so workspaceId is intentionally never accepted from the
 * request body.
 */
export async function updateBoard(req: Request, res: Response) {
  const { boardId } = req.params;
  const { title } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const access = await resolveBoardAccess(board, req.userId!);
  // A board-only guest never has board-level rights at all, by design —
  // they can work inside a board's lists/cards but never rename/delete
  // the board itself, so scope !== "workspace" is a 404 here the same as
  // no access at all, not a 403 (this endpoint doesn't exist for them).
  if (!access || access.scope !== "workspace") {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.boardPermissions.canEditBoards) {
    return res.status(403).json({ error: "you don't have permission to edit this board" });
  }

  board.title = title;
  await board.save();

  const boardResponse = toBoardResponse(board);
  req.app
    .get("io")
    .to(`workspace:${board.workspaceId}`)
    .emit(SocketEvents.BOARD_UPDATED, boardResponse);
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.BOARD_UPDATED, boardResponse);

  res.json(boardResponse);
}

/**
 * DELETE /boards/:boardId
 * Deletes a board — requires "delete" permission in its workspace.
 * Cascades: every List in the board, and every Card in those lists, is
 * deleted too — a board should never leave orphaned lists or cards behind
 * that no UI can reach anymore.
 */
export async function deleteBoard(req: Request, res: Response) {
  const { boardId } = req.params;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const access = await resolveBoardAccess(board, req.userId!);
  if (!access || access.scope !== "workspace") {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.boardPermissions.canDeleteBoards) {
    return res.status(403).json({ error: "you don't have permission to delete this board" });
  }

  const lists = await ListModel.find({ boardId });
  const listIds = lists.map((l) => l._id);
  const boardGuests = [...board.guestPermissions];

  // Cascade delete, innermost first: cards → lists → board. Doing it in
  // this order means if this fails partway through, we're left with
  // orphaned lists/cards rather than a board referencing lists that no
  // longer exist — the safer failure mode of the two.
  await CardModel.deleteMany({ listId: { $in: listIds } });
  await ListModel.deleteMany({ boardId });
  await BoardModel.findByIdAndDelete(boardId);

  const boardResponse = toBoardResponse(board);
  req.app
    .get("io")
    .to(`workspace:${board.workspaceId}`)
    .emit(SocketEvents.BOARD_DELETED, boardResponse);

  const io = req.app.get("io");
  for (const guest of boardGuests) {
    const guestId = guest.userId.toString();
    io.to(`user:${guestId}`).emit(SocketEvents.ACCESS_REVOKED, {
      workspaceId: board.workspaceId.toString(),
      workspaceName: access.workspace.name,
      resourceType: "board",
      resourceId: board.id,
      resourceName: board.title,
    });
    await notifyUser(io, guestId, {
      type: "board_removed",
      title: "Board access removed",
      body: `"${board.title}" was deleted, so you no longer have access to it.`,
      link: "/workspaces",
    });
  }
  const pendingInvitations = await InvitationModel.find({
    scope: "board",
    targetId: board._id,
    status: { $in: ["pending", "snoozed"] },
  });
  await InvitationModel.updateMany(
    { _id: { $in: pendingInvitations.map((invitation) => invitation._id) } },
    { status: "revoked" }
  );
  for (const invitation of pendingInvitations) {
    if (!invitation.notificationId) continue;
    const notification = await NotificationModel.findByIdAndUpdate(
      invitation.notificationId,
      { isResolved: true, snoozedUntil: null },
      { new: true }
    );
    if (notification) {
      io.to(`user:${invitation.recipientId}`).emit(
        SocketEvents.NOTIFICATION_UPDATED,
        notificationResponse(notification)
      );
    }
  }

  res.json({ deleted: boardResponse });
}

/** Converts a guestPermissions entry + its looked-up User into the shared `BoardGuest` shape. */
function toBoardGuestResponse(user: any, entry: any): any {
  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    permissions: {
      canAdd: entry.canAddCards,
      canEdit: entry.canEditCards,
      canDelete: entry.canDeleteCards,
    },
  };
}

/**
 * GET /boards/:boardId/guests
 * Lists everyone with single-board guest access to this board (not
 * workspace members — see listMembers in workspaceController for that).
 * Workspace-member-only, same visibility reasoning as the rest of this
 * controller's management endpoints.
 */
/**
 * GET /boards/:boardId/assignable-people
 * Everyone a card on this board could be assigned to — workspace members
 * AND other board guests, id/name/avatar only. Open to anyone with ANY
 * access to the board (resolveBoardAccess returning non-null covers both
 * scopes), unlike listMembers/listBoardGuests which are workspace-member-
 * only: a guest couldn't previously even see who to assign a card to on a
 * board they're a legitimate Contributor on, since those two endpoints
 * both 404 for a guest caller. This is deliberately NOT those two
 * endpoints with a looser check bolted on — it returns a different,
 * narrower shape (no email, no role, no permissions) so broadening who can
 * call it doesn't also broaden what a guest caller learns about everyone
 * else's access level.
 */
export async function listAssignablePeople(req: Request, res: Response) {
  const { boardId } = req.params;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }
  const access = await resolveBoardAccess(board, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }

  // Loaded independently of `access` on purpose: access.workspace is only
  // populated when the CALLER themselves is a member (resolveBoardAccess's
  // "workspace" scope branch) — a guest caller's access has no workspace
  // attached at all. Without this, a guest would only ever see other
  // guests in the list, never the workspace members (including the owner)
  // a card could just as well be assigned to.
  const workspace = await WorkspaceModel.findById(board.workspaceId);
  const memberIds = workspace ? workspace.memberIds.map((id) => id.toString()) : [];
  const guestIds = board.guestPermissions.map((g) => g.userId.toString());
  const userIds = [...new Set([...memberIds, ...guestIds])];

  const users = await UserModel.find({ _id: { $in: userIds } });
  const people = users
    .map((u) => ({ id: u._id.toString(), displayName: u.displayName, avatarUrl: u.avatarUrl }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  res.json({ items: people });
}

export async function listBoardGuests(req: Request, res: Response) {
  const { boardId } = req.params;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const access = await resolveBoardAccess(board, req.userId!);
  if (!access || access.scope !== "workspace") {
    return res.status(404).json({ error: "board not found" });
  }

  const userIds = board.guestPermissions.map((g) => g.userId);
  const users = await UserModel.find({ _id: { $in: userIds } });
  const usersById = new Map(users.map((u) => [u._id.toString(), u]));

  const guests = board.guestPermissions
    .map((entry) => {
      const user = usersById.get(entry.userId.toString());
      return user ? toBoardGuestResponse(user, entry) : null;
    })
    .filter(Boolean);

  res.json({ items: guests });
}

/**
 * POST /boards/:boardId/guests
 * Grants someone single-board access — NOT workspace membership, the
 * Trello-style guest concept described on BoardGuestEntry (Board.ts):
 * they'll be able to see and work on exactly this board, nothing else in
 * the workspace. Owner-only, same authorization level as inviting a
 * workspace member (addMember) — granting any new person access to
 * anything is treated as an owner-level decision throughout this app,
 * not something any member can do.
 *
 * If the target email belongs to an existing workspace member, this is
 * rejected — board-guest access would be strictly weaker than what they
 * already have as a member, so it can only be a mistake, not a
 * meaningful request.
 */
export async function addBoardGuest(req: Request, res: Response) {
  const { boardId } = req.params;
  // Unspecified permissions default to Contributor (add + edit, no delete)
  // rather than full access — see DEFAULT_GUEST_CARD_PERMISSIONS.
  const {
    email,
    canAdd = DEFAULT_GUEST_CARD_PERMISSIONS.canAdd,
    canEdit = DEFAULT_GUEST_CARD_PERMISSIONS.canEdit,
    canDelete = DEFAULT_GUEST_CARD_PERMISSIONS.canDelete,
  } = req.body;

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }
  if (canDelete && !(canAdd && canEdit)) {
    return res.status(400).json({ error: "canDelete requires canAdd and canEdit to also be true" });
  }

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const workspace = await WorkspaceModel.findById(board.workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "board not found" });
  }
  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can invite a guest to a board" });
  }

  const userToAdd = await UserModel.findOne({ email: email.toLowerCase() });
  if (!userToAdd) {
    return res.status(404).json({ error: "no user found with that email" });
  }

  if (isWorkspaceMember(workspace, userToAdd._id.toString())) {
    return res.status(400).json({ error: "this person is already a workspace member, which already includes access to this board" });
  }

  if (board.guestPermissions.some((guest) => guest.userId.toString() === userToAdd._id.toString())) {
    return res.status(409).json({ error: "that person already has access to this board" });
  }
  const hasPendingInvitation = await InvitationModel.exists({
    scope: "board",
    targetId: board._id,
    recipientId: userToAdd._id,
    status: { $in: ["pending", "snoozed"] },
  });
  if (hasPendingInvitation) {
    return res.status(409).json({ error: "that person already has a pending invitation" });
  }

  const invitation = await InvitationModel.create({
    token: crypto.randomBytes(24).toString("hex"),
    scope: "board",
    targetId: board._id,
    inviterId: req.userId,
    recipientId: userToAdd._id,
    canAddCards: !!canAdd,
    canEditCards: !!canEdit,
    canDeleteCards: !!canDelete,
  });
  const notification = await createNotification(userToAdd._id.toString(), {
    type: "board_invite",
    title: "Board invitation",
    body: `You were invited to "${board.title}" in "${workspace.name}".`,
    link: `/invite/${invitation.token}`,
  });
  await InvitationModel.updateOne(
    { _id: invitation._id },
    { $set: { notificationId: new Types.ObjectId(notification.id) } }
  );
  emitNotification(req.app.get("io"), userToAdd._id.toString(), notification);

  res.status(201).json({ invitationSent: true });
}

/**
 * PATCH /boards/:boardId/guests/:userId
 * Updates an existing guest's card-level permissions on this board. The
 * owner can always do this; other members need canEditWorkspace, same rule
 * as updateWorkspace and every other permission-setting endpoint in the app
 * — a guest's access is workspace-adjacent, so it's gated the same way a
 * workspace member's own permissions are, rather than carrying its own
 * separate owner-only rule.
 *
 * A guest can only ever be set to Viewer or Contributor here — never Full
 * access — enforced below regardless of what the request body asks for.
 * Full access would let someone outside the workspace delete cards on a
 * board they don't otherwise belong to; that's a deliberate ceiling, not an
 * oversight, so it's enforced server-side rather than only hidden from the
 * permission picker in the UI.
 */
export async function updateBoardGuestPermissions(req: Request, res: Response) {
  const { boardId, userId } = req.params;
  const { canAdd, canEdit, canDelete } = req.body;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const workspace = await WorkspaceModel.findById(board.workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "board not found" });
  }
  const callerPermissions = getMemberPermissions(workspace, req.userId!);
  if (!callerPermissions?.canEditWorkspace) {
    return res.status(403).json({ error: "you don't have permission to change a guest's permissions" });
  }

  const entry = board.guestPermissions.find((g) => g.userId.toString() === userId);
  if (!entry) {
    return res.status(404).json({ error: "that person is not a guest on this board" });
  }

  if (canAdd !== undefined) entry.canAddCards = !!canAdd;
  if (canEdit !== undefined) entry.canEditCards = !!canEdit;
  // Guests are capped at Contributor — canDeleteCards is never settable
  // through this endpoint, whatever the request asks for. See the doc
  // comment above for why.
  entry.canDeleteCards = false;

  await board.save();

  const user = await UserModel.findById(userId);
  const updatedGuest = toBoardGuestResponse(user, entry);

  // Without this, the guest's own open session never learns their access
  // changed — their UI would keep showing drag/edit as available until
  // they happened to refresh, then fail silently against the server the
  // next time they tried. BOARD_GUEST_ADDED doubles as "here's this
  // guest's current full state" for both joining and updating — the
  // client-side handler for it already upserts by id rather than only
  // inserting, so reusing it here needs no new event type.
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.BOARD_GUEST_ADDED, {
    boardId,
    guest: updatedGuest,
  });

  res.json(updatedGuest);
}

/**
 * DELETE /boards/:boardId/guests/:userId
 * Revokes a guest's access to this board entirely. Owner-only.
 */
export async function removeBoardGuest(req: Request, res: Response) {
  const { boardId, userId } = req.params;

  const board = await BoardModel.findById(boardId);
  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  const workspace = await WorkspaceModel.findById(board.workspaceId);
  if (!workspace || workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can remove a guest" });
  }

  const wasGuest = board.guestPermissions.some((guest) => guest.userId.toString() === userId);
  if (!wasGuest) {
    return res.status(404).json({ error: "that person is not a guest on this board" });
  }
  board.guestPermissions = board.guestPermissions.filter((g) => g.userId.toString() !== userId);
  await board.save();

  // Tell everyone else currently on this board that this guest is gone, so
  // their BoardMembersModal/AvatarStack drop them immediately rather than
  // only on next load — the removal counterpart to BOARD_GUEST_ADDED.
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.BOARD_GUEST_REMOVED, { boardId, userId });

  // Mirrors ACCESS_REVOKED for workspace members — sent to the removed
  // guest's own room so their client can immediately back out of this
  // board rather than finding out only when their next request 404s.
  req.app.get("io").to(`user:${userId}`).emit(SocketEvents.ACCESS_REVOKED, {
    workspaceId: board.workspaceId.toString(),
    workspaceName: workspace.name,
    resourceType: "board",
    resourceId: boardId,
    resourceName: board.title,
  });
  await notifyUser(req.app.get("io"), userId, {
    type: "board_removed",
    title: "Board access removed",
    body: `You no longer have access to "${board.title}".`,
    link: "/workspaces",
  });

  res.json({ removed: userId });
}

/** GET /boards/:boardId/invite-link — owner-only share link for one board. */
export async function getBoardInviteLink(req: Request, res: Response) {
  const { boardId } = req.params;
  const board = await BoardModel.findById(boardId);
  if (!board) return res.status(404).json({ error: "board not found" });
  const workspace = await WorkspaceModel.findById(board.workspaceId);
  if (!workspace) return res.status(404).json({ error: "board not found" });
  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can view the board invite link" });
  }
  if (!board.inviteToken) {
    board.inviteToken = crypto.randomBytes(24).toString("hex");
    await board.save();
  }
  res.json({ token: board.inviteToken });
}

/** POST /boards/:boardId/invite-link/regenerate — invalidates the old board link. */
export async function regenerateBoardInviteLink(req: Request, res: Response) {
  const { boardId } = req.params;
  const board = await BoardModel.findById(boardId);
  if (!board) return res.status(404).json({ error: "board not found" });
  const workspace = await WorkspaceModel.findById(board.workspaceId);
  if (!workspace) return res.status(404).json({ error: "board not found" });
  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can regenerate the board invite link" });
  }
  board.inviteToken = crypto.randomBytes(24).toString("hex");
  await board.save();
  res.json({ token: board.inviteToken });
}
