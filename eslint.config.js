import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// ponytail: syntax-only rules; switch to tseslint.configs.strictTypeChecked when async code lands.
export default defineConfig(
  globalIgnores(["**/dist/"]),
  js.configs.recommended,
  tseslint.configs.strict,
);
