const createMDX = require('@next/mdx')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // .mdx files act as page sources so app/[lang]/docs/<slug>/page.mdx
  // works without a wrapper component per page.
  pageExtensions: ['ts', 'tsx', 'mdx'],
  env: {
    NEXT_PUBLIC_BRAIN_API_URL:
      process.env.NEXT_PUBLIC_BRAIN_API_URL || 'https://brain.inite.ai',
  },
}

const withMDX = createMDX({
  options: {
    // GFM tables + strikethrough + task lists. CommonMark alone leaves
    // pipe tables as raw text — every docs page leans on tables, so this
    // plugin is load-bearing.
    remarkPlugins: [['remark-gfm']],
  },
})

module.exports = withMDX(nextConfig)
