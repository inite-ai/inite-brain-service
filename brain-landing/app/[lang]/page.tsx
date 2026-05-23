import { Header } from '../../components/Header'
import { Hero } from '../../components/Hero'
import { Stats } from '../../components/Stats'
import { Features } from '../../components/Features'
import { QuickstartTabs } from '../../components/QuickstartTabs'
import { McpInstall } from '../../components/McpInstall'
import { SkillsInstall } from '../../components/SkillsInstall'
import { Footer } from '../../components/Footer'
import { normalizeLang } from '../../lib/i18n'

interface Props {
  params: Promise<{ lang: string }>
}

export default async function LandingPage({ params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <Header lang={lang} />
      <main className="max-w-5xl mx-auto px-6">
        <Hero lang={lang} />
        <Stats lang={lang} />
        <Features lang={lang} />
        <QuickstartTabs lang={lang} />
        <McpInstall lang={lang} />
        <SkillsInstall lang={lang} />
        <Footer lang={lang} />
      </main>
    </div>
  )
}
