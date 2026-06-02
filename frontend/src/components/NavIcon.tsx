/**
 * NavIcon - サイドバーナビ用のアイコン共通定義
 * claude.ai サイドバー風 (line icons, 1.6px stroke)
 */
import {
  Boxes, Calendar, ArrowDownToLine, ArrowUpFromLine,
  Tags, FlaskConical, LayoutGrid, Lock, Archive, Filter,
  BookOpen, Truck, PackagePlus, ChefHat, Calculator,
  Database, SlidersHorizontal, MessageSquareReply, Smartphone,
  ScrollText, type LucideIcon,
} from 'lucide-react'

export const NAV_ICONS: Record<string, LucideIcon> = {
  inventory:   Boxes,
  calendar:    Calendar,
  inbound:     ArrowDownToLine,
  outbound:    ArrowUpFromLine,
  prices:      Tags,
  semifinished: FlaskConical,
  storage:     LayoutGrid,
  selection:   Filter,
  monthlyClose: Lock,
  archive:     Archive,
  materials:   Boxes,
  recipesBulk: BookOpen,
  shipments:   Truck,
  register:    PackagePlus,
  recipes:     ChefHat,
  recipesEstimate: Calculator,
  masters:     Database,
  settings:    SlidersHorizontal,
  recipeReview: MessageSquareReply,
  devices:     Smartphone,
  audit:       ScrollText,
}

interface Props {
  name: keyof typeof NAV_ICONS
  size?: number
}

export function NavIcon({ name, size = 16 }: Props) {
  const Icon = NAV_ICONS[name]
  if (!Icon) return null
  return <Icon size={size} strokeWidth={1.6} aria-hidden />
}
