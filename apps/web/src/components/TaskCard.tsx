"use client";

import { forwardRef, type CSSProperties, type HTMLAttributes, type SyntheticEvent } from "react";
import { useDndContext } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card, LabelColor, WorkspaceMember } from "@boardwright/shared-types";
import { PRIORITY_META } from "@boardwright/shared-types";
import { TrashIcon, CalendarIcon } from "./ui/icons";
import { LABEL_SWATCH, PRIORITY_PILL } from "./CardDetailModal";
import { avatarColorFor, initialsFor } from "@/lib/avatar";

function formatDueDate(iso?: string) {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isOverdue(iso?: string) {
  if (!iso) return false;
  return new Date(iso).getTime() < new Date().setHours(0, 0, 0, 0);
}

/**
 * The delete button lives INSIDE the draggable card, so a press on it would
 * otherwise bubble up to the card's drag activators and start a drag. dnd-kit's
 * MouseSensor listens for `mousedown`, TouchSensor for `touchstart` and
 * KeyboardSensor for `keydown` — stopping only `pointerdown` (as this used to)
 * does nothing for any of them.
 */
const stopDragActivation = (e: SyntheticEvent) => e.stopPropagation();

interface TaskCardViewProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  card: Card;
  /** Used to resolve card.assigneeId into a name/avatar — pass an empty array if unavailable, the assignee avatar is simply omitted then. */
  members?: WorkspaceMember[];
  /** Whether the current user may delete this card — hides the inline delete button when false. */
  canDelete?: boolean;
  onDelete?: (cardId: string) => void;
  onOpen?: (card: Card) => void;
  /** Filtered cards cannot be reordered, so show a normal pointer instead of a grab cursor. */
  disableDrag?: boolean;
  /** True for the floating copy rendered inside <DragOverlay>. */
  isOverlay?: boolean;
}

/**
 * Pure presentation of a card — no dnd-kit hooks in here on purpose.
 *
 * It is rendered in two places: by <TaskCard> (below) as the sortable item in
 * a column, and directly by the board page inside <DragOverlay> as the copy
 * that follows the finger/cursor. dnd-kit requires DragOverlay's child to be a
 * plain component: if the overlay child were <TaskCard>, it would call
 * `useSortable` with the SAME id as the real card, i.e. register a second
 * draggable/droppable under an id that is already taken.
 *
 * Any `attributes`/`listeners`/`ref`/`style` from dnd-kit arrive as ordinary
 * props and are forwarded to the root element.
 */
