/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  settings: {
    jest: {
      // We run Vitest, but remix preset enables jest plugin rules.
      // Pinning avoids "Unable to detect Jest version" lint crashes.
      version: 29,
    },
  },
};
