const messages = {
  MEMORY_NOT_FOUND: 'The memory or project is unavailable.',
  MEMORY_CONFLICT: 'This memory changed. Reload before saving.',
  MEMORY_INVALID: 'Check the memory fields and scope.',
  MEMORY_SECRET: 'Store credentials in the vault, not in memory or knowledge.',
  JOB_NOT_FOUND: 'The background job is unavailable.',
  JOB_CONFLICT: 'Only a blocked or failed job can be retried.',
  JOB_BUDGET: 'The background job reached its budget. Review the run and configured limits.',
  JOB_INTERRUPTED: 'Execution was interrupted. Review the job before retrying.',
  JOB_FAILED: 'The background job failed. Check the provider, vault and source.',
  SOURCE_INVALID: 'Use a supported, readable document within the upload and text limits.',
  SOURCE_NOT_FOUND: 'The source or citation is unavailable in this project.',
  SOURCE_CONFLICT: 'This upload request was already used for another source.',
  EMBEDDING_UNAVAILABLE: 'Configure an enabled embedding provider and model in Settings.',
  EMBEDDING_SPACE: 'The embedding model returned inconsistent vector dimensions.',
  EMBEDDING_PRIVATE: 'Private data requires a local embedding provider.',
} as const;
export class MemoryError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'MemoryError';
  }
}
