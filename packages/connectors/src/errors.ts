import { ToolError } from '@sazuz/tools';

export type ConnectorErrorCode =
  | 'ACCOUNT_UNAVAILABLE'
  | 'ACCOUNT_SCOPE_DENIED'
  | 'AGENT_SCOPE_DENIED'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_RESPONSE'
  | 'REQUEST_REJECTED'
  | 'TRANSPORT_FAILED'
  | 'OAUTH_STATE_INVALID';

/** No provider text, credential, URL or transport cause survives this boundary. */
export class ConnectorError extends ToolError {
  constructor(public readonly connectorCode: ConnectorErrorCode) {
    super('TOOL_FAILED');
    this.name = 'ConnectorError';
  }
}
