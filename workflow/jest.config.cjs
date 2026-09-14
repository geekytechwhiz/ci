const { readFileSync } = require('fs');

const { coverageThreshold, collectCoverageFrom } = require('./jest.coverage.cjs');

let swcJestConfig = {};
try {
  swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));
  swcJestConfig.swcrc = false;
} catch (e) {
  // Fallback if .spec.swcrc is missing
}

module.exports = {
  displayName: 'workflow-service',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
  coverageThreshold,
  collectCoverageFrom,
  passWithNoTests: true,
  verbose: true,
};