export const TaskCardView = forwardRef<HTMLDivElement, TaskCardViewProps>(function TaskCardView(
  { card, members = [], canDelete = true, onDelete, onOpen, disableDrag = false, isOverlay = false, className = "", style, ...rest },
  ref
) {
  const dueLabel = formatDueDate(card.dueDate);
  const overdue = isOverdue(card.dueDate);
  const assignee = card.assigneeId ? members.find((m) => m.id === card.assigneeId) : undefined;

  // iOS shows a "copy / share" callout on long-press; the touch drag starts
  // with a long-press, so suppress it (select-none covers text selection).
  const rootStyle: CSSProperties = { WebkitTouchCallout: "none", ...style };

  const stateClasses = isOverlay
    ? // The lifted copy: full opacity, no transform of its own (rotating/scaling
      // a layer makes text render soft), just a stronger shadow + ring.
      "cursor-grabbing border-brand-300 shadow-xl ring-2 ring-brand-200"
    : `${disableDrag ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} border-slate-200 shadow-sm transition hover:border-brand-200 hover:shadow-md`;

  return (
    <div
      ref={ref}
      style={rootStyle}
      {...rest}
      onClick={onOpen ? () => onOpen(card) : undefined}
      // touch-manipulation (NOT touch-none): with touch-none every card was a
      // dead zone for scrolling, so on a phone you couldn't scroll a long
      // column or swipe the board sideways when your finger landed on a card —
      // which is most of the screen. The TouchSensor's press-and-hold delay
      // (see the board page) is what separates the two gestures: swipe =
      // scroll, hold ~¼s then move = drag.
      className={`group relative touch-manipulation select-none rounded-lg border bg-white p-3 ${stateClasses} ${className}`}
    >
      {card.labels && card.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {card.labels.map((color) => (
            <span
              key={color}
              role="img"
              aria-label={`${color} label`}
              title={`${color[0].toUpperCase()}${color.slice(1)} label`}
              className={`h-2 w-8 rounded-full ${LABEL_SWATCH[color as LabelColor] ?? "bg-slate-300"}`}
            />
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug text-slate-800">{card.title}</p>
        {canDelete && onDelete && (
          <button
            onPointerDown={stopDragActivation}
            onMouseDown={stopDragActivation}
            onTouchStart={stopDragActivation}
            onKeyDown={stopDragActivation}
            onClick={(e) => {
              e.stopPropagation(); // don't also open the card
              onDelete(card.id);
            }}
            aria-label="Delete card"
            // Always visible on touch/small screens (no hover state to
            // reveal it there); fades in on hover for desktop pointer users.
            className="shrink-0 rounded-md p-1 text-slate-300 opacity-100 transition hover:bg-red-50 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {card.description && (
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{card.description}</p>
      )}

      {card.priority && (
        <span
          className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY_PILL[card.priority]}`}
        >
          {PRIORITY_META[card.priority].label}
        </span>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {card.taskId && (
            <span className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400">
              {card.taskId}
            </span>
          )}
          {dueLabel && (
            <div
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                overdue ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"
              }`}
            >
              <CalendarIcon className="h-3 w-3" />
              {dueLabel}
            </div>
          )}
        </div>

        {assignee && (
          <span
            title={assignee.displayName}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white ${avatarColorFor(
              assignee.id
            )}`}
          >
            {initialsFor(assignee.displayName)}
          </span>
        )}
      </div>
    </div>
  );
});

interface TaskCardProps {
  card: Card;
  onDelete: (cardId: string) => void;
  /** True while a previous drag-move for this exact card is still being
   *  persisted to the backend. Passed through to useSortable's `disabled`
   *  option so dnd-kit refuses to start a new drag on it at the gesture
   *  level — dragging the same card again before its move finishes is
   *  what caused a real backend race condition (see moveCard) resulting
   *  in the card getting recorded in two lists at once; this stops the
   *  double-drag at the source rather than only recovering from it. */
  isMovePending?: boolean;
  /** Filtered cards cannot be safely reordered relative to hidden cards. */
  disableDrag?: boolean;
  onOpen?: (card: Card) => void;
  members?: WorkspaceMember[];
  canDelete?: boolean;
}

/**
 * A single draggable card within a list: <TaskCardView> wired up to dnd-kit's
 * `useSortable`, which supplies the drag handlers and the `transform` /
 * `transition` used to animate the card as it's dragged and as its
 * neighbours shift to make room.
 *
 * The whole card body doubles as a click target that opens the full editor
 * (onOpen). That works alongside dragging because the sensors (configured on
 * the board page) only start a drag after a few pixels of mouse movement / a
 * short touch hold, so a plain click or tap is never swallowed as a drag.
 */
export function TaskCard({
  card,
  onDelete,
  onOpen,
  members = [],
  canDelete = true,
  isMovePending = false,
  disableDrag = false,
}: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: isMovePending || disableDrag,
  });
  const { active, over } = useDndContext();
  const activeRect = active?.rect.current.translated;
  const isDropTarget = over?.id === card.id && active?.id !== card.id && !!activeRect;
  const insertBefore = isDropTarget && activeRect
    ? activeRect.top + activeRect.height / 2 < over.rect.top + over.rect.height / 2
    : false;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <TaskCardView
      ref={setNodeRef}
      style={style}
      card={card}
      members={members}
      canDelete={canDelete}
      onDelete={onDelete}
      onOpen={onOpen}
      disableDrag={disableDrag}
      className={
        isDropTarget
          ? insertBefore
            ? "before:pointer-events-none before:absolute before:-top-1.5 before:left-2 before:right-2 before:z-10 before:h-1 before:rounded-full before:bg-brand-500 before:shadow-[0_0_0_2px_white] before:content-['']"
            : "after:pointer-events-none after:absolute after:-bottom-1.5 after:left-2 after:right-2 after:z-10 after:h-1 after:rounded-full after:bg-brand-500 after:shadow-[0_0_0_2px_white] after:content-['']"
          : ""
      }
      {...attributes}
      {...listeners}
    />
  );
}
