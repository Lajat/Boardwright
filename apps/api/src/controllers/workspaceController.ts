import { Request, Response } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { WorkspaceModel } from "../models/Workspace";
import { UserModel } from "../models/User";
import { BoardModel } from "../models/Board";
import { ListModel } from "../models/List";
import { CardModel } from "../models/Card";
import type { Workspace, WorkspaceMember, WorkspaceMemberPreview } from "@boardwright/shared-types";
import { SocketEvents } from "@boardwright/shared-types";
import { getMemberPermissions } from "../lib/permissions";
import { createNotification, emitNotification, notificationResponse, notifyUser } from "../lib/notify";
import { InvitationModel } from "../models/Invitation";
import { NotificationModel } from "../models/Notification";

/** Converts a Mongoose WorkspaceDocument into the shared `Workspace` shape sent to the frontend. */
function toWorkspaceResponse(doc: any, memberPreview?: WorkspaceMemberPreview[]): Workspace {
  return {
    id: doc._id.toString(),
    name: doc.name,
    ownerId: doc.ownerId.toString(),
    memberIds: doc.memberIds.map((id: Types.ObjectId) => id.toString()),
    memberCount: doc.memberIds.length,
    createdAt: doc.createdAt.toISOString(),
    ...(memberPreview ? { memberPreview } : {}),
  };
}

/**
 * POST /workspaces
 * Creates a new workspace, owned by the logged-in user (req.userId is set
 * by requireAuth). The owner is automatically added as the first member.
 */
export async function createWorkspace(req: Request, res: Response) {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  const workspace = await WorkspaceModel.create({
    name,
    ownerId: req.userId,
    memberIds: [req.userId],
  });

  // Without this, the sidebar (which fetches its own independent copy of
  // the workspace list) never learns a new workspace was created — only
  // the /workspaces page's own local state did, via the HTTP response
  // below. Reusing the exact MEMBER_ADDED event/payload shape that
  // addMember and joinViaInviteLink already emit to a new member's own
  // room means the sidebar's existing handler picks this up for free,
  // with no separate "workspace created" event or frontend change needed
  // — creating a workspace IS adding yourself as its first member.
  const creator = await UserModel.findById(req.userId);
  const memberPreview = creator ? [toMemberPreview(creator)] : [];
  const workspaceResponse = {
    ...toWorkspaceResponse(workspace, memberPreview),
    myPermissions: getMemberPermissions(workspace, req.userId!)!,
  };
  if (creator) {
    const member = toMemberResponse(creator, workspace);
    req.app.get("io").to(`user:${req.userId}`).emit(SocketEvents.MEMBER_ADDED, {
      workspaceId: workspace.id,
      member,
      workspace: workspaceResponse,
    });
  }

  res.status(201).json(workspaceResponse);
}

/**
 * GET /workspaces
 * Lists every workspace the logged-in user is a member of (including ones
 * they own, since ownerId is always mirrored into memberIds on creation).
 */
