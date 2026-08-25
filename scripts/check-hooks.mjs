// Falla SOLO si hay violaciones de react-hooks/rules-of-hooks en src/.
// Usa la config normal del repo (así toda regla es conocida y no hay falsos
// "rule not found"), pero ignora todo lo demás: este chequeo es de
// CORRECTITUD, no de estilo.
//
// Por qué existe: un hook después de un early-return tira React #300/#310 y
// CAE LA PANTALLA entera. El 25-ago-2026 CallView y NovedadView lo tenían y una
// operadora de Colombia quedó bloqueada cuando su cola de trabajo llegó a cero.
// El lint de la CI solo miraba src/lib|hooks|contexts y era continue-on-error,
// así que un hook mal puesto en un COMPONENTE pasaba el pipeline entero.
import { ESLint } from "eslint";

const eslint = new ESLint();
const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
const malos = results.flatMap((f) =>
  f.messages
    .filter((m) => m.ruleId === "react-hooks/rules-of-hooks")
    .map((m) => `${f.filePath}:${m.line}:${m.column}  ${m.message}`)
);

if (malos.length) {
  console.error(`\n✖ ${malos.length} violación(es) de reglas de hooks:\n`);
  for (const l of malos) console.error("  " + l);
  console.error("\nUn hook después de un early-return tumba la pantalla entera (React #300/#310).\n");
  process.exit(1);
}
console.log("✓ Reglas de hooks OK en todo src/");
