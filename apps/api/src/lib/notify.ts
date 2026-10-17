import { NotificationModel } from "../models/Notification";
import { SocketEvents } from "@boardwright/shared-types";
import type { Notification } from "@boardwright/shared-types";

/** Converts a Mongoose NotificationDocument into the shared `Notification` shape. */
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
 * Creates a notification and pushes it to the recipient's personal room
 * in one call, so every invite-style flow (workspace invite today,
 * board-level invites once that ships) goes through the same path
 * rather than each hand-rolling its own persist-then-emit pair. Persisted
 * first so a recipient who's offline right now still sees it the next
 * time they load the app — the socket push is purely for the "already
 * has the app open" case, on top of that.
 */
export async function createNotification(
  userId: string,
  fields: { type: Notification["type"]; title: string; body: string; link: string }
): Promise<Notification> {
  const doc = await NotificationModel.create({ userId, ...fields });
  return toNotificationResponse(doc);
}

export function emitNotification(io: any, userId: string, notification: Notification) {
  io.to(`user:${userId}`).emit(SocketEvents.NOTIFICATION_CREATED, notification);
}

export async function notifyUser(
  io: any,
  userId: string,
  fields: { type: Notification["type"]; title: string; body: string; link: string }
): Promise<Notification> {
  const notification = await createNotification(userId, fields);
  emitNotification(io, userId, notification);
  return notification;
}

export function notificationResponse(doc: any): Notification {
  return toNotificationResponse(doc);
}
