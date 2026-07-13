// Hermetic env for unit tests. Set before any module imports config.ts, which
// hard-requires these at load time. dotenv does not override already-set vars,
// so a developer's real .env can't leak a production key into a test run.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-jwt-secret-not-used-for-anything-real';
// A valid 32-byte (64 hex char) key so crypto.ts accepts it.
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
