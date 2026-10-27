import { Request, Response } from "express";
import { Types } from "mongoose";
import { BoardModel } from "../models/Board";
import { InviteDecisionModel, InvitationModel } from "../models/Invitation";
import { NotificationModel } from "../models/Notification";
import { UserModel } from "../models/User";
import { WorkspaceModel } from "../models/Workspace";
import { DEFAULT_GUEST_CARD_PERMISSIONS, isWorkspaceMember } from "../lib/permissions";
import { notificationResponse, notifyUser } from "../lib/notify";
import type { InvitePreview, Workspace, WorkspaceMember } from "@boardwright/shared-types";
import { SocketEvents } from "@boardwright/shared-types";

const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

function workspaceResponse(doc: any): Workspace {
  return {
    id: doc._id.toString(),
    name: doc.name,
    ownerId: doc.ownerId.toString(),
    memberIds: doc.memberIds.map((id: Types.ObjectId) => id.toString()),
    createdAt: doc.createdAt.toISOString(),
  };
}

async function findInviteTarget(token: string) {
  const invitation = await InvitationModel.findOne({ token });
  if (invitation) {
    if (invitation.scope === "workspace") {
      const workspace = await WorkspaceModel.findById(invitation.targetId);
      return workspace ? { invitation, scope: "workspace" as const, workspace } : null;
    }
    const board = await BoardModel.findById(invitation.targetId);
    if (!board) return null;
    const workspace = await WorkspaceModel.findById(board.workspaceId);
    return workspace ? { invitation, scope: "board" as const, board, workspace } : null;
  }

  const workspace = await WorkspaceModel.findOne({ inviteToken: token });
  if (workspace) return { invitation: null, scope: "workspace" as const, workspace };
  const board = await BoardModel.findOne({ inviteToken: token });
  if (!board) return null;
  const parentWorkspace = await WorkspaceModel.findById(board.workspaceId);
  return parentWorkspace
    ? { invitation: null, scope: "board" as const, board, workspace: parentWorkspace }
    : null;
}

export async function previewInvite(req: Request, res: Response) {
  const { token } = req.params;
  const target = await findInviteTarget(token);
  if (!target) return res.status(404).json({ error: "This invitation link is invalid or has expired." });

  const inviterId = target.invitation?.inviterId ?? target.workspace.ownerId;
  const inviter = await UserModel.findById(inviterId).select("displayName");
  let status: InvitePreview["status"] = "pending";
  let snoozedUntil: string | undefined;
  let permissions: InvitePreview["permissions"];

  if (target.invitation) {
    if (req.userId && target.invitation.recipientId.toString() !== req.userId) {
      return res.status(404).json({ error: "This invitation was sent to another account." });
    }
    const alreadyHasAccess = req.userId && (
      target.scope === "workspace"
        ? isWorkspaceMember(target.workspace, req.userId)
        : isWorkspaceMember(target.workspace, req.userId) ||
          target.board.guestPermissions.some((guest) => guest.userId.toString() === req.userId)
    );
    const expiredSnooze =
      target.invitation.status === "snoozed" &&
      (!target.invitation.snoozedUntil || target.invitation.snoozedUntil.getTime() <= Date.now());
    status = alreadyHasAccess
      ? "already_has_access"
      : target.invitation.status === "accepted" || target.invitation.status === "revoked"
        ? "closed"
        : expiredSnooze
          ? "pending"
          : target.invitation.status;
    if (!expiredSnooze && target.invitation.snoozedUntil) {
      snoozedUntil = target.invitation.snoozedUntil.toISOString();
    }
    if (target.scope === "board") {
      permissions = {
        canAdd: target.invitation.canAddCards,
        canEdit: target.invitation.canEditCards,
        canDelete: target.invitation.canDeleteCards,
      };
    }
  } else if (req.userId) {
    const decision = await InviteDecisionModel.findOne({
      userId: req.userId,
      inviteToken: token,
    });
    if (target.scope === "workspace" && isWorkspaceMember(target.workspace, req.userId)) {
      status = "already_has_access";
    } else if (target.scope === "board" && (
      isWorkspaceMember(target.workspace, req.userId) ||
      target.board.guestPermissions.some((guest) => guest.userId.toString() === req.userId)
    )) {
      status = "already_has_access";
    } else if (decision?.status === "snoozed" && decision.snoozedUntil && decision.snoozedUntil > new Date()) {
      status = "snoozed";
      snoozedUntil = decision.snoozedUntil.toISOString();
    } else if (decision?.status === "declined") {
      status = "declined";
    }
  }

  const preview: InvitePreview = {
    token,
    scope: target.scope,
    workspaceName: target.workspace.name,
    ...(target.scope === "board" ? { boardName: target.board.title } : {}),
    resourceLink: target.scope === "workspace"
      ? `/workspaces/${target.workspace.id}`
      : `/boards/${target.board.id}`,
    inviterName: inviter?.displayName ?? "A workspace owner",
    status,
    ...(snoozedUntil ? { snoozedUntil } : {}),
    isDirectInvite: !!target.invitation,
    ...(permissions ? { permissions } : {}),
  };
  res.json(preview);
}

