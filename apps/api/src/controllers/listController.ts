import { Request, Response } from "express";
import { ListModel } from "../models/List";
import { BoardModel } from "../models/Board";
import { CardModel } from "../models/Card";
import type { List } from "@boardwright/shared-types";
import { SocketEvents } from "@boardwright/shared-types";
import { resolveBoardAccessById } from "../lib/permissions";

/** Converts a Mongoose ListDocument into the shared `List` shape. */
function toListResponse(doc: any): List {
  return {
    id: doc._id.toString(),
    boardId: doc.boardId.toString(),
    title: doc.title,
    cardOrder: doc.cardOrder.map((id: any) => id.toString()),
  };
}

/**
 * POST /boards/:boardId/lists
 * Creates a new list and appends it to the board's listOrder. Requires
 * card-level "add" permission — either as a workspace member, or as a
 * single-board guest with access to this specific board.
 */
export async function createList(req: Request, res: Response) {
  const { boardId } = req.params;
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  const access = await resolveBoardAccessById(boardId, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.cardPermissions.canAdd) {
    return res.status(403).json({ error: "you don't have permission to add lists to this board" });
  }

  const list = await ListModel.create({ boardId, title, cardOrder: [] });

  await BoardModel.findByIdAndUpdate(boardId, {
    $push: { listOrder: list._id },
  });

  const listResponse = toListResponse(list);
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.LIST_CREATED, listResponse);

  res.status(201).json(listResponse);
}

/**
 * GET /boards/:boardId/lists
 * Returns every list on a board, in the board's listOrder (not insertion
 * order) — this is what lets the frontend render columns left-to-right
 * correctly after a reorder. Plain membership is enough to view.
 */
export async function listListsForBoard(req: Request, res: Response) {
  const { boardId } = req.params;

  const access = await resolveBoardAccessById(boardId, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }

  const board = await BoardModel.findById(boardId).populate("listOrder");
  const lists = (board!.listOrder as any[]).map(toListResponse);

  res.json({ items: lists });
}

/**
 * PATCH /boards/:boardId/lists/:listId
 * Renames a list — requires "edit" permission. Kept as its own endpoint
 * (distinct from /lists/reorder below) since the two are triggered by
 * completely different UI actions — one from a drag-and-drop drop, one
 * from an inline rename field — and mixing "reorder the whole board" with
 * "rename one list" into a single handler would make both harder to
 * reason about.
 */
export async function updateList(req: Request, res: Response) {
  const { boardId, listId } = req.params;
  const { title } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }

  const access = await resolveBoardAccessById(boardId, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.cardPermissions.canEdit) {
    return res.status(403).json({ error: "you don't have permission to edit this board" });
  }

  const list = await ListModel.findOneAndUpdate(
    { _id: listId, boardId },
    { title },
    { new: true }
  );

  if (!list) {
    return res.status(404).json({ error: "list not found" });
  }

  const listResponse = toListResponse(list);
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.LIST_UPDATED, listResponse);

  res.json(listResponse);
}

/**
 * PATCH /boards/:boardId/lists/reorder
 * Replaces the board's listOrder wholesale with a new array of list ids.
 * Used after a drag-and-drop reorder on the frontend — simpler and less
 * error-prone than a "move list from index X to index Y" endpoint, since
 * the frontend already knows the full desired order after a drop.
 * Treated as an "edit" action, same permission level as renaming.
 */
export async function reorderLists(req: Request, res: Response) {
  const { boardId } = req.params;
  const { listOrder } = req.body;

  if (!Array.isArray(listOrder)) {
    return res.status(400).json({ error: "listOrder must be an array of list ids" });
  }

  const access = await resolveBoardAccessById(boardId, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.cardPermissions.canEdit) {
    return res.status(403).json({ error: "you don't have permission to edit this board" });
  }

  const board = await BoardModel.findByIdAndUpdate(
    boardId,
    { listOrder },
    { new: true }
  );

  if (!board) {
    return res.status(404).json({ error: "board not found" });
  }

  // Returning the board's new listOrder directly (not wrapped in
  // toListResponse, which is for individual List documents, not this) —
  // this is the one thing the frontend actually needs after a reorder.
  const newListOrder = board.listOrder.map((id: any) => id.toString());

  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.LIST_REORDERED, {
    boardId,
    listOrder: newListOrder,
  });

  res.json({ boardId, listOrder: newListOrder });
}

/**
 * DELETE /boards/:boardId/lists/:listId
 * Deletes a list, its cards, and removes it from the board's listOrder.
 * Requires "delete" permission.
 */
export async function deleteList(req: Request, res: Response) {
  const { boardId, listId } = req.params;

  const access = await resolveBoardAccessById(boardId, req.userId!);
  if (!access) {
    return res.status(404).json({ error: "board not found" });
  }
  if (!access.cardPermissions.canDelete) {
    return res.status(403).json({ error: "you don't have permission to delete lists on this board" });
  }

  const list = await ListModel.findOneAndDelete({ _id: listId, boardId });
  if (!list) {
    return res.status(404).json({ error: "list not found" });
  }

  await CardModel.deleteMany({ listId });
  await BoardModel.findByIdAndUpdate(boardId, {
    $pull: { listOrder: listId },
  });

  const listResponse = toListResponse(list);
  req.app.get("io").to(`board:${boardId}`).emit(SocketEvents.LIST_DELETED, {
    listId: listResponse.id,
    boardId,
  });

  res.json({ deleted: listResponse });
}
