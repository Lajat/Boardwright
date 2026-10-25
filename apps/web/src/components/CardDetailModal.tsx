"use client";

import { useEffect, useState } from "react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { CommentSection } from "./CommentSection";
import { TrashIcon, CalendarIcon, TagIcon, UserPlusIcon, XIcon } from "./ui/icons";
import {
  LABEL_COLORS,
  PRIORITY_META,
  type Card,
  type LabelColor,
  type Priority,
  type WorkspaceMember,
  type AssignableBoardPerson,
} from "@boardwright/shared-types";

export interface CardUpdates {
  title: string;
  description: string;
  dueDate: string | null;
  labels: string[];
  priority: Priority | null;
  assigneeId: string | null;
}

interface CardDetailModalProps {
  card: Card | null;
  /** Workspace members — kept for anything else in this modal keyed off a real WorkspaceMember, but NOT what the assignee dropdown uses (see assignablePeople). */
  members: WorkspaceMember[];
  /**
   * Who the assignee dropdown actually offers — workspace members AND
   * board guests, for every viewer including a guest themselves. `members`
   * above is deliberately left empty for a guest viewer elsewhere in the
   * app to keep the full workspace roster private from them; this is a
   * separate, narrower list (id/name/avatar only) built specifically to
   * stay populated for a guest, which is what makes a Contributor-level
   * guest able to actually set an assignee instead of the dropdown having
   * no real options and silently falling back to "Unassigned."
   */
  assignablePeople: AssignableBoardPerson[];
  onClose: () => void;
  onSave: (cardId: string, updates: CardUpdates) => Promise<void>;
  onDelete: (cardId: string) => Promise<void>;
  /** The current user's own permissions — when canEdit is false, every field renders read-only and Save is hidden; when canDelete is false, the Delete button is hidden. */
  canEdit?: boolean;
  canDelete?: boolean;
}

/** Tailwind classes for each label color swatch — kept as one lookup so
 * every place a label renders (this modal, TaskCard) stays visually
 * consistent. */
export const LABEL_SWATCH: Record<LabelColor, string> = {
  gray: "bg-slate-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-400",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
};

/** Pill styling per priority level — deliberately mirrors the red/orange/gray
 * severity pills from classic bug-tracker boards (Trello, Jira, Linear). */
export const PRIORITY_PILL: Record<Priority, string> = {
  low: "bg-slate-100 text-slate-500",
  medium: "bg-orange-100 text-orange-700",
  high: "bg-red-100 text-red-700",
};

