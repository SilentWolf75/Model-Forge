import type { ReactNode } from 'react'
import changelogRaw from '../../../CHANGELOG.md?raw'

type ChangelogSection = {
  heading: string
  body: string
}

function parseChangelogSections(markdown: string): ChangelogSection[] {
  const stripped = markdown.replace(/^#\s*Changelog\s*\n*/im, '').trim()
  if (!stripped) return []
  const parts = stripped.split(/\n(?=## )/)
  return parts.map((part) => {
    const lines = part.trim().split('\n')
    const first = lines[0] ?? ''
    const heading = first.replace(/^##\s*/, '').trim()
    const body = lines.slice(1).join('\n').trim()
    return { heading, body }
  })
}

function formatInline(text: string): ReactNode {
  const segments = text.split('**')
  return segments.map((seg, i) =>
    i % 2 === 1 ? (
      <strong key={i}>{seg}</strong>
    ) : (
      <span key={i}>{seg}</span>
    )
  )
}

function SectionBody({ body }: { body: string }): JSX.Element {
  const trimmed = body.trim()
  const lines = trimmed.split('\n').map((l) => l.trim())
  const nonEmpty = lines.filter((l) => l.length > 0)
  const allBullets = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith('- '))

  if (allBullets) {
    return (
      <ul className="whats-new-list">
        {nonEmpty.map((line, i) => (
          <li key={i}>{formatInline(line.replace(/^-\s+/, ''))}</li>
        ))}
      </ul>
    )
  }

  return <p className="whats-new-prose">{formatInline(trimmed)}</p>
}

export function WhatsNew(): JSX.Element {
  const sections = parseChangelogSections(changelogRaw)

  return (
    <div className="whats-new-scroll" role="region" aria-label="Changelog and release notes">
      {sections.map((sec) => (
        <section key={sec.heading} className="whats-new-section">
          <h4 className="whats-new-version">{sec.heading}</h4>
          <SectionBody body={sec.body} />
        </section>
      ))}
    </div>
  )
}
