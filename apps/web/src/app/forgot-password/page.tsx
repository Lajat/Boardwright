"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { emailError as getEmailError } from "@/lib/validation";
import { SpinnerIcon, LinkIcon, CheckIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/Logo";
import { APP_NAME } from "@/lib/constants";

/**
 * Requests a password-reset token for an email address.
 *
 * This project has no email-sending service connected — see
 * apps/api/src/controllers/authController.ts's forgotPassword for the
 * full reasoning — so instead of "check your inbox", a successful request
 * displays the reset link directly on screen, clearly labeled as a
 * stand-in for what would normally be emailed.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState(false);

  const emailErr = getEmailError(email);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setFormError(null);
    if (emailErr) return;

    setIsSubmitting(true);
    try {
      const res = await apiFetch<{ message: string; resetToken?: string }>(
        "/auth/forgot-password",
        { method: "POST", body: { email } }
      );
      setMessage(res.message);
      if (res.resetToken && typeof window !== "undefined") {
        setResetLink(`${window.location.origin}/reset-password/${res.resetToken}`);
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopyLink() {
    if (!resetLink) return;
    try {
      await navigator.clipboard.writeText(resetLink);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 2000);
    } catch {
      // Link is still selectable/copyable by hand if the Clipboard API is blocked.
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={44} />
          <span className="text-sm font-semibold tracking-tight text-slate-400">{APP_NAME}</span>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-100">
          <h1 className="mb-2 text-xl font-bold text-slate-900">Reset your password</h1>
          <p className="mb-6 text-sm text-slate-500">
            Enter your email and we&apos;ll generate a reset link.
          </p>

          {message ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>

              {resetLink && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-500">
                    This project doesn&apos;t send real emails — here&apos;s your reset link
                    directly. In production, this would be emailed to you instead.
                  </p>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={resetLink}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 outline-none"
                    />
                    <button
                      onClick={handleCopyLink}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-900"
                    >
                      {justCopied ? <CheckIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                      {justCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <Link
                    href={resetLink.replace(/^https?:\/\/[^/]+/, "")}
                    className="mt-3 flex w-full items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:from-brand-600 hover:to-violet-700"
                  >
                    Open reset link
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && !!emailErr}
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${
                    touched && emailErr
                      ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                      : "border-slate-200 focus:border-brand-400 focus:ring-brand-100"
                  }`}
                />
                {touched && emailErr && <p className="mt-1 text-xs text-red-600">{emailErr}</p>}
              </div>

              {formError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{formError}</p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:from-brand-600 hover:to-violet-700 disabled:opacity-50"
              >
                {isSubmitting && <SpinnerIcon className="h-4 w-4" />}
                {isSubmitting ? "Generating link..." : "Generate reset link"}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-sm text-slate-500">
            <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">
              Back to log in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