/** Converts an ISO timestamp to the value a <input type="date"> expects. */
function toDateInputValue(iso?: string) {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function formatDateLabel(date: string) {
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function labelName(color: LabelColor) {
  return `${color[0].toUpperCase()}${color.slice(1)}`;
}

const PRIORITY_ORDER: Priority[] = ["low", "medium", "high"];

/**
 * Full editor for a single card — opened by clicking a card (not
 * dragging it). Handles title, description, due date, labels, priority,
 * and assignee in one place, plus the card's delete action, so TaskCard
 * itself only needs quick affordances for the common case and this modal
 * covers everything else.
 */
export function CardDetailModal({
  card,
  members,
  assignablePeople,
  onClose,
  onSave,
  onDelete,
  canEdit = true,
  canDelete = true,
}: CardDetailModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setDescription(card.description ?? "");
      setDueDate(toDateInputValue(card.dueDate));
      setLabels(card.labels ?? []);
      setPriority(card.priority ?? null);
      setAssigneeId(card.assigneeId ?? null);
      setTitleTouched(false);
    }
  }, [card]);

  if (!card) return null;

  function toggleLabel(color: string) {
    setLabels((prev) => (prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]));
  }

  async function handleSave() {
    setTitleTouched(true);
    if (!card || !title.trim()) return;
    setIsSaving(true);
    try {
      await onSave(card.id, {
        title: title.trim(),
        description: description.trim(),
        dueDate: dueDate || null,
        labels,
        priority,
        assigneeId,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <Modal
        open={!!card && !confirmingDelete}
        onClose={onClose}
        ariaLabel="Card details"
        widthClassName="max-w-xl"
        header={
          <div className="shrink-0 border-b border-slate-100 bg-white px-5 py-4">
            <div className="mb-1 flex items-center gap-2">
              <label
                htmlFor="card-detail-title"
                className="block text-xs font-semibold uppercase tracking-wide text-slate-400"
              >
                Title
              </label>
              {card.taskId && (
                <span
                  title="Task ID — assigned once when the card was created, and never changes"
                  className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-slate-500"
                >
                  {card.taskId}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close card details"
                className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <input
              id="card-detail-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setTitleTouched(true)}
              aria-invalid={titleTouched && !title.trim()}
              disabled={!canEdit}
              className={`w-full rounded-lg border px-3 py-2 text-lg font-semibold text-slate-900 outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-500 ${
                titleTouched && !title.trim()
                  ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                  : "border-slate-200 focus:border-brand-400 focus:ring-brand-100"
              }`}
            />
            {titleTouched && !title.trim() && (
              <p className="mt-1 text-xs text-red-600">Title is required.</p>
            )}
          </div>
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            {canDelete ? (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <TrashIcon className="h-4 w-4" /> Delete card
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                {canEdit ? "Cancel" : "Close"}
              </button>
              {canEdit && (
                <button
                  onClick={handleSave}
                  disabled={isSaving || !title.trim()}
                  className="rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-brand-600 hover:to-violet-700 disabled:opacity-50"
                >
                  {isSaving ? "Saving..." : "Save changes"}
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={!canEdit}
              placeholder="Add a more detailed description..."
              className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Priority
            </label>
            <div className="flex gap-2" role="group" aria-label="Card priority">
              {PRIORITY_ORDER.map((level) => (
                <button
                  key={level}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setPriority((prev) => (prev === level ? null : level))}
                  aria-pressed={priority === level}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    priority === level
                      ? `${PRIORITY_PILL[level]} border-current/20 shadow-sm`
                      : "border-transparent bg-slate-50 text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {PRIORITY_META[level].label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <CalendarIcon className="h-3.5 w-3.5" /> Due date
              </label>
              <div className="relative">
                <div
                  className={`flex min-h-[42px] items-center rounded-lg border border-slate-200 px-3 py-2 text-sm ${
                    canEdit ? "text-slate-700" : "bg-slate-50 text-slate-500"
                  }`}
                >
                  <span className={dueDate ? "" : "text-slate-400"}>
                    {dueDate ? formatDateLabel(dueDate) : "No due date"}
                  </span>
                  {canEdit && <CalendarIcon className="ml-auto h-4 w-4 text-slate-400" />}
                </div>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={!canEdit}
                  aria-label="Due date"
                  title={dueDate ? formatDateLabel(dueDate) : "Choose due date"}
                  // The visible formatted value stays consistent across
                  // browser locales; this transparent input preserves the
                  // native, keyboard-accessible date picker.
                  min={toDateInputValue(new Date().toISOString())}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <UserPlusIcon className="h-3.5 w-3.5" /> Assignee
              </label>
              <select
                value={assigneeId ?? ""}
                onChange={(e) => setAssigneeId(e.target.value || null)}
                disabled={!canEdit}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500"
              >
                <option value="">Unassigned</option>
                {assignablePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <TagIcon className="h-3.5 w-3.5" /> Labels
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              {LABEL_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => toggleLabel(color)}
                  aria-label={`${labels.includes(color) ? "Remove" : "Add"} ${labelName(color)} label`}
                  aria-pressed={labels.includes(color)}
                  title={`${labelName(color)} label`}
                  className={`h-7 w-7 rounded-full border-2 border-white ${LABEL_SWATCH[color]} transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed ${
                    labels.includes(color)
                      ? "scale-110 ring-2 ring-brand-600 ring-offset-1"
                      : "opacity-60 hover:scale-105 hover:opacity-100 disabled:hover:scale-100 disabled:hover:opacity-60"
                  }`}
                />
              ))}
            </div>
          </div>

          <CommentSection cardId={card.id} />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this card?"
        description={`"${card.title}" will be permanently deleted. This can't be undone.`}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          await onDelete(card.id);
          setConfirmingDelete(false);
          onClose();
        }}
      />
    </>
  );
}
