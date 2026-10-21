"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { CheckIcon, LayoutIcon, SpinnerIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/Logo";
import type { InvitePreview } from "@boardwright/shared-types";
import { APP_NAME } from "@/lib/constants";

type InviteAction = "accept" | "decline" | "snooze";

export default function InvitePage() {
  const { user, accessToken, isLoading: authLoading } = useAuth();
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState<InviteAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptedLink, setAcceptedLink] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    apiFetch<InvitePreview>(`/invites/${token}/preview`, { accessToken })
      .then((result) => {
        if (active) setInvite(result);
      })
      .catch((err) => {
        if (active) setError(err instanceof ApiError ? err.message : "This invitation could not be loaded.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, accessToken]);

  async function respond(action: InviteAction) {
    if (!user) return;
    setSubmitting(action);
    setError(null);
    try {
      const result = await apiFetch<{ status: InvitePreview["status"]; snoozedUntil?: string; link: string }>(
        `/invites/${token}/respond`,
        { method: "POST", accessToken, body: { action } }
      );
      setInvite((current) => current
        ? { ...current, status: result.status, ...(result.snoozedUntil ? { snoozedUntil: result.snoozedUntil } : {}) }
        : current);
      if (action === "accept") setAcceptedLink(result.link);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We couldn't update this invitation. Please try again.");
    } finally {
      setSubmitting(null);
    }
  }

  const isBusy = !!submitting;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 py-10">
      <div className="pointer-events-none absolute -left-28 -top-24 h-80 w-80 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -right-20 h-96 w-96 rounded-full bg-indigo-500/20 blur-3xl" />
      <section className="relative w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold tracking-tight text-white/70">
          <Logo size={36} bgClassName="bg-gradient-to-br from-brand-400 to-violet-500" className="shadow-lg shadow-brand-950/30" />
          {APP_NAME}
        </div>

        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white shadow-2xl shadow-black/30">
          <div className="bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-600 px-7 py-8 text-white sm:px-9">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
              {invite?.scope === "board" ? "Board invitation" : "Workspace invitation"}
            </p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
              {isLoading ? "Preparing your invitation…" : invite ? "You’re invited to collaborate" : "Invitation unavailable"}
            </h1>
            {invite && (
              <p className="mt-2 text-sm leading-relaxed text-white/80">
                {invite.inviterName} invited you to join <span className="font-semibold text-white">{invite.workspaceName}</span>
                {invite.boardName && <> <span className="px-1 text-white/60">/</span><span className="font-semibold text-white">{invite.boardName}</span></>}.
              </p>
            )}
          </div>

          <div className="px-7 py-7 sm:px-9">
            {isLoading || authLoading ? (
              <div className="flex items-center justify-center gap-3 py-8 text-sm text-slate-500">
                <SpinnerIcon className="h-5 w-5 text-brand-600" /> Loading invitation details
              </div>
            ) : error && !invite ? (
              <div role="alert" className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{error}</div>
            ) : invite ? (
              <>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-brand-600 shadow-sm ring-1 ring-slate-200">
                      <LayoutIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {invite.scope === "board" ? invite.boardName : invite.workspaceName}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-600">
                        {invite.scope === "board"
                          ? `Board-only access in ${invite.workspaceName}. Other boards and workspace members remain private.`
                          : "Workspace access includes all boards in this workspace."}
                      </p>
                      {invite.permissions && (
                        <p className="mt-2 text-[11px] font-medium text-slate-500">
                          {invite.permissions.canEdit ? "Can edit board content" : "View only"}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {acceptedLink || invite.status === "already_has_access" ? (
                  <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
                      <CheckIcon className="h-5 w-5" /> {acceptedLink ? "Invitation accepted" : "You already have access"}
                    </div>
                    <p className="mt-1 text-xs text-emerald-700">Your access is ready. You can open the shared {invite.scope} now.</p>
                    <Link href={acceptedLink ?? invite.resourceLink}
                      className="mt-3 inline-flex rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800">
                      Open {invite.scope}
                    </Link>
                  </div>
                ) : invite.status === "declined" || invite.status === "closed" ? (
                  <p className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    {invite.status === "closed"
                      ? "This invitation is no longer active. Ask the owner for a new invitation if you still need access."
                      : "This invitation was declined. Ask the owner for a new invitation if you change your mind."}
                  </p>
                ) : (
                  <>
                    {invite.status === "snoozed" && invite.snoozedUntil && (
                      <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
                        Snoozed until {new Date(invite.snoozedUntil).toLocaleString()}. You can still respond now.
                      </p>
                    )}
                    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
                    {user ? (
                      <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <button type="button" onClick={() => respond("accept")} disabled={isBusy}
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-brand-600 hover:to-violet-700 disabled:cursor-wait disabled:opacity-60">
                          {submitting === "accept" && <SpinnerIcon className="h-4 w-4" />} Accept invitation
                        </button>
                        <button type="button" onClick={() => respond("decline")} disabled={isBusy}
                          className="min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60">
                          {submitting === "decline" ? "Declining…" : "Decline"}
                        </button>
                        <button type="button" onClick={() => respond("snooze")} disabled={isBusy}
                          className="min-h-11 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-60">
                          {submitting === "snooze" ? "Snoozing…" : "Later"}
                        </button>
                      </div>
                    ) : (
                      <div className="mt-5 grid gap-2 sm:grid-cols-2">
                        <Link href={`/signup?redirect=${encodeURIComponent(`/invite/${token}`)}`}
                          className="flex min-h-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:from-brand-600 hover:to-violet-700">
                          Create an account to respond
                        </Link>
                        <Link href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}
                          className="flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
                          Sign in
                        </Link>
                      </div>
                    )}
                    <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
                      {invite.scope === "board"
                        ? "Accepting grants access to this board only. Snoozing is private and reminds you in 24 hours."
                        : "Accepting grants access to this workspace and all its boards. Snoozing is private and reminds you in 24 hours."}
                    </p>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
        <p className="mt-5 text-center text-xs text-white/40">A secure invitation for the right place, with access you choose.</p>
      </section>
    </main>
  );
}
