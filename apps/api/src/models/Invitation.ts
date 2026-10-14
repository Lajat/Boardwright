import { Schema, model, Document, Types } from "mongoose";

export type InvitationScope = "workspace" | "board";
export type InvitationStatus = "pending" | "snoozed" | "accepted" | "declined" | "revoked";

export interface InvitationDocument extends Document {
  token: string;
  scope: InvitationScope;
  targetId: Types.ObjectId;
  inviterId: Types.ObjectId;
  recipientId: Types.ObjectId;
  status: InvitationStatus;
  canAddCards: boolean;
  canEditCards: boolean;
  canDeleteCards: boolean;
  notificationId?: Types.ObjectId;
  snoozedUntil?: Date;
  createdAt: Date;
}

const invitationSchema = new Schema<InvitationDocument>({
  token: { type: String, required: true, unique: true },
  scope: { type: String, enum: ["workspace", "board"], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  inviterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["pending", "snoozed", "accepted", "declined", "revoked"], default: "pending" },
  // Contributor by default — see DEFAULT_GUEST_CARD_PERMISSIONS in
  // lib/permissions.ts. Only meaningful for scope "board": a workspace-scope
  // invite's acceptance path (respondToInvite) grants full workspace-member
  // permissions unconditionally and never reads these three fields at all.
  canAddCards: { type: Boolean, default: true },
  canEditCards: { type: Boolean, default: true },
  canDeleteCards: { type: Boolean, default: false },
  notificationId: { type: Schema.Types.ObjectId, ref: "Notification" },
  snoozedUntil: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

invitationSchema.index({ recipientId: 1, status: 1, createdAt: -1 });
invitationSchema.index({ scope: 1, targetId: 1, recipientId: 1, status: 1 });

export const InvitationModel = model<InvitationDocument>("Invitation", invitationSchema);

export interface InviteDecisionDocument extends Document {
  userId: Types.ObjectId;
  scope: InvitationScope;
  targetId: Types.ObjectId;
  inviteToken: string;
  status: "snoozed" | "declined" | "accepted";
  snoozedUntil?: Date;
}

const inviteDecisionSchema = new Schema<InviteDecisionDocument>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  scope: { type: String, enum: ["workspace", "board"], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  inviteToken: { type: String, required: true },
  status: { type: String, enum: ["snoozed", "declined", "accepted"], required: true },
  snoozedUntil: { type: Date },
});

inviteDecisionSchema.index({ userId: 1, inviteToken: 1 }, { unique: true });

export const InviteDecisionModel = model<InviteDecisionDocument>("InviteDecision", inviteDecisionSchema);
