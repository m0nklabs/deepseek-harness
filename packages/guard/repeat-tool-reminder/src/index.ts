/**
 * Advisory per-agent repeat-call detector. It enriches post-execute decisions
 * with logged model context without vetoing or rewriting calls. Configuration
 * and chain semantics live in the package README; rationale lives in the
 * repeat-tool-reminder Agent Note.
 * @module @deepseek-ai/dsh-repeat-tool-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'repeat-tool-reminder': { kind: 'repeat-tool-reminder' } & ContextFormed
  }
}

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'repeat-tool-reminder'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: an empty
 * `thresholds` list, a non-integer, a value below 2, or a duplicate throws at
 * plugin load, never a silent fall-back). `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[]
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Maximum characters of canonical arguments quoted in the DETAILED reminder
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
  /**
   * Per-tool hard cap within one user-bounded run: when ONE tracked tool has
   * been called more than N times in a row regardless of arguments, every
   * further call's result is withheld and replaced by a hard-stop block until
   * the user replies (which resets the counters). 0 disables the cap — the
   * default, so the package stays advisory unless a deployment opts in.
   * Rationale: the exact-match chain cannot see argument-rotating loops (each
   * different-argument call resets the chain to 1); a deployment that lets a
   * model enumerate a bounded catalog (e.g. template search) can still be
   * consumed by such a loop (observed: one agent emitted ~70
   * `search_templates` calls with rotating one-word queries, surviving a
   * compaction checkpoint).
   */
  toolCallCap?: number
}

export const Config: z<Config> = z.object({
  thresholds: z.array(z.number()).default([3, 5, 8]),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
  toolCallCap: z.number().int().min(0).default(0),
})

/**
 * The `{kind:'repeat-tool-reminder'}` producer source stamped on every reminder
 * this guard injects — the label is load-bearing (an unlabeled context would
 * render as a user prompt in derived history).
 */
const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }

/**
 * The gentle first-threshold reminder. Keyed to `thresholds[0]`, not a literal
 * count, so a custom first threshold keeps the gentle-then-detailed escalation.
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

/** The detailed later-threshold reminder naming the tool, the run length, and the canonical arguments. */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

/**
 * The hard-stop feedback for a per-tool cap breach. Unlike the reminders, this
 * text rides a `block` decision: the deployment opted into enforcement.
 */
function hardStopNotice(toolName: string, runCount: number, cap: number): string {
  return 'Hard per-tool call cap exceeded:\n'
    + `- tool: ${toolName}\n`
    + `- calls_this_run: ${runCount} (cap: ${cap})\n`
    + 'The tool result is withheld. Do not call this tool again this run: '
    + 'summarize what you have so far, switch to a materially different '
    + 'approach, or finish the task. The counter resets when the user replies.'
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the
 * chain key always uses the full canonical string.
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/**
 * Validate `thresholds` per the fail-loud contract and return them sorted
 * ascending (the escalation rule reads `thresholds[0]` as the gentle tier, so
 * order is normalized here, once).
 */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('repeat-tool-reminder: `thresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('repeat-tool-reminder: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Prepend the guard's reminder while preserving every downstream context's
 * source and metadata.
 */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** One agent's consecutive-repeat chain: the last tracked call's identity key and its run length. */
interface Chain {
  key: string
  count: number
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `thresholds` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the fields are set after validation.
  const thresholds = validateThresholds(config.thresholds as number[])
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }

  const chains = new WeakMap<Agent, Chain>()
  /** Per-tool call totals within one user-bounded run; reset together with the chain. */
  const toolRuns = new WeakMap<Agent, Map<string, number>>()

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  /**
   * Advance the calling agent's chain for one attempt and return the reminder
   * to deliver, if this attempt's run length hits a configured threshold.
   * Counting happens here — in post-execute — because denied calls also flow
   * through this waterfall (`ToolRuntime.execute` routes a deny through the
   * same pipeline), and a model hammering a denied call is exactly the loop
   * worth breaking.
   */
  /** One post-execute observation: an optional reminder message, plus the hard-stop feedback text when the configured per-tool cap is exceeded. */
  interface Observation {
    reminder?: UserMessage
    blockText?: string
  }

  function observe(exec: ToolExecution): Observation | undefined {
    // A direct `ctx.tools.execute()` caller has no model to remind and no id
    // to key on; only agent-loop calls participate.
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    const canonical = canonicalize(exec.arguments)
    const key = JSON.stringify([exec.name, canonical])
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(exec.agent, { key, count })
    let reminder: UserMessage | undefined
    let blockText: string | undefined
    if (toolCallCap > 0) {
      const runs = toolRuns.get(exec.agent) ?? new Map<string, number>()
      const runCount = (runs.get(exec.name) ?? 0) + 1
      runs.set(exec.name, runCount)
      toolRuns.set(exec.agent, runs)
      if (runCount > toolCallCap) {
        blockText = hardStopNotice(exec.name, runCount, toolCallCap)
        reminder = createUserMessage({
          content: [{ type: 'text', text: blockText }],
          source: { ...REMINDER_SOURCE, form: 'notice', summary: `${exec.name} cap ${runCount}/${toolCallCap}` },
        })
        return { reminder, blockText }
      }
    }
    if (!thresholdSet.has(count)) return { reminder }
    const text = count === thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
    reminder = createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...REMINDER_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
    })
    return { reminder }
  }

  // Observe-and-enrich, never veto: count first (state advances regardless of
  // the downstream outcome), DELEGATE so a later listener can still block or
  // replace, then fold the reminder onto whatever came back — additionalContexts
  // rides both decision variants, so a blocked call still gets the nudge.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const observation = observe(exec)
    const downstream = await next()
    if (observation === undefined || observation.reminder === undefined) return downstream
    if (observation.blockText !== undefined) {
      // The cap is a configured hard stop: the call already ran, so feeding
      // the loop another near-identical result is withheld — the result is
      // replaced by the hard-stop feedback, while an existing block (a deny)
      // keeps its own feedback and only gains the notice.
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(observation.reminder, downstream.additionalContexts) }
      }
      return { kind: 'block', feedback: [{ type: 'text', text: observation.blockText }] }
    }
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(observation.reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(observation.reminder, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      chains.delete(agent)
      toolRuns.delete(agent)
    }
    return next()
  })
}
