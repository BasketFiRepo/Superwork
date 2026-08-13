/** Failure taxonomy (§5.6). The UI copy differs per class, so the class travels with the error. */
export type FailureClass =
  | 'transient'
  | 'auth'
  | 'permission'
  | 'validation'
  | 'not_found'
  | 'ambiguous'
  | 'policy'
  | 'model'
  | 'budget'
  | 'conflict'

export class SuperworkError extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SuperworkError'
  }
}

export class PermissionError extends SuperworkError {
  constructor(reason: string, detail: Record<string, unknown> = {}) {
    super('permission', reason, detail)
    this.name = 'PermissionError'
  }
}

/** Cross-tenant access is reported as absence, never as denial (§3.2). */
export class NotFoundError extends SuperworkError {
  constructor(message = 'Not found.') {
    super('not_found', message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends SuperworkError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('conflict', message, detail)
    this.name = 'ConflictError'
  }
}

export class AmbiguousEntityError extends SuperworkError {
  constructor(
    message: string,
    public readonly candidates: { id: string; label: string; hint?: string }[],
  ) {
    super('ambiguous', message, { candidates })
    this.name = 'AmbiguousEntityError'
  }
}

export class ValidationError extends SuperworkError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('validation', message, detail)
    this.name = 'ValidationError'
  }
}

export class BudgetError extends SuperworkError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('budget', message, detail)
    this.name = 'BudgetError'
  }
}
