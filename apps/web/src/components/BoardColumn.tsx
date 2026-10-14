"use client";

import { useRef, useState, FormEvent } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskCard } from "./TaskCard";
import { EditableTitle } from "./ui/EditableTitle";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { PlusIcon, TrashIcon, XIcon } from "./ui/icons";
import type { Card, WorkspaceMember } from "@fluxboard/shared-types";

interface BoardColumnProps {
  listId: string;
  title: string;
  cards: Card[];
  members: WorkspaceMember[];
  onAddCard: (listId: string, title: string) => Promise<void>;
  onDeleteCard: (cardId: string) => void;
  onOpenCard: (card: Card) => void;
  onRenameList: (listId: string, title: string) => Promise<void>;
  onDeleteList: (listId: string) => Promise<void>;
  /** The CURRENT user's own permissions in this board's workspace — gates the add/rename/delete affordances below. */
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Card ids with a move currently in flight — passed through to each
   *  TaskCard as isMovePending, disabling drag on that specific card
   *  until its move finishes (see TaskCard for why this matters). */
  pendingMoveCardIds: Set<string>;
  isBoardMovePending: boolean;
  /** Disables dragging for a reason OTHER than filters too (a viewer with no canEdit) — kept separate from hasActiveFilters below so the two causes don't get the same empty-state message. */
  disableDrag: boolean;
  /** Whether the empty state below should say "No cards match these filters" — only true, never inferred from disableDrag, since disableDrag is also true for a viewer with an empty, unfiltered list. */
  hasActiveFilters: boolean;
}

/**
 * One column on the board. `useDroppable` makes the column itself a valid
 * drop target for the case where a card is dropped into an EMPTY column
 * (no existing card to drop "next to") — the id is prefixed with
 * "column-" so the board page's onDragEnd can tell "dropped on a column"
 * apart from "dropped on a card" when both ids could otherwise collide.
 */
export function BoardColumn({
  listId,
  title,
  cards,
  members,
  onAddCard,
  onDeleteCard,
  onOpenCard,
  onRenameList,
  onDeleteList,
  canAdd,
  canEdit,
  canDelete,
  pendingMoveCardIds,
  isBoardMovePending,
  disableDrag,
  hasActiveFilters,
}: BoardColumnProps) {
  const columnDropId = `column-${listId}`;
  const { setNodeRef } = useDroppable({ id: columnDropId });
  const { active, over } = useDndContext();
  const isActiveDropTarget =
    !!active &&
    !!over &&
    (over.id === columnDropId || cards.some((card) => card.id === over.id));
  const isDroppingAtEnd = !!active && over?.id === columnDropId;
  const [newCardTitle, setNewCardTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isSubmittingCard, setIsSubmittingCard] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [cardTitleError, setCardTitleError] = useState<string | null>(null);
  const addCardInFlight = useRef(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (addCardInFlight.current) return;
    if (!newCardTitle.trim()) {
      setCardTitleError("Card title is required.");
      return;
    }

    addCardInFlight.current = true;
    setIsSubmittingCard(true);
    try {
      await onAddCard(listId, newCardTitle);
    } finally {
      addCardInFlight.current = false;
      setIsSubmittingCard(false);
    }
    setNewCardTitle("");
    setCardTitleError(null);
  }

  return (
    <div
      className={`board-column-snap flex h-full max-h-full w-[85vw] shrink-0 flex-col rounded-xl p-2.5 transition-colors sm:w-72 ${
        isActiveDropTarget
          ? "bg-brand-50 ring-2 ring-inset ring-brand-300"
          : "bg-slate-100/80"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-1 px-1">
        <EditableTitle
          as="h3"
          value={title}
          onSave={(next) => onRenameList(listId, next)}
          disabled={!canEdit}
          className="text-sm font-semibold text-slate-700"
          inputClassName="w-full rounded-md border border-brand-300 bg-white px-1.5 py-0.5 text-sm font-semibold text-slate-700 outline-none ring-2 ring-brand-100"
        />
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
            {cards.length}
          </span>
          {canDelete && (
            <button
              onClick={() => setConfirmingDelete(true)}
              aria-label="Delete list"
              className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={setNodeRef}
        // min-h: this element is the drop target for an EMPTY column (there's no
        // card to drop "next to"). 20px was a sliver you had to hit exactly —
        // fine for a mouse, close to impossible with a thumb.
        className="scrollbar-thin min-h-[56px] flex-1 space-y-2 overflow-y-auto px-0.5"
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <TaskCard
              key={card.id}
              card={card}
              members={members}
              onDelete={onDeleteCard}
              onOpen={onOpenCard}
              canDelete={canDelete}
              isMovePending={isBoardMovePending || pendingMoveCardIds.has(card.id)}
              disableDrag={disableDrag}
            />
          ))}
        </SortableContext>
        {cards.length === 0 && hasActiveFilters && (
          <p className="px-2 py-4 text-center text-xs text-slate-400">No cards match these filters.</p>
        )}
        {isDroppingAtEnd &&
          (cards.length === 0 ? (
            <div className="flex min-h-16 items-center justify-center rounded-lg border-2 border-dashed border-brand-300 bg-white/70 text-xs font-medium text-brand-600">
              Drop card here
            </div>
          ) : (
            <div
              aria-hidden="true"
              className="h-1 shrink-0 rounded-full bg-brand-500 shadow-[0_0_0_2px_white]"
            />
          ))}
      </div>

      {!canAdd ? null : isAdding ? (
        <form onSubmit={handleSubmit} className="mt-2 space-y-1.5">
          <textarea
            autoFocus
            rows={2}
            placeholder="Enter a title for this card..."
            value={newCardTitle}
            onChange={(e) => {
              setNewCardTitle(e.target.value);
              if (cardTitleError) setCardTitleError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
              if (e.key === "Escape") {
                setIsAdding(false);
                setNewCardTitle("");
                setCardTitleError(null);
              }
            }}
            aria-invalid={!!cardTitleError}
            className={`w-full resize-none rounded-lg border bg-white px-2.5 py-2 text-sm shadow-sm outline-none ring-2 ${
              cardTitleError ? "border-red-300 ring-red-100" : "border-brand-300 ring-brand-100"
            }`}
          />
          {cardTitleError && <p className="text-xs text-red-600">{cardTitleError}</p>}
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={isSubmittingCard}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {isSubmittingCard ? "Adding..." : "Add card"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setNewCardTitle("");
                setCardTitleError(null);
              }}
              aria-label="Cancel"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left text-sm text-slate-500 hover:bg-slate-200/70"
        >
          <PlusIcon className="h-4 w-4" /> Add a card
        </button>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this list?"
        description={`"${title}" and all ${cards.length} card${cards.length === 1 ? "" : "s"} in it will be permanently deleted.`}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          await onDeleteList(listId);
          setConfirmingDelete(false);
        }}
      />
    </div>
  );
}
