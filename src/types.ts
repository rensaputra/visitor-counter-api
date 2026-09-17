/**
 * Represents the DynamoDB item stored in the database.
 */
export interface CounterRecord {
  /** Unique page identifier (Partition Key) */
  pageId: string;
  /** Current count of visitors */
  count: number;
  /** ISO 8601 string of the last update timestamp */
  updatedAt: string;
}

/**
 * Public response payload returned to clients on GET and POST.
 */
export interface CounterResponse {
  pageId: string;
  count: number;
  updatedAt: string | null;
}

/**
 * Standard error response payload.
 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/**
 * Optional payload body for POST requests.
 */
export interface CounterRequestBody {
  pageId?: string;
}

/**
 * Runtime environment configuration.
 */
export interface AppConfig {
  tableName: string;
  allowOrigin: string;
  defaultPageId: string;
  awsRegion: string;
}
