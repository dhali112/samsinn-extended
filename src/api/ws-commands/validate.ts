import type { IncludeContext, IncludePrompts } from '../../core/types/agent.ts'
import type { MessageTarget } from '../../core/types/messaging.ts'
import { validateSummaryConfig } from '../../core/types/summary.ts'
import type { BiometricSignalWire, WSInbound } from '../../core/types/ws-protocol.ts'

type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }
type RawObject = Record<string, unknown>

const isObject = (value: unknown): value is RawObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isStringArray = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value) && value.every(item => typeof item === 'string')

const requiredString = (obj: RawObject, key: string): ValidationResult<string> => {
  const value = obj[key]
  return typeof value === 'string'
    ? { ok: true, value }
    : { ok: false, error: `${key} must be a string` }
}

const optionalString = (obj: RawObject, key: string): ValidationResult<string | undefined> => {
  const value = obj[key]
  return value === undefined || typeof value === 'string'
    ? { ok: true, value }
    : { ok: false, error: `${key} must be a string when present` }
}

const requiredBoolean = (obj: RawObject, key: string): ValidationResult<boolean> => {
  const value = obj[key]
  return typeof value === 'boolean'
    ? { ok: true, value }
    : { ok: false, error: `${key} must be a boolean` }
}

const optionalNumber = (obj: RawObject, key: string): ValidationResult<number | undefined> => {
  const value = obj[key]
  return value === undefined || typeof value === 'number'
    ? { ok: true, value }
    : { ok: false, error: `${key} must be a number when present` }
}

const validateTarget = (value: unknown): ValidationResult<MessageTarget> => {
  if (!isObject(value)) return { ok: false, error: 'target must be an object' }
  if (!isStringArray(value.rooms)) return { ok: false, error: 'target.rooms must be an array of strings' }
  return { ok: true, value: { rooms: value.rooms } }
}

const validateBooleanMap = <T extends IncludePrompts | IncludeContext>(value: unknown, key: string): ValidationResult<T | undefined> => {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isObject(value)) return { ok: false, error: `${key} must be an object when present` }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'boolean') return { ok: false, error: `${key}.${entryKey} must be a boolean` }
  }
  return { ok: true, value: value as T }
}

const validateCreateAgent = (obj: RawObject): ValidationResult<Extract<WSInbound, { type: 'create_agent' }>> => {
  const config = obj.config
  if (!isObject(config)) return { ok: false, error: 'config must be an object' }
  const name = requiredString(config, 'name')
  if (!name.ok) return name
  const model = requiredString(config, 'model')
  if (!model.ok) return model
  const persona = requiredString(config, 'persona')
  if (!persona.ok) return persona
  if (config.tools !== undefined && !isStringArray(config.tools)) return { ok: false, error: 'config.tools must be an array of strings when present' }
  if (config.tags !== undefined && !isStringArray(config.tags)) return { ok: false, error: 'config.tags must be an array of strings when present' }
  for (const key of ['temperature', 'seed', 'historyLimit', 'maxToolIterations']) {
    const result = optionalNumber(config, key)
    if (!result.ok) return result
  }
  for (const key of ['preferredModel']) {
    const result = optionalString(config, key)
    if (!result.ok) return result
  }
  for (const key of ['thinking', 'includeTools', 'promptsEnabled', 'contextEnabled']) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'boolean') return { ok: false, error: `config.${key} must be a boolean when present` }
  }
  const includePrompts = validateBooleanMap<IncludePrompts>(config.includePrompts, 'config.includePrompts')
  if (!includePrompts.ok) return includePrompts
  const includeContext = validateBooleanMap<IncludeContext>(config.includeContext, 'config.includeContext')
  if (!includeContext.ok) return includeContext
  return { ok: true, value: { type: 'create_agent', config: config as unknown as Extract<WSInbound, { type: 'create_agent' }>['config'] } }
}

const validateUpdateAgent = (obj: RawObject): ValidationResult<Extract<WSInbound, { type: 'update_agent' }>> => {
  const name = requiredString(obj, 'name')
  if (!name.ok) return name
  for (const key of ['persona', 'model']) {
    const result = optionalString(obj, key)
    if (!result.ok) return result
  }
  const includePrompts = validateBooleanMap<IncludePrompts>(obj.includePrompts, 'includePrompts')
  if (!includePrompts.ok) return includePrompts
  const includeContext = validateBooleanMap<IncludeContext>(obj.includeContext, 'includeContext')
  if (!includeContext.ok) return includeContext
  if (obj.includeTools !== undefined && typeof obj.includeTools !== 'boolean') return { ok: false, error: 'includeTools must be a boolean when present' }
  const maxToolIterations = optionalNumber(obj, 'maxToolIterations')
  if (!maxToolIterations.ok) return maxToolIterations
  if (obj.tools !== undefined && !isStringArray(obj.tools)) return { ok: false, error: 'tools must be an array of strings when present' }
  return { ok: true, value: obj as Extract<WSInbound, { type: 'update_agent' }> }
}

const validateSignal = (value: unknown): ValidationResult<BiometricSignalWire> => {
  if (!isObject(value)) return { ok: false, error: 'snapshot must be an object' }
  for (const key of ['ts', 'faceCount', 'attention', 'blinkRate']) {
    if (typeof value[key] !== 'number') return { ok: false, error: `snapshot.${key} must be a number` }
  }
  if (typeof value.presence !== 'boolean') return { ok: false, error: 'snapshot.presence must be a boolean' }
  if (!isObject(value.expression) || !isObject(value.headPose)) return { ok: false, error: 'snapshot expression and headPose must be objects' }
  for (const key of ['smile', 'surprise', 'frown', 'concentration']) {
    if (typeof value.expression[key] !== 'number') return { ok: false, error: `snapshot.expression.${key} must be a number` }
  }
  for (const key of ['yaw', 'pitch', 'roll']) {
    if (typeof value.headPose[key] !== 'number') return { ok: false, error: `snapshot.headPose.${key} must be a number` }
  }
  return { ok: true, value: value as unknown as BiometricSignalWire }
}

