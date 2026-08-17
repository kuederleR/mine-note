import { LUCIDE_ICONS, isLucideIconName } from '../lib/categoryIcons'

export function CatIcon({
  name,
  color,
  size = 16,
  className,
}: {
  name: string
  color?: string | null
  size?: number
  className?: string
}) {
  if (isLucideIconName(name)) {
    const Icon = LUCIDE_ICONS[name]
    return <Icon className={className} size={size} color={color || 'currentColor'} strokeWidth={1.75} />
  }
  return (
    <span className={className} style={{ color: color || 'inherit', fontSize: size * 0.85, lineHeight: 1 }}>
      {name || '📁'}
    </span>
  )
}
