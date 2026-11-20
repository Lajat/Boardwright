import { Schema, model, Document } from "mongoose";

/**
 * A login session that has been logged out and must no longer be able to
 * refresh. Every token a session ever issues carries the same random `sid`
 * (see issueTokens in authController), so revoking the one sid kills the
 * whole session — including refresh tokens copied before logout — without
 * touching the user's other devices, which hold different sids.
 *
 * Rows delete themselves: `expiresAt` is set to when the session's refresh
 * tokens would have expired anyway, and the TTL index below has MongoDB
 * remove the row at that moment. Past that point the signature check alone
 * rejects the token, so keeping the row would only be clutter.
 */
export interface RevokedSessionDocument extends Document {
  sid: string;
  expiresAt: Date;
}

const revokedSessionSchema = new Schema<RevokedSessionDocument>({
  sid: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const RevokedSessionModel = model<RevokedSessionDocument>("RevokedSession", revokedSessionSchema);
