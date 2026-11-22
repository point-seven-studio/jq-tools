/** Entry point of the viewer bundle (dist/view.mjs), run by `crosstalk view`. */
import { run } from './view.js'

declare const __JQ_CROSSTALK_VERSION__: string
const VERSION = typeof __JQ_CROSSTALK_VERSION__ === 'string' ? __JQ_CROSSTALK_VERSION__ : 'dev'

try {
  run(process.argv.slice(2), VERSION)
} catch (error: any) {
  console.error(error.message || error)
  process.exit(1)
}
