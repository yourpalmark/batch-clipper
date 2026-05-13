// tests/setup.js
// Mock browser APIs not available in jsdom.

global.chrome = {
  runtime: {
    lastError: null,
    sendMessage: jest.fn(),
    onMessage: { addListener: jest.fn() },
  },
  tabs: {
    query: jest.fn(),
    sendMessage: jest.fn(),
  },
  scripting: {
    executeScript: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
    },
  },
};
