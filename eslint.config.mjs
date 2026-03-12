import nextConfig from "eslint-config-next";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["node_modules/", ".next/", "mobile/"],
  },
];

export default eslintConfig;
