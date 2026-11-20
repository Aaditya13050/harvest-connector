/**
 * A problem the person (or the AI model acting for them) can fix, such as an unknown project
 * name or a missing field. Its message is returned to the model as-is, so write it as a
 * clear, actionable sentence.
 */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError';
}

/** A credential problem on the connect page; shown above the form so the person can retry. */
export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  /** Open the "advanced" part of the form (for example the account picker) when re-rendering. */
  constructor(
    message: string,
    readonly options: { showAdvanced?: boolean } = {},
  ) {
    super(message);
  }
}
