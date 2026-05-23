import { Lock } from 'lucide-react'
import { getMessages, type Lang } from '../lib/i18n'

interface Props {
  lang: Lang
}

export function Footer({ lang }: Props) {
  const t = getMessages(lang)
  return (
    <footer className="py-8 mt-12 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[var(--text-faint)]">
      <div className="flex items-center gap-2">
        <Lock className="w-3.5 h-3.5" />
        {t.footer.tagline}
      </div>
      <div className="flex items-center gap-4">
        <a href={`/${lang}/docs`} className="hover:text-[var(--text)]">
          {t.footer.links.docs}
        </a>
        <a
          href="https://brain.inite.ai/openapi.json"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text)]"
        >
          {t.footer.links.openapi}
        </a>
        <a
          href="https://brain.inite.ai/health"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text)]"
        >
          {t.footer.links.status}
        </a>
        <a
          href="https://github.com/inite/inite-brain-service"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text)]"
        >
          {t.footer.links.github}
        </a>
      </div>
    </footer>
  )
}
