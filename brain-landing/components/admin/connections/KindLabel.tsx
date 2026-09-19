import {
  Cloud,
  CloudCog,
  Database,
  Folder,
  GitBranch,
  Globe,
  HardDrive,
  Package,
  Plug,
  Server,
  Upload,
} from 'lucide-react'
import { fill, type ConnectionsT } from './shared'
import type { SourceFamily, SourceGroup } from './kinds'

type Icon = React.ComponentType<{ className?: string }>

export const KIND_ICONS: Record<SourceFamily, Icon> = {
  folder: Folder,
  site: Globe,
  bucket: Cloud,
  mcp: Server,
  repo: GitBranch,
  gdrive: HardDrive,
  onedrive: CloudCog,
  dropbox: Package,
  records: Database,
  external: Upload,
  other: Plug,
}

export const GROUP_ICONS: Record<SourceGroup, Icon> = {
  files: Folder,
  web: Globe,
  mcp: Server,
  code: GitBranch,
  records: Database,
  external: Upload,
  other: Plug,
}

/** The records family names the vendor: the vendor's name for a vendor connector, "custom REST" for the config-driven one. */
export const CONNECTOR_NAMES: Record<string, string> = {
  pipedrive: 'Pipedrive',
  hubspot: 'HubSpot',
  bitrix24: 'Bitrix24',
  kommo: 'Kommo / amoCRM',
  salesforce: 'Salesforce',
  rest_records: 'custom REST / OpenAPI',
}

export function kindTitle(t: ConnectionsT, family: SourceFamily, connector: string): string {
  return fill(t.kinds[family].title, { connector: CONNECTOR_NAMES[connector] ?? connector })
}

export function KindLabel({
  family,
  connector,
  t,
}: {
  family: SourceFamily
  connector: string
  t: ConnectionsT
}) {
  const Icon = KIND_ICONS[family]
  return (
    <span className="inline-flex items-center gap-1 text-[var(--text)]">
      <Icon className="w-3 h-3 text-[var(--text-muted)]" /> {kindTitle(t, family, connector)}
    </span>
  )
}

/** A group's heading — icon, name, how many things are in it. */
export function GroupHeading({
  group,
  count,
  t,
  as = 'h3',
}: {
  group: SourceGroup
  count: number
  t: ConnectionsT
  as?: 'h3' | 'span'
}) {
  const Icon = GROUP_ICONS[group]
  const Tag = as
  return (
    <Tag className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
      <Icon className="w-3.5 h-3.5 text-[var(--accent)]" />
      {t.groups[group].title}
      <span className="font-mono text-[10px] font-normal text-[var(--text-faint)]">{count}</span>
    </Tag>
  )
}