export async function listMyWorkspaces(req: Request, res: Response) {
  const [workspaces, guestBoards] = await Promise.all([
    WorkspaceModel.find({ memberIds: req.userId }),
    BoardModel.find({ "guestPermissions.userId": req.userId }).select("workspaceId"),
  ]);
  const memberWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const guestWorkspaceIds = [...new Set(
    guestBoards
      .map((board) => board.workspaceId.toString())
      .filter((workspaceId) => !memberWorkspaceIds.has(workspaceId))
  )];
  const guestWorkspaces = guestWorkspaceIds.length
    ? await WorkspaceModel.find({ _id: { $in: guestWorkspaceIds } })
    : [];
  const allWorkspaces = [...workspaces, ...guestWorkspaces];
  const memberIds = [...new Set(workspaces.flatMap((workspace) => workspace.memberIds.map((id) => id.toString())))];
  const users = await UserModel.find({ _id: { $in: memberIds } }).select("_id displayName avatarUrl");
  const membersById = new Map(users.map((user) => [user._id.toString(), toMemberPreview(user)]));
  res.json({
    items: allWorkspaces.map((workspace) => {
      if (!memberWorkspaceIds.has(workspace.id)) {
        // memberIds and ownerId are blanked out here on purpose — a board
        // guest doesn't get to see the workspace's real roster or who owns
        // it, same as everywhere else that distinction is enforced. The
        // real member COUNT isn't part of that: it's computed from the
        // workspace doc's actual memberIds BEFORE stripping, passed
        // through separately, so "N members" on the card stays honest
        // without the stripped memberIds leaking anyone's identity.
        const realMemberCount = workspace.memberIds.length;
        return {
          ...toWorkspaceResponse({
            ...workspace.toObject(),
            memberIds: [],
            ownerId: "",
          }),
          memberCount: realMemberCount,
          isBoardGuest: true,
          myPermissions: {
            canAdd: false, canEdit: false, canDelete: false,
            canEditWorkspace: false,
            canAddBoards: false, canEditBoards: false, canDeleteBoards: false,
            canAddCards: false, canEditCards: false, canDeleteCards: false,
          },
        };
      }
      const memberPreview = workspace.memberIds
        .map((id) => membersById.get(id.toString()))
        .filter((member): member is WorkspaceMemberPreview => member !== undefined)
        .sort((a, b) =>
          a.id === workspace.ownerId.toString()
            ? -1
            : b.id === workspace.ownerId.toString()
              ? 1
              : a.displayName.localeCompare(b.displayName)
        );
      return {
        ...toWorkspaceResponse(workspace, memberPreview),
        myPermissions: getMemberPermissions(workspace, req.userId!)!,
      };
    }),
  });
}

/**
 * GET /workspaces/:workspaceId
 * Returns a single workspace — but only if the requester is a member.
 * This is the access-control check every Board/List/Card route further
 * down the chain ultimately relies on: no membership, no visibility.
 */
export async function getWorkspace(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const isMember = workspace.memberIds.some((id) => id.toString() === req.userId);
  if (!isMember) {
    const guestBoard = await BoardModel.exists({
      workspaceId,
      guestPermissions: { $elemMatch: { userId: req.userId } },
    });
    if (guestBoard) {
      // Same reasoning as listMyWorkspaces' guest branch: memberIds/ownerId
      // are blanked for a guest caller, but the real member count isn't
      // part of what's being kept private, so it's preserved separately.
      return res.json({
        ...toWorkspaceResponse({ ...workspace.toObject(), memberIds: [], ownerId: "" }),
        memberCount: workspace.memberIds.length,
        isBoardGuest: true,
        myPermissions: {
          canAdd: false, canEdit: false, canDelete: false,
          canEditWorkspace: false,
          canAddBoards: false, canEditBoards: false, canDeleteBoards: false,
          canAddCards: false, canEditCards: false, canDeleteCards: false,
        },
      });
    }
    // 404, not 403 — confirming a workspace exists to a non-member is its
    // own small information leak (reveals the id is valid/in-use).
    return res.status(404).json({ error: "workspace not found" });
  }

  res.json({ ...toWorkspaceResponse(workspace), myPermissions: getMemberPermissions(workspace, req.userId!)! });
}

/**
 * PATCH /workspaces/:workspaceId
 * Renames a workspace. The owner can always do so; other members need the
 * explicit canEditWorkspace permission.
 */
export async function updateWorkspace(req: Request, res: Response) {
  const { workspaceId } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const permissions = getMemberPermissions(workspace, req.userId!);
  if (!permissions) {
    return res.status(404).json({ error: "workspace not found" });
  }
  if (!permissions.canEditWorkspace) {
    return res.status(403).json({ error: "you don't have permission to edit this workspace" });
  }

  workspace.name = name;
  await workspace.save();

  const workspaceResponse = {
    ...toWorkspaceResponse(workspace),
    myPermissions: getMemberPermissions(workspace, req.userId!)!,
  };
  req.app.get("io").to(`workspace:${workspaceId}`).emit(SocketEvents.WORKSPACE_UPDATED, toWorkspaceResponse(workspace));

  res.json(workspaceResponse);
}

