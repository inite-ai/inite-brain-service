import { Suspense } from 'react'
import { KeyLens } from '../../../../components/admin/policies/KeyLens'

export const dynamic = 'force-dynamic'

export default function KeyLensPage() {
  return (
    <Suspense>
      <KeyLens />
    </Suspense>
  )
}
