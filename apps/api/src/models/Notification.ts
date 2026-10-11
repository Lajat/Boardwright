import { Schema, model, Document, Types } from "mongoose";
import type { NotificationType } from "@fluxboard/shared-types";

/** Mongoose document shape for a persisted notification. */
export interface NotificationDocument extends Document {
  userId: Types.ObjectId; // recipient
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  isRead: boolean;
  isResolved: boolean;
  snoozedUntil?: Date;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDocument>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  link: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  isResolved: { type: Boolean, default: false },
  snoozedUntil: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

// Every notification list/unread-count query filters by userId and sorts
// by recency — this compound index is what makes both fast as the
// collection grows, rather than a full scan per request.
notificationSchema.index({ userId: 1, createdAt: -1 });

export const NotificationModel = model<NotificationDocument>("Notification", notificationSchema);