/**
 * DELETE /workspaces/:workspaceId
 * Deletes a workspace and cascades all the way down: every Board in it,
 * every List on those boards, and every Card in those lists. Restricted
 * to the owner only — unlike renaming, this is destructive and
 * irreversible for every member, not just the person clicking delete.
 */
export async function deleteWorkspace(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can delete this workspace" });
  }

  const boards = await BoardModel.find({ workspaceId });
  const boardIds = boards.map((b) => b._id);

  const lists = await ListModel.find({ boardId: { $in: boardIds } });
  const listIds = lists.map((l) => l._id);

  // Delete children before parents so each successful step preserves
  // referential consistency. These operations are not transactional, so a
  // database failure can still leave the cascade incomplete and should be
  // surfaced for operational recovery.
  await CardModel.deleteMany({ listId: { $in: listIds } });
  await ListModel.deleteMany({ boardId: { $in: boardIds } });
  await BoardModel.deleteMany({ workspaceId });
  await WorkspaceModel.findByIdAndDelete(workspaceId);

  const workspaceResponse = toWorkspaceResponse(workspace);
  const io = req.app.get("io");
  io.to(`workspace:${workspaceId}`).emit(SocketEvents.WORKSPACE_DELETED, workspaceResponse);
  // Most pages are not subscribed to the workspace room, but every member
  // is always in their personal room so persistent navigation can remove it.
  for (const memberId of workspace.memberIds) {
    io.to(`user:${memberId.toString()}`).emit(SocketEvents.WORKSPACE_DELETED, workspaceResponse);
  }

  res.json({ deleted: workspaceResponse });
}

/**
 * Shapes a User document (owner or member) into the WorkspaceMember shape
 * the frontend renders as an avatar. Kept as one function so the "owner
 * badge" logic lives in exactly one place.
 */
function toMemberResponse(user: any, workspace: any): WorkspaceMember {
  const userId = user._id.toString();
  return {
    id: userId,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: userId === workspace.ownerId.toString() ? "owner" : "member",
    // Falls back to full permissions if somehow called for a non-member
    // (shouldn't happen given every call site already filters to actual
    // members first) rather than crashing on a null.
    permissions: getMemberPermissions(workspace, userId) ?? {
      canAdd: true,
      canEdit: true,
      canDelete: true,
      canEditWorkspace: workspace.ownerId.toString() === userId,
      canAddBoards: true,
      canEditBoards: true,
      canDeleteBoards: true,
      canAddCards: true,
      canEditCards: true,
      canDeleteCards: true,
    },
  };
}

