/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  collectCoverage: false,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/types.ts"],
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 90,
    },
  },
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  clearMocks: true,
};
