import { Schema, model, Document, Types } from "mongoose";

/** Mongoose document shape for a Card (a single task). */
export interface CardDocument extends Document {
  listId: Types.ObjectId;
  title: string;
  description?: string;
  assigneeId?: Types.ObjectId;
  dueDate?: Date;
  labels?: string[];
  priority?: "low" | "medium" | "high";
  // Human-readable, board-scoped id like "BT-7" — see Board.cardCounter
  // and lib/taskId.ts for how this is generated. Optional in the type
  // only because cards created before this feature existed won't have
  // one; every card created going forward always gets one at creation
  // time in cardController.createCard, never generated retroactively (a
  // stable, permanent id is the whole point of it).
  taskId?: string;
  // Optional for the same reason taskId is: cards created before this
  // field existed won't have one, and it's never backfilled retroactively
  // — a stable record of "who actually did this" is only meaningful if
  // it's set at the real moment of creation/edit, not guessed after the
  // fact.
  createdBy?: Types.ObjectId;
  // Set alongside createdBy at creation (so a brand-new card already has a
  // sensible "last updated by" before anyone's touched it), then
  // reassigned on every updateCard call — but NOT on a drag-and-drop move
  // between lists, which changes position, not content.
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const cardSchema = new Schema<CardDocument>(
  {
    listId: { type: Schema.Types.ObjectId, ref: "List", required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String },
    assigneeId: { type: Schema.Types.ObjectId, ref: "User" },
    dueDate: { type: Date },
    // Simple label model: an array of color keywords (e.g. "green", "red").
    // Kept intentionally simple (no separate Label collection/model) since
    // labels here are per-card tags, not shared/reusable across a board.
    labels: [{ type: String }],
    priority: { type: String, enum: ["low", "medium", "high"] },
    taskId: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    // Adds and auto-maintains createdAt/updatedAt — no manual bookkeeping
    // needed on every save().
    timestamps: true,
  }
);

export const CardModel = model<CardDocument>("Card", cardSchema);
