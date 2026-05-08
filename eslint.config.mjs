import globals from "globals";
import js      from "@eslint/js";

export default [
  js.configs.recommended,

  // ── Node.js server-side files (CommonJS) ─────────────────────────────────
  {
    files: [
      "MMM-BMWCarDataInfo/node_helper.js",
      "MMM-BMWCarDataInfo/lib/**/*.js",
      "scripts/**/*.js",
      "tools/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  "commonjs",
      globals: { ...globals.node },
    },
  },

  // ── MagicMirror front-end modules (browser, loaded as plain <script> tags)
  {
    files: [
      "MMM-BMWCarData.js",
      "MMM-BMWCarDataInfo/MMM-BMWCarDataInfo.js",
      "MMM-BMWCarDataMap/MMM-BMWCarDataMap.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  "script",
      globals: {
        ...globals.browser,
        Module: "readonly",
        Log:    "readonly",
        config: "readonly",
        L:      "readonly",
      },
    },
  },

  // ── topicFormatter: loaded as <script> by MM and also require()'d in Node ─
  // sourceType "commonjs" makes `module` available for module.exports;
  // browser globals are added for the globalThis / DOM side.
  {
    files: ["MMM-BMWCarDataInfo/lib/topicFormatter.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  {
    ignores: ["node_modules/", "MMM-BMWCarDataMap/vendor/"],
  },
];
