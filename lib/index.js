/**
 * dsh-tidewatch host plugin.
 *
 * A single responsibility: register the `costUsage` session projection — collect
 * the usage block of every model call from the session event stream
 * (request/header, assistant/chunk, assistant/message), pick the price era by the
 * event's own instant (event.time), bill each call, and produce token buckets plus
 * a USD cost. The browser half (lib/client.js) reads it through
 * useProjection('costUsage') and converts to the display currency.
 *
 * The projection factory structure is adapted from dsh-cost-meter (MIT License) and
 * rewritten for a lean goal: no ledger, no RPC, no configuration, peak/off-peak
 * always enabled (the two-tier scheme has been in effect since 2026-08-17).
 */

import { z } from 'zod'
import { costOf, priceEntryFor } from './pricing.js'

export const name = 'tidewatch'

const bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
})

// Projection state schema (newer session-projection interface: stateSchema validates
// state before a persisted cache is restored; state must be plain JSON).
const costUsageStateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  totals: bucketSchema,
  byModel: z.record(z.string(), bucketSchema),
  last: z.union([
    z.null(),
    z.object({ key: z.string(), model: z.string(), buckets: bucketSchema, cost: z.number() }),
  ]),
})

// Client wire payload schema (the view output pushed to the browser with session/projection frames).
const usageProjectionSchema = z.object({
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  byModel: z.record(z.string(), bucketSchema),
})

/**
 * costUsage session projection factory: the closure is stateless (no ledger, no
 * configuration) and bills each call by the event's own instant (event.time) using
 * the tier in force at that moment, so historical session totals stay correct.
 */
function makeCostUsageProjection() {
  const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 })
  return {
    key: 'costUsage',
    stateSchema: costUsageStateSchema,
    // v4: added the first peak/off-peak tier (2026-08-16 16:00Z ~ 2026-09-10 04:00Z)
    // and explicitly registered the V4.1 Flash rename alias, fixing the billing basis
    // inside the repricing window. A ver=3 cache row folds through the old code (whose
    // amounts inside the repricing window were computed at the then-current price, so a
    // replay matches); the bump only unifies the basis on "pick the tier by the event
    // instant", at the cost of one full replay.
    stateVersion: 4,
    init: () => ({ provider: 'deepseek', model: 'default', totals: zeroBuckets(), byModel: {}, last: null }),
    apply(state, event) {
      if (event.type === 'request/header') {
        const model = event.data?.header?.config?.model
        const provider = event.data?.header?.config?.provider
        const nextModel = typeof model === 'string' && model.length > 0 ? model : 'default'
        const nextProvider = typeof provider === 'string' && provider.length > 0 ? provider : 'deepseek'
        return nextModel === state.model && nextProvider === state.provider ? state : { ...state, model: nextModel, provider: nextProvider }
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' && event.data.chunk.usage !== undefined) {
        usage = event.data.chunk.usage
        turn = event.data.turn
        step = event.data.step
      } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
        usage = event.data.usage
        turn = event.data.turn
        step = event.data.step
      } else {
        return state
      }
      const buckets = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      }
      const key = `${turn}:${step}`
      const prev = state.last !== null && state.last.key === key ? state.last : null
      if (prev !== null && prev.provider === state.provider && prev.model === state.model
        && prev.buckets.input === buckets.input && prev.buckets.output === buckets.output
        && prev.buckets.cacheRead === buckets.cacheRead && prev.buckets.cacheWrite === buckets.cacheWrite
        && prev.buckets.reasoning === buckets.reasoning) {
        return state
      }
      // Bill by the event instant (historical accuracy): base price → first peak/off-peak
      // price → current peak/off-peak price, picking one of the three eras.
      const atMs = Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Date.now()
      const entry = priceEntryFor(state.model, atMs)
      const billed = costOf(buckets, entry, atMs)
      // The final sample for a (turn, step) replaces the streaming sample: subtract
      // first, then add, so nothing is counted twice.
      const totals = { ...state.totals }
      const byModel = { ...state.byModel }
      const shift = (model, bucket, cost, sign) => {
        totals.input += sign * bucket.input
        totals.output += sign * bucket.output
        totals.cacheRead += sign * bucket.cacheRead
        totals.cacheWrite += sign * bucket.cacheWrite
        totals.reasoning += sign * bucket.reasoning
        totals.cost += sign * cost
        const current = byModel[model] ?? zeroBuckets()
        byModel[model] = {
          input: current.input + sign * bucket.input,
          output: current.output + sign * bucket.output,
          cacheRead: current.cacheRead + sign * bucket.cacheRead,
          cacheWrite: current.cacheWrite + sign * bucket.cacheWrite,
          reasoning: current.reasoning + sign * bucket.reasoning,
          cost: current.cost + sign * cost,
        }
      }
      if (prev !== null) shift(prev.model, prev.buckets, prev.cost, -1)
      shift(state.model, buckets, billed, 1)
      return { provider: state.provider, model: state.model, totals, byModel, last: { key, model: state.model, buckets, cost: billed } }
    },
    // Client-visible view: a missing wire makes the projection host-only, so the
    // browser's useProjection never sees it — the root cause of a perpetual zero
    // cost after a DSH upgrade.
    wire: {
      viewSchema: usageProjectionSchema,
      view(state) {
        return {
          // Model currently in use in this session (the most recent request header; 'default' before any request).
          model: state.model,
          input: state.totals.input,
          output: state.totals.output,
          cacheRead: state.totals.cacheRead,
          cacheWrite: state.totals.cacheWrite,
          reasoning: state.totals.reasoning,
          cost: state.totals.cost,
          byModel: state.byModel,
        }
      },
    },
  }
}

/**
 * Mount: register the costUsage session projection. No other host responsibility.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  console.log('[dsh-tidewatch] loaded (peak/off-peak tide card)')
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeCostUsageProjection())
  })
}
