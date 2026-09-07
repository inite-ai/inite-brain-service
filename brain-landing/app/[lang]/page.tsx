import { Header } from '../../components/Header'
import { Hero } from '../../components/Hero'
import { BitemporalDemo } from '../../components/BitemporalDemo'
import { Architecture } from '../../components/Architecture'
import { DomainPacks } from '../../components/DomainPacks'
import { MemoryLayers } from '../../components/MemoryLayers'
import { Features } from '../../components/Features'
import { DualPath } from '../../components/DualPath'
import { Stats } from '../../components/Stats'
import { QuickstartTabs } from '../../components/QuickstartTabs'
import { McpInstall } from '../../components/McpInstall'
import { SkillsInstall } from '../../components/SkillsInstall'
import { OpenSource } from '../../components/OpenSource'
import { Footer } from '../../components/Footer'
import { JsonLd } from '../../components/StructuredData'
import { normalizeLang, getMessages, LANGS } from '../../lib/i18n'
import {
  SITE_URL,
  organizationSchema,
  websiteSchema,
  softwareApplicationSchema,
  ogImage,
} from '../../lib/seo'
import type { Metadata } from 'next'

interface Props {
  params: Promise<{ lang: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  return {
    title: `INITE Brain — ${t.hero.title}`,
    description: t.hero.subtitle,
    alternates: {
      canonical: `${SITE_URL}/${lang}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `${SITE_URL}/${l}`])),
    },
    openGraph: {
      title: `INITE Brain — ${t.hero.title}`,
      description: t.hero.subtitle,
      locale: lang === 'ru' ? 'ru_RU' : 'en_US',
      images: [{ url: ogImage({ title: t.hero.title }), width: 1200, height: 630 }],
    },
    twitter: { title: `INITE Brain — ${t.hero.title}`, description: t.hero.subtitle, images: [ogImage({ title: t.hero.title })] },
  }
}

export default async function LandingPage({ params }: Props) {
  const { lang: raw } = await params
  const lang = normalizeLang(raw)
  const t = getMessages(lang)
  return (
    <div className="lab-root landing-refresh min-h-screen" lang={lang}>
      <JsonLd
        data={[organizationSchema(), websiteSchema(), softwareApplicationSchema()]}
      />
      <a href="#main-content" className="landing-skip">{t.nav.skip}</a>
      <Header lang={lang} landing />
      <main id="main-content" className="max-w-6xl mx-auto px-5 sm:px-6">
        <Hero lang={lang} />
        <MemoryLayers lang={lang} />
        <Architecture lang={lang} />
        <DomainPacks lang={lang} />
        <BitemporalDemo lang={lang} />
        <Features lang={lang} />
        <DualPath lang={lang} />
        <Stats lang={lang} />
        <QuickstartTabs lang={lang} />
        <McpInstall lang={lang} />
        <SkillsInstall lang={lang} />
        <OpenSource lang={lang} />
        <Footer lang={lang} />
      </main>
    </div>
  )
}
