import { Schema, model, Document, Types } from "mongoose";

/**
 * A guest's card-level permissions on ONE specific board, for someone who
 * is NOT a member of the board's workspace at all — a "single-board
 * guest" in the same sense Trello uses the term: they can see and work
 * on exactly this board, nothing else in the workspace (other boards or
 * its member list). The parent workspace name is shown only as context.
 * No board-level
 * permissions exist for a guest — they can never rename/delete the board
 * itself or create sibling boards, only add/edit/delete within it,
 * matching the same delete-requires-add+edit rule as workspace members.
 */
export interface BoardGuestEntry {
  userId: Types.ObjectId;
  canAddCards: boolean;
  canEditCards: boolean;
  canDeleteCards: boolean;
}

/** Mongoose document shape for a Board. See User.ts for why this differs from the shared-types shape. */
export interface BoardDocument extends Document {
  workspaceId: Types.ObjectId;
  title: string;
  listOrder: Types.ObjectId[];
  // Short uppercase prefix used to build human-readable card task IDs
  // (e.g. "BT" -> cards are "BT-1", "BT-2", ...) — generated once from the
  // board's title at creation time and then fixed, the same way a Jira
  // project key doesn't change if you rename the project afterward: task
  // IDs that already exist and may be written down/linked elsewhere
  // should never silently change out from under you.
  //
  // Optional/lazily-generated (same pattern as Workspace.inviteToken)
  // rather than required, so boards created before this feature existed
  // don't fail validation on their next save — cardController backfills
  // this the first time a card is created on such a board.
  keyPrefix?: string;
  // How many cards have ever been created on this board, used only to
  // hand out the next task ID number. Deliberately never decremented on
  // delete — task IDs are meant to be stable, unique references, not a
  // live count, so "BT-3" being deleted should never let a future card
  // reuse that same number.
  cardCounter: number;
  guestPermissions: BoardGuestEntry[];
  inviteToken?: string;
  createdAt: Date;
}

const boardGuestSchema = new Schema<BoardGuestEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    canAddCards: { type: Boolean, default: true },
    canEditCards: { type: Boolean, default: true },
    canDeleteCards: { type: Boolean, default: true },
  },
  { _id: false }
);

const boardSchema = new Schema<BoardDocument>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  title: { type: String, required: true, trim: true },
  // Ordered array of List _ids — this array's order IS the left-to-right
  // column order shown on screen. Reordering columns means reordering this
  // array, not adding a separate "position" field on each List.
  listOrder: [{ type: Schema.Types.ObjectId, ref: "List" }],
  keyPrefix: { type: String },
  cardCounter: { type: Number, default: 0 },
  guestPermissions: { type: [boardGuestSchema], default: [] },
  inviteToken: { type: String, index: true, sparse: true },
  createdAt: { type: Date, default: Date.now },
});

export const BoardModel = model<BoardDocument>("Board", boardSchema);
