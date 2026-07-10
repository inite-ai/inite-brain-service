'use client'

import { useParams } from 'next/navigation'
import { PolicySetEditor } from '../../../../../components/admin/policies/PolicySetEditor'

export default function PolicySetPage() {
  const params = useParams<{ policySetId: string }>()
  const name = decodeURIComponent(params?.policySetId ?? '')
  if (!name) return null
  return <PolicySetEditor name={name} />
}