function toMemberPreview(user: any): WorkspaceMemberPreview {
  return {
    id: user._id.toString(),
    displayName: user.displayName,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/**
 * GET /workspaces/:workspaceId/members
 * Returns every member's basic profile (for the avatar stack), owner
 * first. Separate from GET /workspaces/:workspaceId because the bare
 * Workspace shape only carries member *ids* — most callers don't need a
 * full profile fetch for every member just to check who has access.
 */
export async function listMembers(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const isMember = workspace.memberIds.some((id) => id.toString() === req.userId);
  if (!isMember) {
    return res.status(404).json({ error: "workspace not found" });
  }

  const users = await UserModel.find({ _id: { $in: workspace.memberIds } });
  const members = users
    .map((u) => toMemberResponse(u, workspace))
    // Owner first, then everyone else alphabetically by name — a stable,
    // predictable order rather than whatever order Mongo happened to
    // return documents in.
    .sort((a, b) =>
      a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === "owner" ? -1 : 1
    );

  res.json({ items: members });
}

/**
 * POST /workspaces/:workspaceId/members
 * Sends an existing user a workspace invitation. Membership is granted
 * only after they accept, so opening a notification or shared link never
 * silently exposes every board in the workspace.
 */
export async function addMember(req: Request, res: Response) {
  const { workspaceId } = req.params;
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can add members" });
  }

  const userToAdd = await UserModel.findOne({ email: email.toLowerCase() });
  if (!userToAdd) {
    return res.status(404).json({ error: "no user found with that email" });
  }

  const alreadyMember = workspace.memberIds.some(
    (id) => id.toString() === userToAdd._id.toString()
  );

  if (alreadyMember) {
    return res.status(409).json({ error: "that person is already a member of this workspace" });
  }

  const io = req.app.get("io");
  const hasPendingInvitation = await InvitationModel.exists({
    scope: "workspace",
    targetId: workspace._id,
    recipientId: userToAdd._id,
    status: { $in: ["pending", "snoozed"] },
  });
  if (hasPendingInvitation) {
    return res.status(409).json({ error: "that person already has a pending invitation" });
  }

  const invitation = await InvitationModel.create({
    token: crypto.randomBytes(24).toString("hex"),
    scope: "workspace",
    targetId: workspace._id,
    inviterId: req.userId,
    recipientId: userToAdd._id,
  });
  const notification = await createNotification(userToAdd._id.toString(), {
    type: "workspace_invite",
    title: "Workspace invitation",
    body: `You were invited to join "${workspace.name}".`,
    link: `/invite/${invitation.token}`,
  });
  await InvitationModel.updateOne(
    { _id: invitation._id },
    { $set: { notificationId: new Types.ObjectId(notification.id) } }
  );
  emitNotification(io, userToAdd._id.toString(), notification);

  res.status(201).json({ invitationSent: true });
}

/**
 * DELETE /workspaces/:workspaceId/members/:userId
 * Removes a member from the workspace. Owner-only, and the owner can't
 * remove themselves this way — that would leave the workspace ownerless;
 * "delete the whole workspace" is the deliberate, explicit action for
 * that instead of an implicit side effect of a member-removal call.
 */
export async function removeMember(req: Request, res: Response) {
  const { workspaceId, userId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can remove members" });
  }

  if (userId === workspace.ownerId.toString()) {
    return res.status(400).json({ error: "the workspace owner can't be removed" });
  }

  const wasMember = workspace.memberIds.some((id) => id.toString() === userId);
  if (!wasMember) {
    return res.status(404).json({ error: "that person is not a member of this workspace" });
  }

  workspace.memberIds = workspace.memberIds.filter((id) => id.toString() !== userId);
  // Also drop any permission override for them — harmless to leave behind
  // (getMemberPermissions checks memberIds first and would never look it
  // up again), but cleaning it up avoids the array quietly accumulating
  // dead entries for people who've been removed and re-invited multiple
  // times over a workspace's life.
  workspace.memberPermissions = workspace.memberPermissions.filter(
    (p) => p.userId.toString() !== userId
  );
  await workspace.save();

  const io = req.app.get("io");
  io.to(`workspace:${workspaceId}`).emit(SocketEvents.MEMBER_REMOVED, { workspaceId, userId });
  // The removed user gets their own dedicated event so their client can
  // immediately back out of this workspace (and any of its boards it has
  // open) rather than finding out only when their next request 404s.
  io.to(`user:${userId}`).emit(SocketEvents.ACCESS_REVOKED, {
    workspaceId,
    workspaceName: workspace.name,
    resourceType: "workspace",
    resourceId: workspaceId,
    resourceName: workspace.name,
  });

  await notifyUser(io, userId, {
    type: "workspace_removed",
    title: "Workspace access removed",
    body: `You no longer have access to "${workspace.name}".`,
    link: "/workspaces",
  });
  const pendingInvitations = await InvitationModel.find(
    { scope: "workspace", targetId: workspace._id, recipientId: userId, status: { $in: ["pending", "snoozed"] } },
    { notificationId: 1 }
  );
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
      io.to(`user:${userId}`).emit(SocketEvents.NOTIFICATION_UPDATED, notificationResponse(notification));
    }
  }

  res.json({ removed: userId });
}

