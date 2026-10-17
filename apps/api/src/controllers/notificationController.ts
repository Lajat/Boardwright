import { Request, Response } from "express";
import { NotificationModel } from "../models/Notification";
import { SocketEvents } from "@boardwright/shared-types";
import { InvitationModel } from "../models/Invitation";
import type { Notification } from "@boardwright/shared-types";

function toNotificationResponse(doc: any): Notification {
  return {
    id: doc._id.toString(),
    type: doc.type,
    title: doc.title,
    body: doc.body,
    link: doc.link,
    isRead: doc.isRead,
    isResolved: doc.isResolved ?? !doc.link.startsWith("/invite/"),
    ...(doc.snoozedUntil ? { snoozedUntil: doc.snoozedUntil.toISOString() } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * GET /notifications
 * The most recent 30 notifications for the logged-in user, newest first,
 * plus a separate unread count — the bell icon needs the count even for
 * notifications beyond whatever page/limit is shown in the dropdown, so
 * it's computed independently rather than derived from the returned list.
 */
export async function listNotifications(req: Request, res: Response) {
  const now = new Date();
  const dueInvitations = await NotificationModel.find({
    userId: req.userId,
    type: { $in: ["workspace_invite", "board_invite"] },
    isResolved: false,
    snoozedUntil: { $lte: now },
  });
  if (dueInvitations.length) {
    const dueIds = dueInvitations.map((item) => item._id);
    await NotificationModel.updateMany(
      { _id: { $in: dueIds } },
      { $set: { isRead: false }, $unset: { snoozedUntil: 1 } }
    );
    await InvitationModel.updateMany(
      { recipientId: req.userId, status: "snoozed", snoozedUntil: { $lte: now } },
      { $set: { status: "pending" }, $unset: { snoozedUntil: 1 } }
    );
    const io = req.app.get("io");
    for (const notification of dueInvitations) {
      io.to(`user:${req.userId}`).emit(
        SocketEvents.NOTIFICATION_UPDATED,
        toNotificationResponse({ ...notification.toObject(), isRead: false, snoozedUntil: undefined })
      );
    }
  }

  const [items, unreadCount] = await Promise.all([
    NotificationModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(30),
    NotificationModel.countDocuments({ userId: req.userId, isRead: false }),
  ]);

  res.json({ items: items.map(toNotificationResponse), unreadCount });
}

/**
 * PATCH /notifications/:notificationId/read
 * Marks a single notification as read — scoped to req.userId in the
 * query itself (not just fetched-then-checked), so there's no way to
 * mark another user's notification as read even by guessing an id.
 */
export async function markNotificationRead(req: Request, res: Response) {
  const { notificationId } = req.params;

  const notification = await NotificationModel.findOneAndUpdate(
    { _id: notificationId, userId: req.userId },
    { isRead: true },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json({ error: "notification not found" });
  }

  req.app.get("io").to(`user:${req.userId}`).emit(
    SocketEvents.NOTIFICATION_UPDATED,
    toNotificationResponse(notification)
  );
  res.json(toNotificationResponse(notification));
}

/**
 * PATCH /notifications/read-all
 * Marks every one of the current user's notifications as read — the
 * "clear all" action in the dropdown.
 */
export async function markAllNotificationsRead(req: Request, res: Response) {
  const unread = await NotificationModel.find({ userId: req.userId, isRead: false });
  await NotificationModel.updateMany({ userId: req.userId, isRead: false }, { isRead: true });
  const io = req.app.get("io");
  for (const notification of unread) {
    io.to(`user:${req.userId}`).emit(
      SocketEvents.NOTIFICATION_UPDATED,
      toNotificationResponse({ ...notification.toObject(), isRead: true })
    );
  }
  res.json({ ok: true });
}