export const validateWSInbound = (raw: unknown): ValidationResult<WSInbound> => {
  if (!isObject(raw)) return { ok: false, error: 'message must be a JSON object' }
  if (typeof raw.type !== 'string') return { ok: false, error: 'type must be a string' }

  switch (raw.type) {
    case 'post_message': {
      const target = validateTarget(raw.target)
      if (!target.ok) return target
      const content = requiredString(raw, 'content')
      if (!content.ok) return content
      const senderId = optionalString(raw, 'senderId')
      if (!senderId.ok) return senderId
      return { ok: true, value: { type: 'post_message', target: target.value, content: content.value, ...(senderId.value ? { senderId: senderId.value } : {}) } }
    }
    case 'create_room': {
      const name = requiredString(raw, 'name')
      if (!name.ok) return name
      const roomPrompt = optionalString(raw, 'roomPrompt')
      if (!roomPrompt.ok) return roomPrompt
      return { ok: true, value: { type: 'create_room', name: name.value, ...(roomPrompt.value !== undefined ? { roomPrompt: roomPrompt.value } : {}) } }
    }
    case 'add_to_room':
    case 'remove_from_room':
    case 'set_muted':
    case 'activate_agent': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      const agentName = requiredString(raw, 'agentName')
      if (!agentName.ok) return agentName
      if (raw.type === 'set_muted') {
        const muted = requiredBoolean(raw, 'muted')
        if (!muted.ok) return muted
        return { ok: true, value: { type: raw.type, roomName: roomName.value, agentName: agentName.value, muted: muted.value } }
      }
      return { ok: true, value: { type: raw.type, roomName: roomName.value, agentName: agentName.value } }
    }
    case 'create_agent':
      return validateCreateAgent(raw)
    case 'update_agent':
      return validateUpdateAgent(raw)
    case 'remove_agent':
    case 'cancel_generation': {
      const name = requiredString(raw, 'name')
      if (!name.ok) return name
      return { ok: true, value: { type: raw.type, name: name.value } }
    }
    case 'set_delivery_mode': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      if (raw.mode !== 'broadcast' && raw.mode !== 'manual') return { ok: false, error: "mode must be 'broadcast' or 'manual'" }
      return { ok: true, value: { type: 'set_delivery_mode', roomName: roomName.value, mode: raw.mode } }
    }
    case 'set_paused': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      const paused = requiredBoolean(raw, 'paused')
      if (!paused.ok) return paused
      return { ok: true, value: { type: 'set_paused', roomName: roomName.value, paused: paused.value } }
    }
    case 'delete_room':
    case 'clear_messages': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      return { ok: true, value: { type: raw.type, roomName: roomName.value } }
    }
    case 'delete_message': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      const messageId = requiredString(raw, 'messageId')
      if (!messageId.ok) return messageId
      return { ok: true, value: { type: 'delete_message', roomName: roomName.value, messageId: messageId.value } }
    }
    case 'set_summary_config': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      const config = validateSummaryConfig(raw.config)
      if (!config.ok) return { ok: false, error: `config.${config.error}` }
      return { ok: true, value: { type: 'set_summary_config', roomName: roomName.value, config: config.value } }
    }
    case 'regenerate_summary': {
      const roomName = requiredString(raw, 'roomName')
      if (!roomName.ok) return roomName
      if (raw.target !== 'summary' && raw.target !== 'compression' && raw.target !== 'both') return { ok: false, error: "target must be 'summary', 'compression', or 'both'" }
      return { ok: true, value: { type: 'regenerate_summary', roomName: roomName.value, target: raw.target } }
    }
    case 'biometric_capture_started':
    case 'biometric_capture_denied': {
      const captureId = requiredString(raw, 'captureId')
      if (!captureId.ok) return captureId
      return { ok: true, value: { type: raw.type, captureId: captureId.value } }
    }
    case 'biometric_capture_signal': {
      const captureId = requiredString(raw, 'captureId')
      if (!captureId.ok) return captureId
      const snapshot = validateSignal(raw.snapshot)
      if (!snapshot.ok) return snapshot
      return { ok: true, value: { type: 'biometric_capture_signal', captureId: captureId.value, snapshot: snapshot.value } }
    }
    case 'biometric_capture_stopped': {
      const captureId = requiredString(raw, 'captureId')
      if (!captureId.ok) return captureId
      if (raw.reason !== 'user' && raw.reason !== 'agent' && raw.reason !== 'unmount' && raw.reason !== 'disconnect' && raw.reason !== 'error') {
        return { ok: false, error: 'reason must be a biometric stop reason' }
      }
      return { ok: true, value: { type: 'biometric_capture_stopped', captureId: captureId.value, reason: raw.reason } }
    }
    case 'biometric_capture_failed': {
      const captureId = requiredString(raw, 'captureId')
      if (!captureId.ok) return captureId
      const error = requiredString(raw, 'error')
      if (!error.ok) return error
      return { ok: true, value: { type: 'biometric_capture_failed', captureId: captureId.value, error: error.value } }
    }
    default:
      return { ok: true, value: raw as unknown as WSInbound }
  }
}
