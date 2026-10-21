"use client";

import { useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { passwordError as getPasswordError } from "@/lib/validation";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { SpinnerIcon, CheckIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/Logo";
import { APP_NAME } from "@/lib/constants";

export default function ResetPasswordPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [touched, setTouched] = useState<{ password?: boolean; confirmPassword?: boolean }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);

  const passwordErr = getPasswordError(password);
  const confirmErr = confirmPassword !== password ? "Passwords don't match." : null;
  const isFormValid = !passwordErr && !confirmErr;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ password: true, confirmPassword: true });
    setFormError(null);
    if (!isFormValid) return;

    setIsSubmitting(true);
    try {
      await apiFetch("/auth/reset-password", {
        method: "POST",
        body: { token: params.token, newPassword: password },
      });
      setIsDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={44} />
          <span className="text-sm font-semibold tracking-tight text-slate-400">{APP_NAME}</span>
        </div>

        <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
          {isDone ? (
            <>
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <CheckIcon className="h-6 w-6" />
              </div>
              <h1 className="text-lg font-bold text-slate-900">Password updated</h1>
              <p className="mt-1 text-sm text-slate-500">Taking you to log in...</p>
            </>
          ) : (
            <>
              <h1 className="mb-2 text-left text-xl font-bold text-slate-900">Set a new password</h1>
              <form onSubmit={handleSubmit} noValidate className="space-y-4 text-left">
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                    New password
                  </label>
                  <PasswordInput
                    id="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                    aria-invalid={touched.password && !!passwordErr}
                    hasError={!!(touched.password && passwordErr)}
                    wrapperClassName="mt-1"
                  />
                  {touched.password && passwordErr && (
                    <p className="mt-1 text-xs text-red-600">{passwordErr}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700">
                    Confirm new password
                  </label>
                  <PasswordInput
                    id="confirmPassword"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
                    aria-invalid={touched.confirmPassword && !!confirmErr}
                    hasError={!!(touched.confirmPassword && confirmErr)}
                    wrapperClassName="mt-1"
                  />
                  {touched.confirmPassword && confirmErr && (
                    <p className="mt-1 text-xs text-red-600">{confirmErr}</p>
                  )}
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
                  {isSubmitting ? "Updating..." : "Update password"}
                </button>
              </form>
            </>
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
