"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { getSocket } from "@/lib/socket";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { SocketEvents, type Comment } from "@boardwright/shared-types";

interface CommentSectionProps {
  cardId: string;
}

/**
 * Comment thread for a single card, shown inside CardDetailModal.
 * Self-contained on purpose (fetches and posts its own data, rather than
 * routing through the board page's state) since comments don't affect
 * card ordering or any other part of the board — there's nothing else
 * that needs to know about them except this thread itself.
 */
export function CommentSection({ cardId }: CommentSectionProps) {
  const { accessToken } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [newBody, setNewBody] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiFetch<{ items: Comment[] }>(`/cards/${cardId}/comments`, { accessToken })
      .then((res) => {
        if (!cancelled) setComments(res.items);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load comments"))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, accessToken]);

  // Real-time: pick up comments added by other people viewing the same
  // card while this modal is open. Guarded against duplicates the same
  // way the board page guards card/list events — this component's own
  // successful POST already adds the comment locally, so the broadcast
  // for that same comment (which also reaches the poster, since the
  // server emits to the whole board room) must not add it twice.
  useEffect(() => {
    const socket = getSocket();
    function handleCommentAdded(comment: Comment) {
      if (comment.cardId !== cardId) return;
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
    }
    socket.on(SocketEvents.COMMENT_ADDED, handleCommentAdded);
    return () => {
      socket.off(SocketEvents.COMMENT_ADDED, handleCommentAdded);
    };
  }, [cardId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newBody.trim() || submitInFlight.current) return;

    submitInFlight.current = true;
    setIsSubmitting(true);
    try {
      const created = await apiFetch<Comment>(`/cards/${cardId}/comments`, {
        method: "POST",
        accessToken,
        body: { body: newBody },
      });
      setComments((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]));
      setNewBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add comment");
    } finally {
      submitInFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="border-t border-slate-100 pt-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Comments
      </h3>

      {isLoading ? (
        <p className="text-sm text-slate-400">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-slate-400">No comments yet.</p>
      ) : (
        <ul className="mb-3 space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="flex gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColorFor(
                  comment.authorId
                )}`}
              >
                {initialsFor(comment.authorName ?? "?")}
              </div>
              <div className="min-w-0 flex-1 rounded-lg bg-slate-50 px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-slate-800">
                    {comment.authorName ?? "Unknown user"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-slate-700">{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          placeholder="Write a comment..."
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isSubmitting || !newBody.trim()}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Post
        </button>
      </form>
    </div>
  );
}
