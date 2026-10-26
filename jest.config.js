/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  collectCoverage: false,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    // Type-only module: no runtime logic to cover.
    "!src/types.ts",
    // Build-time OpenAPI contract schemas. This module has no runtime side
    // effects and is not part of the Lambda bundle; it is consumed only by the
    // `npm run openapi` generation script, so it is excluded from runtime
    // coverage the same way types.ts is.
    "!src/openapi.ts",
  ],
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
