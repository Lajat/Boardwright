"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { ApiError } from "@/lib/apiClient";
import { emailError as getEmailError } from "@/lib/validation";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { SpinnerIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/Logo";
import { APP_NAME } from "@/lib/constants";
import { AuthPageRedirect } from "@/components/AuthPageRedirect";

type Touched = { email?: boolean; password?: boolean };

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState<Touched>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Field-level validation, recomputed on every render from current
  // values — cheap for a two-field form, and means the error under each
  // input is always in sync with what's typed, not just checked on submit.
  const emailErr = getEmailError(email);
  const passwordErr = !password ? "Password is required." : null;
  const isFormValid = !emailErr && !passwordErr;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    setFormError(null);
    if (!isFormValid) return;

    setIsSubmitting(true);
    try {
      await login(email, password);
      // useAuth's login() already redirects to /workspaces on success.
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthPageRedirect>
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={44} />
          <span className="text-sm font-semibold tracking-tight text-slate-400">{APP_NAME}</span>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-100">
          <h1 className="mb-6 text-xl font-bold text-slate-900">Welcome back</h1>

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
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                aria-invalid={touched.email && !!emailErr}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${
                  touched.email && emailErr
                    ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                    : "border-slate-200 focus:border-brand-400 focus:ring-brand-100"
                }`}
              />
              {touched.email && emailErr && (
                <p className="mt-1 text-xs text-red-600">{emailErr}</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                  Password
                </label>
                <Link href="/forgot-password" className="text-xs font-medium text-brand-600 hover:text-brand-700">
                  Forgot password?
                </Link>
              </div>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                aria-invalid={touched.password && !!passwordErr}
                hasError={touched.password && !!passwordErr}
                wrapperClassName="mt-1"
              />
              {touched.password && passwordErr && (
                <p className="mt-1 text-xs text-red-600">{passwordErr}</p>
              )}
            </div>

            {formError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{formError}</p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
            >
              {isSubmitting && <SpinnerIcon className="h-4 w-4" />}
              {isSubmitting ? "Logging in..." : "Log in"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-500">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-brand-600 hover:text-brand-700">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </main>
    </AuthPageRedirect>
  );
}
