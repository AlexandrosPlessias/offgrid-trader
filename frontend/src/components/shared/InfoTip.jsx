export default function InfoTip({ text }) {
  return (
    <span className="info-tip">
      <span className="info-tip-icon">ℹ</span>
      <span className="info-tip-popup">{text}</span>
    </span>
  )
}
