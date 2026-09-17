import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('throws an error if TABLE_NAME is missing', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variable: TABLE_NAME'
    );
  });

  it('loads config with default values when only TABLE_NAME is provided', () => {
    const config = loadConfig({ TABLE_NAME: 'visitors' });
    expect(config).toEqual({
      tableName: 'visitors',
      allowOrigin: '*',
      defaultPageId: 'global',
      awsRegion: 'us-east-1',
    });
  });

  it('uses custom environment variables when provided', () => {
    const config = loadConfig({
      TABLE_NAME: 'custom-table',
      ALLOW_ORIGIN: 'https://mysite.com',
      DEFAULT_PAGE_ID: 'home',
      AWS_REGION: 'ap-southeast-2',
    });
    expect(config).toEqual({
      tableName: 'custom-table',
      allowOrigin: 'https://mysite.com',
      defaultPageId: 'home',
      awsRegion: 'ap-southeast-2',
    });
  });

  it('falls back to AWS_DEFAULT_REGION if AWS_REGION is not set', () => {
    const config = loadConfig({
      TABLE_NAME: 'custom-table',
      AWS_DEFAULT_REGION: 'eu-west-1',
    });
    expect(config.awsRegion).toBe('eu-west-1');
  });
});
