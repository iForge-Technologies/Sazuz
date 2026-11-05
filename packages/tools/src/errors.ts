export type ToolErrorCode =
  | 'INVALID_TOOL'
  | 'TOOL_NOT_FOUND'
  | 'INVALID_TOOL_ARGS'
  | 'INVALID_TOOL_RESULT'
  | 'SECRET_INPUT'
  | 'TOOL_FAILED'
  | 'TOOL_ABORTED'
  | 'UNSAFE_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'UNSAFE_URL'
  | 'NETWORK_FAILED'
  | 'RESPONSE_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT'
  | 'TOO_MANY_REDIRECTS';

const messages: Record<ToolErrorCode, string> = {
  INVALID_TOOL: 'The tool definition is invalid or already registered.',
  TOOL_NOT_FOUND: 'The requested tool is not registered.',
  INVALID_TOOL_ARGS: 'The tool arguments do not match its input schema.',
  INVALID_TOOL_RESULT: 'The tool returned an invalid result.',
  SECRET_INPUT: 'Tool arguments must use secret handles instead of credentials.',
  TOOL_FAILED: 'The tool could not complete the operation.',
  TOOL_ABORTED: 'The tool operation was cancelled or timed out.',
  UNSAFE_PATH: 'The path must refer to a regular file inside the project workspace.',
  FILE_NOT_FOUND: 'The workspace file does not exist.',
  FILE_TOO_LARGE: 'The file exceeds the tool size limit.',
  UNSAFE_URL: 'The URL must target an allowed public HTTP or HTTPS address.',
  NETWORK_FAILED: 'The external service could not complete the request.',
  RESPONSE_TOO_LARGE: 'The external response exceeds the tool size limit.',
  UNSUPPORTED_CONTENT: 'The external response is not supported text content.',
  TOO_MANY_REDIRECTS: 'The external service redirected too many times.',
};

/** Errors intentionally carry no raw URL, path, credential, response, or transport cause. */
export class ToolError extends Error {
  constructor(public readonly code: ToolErrorCode) {
    super(messages[code]);
    this.name = 'ToolError';
  }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('TOOL_ABORTED');
}
