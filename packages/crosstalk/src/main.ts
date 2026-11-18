/** Entry point of the viewer bundle (dist/view.mjs), run by `crosstalk view`. */
import { run } from './view.js'

try {
  run(process.argv.slice(2))
} catch (error: any) {
  console.error(error.message || error)
  process.exit(1)
}
