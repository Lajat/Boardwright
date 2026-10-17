import { Request, Response } from "express";
import { CommentModel } from "../models/Comment";
import { CardModel } from "../models/Card";
import { ListModel } from "../models/List";
import { UserModel } from "../models/User";
import type { Comment } from "@boardwright/shared-types";
import { SocketEvents } from "@boardwright/shared-types";
import { resolveListAccess } from "../lib/permissions";

/** Converts a Mongoose CommentDocument into the shared `Comment` shape. */
function toCommentResponse(doc: any): Comment {
  return {
    id: doc._id.toString(),
    cardId: doc.cardId.toString(),
    authorId: doc.authorId.toString(),
    body: doc.body,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * GET /cards/:cardId/comments
 * Lists every comment on a card, oldest first. Plain membership is
 * enough to read — same rule as listCardsForList in cardController.
 */
export async function listCommentsForCard(req: Request, res: Response) {
  const { cardId } = req.params;

  const card = await CardModel.findById(cardId);
  if (!card) {
    return res.status(404).json({ error: "card not found" });
  }

  const access = await resolveListAccess(card.listId.toString(), req.userId!);
  if (!access) {
    return res.status(404).json({ error: "card not found" });
  }

  const comments = await CommentModel.find({ cardId }).sort({ createdAt: 1 });

  // Resolve author display info in one batch query rather than N+1 queries
  // (one per comment) — comments only store authorId, not a denormalized
  // name, so this is the join the frontend needs to render anything
  // readable.
  const authorIds = [...new Set(comments.map((c) => c.authorId.toString()))];
  const authors = await UserModel.find({ _id: { $in: authorIds } });
  const authorsById = new Map(authors.map((a) => [a._id.toString(), a]));

  const items = comments.map((c) => {
    const author = authorsById.get(c.authorId.toString());
    return {
      ...toCommentResponse(c),
      authorName: author?.displayName ?? "Unknown user",
      authorAvatarUrl: author?.avatarUrl,
    };
  });

  res.json({ items });
}

/**
 * POST /cards/:cardId/comments
 * Adds a comment, authored by the logged-in user, and broadcasts it to
 * everyone else viewing this board in real time. Requires "add"
 * permission — the same level required to create a card, since posting a
 * comment is adding new content to the board, not editing existing
 * content someone else made.
 */
export async function createComment(req: Request, res: Response) {
  const { cardId } = req.params;
  const { body } = req.body;

  if (!body || !body.trim()) {
    return res.status(400).json({ error: "body is required" });
  }

  const card = await CardModel.findById(cardId);
  if (!card) {
    return res.status(404).json({ error: "card not found" });
  }

  const access = await resolveListAccess(card.listId.toString(), req.userId!);
  if (!access) {
    return res.status(404).json({ error: "card not found" });
  }
  if (!access.cardPermissions.canAdd) {
    return res.status(403).json({ error: "you don't have permission to comment on this card" });
  }

  const comment = await CommentModel.create({
    cardId,
    authorId: req.userId,
    body: body.trim(),
  });

  const author = await UserModel.findById(req.userId);
  const responseBody = {
    ...toCommentResponse(comment),
    authorName: author?.displayName ?? "Unknown user",
    authorAvatarUrl: author?.avatarUrl,
  };

  const list = await ListModel.findById(card.listId);
  if (list) {
    req.app.get("io").to(`board:${list.boardId}`).emit(SocketEvents.COMMENT_ADDED, responseBody);
  }

  res.status(201).json(responseBody);
}
