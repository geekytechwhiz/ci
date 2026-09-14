const { readFileSync } = require('fs');

const { coverageThreshold, collectCoverageFrom } = require('./jest.coverage.cjs');

const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

swcJestConfig.swcrc = false;

module.exports = {
  displayName: 'workflow-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  moduleNameMapper: {
    '^@api-hub/utils$': '<rootDir>/../../libs/utils/src/index.ts',
    '^@api-hub/observability$': '<rootDir>/../../libs/observability/src/index.ts',
    '^@api-hub/middleware$': '<rootDir>/../../libs/middleware/src/index.ts',
    '^@api-hub/workflow-runtime-core$': '<rootDir>/../../libs/workflow-runtime-core/src/index.ts',
    '^@api-hub/event-platform$': '<rootDir>/../../libs/event-platform/src/index.ts',
    '^@api-hub/service-clients$': '<rootDir>/../../libs/service-clients/src/index.ts',
  },
  coverageDirectory: '../../coverage/apps/workflow-service',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
  coverageThreshold,
  collectCoverageFrom,
  passWithNoTests: true,
  verbose: true,
};