/**
 * PATCH /workspaces/:workspaceId/members/:userId/permissions
 * Sets a member's workspace-, board-, and card-level permission flags
 * (see WorkspacePermissions in shared-types for what each
 * means) — each field is optional in the request body so the owner can
 * flip just one switch at a time without resending the whole set.
 * Owner-only, and the owner can't be targeted (their permissions are
 * always full, by definition — see getMemberPermissions).
 *
 * Enforces the delete-requires-add+edit rule server-side, independently
 * on each axis — the UI disables the Delete checkbox accordingly, but
 * that's a convenience, not the actual guarantee; a direct API call
 * bypasses a client-side-only rule entirely, same reasoning as the
 * dueDate validation in cardController.
 */
export async function updateMemberPermissions(req: Request, res: Response) {
  const { workspaceId, userId } = req.params;
  const {
    canEditWorkspace,
    canAddBoards,
    canEditBoards,
    canDeleteBoards,
    canAddCards,
    canEditCards,
    canDeleteCards,
  } = req.body;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can change member permissions" });
  }

  if (userId === workspace.ownerId.toString()) {
    return res.status(400).json({ error: "the workspace owner's permissions can't be changed" });
  }

  const isMember = workspace.memberIds.some((id) => id.toString() === userId);
  if (!isMember) {
    return res.status(404).json({ error: "that person is not a member of this workspace" });
  }

  let entry = workspace.memberPermissions.find((p) => p.userId.toString() === userId);
  if (!entry) {
    entry = {
      userId: new Types.ObjectId(userId),
      canEditWorkspace: false,
      canAddBoards: true, canEditBoards: true, canDeleteBoards: true,
      canAddCards: true, canEditCards: true, canDeleteCards: true,
    };
    workspace.memberPermissions.push(entry);
  } else if (entry.canAddBoards === undefined && entry.canAdd !== undefined) {
    // This entry still has the pre-migration shape (see
    // getMemberPermissions for the read-side of this same
    // compatibility handling) — the moment an owner touches it through
    // this endpoint, upgrade it to the new shape by mapping the old
    // uniform restriction onto both axes, so it's stored in the current
    // format going forward rather than perpetuating the old one.
    entry.canAddBoards = entry.canAdd;
    entry.canEditBoards = entry.canEdit;
    entry.canDeleteBoards = entry.canDelete;
    entry.canAddCards = entry.canAdd;
    entry.canEditCards = entry.canEdit;
    entry.canDeleteCards = entry.canDelete;
  }

  if (canEditWorkspace !== undefined) entry.canEditWorkspace = !!canEditWorkspace;
  if (canAddBoards !== undefined) entry.canAddBoards = !!canAddBoards;
  if (canEditBoards !== undefined) entry.canEditBoards = !!canEditBoards;
  if (canDeleteBoards !== undefined) entry.canDeleteBoards = !!canDeleteBoards;
  if (canAddCards !== undefined) entry.canAddCards = !!canAddCards;
  if (canEditCards !== undefined) entry.canEditCards = !!canEditCards;
  if (canDeleteCards !== undefined) entry.canDeleteCards = !!canDeleteCards;

  // Dependency rule, each axis independently: Delete requires Add AND
  // Edit to already be true on that same axis, after this request's
  // changes are applied — not just at the moment Delete was checked, so
  // a request that tries to grant Delete while simultaneously revoking
  // Add/Edit is rejected too, not just the "Delete alone" case.
  if (entry.canDeleteBoards && !(entry.canAddBoards && entry.canEditBoards)) {
    return res.status(400).json({ error: "canDeleteBoards requires canAddBoards and canEditBoards to also be true" });
  }
  if (entry.canDeleteCards && !(entry.canAddCards && entry.canEditCards)) {
    return res.status(400).json({ error: "canDeleteCards requires canAddCards and canEditCards to also be true" });
  }

  await workspace.save();

  const user = await UserModel.findById(userId);
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }

  const member = toMemberResponse(user, workspace);
  const io = req.app.get("io");
  // Everyone looking at this workspace's member list sees the change
  // live, and the affected member's own client can update what UI it
  // shows them (e.g. disabling the "Add card" button) without needing to
  // refresh.
  io.to(`workspace:${workspaceId}`).emit(SocketEvents.MEMBER_PERMISSIONS_UPDATED, {
    workspaceId,
    member,
  });
  io.to(`user:${userId}`).emit(SocketEvents.MEMBER_PERMISSIONS_UPDATED, { workspaceId, member });

  res.json({ member });
}

