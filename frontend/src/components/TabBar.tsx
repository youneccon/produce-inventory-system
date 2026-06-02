import { NavLink, useLocation } from 'react-router-dom'

export type LedgerTab =
  | 'ginger' | 'garlic' | 'garlic_exp' | 'yamaimo' | 'gobo' | 'satsumaimo'
  | 'materials' | 'shipments' | 'masters'

export function currentTab(pathname: string): LedgerTab {
  if (pathname.startsWith('/masters'))     return 'masters'
  if (pathname.startsWith('/materials')
      || pathname.startsWith('/storage/material')) return 'materials'
  if (pathname.startsWith('/shipments'))   return 'shipments'
  if (pathname.startsWith('/garlic-exp'))  return 'garlic_exp'
  if (pathname.startsWith('/garlic'))      return 'garlic'
  if (pathname.startsWith('/yamaimo'))     return 'yamaimo'
  if (pathname.startsWith('/gobo'))        return 'gobo'
  if (pathname.startsWith('/satsumaimo'))  return 'satsumaimo'
  // 原料置き場は前回いた作物タブを保持できないので、
  // ?from=<crop> クエリで一時管理（保留: 当面は生姜タブ扱い）
  if (pathname.startsWith('/storage/ingredient')) {
    const sp = new URLSearchParams(window.location.search)
    const from = sp.get('from')
    if (from === 'garlic')     return 'garlic'
    if (from === 'yamaimo')    return 'yamaimo'
    if (from === 'gobo')       return 'gobo'
    if (from === 'satsumaimo') return 'satsumaimo'
    return 'ginger'
  }
  return 'ginger'
}

const TABS: { id: LedgerTab; label: string; to: string }[] = [
  { id: 'ginger',     label: '生姜原料台帳',   to: '/' },
  { id: 'garlic',     label: '大蒜原料台帳',   to: '/garlic' },
  { id: 'garlic_exp', label: '大蒜(実験)台帳', to: '/garlic-exp' },
  { id: 'yamaimo',    label: '長芋原料台帳',   to: '/yamaimo' },
  { id: 'gobo',       label: '牛蒡原料台帳',   to: '/gobo' },
  { id: 'satsumaimo', label: '薩摩芋原料台帳', to: '/satsumaimo' },
  { id: 'materials',  label: '資材管理台帳',   to: '/materials' },
  { id: 'shipments',  label: '商品出荷台帳',   to: '/shipments' },
  { id: 'masters',    label: 'マスタ管理台帳', to: '/masters' },
]

export default function TabBar() {
  const { pathname } = useLocation()
  const active = currentTab(pathname)
  return (
    <div className="tabbar">
      {TABS.map((t) => (
        <NavLink
          key={t.id}
          to={t.to}
          className={'tab-button ' + (active === t.id ? 'active' : '')}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  )
}
