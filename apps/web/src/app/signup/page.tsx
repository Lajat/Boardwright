"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { ApiError } from "@/lib/apiClient";
import { emailError as getEmailError, passwordError as getPasswordError } from "@/lib/validation";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { SpinnerIcon, CheckIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/Logo";
import { APP_NAME } from "@/lib/constants";
import { AuthPageRedirect } from "@/components/AuthPageRedirect";

type Touched = { displayName?: boolean; email?: boolean; password?: boolean; confirmPassword?: boolean };

export default function SignupPage() {
  const { signup } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [touched, setTouched] = useState<Touched>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nameErr = !displayName.trim() ? "Name is required." : null;
  const emailErr = getEmailError(email);
  const passwordErr = getPasswordError(password);
  const confirmErr =
    confirmPassword !== password ? "Passwords don't match." : null;
  const isFormValid = !nameErr && !emailErr && !passwordErr && !confirmErr;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched({ displayName: true, email: true, password: true, confirmPassword: true });
    setFormError(null);
    if (!isFormValid) return;

    setIsSubmitting(true);
    try {
      await signup(email, password, displayName.trim());
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function fieldClass(hasError: boolean) {
    return `mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${
      hasError
        ? "border-red-300 focus:border-red-400 focus:ring-red-100"
        : "border-slate-200 focus:border-brand-400 focus:ring-brand-100"
    }`;
  }

  return (
    <AuthPageRedirect>
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={44} />
          <span className="text-sm font-semibold tracking-tight text-slate-400">{APP_NAME}</span>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-100">
          <h1 className="mb-6 text-xl font-bold text-slate-900">Create your account</h1>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="displayName" className="block text-sm font-medium text-slate-700">
                Name
              </label>
              <input
                id="displayName"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
                aria-invalid={touched.displayName && !!nameErr}
                className={fieldClass(!!(touched.displayName && nameErr))}
              />
              {touched.displayName && nameErr && (
                <p className="mt-1 text-xs text-red-600">{nameErr}</p>
              )}
            </div>

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
                className={fieldClass(!!(touched.email && emailErr))}
              />
              {touched.email && emailErr && <p className="mt-1 text-xs text-red-600">{emailErr}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
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
              {/* Live checklist instead of a static hint — gives immediate,
                  encouraging feedback as the user types rather than only
                  showing red text after they've already failed. */}
              <p
                className={`mt-1 flex items-center gap-1 text-xs ${
                  password.length >= 8 ? "text-emerald-600" : "text-slate-400"
                }`}
              >
                <CheckIcon className="h-3 w-3" /> At least 8 characters
              </p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700">
                Confirm password
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
              {isSubmitting ? "Creating account..." : "Sign up"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </main>
    </AuthPageRedirect>
  );
}
