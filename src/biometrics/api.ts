// MediaPipe Tasks Vision loader (CDN, ESM dynamic import).
//
// Diverges from ensureLeaflet / ensureMermaid (which load UMD via <script>):
// MediaPipe Tasks Vision ships ESM only on jsDelivr, so we use dynamic
// import() of an ESM bundle URL. Cached on first success; a second caller
// awaits the same Promise.
//
// Failure is loud — no fallback path. If jsDelivr or storage.googleapis.com
// is blocked, the consumer renders an inline error rather than a silent
// degradation.

// Pinned to a known-good version. Bump deliberately and verify against
// the FaceLandmarker model file format (model card V2).
const TASKS_VISION_VERSION = '0.10.18'
const TASKS_VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
// Google's model CDN. CSP must allow connect-src to this host.
const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// We don't depend on @types/mediapipe — the surface we use is small and
// pinning a type definition would lock the version more aggressively than
// we want. Inline shapes only describe what we actually call.
export interface FilesetResolverApi {
  forVisionTasks(wasmBaseUrl: string): Promise<unknown>
}
export interface FaceLandmarkerApi {
  createFromOptions(fileset: unknown, options: unknown): Promise<FaceLandmarkerInstance>
}
export interface FaceLandmarkerInstance {
  detectForVideo(video: HTMLVideoElement, ts: number): FaceLandmarkerResult
  close(): void
}
export interface FaceLandmarkerResult {
  faceLandmarks?: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z?: number }>>
  faceBlendshapes?: ReadonlyArray<{
    categories: ReadonlyArray<{ categoryName: string; score: number }>
  }>
  facialTransformationMatrixes?: ReadonlyArray<{
    data: ReadonlyArray<number>
  }>
}
export interface MediaPipeBundle {
  readonly FilesetResolver: FilesetResolverApi
  readonly FaceLandmarker: FaceLandmarkerApi
  readonly modelUrl: string
}

let cached: Promise<MediaPipeBundle> | null = null

export const ensureMediaPipe = (): Promise<MediaPipeBundle> => {
  if (cached) return cached
  cached = (async () => {
    let mod: { FilesetResolver: FilesetResolverApi; FaceLandmarker: FaceLandmarkerApi }
    try {
      mod = await import(/* @vite-ignore */ TASKS_VISION_URL) as typeof mod
    } catch (err) {
      cached = null
      throw new Error(`MediaPipe Tasks Vision import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      FilesetResolver: mod.FilesetResolver,
      FaceLandmarker: mod.FaceLandmarker,
      modelUrl: FACE_LANDMARKER_MODEL_URL,
    }
  })()
  return cached
}

export const getWasmBaseUrl = (): string => WASM_BASE_URL