/**
 * GET /workspaces/:workspaceId/invite-link
 * Returns this workspace's shareable join link token, generating one on
 * first request if it doesn't have one yet (lazy generation, rather than
 * a migration, so workspaces created before this feature existed still
 * work without any manual backfill). Owner-only, same permission level as
 * managing members directly — anyone holding the resulting link can add
 * themselves to the workspace, so who's allowed to *see* that link should
 * match who's allowed to invite in the first place.
 */
export async function getInviteLink(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can view the invite link" });
  }

  if (!workspace.inviteToken) {
    workspace.inviteToken = crypto.randomBytes(16).toString("hex");
    await workspace.save();
  }

  res.json({ token: workspace.inviteToken });
}

/**
 * POST /workspaces/:workspaceId/invite-link/regenerate
 * Rotates the invite token, immediately invalidating any previously
 * shared link — the "revoke" half of the invite-link flow. Owner-only.
 */
export async function regenerateInviteLink(req: Request, res: Response) {
  const { workspaceId } = req.params;

  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: "workspace not found" });
  }

  if (workspace.ownerId.toString() !== req.userId) {
    return res.status(403).json({ error: "only the workspace owner can regenerate the invite link" });
  }

  workspace.inviteToken = crypto.randomBytes(16).toString("hex");
  await workspace.save();

  res.json({ token: workspace.inviteToken });
}

/**
 * POST /invites/:token/join
 * Adds the currently-logged-in user to whichever workspace this token
 * belongs to. This is the whole point of the invite-link flow: it works
 * for anyone with an account, not just people the owner already knows the
 * email of — they just need the link. requireAuth still guards this route
 * (see inviteRoutes.ts), so an anonymous visitor hits the frontend's
 * login/signup flow first; only an authenticated request reaches here.
 */
export async function joinViaInviteLink(req: Request, res: Response) {
  const { token } = req.params;

  const workspace = await WorkspaceModel.findOne({ inviteToken: token });
  if (!workspace) {
    return res.status(404).json({ error: "this invite link is invalid or has been revoked" });
  }

  const alreadyMember = workspace.memberIds.some((id) => id.toString() === req.userId);
  if (!alreadyMember) {
    workspace.memberIds.push(new Types.ObjectId(req.userId));
    await workspace.save();
  }

  const user = await UserModel.findById(req.userId);
  if (!user) {
    return res.status(404).json({ error: "user not found" });
  }

  const member = toMemberResponse(user, workspace);
  const workspaceResponse = toWorkspaceResponse(workspace);

  if (!alreadyMember) {
    // Same live-update behavior as the email-based addMember flow: notify
    // anyone already looking at this workspace, and separately notify the
    // new member's own personal room in case they have the app open
    // elsewhere (e.g. they opened the invite link in a new tab).
    const io = req.app.get("io");
    io.to(`workspace:${workspace.id}`).emit(SocketEvents.MEMBER_ADDED, {
      workspaceId: workspace.id,
      member,
    });
    io.to(`user:${req.userId}`).emit(SocketEvents.MEMBER_ADDED, {
      workspaceId: workspace.id,
      member,
      workspace: workspaceResponse,
    });
  }

  res.json({ workspace: workspaceResponse, member, alreadyMember });
}
