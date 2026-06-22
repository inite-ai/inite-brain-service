import type { MDXComponents } from 'mdx/types'
import Link from 'next/link'
import { ReactNode } from 'react'

/**
 * Style overrides for MDX content. Next.js looks for this file at the
 * project root and applies it to every .mdx page. Tailwind classes
 * here drive the docs typography pass so every page inherits one look
 * without needing a `prose` wrapper inside the MDX.
 */
/** The shared style map — importable directly (e.g. for MDXRemote in the
 * blog) without going through the hook. */
export const mdxComponents: MDXComponents = {
  h1: (props) => (
      <h1
        className="u-display text-[2rem] font-bold tracking-[-0.01em] text-[var(--text)] mt-2 mb-4"
        {...props}
      />
    ),
    h2: (props) => (
      <h2
        className="text-xl font-semibold tracking-tight text-[var(--text)] mt-10 mb-3 pb-1 border-b border-[var(--border)]"
        {...props}
      />
    ),
    h3: (props) => (
      <h3
        className="text-base font-semibold tracking-tight text-[var(--text)] mt-6 mb-2"
        {...props}
      />
    ),
    p: (props) => (
      <p className="text-[15px] leading-relaxed text-[var(--text-muted)] my-3" {...props} />
    ),
    ul: (props) => (
      <ul
        className="text-[15px] leading-relaxed text-[var(--text-muted)] my-3 ml-5 list-disc space-y-1"
        {...props}
      />
    ),
    ol: (props) => (
      <ol
        className="text-[15px] leading-relaxed text-[var(--text-muted)] my-3 ml-5 list-decimal space-y-1"
        {...props}
      />
    ),
    li: (props) => <li className="leading-relaxed" {...props} />,
    a: ({ href = '', children, ...rest }) => {
      const isInternal = href.startsWith('/') || href.startsWith('#')
      if (isInternal) {
        return (
          <Link
            href={href}
            className="text-[var(--data)] hover:text-[var(--signal)] underline decoration-[var(--data)]/40 underline-offset-2 transition-colors"
          >
            {children}
          </Link>
        )
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--data)] hover:text-[var(--signal)] underline decoration-[var(--data)]/40 underline-offset-2 transition-colors"
          {...rest}
        >
          {children}
        </a>
      )
    },
    code: (props) => (
      <code
        className="px-1 py-0.5 rounded bg-[var(--bg-overlay)] border border-[var(--border)] text-[13px] font-mono text-[var(--text)]"
        {...props}
      />
    ),
    pre: ({ children }: { children?: ReactNode }) => (
      <pre className="my-4 p-4 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] overflow-x-auto text-[13px] leading-relaxed font-mono text-[var(--text)]">
        {children}
      </pre>
    ),
    blockquote: (props) => (
      <blockquote
        className="my-4 pl-3 border-l-2 border-[var(--signal)] text-[var(--text-muted)]"
        {...props}
      />
    ),
    hr: () => <hr className="my-8 border-[var(--border)]" />,
    table: (props) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full text-sm border-collapse" {...props} />
      </div>
    ),
    th: (props) => (
      <th
        className="text-left text-xs font-semibold text-[var(--text-muted)] px-3 py-2 border-b border-[var(--border)] uppercase tracking-wide"
        {...props}
      />
    ),
    td: (props) => (
      <td
        className="px-3 py-2 border-b border-[var(--border)] text-[var(--text)] align-top"
        {...props}
      />
    ),
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...mdxComponents, ...components }
}
