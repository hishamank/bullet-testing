import type { Metadata } from 'next'
import { Providers } from '@/lib/trpc'
import './globals.css'

export const metadata: Metadata = {
  title: 'Bullet Journal',
  description: 'Local-first bullet journal — web scaffold (UI built via the design tool).',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
