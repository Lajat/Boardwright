import Link from "next/link";
import { APP_NAME, APP_VERSION } from "@/lib/constants";
import { LayoutIcon } from "@/components/ui/icons";

const features = [
  {
    title: "Workspaces and boards",
    description: "Organize team work into workspaces, boards, lists, and cards.",
  },
  {
    title: "Live collaboration",
    description: "See board changes as they happen while working with your team.",
  },
  {
    title: "Board guests",
    description: "Share a single board with someone outside your workspace — by email or a link — without giving them access to anything else.",
  },
  {
    title: "Granular access",
    description: "Three named levels — Viewer, Contributor, Full access — set by the workspace owner or an Admin, down to what each person can add, edit, or delete.",
  },
  {
    title: "Notifications",
    description: "Invitations and access changes land in a notification bell you can act on, or mark read, without leaving what you're doing.",
  },
  {
    title: "Card details",
    description: "Track due dates, priority, labels, assignees, task IDs, and conversations.",
  },
];

const technologies = [
  "Next.js",
  "React",
  "TypeScript",
  "Tailwind CSS",
  "Node.js",
  "Express",
  "Socket.IO",
  "MongoDB",
];

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 lg:px-10">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
              <LayoutIcon className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-brand-700">About</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
                {APP_NAME}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
                A real-time collaborative Kanban board that helps teams organize work, track progress,
                and stay in sync.
              </p>
              <p className="mt-4 inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                Version {APP_VERSION}
              </p>
            </div>
          </div>
        </header>

        <section aria-labelledby="about-features" className="mt-8">
          <div className="mb-4">
            <h2 id="about-features" className="text-lg font-semibold text-slate-900">
              Built for collaborative work
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Keep your team’s plans and progress together in one clear workspace.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {features.map((feature) => (
              <article key={feature.title} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-800">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{feature.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="about-technology" className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 id="about-technology" className="text-lg font-semibold text-slate-900">
            Made with
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            A TypeScript monorepo with a Next.js web app and a real-time Node.js API.
          </p>
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Technology stack">
            {technologies.map((technology) => (
              <li key={technology} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                {technology}
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-8 flex flex-col gap-3 border-t border-slate-200 pt-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {APP_NAME}. Open source under the MIT License.</p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/Lajat/Boardwright"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              GitHub project
            </a>
            <Link
              href="/workspaces"
              className="font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Back to workspaces
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
