function required(value, key, production) {
  if (production && !value) throw new Error(`env ${key} missing/unfilled`);
  return value || '';
}

function actionUrl(endpoint, action) {
  if (!endpoint) return '';
  const url = new URL(endpoint);
  url.searchParams.set('action', action);
  return url.toString();
}

export function createAgentIndexConfig({
  endpoint,
  secret,
  schemaVersion,
  dbPath,
  relayerOrigin,
  production = false,
} = {}) {
  const checkedEndpoint = required(endpoint, 'AGENT_INDEX_REPORTER_URL', production);
  const checkedSecret = required(secret, 'AGENT_INDEX_REPORTER_SECRET', production);
  const checkedDbPath = required(dbPath, 'RELAYER_DB_PATH', production);
  const checkedOrigin = required(relayerOrigin, 'RELAYER_PUBLIC_ORIGIN', production);
  if (schemaVersion !== 1) throw new Error('env AGENT_INDEX_REPORTER_SCHEMA must equal 1');
  const config = {
    intentUrl: actionUrl(checkedEndpoint, 'base-child-intent'),
    lifecycleUrl: actionUrl(checkedEndpoint, 'base-child-lifecycle'),
    schemaVersion,
    ready: Boolean(checkedEndpoint && checkedSecret && checkedDbPath && checkedOrigin),
  };
  Object.defineProperty(config, 'endpoint', { value: checkedEndpoint, enumerable: false });
  Object.defineProperty(config, 'secret', { value: checkedSecret, enumerable: false });
  Object.defineProperty(config, 'dbPath', { value: checkedDbPath, enumerable: false });
  Object.defineProperty(config, 'relayerOrigin', { value: checkedOrigin, enumerable: false });
  return Object.freeze(config);
}
