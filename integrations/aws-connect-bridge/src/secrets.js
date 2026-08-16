'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({});

// Cached across warm Lambda invocations so we don't call Secrets Manager on
// every fragment-continuation or reconnect.
let cachedApiKey = null;

async function getCallGuardApiKey(secretArn) {
  if (cachedApiKey) return cachedApiKey;

  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString (binary secrets are not supported)`);
  }

  let key = result.SecretString.trim();
  // Accept either a plain-string secret or a JSON object with an apiKey /
  // api_key field, so the same template works whether the secret was
  // created as a plaintext value or as a JSON blob.
  if (key.startsWith('{')) {
    const parsed = JSON.parse(key);
    key = parsed.apiKey || parsed.api_key;
    if (!key) {
      throw new Error(`Secret ${secretArn} is JSON but has no "apiKey"/"api_key" field`);
    }
  }

  cachedApiKey = key;
  return cachedApiKey;
}

module.exports = { getCallGuardApiKey };
