/**
 * Drift guards — admin panels render filter/sort lists that mirror enums
 * in lib/contracts (the landing-side wire-contract mirrors, which backend
 * PRs are expected to keep in sync). The panels now derive those lists
 * from the contracts; these tests fail if anyone re-hardcodes a copy and
 * it drifts (that's exactly how 'registry'/'billing' went missing from
 * ConfigPanel and 7 job types from JobsPanel).
 */
import { describe, it, expect } from 'vitest'
import { CATEGORY_ORDER } from '@/components/admin/ConfigPanel'
import { STATUSES } from '@/components/admin/JobsPanel'
import { CONFIG_CATEGORIES } from '@/lib/contracts/admin-config'
import { JOB_STATUSES } from '@/lib/contracts/admin-jobs'

describe('ConfigPanel category order ↔ admin-config contract', () => {
  it('covers exactly the contract enum values (no missing, no unknown)', () => {
    expect([...CATEGORY_ORDER].sort()).toEqual([...CONFIG_CATEGORIES].sort())
  })

  it('has no duplicates', () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length)
  })
})

describe('JobsPanel status filter ↔ admin-jobs contract', () => {
  it("covers exactly '' (= all) plus the contract status values", () => {
    expect([...STATUSES]).toEqual(['', ...JOB_STATUSES])
  })
})
