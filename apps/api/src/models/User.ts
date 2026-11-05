import { Schema, model, Document } from "mongoose";

/**
 * Mongoose document shape for a User.
 *
 * This mirrors (but is not identical to) the `User` type in
 * `@boardwright/shared-types` — the shared type is the *API contract* sent
 * over the wire (no password hash, string id instead of ObjectId), while
 * this schema is the *storage shape* (includes passwordHash, uses Mongo's
 * native _id). Keeping these separate on purpose: the API response type
 * should never accidentally leak a password hash just because we changed
 * the database schema.
 */
export interface UserDocument extends Document {
  email: string;
  passwordHash: string;
  displayName: string;
  avatarUrl?: string;
  // SHA-256 hash of the password-reset token — never the token itself. The
  // raw token only ever exists in the emailed link; if this collection is
  // ever read by someone who shouldn't (a leaked backup, an injection bug),
  // a hash can't be turned back into a working reset link. Both fields are
  // unset except during the brief window between requesting a reset and
  // using it (or until it expires unused). See authController's
  // forgotPassword / resetPassword for the full flow.
  resetTokenHash?: string;
  resetTokenExpiresAt?: Date;
  // Bumped whenever the password is reset. It's embedded in every refresh
  // token at the time it's issued and checked when that token is used, so
  // a reset immediately kills every session that existed before it —
  // JWTs are otherwise stateless and would stay valid until they expire.
  tokenVersion: number;
  createdAt: Date;
}

const userSchema = new Schema<UserDocument>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: { type: String, required: true, trim: true },
  avatarUrl: { type: String },
  resetTokenHash: { type: String, index: true, sparse: true },
  resetTokenExpiresAt: { type: Date },
  tokenVersion: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export const UserModel = model<UserDocument>("User", userSchema);
