import { UserModel } from "../models/User";

/**
 * Whether a token stamped with `tokenVersion` still belongs to a live
 * session: the user must still exist and their current tokenVersion must
 * match. Resetting a password bumps tokenVersion (see resetPassword), which
 * is what turns every token issued before the reset — access, refresh, or
 * websocket ticket — from "valid until it expires" into "dead immediately".
 *
 * A token minted before tokenVersion existed carries no `tv`, and a user
 * document from before it existed has no tokenVersion; both count as 0, so
 * sessions already open when this shipped keep working until a real reset.
 *
 * One indexed lookup on _id, projecting a single field, with no document
 * hydration (.lean()) — cheap enough to run on every authenticated request,
 * which is the whole point: a version check that only ran at refresh time
 * would leave a stolen access token usable for up to its 15-minute life.
 */
export async function isSessionCurrent(userId: string, tokenVersion: number | undefined): Promise<boolean> {
  const user = await UserModel.findById(userId).select("tokenVersion").lean();
  return !!user && (user.tokenVersion ?? 0) === (tokenVersion ?? 0);
}
