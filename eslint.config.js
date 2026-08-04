import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      // Copia COMPLETA y vieja del proyecto: duplicaba cada hallazgo del lint.
      ".claude/worktrees/**",
      // Repo de terceros vendorizado — no es código de este proyecto.
      "everything-claude-code/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Las edge functions son Deno y NO pasan por `tsc`: esto es lo ÚNICO que las
  // revisa. Por eso acá `no-undef` va PRENDIDO. Es la regla que caza un
  // identificador usado y nunca declarado — exactamente lo que mató la
  // reconciliación nocturna el 1-ago-2026 ("GUARDIAN_PAGE_SIZE is not defined",
  // en las dos tiendas, todas las noches, hasta que el badge se puso rojo).
  // En `src/` se puede dejar apagada porque tsc hace ese trabajo; acá no corre.
  {
    files: ["supabase/functions/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        Deno: "readonly",
        EdgeRuntime: "readonly",
        // `no-undef` no entiende de TIPOS: ve `RequestInit` en una anotación y
        // lo reporta como variable inexistente. Los tipos que solo viven en el
        // sistema de tipos van declarados acá. Si aparece uno nuevo, se agrega
        // — es barato al lado de perder la regla que caza las constantes que no
        // existen, que es para lo que está prendida.
        RequestInit: "readonly",
        RequestInfo: "readonly",
        ResponseInit: "readonly",
        HeadersInit: "readonly",
        BodyInit: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      // Las respuestas de Dropi/Shopify son JSON sin contrato: tiparlas de
      // verdad es otro trabajo. Exigirlo acá dejaba 39 errores fijos, y un
      // lint siempre en rojo no lo mira nadie — así estaba hasta hoy, y por
      // eso el gate no sirvió de nada cuando hubo un error de verdad.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
