// ============================================================================
// Op-builder — converts a (op-name, args) pair from the scenario YAML block
// into a typed ScenarioOp. Plus the parse-time name-resolution validator
// (ensures `room:` / `as:` references resolve against earlier declarations).
//
// Scenario-specific knowledge lives ONLY here. To add a new op:
//   1. Add the variant to ScenarioOp in types.ts
//   2. Add a case to buildOp's switch
//   3. (If it references named entities) extend validateNameReferences
// ============================================================================

import type { ScenarioOp, GuideWait, ExternalWait } from './types.ts'
import { ScenarioParseError } from './errors.ts'

// === Build a typed op from {key:val} args + the source-line ===

export const buildOp = (
  opName: string,
  args: Record<string, unknown>,
  absLine: number,
): ScenarioOp => {
  const single = (args as { __single?: string }).__single
  const line = absLine
  const requireStr = (k: string): string => {
    const v = args[k]
    if (typeof v !== 'string' || v.length === 0) {
      throw new ScenarioParseError(`${opName}: missing required string field "${k}"`, absLine)
    }
    return v
  }
  const optStr = (k: string): string | undefined => {
    const v = args[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const optStrArr = (k: string): ReadonlyArray<string> | undefined => {
    const v = args[k]
    if (v === undefined) return undefined
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as ReadonlyArray<string>
    throw new ScenarioParseError(`${opName}: field "${k}" must be string array`, absLine)
  }
  const optWait = (): GuideWait | undefined => {
    const v = args.waitFor
    if (v === undefined) return undefined
    if (typeof v !== 'object' || v === null) {
      throw new ScenarioParseError(`${opName}: waitFor must be object`, absLine)
    }
    const w = v as Record<string, unknown>
    const t = w.type
    if (t === 'click') return w.selector ? { type: 'click', selector: String(w.selector) } : { type: 'click' }
    if (t === 'post') return { type: 'post', room: String(w.room ?? '') }
    if (t === 'timer') return { type: 'timer', seconds: Number(w.seconds ?? 5) }
    throw new ScenarioParseError(`${opName}: waitFor.type must be click|post|timer`, absLine)
  }

  switch (opName) {
    case 'install-pack': {
      const source = single ?? requireStr('source')
      const name = optStr('name')
      return name ? { kind: 'install-pack', line, source, name } : { kind: 'install-pack', line, source }
    }
    case 'create-room': {
      const name = single ?? requireStr('name')
      const roomPrompt = optStr('roomPrompt')
      return roomPrompt
        ? { kind: 'create-room', line, name, roomPrompt }
        : { kind: 'create-room', line, name }
    }
    case 'activate-pack': {
      return {
        kind: 'activate-pack',
        line,
        room: requireStr('room'),
        pack: requireStr('pack'),
      }
    }
    case 'spawn-agent': {
      const tools = optStrArr('tools')
      const base = {
        kind: 'spawn-agent' as const,
        line,
        room: requireStr('room'),
        name: requireStr('name'),
        model: requireStr('model'),
        persona: requireStr('persona'),
      }
      return tools ? { ...base, tools } : base
    }
    case 'spawn-human': {
      return {
        kind: 'spawn-human',
        line,
        room: requireStr('room'),
        name: requireStr('name'),
      }
    }
    case 'post-message': {
      return {
        kind: 'post-message',
        line,
        room: requireStr('room'),
        as: requireStr('as'),
        body: requireStr('body'),
      }
    }
    case 'start-script': {
      return {
        kind: 'start-script',
        line,
        room: requireStr('room'),
        scriptName: requireStr('scriptName'),
      }
    }
    case 'guide-tooltip': {
      const wait = optWait()
      const base = {
        kind: 'guide-tooltip' as const,
        line,
        selector: requireStr('selector'),
        body: requireStr('body'),
      }
      return wait ? { ...base, waitFor: wait } : base
    }
    case 'guide-modal': {
      const wait = optWait()
      const base = {
        kind: 'guide-modal' as const,
        line,
        title: requireStr('title'),
        body: requireStr('body'),
      }
      return wait ? { ...base, waitFor: wait } : base
    }
    case 'guide-toast': {
      const variant = optStr('variant')
      if (variant !== undefined && variant !== 'success' && variant !== 'error') {
        throw new ScenarioParseError(`guide-toast.variant must be 'success' or 'error'`, absLine)
      }
      return variant
        ? { kind: 'guide-toast', line, body: requireStr('body'), variant: variant as 'success' | 'error' }
        : { kind: 'guide-toast', line, body: requireStr('body') }
    }
    case 'wait': {
      const v = args.waitFor
      if (typeof v !== 'object' || v === null) {
        throw new ScenarioParseError(`wait: missing required object field "waitFor"`, absLine)
      }
      const w = v as Record<string, unknown>
      const t = w.type
      if (t !== 'timer' && t !== 'llm-response' && t !== 'script-completed') {
        throw new ScenarioParseError(`wait.waitFor.type must be 'timer' | 'llm-response' | 'script-completed'`, absLine)
      }
      let waitFor: ExternalWait
      if (t === 'timer') {
        const seconds = Number(w.seconds ?? NaN)
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new ScenarioParseError(`wait.waitFor.seconds must be a non-negative number`, absLine)
        }
        waitFor = { type: 'timer', seconds }
      } else if (t === 'llm-response') {
        if (typeof w.agent !== 'string' || w.agent.length === 0) {
          throw new ScenarioParseError(`wait.waitFor.agent is required for type 'llm-response'`, absLine)
        }
        waitFor = { type: 'llm-response', agent: w.agent }
      } else {
        if (typeof w.room !== 'string' || w.room.length === 0) {
          throw new ScenarioParseError(`wait.waitFor.room is required for type 'script-completed'`, absLine)
        }
        if (typeof w.scriptName !== 'string' || w.scriptName.length === 0) {
          throw new ScenarioParseError(`wait.waitFor.scriptName is required for type 'script-completed'`, absLine)
        }
        waitFor = { type: 'script-completed', room: w.room, scriptName: w.scriptName }
      }
      return { kind: 'wait', line, waitFor }
    }
    default:
      throw new ScenarioParseError(`unknown op "${opName}"`, absLine)
  }
}

// === Parse-time name resolution ===
//
// Walks the op list and verifies every `room:` / `as:` reference is to a
// name declared earlier (or to "system" for `as:`). Catches typos at scenario-
// load time rather than mid-run.

export const validateNameReferences = (ops: ReadonlyArray<ScenarioOp>): void => {
  const declaredRooms = new Set<string>()
  const declaredAgents = new Set<string>(['system'])
  for (const op of ops) {
    switch (op.kind) {
      case 'create-room':
        declaredRooms.add(op.name)
        break
      case 'spawn-agent':
        if (!declaredRooms.has(op.room)) {
          throw new ScenarioParseError(
            `spawn-agent references undeclared room "${op.room}" (declare it with create-room first)`,
            op.line,
          )
        }
        declaredAgents.add(op.name)
        break
      case 'spawn-human':
        if (!declaredRooms.has(op.room)) {
          throw new ScenarioParseError(
            `spawn-human references undeclared room "${op.room}"`,
            op.line,
          )
        }
        declaredAgents.add(op.name)
        break
      case 'activate-pack':
      case 'start-script':
        if (!declaredRooms.has(op.room)) {
          throw new ScenarioParseError(
            `${op.kind} references undeclared room "${op.room}"`,
            op.line,
          )
        }
        break
      case 'post-message':
        if (!declaredRooms.has(op.room)) {
          throw new ScenarioParseError(
            `post-message references undeclared room "${op.room}"`,
            op.line,
          )
        }
        if (!declaredAgents.has(op.as)) {
          throw new ScenarioParseError(
            `post-message references undeclared sender "${op.as}" (declare with spawn-agent/spawn-human, or use "system")`,
            op.line,
          )
        }
        break
      case 'wait':
        if (op.waitFor.type === 'llm-response') {
          if (!declaredAgents.has(op.waitFor.agent)) {
            throw new ScenarioParseError(
              `wait { type: llm-response, agent: "${op.waitFor.agent}" } references undeclared agent`,
              op.line,
            )
          }
        } else if (op.waitFor.type === 'script-completed') {
          if (!declaredRooms.has(op.waitFor.room)) {
            throw new ScenarioParseError(
              `wait { type: script-completed, room: "${op.waitFor.room}" } references undeclared room`,
              op.line,
            )
          }
        }
        break
      // install-pack / guide-* don't reference declared names.
    }
  }
}
