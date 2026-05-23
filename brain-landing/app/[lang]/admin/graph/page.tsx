import { GraphExplorer } from '../../../../components/admin/GraphExplorer'

export const dynamic = 'force-dynamic'

export default function GraphPage() {
  return (
    <div className="h-[calc(100vh-7rem)] min-h-[600px] -m-2">
      <GraphExplorer />
    </div>
  )
}
