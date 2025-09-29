module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: ['main.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};