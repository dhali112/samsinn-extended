// Scenario parse-error type. Lives in its own file so parser/yaml-mini/
// op-builder can all import without an import cycle (parser used to host
// it, but op-builder needed parser, and parser needed yaml-mini → cycle).

export class ScenarioParseError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`line ${line}: ${message}`)
    this.name = 'ScenarioParseError'
  }
}
