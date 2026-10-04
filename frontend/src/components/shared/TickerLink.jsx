import { openLatestRun } from '../../utils/explorer'

/** Compact button for detail panels: opens the latest Explorer run for *ticker*. */
export function ExplorerButton({ ticker, onOpenExplorer }) {
  if (!onOpenExplorer || !ticker) return null
  return (
    <button
      type="button"
      className="btn-ghost"
      style={{ fontSize: 11, padding: '2px 10px' }}
      onClick={(e) => { e.stopPropagation(); openLatestRun(ticker, onOpenExplorer) }}
      title={`Open the latest ${ticker} analysis in Explorer`}
    >
      🔍 Open {ticker} in Explorer →
    </button>
  )
}

/** A ticker name that opens its latest Explorer run. Renders plain text without a handler. */
export default function TickerLink({ ticker, onOpenExplorer, className, style, children }) {
  if (!onOpenExplorer) return <span className={className} style={style}>{children ?? ticker}</span>
  // A span (not a button) so the caller's class keeps full control of font and colour.
  const open = (e) => { e.stopPropagation(); openLatestRun(ticker, onOpenExplorer) }
  return (
    <span
      role="link"
      tabIndex={0}
      className={className}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e) } }}
      title={`Open the latest ${ticker} analysis in Explorer`}
      style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, ...style }}
    >
      {children ?? ticker}
    </span>
  )
}
