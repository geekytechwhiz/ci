/** Shared coverage policy for workflow-service Jest configs. */

const coverageThreshold = {
  global: {
    statements: 90,
    branches: 90,
    functions: 90,
    lines: 90,
  },
};

const collectCoverageFrom = [
  'src/handlers/**/*.ts',
  'src/controllers/**/*.ts',
  'src/validators/**/*.ts',
  'src/config/**/*.ts',
  'src/utils/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/**/__tests__/**',
  '!src/**/*.d.ts',
  '!src/**/index.ts',
  '!src/**/*.types.ts',
  '!src/handlers/http/health.ts',
  '!src/handlers/http/api.ts',
];

module.exports = {
  coverageThreshold,
  collectCoverageFrom,
};
