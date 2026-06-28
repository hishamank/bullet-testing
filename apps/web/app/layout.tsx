import type { Metadata } from 'next'
import { Instrument_Serif, Newsreader, Spline_Sans, Spline_Sans_Mono } from 'next/font/google'
import { AppShell } from '@/components/app-shell'
import { Providers } from '@/lib/trpc'
import './globals.css'

/*
 * The four Margin Notebook families, self-hosted via next/font (no runtime CDN — privacy-first,
 * matching the app's local-first ethos). Each is exposed as a CSS variable consumed by the
 * `--font-*` tokens in globals.css.
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-newsreader',
})
const instrument = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-instrument',
})
const spline = Spline_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-spline',
})
const splineMono = Spline_Sans_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-spline-mono',
})

export const metadata: Metadata = {
  title: 'Margin Notebook',
  description: 'A local-first bullet journal. Empty your head, one bullet at a time.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${instrument.variable} ${spline.variable} ${splineMono.variable}`}
    >
      <body className="bg-paper text-ink antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
