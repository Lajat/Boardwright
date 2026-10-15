"use client";

import { useEffect, useRef, useState, KeyboardEvent, MouseEvent, ReactNode } from "react";

interface EditableTitleProps {
  value: string;
  onSave: (next: string) => Promise<void> | void;
  className?: string;
  inputClassName?: string;
  as?: "h1" | "h2" | "h3" | "span";
  /** Rendered next to the title, e.g. an edit/delete menu — only shown when NOT editing. */
  actions?: ReactNode;
  /** When true, renders as plain static text — no click-to-edit affordance, no hover cue. Used to gate renaming by permission without needing a second component. */
  disabled?: boolean;
  /**
   * Called on click/tap instead of entering edit mode, only while disabled.
   * The title still truncates when space is tight (className typically
   * includes truncate/text-ellipsis) — without this there was no way at
   * all for someone who can't rename it to ever see the untruncated text,
   * since the native title="" tooltip doesn't help on a touchscreen.
   */
  onClickDisabled?: () => void;
}

/**
 * Click-to-edit text: renders as plain text until clicked, then swaps to
 * an input focused and pre-selected. Enter/blur saves, Escape cancels.
 * Used for workspace names, board titles, and list titles — anywhere a
 * "rename" affordance is needed without a separate modal.
 */
export function EditableTitle({
  value,
  onSave,
  className = "",
  inputClassName = "",
  as = "span",
  actions,
  disabled = false,
  onClickDisabled,
}: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [showEmptyError, setShowEmptyError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const Tag = as;

  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      // Don't silently revert on an empty save — keep editing open and
      // show why, the same way any other required field in the app
      // behaves, rather than just snapping back to the old value with no
      // explanation.
      setShowEmptyError(true);
      return;
    }
    setIsEditing(false);
    setShowEmptyError(false);
    if (trimmed === value) return;
    await onSave(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setDraft(value);
      setShowEmptyError(false);
      setIsEditing(false);
    }
  }

  if (isEditing) {
    return (
      <div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (showEmptyError) setShowEmptyError(false);
          }}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          // Same reasoning as the title span's onClick above — this input
          // can be rendered inside a clickable <Link>, and clicking to
          // place the cursor shouldn't trigger navigation.
          onClick={(e) => e.preventDefault()}
          aria-invalid={showEmptyError}
          className={
            inputClassName ||
            `w-full rounded-md border bg-white px-2 py-1 outline-none ring-2 ${
              showEmptyError ? "border-red-300 ring-red-100" : "border-indigo-300 ring-indigo-100"
            }`
          }
        />
        {showEmptyError && <p className="mt-0.5 text-xs text-red-600">Can&apos;t be empty.</p>}
      </div>
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-1.5">
      <Tag
        onClick={(e: MouseEvent) => {
          if (disabled) {
            if (onClickDisabled) {
              e.preventDefault();
              e.stopPropagation();
              onClickDisabled();
            }
            return;
          }
          // preventDefault/stopPropagation matter here because this title
          // is sometimes rendered inside a clickable <Link> (e.g. a board
          // or workspace tile) — without stopping the event, clicking the
          // title to rename it would also trigger the link's navigation.
          e.preventDefault();
          e.stopPropagation();
          setIsEditing(true);
        }}
        title={disabled ? undefined : "Click to rename"}
        className={`min-w-0 truncate rounded-md px-1 -mx-1 ${
          disabled ? (onClickDisabled ? "cursor-pointer hover:bg-slate-900/5" : "") : "cursor-text hover:bg-slate-900/5"
        } ${className}`}
      >
        {value}
      </Tag>
      {actions}
    </div>
  );
}
