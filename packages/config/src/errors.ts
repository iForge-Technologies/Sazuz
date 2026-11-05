const messages = {
  INVALID_INFRA_CONFIG: 'Infrastructure configuration is invalid.',
  DATABASE_CREDENTIAL_MISSING:
    'The database credential is missing. Run the infrastructure bootstrap.',
  DATABASE_CREDENTIAL_INVALID:
    'The database credential is invalid. Restore the original credential before restarting.',
  DATABASE_CREDENTIAL_UNSAFE: 'The database credential location or permissions are unsafe.',
  DATABASE_CREDENTIAL_IO: 'The database credential could not be accessed safely.',
  PLUMBING_SECRET_MISSING:
    'An infrastructure secret is missing. Restore the original files or run first-time bootstrap.',
  PLUMBING_SECRET_INVALID:
    'An infrastructure secret is invalid. Restore the original files before restarting.',
  PLUMBING_SECRET_UNSAFE: 'Infrastructure secret locations or permissions are unsafe.',
  PLUMBING_SECRET_IO: 'Infrastructure secrets could not be accessed safely.',
} as const;

export type ConfigErrorCode = keyof typeof messages;

/** Raw validation and filesystem errors must not expose credential values or paths. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode) {
    super(messages[code]);
    this.name = 'ConfigError';
    this.code = code;
  }
}
