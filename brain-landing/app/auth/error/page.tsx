import Link from 'next/link'
import { DemoSignInButton } from '../../../components/demo-session/DemoSignInButton'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ reason?: string }>
}

export default async function AuthErrorPage({ searchParams }: Props) {
  const { reason } = await searchParams
  return (
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-[var(--text)]">
          Sign-in failed
        </h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          {reason ? (
            <>
              auth.inite.ai returned <code className="text-[var(--danger)] font-mono">{reason}</code>.
            </>
          ) : (
            'Unknown error.'
          )}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            href="/api/auth/login"
            className="h-9 px-3.5 inline-flex items-center rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)]"
          >
            Try again
          </Link>
          <Link
            href="/en"
            className="h-9 px-3.5 inline-flex items-center rounded-md border border-[var(--border-strong)] text-[var(--text)] text-sm hover:bg-[var(--bg-overlay)]"
          >
            Back home
          </Link>
          <DemoSignInButton
            lang="en"
            className="h-9 px-3.5 inline-flex items-center rounded-md border border-[var(--border-strong)] text-[var(--text)] text-sm hover:bg-[var(--bg-overlay)]"
          />
        </div>
      </div>
    </div>
  )
}