export async function respondToInvite(req: Request, res: Response) {
  const { token } = req.params;
  const { action } = req.body as { action?: string };
  if (!["accept", "decline", "snooze"].includes(action ?? "")) {
    return res.status(400).json({ error: "action must be accept, decline, or snooze" });
  }

  const target = await findInviteTarget(token);
  if (!target) return res.status(404).json({ error: "This invitation link is invalid or has expired." });

  const user = await UserModel.findById(req.userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  const io = req.app.get("io");
  const targetId = target.scope === "workspace" ? target.workspace._id : target.board._id;

  if (target.invitation && target.invitation.recipientId.toString() !== req.userId) {
    return res.status(404).json({ error: "This invitation was sent to another account." });
  }
  if (target.invitation && ["accepted", "declined", "revoked"].includes(target.invitation.status)) {
    return res.status(409).json({ error: "This invitation has already been responded to." });
  }

  const alreadyHasAccess = target.scope === "workspace"
    ? isWorkspaceMember(target.workspace, req.userId!)
    : isWorkspaceMember(target.workspace, req.userId!) ||
      target.board.guestPermissions.some((guest) => guest.userId.toString() === req.userId);

  if (action === "accept" && !alreadyHasAccess) {
    if (target.scope === "workspace") {
      target.workspace.memberIds.push(user._id);
      await target.workspace.save();

      // If this person already had single-board guest access to one or
      // more boards in this SAME workspace — invited to a board first,
      // then invited to the workspace itself later — their new membership
      // supersedes it: resolveBoardAccess checks workspace membership
      // before ever looking at guestPermissions, so the stale entry is
      // already functionally dead. But leaving it in place is a latent
      // bug, not just clutter: if they're later removed as a member, this
      // leftover entry would silently hand them back access to that one
      // board, as if they'd never been removed at all. Clean it up now so
      // there's nothing left to resurrect later.
      const staleGuestBoards = await BoardModel.find({
        workspaceId: target.workspace.id,
        "guestPermissions.userId": user._id,
      });
      if (staleGuestBoards.length > 0) {
        await BoardModel.updateMany(
          { workspaceId: target.workspace.id, "guestPermissions.userId": user._id },
          { $pull: { guestPermissions: { userId: user._id } } }
        );
        for (const board of staleGuestBoards) {
          io.to(`board:${board.id}`).emit(SocketEvents.BOARD_GUEST_REMOVED, {
            boardId: board.id,
            userId: req.userId,
          });
        }
      }

      const member: WorkspaceMember = {
        id: user._id.toString(),
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: "member",
        permissions: {
          canAdd: true, canEdit: true, canDelete: true,
          canEditWorkspace: false,
          canAddBoards: true, canEditBoards: true, canDeleteBoards: true,
          canAddCards: true, canEditCards: true, canDeleteCards: true,
        },
      };
      io.to(`workspace:${target.workspace.id}`).emit(SocketEvents.MEMBER_ADDED, {
        workspaceId: target.workspace.id,
        member,
      });
      io.to(`user:${req.userId}`).emit(SocketEvents.MEMBER_ADDED, {
        workspaceId: target.workspace.id,
        member,
        workspace: {
          ...workspaceResponse(target.workspace),
          myPermissions: member.permissions,
        },
      });
    } else {
      // An email invite (target.invitation set) carries its own
      // canAddCards/canEditCards/canDeleteCards, chosen when it was sent —
      // see addBoardGuest. The board's general share link has no per-invite
      // role picker at all (target.invitation is null there), so it falls
      // back to DEFAULT_GUEST_CARD_PERMISSIONS (Contributor), not full
      // access — the same default addBoardGuest uses when nobody picks a
      // role explicitly.
      target.board.guestPermissions.push({
        userId: user._id,
        canAddCards: target.invitation?.canAddCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canAdd,
        canEditCards: target.invitation?.canEditCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canEdit,
        canDeleteCards: target.invitation?.canDeleteCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canDelete,
      });
      await target.board.save();
      io.to(`user:${req.userId}`).emit(SocketEvents.ACCESS_GRANTED, {
        workspaceId: target.workspace.id,
        workspaceName: target.workspace.name,
        resourceType: "board",
        resourceId: target.board.id,
        resourceName: target.board.title,
      });
      // Tell everyone ALREADY on this board — the owner and any workspace
      // member with it open — that a new guest just joined, so their
      // BoardMembersModal/AvatarStack update live instead of only catching
      // up on their next full page load. Mirrors MEMBER_ADDED's broadcast
      // to the workspace room; board:<id> is the equivalent room for a
      // single board (joined via the "join-board" socket event).
      const addedGuest = {
        id: user._id.toString(),
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        permissions: {
          canAdd: target.invitation?.canAddCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canAdd,
          canEdit: target.invitation?.canEditCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canEdit,
          canDelete: target.invitation?.canDeleteCards ?? DEFAULT_GUEST_CARD_PERMISSIONS.canDelete,
        },
      };
      io.to(`board:${target.board.id}`).emit(SocketEvents.BOARD_GUEST_ADDED, {
        boardId: target.board.id,
        guest: addedGuest,
      });
    }
  }

  if (target.invitation) {
    target.invitation.status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "snoozed";
    target.invitation.snoozedUntil = action === "snooze" ? new Date(Date.now() + SNOOZE_DURATION_MS) : undefined;
    await target.invitation.save();
    if (target.invitation.notificationId) {
      const notification = await NotificationModel.findByIdAndUpdate(
        target.invitation.notificationId,
        {
          ...(action === "snooze"
            ? { snoozedUntil: target.invitation.snoozedUntil, isResolved: false, isRead: true }
            : { isResolved: true, snoozedUntil: null, isRead: true }),
        },
        { new: true }
      );
      if (notification) {
        io.to(`user:${req.userId}`).emit(SocketEvents.NOTIFICATION_UPDATED, notificationResponse(notification));
      }
    }
    if (action !== "snooze") {
      const actionLabel = action === "accept" ? "accepted" : "declined";
      await notifyUser(io, target.invitation.inviterId.toString(), {
        type: "invitation_response",
        title: `Invitation ${actionLabel}`,
        body: `${user.displayName} ${actionLabel} your invitation to ${target.scope === "workspace" ? `"${target.workspace.name}"` : `"${target.board.title}"`}.`,
        link: target.scope === "workspace" ? `/workspaces/${target.workspace.id}` : `/boards/${target.board.id}`,
      });
    }
  } else {
    await InviteDecisionModel.findOneAndUpdate(
      { userId: user._id, inviteToken: token },
      {
        scope: target.scope,
        targetId,
        inviteToken: token,
        status: action === "accept" ? "accepted" : action === "decline" ? "declined" : "snoozed",
        snoozedUntil: action === "snooze" ? new Date(Date.now() + SNOOZE_DURATION_MS) : null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (action !== "snooze") {
      // Share links don't have a separate invite record, so the resource
      // owner is the inviter to notify about the outcome.
      const actionLabel = action === "accept" ? "accepted" : "declined";
      await notifyUser(io, target.workspace.ownerId.toString(), {
        type: "invitation_response",
        title: `Invite link ${actionLabel}`,
        body: `${user.displayName} ${actionLabel} your invitation to "${target.scope === "workspace" ? target.workspace.name : target.board.title}".`,
        link: target.scope === "workspace" ? `/workspaces/${target.workspace.id}` : `/boards/${target.board.id}`,
      });
    }
  }

  res.json({
    action,
    status: action === "snooze" ? "snoozed" : action === "decline" ? "declined" : "accepted",
    snoozedUntil: action === "snooze" ? new Date(Date.now() + SNOOZE_DURATION_MS).toISOString() : undefined,
    link: target.scope === "workspace" ? `/workspaces/${target.workspace.id}` : `/boards/${target.board.id}`,
  });
}
