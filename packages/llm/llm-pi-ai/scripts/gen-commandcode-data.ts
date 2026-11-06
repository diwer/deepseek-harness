/** Refresh the bundled CommandCode catalog from its public, keyless model listing. */
import { writeFileSync } from 'node:fs'
import ts from 'typescript'
import z from '@deepseek-ai/schemastery'

const response = await fetch('https://api.commandcode.ai/provider/v1/models', { signal: AbortSignal.timeout(10000) })
if (!response.ok) throw new Error(`CommandCode model listing returned ${response.status}`)
const listing = z.object({ data: z.array(z.object({
  id: z.string().required(),
  name: z.string().required(),
  context_length: z.number().step(1).min(1).required(),
  supported_endpoints: z.array(z.string()).required(),
})) })(await response.json())
const printer = ts.createPrinter()
const source = ts.createSourceFile('commandcode-data.ts', '', ts.ScriptTarget.Latest)
const quote = (value: string): string => printer.printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(value, true), source)
const rows = listing.data.map(model => '  [' + [quote(model.id), quote(model.name), String(model.context_length),
  '[' + model.supported_endpoints.map(quote).join(', ') + ']',
].join(', ') + '],')
writeFileSync(new URL('../src/commandcode-data.generated.ts', import.meta.url),
  '/** CommandCode public model snapshot. Regenerate with scripts/gen-commandcode-data.ts. */\n'
  + 'export const COMMANDCODE_MODELS = [\n' + rows.join('\n') + '\n] as const\n')
