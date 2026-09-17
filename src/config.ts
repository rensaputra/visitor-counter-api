import { AppConfig } from './types';

/**
 * Loads and validates configuration from process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tableName = env.TABLE_NAME;
  if (!tableName) {
    throw new Error('Missing required environment variable: TABLE_NAME');
  }

  return {
    tableName,
    allowOrigin: env.ALLOW_ORIGIN || '*',
    defaultPageId: env.DEFAULT_PAGE_ID || 'global',
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
  };
}
